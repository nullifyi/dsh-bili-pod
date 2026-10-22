/**
 * lib/policy.mjs —— 「这句话要不要先问主人」的唯一决策点 + 自动发送额度
 * ============================================================================
 * 0.6.x 之前，两处各写各的布尔：
 *   comment.mjs：needsApproval = preReview !== false && (root || parent)
 *   dm.mjs     ：needsApproval = !SHARE && !TEST && preReview !== false
 * 结果：档位一多就互相打架（比如「全免」了私信还拦着、「自动发」了私信又没开）。
 *
 * 现在统一成：
 *   review.policy ∈ ask | auto-owner | auto-quiet | off
 *   + 私信要额外满足 dm.autoSend 与 dm.autoSendTo（两道门都开才免审）
 *   + 自动发出还要过 autoLimits（总量、单人量、静音时段）
 *
 * 重要边界：policy 只决定「要不要先问主人」，**不**放宽任何硬闸门
 * （配额、互关、分享策略、收信人白名单、去重、禁发）。
 * ============================================================================
 */
import path from 'node:path'
import { withFileLock, readJson, atomicJson } from './file-state.mjs'

export const POLICIES = ['ask', 'auto-owner', 'auto-quiet', 'off']

export const POLICY_LABEL = {
  ask: '每次都问我',
  'auto-owner': '只放行自家人（主人）',
  'auto-quiet': '自家人 + 核实过的互关/粉丝',
  off: '不再人工审核',
}

export const DEFAULT_AUTO_LIMITS = {
  perDay: 12,
  perPersonPerDay: 1,
  // 静音时段默认空：她可能在低价时段（00:30–08:30）醒来，硬静音会把所有自动消息变成草稿。
  // 想用就在设置页填，比如 00:30 → 08:30。
  quietHours: [],
}

/** 读有效档位：显式 policy 优先；只有它缺失时才从旧 preReview 迁移 */
export function policyOf(cfg) {
  const p = cfg?.review?.policy
  if (POLICIES.includes(p)) return p
  // 迁移：明确关过（preReview=false）就保持 off；其余旧配置按主人 2026-10-22 的要求进第三档
  return cfg?.review?.preReview === false ? 'off' : 'auto-quiet'
}

/** 迁移标记：这个配置是不是「旧配置」（没写 policy 但已经有 review 段） */
export function needsPolicyMigration(raw) {
  const review = raw?.review
  return !!review && typeof review === 'object' && !Object.hasOwn(review, 'policy')
}

export function autoLimitsOf(cfg) {
  const raw = cfg?.review?.autoLimits
  return { ...DEFAULT_AUTO_LIMITS, ...(raw && typeof raw === 'object' ? raw : {}) }
}

/** 本地时钟的「现在」（分钟） */
function localMinutes(now = Date.now()) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

/** "HH:MM" → 分钟；非法返回 null */
export function parseHhmm(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 现在是否落在静音时段里（支持跨零点，如 00:30–08:30） */
export function inQuietHours(ranges, now = Date.now()) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false
  const cur = localMinutes(now)
  for (const r of ranges) {
    const a = parseHhmm(r?.start)
    const b = parseHhmm(r?.end)
    if (a == null || b == null) continue
    if (a <= b) { if (cur >= a && cur < b) return true }
    else if (cur >= a || cur < b) return true
  }
  return false
}

function reasonText({ policy, role, kind, relationship, quiet, dmOn, dmRoles }) {
  if (quiet) return `现在在静音时段（${kind === 'dm' ? '自动私信' : '自动回复'}改成等你点头）`
  if (kind === 'dm' && !dmOn) return '私信自动发送没开（dm.autoSend=false）→ 先存草稿'
  if (kind === 'dm' && dmOn && !dmRoles.includes(role)) return `「只自动发给」里没有${role === 'owner' ? '主人' : '女主人'} → 先存草稿`
  if (policy === 'ask') return '现在是「每次都问我」'
  if (policy === 'off') return '「不再人工审核」已开'
  if (role === 'owner') return '自家人 → 直接发'
  if (policy === 'auto-quiet' && relationship === 'mutual') return '核实过是互关 → 直接发'
  if (policy === 'auto-quiet' && relationship === 'fan') return '核实过是粉丝 → 直接发'
  return '陌生人不自动发 → 先存草稿'
}

/**
 * 决策：这条消息能不能不经主人手就发？
 * @param {object} p
 * @param {'comment'|'dm'} p.kind
 * @param {'owner'|'mistress'|'stranger'} p.role       真实查询得到的角色（不许 CLI 自报）
 * @param {'mutual'|'fan'|'none'|'unknown'} [p.relationship]
 * @param {boolean} [p.share]
 * @param {object} p.cfg
 * @param {number} [p.now]
 * @returns {{policy:string, required:boolean, auto:boolean, quiet:boolean, reason:string, limits:object}}
 */
