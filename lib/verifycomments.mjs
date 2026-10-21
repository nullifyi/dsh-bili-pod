/**
 * lib/verifycomments.mjs —— 「评论发出后复核」（做法照 dsh-bili-scroll 的 lib/verify.mjs）
 * ============================================================================
 * 为什么需要：接口回「发送成功」≠ 公开可见。新号 / 风控会让评论进审核，
 * 你自己看不见但插件以为发出去了、还记进了判重表 ⇒ 下一轮不再发，
 * 结果一条都没到人。
 *
 * 两条只读接口复核（与 ① 一致的实测方案）：
 *   ① 顶层评论：/x/v2/reply/main?type=1&oid=<aid>&mode=2&next=0&ps=20（按时间第一页）
 *   ② 楼中楼：  /x/v2/reply/reply?type=1&oid=<aid>&root=<root>&ps=20&pn=1
 * ⚠️ 看不到 ≠ 没发出（翻页 / 热度排序都会漏）⇒ 结论一律写「没查到」，
 *    绝不写「没发出去」。
 *
 * 数据源：成功发出评论时 tools/commands/comment.mjs 会往
 *   ~/.bili-ai/pod-sent.json 追加 {rpid,bvid,oid,root,parent,at,message}
 * 这样账本里才有"我们到底发过什么"可核。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const SENT_FILE = path.join(HOME, '.bili-ai', 'pod-sent.json')
export const VERIFY_STATE = path.join(HOME, '.bili-ai', 'pod-verify.json')
const CRED_FILE = path.join(HOME, '.bili-ai', 'credentials.json')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jget = async (url, headers) => {
  try {
    const r = await fetch(url, { headers })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json' } }
  } catch (e) { return { code: -998, message: String(e?.message ?? e) } }
}

export function readSent() {
  try { const j = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); return Array.isArray(j.items) ? j : { items: [] } } catch { return { items: [] } }
}
export function writeSent(db) {
  fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true })
  fs.writeFileSync(SENT_FILE, JSON.stringify(db, null, 2) + '\n', 'utf8')
}
export function recordSent(item) {
  const db = readSent()
  const rpid = String(item.rpid ?? '')
  if (!rpid) return db
  if (db.items.some((x) => String(x.rpid) === rpid)) return db
  db.items.push({ at: new Date().toISOString(), verified: null, ...item, rpid })
  // 只留最近 300 条，别把文件养大
  db.items = db.items.slice(-300)
  writeSent(db)
  return db
}

export const readCred = () => {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return c?.sessdata ? c : null
  } catch { return null }
}

const headersFor = (cred) => ({
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}`,
})

const readVerifyState = () => { try { return JSON.parse(fs.readFileSync(VERIFY_STATE, 'utf8')) } catch { return {} } }
const writeVerifyState = (s) => {
  try { fs.mkdirSync(path.dirname(VERIFY_STATE), { recursive: true }); fs.writeFileSync(VERIFY_STATE, JSON.stringify(s, null, 2) + '\n', 'utf8') } catch { /* 复核不该因为写不了状态而失败 */ }
}

/**
 * 复核一条。每条记录里尽量有 bvid（或 oid）；楼中楼还要 root。
 * @returns {Promise<{rpid:string,bvid:string,visible:boolean|null,how:string,note:string,likes?:number}>}
 */
