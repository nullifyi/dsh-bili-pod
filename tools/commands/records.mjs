#!/usr/bin/env node
// 分类记录库 —— 她的「长期记忆」。日记归档时，带标记的句子会被摘进这里。
//
//   node tools/bili.mjs records                       # 看各分类有多少条、最近一条是什么时候
//   node tools/bili.mjs records add 吐槽 "这个算法又给我推…"     # 手记一条（不加 --day 就是今天）
//   node tools/bili.mjs records show 思考 [--limit 10] [--full]
//   node tools/bili.mjs records recall --q 显卡 [--limit 5]
//   node tools/bili.mjs records index                 # 重建 records/INDEX.md
//
// 为什么要它：每日日记越写越厚，而「长期用得上的东西」其实就那么几类。
// 归档时把关键句摘出来分门别类放好，第二天醒来只读索引 + 少量分类，
// 不翻旧日记原文（主人要看再 recall）。
import fs from 'node:fs'
import path from 'node:path'
import { diaryDir } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import {
  layout, ensureLayout, stats, appendRecord, rebuildIndex, recall, normalizeKind, DEFAULT_KINDS, dayKey,
} from '../../lib/diarystore.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list'
const rest = sub === argv[0] ? argv.slice(1) : argv
const get = (k, d = null) => {
  const i = rest.indexOf('--' + k)
  if (i < 0) return d
  const v = rest[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const JSON_OUT = rest.includes('--json')
const kinds = (() => {
  const c = config().diary?.records
  return Array.isArray(c) && c.length ? c : DEFAULT_KINDS
})()

ensureLayout(diaryDir)
const L = layout(diaryDir)

if (sub === 'list') {
  const rows = stats(diaryDir, kinds)
  if (JSON_OUT) { console.log(JSON.stringify({ root: diaryDir, kinds: rows }, null, 2)); process.exit(0) }
  const total = rows.reduce((n, r) => n + r.count, 0)
  console.log(`分类记录 · ${path.join(L.recordsDir)}`)
  console.log(`共 ${rows.length} 个分类 / ${total} 条\n`)
  for (const r of rows) console.log(`  ${r.kind.padEnd(8)} ${String(r.count).padStart(4)} 条   最近 ${r.last || '—'}`)
  console.log(`\n总索引：${L.indexPath}`)
  process.exit(0)
}

if (sub === 'add') {
  const positional = rest.filter((a) => !String(a).startsWith('--'))
  const kind = String(get('kind', positional[0] ?? ''))
  const text = String(get('text', positional[1] ?? ''))
  if (!kind || !text) {
    console.error('用法：records add <分类> "<内容>"  （或 --kind 吐槽 --text "…"）')
    process.exit(2)
  }
  const day = String(get('day', dayKey()))
  const r = appendRecord(diaryDir, { kind: normalizeKind(kind, kinds) || kind, text, day, source: '手记' })
  rebuildIndex(diaryDir, { kinds })
  console.log(r.added ? `✅ 已记入 ${path.relative(diaryDir, r.file)}` : '（这条已经记过了，跳过）')
  process.exit(0)
}

if (sub === 'show') {
  const positional = rest.filter((a) => !String(a).startsWith('--'))
  const kind = normalizeKind(String(get('kind', positional[0] ?? '')), kinds)
  if (!kind) { console.error('用法：records show <分类>'); process.exit(2) }
  const file = L.record(kind)
  if (!fs.existsSync(file)) {
    console.error(`还没有「${kind}」这个分类的记录文件（归档时会自动建）。`)
    console.error(`可用分类：${kinds.join(' / ')}`)
    process.exit(2)
  }
  const text = fs.readFileSync(file, 'utf8')
  const limit = Number(get('limit', 0))
  if (rest.includes('--full') || !limit) { console.log(text.trim()); process.exit(0) }
  // 只取最近 N 条（条目形如 `- **2026-10-21** …`）
  const blocks = text.split(/\n(?=- \*\*\d{4}-\d{2}-\d{2}\*\*)/)
  const head = blocks.shift() ?? ''
  console.log(head.trim())
  console.log(blocks.slice(-limit).join('\n').trim())
  process.exit(0)
}

if (sub === 'recall') {
  const q = get('q', get('query', ''))
  const limit = Number(get('limit', 5)) || 5
  const hits = recall(diaryDir, { query: typeof q === 'string' && q ? q : '', limit })
  if (JSON_OUT) { console.log(JSON.stringify(hits, null, 2)); process.exit(0) }
  if (!hits.length) { console.log('没有翻到相关的旧记录。'); process.exit(0) }
  for (const h of hits) {
    console.log(`\n=== ${h.day}  ${path.relative(diaryDir, h.file)}`)
    console.log('  ' + h.snippet.slice(0, 600))
  }
  process.exit(0)
}

if (sub === 'index') {
  const r = rebuildIndex(diaryDir, { kinds })
  console.log(`✅ 已重建 ${r.indexPath}（${r.rows.length} 个分类 / ${r.total} 条）`)
  process.exit(0)
}

if (sub === 'kinds') {
  console.log(kinds.join('\n'))
  process.exit(0)
}

console.error('用法：records list|add|show|recall|index|kinds [参数]')
process.exit(2)
