#!/usr/bin/env node
/**
 * uninstall.mjs —— 从 DSH 配置档里摘掉鲸群（**不动**她的数据）
 *
 *   node scripts/uninstall.mjs [--profile desktop] [--dsh-home <dir>] [--dry-run]
 *
 * 只做三件反向操作：
 *   1) package.json 的 dependencies 里删掉 dsh-bili-pod
 *   2) dsh.profile.bundles 里删掉 dsh-bili-pod
 *   3) 删掉 node_modules/dsh-bili-pod 这个链接（只删链接，绝不删插件源码）
 *
 * 配置 / 日记 / 账本 / 状态都在 ~/.dsh 与 ~/.bili-ai 里，卸载不会碰。
 * 想彻底清干净：手动删 ~/.dsh/pod-work、~/.dsh/pod-diary、~/.dsh/pod.config.json、~/.bili-ai。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const value = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const NAME = 'dsh-bili-pod'
const DRY = flag('dry-run')
const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
const dshHome = path.resolve(value('dsh-home') || process.env.DSH_HOME || path.join(home, '.dsh'))
const profileName = value('profile') || 'desktop'
const profileDir = path.join(dshHome, 'profiles', profileName)
const profileFile = path.join(profileDir, 'package.json')

if (!fs.existsSync(profileFile)) {
  console.error(`✗ 没有配置档：${profileFile}`)
  process.exit(1)
}

const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
const before = JSON.stringify(profile)
delete profile.dependencies?.[NAME]
if (Array.isArray(profile.dsh?.profile?.bundles)) {
  profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((b) => b !== NAME)
}
const changed = JSON.stringify(profile) !== before

console.log(`配置档：${profileDir}`)
console.log(`  dependencies.${NAME}：${changed ? '删除' : '本来就没有'}`)
console.log(`  bundles：${changed ? '删除 ' + NAME : '本来就没有'}`)

const linkPath = path.join(profileDir, 'node_modules', NAME)
let hasLink = false
try {
  hasLink = fs.lstatSync(linkPath).isSymbolicLink()
} catch {
  hasLink = false
}
console.log(`  node_modules/${NAME}：${hasLink ? '删除链接' : '没有链接（不动）'}`)

if (DRY) {
  console.log('（dry-run）没写任何东西')
  process.exit(0)
}

if (changed) {
  const bak = `${profileFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  fs.copyFileSync(profileFile, bak)
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  console.log(`✓ 已更新 package.json（备份 ${path.basename(bak)}）`)
}
if (hasLink) {
  fs.unlinkSync(linkPath)
  console.log('✓ 已删掉 node_modules 链接')
}
console.log('')
console.log('已卸载。她的数据还在：')
console.log(`  ${path.join(dshHome, 'pod.config.json')}`)
console.log(`  ${path.join(dshHome, 'pod-work')}`)
console.log(`  ${path.join(dshHome, 'pod-diary')}`)
console.log(`  ${path.join(home, '.bili-ai')}`)