export function reviewDecision({ kind, role = 'stranger', relationship = 'unknown', share = false, cfg, now = Date.now() } = {}) {
  const policy = policyOf(cfg)
  const limits = autoLimitsOf(cfg)
  let required
  if (policy === 'off') required = false
  else if (policy === 'ask') required = true
  // 主角/女主人都是「自家人」；女主人权限低一档由 dm.autoSendTo 与分享配额再收一次。
  else if (policy === 'auto-owner') required = role === 'stranger'
  else required = !(role !== 'stranger' || (kind === 'comment' && (relationship === 'mutual' || relationship === 'fan')))

  const dmOn = cfg?.dm?.autoSend === true
  const dmRoles = Array.isArray(cfg?.dm?.autoSendTo) && cfg.dm.autoSendTo.length ? cfg.dm.autoSendTo : ['owner']
  // 顺序很重要：policy=off 是「主人自己关掉了审核」，不该再被 dm.autoSend 拦住；
  //   dm.autoSend 只在「本该自动发」的档位里决定私信要不要真的自动发。
  if (policy !== 'off' && kind === 'dm' && !required && !(dmOn && dmRoles.includes(role))) required = true

  const quiet = policy !== 'off' && !required && inQuietHours(limits.quietHours, now)
  if (quiet) required = true

  return {
    policy,
    required,
    auto: !required,
    quiet,
    share: !!share,
    limits,
    reason: reasonText({ policy, role, kind, relationship, quiet, dmOn, dmRoles }),
  }
}

// ── 自动发送额度（预留 → 发送 → 结算）────────────────────────────────────
// 为什么不「读总数 → 发 → 总数+1」：两个进程同时抢最后一格会双发。
// 这里在文件锁内预留（reserved），发完结算（accepted/rejected/uncertain）。

const fileOf = (stateDir) => path.join(stateDir, 'auto-sent.json')

function emptyDay(now) {
  return { day: new Date(now).toLocaleDateString('sv-SE'), items: [] }
}

function normDay(db, now) {
  const day = new Date(now).toLocaleDateString('sv-SE')
  if (!db || db.day !== day || !Array.isArray(db.items)) return emptyDay(now)
  return db
}

/** 读今天已经占用的额度（给设置页/状态用，不加锁，只看） */
export function autoBudget(stateDir, now = Date.now()) {
  let db
  try { db = readJson(fileOf(stateDir), emptyDay(now)) } catch { db = emptyDay(now) }
  const day = normDay(db, now)
  const counts = { total: 0, byMid: {} }
  for (const it of day.items) {
    if (!it || !['reserved', 'accepted', 'uncertain'].includes(it.status)) continue
    counts.total += 1
    const key = String(it.mid ?? '')
    counts.byMid[key] = (counts.byMid[key] ?? 0) + 1
  }
  return { day: day.day, ...counts, items: day.items, file: fileOf(stateDir) }
}

/**
 * 预留一格自动额度。返回 {ok, reason?, opId, limits}
 * opId 用于结算：同一 operationId 重复预留是幂等的（不会重复计数）。
 */
export function reserveAuto(stateDir, { opId, kind, mid, now = Date.now(), limits = DEFAULT_AUTO_LIMITS } = {}) {
  const file = fileOf(stateDir)
  return withFileLock(file, () => {
    const db = normDay(readJson(file, emptyDay(now)), now)
    const id = String(opId ?? '')
    if (!id) return { ok: false, reason: '缺少 operationId，不能预留自动额度' }
    if (db.items.some((x) => x.opId === id)) return { ok: true, reason: '重复预留（幂等）', opId: id }
    const live = db.items.filter((x) => ['reserved', 'accepted', 'uncertain'].includes(x.status))
    const perDay = Math.max(0, Number(limits.perDay ?? DEFAULT_AUTO_LIMITS.perDay))
    const perPerson = Math.max(0, Number(limits.perPersonPerDay ?? DEFAULT_AUTO_LIMITS.perPersonPerDay))
    if (live.length >= perDay) return { ok: false, reason: `今天自动发出的条数到上限了（${live.length}/${perDay}）→ 这条转成草稿` }
    const mine = live.filter((x) => String(x.mid ?? '') === String(mid ?? '')).length
    if (perPerson > 0 && mine >= perPerson) return { ok: false, reason: `同一个人今天已经自动发过 ${mine} 条（上限 ${perPerson}）→ 这条转成草稿` }
    db.items.push({ opId: id, kind: String(kind ?? ''), mid: String(mid ?? ''), status: 'reserved', at: new Date(now).toISOString() })
    atomicJson(file, db)
    return { ok: true, opId: id }
  })
}

/** 结算：accepted / rejected / uncertain（uncertain 也占额度，防止盲目重发） */
export function settleAuto(stateDir, opId, status) {
  if (!['accepted', 'rejected', 'uncertain'].includes(status)) return null
  const file = fileOf(stateDir)
  return withFileLock(file, () => {
    const db = normDay(readJson(file, emptyDay(Date.now())), Date.now())
    const it = db.items.find((x) => x.opId === String(opId))
    if (!it) return null
    it.status = status
    it.settledAt = new Date().toISOString()
    atomicJson(file, db)
    return it
  })
}
