// 开销监控（2026-10-22 主人要求）：看小鲸鱼一天里哪些活最费 token。
//
// 数据来源只读三处，绝不写会话日志：
//   ① ~/.dsh/sessions/<项目>/session-*/session.v4.jsonl.zstd
//      —— 真账本：每个 assistant/message 都带 usage（input/output/cacheRead/cacheWrite），
//         每个 tool/call 都带工具名和参数，所以「哪一步、哪件活、花了多少」是能对上的。
//      注意：文件是**多帧 zstd 拼接**（Node 的 zstdDecompressSync 只吐第一帧），要按魔数拆帧。
//   ② ~/.dsh/storages/cost-meter/ledger.json —— 宿主 cost-meter 的当日 ¥ 合计（用来把 token
//      折算成钱；它只到「会话/天」这一级，所以每轮的钱是按 token 占比摊出来的，标注为估算）。
//   ③ ~/.dsh/dsh-usage/usage-ledger.json —— 宿主自己的按天用量（交叉校验用）。
//
// 分类规则来自我们自己的唤醒提示里的固定标记（见 lib/scheduler.js）：
//   【生物钟】= 醒来一轮、【今晚不看】= 排到但跳过、【主人私信】= 私信回复、
//   【有人找你】= 监听回复、【直播间有人叫你】= 弹幕。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const SESSION_ROOT = path.join(
  process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh'),
  'sessions',
)
const COST_LEDGER = path.join(path.dirname(SESSION_ROOT), 'storages', 'cost-meter', 'ledger.json')
const DSH_USAGE = path.join(path.dirname(SESSION_ROOT), 'dsh-usage', 'usage-ledger.json')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ── 读多帧 zstd 会话日志 ────────────────────────────────────────────────
export function splitFrames(buf) {
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
  }
  return offs.map((o, i) => buf.subarray(o, offs[i + 1] ?? buf.length))
}

export function readSessionFile(file) {
  const st = fs.statSync(file)
  const hit = CACHE.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
  const buf = fs.readFileSync(file)
  const text = splitFrames(buf)
    .map((f) => {
      try { return zlib.zstdDecompressSync(f).toString('utf8') } catch { return '' }
    })
    .join('')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 崩在写盘中间的最后一行，跳过 */ }
  }
  const header = events.find((e) => e.type === 'session') ?? null
  const value = { header, events }
  CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  while (CACHE.size > 8) CACHE.delete(CACHE.keys().next().value)
  return value
}

const CACHE = new Map()

export function listSessionFiles(root = SESSION_ROOT) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name === 'session.v4.jsonl.zstd') out.push(full)
    }
  }
  walk(root, 0)
  return out
}

// ── 事件 → 一轮（turn） ────────────────────────────────────────────────
const KIND_MARKERS = [
  ['【今晚不看】', 'skip'],
  ['【生物钟】', 'wake'],
  ['【主人私信】', 'dm'],
  ['【有人找你】', 'listen'],
  ['【直播间有人叫你】', 'live'],
]
const KIND_LABEL = { wake: '醒来一轮', skip: '到点跳过', dm: '私信回复', listen: '监听回复', live: '弹幕互动', manual: '手动/其他' }

export function kindOf(texts) {
  const joined = (texts ?? []).join('\n')
  for (const [marker, kind] of KIND_MARKERS) if (joined.includes(marker)) return kind
  return 'manual'
}

function textOfUserEvent(ev) {
  const content = ev?.data?.message?.content ?? ev?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
}

