// 0.8.0：卡住的草稿要能「对账后重试」。
// 以前 uncertain 就永久卡在「正在发送或结果不明」，主人点「发」只会再报同一句错。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-reconcile-'))
process.env.BILI_POD_STATE = tmp
process.env.USERPROFILE = tmp
process.env.HOME = tmp

const cs = await import('../lib/comment-state.mjs?t=' + Date.now())

function setOp(operationId, status, when = new Date()) {
  const db = JSON.parse(fs.readFileSync(cs.OPERATIONS_FILE, 'utf8'))
  const op = db.items.find((x) => x.operationId === operationId)
  op.status = status
  op.updatedAt = when.toISOString()
  fs.writeFileSync(cs.OPERATIONS_FILE, JSON.stringify(db, null, 2))
}
const pendingItems = () => JSON.parse(fs.readFileSync(cs.PENDING_FILE, 'utf8')).items
const makeDraft = (msg) => {
  const { item } = cs.addDraft({ kind: 'dm', to: '660490601', message: msg, who: '主人' })
  const claim = cs.claimDraft(item.id)
  return { id: item.id, operationId: claim.operationId }
}

test('结果不明且已经过时：拉回 pending 并可以再点一次', () => {
  const { id, operationId } = makeDraft('对账重试测试 A')
  setOp(operationId, 'uncertain', new Date(Date.now() - 10 * 60 * 1000))
  const rec = cs.reconcileDraft(id)
  assert.equal(rec.action, 'reset')
  const item = pendingItems().find((x) => x.id === id)
  assert.equal(item.status, 'pending')
  assert.equal(item.operationId, undefined)
  assert.equal(item.lastStatus, 'uncertain')
  const again = cs.claimDraft(id)
  assert.ok(again?.operationId, '对账之后必须能重新认领')
})

test('操作其实已经 accepted：标为已发并从待审核里清掉', () => {
  const { id, operationId } = makeDraft('对账重试测试 B')
  setOp(operationId, 'accepted')
  const rec = cs.reconcileDraft(id)
  assert.equal(rec.action, 'sent')
  assert.equal(pendingItems().some((x) => x.id === id), false)
  assert.equal(cs.claimDraft(id), null)
})

test('刚发出几秒（sending 且未超时）：先别动，等一等', () => {
  const { id, operationId } = makeDraft('对账重试测试 C')
  setOp(operationId, 'sending', new Date())
  const rec = cs.reconcileDraft(id)
  assert.equal(rec.action, 'sending')
  assert.equal(pendingItems().find((x) => x.id === id).status, 'sending')
})

test('草稿不存在：如实说，不假装成功', () => {
  const rec = cs.reconcileDraft('nope-nope')
  assert.equal(rec.ok, false)
  assert.equal(rec.action, 'missing')
})
