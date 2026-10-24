/**
 * lib/bundler.mjs —— 「存档包」：把一只鲸鱼连同她的日记、账本、状态、人设一起打包
 * ============================================================================
 * 代码在 GitHub 上，不用打包；要搬的是「运行态」：
 *
 *   config/    pod.config.json          她的作息、口味、审核档、私信设置
 *   data/pod-diary/  daily/ owner/ records/ archive/   日记与分类记录库
 *   data/pod-work/   state/ rounds/ artifacts/ ext/    运行状态、账本、产出物、mod
 *   home/            persona.md（人设）  credentials.json（凭据，默认不打包）
 *   plugin/          插件源码（可选；一般直接 git clone 更新）
 *
 * 设计原则：
 *   - 默认**不**打包凭据（credentials.json 属于账号，不该跟着压缩包到处飞）
 *   - 包内不带任何绝对路径 / 用户名，换机器不会泄露也不冲突
 *   - 导入前逐条校验 sha256；目标已存在默认拒绝覆盖（--force 才先备份再写）
 *   - 只搬运行态，不搬会话日志（sessions 很大，且属于 DSH 而不是插件）
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeZipFile, readZipFile } from './zip.mjs'
import { CFG_FILE, CRED_FILE, PERSONA_FILE, LEGACY_PERSONA_FILE, WORK_DIR, DIARY_ROOT } from './store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')

export const BUNDLE_VERSION = 1
export const BUNDLE_KIND = 'dsh-bili-pod-bundle'

/** 这些是「可重新生成 / 噪音」的文件，不值得进存档 */
const SKIP_NAMES = new Set([
  'api-cache.json',
  'api-requests.log',
  'dm-tick-err.log',
  '.DS_Store',
  'Thumbs.db',
])
const SKIP_DIRS = new Set(['node_modules', '.git', 'sessions'])
const MAX_FILE_BYTES = 48 * 1024 * 1024

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const readDirSafe = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 递归列文件；跳过符号链接、噪音文件、超大文件；返回 [{rel, abs, size, mtime}]（rel 用 / 分隔） */
export function collectFiles(root, { base = '', warnings = [] } = {}) {
  const out = []
  for (const d of readDirSafe(root)) {
    const abs = path.join(root, d.name)
    const rel = base ? `${base}/${d.name}` : d.name
    if (d.isSymbolicLink()) {
      warnings.push(`跳过符号链接：${rel}`)
      continue
    }
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue
      out.push(...collectFiles(abs, { base: rel, warnings }))
      continue
    }
    if (!d.isFile()) continue
    if (SKIP_NAMES.has(d.name)) continue
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      warnings.push(`读不到：${rel}`)
      continue
    }
    if (st.size > MAX_FILE_BYTES) {
      warnings.push(`跳过超大文件（>48MB）：${rel}`)
      continue
    }
    out.push({ rel, abs, size: st.size, mtime: st.mtime })
  }
  return out
}

/** 目标机器的默认位置（允许用 env / 显式参数覆盖） */
export function defaultTargets() {
  return { cfgFile: CFG_FILE, workDir: WORK_DIR, diaryDir: DIARY_ROOT, personaFile: PERSONA_FILE, credFile: CRED_FILE }
}

function envInfo() {
  return { platform: process.platform, arch: process.arch, node: process.version }
}

/**
 * 导出存档包。
 * @param {object} o
 * @param {string} o.out 输出 zip 路径
 * @param {boolean} [o.withPlugin] 是否把插件源码一起打包
 * @param {boolean} [o.withCredentials] 是否打包凭据（默认 false，会在 warnings 里说明）
 */
