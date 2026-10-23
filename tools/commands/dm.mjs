// 私信（专属通道）—— 2026-10-18 主人定：**三条写死在代码里**
//   ① **一天只锁定 1 个收信人**（防刷量；对同一个人发多少条不限 ✓）
//   ② 只发给配置里的 owner.mid（同一个用户，别处发不出去）
//   ④ **带 --share 时占「分享 3 条/天」的额度**（与评论区 @ 共用同一本账 ✓；不带则只是推送，不占额度）
//   ③ 必须互关（relation.attribute === 6），否则拒发
//
// 为什么写死：私信是 B站 风控最凶的接口（判营销/骚扰），而我们要的只是
// "把一条分享私密地送到主人手里"，不是群发工具 ✗ 所以能力越窄越安全 ✓
//
// 用法:
//   node dm.mjs --msg "…" --dry
//   node dm.mjs --msg "…" --go
//   node dm.mjs --status            （看今天额度 + 互关状态）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'
import { validateShare } from '../lib/share-policy.mjs'
import { gate, record } from '../lib/quota-gate.mjs'
import { buildDmMessage } from '../../lib/dm-message.mjs'
import { reviewDecision, reserveAuto, settleAuto, dmGapBlocks, dmSameThread } from '../../lib/policy.mjs'
import { STATE_DIR } from '../lib/paths.mjs'
import { addDraft, coordinates, checkApproval, beginSend, finishSend, claimShareContinuation, finishShareContinuation } from '../../lib/comment-state.mjs'
import { stateFile } from '../lib/paths.mjs'
import { workDir } from '../lib/paths.mjs'
import { readScope } from '../../lib/scope.mjs'

