// Local host/CLI handoff, not a security sandbox against same-user processes.
import path from 'node:path'
import crypto from 'node:crypto'
import { withFileLock, readJson, atomicJson } from './file-state.mjs'

const dir = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.bili-ai')
export const OPERATIONS_FILE = path.join(dir, 'comment-operations.json')
export const PENDING_FILE = path.join(dir, 'pending-replies.json')
export const coordinates = (v) => v.kind === 'dm'
  ? { kind: 'dm', to: String(v.to ?? ''), message: String(v.message ?? '') }
  : ({ oid: String(v.oid ?? ''), type: String(v.type ?? '1'), root: String(v.root ?? ''), parent: String(v.parent || v.root || ''), message: String(v.message ?? '') })
const fingerprint = v => crypto.createHash('sha256').update(JSON.stringify(coordinates(v))).digest('hex')
const transaction = fn => withFileLock(OPERATIONS_FILE, () => {
  const db = readJson(OPERATIONS_FILE, { items: [] })
  const result = fn(db)
  atomicJson(OPERATIONS_FILE, db)
  return result
})
export function readOperation(id) { return readJson(OPERATIONS_FILE, { items: [] }).items.find(x => x.operationId === id) ?? null }
export function issueApproval(draft) {
  return transaction(db => {
    const operationId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex')
    db.items.push({ operationId, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), fingerprint: fingerprint(draft), ...coordinates(draft), status: 'approved', at: new Date().toISOString() })
    return { operationId, token }
  })
}
function matching(op, draft, token) {
  return op?.status === 'approved' && op.fingerprint === fingerprint(draft) && typeof token === 'string' && op.tokenHash === crypto.createHash('sha256').update(token).digest('hex')
}
export function checkApproval(draft, { operationId, token }) { return matching(readOperation(operationId), draft, token) }
export function beginSend(draft, { operationId, token, required = false } = {}) {
  return transaction(db => {
    let op = db.items.find(x => x.operationId === operationId)
    if (required || token) {
      if (!matching(op, draft, token)) throw new Error('需要宿主签发且匹配正文和坐标的一次性审核凭据')
    } else {
      if (op) throw new Error(`操作已存在：${op.status}；不可重新发送`)
      op = { operationId: operationId || crypto.randomUUID(), ...coordinates(draft), at: new Date().toISOString() }; db.items.push(op)
    }
    op.status = 'sending'; delete op.tokenHash
    return op.operationId
  })
}
export function finishSend(id, status, details = {}) {
  return transaction(db => {
    const op = db.items.find(x => x.operationId === id)
    if (!op) throw new Error('Unknown comment operation')
    if (op.status === 'accepted' && status !== 'accepted') return op
    Object.assign(op, details, { status, updatedAt: new Date().toISOString() })
    return op
  })
}
// Same-user host/CLI handoff: source receipt and quota must both have committed.
export function claimShareContinuation(id, { ownerMid, bvid, message }, { claim = true } = {}) {
  return transaction(db => {
    const op = db.items.find(x => x.operationId === id)
    const quota = readJson(path.join(dir, 'quota.json'), { log: [] })
    const expected = op ? `${op.message} https://www.bilibili.com/video/${op.bvid}/` : ''
    if (!op || op.channel !== 'comment' || op.share !== true || op.status !== 'accepted' || op.accountingStatus !== 'complete'
      || op.root || op.parent || !ownerMid || op.ownerMid !== ownerMid || op.bvid !== bvid || message !== expected
      || !quota.log.some(x => x.operationId === id && x.type === 'comment' && x.share === true && x.target === `BV:${bvid}`))
      throw new Error('续送需要已接受且已完整记账的同主人、同BV、同正文公开分享')
    if (op.continuation && op.continuation.status !== 'rejected') throw new Error(`续送已 ${op.continuation.status}，不得重发；请人工核对`)
    if (claim) op.continuation = { ownerMid, bvid, message, status: 'sending', at: new Date().toISOString(), attempt: Number(op.continuation?.attempt ?? 0) + 1 }
    return op
  })
}
export function finishShareContinuation(id, status, details = {}) {
  return transaction(db => {
    const op = db.items.find(x => x.operationId === id)
    if (!op?.continuation || op.continuation.status !== 'sending') throw new Error('续送未被认领')
    Object.assign(op.continuation, details, { status, updatedAt: new Date().toISOString() })
    return op.continuation
  })
}
export function claimDraft(id) {
  return withFileLock(PENDING_FILE, () => {
    const db = readJson(PENDING_FILE, { items: [] }), item = db.items.find(x => x.id === id)
    if (!item || (item.status && item.status !== 'pending')) return null
    const approval = issueApproval(item)
    Object.assign(item, { status: 'sending', operationId: approval.operationId })
    atomicJson(PENDING_FILE, db)
    return { item: { ...item }, ...approval }
  })
}
export function settleDraft(id, operationId, status) {
  withFileLock(PENDING_FILE, () => {
    const db = readJson(PENDING_FILE, { items: [] }), item = db.items.find(x => x.id === id && x.operationId === operationId)
    if (!item) return
    if (status === 'accepted') db.items = db.items.filter(x => x !== item)
    else item.status = status === 'rejected' ? 'pending' : 'uncertain'
    atomicJson(PENDING_FILE, db)
  })
}
