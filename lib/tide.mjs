/**
 * lib/tide.mjs —— 可选生物钟「峰谷模式」
 * ============================================================================
 * 基座的作息是「固定窗口 + 每窗醒来 N 次」（night.windows）。
 * 这里再加一种可选的：**峰谷**
 *   · 峰（状态好的时段，例如晚饭后）醒得多、更容易真的去看；
 *   · 谷（午间犯困、通勤）醒得少、跳过概率高；
 *   · 两者都受一个「清醒区间 activeStart–activeEnd」夹着（否则半夜醒来很奇怪）。
 *
 * 关键：不改基座的 makePlan 语义 —— 只是把 night 配置**翻译**成一份
 * {windows, skipChance, skipChanceFor} 再交给它，所以两种模式共用同一套
 * 记账 / 窗口历史 / 补跑逻辑（老计划文件也能读）。
 * ============================================================================
 */
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null
  return h * 60 + mi
}
const toHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

export const TIDE_DEFAULTS = {
  activeStart: '08:30',
  activeEnd: '23:30',
  peakStart: '19:00',
  peakEnd: '23:00',
  wakesPeak: 2,
  skipPeak: 0.1,
  valleyStart: '12:30',
  valleyEnd: '14:00',
  wakesValley: 1,
  skipValley: 0.6,
  extraStart: '',
  extraEnd: '',
  wakesExtra: 0,
}

/** 规范化：缺省补全、非法时间抛错（设置页保存时会把它变成一句人话） */
export function normalizeTide(raw = {}) {
  const t = { ...TIDE_DEFAULTS, ...(raw ?? {}) }
  const out = { ...t }
  for (const k of ['activeStart', 'activeEnd', 'peakStart', 'peakEnd', 'valleyStart', 'valleyEnd', 'extraStart', 'extraEnd']) {
    if (out[k] === '' && (k === 'extraStart' || k === 'extraEnd')) continue
    if (toMin(out[k]) === null) out[k] = TIDE_DEFAULTS[k]
  }
  out.wakesPeak = clamp(Number(out.wakesPeak ?? 2), 0, 12)
  out.wakesValley = clamp(Number(out.wakesValley ?? 1), 0, 12)
  out.wakesExtra = clamp(Number(out.wakesExtra ?? 0), 0, 12)
  out.skipPeak = clamp(Number(out.skipPeak ?? 0.1), 0, 0.95)
  out.skipValley = clamp(Number(out.skipValley ?? 0.6), 0, 0.95)
  return out
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))

/**
 * 把峰 / 谷 / 加档翻译成窗口数组（形状与 night.windows 一致）。
 * 窗口会被 active 区间裁剪；完全落在清醒区间外的直接丢弃。
 */
