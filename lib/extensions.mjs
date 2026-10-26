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
import {normalizeField} from './mod-schema.mjs'

export const POD_API_VERSION = 2
export const EXT_EVENTS = [
  'tick',
  'wake:before',
  'wake:after',
  'round:start',
  'round:delivered',
  'ledger:write',
  'diary:archived',
  'verify:done',
  'config:saved',
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
  constructor({ podId = 'bili-pod', workDir, log = () => {}, readConfig = () => ({}), patchConfig = () => ({}), dirs = [], timeoutMs = DEFAULT_TIMEOUT }) {
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
    this.panels = []
    this.routes = []
    this.commands = new Map()
    this.registryFile = path.join(workDir, 'extensions.json')
    this.timeoutMs = timeoutMs
    this.closed = false
    this._queue = Promise.resolve()
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
    const guarded = fn => (...args) => host.isActive(entry) ? fn(...args) : undefined
    return {
      apiVersion: POD_API_VERSION,
      id,
      podId: host.podId,
      dir: id,
      dataDir: guarded(() => host.dataDirOf(id)),
      log: (msg) => host.log(`[ext:${id}] ${msg}`),
      readConfig: () => host._readConfig(),
      patchConfig: guarded((patch) => host._patchConfig(patch)),
      on: guarded((event, fn) => host.on(id, event, fn)),
      addPromptSection: guarded((spec) => host.addPromptSection(id, spec)),
      command: guarded((spec) => host.command(id, spec)),
      route: guarded((expr, handler) => host.route(id, expr, handler)),
      field: guarded((spec) => host.field(id, spec)),
      panel: guarded((spec) => host.panel(id, spec)),
      hostInfo: () => host.status(),
    }
  }

  isActive(entry) { return !this.closed && entry.active === true && this.ext.get(entry.id) === entry }

  async deactivate(entry) {
    entry.active = false
    // A timed-out setup may return after a reload has installed the same id.
    if (this.ext.get(entry.id) === entry) {
      for (const [event, list] of this.handlers) this.handlers.set(event, list.filter(x => x.id !== entry.id))
      this.promptSections = this.promptSections.filter(x => x.ext !== entry.id)
      this.fields = this.fields.filter(x => x.ext !== entry.id)
      this.panels = this.panels.filter(x => x.ext !== entry.id)
      this.routes = this.routes.filter(x => x.ext !== entry.id)
      for (const [name, c] of this.commands) if (c.ext === entry.id) this.commands.delete(name)
    }
    const dispose = entry.dispose
    entry.dispose = null
    if (typeof dispose === 'function') {
      try { await withTimeout(Promise.resolve().then(dispose), this.timeoutMs, `ext ${entry.id} dispose`) }
      catch (e) { this.recordError(entry.id, `dispose: ${e.message}`) }
    }
  }

  async close() {
    this.closed = true // 必须在等待 setup 结束前阻断晚到的注册。
    await Promise.all([...this.ext.values()].map(entry => this.deactivate(entry)))
    await this._queue
  }

  on(extId, event, fn) {
    if (!EXT_EVENTS.includes(event)) throw new Error(`未知事件：${event}（可用：${EXT_EVENTS.join(', ')}）`)
    if (typeof fn !== 'function') throw new Error('pod.on(event, fn) 的 fn 必须是函数')
    const list = this.handlers.get(event) ?? []
    list.push({ id: extId, fn, entry:this.ext.get(extId) })
    this.handlers.set(event, list)
    return () => {
      const cur = this.handlers.get(event) ?? []
      this.handlers.set(event, cur.filter((x) => !(x.id === extId && x.fn === fn)))
    }
  }

  addPromptSection(extId, spec = {}) {
    const id = safeId(spec.id ?? extId)
    const existing = this.promptSections.findIndex((s) => s.id === id && s.ext === extId)
    const item = {
      id,
      ext: extId,
      title: String(spec.title ?? id).slice(0, 60),
      text: spec.text ?? '',
      priority: Number(spec.priority ?? 100),
      reasons: Array.isArray(spec.reasons)?spec.reasons.map(String):['wake'],
    }
    if (existing >= 0) this.promptSections[existing] = item
    else this.promptSections.push(item)
    return item
  }

  command(extId, spec = {}) {
    const name = String(spec.name ?? '').trim()
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error(`命令名不合法：${name}（小写字母开头，可含数字与 -）`)
    if (!spec.script) throw new Error(`命令 ${name} 缺少 script（.mjs 的绝对路径）`)
    if (!path.isAbsolute(String(spec.script)) || !String(spec.script).endsWith('.mjs')) throw new Error('script 必须是本地 .mjs 绝对路径')
    const item = { name, desc: String(spec.desc ?? ''), script: String(spec.script), ext: extId, argsHints: Array.isArray(spec.argsHints) ? spec.argsHints : [] }
    if(this.commands.has(name)&&this.commands.get(name).ext!==extId)throw Error('命令已被其他模块注册：'+name)
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
    const item = {ext:extId,...normalizeField(spec)}
    if(this.fields.some(f=>f.path.join('.')===item.path.join('.')&&f.ext!==extId))throw Error('设置字段已被其他模块注册：'+item.path.join('.'))
    this.fields = this.fields.filter(f=>f.path.join('.')!==item.path.join('.'))
    this.fields.push(item)
    return item
  }

  panel(extId,spec={}) {
    if(spec.kind!=='collection'||!/^\/[a-zA-Z0-9/_-]*$/.test(spec.route??''))throw Error('不支持的展示面板或路由')
    const item={ext:extId,id:safeId(spec.id??extId),title:String(spec.title??'列表'),kind:'collection',route:spec.route,description:String(spec.description??''),filters:(spec.filters??[]).map(f=>({key:String(f.key),label:String(f.label),options:(f.options??[]).map(o=>typeof o==='object'?{value:String(o.value),label:String(o.label)}:{value:String(o),label:String(o)})}))}
    this.panels=this.panels.filter(p=>p.ext!==extId||p.id!==item.id)
    this.panels.push(item)
    return item
  }

  panelsForClient() {return this.panels.map(p=>({...p,route:'/dsh-bili/api/ext/'+p.ext+p.route}))}

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
    for (const { id, fn, entry } of list) {
      if (!this.isActive(entry ?? {})) continue
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
      .filter(s=>s.reasons.includes(ctx.reason??'wake'))
      .slice()
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((s) => {
        try {
          const body = typeof s.text === 'function' ? s.text(ctx) : s.text
          if (body && typeof body.then === 'function') {
            Promise.resolve(body).catch(() => {})
            throw new Error('prompt text 回调必须同步返回文本')
          }
          if (!body) return ''
          return `【扩展：${s.title}】\n${String(body).trim()}`
        } catch (e) { this.recordError(s.ext, `prompt: ${e.message}`); return '' }
      })
      .filter(Boolean)
    return parts.length ? `\n\n—— 以下是 mod 扩展加进来的段落 ——\n\n${parts.join('\n\n')}` : ''
  }

  status() {
    return [...this.ext.values()].map((e) => ({
      id: e.id, name: e.name, version: e.version, description: e.description,
      source: e.source, enabled: e.enabled, active: this.isActive(e), kind: e.kind ?? 'legacy', ok: !e.lastError, lastError: e.lastError ?? '', lastErrorAt: e.lastErrorAt ?? '',
      promptSections: this.promptSections.filter((s) => s.ext === e.id).length,
      commands: [...this.commands.values()].filter((c) => c.ext === e.id).map((c) => c.name),
      fields: this.fields.filter((f) => f.ext === e.id).length,
      panels: this.panels.filter(p=>p.ext===e.id).length,
    }))
  }

  fieldsForClient() {
    // 2026-10-22 修：字段的 path 内部是数组（好写 setPath），但设置页按「点号路径」
    //   收发（extensionValues 的 key 就是点号字符串）。原来直接把数组发出去，前端
    //   `f.path.split('...')` 会炸成 `TypeError: f.path.split is not a function`，
    //   整个「设置 → 鲸群」被 slot 的错误边界吞掉，页面一片空白。
    return this.fields.map(f=>({...f,path:f.path.join('.'),parts:f.path,optionsRoute:f.optionsRoute?'/dsh-bili/api/ext/'+f.ext+f.optionsRoute:undefined}))
  }

  /** 给 CLI（tools/bili.mjs）看的命令索引 */
  registry() {
    return {
      podId: this.podId,
      generatedAt: new Date().toISOString(),
      extensions: this.status(),
      commands: [...this.commands.values()].map(({ name, desc, ext, argsHints }) => ({ name, desc, ext, argsHints })),
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
      try { list = fs.readdirSync(dir).sort((a,b)=>Number(!a.endsWith('.mjs'))-Number(!b.endsWith('.mjs'))||a.localeCompare(b)) } catch { continue }
      for (const f of list) {
        if (f.startsWith('_') || f.startsWith('.')) continue
        const candidate=path.join(dir,f)
        if(f.endsWith('.mjs')&&fs.statSync(candidate).isFile())files.push(candidate)
        else if(fs.statSync(candidate).isDirectory()&&fs.existsSync(path.join(candidate,'mod.json')))files.push(path.join(candidate,'mod.json'))
      }
    }
    return files
  }

  /**
   * 加载全部扩展（幂等：先清掉旧的注册，再重新载）。
   * @param {{dirs?: string[]}} [opt]
   */
  loadAll({ dirs = this.dirs } = {}) {
    const next = this._queue.then(() => this._loadAll(dirs))
    this._queue = next.catch(() => {})
    return next
  }

  async _loadAll(dirs) {
    if (this.closed) return []
    this.dirs = [...new Set(dirs.filter(Boolean))]
    for (const entry of this.ext.values()) await this.deactivate(entry)
    this.ext.clear()
    this.handlers.clear()
    this.promptSections = []
    this.fields = []
    this.panels = []
    this.routes = []
    this.commands.clear()

    const files = PodHost.discover(this.dirs)
    for (const file of files) {
      if (this.closed) return []
      await this.loadFile(file)
    }
    if (this.closed) return []
    this.writeRegistry()
    await this.emit('extensions:loaded', { count: this.ext.size })
    return this.status()
  }

  async loadFile(file) {
    if(path.basename(file)==='mod.json')return this.loadPackage(file)
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
    if (this.closed) return null
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
      active: true,
      lastError: '',
    }
    this.ext.set(id, entry)
    // 设置页可以把某个扩展关掉（config.extensions.items[id].enabled === false）：
    // 关掉 = 不执行 setup，但仍在清单里显示（方便你回头再打开）。
    const cfg = this._readConfig()?.extensions ?? {}
    const items = cfg.items ?? {}
    if (cfg.enabled === false || items[id]?.enabled === false) {
      entry.enabled = false
      entry.active = false
      this.log(`[ext:${id}] 已停用（设置里关掉了）`)
      return entry
    }
    if (manifest.apiVersion && Number(manifest.apiVersion) > POD_API_VERSION) {
      entry.lastError = `要求 API v${manifest.apiVersion}，当前只有 v${POD_API_VERSION}`
      await this.deactivate(entry)
      return entry
    }
    return this.setupEntry(entry,manifest)
  }

  async setupEntry(entry,manifest) {
    const id=entry.id,pod=this.apiFor(entry)
    try {
      for(const f of manifest.fields??[])pod.field(f)
      for(const p of manifest.panels??[])pod.panel(p)
      const setup = manifest.setup
      if (typeof setup === 'function') {
        const pending = Promise.resolve().then(() => setup(pod)).then(async dispose => {
          if (typeof dispose === 'function') {
            entry.dispose = dispose
            if (!this.isActive(entry)) await this.deactivate(entry)
          }
        })
        await withTimeout(pending, this.timeoutMs, `ext ${id} setup`)
      }
      if (!this.isActive(entry)) return entry
      entry.ok = true
      this.log(`[ext:${id}] 已加载 ${entry.name} v${entry.version}`)
    } catch (e) {
      entry.lastError = `setup 失败：${e.message}`
      await this.deactivate(entry)
      this.log(`[ext:${id}] setup 失败：${e.message}`)
    }
    return entry
  }
  reload(id) {
    const next=this._queue.then(async()=>{
      if(this.closed)throw Error('模块宿主已关闭')
      const entry=this.ext.get(id)
      if(!entry)throw Error('未知模块：'+id)
      await this.deactivate(entry)
      this.ext.delete(id)
      await this.loadFile(entry.source)
      this.writeRegistry()
      await this.emit('extensions:loaded',{count:this.ext.size,reloaded:id})
      return this.status()
    })
    this._queue=next.catch(()=>{})
    return next
  }

  async loadPackage(file) {
    let manifest,entry
    const fallback=safeId(path.basename(path.dirname(file)))
    try {
      manifest=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))
      if(!/^[a-z][a-z0-9-]{1,59}$/.test(manifest.id??''))throw Error('mod.json 需要合法唯一 id')
      const id=manifest.id
      if(this.ext.has(id)){this.log('[ext:'+id+'] 跳过重复模块');return null}
      entry={id,name:String(manifest.name??id),version:String(manifest.version??'0.0.1'),description:String(manifest.description??''),source:file,kind:'package',enabled:true,active:true,lastError:''}
      this.ext.set(id,entry)
      const settings=this._readConfig()?.extensions??{}
      if(settings.enabled===false||settings.items?.[id]?.enabled===false){entry.enabled=false;entry.active=false;return entry}
      if(Number(manifest.apiVersion??2)>POD_API_VERSION)throw Error('要求 API v'+manifest.apiVersion+'，当前只有 v'+POD_API_VERSION)
      const dir=fs.realpathSync(path.dirname(file)),main=String(manifest.main??'index.mjs'),target=path.resolve(dir,main)
      if(path.isAbsolute(main)||!target.startsWith(dir+path.sep)||!target.endsWith('.mjs'))throw Error('模块入口必须位于包内且为 .mjs')
      const real=fs.realpathSync(target)
      if(!real.startsWith(dir+path.sep))throw Error('模块入口不能跳出包目录')
      const hash=crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex').slice(0,16)
      const loaded=await import(pathToFileURL(real).href+'?v='+hash)
      if(this.closed){entry.active=false;return entry}
      const def=loaded.default??loaded.extension
      if(typeof def!=='function'&&typeof def?.setup!=='function')throw Error('模块入口须导出 setup(pod)')
      return this.setupEntry(entry,{...manifest,setup:typeof def==='function'?def:def.setup})
    } catch(e) {
      if(!entry){entry={id:fallback,name:fallback,source:file,kind:'package',enabled:true,active:false};if(!this.ext.has(fallback))this.ext.set(fallback,entry)}
      entry.lastError='载入失败：'+e.message
      await this.deactivate(entry)
      this.log('[ext:'+entry.id+'] '+entry.lastError)
      return entry
    }
  }

}
