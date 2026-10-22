/**
 * lib/pricing.mjs —— DeepSeek API 的「便宜时段」（2026-10-22 主人要求）
 * ============================================================================
 * 峰谷模式的真实含义：DeepSeek 在 UTC 16:30–00:30 有折扣（北京时间 00:30–08:30）。
 * 所以「峰谷」不是随便编的作息，而是**她挑 API 便宜的时候干活**：
 *   · mode = 'cheap'：只在北京时间 00:30–08:30 醒来（折扣窗口）
 *   · mode = 'tide' ：用户自己划峰/谷（旧行为，保留）
 *   · mode = 'fixed'：用户自己给窗口（基座行为，保留）
 * 折扣细节以官网为准，这里只存「窗口」这一件事；窗口本身也会随官方调整变，
 * 所以做成常量 + 设置里可改的覆盖值，而不是写死在调度里。
 * ============================================================================
 */

/** 北京时间（东八区）的便宜窗口，按「跨零点」写法：00:30 → 08:30 是同一段 */
export const DEEPSEEK_CHEAP_WINDOWS = [
  { start: '00:30', end: '08:30', wakes: 2 },
]

export const CHEAP_TZ_OFFSET_MIN = 480 // Asia/Shanghai

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

/** 本地时间（不分夏令时——国内没有）的当天分钟数 */
export function localMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}

/** 某个窗口是否包含当前时刻（支持跨零点） */
export function inWindowAt(win, date = new Date()) {
  const s = toMin(win.start)
  let e = toMin(win.end)
  if (e <= s) e += 1440
  const now = localMinutes(date)
  return (now >= s && now < e) || (now + 1440 >= s && now + 1440 < e)
}

/** 现在是不是 DeepSeek 便宜时段（窗口可被设置覆盖） */
export function isCheapNow(cfg = {}, date = new Date()) {
  const wins = Array.isArray(cfg.night?.cheap?.windows) && cfg.night.cheap.windows.length
    ? cfg.night.cheap.windows
    : DEEPSEEK_CHEAP_WINDOWS
  return wins.some((w) => inWindowAt(w, date))
}

/** 下一个便宜窗口的开始时间（用于「现在不便宜，几点再醒」的提示） */
export function nextCheapAt(cfg = {}, date = new Date()) {
  const wins = Array.isArray(cfg.night?.cheap?.windows) && cfg.night.cheap.windows.length
    ? cfg.night.cheap.windows
    : DEEPSEEK_CHEAP_WINDOWS
  const now = localMinutes(date)
  let best = null
  for (const w of wins) {
    const s = toMin(w.start)
    for (const day of [0, 1]) {
      let at = s + day * 1440
      if (at <= now) at += 1440
      if (best === null || at < best) best = at
    }
  }
  if (best === null) return null
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setMinutes(best)
  return d
}

/** 人话描述：给设置页 / 提示用 */
export function describeCheap(cfg = {}) {
  const wins = Array.isArray(cfg.night?.cheap?.windows) && cfg.night.cheap.windows.length
    ? cfg.night.cheap.windows
    : DEEPSEEK_CHEAP_WINDOWS
  const label = wins.map((w) => `${String(w.start).padStart(5, '0')}–${String(w.end).padStart(5, '0')}`).join('、')
  const now = isCheapNow(cfg) ? '现在就在便宜时段' : '现在不是便宜时段'
  return `DeepSeek 折扣窗口 ${label}（${now}）`
}

/** 把便宜窗口翻成调度用的 windows（带 wakes / skip） */
export function cheapWindows(cfg = {}) {
  const raw = Array.isArray(cfg.night?.cheap?.windows) && cfg.night.cheap.windows.length
    ? cfg.night.cheap.windows
    : DEEPSEEK_CHEAP_WINDOWS
  const wakes = Math.max(1, Math.min(6, Number(cfg.night?.cheap?.wakes) || 2))
  const skip = Math.max(0, Math.min(0.95, Number(cfg.night?.cheap?.skipChance ?? 0.15)))
  return raw.map((w) => ({ start: String(w.start), end: String(w.end), wakes, label: `低价 ${String(w.start).padStart(5, '0')}–${String(w.end).padStart(5, '0')}` }))
}