export async function verifyOne(record, { headers, aidCache = new Map() }) {
  const out = { rpid: String(record.rpid), bvid: String(record.bvid ?? ''), visible: null, how: '', note: '' }
  let aid = record.oid ? String(record.oid) : ''
  if (!aid) {
    const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(out.bvid)}`, headers)
    if (v?.code !== 0 || !v?.data?.aid) { out.how = '取视频信息失败'; out.note = '跳过（视频可能已删 / 不可见）'; return out }
    aid = String(v.data.aid)
    aidCache.set(out.bvid, aid)
    await sleep(300)
  }
  const rpidNum = Number(record.rpid)

  if (!record.root) {
    const d = await jget(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=2&next=0&ps=20`, headers)
    const list = d?.data?.replies ?? []
    const hit = list.find((r) => Number(r.rpid) === rpidNum)
    out.how = '顶层·最新一页'
    if (hit) {
      out.visible = !hit.invisible
      out.likes = hit.like ?? 0
      out.note = hit.invisible ? '（接口标了 invisible）' : ''
      return out
    }
    out.note = '最新一页里没找到 —— 可能还在审核，也可能只是翻页看不到（不等于没发出去）'
    return out
  }

  const d = await jget(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${encodeURIComponent(record.root)}&ps=20&pn=1`, headers)
  const subs = d?.data?.replies ?? []
  const hit = subs.find((r) => Number(r.rpid) === rpidNum)
  out.how = `楼中楼·root=${record.root}`
  if (hit) {
    out.visible = !hit.invisible
    out.likes = hit.like ?? 0
    out.note = hit.invisible ? '（接口标了 invisible）' : ''
    return out
  }
  out.note = subs.length
    ? `那一串里有 ${subs.length} 条，但没有我们这条 —— 可能还在审核（不等于没发出去）`
    : '那一串暂时拉不到内容 —— 可能还在审核（不等于没发出去）'
  return out
}

/**
 * 复核最近一批（默认最多 6 条；7 天内确认见过的不重复查）。
 * @returns {Promise<{checked:Array, skipped:number, text:string}>}
 */
export async function verifyRecent({ max = 6, cred = readCred(), now = Date.now(), log = () => {} } = {}) {
  if (!cred) return { checked: [], skipped: 0, text: '⚠️ 还没登录（没有凭据），没法复核 —— 复核要用你自己的登录态' }
  const db = readSent()
  const rows = db.items.filter((x) => x.rpid)
  if (!rows.length) return { checked: [], skipped: 0, text: '还没发过评论，暂时没有可复核的账' }
  const state = readVerifyState()
  const fresh = []
  let skipped = 0
  for (const r of rows.slice().reverse()) {
    const prev = state[String(r.rpid)]
    if (prev?.visible === true && now - (prev.at || 0) < 7 * 86400000) { skipped++; continue }
    fresh.push(r)
    if (fresh.length >= max) break
  }
  if (!fresh.length) return { checked: [], skipped, text: `都复核过了（跳过最近已确认的 ${skipped} 条）` }

  const headers = headersFor(cred)
  const aidCache = new Map()
  const checked = []
  for (const r of fresh) {
    const res = await verifyOne(r, { headers, aidCache })
    checked.push(res)
    state[res.rpid] = { visible: res.visible, at: now, how: res.how, bvid: res.bvid, likes: res.likes ?? null, note: res.note }
    log(`复核 ${res.bvid || r.oid} rpid=${res.rpid} → ${res.visible === true ? '公开可见' : '没查到'}（${res.how}）`)
    await sleep(700)
  }
  writeVerifyState(state)
  // 回写到 sent 表，下一轮不用重复查
  const byRpid = new Map(checked.map((c) => [c.rpid, c]))
  for (const it of db.items) {
    const c = byRpid.get(String(it.rpid))
    if (c) { it.verified = c.visible === true ? 'visible' : 'not-found'; it.verifiedAt = new Date(now).toISOString(); it.verifyHow = c.how }
  }
  writeSent(db)

  const lines = ['', '## 评论复核（宿主自动跑的，不是那一轮自己说的）', '']
  for (const c of checked) {
    const t = c.visible === true ? `公开可见（赞 ${c.likes ?? 0}）` : '没查到'
    lines.push(`- \`${c.bvid || 'oid'}\` rpid **${c.rpid}** —— ${t} · 依据：${c.how}${c.note ? ' · ' + c.note : ''}`)
  }
  if (skipped) lines.push(`- （另外 ${skipped} 条最近已复核过，没重复查）`)
  return { checked, skipped, text: lines.join('\n') }
}
