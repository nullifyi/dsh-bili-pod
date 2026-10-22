// All comparisons use absolute local-calendar timestamps, including midnight/DST.
export const dayOf = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE')
const stamp = (day, minutes) => {
  const d = new Date(`${day}T00:00:00`)
  d.setMinutes(minutes)
  return d.getTime()
}
const parse = (s) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(s))
  if (!match) throw new Error(`无效作息时间：${s}`)
  const h = Number(match[1]), m = Number(match[2])
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`无效作息时间：${s}`)
  return h * 60 + m
}
export function windowsOf(cfg) {
  const list = Array.isArray(cfg.windows) ? cfg.windows : [{ start: cfg.windowStart ?? '20:00', end: cfg.windowEnd ?? '24:00', wakes: cfg.maxWakesPerDay ?? 1 }]
  return list.map(w => {
    const start = parse(w.start), rawEnd = parse(w.end)
    const end = rawEnd <= start ? rawEnd + 1440 : rawEnd
    return { start, end, wrap: end > 1440, label: `${w.start}–${w.end}`, wakes: Math.min(12, Math.max(0, Math.floor(Number(w.wakes ?? 1) || 0))) }
  })
}
export const maxWakes = cfg => Math.min(12, windowsOf(cfg).reduce((n, w) => n + w.wakes, 0))
export function occurrences(cfg, now = Date.now()) {
  const today = dayOf(now), yesterday = new Date(`${today}T00:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  return windowsOf(cfg).flatMap(w => (w.wrap ? [dayOf(yesterday), today] : [today]).map(day => ({
    ...w, key: `${day}|${w.label}`, startsAt: stamp(day, w.start), endsAt: stamp(day, w.end),
  }))).filter(w => w.endsAt > now)
}
export const inWindow = (cfg, now = Date.now()) => occurrences(cfg, now).some(w => w.startsAt <= now)

// Keep history by dated window occurrence. A configuration save must not erase it.
export function historyOf(state = {}, now = Date.now()) {
  const usedCount = { ...(state.usedCount ?? {}) }
  const skippedWindows = new Set(state.skippedWindows ?? [])
  if (state.schema !== 2 && state.date) {
    for (const [label, count] of Object.entries(usedCount)) {
      if (!label.includes('|')) {
        // Legacy plans reserved a wake before delivery; release only that reservation.
        const reserved = state.action === 'wake' && !state.fired && !state.woke && label === state.window ? 1 : 0
        usedCount[`${state.date}|${label}`] = Math.max(0, Number(count) - reserved)
        delete usedCount[label]
      }
    }
    if (state.action === 'skip' && state.fired && state.window) skippedWindows.add(`${state.date}|${state.window}`)
  }
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 3)
  for (const key of Object.keys(usedCount)) if (key.slice(0, 10) < dayOf(cutoff)) delete usedCount[key]
  return { schema: 2, date: dayOf(now), wakes: state.date === dayOf(now) ? Number(state.wakes ?? 0) : 0,
    wokeAt: state.wokeAt ?? null, usedCount, skippedWindows: [...skippedWindows].filter(key => key.slice(0, 10) >= dayOf(cutoff)) }
}
export function isPending(state, now = Date.now()) {
  return state?.schema === 2 && ['wake', 'skip'].includes(state.action) && !state.fired && !state.woke &&
    Number.isFinite(state.atMs) && Number.isFinite(state.endsAt) && state.endsAt > now
}
export function makePlan(cfg, state = {}, now = Date.now(), random = Math.random) {
  // Persist both the random decision and its time, even after midnight.
  if (isPending(state, now)) return state
  const history = historyOf(state, now)
  const done = reason => ({ ...history, action: 'done', done: true, reason })
  if (history.wakes >= maxWakes(cfg)) return done('今天醒来次数已用完（或所有窗口为零次）')
  // 上游 v0.4.1 同步：不再用 skippedWindows 拉黑整个窗口 —— 只看「这个窗口还剩几次机会」
  const pool = occurrences(cfg, now).filter(w => w.wakes > (history.usedCount[w.key] ?? 0))
    .sort((a, b) => a.endsAt - b.endsAt || a.startsAt - b.startsAt)
  if (!pool.length) return done('今天可用窗口已结束或已经处理')

  // 上游 v0.4.1 同步：同一窗口的多次醒来之间加最小间隔（默认 10 分钟，cfg.minGapMin 可调）
  //   窗口里放不下就换下一个；都不行就今天到此为止（少醒一次，不把间隔硬压短）
  const lastWokeAt = Number.isFinite(Date.parse(state.wokeAt ?? '')) ? Date.parse(state.wokeAt) : 0
  const gapMs = Math.max(60_000, Math.floor((Number.isFinite(Number(cfg.minGapMin)) ? Number(cfg.minGapMin) : 10) * 60_000))
  let picked = null
  for (const cand of pool) {
    const earliest = Math.max(now, cand.startsAt, lastWokeAt + gapMs)
    if (earliest >= cand.endsAt - 30_000) continue
    picked = { cand, earliest }
    break
  }
  if (!picked) return done('今天可用窗口里已经排不下下一次（间隔不够）')
  const w = picked.cand, from = picked.earliest
  const atMs = from + Math.floor(random() * Math.max(1, w.endsAt - from))
  const atDate = new Date(atMs), at = atDate.getHours() * 60 + atDate.getMinutes()
  // 峰谷模式：每个窗口可以有自己的跳过概率（lib/tide.mjs 挂的 skipChanceFor）；
  // 固定窗口模式没有这个函数 → 退回原来的全局 skipChance，行为不变。
  const rawSkip = typeof cfg.skipChanceFor === 'function' ? cfg.skipChanceFor(w) : cfg.skipChance
  const skip = random() < Math.min(1, Math.max(0, Number(rawSkip ?? 0.3)))
  return { ...history, action: skip ? 'skip' : 'wake', fired: false, atMs, at,
    atText: `${dayOf(atMs)} ${String(atDate.getHours()).padStart(2, '0')}:${String(atDate.getMinutes()).padStart(2, '0')}`,
    window: w.label, windowKey: w.key, startsAt: w.startsAt, endsAt: w.endsAt,
    withinWindow: `${w.label} 第 ${(history.usedCount[w.key] ?? 0) + 1}/${w.wakes} 次`,
    maxVideos: cfg.maxVideos ?? 5, createdAt: new Date(now).toISOString(),
    ...(skip ? { reason: '本次计划跳过看视频，仍写日记' } : { roll: 'watch' }) }
}
export function completePlan(state, now = Date.now()) {
  if (state.fired) return state
  const h = historyOf(state, now)
  if (!state.windowKey) throw new Error('计划缺少窗口标识，请重新 plan')
  // 上游 v0.4.1 同步：「不看」只消耗一次机会（和看视频一样占一个 wake 位），不再把整个窗口作废
  if (state.action === 'skip' || state.action === 'wake') {
    h.usedCount[state.windowKey] = (h.usedCount[state.windowKey] ?? 0) + 1
    h.wakes += 1
  }
  return { ...state, ...h, fired: true, woke: state.action === 'wake', wokeAt: new Date(now).toISOString() }
}
