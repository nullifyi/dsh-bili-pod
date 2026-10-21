#!/usr/bin/env node
// mod 扩展清单（只读，不出网）—— 看清「谁加进来的、加了什么」。
//
//   node tools/bili.mjs extlist            # 已装的扩展 + 它们注册的命令/字段/提示段
//   node tools/bili.mjs extlist --json
//
// 宿主每次启动 / 热重载都会写 <work>/ext/registry.json；这里读它。
// 目录约定：设置 → 鲸群 → 扩展 里的 dirs（逗号分隔），加上 ~/.dsh/pod-ext。
import fs from 'node:fs'
import path from 'node:path'
import { workDir, dshPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const REG = path.join(workDir, 'extensions.json')
const read = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')) } catch { return null } }
const reg = read()
const cfg = config()
const dirs = [...new Set([
  ...(Array.isArray(cfg.extensions?.dirs) ? cfg.extensions.dirs : []),
  String(process.env.BILI_POD_EXT || dshPath('pod-ext')),
].flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean))]

if (JSON_OUT) {
  console.log(JSON.stringify({ registry: REG, dirs, registry_data: reg }, null, 2))
  process.exit(0)
}

console.log('## 扩展目录')
for (const d of dirs) {
  let files = []
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')) } catch { files = [] }
  console.log(`  ${d}  ${files.length ? '（' + files.join(', ') + '）' : '（没有 .mjs）'}`)
}
if (!reg) {
  console.log('\n还没有 registry.json —— 说明宿主没加载过扩展（先在设置里点「重载扩展」，或重启 DSH）。')
  process.exit(0)
}
console.log(`\n## 已加载的扩展（${reg.generatedAt}）`)
const list = reg.extensions ?? []
if (!list.length) console.log('  （一个都没有）')
for (const e of list) {
  const flag = e.enabled === false ? '（已停用）' : e.ok ? '✓' : '✗'
  console.log(`\n  ${flag} ${e.id}  v${e.version}  ${e.name}${e.description ? ' — ' + e.description : ''}`)
  console.log(`     来源：${e.source}`)
  console.log(`     提示段 ${e.promptSections} · 设置字段 ${e.fields} · 命令 ${(e.commands ?? []).join(', ') || '无'}`)
  if (e.lastError) console.log(`     ⚠️ 最近一次错误（${e.lastErrorAt}）：${e.lastError}`)
}
const cmds = reg.commands ?? []
if (cmds.length) {
  console.log('\n## 扩展带来的命令（在 bili.mjs 里按名字调用）')
  for (const c of cmds) console.log(`  ${c.name.padEnd(18)} ${c.desc ?? ''}  [${c.ext}]`)
}
process.exit(0)
