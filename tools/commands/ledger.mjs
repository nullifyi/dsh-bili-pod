#!/usr/bin/env node
// 账本 —— 每一轮醒来 / 每次监听，都落一份人可读的账，并且带哈希链。
//
//   node tools/bili.mjs ledger write --mode valley --title "谷里翻到一条" --body-file -   # 正文从 stdin
//   node tools/bili.mjs ledger write --mode manual --title "手动记一笔" --body "……" --extra score=15
//   node tools/bili.mjs ledger list [--n 10] [--json]
//   node tools/bili.mjs ledger show [<day>/<name>]      # 不给就是最近一份
//   node tools/bili.mjs ledger verify [--json]          # 查哈希链（改过就会断）
//   node tools/bili.mjs ledger index                    # 重建 rounds/INDEX.md
//
// 为什么值得留：账本不是「必须可信」，而是「被动过就会留痕」。
// 每份账头部有 prev = 上一份的 sha256；任何旧账被改，verify 立刻指出是哪一份。
import fs from 'node:fs'
import path from 'node:path'
import { workDir } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { appendRound, listRounds, parseRound, rebuildLedgerIndex, tail, verifyChain, roundModes } from '../../lib/ledger.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list'
const rest = sub === argv[0] ? argv.slice(1) : argv
const get = (k, d = null) => {
  const i = rest.indexOf('--' + k)
  if (i < 0) return d
  const v = rest[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const getAll = (k) => {
  const out = []
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--' + k && rest[i + 1] && !rest[i + 1].startsWith('--')) out.push(rest[i + 1])
  }
  return out
}
const JSON_OUT = rest.includes('--json')
const readStdin = async () => {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

if (sub === 'write') {
  if (config().ledger?.enabled === false) {
    console.log('账本已在设置里关闭（ledger.enabled=false）→ 这一轮不落账')
    process.exit(0)
  }
  const mode = String(get('mode', 'manual'))
  if (!roundModes.includes(mode)) {
    console.error(`mode 必须是：${roundModes.join(' / ')}`)
    process.exit(2)
  }
  const title = String(get('title', ''))
  let body = ''
  const bodyFile = get('body-file')
  if (bodyFile === '-') body = await readStdin()
  else if (typeof bodyFile === 'string') body = fs.readFileSync(bodyFile, 'utf8')
  else if (typeof get('body') === 'string') body = String(get('body'))
  if (!body.trim()) {
    console.error('正文是空的 —— 用 --body "…" 或 --body-file -（stdin）给一段')
    process.exit(2)
  }
  const extra = {}
  for (const kv of getAll('extra')) {
    const i = kv.indexOf('=')
    if (i > 0) extra[kv.slice(0, i)] = kv.slice(i + 1)
  }
  const operationId = String(get('operation-id', process.env.BILI_POD_ROUND_ID || ''))
  const r = appendRound({ root: workDir, mode, title, body, extra, operationId })
  console.log(`✅ 账已落：${r.file}`)
  console.log(`   mode=${mode} prev=${String(r.meta.prev).slice(0, 12)} hash=${r.hash.slice(0, 12)}`)
  if (r.indexError) console.log(`   账已提交；索引待重建：${r.indexError}`)
  process.exit(0)
}

if (sub === 'list') {
  const n = Number(get('n', 20)) || 20
  const all = listRounds(workDir)
  const rows = all.slice(-n).reverse().map((x) => {
    const p = parseRound(fs.readFileSync(x.file, 'utf8'))
    return { day: x.day, name: x.name, at: p.meta.at ?? '', mode: p.meta.mode ?? '', title: p.meta.title ?? '', file: x.file }
  })
  if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }
  if (!rows.length) { console.log('还没有账 —— 第一轮醒来之后会有了。'); process.exit(0) }
  console.log(`账本：${all.length} 份（最近 ${rows.length} 份）\n`)
  for (const r of rows) console.log(`  ${r.day}/${r.name}  [${r.mode}]  ${r.title}`)
  console.log(`\n目录：${path.join(workDir, 'rounds')}`)
  process.exit(0)
}

if (sub === 'show') {
  const want = rest.find((a) => !String(a).startsWith('--')) ?? ''
  const all = listRounds(workDir)
  if (!all.length) { console.error('还没有账'); process.exit(2) }
  let hit = want ? all.find((x) => `${x.day}/${x.name}` === want || x.name === want || x.day === want) : all[all.length - 1]
  if (!hit && want) hit = all.filter((x) => x.file.includes(want)).pop()
  if (!hit) { console.error(`找不到：${want}`); process.exit(2) }
  console.log(fs.readFileSync(hit.file, 'utf8'))
  process.exit(0)
}

if (sub === 'verify') {
  const r = verifyChain(workDir)
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 5) }
  if (r.ok) {
    console.log(`✅ 哈希链完整：${r.count} 份账，从 GENESIS 一路对得上。`)
    process.exit(0)
  }
  console.log(`❌ 有 ${r.broken.length} 处断裂（中间某份被改过 / 被删过）：`)
  for (const b of r.broken) console.log(`  ${b.day}/${b.name}\n    期望 prev=${String(b.expectedPrev).slice(0, 16)}  实际 prev=${String(b.actualPrev).slice(0, 16) || '(空)'}`)
  process.exit(5)
}

if (sub === 'index') {
  const p = rebuildLedgerIndex(workDir)
  console.log(`✅ 已重建：${p}`)
  process.exit(0)
}

if (sub === 'tail') {
  const n = Number(rest[0]) || 3
  for (const r of tail(workDir, n)) {
    console.log(`\n=== ${r.day}/${r.name} [${r.meta.mode}] ${r.meta.title}`)
    console.log(r.body.trim().slice(0, 1200))
  }
  process.exit(0)
}

console.error('用法：ledger write|list|show|verify|index|tail [参数]（--help 见 bili.mjs help）')
process.exit(2)