function toolCallOf(ev) {
  const d = ev?.data ?? {}
  const name = d.name ?? d.tool ?? '?'
  let raw = d.arguments ?? d.args ?? ''
  if (typeof raw !== 'string') raw = JSON.stringify(raw)
  const cmds = []
  // 我们所有 B 站动作都经 tools/bili.mjs 派发：从命令行里抠出子命令
  for (const m of raw.matchAll(/bili\.mjs["'\\]*\s+([a-z][a-z0-9-]*)/g)) cmds.push(m[1])
  return { name, cmds, raw }
}

export function buildRounds(events) {
  const turns = new Map()
  const stepCalls = new Map()
  const get = (t) => {
    if (!turns.has(t)) {
      turns.set(t, { turn: t, startedAt: null, endedAt: null, texts: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, steps: [], tools: new Map(), cmds: new Map() })
    }
    return turns.get(t)
  }
  for (const ev of events) {
    const t = ev?.data?.turn
    if (typeof t !== 'number') continue
    const r = get(t)
    if (ev.time) {
      if (r.startedAt == null || ev.time < r.startedAt) r.startedAt = ev.time
      if (r.endedAt == null || ev.time > r.endedAt) r.endedAt = ev.time
    }
    if (ev.type === 'user/message') {
      const txt = textOfUserEvent(ev)
      if (txt) r.texts.push(txt)
    } else if (ev.type === 'assistant/message') {
      const u = ev.data.usage
      if (u) {
        r.usage.inputTokens += u.inputTokens ?? 0
        r.usage.outputTokens += u.outputTokens ?? 0
        r.usage.cacheReadTokens += u.cacheReadTokens ?? 0
        r.usage.cacheWriteTokens += u.cacheWriteTokens ?? 0
        r.usage.totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
        r.steps.push({ turn: t, step: ev.data.step, time: ev.time, usage: u })
      }
    } else if (ev.type === 'tool/call') {
      const { name, cmds } = toolCallOf(ev)
      r.tools.set(name, (r.tools.get(name) ?? 0) + 1)
      for (const c of cmds) r.cmds.set(c, (r.cmds.get(c) ?? 0) + 1)
      // 这一步「决定要干什么」花掉的 token，记在它调用的工具上（一步里多次调用 → 平分）
      const key = `${t}:${ev.data.step ?? 0}`
      if (!stepCalls.has(key)) stepCalls.set(key, [])
      stepCalls.get(key).push({ name, cmd: cmds[0] ?? '' })
    }
  }
  // 把工具调用挂到对应步上，并算出「这一步的 token 归谁」（每轮各自一份，别跨轮累加）
  const byToolOf = (r) => {
    const map = new Map()
    for (const st of r.steps) {
      const calls = stepCalls.get(`${st.turn}:${st.step ?? 0}`) ?? []
      const share = calls.length ? 1 / calls.length : 1
      const list = calls.length ? calls : [{ name: '（无工具调用的思考/回答）', cmd: '' }]
      const tok = st.usage?.totalTokens ?? 0
      for (const c of list) {
        const label = c.cmd ? `${c.name} · ${c.cmd}` : c.name
        if (!map.has(label)) map.set(label, { label, tool: c.name, cmd: c.cmd ?? '', tokens: 0, calls: 0 })
        const agg = map.get(label)
        agg.tokens += tok * (calls.length ? share : 1)
        agg.calls += calls.length ? 1 : 0
      }
    }
    return map
  }
  return [...turns.values()]
    .filter((r) => r.usage.totalTokens > 0 || r.tools.size > 0)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((r) => ({
      turn: r.turn,
      kind: kindOf(r.texts),
      kindLabel: KIND_LABEL[kindOf(r.texts)] ?? '其他',
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      usage: r.usage,
      steps: r.steps.length,
      tools: Object.fromEntries(r.tools),
      cmds: Object.fromEntries(r.cmds),
      // 一轮里最贵的工具归属：按「该步用到的工具」没有精确拆分，这里取本轮出现的 bili 子命令集合
      biliCmds: [...r.cmds.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      _byTool: byToolOf(r),
    }))
}

const dayKey = (ms) => new Date(ms).toLocaleDateString('sv-SE')

export function roundsOf(file, { date } = {}) {
  const { header, events } = readSessionFile(file)
  const cwd = header?.cwd ?? ''
  const all = buildRounds(events)
  const rounds = date ? all.filter((r) => r.startedAt && dayKey(r.startedAt) === date) : all
  return { file, cwd, sessionId: header?.id ?? path.basename(path.dirname(file)), rounds }
}

export function podSessions({ workDir } = {}) {
  const want = String(workDir ?? '').toLowerCase()
  const out = []
  for (const file of listSessionFiles()) {
    try {
      const { header } = readSessionFile(file)
      const cwd = String(header?.cwd ?? '').toLowerCase()
      if (want ? cwd === want : /pod-work/.test(cwd)) out.push(file)
    } catch { /* 坏文件跳过 */ }
  }
  return out
}

export function summarize(rounds) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
  const byKind = new Map()
  const byCmd = new Map()
  for (const r of rounds) {
    for (const k of Object.keys(total)) total[k] += r.usage[k] ?? 0
    const k = r.kind
    if (!byKind.has(k)) byKind.set(k, { kind: k, kindLabel: r.kindLabel, rounds: 0, tokens: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
    const bk = byKind.get(k)
    bk.rounds += 1
    bk.tokens += r.usage.totalTokens
    for (const [kk, vv] of Object.entries(r.usage)) if (kk in bk.usage) bk.usage[kk] += vv
    if (!r.biliCmds.length) {
      const nullKey = '（没有调 B 站命令）'
      byCmd.set(nullKey, byCmd.get(nullKey) ?? { cmd: nullKey, rounds: 0 })
      byCmd.get(nullKey).rounds += 1
    }
    for (const c of r.biliCmds) {
      if (!byCmd.has(c)) byCmd.set(c, { cmd: c, rounds: 0 })
      byCmd.get(c).rounds += 1
    }
  }
  const toolMap = new Map()
  for (const r of rounds) {
    for (const t of r._byTool?.values() ?? []) {
      const cur = toolMap.get(t.label) ?? { label: t.label, tool: t.tool, cmd: t.cmd, tokens: 0, calls: 0 }
      cur.tokens += t.tokens
      cur.calls += t.calls
      toolMap.set(t.label, cur)
    }
  }
  return {
    rounds: rounds.length,
    usage: total,
    byTool: [...toolMap.values()].sort((a, b) => b.tokens - a.tokens),
    byKind: [...byKind.values()].sort((a, b) => b.tokens - a.tokens),
    byCmd: [...byCmd.values()].sort((a, b) => b.rounds - a.rounds),
    topRounds: [...rounds].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens).slice(0, 5),
  }
}

// ── ¥ 折算：用宿主 cost-meter 的当日合计按 token 占比摊（估） ───────────
export function dayCost(date) {
  try {
    const j = JSON.parse(fs.readFileSync(COST_LEDGER, 'utf8'))
    const d = j?.days?.[date]
    if (!d) return null
    return { cny: d.costCny ?? 0, usd: d.cost ?? 0, tokens: (d.input ?? 0) + (d.output ?? 0) + (d.cacheRead ?? 0) + (d.cacheWrite ?? 0), calls: d.calls ?? 0 }
  } catch { return null }
}

export function dshUsage(date) {
  try {
    const j = JSON.parse(fs.readFileSync(DSH_USAGE, 'utf8'))
    const d = j?.days?.[date]
    if (!d) return null
    const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0, cost: 0 }
    for (const provider of Object.values(d)) {
      for (const m of Object.values(provider ?? {})) {
        acc.inputTokens += m.inputTokens ?? 0
        acc.outputTokens += m.outputTokens ?? 0
        acc.cacheReadTokens += m.cacheReadTokens ?? 0
        acc.calls += m.calls ?? 0
        acc.cost += m.cost ?? 0
      }
    }
    return acc
  } catch { return null }
}

// 按 token 占比把当日 ¥ 摊到每一轮（估）
export function apportionYuan(sum, cost) {
  if (!cost || !cost.tokens || !cost.cny) return null
  return (sum.usage.totalTokens / cost.tokens) * cost.cny
}

export function report({ date = new Date().toLocaleDateString('sv-SE'), workDir, scope = 'pod', price = true } = {}) {
  const files = scope === 'all' ? listSessionFiles() : podSessions({ workDir })
  const sessions = []
  for (const file of files) {
    let r
    try { r = roundsOf(file, { date }) } catch { continue }
    if (!r.rounds.length) continue
    sessions.push(r)
  }
  const rounds = sessions.flatMap((s) => s.rounds)
  const sum = summarize(rounds)
  const cost = price ? dayCost(date) : null
  const yuan = apportionYuan(sum, cost)
  return { date, scope, workDir: workDir ?? null, sessions: sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, rounds: s.rounds.length })), ...sum, cost, yuan }
}

