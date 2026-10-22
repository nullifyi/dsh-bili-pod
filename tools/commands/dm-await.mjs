// 私信监听（主人 + 女主人）—— 命中任一收件人的新消息就叫她起来
//   主人：普通回答（该审就审）
//   女主人：必须回（`--reply`），一天最多 mistress.replyMaxPerDay 条，长回可分两条
//   用法:
//     node dm-await.mjs --baseline          把当前状态记为"已读"，从现在起只认新消息
//     node dm-await.mjs --once [--json]     轮询一次（命中打印 DM_HIT）
//     node dm-await.mjs --once --json --peek  持久化待交付消息，返回 receipt
//     node dm-await.mjs --ack <receipt>    宿主成功接收后确认，不访问网络
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'
import { stateFile } from '../lib/paths.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const BASE = !!opt.baseline
const ONCE = !!opt.once || BASE
const JSONOUT = !!opt.json
const PEEK = !!opt.peek

const U = process.env.USERPROFILE || process.env.HOME || '/'
const STATE = stateFile('dm-await-state.json')
const c = JSON.parse(fs.readFileSync(path.join(U, '.bili-ai', 'credentials.json'), 'utf8'))
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')
const MISTRESS = cfg.mistress?.enabled === true ? String(cfg.mistress?.mid ?? '').trim() : ''
const MISTRESS_NAME = String(cfg.mistress?.title ?? '女主人')
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空'); process.exit(2) }

/** 收件人表：主人 + （启用时）女主人。命中谁都算，role 决定回复口径。 */
const TALKERS = [
  { mid: OWNER, role: 'owner', name: OWNER_NAME },
  ...(MISTRESS && MISTRESS !== OWNER ? [{ mid: MISTRESS, role: 'mistress', name: MISTRESS_NAME }] : []),
]

const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}`,
}
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('私信状态无法读取，已停止推进已读位置：' + error.message) }
}
const saveState = (o) => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  const temp = STATE + '.' + process.pid + '.tmp'
  try { fs.writeFileSync(temp, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(temp, STATE) }
  finally { fs.rmSync(temp, { force: true }) }
}
const parsed = (content) => {
  try { const j = JSON.parse(String(content)); return String(j.content ?? j.text ?? content) } catch { return String(content ?? '') }
}

async function poll() {
  const u = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=20&mobi_app=web'
  const r = await fetch(u, { headers: H })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, why: `get_sessions code=${j.code} ${j.message ?? ''}` }
  const list = j.data?.session_list ?? []
  for (const t of TALKERS) {
    const mine = list.find((s) => String(s.talker_id) === t.mid)
    if (!mine) continue
    const last = mine.last_msg ?? {}
    const ts = Number(last.timestamp ?? 0)
    const text = parsed(last.content)
    const sender = String(last.sender_uid ?? 0)
    const fromSelf = sender === t.mid               // 只有对方发来的才算
    const key = String(last.msg_key ?? last.msg_seqno ?? crypto.createHash('sha256').update(JSON.stringify([ts, sender, text])).digest('hex'))
    return { ok: true, ts, key, text, role: t.role, mid: t.mid, name: t.name, fromSelf, unread: Number(mine.unread_count ?? 0) }
  }
  return { ok: true, hit: false, why: '没有主人/女主人的会话' }
}

/** 兼容旧状态：{owner,lastSeen,lastKey} → {seen:{<mid>:ts}, keys:{<mid>:key}} */
function normalizeState(st) {
  const seen = { ...(st.seen ?? {}) }
  const keys = { ...(st.keys ?? {}) }
  if (st.owner && st.lastSeen) { seen[String(st.owner)] = Math.max(Number(seen[st.owner] ?? 0), Number(st.lastSeen)) }
  if (st.owner && st.lastKey) keys[String(st.owner)] = String(st.lastKey)
  return { seen, keys, pending: st.pending ?? null, at: st.at ?? '' }
}

if (BASE) {
  const r = await poll()
  if (!r.ok) { console.error(`✗ ${r.why}`); process.exit(3) }
  const st = normalizeState(loadState())
  if (!r.hit && r.mid) { st.seen[r.mid] = r.ts || 0; st.keys[r.mid] = r.key }
  saveState({ ...st, at: new Date().toISOString() })
  console.log(`已把当前私信状态标记为已读（${r.mid ?? '无会话'} @ ${r.ts ?? 0}）✓ 从现在起只认新消息`)
  process.exit(0)
}

let st = normalizeState(loadState())
if (opt.ack) {
  if (!st.pending || st.pending.receipt !== String(opt.ack)) {
    console.error('私信确认凭据不匹配，未推进已读状态'); process.exit(2)
  }
  st.seen[String(st.pending.mid)] = Number(st.pending.ts)
  st.keys[String(st.pending.mid)] = String(st.pending.key)
  saveState({ ...st, pending: null, at: new Date().toISOString() })
  console.log('私信交付已确认'); process.exit(0)
}
if (st.pending) {
  console.log(JSONOUT ? JSON.stringify(st.pending) : `DM_HIT role=${st.pending.role} mid=${st.pending.mid} ts=${st.pending.ts} text=${st.pending.text}`)
  process.exit(0)
}
const r = await poll()
if (!r.ok) { console.error(`✗ ${r.why}`); process.exit(3) }
if (r.hit) { if (JSONOUT) console.log(JSON.stringify({ hit: false })); else if (!ONCE) console.log('无新私信'); process.exit(1) }
const lastSeen = Number(st.seen[r.mid] ?? 0)
const hit = r.fromSelf && (r.ts > lastSeen || (r.ts === lastSeen && st.keys[r.mid] && r.key !== st.keys[r.mid]))
if (hit) {
  const result = { hit: true, role: r.role, mid: r.mid, name: r.name, text: r.text, ts: r.ts, key: r.key }
  if (PEEK) { result.receipt = crypto.randomUUID(); saveState({ ...st, pending: result }) }
  else { st.seen[r.mid] = r.ts; st.keys[r.mid] = r.key; saveState({ ...st, at: new Date().toISOString() }) }
  if (JSONOUT) console.log(JSON.stringify(result))
  else console.log(`DM_HIT role=${r.role} mid=${r.mid} name=${r.name} ts=${r.ts} text=${r.text.replace(/\n/g, ' ').slice(0, 200)}`)
  process.exit(0)
}
// 没命中：把该会话的 lastSeen 往前推
if (r.ts > lastSeen) { st.seen[r.mid] = r.ts; st.keys[r.mid] = r.key; saveState({ ...st, at: new Date().toISOString() }) }
if (JSONOUT) console.log(JSON.stringify({ hit: false }))
else if (!ONCE) console.log('无新私信')
process.exit(1)
