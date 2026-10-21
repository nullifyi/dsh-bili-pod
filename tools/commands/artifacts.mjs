#!/usr/bin/env node
// 产出物（默认关）—— 想让一轮的深读报告 / 抽帧图留下来时用。
//
//   node tools/bili.mjs artifacts status
//   node tools/bili.mjs artifacts save --name 2501号深读 --text "…"      # 或 --file report.md / --file -
//   node tools/bili.mjs artifacts list [--n 20]
//   node tools/bili.mjs artifacts show <文件> 
//
// 为什么默认关：每轮都存一份，一个月后就是几百个文件，没人看。
// 打开方式：设置 → 鲸群 → 产出物 → 启用（目录可留空 = <work>/artifacts）。
import fs from 'node:fs'
import path from 'node:path'
import { workDir } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status'
const rest = sub === argv[0] ? argv.slice(1) : argv
const get = (k, d = null) => {
  const i = rest.indexOf('--' + k)
  if (i < 0) return d
  const v = rest[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const cfg = config()
const enabled = cfg.artifacts?.enabled === true
const dir = String(cfg.artifacts?.dir || path.join(workDir, 'artifacts'))
const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact'

const listFiles = () => {
  try {
    return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort().reverse()
  } catch { return [] }
}

if (sub === 'status') {
  const files = listFiles()
  console.log(`产出物：${enabled ? '已启用' : '已关闭（默认）'}`)
  console.log(`目录：${dir}`)
  console.log(`文件：${files.length} 个${files.length ? '（最近 ' + files.slice(0, 3).join(' / ') + '）' : ''}`)
  if (!enabled) console.log('→ 要留东西：设置 → 鲸群 → 产出物 → 启用；或 `artifacts save --force …`')
  process.exit(0)
}

if (sub === 'save') {
  if (!enabled && rest.includes('--force') !== true) {
    console.error('产出物默认关着（artifacts.enabled=false）。要存就加 --force，或先去设置里启用。')
    process.exit(3)
  }
  const name = String(get('name', `round-${Date.now()}`))
  let body = ''
  const fileArg = get('file')
  if (fileArg === '-') {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    body = Buffer.concat(chunks).toString('utf8')
  } else if (typeof fileArg === 'string') body = fs.readFileSync(fileArg, 'utf8')
  else if (typeof get('text') === 'string') body = String(get('text'))
  if (!body.trim()) { console.error('内容是空的：用 --text "…" 或 --file <路径|->'); process.exit(2) }
  fs.mkdirSync(dir, { recursive: true })
  const day = new Date().toLocaleDateString('sv-SE')
  const final = path.join(dir, `${day}-${safe(name)}.md`)
  const head = `# ${name}\n\n- 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n- 来源：鲸群一轮产出\n\n`
  fs.writeFileSync(final, head + body.trim() + '\n', 'utf8')
  console.log(`✅ 已存：${final}`)
  process.exit(0)
}

if (sub === 'list') {
  const files = listFiles()
  const n = Number(get('n', 20)) || 20
  if (!files.length) { console.log('还没有产出物。'); process.exit(0) }
  for (const f of files.slice(0, n)) {
    const st = fs.statSync(path.join(dir, f))
    console.log(`  ${f}  ${String(Math.ceil(st.size / 1024)).padStart(5)} KB  ${st.mtime.toLocaleString('zh-CN', { hour12: false })}`)
  }
  process.exit(0)
}

if (sub === 'show') {
  const name = rest.find((a) => !String(a).startsWith('--'))
  if (!name) { console.error('用法：artifacts show <文件名>'); process.exit(2) }
  const file = path.join(dir, path.basename(String(name)))
  if (!fs.existsSync(file)) { console.error(`没有这个文件：${file}`); process.exit(2) }
  console.log(fs.readFileSync(file, 'utf8'))
  process.exit(0)
}

console.error('用法：artifacts status|save|list|show [参数]')
process.exit(2)