// ── 给人看的格式化 ────────────────────────────────────────────────────
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '-'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

export function fmtTime(ms) {
  if (!ms) return '--:--'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

export function reportLines(rep) {
  const out = []
  const r = rep
  out.push(`📒 ${r.date} 开销（${r.scope === 'all' ? '全部会话' : '小鲸鱼自己的会话'}）`)
  out.push(`   醒来/回复轮次 ${r.rounds} 轮 · 合计 ${fmtTokens(r.usage.totalTokens)} tokens（输入 ${fmtTokens(r.usage.inputTokens)} / 缓存读 ${fmtTokens(r.usage.cacheReadTokens)} / 输出 ${fmtTokens(r.usage.outputTokens)}）` +
    (r.yuan != null ? ` · 约 ¥${r.yuan.toFixed(3)}（按当日单价摊）` : ''))
  if (!r.rounds) {
    out.push('   （今天还没有醒来过：没有可统计的轮次）')
    return out
  }
  out.push('')
  out.push('   按在干什么分组：')
  for (const k of r.byKind) {
    out.push(`     ${k.kindLabel.padEnd(6, ' ')} ${String(k.rounds).padStart(2)} 轮  ${fmtTokens(k.tokens).padStart(8)}  ${r.yuan != null ? '¥' + ((k.tokens / (r.usage.totalTokens || 1)) * r.yuan).toFixed(3) : ''}`)
  }
  out.push('')
  out.push('   最贵的几轮：')
  for (const t of r.topRounds) {
    out.push(`     ${fmtTime(t.startedAt)}  ${t.kindLabel}  ${fmtTokens(t.usage.totalTokens).padStart(8)}  ${t.steps} 步  ${t.biliCmds.slice(0, 3).join(', ') || '（无 B 站命令）'}`)
  }
  if (r.byTool?.length) {
    const costs = r.byTool.slice(0, 8)
    const sumT = r.byTool.reduce((a, b) => a + b.tokens, 0) || 1
    out.push('')
    out.push('   哪件事最费 token（按「为决定这件事付出的 token」估）：')
    for (const t of costs) {
      const yuanPart = r.yuan != null ? `  ≈¥${((t.tokens / sumT) * r.yuan).toFixed(3)}` : ''
      out.push(`     ${t.label.slice(0, 34).padEnd(34, ' ')} ${fmtTokens(t.tokens).padStart(8)}  ${t.calls} 次${yuanPart}`)
    }
  }
  const cmds = r.byCmd.slice(0, 8)
  if (cmds.length) {
    out.push('')
    out.push('   调得最多的 B 站命令：')
    for (const c of cmds) out.push(`     ${c.cmd.padEnd(16, ' ')} ${c.rounds} 轮用到`)
  }
  if (r.cost) out.push('', `   （宿主当日合计 ¥${r.cost.cny.toFixed(3)} / ${r.cost.calls} 次请求；轮次拆分是估算）`)
  return out
}
