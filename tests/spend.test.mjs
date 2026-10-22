// 开销监控（lib/spend.mjs）的离线测试：用合成会话日志验证「按轮/按工具归因 token」。
// 会话文件是**多帧 zstd 拼接**（Node 默认只解第一帧），所以这里故意按帧写，专门守这个坑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pod-spend-'))
const DSH = path.join(HOME, '.dsh')
const WORK = path.join(DSH, 'pod-work')
const SESS = path.join(DSH, 'sessions', '--F-dsh-project-robo-pod-work--', 'session-bili-pod')
fs.mkdirSync(SESS, { recursive: true })
fs.mkdirSync(WORK, { recursive: true })
process.env.DSH_HOME = DSH
process.env.USERPROFILE = HOME
process.env.HOME = HOME

const spend = await import('../lib/spend.mjs')

// 固定一个「正午」的时间点：如果跟着 Date.now() 跑，跨零点的几分钟里
// 第 1 轮会落到「昨天」，按今天过滤就只剩 2 轮 —— 测试会在半夜随机变红。
const now = new Date('2026-10-22T12:00:00+08:00').getTime()
const day = new Date(now).toLocaleDateString('sv-SE')
const ev = (type, data, seq, time) => ({ type, seq, time, data })

const events = [
  { type: 'session', version: 4, id: 'session-bili-pod', createdAt: now - 3600e3, cwd: WORK, agentPreset: 'standard' },
  // 第 1 轮：醒来
  ev('turn/start', { turn: 1 }, 1, now - 3000e3),
  ev('user/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '【生物钟】你醒了 —— 20:30 左右' }] } }, 2, now - 2999e3),
  ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50000, cacheWriteTokens: 0, totalTokens: 51100 } }, 3, now - 2990e3),
  ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: JSON.stringify({ command: 'node F:/p/tools/bili.mjs feed --n 5' }) }, 4, now - 2989e3),
  ev('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 40000, cacheWriteTokens: 0, totalTokens: 42300 } }, 5, now - 2900e3),
  ev('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'ops_bash', arguments: JSON.stringify({ command: 'node F:/p/tools/bili.mjs debrief --bvid BV1x' }) }, 6, now - 2899e3),
  ev('assistant/message', { turn: 1, step: 3, message: { role: 'assistant', content: [] }, usage: { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 60000, cacheWriteTokens: 0, totalTokens: 65800 } }, 7, now - 2800e3),
  ev('turn/end', { turn: 1 }, 8, now - 2700e3),
  // 第 2 轮：私信
  ev('turn/start', { turn: 2 }, 9, now - 2000e3),
  ev('user/message', { turn: 2, message: { role: 'user', content: [{ type: 'text', text: '【主人私信】主人刚给你发私信：' }] } }, 10, now - 1999e3),
  ev('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 10000, cacheWriteTokens: 0, totalTokens: 10550 } }, 11, now - 1990e3),
  ev('tool/call', { turn: 2, step: 1, callId: 'c3', name: 'ops_bash', arguments: JSON.stringify({ command: 'node F:/p/tools/bili.mjs dm --msg hi --go' }) }, 12, now - 1989e3),
  // 第 3 轮：手动（没有标记）
  ev('turn/start', { turn: 3 }, 13, now - 1000e3),
  ev('user/message', { turn: 3, message: { role: 'user', content: [{ type: 'text', text: '手动跑一轮吧' }] } }, 14, now - 999e3),
  ev('assistant/message', { turn: 3, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0, totalTokens: 1110 } }, 15, now - 990e3),
]

const FILE = path.join(SESS, 'session.v4.jsonl.zstd')
// 每行压成独立 zstd 帧再拼起来 —— 和 DSH 真实的写法一致
fs.writeFileSync(FILE, Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))))

test('多帧 zstd：能把每一帧都读出来（只解第一帧的写法会漏数据）', () => {
  const frames = spend.splitFrames(fs.readFileSync(FILE))
  assert.equal(frames.length, events.length)
  const { header, events: parsed } = spend.readSessionFile(FILE)
  assert.equal(header.id, 'session-bili-pod')
  assert.equal(header.cwd, WORK)
  assert.equal(parsed.length, events.length)
})

test('按轮聚合：usage 求和、类别来自提示词里的固定标记', () => {
  const { rounds } = spend.roundsOf(FILE, { date: day })
  assert.equal(rounds.length, 3)
  const [wake, dm, manual] = rounds
  assert.equal(wake.kind, 'wake')
  assert.equal(dm.kind, 'dm')
  assert.equal(manual.kind, 'manual')
  assert.equal(wake.usage.totalTokens, 51100 + 42300 + 65800)
  assert.equal(wake.steps, 3)
  assert.deepEqual(wake.biliCmds.sort(), ['debrief', 'feed'])
  assert.equal(dm.biliCmds[0], 'dm')
})

test('按工具归因：bili 子命令挂在 ops_bash 后面', () => {
  const rep = spend.report({ date: day, workDir: WORK, price: false })
  assert.equal(rep.rounds, 3)
  assert.equal(rep.usage.totalTokens, 159200 + 10550 + 1110)
  const labels = rep.byTool.map((t) => t.label)
  assert.ok(labels.some((l) => l.includes('feed')), 'feed 应该被单独认出来：' + labels.join(' / '))
  assert.ok(labels.some((l) => l.includes('debrief')))
  // 归因总量不应超过实际总量（每步按平均数分摊）
  const attributed = rep.byTool.reduce((a, b) => a + b.tokens, 0)
  assert.ok(attributed <= rep.usage.totalTokens + 1, `归因 ${attributed} 应 ≤ 总量 ${rep.usage.totalTokens}`)
  assert.ok(attributed > rep.usage.totalTokens * 0.99)
})

test('类别汇总 & 函数格式化', () => {
  const rep = spend.report({ date: day, workDir: WORK, price: false })
  const kinds = Object.fromEntries(rep.byKind.map((k) => [k.kind, k.rounds]))
  assert.deepEqual(kinds, { wake: 1, dm: 1, manual: 1 })
  assert.equal(spend.fmtTokens(1530000), '1.53M')
  assert.equal(spend.fmtTokens(1200), '1.2k')
  assert.equal(spend.fmtTokens(42), '42')
  const text = spend.reportLines(rep).join('\n')
  assert.match(text, /醒来一轮/)
  assert.match(text, /哪件事最费 token/)
})

test('只挑小鲸鱼自己的会话（cwd = pod-work），别的项目不算进来', () => {
  const other = path.join(DSH, 'sessions', '--F-other--', 'session-x')
  fs.mkdirSync(other, { recursive: true })
  const otherEvents = events.map((e) => (e.type === 'session' ? { ...e, cwd: 'F:\\other', id: 'session-other' } : e))
  fs.writeFileSync(path.join(other, 'session.v4.jsonl.zstd'), Buffer.concat(otherEvents.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))))
  const pod = spend.report({ date: day, workDir: WORK, price: false })
  const all = spend.report({ date: day, scope: 'all', price: false })
  assert.equal(pod.sessions.length, 1)
  assert.equal(all.sessions.length, 2)
  assert.equal(pod.rounds, 3)
  assert.equal(all.rounds, 6)
})