export function exportBundle(o = {}) {
  const targets = { ...defaultTargets(), ...(o.targets ?? {}) }
  const now = o.now ?? new Date()
  const warnings = []
  const entries = []
  const files = []
  const counts = { config: 0, diary: 0, work: 0, home: 0, plugin: 0 }

  const add = (name, data, mtime) => {
    entries.push({ name, data, mtime })
    files.push({ path: name, size: data.length, sha256: sha256(data) })
  }

  const addTree = (name, root, counter) => {
    for (const f of collectFiles(root, { warnings })) {
      add(`${name}/${f.rel}`, fs.readFileSync(f.abs), f.mtime)
      counts[counter] += 1
    }
  }

  // 1) 配置
  if (fs.existsSync(targets.cfgFile)) {
    add('config/pod.config.json', fs.readFileSync(targets.cfgFile), fs.statSync(targets.cfgFile).mtime)
    counts.config = 1
  } else {
    warnings.push(`没有配置文件（${targets.cfgFile}）：导入后按设置页重新填一遍`)
  }

  // 2) 日记 / 账本 / 状态 / 产出物 / 扩展
  addTree('data/pod-diary', targets.diaryDir, 'diary')
  addTree('data/pod-work', targets.workDir, 'work')

  // 3) 人设（不打包凭据）
  const personaSource = fs.existsSync(targets.personaFile) || o.targets?.personaFile ? targets.personaFile : LEGACY_PERSONA_FILE
  if (fs.existsSync(personaSource)) {
    add('home/persona.md', fs.readFileSync(personaSource), fs.statSync(personaSource).mtime)
    counts.home += 1
  }
  if (o.withCredentials) {
    if (fs.existsSync(targets.credFile)) {
      add('home/credentials.json', fs.readFileSync(targets.credFile), fs.statSync(targets.credFile).mtime)
      counts.home += 1
      warnings.push('凭据已打进包里：这个 zip 等同于账号密码，别放公共网盘、别发群')
    } else {
      warnings.push('要求打包凭据，但本机还没有凭据文件（先登录）')
    }
  } else if (fs.existsSync(targets.credFile)) {
    warnings.push('凭据没打包（默认）：到新机器上扫码登录一次即可')
  }

  // 4) 插件源码（可选）
  if (o.withPlugin) {
    addTree('plugin', o.pluginRoot ?? PLUGIN_ROOT, 'plugin')
  }

  const manifest = {
    kind: BUNDLE_KIND,
    bundleVersion: BUNDLE_VERSION,
    createdAt: now.toISOString(),
    plugin: { name: 'dsh-bili-pod', version: o.pluginVersion ?? 'unknown', withSource: !!o.withPlugin },
    env: envInfo(),
    contains: {
      config: counts.config,
      diary: counts.diary,
      work: counts.work,
      home: counts.home,
      plugin: counts.plugin,
      credentials: !!o.withCredentials,
    },
    warnings,
    files,
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), mtime: now })

  const out = path.resolve(o.out ?? `dsh-bili-pod-bundle-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`)
  const { size } = writeZipFile(out, entries)
  return { file: out, size, manifest, counts, warnings, targets }
}

/**
 * 只读检查：逐条验 CRC + sha256，不落盘。
 */
export function inspectBundle(file) {
  const entries = readZipFile(file)
  const bad = []
  const byName = new Map()
  for (const e of entries) {
    if (!e.ok) bad.push(`${e.name}：CRC 不对（文件坏了或被改过）`)
    byName.set(e.name, e)
  }
  const manEntry = byName.get('manifest.json')
  if (!manEntry) throw new Error('不是鲸群存档包：缺 manifest.json')
  let manifest
  try {
    manifest = JSON.parse(manEntry.data.toString('utf8'))
  } catch {
    throw new Error('manifest.json 解析失败')
  }
  if (manifest.kind !== BUNDLE_KIND) throw new Error(`不是鲸群存档包：kind=${manifest.kind}`)
  if (manifest.bundleVersion > BUNDLE_VERSION) {
    throw new Error(`这个包由更新的版本导出（bundleVersion=${manifest.bundleVersion}），先升级插件`)
  }
  const files = []
  for (const f of manifest.files ?? []) {
    const e = byName.get(f.path)
    if (!e) { bad.push(`${f.path}：清单里有、包里没有`); continue }
    const got = sha256(e.data)
    const ok = got === f.sha256
    if (!ok) bad.push(`${f.path}：sha256 不一致（文件被改过）`)
    files.push({ path: f.path, size: e.data.length, sha256: got, ok })
  }
  for (const e of entries) {
    if (e.name === 'manifest.json') continue
    if (!(manifest.files ?? []).some((f) => f.path === e.name)) bad.push(`${e.name}：包里有、清单里没有（多出来的文件）`)
  }
  return { ok: bad.length === 0, manifest, files, bad, totalBytes: entries.reduce((n, e) => n + e.data.length, 0) }
}