export function tideWindows(raw = {}) {
  const t = normalizeTide(raw)
  const activeStart = toMin(t.activeStart)
  const activeEndRaw = toMin(t.activeEnd)
  const activeEnd = activeEndRaw <= activeStart ? activeEndRaw + 1440 : activeEndRaw
  const specs = [
    { key: 'peak', label: '峰', start: toMin(t.peakStart), end: toMin(t.peakEnd), wakes: t.wakesPeak, skip: t.skipPeak },
    { key: 'valley', label: '谷', start: toMin(t.valleyStart), end: toMin(t.valleyEnd), wakes: t.wakesValley, skip: t.skipValley },
  ]
  if (t.extraStart && t.extraEnd) {
    specs.push({ key: 'extra', label: '加档', start: toMin(t.extraStart), end: toMin(t.extraEnd), wakes: t.wakesExtra, skip: Math.min(0.95, (t.skipPeak + t.skipValley) / 2) })
  }
  const out = []
  for (const s of specs) {
    if (s.wakes <= 0) continue
    const endRaw = s.end <= s.start ? s.end + 1440 : s.end
    // 将子窗口的前一天、当天、次日映射到同一个连续时间轴再裁剪。
    const clips = [-1440, 0, 1440].map(shift => ({
      lo: Math.max(s.start + shift, activeStart), hi: Math.min(endRaw + shift, activeEnd),
    })).filter(({ lo, hi }) => hi - lo >= 5) // 少于 5 分钟不值得醒
    if (!clips.length) continue
    // 拆段沿用原窗口的总整数额度，按有效时长分配；最大余数优先，平手取较早段。
    // 0 次段仍保留，inWindow 可继续在该段监听；不向其他段转移未用次数。
    const totalMinutes = clips.reduce((sum, c) => sum + c.hi - c.lo, 0)
    const budget = Math.floor(s.wakes)
    const shares = clips.map(c => budget * (c.hi - c.lo) / totalMinutes)
    const quotas = shares.map(Math.floor)
    const priority = shares.map((share, i) => ({ i, remainder: share - quotas[i] }))
      .sort((a, b) => b.remainder - a.remainder || clips[a.i].lo - clips[b.i].lo)
    for (let n = budget - quotas.reduce((sum, q) => sum + q, 0), i = 0; i < n; i++) quotas[priority[i].i]++
    clips.forEach(({ lo: start, hi: end }, i) => out.push({
      start: toHhmm(((start % 1440) + 1440) % 1440),
      end: toHhmm(((end % 1440) + 1440) % 1440),
      wakes: clips.length === 1 ? s.wakes : quotas[i],
      // 供 makePlan 用（不入盘）
      _kind: s.key,
      _label: `${s.label} ${toHhmm(((start % 1440) + 1440) % 1440)}–${toHhmm(((end % 1440) + 1440) % 1440)}`,
      _skip: s.skip,
    }))
  }
  // 按开始时间排序；跨午夜的（end < start）排后面
  return out.sort((a, b) => toMin(a.start) - toMin(b.start))
}

/**
 * 交给 makePlan 的 night 配置。
 * mode=fixed → 原样（只补 skipChanceFor 缺省）；mode=tide → 换成峰谷窗口。
 */
export function applyTide(nightCfg = {}, now = Date.now()) {
  const base = { ...(nightCfg ?? {}) }
  if ((base.mode ?? 'fixed') !== 'tide') {
    if (typeof base.skipChanceFor !== 'function') base.skipChanceFor = () => Number(base.skipChance ?? 0.3)
    return base
  }
  const wins = tideWindows(base.tide ?? {})
  const byLabel = new Map(wins.map((w) => [w._label, w]))
  // 保存时 _label 会丢（JSON），所以计划里只存 start–end；查找时按 start/end 兜底
  const skipFor = (w) => {
    const hit = byLabel.get(w.label) ?? wins.find((x) => `${x.start}–${x.end}` === w.label)
    return hit ? hit._skip : Number(base.skipChance ?? 0.3)
  }
  return {
    ...base,
    windows: wins.map(({ start, end, wakes, _label }) => ({ start, end, wakes, label: _label })),
    windowsMode: 'tide',
    skipChance: Number(base.tide?.skipPeak ?? base.skipChance ?? 0.3),
    skipChanceFor: skipFor,
    tide: normalizeTide(base.tide ?? {}),
  }
}

/** 设置页用：今天（从现在起）的窗口预览，人话 */
export function previewTide(nightCfg = {}, now = Date.now()) {
  const cfg = applyTide(nightCfg, now)
  const wins = Array.isArray(cfg.windows) ? cfg.windows : []
  return wins.map((w) => ({
    label: w.label ?? `${w.start}–${w.end}`,
    start: w.start,
    end: w.end,
    wakes: Number(w.wakes ?? 1),
    skipChance: typeof cfg.skipChanceFor === 'function' ? cfg.skipChanceFor(w) : Number(cfg.skipChance ?? 0.3),
  }))
}

/** 一句人话总结（给日志 / 设置页提示） */
export function describeTide(raw = {}) {
  const t = normalizeTide(raw)
  const wins = tideWindows(t)
  if (!wins.length) return `峰谷模式没有可用窗口（清醒区间 ${t.activeStart}–${t.activeEnd}）`
  return `峰 ${t.peakStart}–${t.peakEnd}（醒 ${t.wakesPeak} 次，跳过 ${Math.round(t.skipPeak * 100)}%）· 谷 ${t.valleyStart}–${t.valleyEnd}（醒 ${t.wakesValley} 次，跳过 ${Math.round(t.skipValley * 100)}%）`
}
