/**
 * lib/extensions.mjs —— mod 扩展宿主（「像游戏 mod 一样」加功能）
 * ============================================================================
 * 主人要的（2026-10-22 第 6 条）：
 *   · 代码要像基座那样**能额外拓展**；
 *   · 预留接口 —— 以后可能像 mod 一样继续加很多功能。
 *
 * 所以鲸群把自己做成了「内核 + 扩展」：
 *
 *   一个扩展 = 一个 .mjs 文件（`export default { id, name, setup(pod) }`），放在
 *     <插件>/extensions/*.mjs          随插件发布的内置 mod
 *     ~/.dsh/pod-ext/*.mjs             用户自己的 mod（不用改插件本体）
 *
 *   它能拿到的接口（pod.*）：
 *     pod.on(event, fn)                订阅生命周期（见 EXT_EVENTS）
 *     pod.addPromptSection({...})      往唤醒提示里加一段（相当于 mod 改人设/加流程）
 *     pod.command({name, desc, script}) 给 `bili.mjs` 加一个子命令（agent 可以调）
 *     pod.route(expr, handler)         加 HTTP 路由（挂到 /dsh-bili/api/ext/<id>/…）
 *     pod.field({path, label, …})      往设置页加一个字段（通用渲染）
 *     pod.dataDir()                    扩展自己的持久目录（自动创建）
 *     pod.readConfig() / pod.patchConfig(patch) / pod.log(msg)
 *
 *   隔离：每个扩展 setup / 事件回调都包在 try/catch + 超时里 ——
 *   一个 mod 写崩了，只会让「它自己」变红，不影响她醒来看视频。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import crypto from 'node:crypto'

export const POD_API_VERSION = 1
export const EXT_EVENTS = [
  'tick',
  'wake:before',
  'wake:after',
  'round:start',
  'round:end',
  'ledger:write',
  'diary:archived',
  'verify:done',
  'comment:sent',
  'login:ok',
  'extensions:loaded',
]

const DEFAULT_TIMEOUT = 8000
const nowMs = () => Date.now()

const withTimeout = (p, ms, label) => {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时（>${ms}ms）`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

const safeId = (s) => String(s ?? '').trim().replace(/[^\w.-]+/g, '-').slice(0, 60)

export class PodHost {
  /**
   * @param {object} o
   * @param {string} o.podId
   * @param {string} o.workDir           扩展数据根目录（<workDir>/ext/<id>）
   * @param {(msg:string)=>void} [o.log]
   * @param {()=>object} [o.readConfig]
   * @param {(patch:object)=>object} [o.patchConfig]
   * @param {string[]} [o.dirs]          默认扫描目录
   */
  constructor({ podId = 'bili-pod', workDir, log = () => {}, readConfig = () => ({}), patchConfig = () => ({}), dirs = [] }) {
    this.podId = podId
    this.workDir = workDir
    this.log = log
    this._readConfig = readConfig
    this._patchConfig = patchConfig
    this.dirs = [...dirs]
    /** @type {Map<string, any>} */
    this.ext = new Map()
    /** @type {Map<string, {id:string, fn:Function}[]>} */
    this.handlers = new Map()
    this.promptSections = []
    this.fields = []
    this.routes = []
    this.commands = new Map()
    this.registryFile = path.join(workDir, 'extensions.json')
  }

  addDir(dir) {
    if (dir && !this.dirs.includes(dir)) this.dirs.push(dir)
    return this.dirs
  }

  dataDirOf(id) {
    const d = path.join(this.workDir, 'ext', safeId(id))
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  /** 为某个扩展构造 pod 接口对象 */
  apiFor(entry) {
    const id = entry.id
    const host = this
    const guard = (fn, label) => async (...args) => {
      try { return await withTimeout(Promise.resolve().then(() => fn(...args)), DEFAULT_TIMEOUT, label) }
      catch (e) { host.recordError(id, `${label}: ${e.message}`); return undefined }
    }
    return {
      apiVersion: POD_API_VERSION,
      id,
      podId: host.podId,
      dir: id,
      dataDir: () => host.dataDirOf(id),
      log: (msg) => host.log(`[ext:${id}] ${msg}`),
      readConfig: () => host._readConfig(),
      patchConfig: (patch) => host._patchConfig(patch),
      on: (event, fn) => host.on(id, event, fn),
      addPromptSection: (spec) => host.addPromptSection(id, spec),
      command: (spec) => host.command(id, spec),
      route: (expr, handler) => host.route(id, expr, handler),
      field: (spec) => host.field(id, spec),
      hostInfo: () => host.status(),
    }
  }

  on(extId, event, fn) {
    if (!EXT_EVENTS.includes(event)) throw new Error(`未知事件：${event}（可用：${EXT_EVENTS.join(', ')}）`)
    if (typeof fn !== 'function') throw new Error('pod.on(event, fn) 的 fn 必须是函数')
    const list = this.handlers.get(event) ?? []
    list.push({ id: extId, fn })
    this.handlers.set(event, list)
    return () => {
      const cur = this.handlers.get(event) ?? []
      this.handlers.set(event, cur.filter((x) => !(x.id === extId && x.fn === fn)))
    }
  }

  addPromptSection(extId, spec = {}) {
    const id = safeId(spec.id ?? extId)
    const existing = this.promptSections.findIndex((s) => s.id === id)
    const item = {
      id,
      ext: extId,
      title: String(spec.title ?? id).slice(0, 60),
      text: spec.text ?? '',
      priority: Number(spec.priority ?? 100),
    }
    if (existing >= 0) this.promptSections[existing] = item
    else this.promptSections.push(item)
    return item
  }

  command(extId, spec = {}) {
    const name = String(spec.name ?? '').trim()
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error(`命令名不合法：${name}（小写字母开头，可含数字与 -）`)
    if (!spec.script) throw new Error(`命令 ${name} 缺少 script（.mjs 的绝对路径）`)
    const item = { name, desc: String(spec.desc ?? ''), script: String(spec.script), ext: extId, argsHints: Array.isArray(spec.argsHints) ? spec.argsHints : [] }
    this.commands.set(name, item)
    return item
  }

  route(extId, expr, handler) {
    if (!expr || typeof expr !== 'string' || !expr.startsWith('/')) throw new Error('pod.route(expr, handler) 的 expr 要以 / 开头')
    if (typeof handler !== 'function') throw new Error('pod.route 的 handler 必须是函数')
    this.routes.push({ ext: extId, expr, handler })
    return { ext: extId, expr }
  }

  field(extId, spec = {}) {
    if (!Array.isArray(spec.path) || !spec.path.length) throw new Error('pod.field 需要 path 数组')
    const item = {
      ext: extId,
      path: spec.path.map(String),
      label: String(spec.label ?? spec.path.join('.')),
      hint: String(spec.hint ?? ''),
      kind: ['text', 'number', 'list', 'switch', 'select'].includes(spec.kind) ? spec.kind : 'text',
      options: Array.isArray(spec.options) ? spec.options.map(String) : [],
    }
    this.fields = this.fields.filter((f) => f.path.join('.') !== item.path.join('.'))
    this.fields.push(item)
    return item
  }

  recordError(extId, message) {
    const e = this.ext.get(extId)
    if (!e) return
    e.lastError = String(message).slice(0, 300)
    e.lastErrorAt = new Date().toISOString()
    this.log(`[ext:${extId}] ✗ ${e.lastError}`)
  }

  /** 触发事件；隔离 + 超时；返回每个扩展的结果 */
  async emit(event, payload = {}, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const list = this.handlers.get(event) ?? []
    const results = []
    for (const { id, fn } of list) {
      const t0 = nowMs()
      try {
        await withTimeout(Promise.resolve().then(() => fn(payload)), timeoutMs, `ext ${id} ${event}`)
        results.push({ id, ok: true, ms: nowMs() - t0 })
      } catch (e) {
        this.recordError(id, `${event}: ${e.message}`)
        results.push({ id, ok: false, ms: nowMs() - t0, error: String(e.message) })
      }
    }
    return results
  }

  /** 唤醒提示里要拼的扩展段落（按 priority，越小的越靠前） */
  promptText(ctx = {}) {
    const parts = this.promptSections
      .slice()
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((s) => {
        const body = typeof s.text === 'function' ? s.text(ctx) : s.text
        if (!body) return ''
        return `【扩展：${s.title}】\n${String(body).trim()}`
      })
      .filter(Boolean)
    return parts.length ? `\n\n—— 以下是 mod 扩展加进来的段落 ——\n\n${parts.join('\n\n')}` : ''
  }

  status() {
    return [...this.ext.values()].map((e) => ({
      id: e.id, name: e.name, version: e.version, description: e.description,
      source: e.source, enabled: e.enabled, ok: !e.lastError, lastError: e.lastError ?? '', lastErrorAt: e.lastErrorAt ?? '',
      promptSections: this.promptSections.filter((s) => s.ext === e.id).length,
      commands: [...this.commands.values()].filter((c) => c.ext === e.id).map((c) => c.name),
      fields: this.fields.filter((f) => f.ext === e.id).length,
    }))
  }

  fieldsForClient() {
    return this.fields.map(({ path, label, hint, kind, options, ext }) => ({ path, label, hint, kind, options, ext }))
  }

  /** 给 CLI（tools/bili.mjs）看的命令索引 */
  registry() {
    return {
      podId: this.podId,
      generatedAt: new Date().toISOString(),
      extensions: this.status(),
      commands: [...this.commands.values()].map(({ name, desc, script, ext, argsHints }) => ({ name, desc, script, ext, argsHints })),
    }
  }

  writeRegistry() {
    fs.mkdirSync(this.workDir, { recursive: true })
    fs.writeFileSync(this.registryFile, JSON.stringify(this.registry(), null, 2) + '\n', 'utf8')
    return this.registryFile
  }

  /** 列目录里所有 .mjs 扩展（不加载） */
  static discover(dirs = []) {
    const files = []
    for (const dir of dirs) {
      let list = []
      try { list = fs.readdirSync(dir) } catch { continue }
      for (const f of list) {
        if (!f.endsWith('.mjs') || f.startsWith('_') || f.startsWith('.')) continue
        files.push(path.join(dir, f))
      }
    }
    return files
  }

  /**
   * 加载全部扩展（幂等：先清掉旧的注册，再重新载）。
   * @param {{dirs?: string[]}} [opt]
   */
  async loadAll({ dirs = this.dirs } = {}) {
    this.dirs = [...new Set(dirs.filter(Boolean))]
    this.ext.clear()
    this.handlers.clear()
    this.promptSections = []
    this.fields = []
    this.routes = []
    this.commands.clear()

    const files = PodHost.discover(this.dirs)
    for (const file of files) {
      await this.loadFile(file)
    }
    this.writeRegistry()
    await this.emit('extensions:loaded', { count: this.ext.size })
    return this.status()
  }

  async loadFile(file) {
    const base = path.basename(file, '.mjs')
    let mod
    try {
      const url = `${pathToFileURL(file).href}?v=${crypto.createHash('sha1').update(String(fs.statSync(file).mtimeMs)).digest('hex').slice(0, 8)}`
      mod = await import(url)
    } catch (e) {
      const id = safeId(base)
      this.ext.set(id, { id, name: base, version: '0', description: '', source: file, enabled: true, lastError: `载入失败：${e.message}` })
      this.log(`[ext:${id}] 载入失败：${e.message}`)
      return null
    }
    const def = mod?.default ?? mod?.extension
    if (!def) {
      this.log(`[ext:${base}] 跳过：没有 export default`)
      return null
    }
    const manifest = typeof def === 'function' ? { setup: def } : def
    const id = safeId(manifest.id ?? base)
    if (this.ext.has(id)) {
      this.log(`[ext:${id}] 跳过：id 重复（${file}）`)
      return null
    }
    const entry = {
      id,
      name: String(manifest.name ?? id),
      version: String(manifest.version ?? '0.0.1'),
      description: String(manifest.description ?? ''),
      source: file,
      enabled: true,
      lastError: '',
    }
    this.ext.set(id, entry)
    // 设置页可以把某个扩展关掉（config.extensions.items[id].enabled === false）：
    // 关掉 = 不执行 setup，但仍在清单里显示（方便你回头再打开）。
    const items = (this._readConfig()?.extensions?.items ?? {})
    if (items[id] && items[id].enabled === false) {
      entry.enabled = false
      this.log(`[ext:${id}] 已停用（设置里关掉了）`)
      return entry
    }
    const pod = this.apiFor(entry)
    if (manifest.apiVersion && Number(manifest.apiVersion) > POD_API_VERSION) {
      entry.lastError = `要求 API v${manifest.apiVersion}，当前只有 v${POD_API_VERSION}`
      return entry
    }
    try {
      const setup = manifest.setup
      if (typeof setup === 'function') await withTimeout(Promise.resolve().then(() => setup(pod)), DEFAULT_TIMEOUT, `ext ${id} setup`)
      entry.ok = true
      this.log(`[ext:${id}] 已加载 ${entry.name} v${entry.version}`)
    } catch (e) {
      entry.lastError = `setup 失败：${e.message}`
      this.log(`[ext:${id}] setup 失败：${e.message}`)
    }
    return entry
  }
}
