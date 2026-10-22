#!/usr/bin/env node
/**
 * install.mjs —— 把鲸群挂进某个 DSH 配置档（等价于 `dsh plugin --profile desktop add "link:…"`）
 *
 *   node scripts/install.mjs                 # 默认装进 desktop 配置档
 *   node scripts/install.mjs --profile web
 *   node scripts/install.mjs --dsh-home D:\dsh-home --plugin F:\path\to\dsh-bili-pod
 *   node scripts/install.mjs --dry-run        # 只打印要改什么
 *   node scripts/uninstall.mjs                # 反向卸载（不动她的数据）
 *
 * 做的事只有三件：
 *   1) 配置档 package.json 的 dependencies 里加 "dsh-bili-pod": "file:<绝对路径>"
 *   2) package.json 的 dsh.profile.bundles 里追加 dsh-bili-pod
 *   3) 在 <配置档>/node_modules 下建一个指向插件目录的链接
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const NAME = 'dsh-bili-pod'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const value = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY = flag('dry-run')
const JSON_OUT = flag('json')
const log = (s) => {
  if (!JSON_OUT) console.log(s)
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir()
}

function fail(msg) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
  else console.error(`✗ ${msg}`)
  process.exit(1)
}

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (dflt !== undefined) return dflt
    throw e
  }
}

function main() {
  const dshHome = path.resolve(value('dsh-home') || process.env.DSH_HOME || path.join(homeDir(), '.dsh'))
  const profileName = value('profile') || 'desktop'
  const pluginRoot = path.resolve(value('plugin') || PLUGIN_ROOT)
  const profilesDir = path.join(dshHome, 'profiles')

  // 0) 插件本身
  const pkgFile = path.join(pluginRoot, 'package.json')
  if (!fs.existsSync(pkgFile)) fail(`这里不是插件目录（没有 package.json）：${pluginRoot}`)
  const pkg = readJson(pkgFile)
  if (pkg.name !== NAME) fail(`package.json 里的名字是 ${pkg.name}，不是 ${NAME}`)
  if (!fs.existsSync(path.join(pluginRoot, 'cordis.patch.yml'))) fail('缺 cordis.patch.yml（bundle 清单），这个目录不完整')

  // 1) 配置档
  const profileDir = path.join(profilesDir, profileName)
  const profileFile = path.join(profileDir, 'package.json')
  if (!fs.existsSync(profileFile)) {
    const have = fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir).filter((d) => fs.existsSync(path.join(profilesDir, d, 'package.json'))) : []
    fail(`没有配置档 ${profileName}（${profileFile}）；现有：${have.join(', ') || '（无）'}`)
  }
  const profile = readJson(profileFile)
  const before = JSON.stringify(profile)

  // 2) 依赖（npm 的 file: 规格，Windows 路径用正斜杠）
  const remote = `file:${pluginRoot.replace(/\\/g, '/')}`
  profile.dependencies ??= {}
  const prevDep = profile.dependencies[NAME]
  profile.dependencies[NAME] = remote

  // 3) bundle 列表
  profile.dsh ??= {}
  profile.dsh.profile ??= {}
  profile.dsh.profile.bundles ??= []
  const hadBundle = profile.dsh.profile.bundles.includes(NAME)
  if (!hadBundle) profile.dsh.profile.bundles.push(NAME)

  const changed = JSON.stringify(profile) !== before
  log(`插件：${pluginRoot}`)
  log(`  版本 ${pkg.version}`)
  log(`配置档：${profileDir}`)
  log(`  依赖 ${NAME}: ${prevDep ? `${prevDep} → ` : ''}${remote}`)
  log(`  bundles：${hadBundle ? '已有（不动）' : '追加 ' + NAME}`)

  // 4) node_modules 链接
  const nm = path.join(profileDir, 'node_modules')
  const linkPath = path.join(nm, NAME)
  let linkState = 'none'
  if (fs.existsSync(linkPath) || isSymlink(linkPath)) {
    const real = fs.realpathSync(linkPath)
    linkState = path.resolve(real).toLowerCase() === path.resolve(pluginRoot).toLowerCase() ? 'same' : `other:${real}`
  }
  log(`  node_modules 链接：${linkState === 'none' ? '新建' : linkState === 'same' ? '已有且指向这里' : linkState}`)

  if (DRY) {
    log('')
    log(changed ? '（dry-run）会改 package.json' : '（dry-run）package.json 不用改')
    log(linkState === 'none' ? '（dry-run）会建 node_modules/dsh-bili-pod 链接' : '（dry-run）链接不动')
    return
  }

  const backups = []
  if (changed) {
    const bak = `${profileFile}.bak-${stamp()}`
    fs.copyFileSync(profileFile, bak)
    backups.push(bak)
    fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8')
    log('')
    log(`✓ 已更新 ${profileFile}（备份 ${path.basename(bak)}）`)
  } else {
    log('')
    log('· package.json 已经是目标状态，没有改动')
  }

  if (linkState === 'none') {
    fs.mkdirSync(nm, { recursive: true })
    fs.symlinkSync(pluginRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    log(`✓ 已创建链接 node_modules/${NAME}`)
  } else if (linkState.startsWith('other:')) {
    fail(`node_modules/${NAME} 已存在且指向 ${linkState.slice(6)}；先把这个旧链接/目录删掉再跑（数据目录不受影响）`)
  }

  log('')
  log('下一步：')
  log('  1) 重启 DSH（bundle 要重启才组装）')
  log('  2) 打开「设置 → 鲸群」：扫码登录 → 填主人 mid → 保存 → 依赖体检')
  log(`  3) node "${path.join(pluginRoot, 'tools', 'bili.mjs')}" selftest`)

  if (JSON_OUT) console.log(JSON.stringify({ ok: true, plugin: pluginRoot, version: pkg.version, profile: profileDir, changed, link: linkState, backups }, null, 2))
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

main()
