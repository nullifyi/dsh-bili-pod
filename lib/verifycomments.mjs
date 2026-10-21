// Accepted receipts and bounded account observations. Missing from one page is not unsent.
import path from 'node:path'
import { withFileLock, readJson, atomicJson } from './file-state.mjs'
import { DEFAULTS } from './defaults.mjs'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const SENT_FILE = path.join(HOME, '.bili-ai', 'pod-sent.json')
export const VERIFY_STATE = path.join(HOME, '.bili-ai', 'pod-verify.json')
const CRED_FILE = path.join(HOME, '.bili-ai', 'credentials.json')
export function readSent() { return readJson(SENT_FILE, { items: [] }) }
const updateSent = fn => withFileLock(SENT_FILE, () => { const db = readSent(); const result = fn(db); atomicJson(SENT_FILE, db); return result ?? db })
export function writeSent(db) { return withFileLock(SENT_FILE, () => atomicJson(SENT_FILE, db)) }
export function recordSent(item) {
  return updateSent(db => {
    const rpid = String(item.rpid ?? '')
    if (rpid && !db.items.some(x => String(x.rpid) === rpid)) {
      db.items.push({ at: new Date().toISOString(), verified: null, verifyAttempts: 0, ...item, type: String(item.type ?? '1'), rpid })
      db.items = db.items.slice(-300)
    }
  })
}
export const readCred = () => { try { const c = readJson(CRED_FILE, null); return c?.sessdata ? c : null } catch { return null } }
const headersFor = cred => ({ 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}` })
async function jget(url, headers) {
  const ctrl = new AbortController()
  let timer
  try {
    return await Promise.race([
      (async () => { const r = await fetch(url, { headers, signal: ctrl.signal }); return JSON.parse(await r.text()) })(),
      new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new Error('observation timeout')) }, 10000) }),
    ])
  } catch (e) { return { code: -998, message: String(e.message) } }
  finally { clearTimeout(timer) }
}
const exactId = row => row?.rpid_str != null ? String(row.rpid_str) : typeof row?.rpid === 'number' && !Number.isSafeInteger(row.rpid) ? '' : String(row?.rpid ?? '')
export async function verifyOne(record, { headers = {}, aidCache = new Map() } = {}) {
  const out = { rpid: String(record.rpid), bvid: String(record.bvid ?? ''), type: String(record.type ?? '1'), visible: null, audience: headers.cookie ? 'account' : 'anonymous', observation: 'missing', how: '', note: '' }
  let oid = String(record.oid || aidCache.get(out.bvid) || '')
  if (!oid) {
    if (out.type !== '1' || !out.bvid) return { ...out, observation: 'error', note: '缺少评论区 oid，未查询' }
    const v = await jget('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(out.bvid), headers)
    if (v.code !== 0 || !v.data?.aid) return { ...out, observation: 'error', note: '取视频信息失败' }
    oid = String(v.data.aid); aidCache.set(out.bvid, oid)
  }
  const query = new URLSearchParams({ type: out.type, oid, ps: '20', ...(record.root ? { root: String(record.root), pn: '1' } : { mode: '2', next: '0' }) })
  out.how = (headers.cookie ? '本人登录观察' : '匿名观察') + (record.root ? ' · 楼中楼第一页' : ' · 顶层最新一页')
  const d = await jget('https://api.bilibili.com/x/v2/reply/' + (record.root ? 'reply' : 'main') + '?' + query, headers)
  if (d.code !== 0) return { ...out, observation: 'error', note: String(d.message ?? '查询失败') }
  const hit = [d.data?.root, ...(d.data?.replies ?? [])].filter(Boolean).find(r => exactId(r) === out.rpid)
  if (hit) { out.visible = !hit.invisible; out.observation = hit.invisible ? 'invisible' : 'visible'; out.likes = hit.like ?? 0; out.note = hit.invisible ? '接口标记 invisible' : '' }
  else out.note = '本页未查到；可能在审核或其他页，不能证明未发出或删除'
  return out
}
const settings = review => ({
  rounds: Math.max(1, Math.min(5, Math.floor(Number(review?.verifyRounds) || DEFAULTS.review.verifyRounds))),
  interval: Math.max(5, Math.min(300, Number(review?.verifyIntervalSec) || DEFAULTS.review.verifyIntervalSec)) * 1000,
})
function persistObservation(res, now, review) {
  const { rounds, interval } = settings(review)
  updateSent(db => {
    const row = db.items.find(x => String(x.rpid) === res.rpid)
    if (!row) return
    row.verifyAttempts = (Number(row.verifyAttempts) || 0) + 1
    row.verified = res.visible === true ? 'visible' : row.verifyAttempts >= rounds ? 'unconfirmed' : null
    Object.assign(row, { verifiedAt: new Date(now).toISOString(), verifyHow: res.how, observation: res.observation, audience: res.audience, verifyNote: res.note, nextVerifyAt: now + interval })
  })
  withFileLock(VERIFY_STATE, () => {
    const state = readJson(VERIFY_STATE, {})
    state[res.rpid] = { ...res, at: now }
    atomicJson(VERIFY_STATE, state)
  })
}
export async function verifyRecorded(rpid, { cred = readCred(), now = Date.now(), review = DEFAULTS.review } = {}) {
  const row = readSent().items.find(x => String(x.rpid) === String(rpid))
  if (!row) throw new Error('待复核清单里没有 rpid=' + rpid)
  if (!cred) throw new Error('没有登录凭据')
  const result = await verifyOne(row, { headers: headersFor(cred) })
  persistObservation(result, now, review)
  return result
}
export async function verifyRecent({ max = 6, cred = readCred(), now = Date.now(), review = DEFAULTS.review, log = () => {} } = {}) {
  if (!cred) return { checked: [], skipped: 0, text: '还没登录，无法进行本人登录观察' }
  const { rounds } = settings(review)
  const rows = readSent().items
  const due = rows.filter(r => r.rpid && r.verified !== 'visible' && (Number(r.verifyAttempts) || 0) < rounds && (Number(r.nextVerifyAt) || 0) <= now)
    .sort((a, b) => (Number(a.nextVerifyAt) || now) - (Number(b.nextVerifyAt) || now) || String(a.at ?? '').localeCompare(String(b.at ?? ''))).slice(0, max)
  const checked = []
  for (const row of due) {
    const result = await verifyOne(row, { headers: headersFor(cred) })
    persistObservation(result, now, review); checked.push(result)
    log('复核 rpid=' + result.rpid + ' → ' + (result.visible === true ? '本人登录可见' : result.observation === 'error' ? '查询失败，未确认' : '本页未查到，未确认'))
  }
  const text = checked.map(r => '- rpid=' + r.rpid + ' · ' + (r.visible === true ? '本人登录可见' : '未确认') + ' · ' + r.how + (r.note ? ' · ' + r.note : '')).join('\n')
  return { checked, skipped: rows.length - due.length, text }
}