// 上游 v0.4.5 同步：稳定的设备 ID —— 只生成一次，之后永久复用 ✓
//   以前每发一条私信就随机一个新 dev_id ✗ → 风控看到「同一个人在不同设备间切换」→ 小号易被封控
//   真浏览器里这个值是固定的；存在 ~/.bili-ai/dev_id（0600），写坏了自动重建（只发生一次）
function stableDevId() {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const file = stateFile('dev_id')
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (/^WEB-[0-9A-F-]{20,}$/i.test(v)) return v
  } catch { /* 首次运行或文件坏了 → 重建 */ }
  const v = 'WEB-' + crypto.randomUUID().toUpperCase()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, v + '\n')
    try { fs.chmodSync(file, 0o600) } catch { /* Windows 上可能不支持 */ }
  } catch (e) { throw new Error('无法保存私信设备 ID，已停止发送：' + e.message) }
  return v
}

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const SHARE = !!opt.share       // ④ 分享型：占「分享 3 条/天」额度（与评论区 @ 共用 ✓）
// 分享型的 target 用正文里的 BV 号（"同一视频 7 天一次"才判得准 ✓）；没有就退回 dm:<mid>
const BV = (String(opt.msg ?? "").match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? "";
// ⚠️ SHARE_TARGET 移到 ONLY_TO 定义之后（2026-10-19 修：原先在模块顶层引用 ONLY_TO，触发 TDZ
//    ReferenceError: Cannot access 'ONLY_TO' before initialization → dm.mjs 整个跑不起来，
//    notify 的私信后端也跟着挂 ✗）
const DRY = !!opt.dry
const GO = !!opt.go
const STATUS = !!opt.status
const MSG = String(opt.msg ?? '').trim()
const CONTINUATION = typeof opt.continuation === 'string' ? opt.continuation : ''
if (opt.continuation && (!CONTINUATION || !SHARE)) { console.error('续送必须给 --share --continuation <operationId>'); process.exit(2) }
if (SHARE && !STATUS) {
  try { validateShare(config(), opt) } catch (e) { console.error(e.message); process.exit(2) }
}

// 2026-10-22：收信人先判，再读凭据 —— 免得「填错 mid」被「没凭据」的错误盖住。
//   只允许：主人 / 已启用且填了 mid 的女主人（两个人必须是两个账号）。
{
  const c0 = config()
  const owners = [String(c0.owner?.mid ?? '').trim()]
  const m = c0.mistress?.enabled === true && /^\d+$/.test(String(c0.mistress?.mid ?? '')) ? String(c0.mistress.mid) : ''
  if (m && m !== owners[0]) owners.push(m)
  const to0 = String(opt.to ?? '').trim()
  if (to0 && !owners.filter(Boolean).includes(to0)) {
    console.error('✗ 私信目标只能是主人，或「设置 → 鲸群 → 女主人」里启用并填了 mid 的那个账号')
    process.exit(7)
  }
}

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CRED = path.join(HOME, '.bili-ai', 'credentials.json')
const QUOTA = stateFile('dm-quota.json')
// 2026-10-21：用共用凭据层（trim + 缺字段检查 + 错误码翻译）
//   以前这里直接 JSON.parse 就用：bili_jct 空着也照发 → B站回裸的 code=-111，
//   用户看到"体检全绿 / 能查互关"却发不出去，完全不知道该改什么 ✗
const { loadCred, missingForWrite, explainCode, looksLikeJct } = await import('../lib/cred.mjs')
const cred = loadCred()
const miss = missingForWrite(cred)
if (miss.length) {
  console.error('✗ 凭据不完整，没法发私信：')
  for (const m of miss) console.error('   · 缺 ' + m)
  console.error('  → 设置页把 SESSDATA 和 bili_jct 【两个都】重新粘贴一次并保存 ✓')
  process.exit(2)
}
// 只检查"有没有"不够 —— 截断/粘错的 bili_jct 一样会让 B 站回 -111 ✗
if (!looksLikeJct(cred.bili_jct)) {
  console.error('⚠️ bili_jct 格式不像（长度 ' + String(cred.bili_jct).length + '，B站 目前是 32 位十六进制）')
  console.error('   发送大概率会被拒（code=-111 CSRF 校验失败）—— 建议回设置页重新粘贴一次')
  console.error('   （只读接口不受影响，所以"依赖体检全绿"不代表能发东西 ✗）')
  console.error('')
}
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')
// 2026-10-22：目标在下面「写死的三条」里解析（主人，或已启用的女主人）。
//   · 通知测试（--test）是宿主自己发的一条固定文案，不是陌生人内容 → 不走发前审核
const TEST = argv.includes('--test')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
}
const jget = async (u) => (await fetch(u, { headers: H })).json()
const loadQ = () => { try { return JSON.parse(fs.readFileSync(QUOTA, 'utf8')) } catch { return {} } }
const saveQ = (o) => { fs.mkdirSync(path.dirname(QUOTA), { recursive: true }); fs.writeFileSync(QUOTA, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')

// ── 写死的三条 ───────────────────────────────────────────────────────
const ONE_TARGET_PER_DAY = true  // ① 一天只锁定 1 个收信人（条数不限 ✓）
const MISTRESS_MID = cfg.mistress?.enabled === true && /^\d+$/.test(String(cfg.mistress?.mid ?? '')) ? String(cfg.mistress.mid) : ''
const RECIPIENTS = [OWNER, ...(MISTRESS_MID && MISTRESS_MID !== OWNER ? [MISTRESS_MID] : [])].filter(Boolean)
const TO_ARG = String(opt.to ?? '').trim()
let ONLY_TO = OWNER            // ② 默认只发给主人；女主人要显式 --to <她的 mid>
if (TO_ARG) {
  if (!RECIPIENTS.includes(TO_ARG)) {
    console.error('✗ 私信目标只能是主人，或「设置 → 鲸群 → 女主人」里启用并填了 mid 的那个账号')
    process.exit(7)
  }
  ONLY_TO = TO_ARG
}
const IS_MISTRESS = ONLY_TO === MISTRESS_MID
const REPLY = argv.includes('--reply')   // 回女主人发来的消息：不计主动私信额度，另有回复上限
const RECIPIENT_NAME = IS_MISTRESS ? String(cfg.mistress?.name ?? cfg.mistress?.title ?? '女主人') : OWNER_NAME
const MISTRESS_TITLE = String(cfg.mistress?.title ?? '女主人')
const REQUIRE_MUTUAL = true      // ③ 必须互关
// 分享型的 target：优先正文里的 BV（"同一视频 7 天一次"才判得准 ✓），否则退回 dm:<mid>
const targetBV = BV || (String(opt.target ?? "").match(/^(?:BV:)?(BV[0-9A-Za-z]{10})$/) ?? [])[1]
if (opt.target && (!/^(?:BV:)?BV[0-9A-Za-z]{10}$/.test(String(opt.target)) || BV && String(opt.target).replace(/^BV:/,'') !== BV)) {
  console.error('显式 --target 必须是有效且与正文一致的 BV'); process.exit(2)
}
if (SHARE && !STATUS && !targetBV) { console.error("分享需要正文或 --target 中的有效 BV 号"); process.exit(2) }
const SHARE_TARGET = targetBV ? "BV:" + targetBV : "dm:" + ONLY_TO
// 0.7.0（PLAN §3.3）：分享私信必须带能直接点开的链接 —— 正文只在这一个入口里构造。
//   预检、存草稿、审核凭据的指纹、真正 POST，用的都是这一段 FINAL，避免「批准的是 A、发出去的是 B」。
const built = buildDmMessage({ message: MSG, bvid: targetBV, share: SHARE && !STATUS })
if (!built.ok) { console.error('✗ ' + built.reason); process.exit(2) }
if (built.addedUrl) console.error('[私信] 正文里没带链接，已补一行视频地址（批准与发送用的是同一段文字）')
const FINAL = built.text
const continuationDetails = { ownerMid: OWNER, bvid: targetBV, message: FINAL }
if (CONTINUATION) {
  try { claimShareContinuation(CONTINUATION, continuationDetails, { claim: false }) }
  catch(e) { console.error('[续送] ' + e.message); process.exit(7) }
}

// 审核凭据（坐标随收信人变）：女主人 → 也要绑她 + 正文；通知测试是宿主固定文案 → 免审
const draft = coordinates({ kind: 'dm', to: ONLY_TO, message: FINAL })
const approval = { operationId: opt['operation-id'], token: opt.approval }
// 0.7.0：审核档位由 lib/policy.mjs 统一决策（policy + dm.autoSend + 收信人白名单 + 静音时段）
const decision = reviewDecision({ kind: 'dm', role: IS_MISTRESS ? 'mistress' : 'owner', relationship: 'mutual', share: SHARE, cfg })
// 续送（--continuation）是宿主在批准分享评论时一并签发的，不再二次问；通知测试是宿主固定文案
// 分享型私信（--share）走 share 闸，不走审核档位（与分享评论一致，主人已明确「分享不必每次问」）
const needsApproval = !TEST && !CONTINUATION && !SHARE && decision.required
if (GO && (needsApproval || approval.token) && !checkApproval(draft, approval)) {
  console.error(IS_MISTRESS
    ? `[审核] ${decision.reason} —— 已存草稿，批准后由设置页发送。`
    : `[审核] ${decision.reason} —— 已存草稿，批准后再发。`)
  try {
    const dr = addDraft({
      kind: 'dm', to: ONLY_TO, message: FINAL, bvid: targetBV ?? '', who: RECIPIENT_NAME, src: '审核未通过',
      share: !!(SHARE && !STATUS), reason: opt.reason ?? '', score: opt.score ?? '', rank: opt.rank ?? 1,
      topic: '发前审核',
    })
    console.error(dr.duplicate ? `  → 同一条草稿已在待审列表里（id ${dr.item.id}）` : `  → 已存成草稿（id ${dr.item.id}），在设置页点「发」才会真发`)
  } catch (e) { console.error('  → 存草稿失败：' + String(e.message).slice(0, 120)) }
  process.exit(7)
}

async function me() {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
  if (!nav.data?.isLogin) { console.error('✗ 未登录（cookie 失效 ✗）'); process.exit(3) }
  return { mid: String(nav.data.mid), uname: nav.data.uname }
}

async function relation(toMid) {
  const j = await jget(`https://api.bilibili.com/x/relation?fid=${toMid}`)
  if (j.code !== 0) return { ok: false, attribute: -1, why: `关系接口 code=${j.code}` }
  return { ok: true, attribute: Number(j.data?.attribute ?? -1), beAttribute: j.data?.be_relation?.attribute == null ? null : Number(j.data.be_relation.attribute) }
}

function relationLines(rel, meInfo) {
  if (!rel.ok) return [rel.why + '，无法确认关注方向，请稍后重试']
  const outgoing = [2, 6].includes(rel.attribute)
  const incoming = rel.attribute === 6 || (rel.beAttribute != null ? [2, 6].includes(rel.beAttribute) : null)
  const lines = [
    `她 → 主人：${outgoing ? '已关注' : '未关注'}`,
    `主人 → 她：${incoming === null ? '未知（请在主人账号确认）' : incoming ? '已关注' : '未关注'}`,
  ]
  if (!outgoing) lines.push(`请登录她的账号，在 https://space.bilibili.com/${ONLY_TO} 手动关注主人。`)
  if (incoming !== true) lines.push(`请登录主人账号，在 https://space.bilibili.com/${meInfo.mid} 确认并手动关注她。`)
  if (rel.attribute === 128 || rel.beAttribute === 128) lines.push('存在拉黑关系，请先检查双方黑名单。')
  return lines
}

async function send(toMid, text) {
  const body = new URLSearchParams()
  body.set('msg[sender_uid]', String((await me()).mid))
  body.set('msg[receiver_id]', String(toMid))
  body.set('msg[receiver_type]', '1')
  body.set('msg[msg_type]', '1')
  body.set('msg[msg_status]', '0')
  body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
  body.set('msg[dev_id]', stableDevId())
  body.set('msg[content]', JSON.stringify({ content: text }))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const j = await r.json().catch(() => ({}))
  return { http: r.status, code: j.code, message: j.message, data: j.data }
}

if (STATUS) {
  const q = loadQ()
  const lockedToday = q.date === today() ? String(q.mid ?? '') : ''
  const rel = await relation(ONLY_TO)
  const meInfo = await me()
  console.log(`账号: ${meInfo.uname}（mid ${meInfo.mid}）`)
  console.log(`专属对象: ${OWNER_NAME}（mid ${OWNER || '未配置'}）${MISTRESS_MID ? ` · ${MISTRESS_TITLE}: ${cfg.mistress?.name ?? ''}（mid ${MISTRESS_MID}）` : ''}`)
  console.log(`今天锁定给: ${lockedToday || '（还没发过）'}${lockedToday && !RECIPIENTS.includes(lockedToday) ? '  ⚠️ 和当前配置不一致 ✗' : ''}`)
  console.log(`今日已发: ${q.date === today() ? Number(q.count ?? 0) : 0} 条（**条数不限** ✓ 只限收信人 ✓）`)
  console.log(`互关状态: attribute=${rel.attribute} ${rel.attribute === 6 ? '（✓ 互关，可以发）' : '（✗ 不是互关，发不出去）'}`)
  for (const line of relationLines(rel, meInfo)) console.log(line)
  if (!rel.ok) process.exit(3)
  process.exit(0)
}

if (!MSG) { console.error('用法: node dm.mjs --msg "…" [--share --target BV…] --dry|--go   |   --status'); process.exit(2) }

// ── 闸门（写死，不接受参数覆盖）──────────────────────────────────────
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空 —— 私信只发给主人，没配就不发'); process.exit(2) }
if (MSG.length > 300) { console.error(`✗ 私信太长（${MSG.length} > 300 字），退化成刷屏了 ✗`); process.exit(2) }

const meInfo = await me()
if (String(meInfo.mid) === ONLY_TO) { console.error('✗ 不能给自己发私信'); process.exit(2) }

const rel = await relation(ONLY_TO)
if (!rel.ok) { console.error(`✗ ${rel.why}`); process.exit(3) }
if (REQUIRE_MUTUAL && rel.attribute !== 6) {
  console.error(`✗ 未互关（attribute=${rel.attribute}）—— 私信通道要求双方互相关注 ✓`)
  for (const line of relationLines(rel, meInfo)) console.error(line)
  process.exit(4)
}

const q = loadQ()
const used = q.date === today() ? Number(q.count ?? 0) : 0
// 0.7.5：私信自己也有日上限与最小间隔（这两个设置以前只写在默认值里、从没生效过）。
//   回复私信（--reply，女主人发来消息）不受日上限约束 —— 人家来问，总得让回。
if (SHARE && !IS_MISTRESS && !REPLY && !DRY && !CONTINUATION) {
  const cap = Math.max(0, Math.floor(Number(cfg.dm?.maxPerDay ?? 1)))
  if (cap <= 0) { console.error('✗ 私信每天条数上限是 0 —— 去设置里调大（或先用草稿手动发）'); process.exit(4) }
  if (used >= cap) { console.error(`✗ 今天主动私信已发 ${used} 条（上限 ${cap}）—— 调高「私信·每天条数」或等明天`); process.exit(4) }
  const gapMin = Math.max(0, Math.floor(Number(cfg.dm?.minGapMinutes ?? 240)))
  const lastAt = Date.parse(String(q.at ?? ''))
  // 「相关/连续」的消息不受间隔限制：同一轮写的（摘要 + 分享）、同一个视频的续聊、或拆分长文（--continues）。
  const scopeNow = readScope(workDir)
  const sameThread = dmSameThread({ last: q, targetBvid: targetBV, continues: argv.includes('--continues'), scope: scopeNow })
  const gap = dmGapBlocks({ lastAt, gapMin, sameThread })
  if (gap.blocked) {
    console.error(`✗ 离上一条主动私信不到 ${gapMin} 分钟（还剩 ${gap.leftMin} 分钟）—— 想发快些就把「两条私信最少隔」调小；同话题续发/拆分长文用 --continues 不受此限`)
    process.exit(4)
  }
}
// ① 一天只锁定 1 个收信人（条数不限 ✓）：如果今天已经发给过别人 → 拒
if (ONE_TARGET_PER_DAY && q.date === today() && q.mid && String(q.mid) !== ONLY_TO) {
  console.error(`✗ 今天已经锁定给 mid ${q.mid} 了 —— 一天只能锁定 1 个收信人（防刷量 ✗）`)
  process.exit(4)
}
// 女主人的份额是单独的一本小账：每天 cfg.mistress.shareDaily 条（默认 1），不占主人的分享额度
const MQ = stateFile('dm-mistress.json')
const loadMQ = () => { try { return JSON.parse(fs.readFileSync(MQ, 'utf8')) } catch { return {} } }
const saveMQ = (o) => { try { fs.mkdirSync(path.dirname(MQ), { recursive: true }); fs.writeFileSync(MQ, JSON.stringify(o, null, 2) + '\n') } catch { /* 记账失败不重发 */ } }
const mq = loadMQ()
const mistressUsed = mq.date === today() ? Number(mq.count ?? 0) : 0
const mistressReplied = mq.date === today() ? Number(mq.replies ?? 0) : 0
// 主动私信/分享给她：一天 cfg.mistress.shareDaily 条（默认 1，可改）
if (IS_MISTRESS && SHARE && !CONTINUATION) {
  const limit = Math.max(0, Number(cfg.mistress?.shareDaily ?? 1))
  if (limit <= 0) { console.error(`✗ 女主人每天主动私信上限是 0 —— 去设置里调大，或者这次别发`); process.exit(4) }
  if (mistressUsed >= limit) { console.error(`✗ 今天已经主动给她发过 ${mistressUsed} 条（上限 ${limit}）—— 明天再聊 ✓`); process.exit(4) }
}
// 回她的消息：不占主动额度，但也要有个上限防止刷屏（默认 6，可改）
if (IS_MISTRESS && REPLY) {
  // 0 = 不限（默认；她来问就回，别让「防刷屏」拦住应答）
  const cap = Math.max(0, Number(cfg.mistress?.replyMaxPerDay ?? 0))
  if (cap > 0 && mistressReplied >= cap) { console.error(`✗ 今天回她已有 ${mistressReplied} 条（上限 ${cap}）—— 明天再说`); process.exit(4) }
}

console.log(`[dm] ${meInfo.uname} → ${RECIPIENT_NAME}（mid ${ONLY_TO}）${IS_MISTRESS ? (REPLY ? ' · 女主人回复（不占主动额度，过审核）' : ' · 女主人通道（主动 10 条/天、回复不限、过审核）') : ''}`)
console.log(`  正文 ${FINAL.length} 字：${FINAL.slice(0, 80)}${FINAL.length > 80 ? '…' : ''}`)
console.log(`  互关 ✓  ·  今天第 ${(IS_MISTRESS ? mistressUsed : used) + 1} 条（上限 ${IS_MISTRESS ? Math.max(0, Number(cfg.mistress?.shareDaily ?? 1)) : Math.max(0, Math.floor(Number(cfg.dm?.maxPerDay ?? 1)))} 条/天 ✓ 锁定给 ${RECIPIENT_NAME} ✓）`)

if (!GO && !DRY) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }

// ④ 分享型先过闸（日上限 / 同一视频 7 天一次 / 评分卡 …由 quota 统一管 ✓）
//    女主人的分享走她自己的 1 条/天 小账，不占主人额度，所以不过这本闸
if (SHARE && !CONTINUATION && !IS_MISTRESS) {
  const ok = gate({ type: 'dm', target: SHARE_TARGET, auto: true, share: true })
  if (!ok) { console.error('✗ 分享额度不允许（见上面的 [限额闸] 输出）'); process.exit(4) }
}
if (DRY) { console.log('  [dry] 预检通过（额度闸也看了），未发送 ✓ 正式发送时会重新检查额度'); process.exit(0) }

// 0.7.0：没经过主人手的那部分，也要过「自动发送额度」（每天 / 每人 / 静音时段）。
//   预留 → 发送 → 结算；预留失败就转草稿，绝不硬发。
let autoOpId = null
const roundScope = readScope(workDir)
const scopeAge = Date.now() - Date.parse(roundScope?.at ?? '')
const ownerRequested = !IS_MISTRESS && roundScope?.userInitiated === true && scopeAge >= 0 && scopeAge < 4 * 3600_000
// 给主人正常回复与主人手动叫醒，不占自主推荐的发送限额。
const autonomousDm = IS_MISTRESS || (SHARE && !ownerRequested)
if (!needsApproval && !CONTINUATION && autonomousDm) {
  const opId = `dm-${crypto.randomBytes(6).toString('hex')}`
  const reserved = reserveAuto(STATE_DIR, { opId, kind: 'dm', mid: ONLY_TO, limits: decision.limits })
  if (!reserved.ok) {
    console.error(`[自动发送] ${reserved.reason}`)
    const draftRes = addDraft({
      kind: 'dm', to: ONLY_TO, message: FINAL, bvid: targetBV ?? '', who: RECIPIENT_NAME, src: 'auto-budget',
      share: !!(SHARE && !STATUS), reason: opt.reason ?? '', score: opt.score ?? '', rank: opt.rank ?? 1,
      topic: '自动发送额度用尽：' + String(reserved.reason ?? ''),
    })
    console.error(draftRes.duplicate ? `  → 同一条草稿已经在待审列表里（id ${draftRes.item.id}）` : `  → 已转成草稿（id ${draftRes.item.id}），在设置页审核后再发`)
    process.exit(4)
  }
  autoOpId = opId
}

let operationId
try {
  if (CONTINUATION) claimShareContinuation(CONTINUATION, continuationDetails)
  else {
    operationId = beginSend(draft, { ...approval, required: needsApproval })
    finishSend(operationId, 'sending', { channel: 'dm', share: SHARE, bvid: targetBV ?? '' })
  }
} catch(e) { console.error('[审核/续送] ' + e.message); process.exit(7) }
const finish = (status, details) => CONTINUATION ? finishShareContinuation(CONTINUATION, status, details) : finishSend(operationId, status, details)
let r
try { r = await send(ONLY_TO, FINAL) }
catch(e) { finish('uncertain', {reason: String(e.message).slice(0,200)}); if (autoOpId) settleAuto(STATE_DIR, autoOpId, 'uncertain'); console.error('发送结果不明，请人工核对，勿重发'); process.exit(8) }
if (r.http >= 200 && r.http < 300 && r.code === 0) {
  finish('accepted', { code: 0, accountingStatus: 'pending' })
  if (autoOpId) settleAuto(STATE_DIR, autoOpId, 'accepted')
  let complete = true
  try {
    if (IS_MISTRESS) {
      // 女主人的私信单独记账：不占主人的分享额度（她那份上限写在设置里）
      saveMQ({
        date: today(),
        count: REPLY ? Number(mq.date === today() ? mq.count ?? 0 : 0) : mistressUsed + 1,
        replies: REPLY ? mistressReplied + 1 : Number(mq.date === today() ? mq.replies ?? 0 : 0),
        mid: ONLY_TO,
        at: new Date().toISOString(),
      })
      try {
        fs.appendFileSync(path.join(HOME, '.dsh', 'pod-log.jsonl'), JSON.stringify({
          at: new Date().toISOString(), kind: 'mistress-share',
          target: targetBV ? `BV:${targetBV}` : `mid:${ONLY_TO}`,
          note: FINAL.slice(0, 60),
        }) + '\n')
      } catch { /* 事件流丢了不影响发送结果 */ }
    } else {
      saveQ({ date: today(), count: used + 1, mid: ONLY_TO, at: new Date().toISOString(), bvid: targetBV ?? '', round: readScope(workDir)?.round ?? '' })
      if (SHARE && !CONTINUATION) complete = record({ type: 'dm', target: SHARE_TARGET, note: FINAL.slice(0, 40), auto: true, share: true, operationId }).code === 0
    }
  } catch { complete = false }
  if (CONTINUATION) {
    // Accepted stays final even if the optional local DM counter cannot be saved.
    console.log(`  ✓ 已发送（HTTP ${r.http}） · 复用原分享额度，不重复计账${complete ? '' : '；本地DM计数未完成，勿重发'}`)
  } else {
    finish('accepted', { accountingStatus: complete ? 'complete' : 'incomplete' })
    console.log(`  ✓ 已发送（HTTP ${r.http}）${SHARE ? ' · 已记入分享额度 ✓' : ' · 回复不占分享额度 ✓'}${complete ? '' : '；本地记账未完成，勿重发'}`)
  }
  process.exit(0)
}
finish(typeof r.code === 'number' && r.code !== 0 ? 'rejected' : 'uncertain', { code: r.code ?? null, reason: String(r.message ?? '') })
if (autoOpId) settleAuto(STATE_DIR, autoOpId, typeof r.code === 'number' && r.code !== 0 ? 'rejected' : 'uncertain')
console.error(`  ✗ 发送失败：HTTP ${r.http} ${explainCode(r.code)}${r.message ? `（B站原文：${r.message}）` : ''}`)
process.exit(1)
