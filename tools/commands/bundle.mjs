#!/usr/bin/env node
/**
 * bundle —— 存档 / 搬家：把一只鲸鱼连日记、账本、状态、人设打包成一个 zip
 *
 *   node tools/bili.mjs bundle export [--out 文件.zip] [--with-credentials] [--with-plugin] [--json]
 *   node tools/bili.mjs bundle inspect <文件.zip> [--json]
 *   node tools/bili.mjs bundle import <文件.zip> [--force] [--no-credentials] [--config f] [--work d] [--diary d] [--json]
 *
 * 默认不打包凭据；--with-credentials 打出来的 zip 等同于账号密码，别放公共网盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportBundle, inspectBundle, importBundle, summaryLines } from '../../lib/bundler.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..', '..', 'package.json')

const argv = process.argv.slice(2)
const sub = argv.find((a) => !a.startsWith('--')) ?? 'export'
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const JSON_OUT = flag('json')

const pluginVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(PKG, 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

function targetsFromArgs() {
  const cfg = value('config')
  const work = value('work')
  const diary = value('diary')
  const persona = value('persona')
  const cred = value('credentials')
  return {
    ...(cfg ? { cfgFile: path.resolve(cfg) } : {}),
    ...(work ? { workDir: path.resolve(work) } : {}),
    ...(diary ? { diaryDir: path.resolve(diary) } : {}),
    ...(persona ? { personaFile: path.resolve(persona) } : {}),
    ...(cred ? { credFile: path.resolve(cred) } : {}),
  }
}

function fail(msg, code = 1) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: String(msg) }, null, 2))
  else console.error(`✗ ${msg}`)
  process.exit(code)
}

if (sub === 'export') {
  const out = value('out')
  const r = exportBundle({
    out,
    withCredentials: flag('with-credentials'),
    withPlugin: flag('with-plugin'),
    pluginVersion,
    targets: targetsFromArgs(),
  })
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: true, file: r.file, size: r.size, counts: r.counts, warnings: r.warnings, manifest: r.manifest }, null, 2))
  } else {
    for (const line of summaryLines(r)) console.log(line)
    console.log('')
    console.log(`导出完成 → ${r.file}`)
    console.log('搬到新电脑：')
    console.log('  1) git clone https://github.com/nullifyi/dsh-bili-pod  （或直接把这个 zip 拷过去）')
    console.log(`  2) node <插件目录>/tools/bili.mjs bundle import "${path.basename(r.file)}"`)
    console.log('  3) node <插件目录>/scripts/install.mjs   （把插件挂进 DSH 配置档）')
    console.log('  4) 重启 DSH → 设置 → 鲸群 → 扫码登录（凭据没打包）→ 依赖体检')
  }
  process.exit(0)
}

if (sub === 'inspect') {
  const file = argv.find((a) => a !== 'inspect' && !a.startsWith('--'))
  if (!file) fail('用法：bundle inspect <文件.zip>')
  const info = inspectBundle(path.resolve(file))
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: info.ok, manifest: info.manifest, files: info.files, bad: info.bad, totalBytes: info.totalBytes }, null, 2))
  } else {
    const m = info.manifest
    console.log(`包：${path.resolve(file)}`)
    console.log(`导出时间：${new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}`)
    console.log(`插件版本：${m.plugin?.version ?? '?'}   来源：${m.env?.platform}/${m.env?.arch} node ${m.env?.node}`)
    console.log(`内含：配置 ${m.contains?.config ? '✓' : '—'} · 日记 ${m.contains?.diary ?? 0} 个文件 · 运行态 ${m.contains?.work ?? 0} · 人设 ${m.contains?.home ? '✓' : '—'} · 凭据 ${m.contains?.credentials ? '⚠ 有' : '无'}`)
    console.log(`文件数：${info.files.length}   解压后约 ${(info.totalBytes / 1024 / 1024).toFixed(2)} MB`)
    if ((m.warnings ?? []).length) console.log(`导出时的提醒：\n- ${m.warnings.join('\n- ')}`)
    if (!info.ok) {
      console.log('')
      console.log(`✗ 校验没过（${info.bad.length} 处）：`)
      for (const b of info.bad) console.log(`  - ${b}`)
    } else {
      console.log('')
      console.log('✓ 校验通过（每一条 sha256 都对得上）')
    }
  }
  process.exit(info.ok ? 0 : 5)
}

if (sub === 'import') {
  const file = argv.find((a) => a !== 'import' && !a.startsWith('--'))
  if (!file) fail('用法：bundle import <文件.zip> [--force]')
  try {
    const r = importBundle({
      file: path.resolve(file),
      force: flag('force'),
      withCredentials: flag('no-credentials') ? false : undefined,
      targets: targetsFromArgs(),
    })
    if (JSON_OUT) {
      console.log(JSON.stringify({ ok: true, ...r, targets: r.targets }, null, 2))
    } else {
      console.log(`✓ 已导入 ${r.written} 个文件（包导出于 ${new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}，插件 ${r.pluginVersion ?? '?'}）`)
      if (r.backups.length) {
        console.log('')
        console.log('旧数据已备份（要回滚就把这些名字改回去）：')
        for (const b of r.backups) console.log(`  - ${b}`)
      }
      if (r.skippedCreds) console.log('凭据按参数跳过了：去设置页扫码登录，或重新用 --with-credentials 导出的包')
      console.log('')
      console.log('下一步：')
      console.log('  1) node tools/bili.mjs deps        # 体检（登录态 / ffmpeg / node / 目录）')
      console.log('  2) 重启 DSH，打开「设置 → 鲸群」，确认主人 mid、作息、审核档')
      console.log('  3) node tools/bili.mjs diary show  # 看她最近的日记')
    }
    process.exit(0)
  } catch (e) {
    fail(e.message)
  }
}

fail(`不认识的子命令：${sub}（只有 export / inspect / import）`)
