#!/usr/bin/env node
// 她的日记（文件夹版）—— 主人 2026-10-22 定的样子：
//
//   ~/.dsh/pod-diary/
//     daily/YYYY-MM-DD.md     今天还没归档的日记（每条一句 + 分类标记）
//     owner/YYYY-MM-DD.md     给主人的那篇（保持"一篇"的写法）
//     archive/YYYY-MM/*.md    归档后的原文（只有 recall 时才翻）
//     records/<分类>.md       归档时摘出来的「长期记忆」
//     records/INDEX.md        总索引（分类 / 条目数 / 最近日期）
//
// 用法：
//   node tools/bili.mjs diary                      # 摘要：今天 + 分类统计 + 最近归档
//   node tools/bili.mjs diary today | owner        # 原文
//   node tools/bili.mjs diary add --kind 吐槽 --text "…"     # 追加一条（或 diary add 吐槽 "…"）
//   node tools/bili.mjs diary archive [--keep 1]   # 归档到 cutoff 的日记并摘记录
//   node tools/bili.mjs diary recall [--q 显卡] [--day 2026-10-01] [--limit 5]
//   node tools/bili.mjs diary index                # 重建 records/INDEX.md
//   node tools/bili.mjs diary log --kind wake --note "…"      # 结构化事件（pod-log.jsonl）
//   node tools/bili.mjs diary tail [--n 20]        # 最近事件
import fs from 'node:fs'
import path from 'node:path'
import { diaryDir, dshPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import {
  layout, ensureLayout, summary, appendDaily, archiveDue, recall, rebuildIndex, normalizeKind, validateKind, DEFAULT_KINDS, dayKey,
} from '../../lib/diarystore.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show'
const rest = sub === argv[0] ? argv.slice(1) : argv
const get = (k, d = null) => {
  const i = rest.indexOf('--' + k)
  if (i < 0) return d
  const v = rest[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const JSON_OUT = rest.includes('--json')
const LOG = dshPath('pod-log.jsonl')
const kinds = (() => {
  const c = config().diary?.records
  return Array.isArray(c) && c.length ? c : DEFAULT_KINDS
})()

const readLog = () => {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
const appendLog = (obj) => {
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, JSON.stringify(obj) + '\n', 'utf8')
}

ensureLayout(diaryDir)
const L = layout(diaryDir)

if (sub === 'show') {
  if (config().diary?.enabled === false) { console.log('日记已在设置里关闭（diary.enabled=false）'); process.exit(0) }
  const s = summary(diaryDir, { kinds })
  if (JSON_OUT) { console.log(JSON.stringify({ ...s, logPath: LOG }, null, 2)); process.exit(0) }
  console.log(`# 她的一天 · ${s.today}`)
  console.log(`\n（日记根：${s.root}）`)
  const total = s.kinds.reduce((n, r) => n + r.count, 0)
  console.log(`\n## 记录库 · ${s.kinds.length} 个分类 / ${total} 条`)
  for (const r of s.kinds) console.log(`  ${r.kind.padEnd(8)} ${String(r.count).padStart(4)} 条   最近 ${r.last || '—'}`)
  console.log(`\n## 今天的日记${s.todayDiary ? '' : '（还空着）'}`)
  console.log(s.todayDiary.trim() || '  （还没写）')
  if (s.ownerDiary) {
    console.log('\n## 给主人的日记')
    console.log(s.ownerDiary.trim())
  }
  if (s.lastArchive) console.log(`\n最近归档：${s.lastArchive}`)
  for (const a of s.archived) console.log(`  ${a.day} → ${a.file}（摘出 ${a.entries} 条：${(a.kinds ?? []).join('/') || '无'}）`)
  const ev = readLog().slice(-8).reverse()
  if (ev.length) {
    console.log('\n## 最近事件')
    for (const e of ev) console.log(`  ${String(e.at).replace('T', ' ').slice(0, 19)}  ${e.kind}  ${e.target || ''}  ${e.note || ''}`)
  }
  process.exit(0)
}

if (sub === 'today' || sub === 'owner') {
  const day = String(get('day', dayKey()))
  const file = sub === 'today' ? L.daily(day) : L.owner(day)
  if (!fs.existsSync(file)) { console.log(`（${day} 的${sub === 'today' ? '' : '主人版'}日记还没写）`); process.exit(0) }
  console.log(fs.readFileSync(file, 'utf8'))
  process.exit(0)
}

if (sub === 'add') {
  if (config().diary?.enabled === false) { console.log('日记已关闭'); process.exit(0) }
  const positional = rest.filter((a) => !String(a).startsWith('--'))
  const kindRaw = String(get('kind', positional[0] ?? ''))
  const text = String(get('text', positional[1] ?? ''))
  if (!text) { console.error('用法：diary add --kind 吐槽 --text "…"（或 diary add 吐槽 "…"）'); process.exit(2) }
  const which = get('owner') === true ? 'owner' : 'self'
  const day = String(get('day', dayKey()))
  let line = text.trim()
  if (which === 'self') {
    const k = validateKind(normalizeKind(kindRaw, kinds) || '想说的')
    line = `- [${k}] ${line}`
  }
  const file = appendDaily(diaryDir, { day, kind: which, text: line })
  console.log(`✅ 已写入 ${path.relative(diaryDir, file)}`)
  process.exit(0)
}

if (sub === 'archive') {
  const keep = Number(get('keep', 1))
  const keepDays = Number.isFinite(keep) ? Math.max(1, Math.min(7, keep)) : 1
  const res = archiveDue(diaryDir, { keepDays, kinds })
  const done = res.filter((r) => r.archived)
  if (JSON_OUT) { console.log(JSON.stringify({ keepDays, results: res }, null, 2)); process.exit(0) }
  if (!done.length) { console.log(`没有需要归档的（保留最近 ${keepDays} 天）`); process.exit(0) }
  for (const r of done) console.log(`✅ ${r.day} 已归档 → ${r.file}（摘出 ${r.entries} 条：${r.kinds.join('/') || '无'}）`)
  console.log(`\n索引：${L.indexPath}`)
  process.exit(0)
}

if (sub === 'recall') {
  const q = get('q', get('query', ''))
  const day = get('day', '')
  const limit = Number(get('limit', 5)) || 5
  const hits = recall(diaryDir, { query: typeof q === 'string' && q ? q : '', day: typeof day === 'string' && day ? day : undefined, limit })
  if (JSON_OUT) { console.log(JSON.stringify(hits, null, 2)); process.exit(0) }
  if (!hits.length) { console.log('没有翻到（归档后的原文里也没有）。'); process.exit(0) }
  for (const h of hits) {
    console.log(`\n=== ${h.day}  ${path.relative(diaryDir, h.file)}`)
    console.log('  ' + h.snippet.slice(0, 800))
  }
  process.exit(0)
}

if (sub === 'index') {
  const r = rebuildIndex(diaryDir, { kinds })
  console.log(`✅ 已重建 ${r.indexPath}（${r.rows.length} 个分类 / ${r.total} 条）`)
  process.exit(0)
}

if (sub === 'log') {
  const positional = rest.filter((a) => !String(a).startsWith('--'))
  const kind = String(get('kind', positional[0] ?? 'note'))
  const target = String(get('target', ''))
  const note = String(get('note', positional[1] ?? ''))
  appendLog({ at: new Date().toISOString(), kind, target, note })
  console.log('✅ 已记一笔事件')
  process.exit(0)
}

if (sub === 'tail') {
  const n = Number(get('n', 20)) || 20
  const rows = readLog().slice(-n)
  if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }
  if (!rows.length) { console.log('还没有事件。'); process.exit(0) }
  for (const e of rows) console.log(`${String(e.at).replace('T', ' ').slice(0, 19)}  ${String(e.kind).padEnd(10)} ${e.target || ''}  ${e.note || ''}`)
  process.exit(0)
}

console.error('用法：diary show|today|owner|add|archive|recall|index|log|tail [参数]')
process.exit(2)