const dirHasContent = (dir) => {
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * 导入存档包。
 * @param {object} o
 * @param {string} o.file zip
 * @param {boolean} [o.force] 目标已存在时先备份（<dir>.bak-<时间戳>）再覆盖
 * @param {boolean} [o.withCredentials] 是否把凭据写回去（包里有才有效）
 * @param {object} [o.targets]
 */
export function importBundle(o = {}) {
  const info = inspectBundle(o.file)
  if (!info.ok) throw new Error(`包校验失败，一条都不写：\n- ${info.bad.join('\n- ')}`)
  const targets = { ...defaultTargets(), ...(o.targets ?? {}) }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  const plan = []
  const entries = readZipFile(o.file)
  for (const e of entries) {
    let dest = null
    if (e.name === 'manifest.json') continue
    if (e.name === 'config/pod.config.json') dest = targets.cfgFile
    else if (e.name.startsWith('data/pod-diary/')) dest = path.join(targets.diaryDir, e.name.slice('data/pod-diary/'.length))
    else if (e.name.startsWith('data/pod-work/')) dest = path.join(targets.workDir, e.name.slice('data/pod-work/'.length))
    else if (e.name === 'home/persona.md') dest = targets.personaFile
    else if (e.name === 'home/credentials.json') dest = o.withCredentials === false ? null : targets.credFile
    else if (e.name.startsWith('plugin/')) continue // 源码不往工作目录写
    else continue
    if (!dest) continue
    if (dest.split(/[\\/]/).includes('..')) throw new Error(`可疑路径：${e.name}`)
    plan.push({ src: e.name, dest, data: e.data })
  }

  // 冲突只在「目录/文件已经有东西」时出现；一条都不写，除非 --force
  const conflicts = []
  for (const [label, dir] of [['工作目录', targets.workDir], ['日记目录', targets.diaryDir]]) {
    if (fs.existsSync(dir) && dirHasContent(dir)) conflicts.push(`${label}：${dir}`)
  }
  if (fs.existsSync(targets.cfgFile)) conflicts.push(`配置：${targets.cfgFile}`)
  if (fs.existsSync(targets.personaFile)) conflicts.push(`人设：${targets.personaFile}`)
  if (plan.some((p) => p.dest === targets.credFile) && fs.existsSync(targets.credFile)) conflicts.push(`凭据：${targets.credFile}`)

  if (conflicts.length && !o.force) {
    throw new Error(
      `目标位置已经有东西，为避免覆盖，一条都没写：\n- ${conflicts.join('\n- ')}\n确认要覆盖就加 --force（会先备份成 .bak-<时间>）`
    )
  }

  const backups = []
  if (o.force) {
    for (const dir of [targets.workDir, targets.diaryDir]) {
      if (fs.existsSync(dir) && dirHasContent(dir)) {
        const bak = `${dir}.bak-${stamp}`
        fs.renameSync(dir, bak)
        backups.push(bak)
      }
    }
    for (const f of [targets.cfgFile, targets.personaFile]) {
      if (fs.existsSync(f)) {
        const bak = `${f}.bak-${stamp}`
        fs.renameSync(f, bak)
        backups.push(bak)
      }
    }
  }

  let written = 0
  for (const p of plan) {
    fs.mkdirSync(path.dirname(p.dest), { recursive: true })
    fs.writeFileSync(p.dest, p.data)
    if (p.dest === targets.credFile) fs.chmodSync(p.dest, 0o600)
    written += 1
  }

  const skippedCreds = entries.some((e) => e.name === 'home/credentials.json') && o.withCredentials === false
  return { written, backups, createdAt: info.manifest.createdAt, pluginVersion: info.manifest.plugin?.version, targets, skippedCreds }
}

/** 给 CLI / 设置页用的一段人话摘要 */
export function summaryLines(result) {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
  return [
    `包：${result.file}`,
    `大小：${mb(result.size)}`,
    `内含：配置 ${result.counts.config} · 日记 ${result.counts.diary} · 运行态 ${result.counts.work} · 人设 ${result.counts.home}${result.counts.plugin ? ` · 源码 ${result.counts.plugin}` : ''}`,
    ...(result.warnings ?? []).map((w) => `注意：${w}`),
  ]
}
