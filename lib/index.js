import { trafficGuard, riskSettings } from '../tools/lib/traffic.mjs'
/**
 * lib/index.js —— 鲸群（dsh-bili-pod）宿主插件
 * ============================================================================
 * 这是 dsh-bili-whale（基座）的 fork。和基座一样，插件挂在 DSH 里，负责：
 *   · 生物钟（lib/scheduler.js）：到点把她叫醒、监听回复、私信、直播
 *   · 设置 API + 客户端 section（lib/client.js：设置 → 鲸群）
 *   · 扫码登录（lib/login.mjs + lib/qr.mjs）
 *   · 日记文件夹 + 分类记录（lib/diarystore.mjs）
 *   · 账本（lib/ledger.mjs）
 *   · 发出后的评论复核（lib/verifycomments.mjs）
 *   · mod 扩展宿主（lib/extensions.mjs）与每轮工具白名单（lib/scope.mjs）
 *
 * 保留基座最重要的两条工程纪律：
 *   ① inject 用**一个数组**写全（基座踩过：写两个 inject 键 → 后者覆盖前者 → 静默不干活的坑）
 *   ② 所有写操作都过本机回环 + connection 信任栅栏（fail-closed）
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

import { resolveNodeRuntime } from './node-runtime.js'
import { startScheduler } from './scheduler.js'
import * as store from './store.mjs'
import * as biliApi from '../tools/lib/bili-api.mjs'
import { mergeDeep, normalizeConfig, DEFAULTS } from './defaults.mjs'
import { applyTide, previewTide, describeTide } from './tide.mjs'
import { describeCheap, isCheapNow } from './pricing.mjs'
import { loginStart, loginPoll, fetchSelf, saveCredential, credentialState, readCredential } from './login.mjs'
import { qrSvg, qrAscii, qrAvailable } from './qr.mjs'
import * as diary from './diarystore.mjs'
import * as ledger from './ledger.mjs'
import * as spend from './spend.mjs'
import { verifyRecent, recordSent, SENT_FILE } from './verifycomments.mjs'
import { claimDraft, settleDraft, readOperation, finishSend, reconcileDraft } from './comment-state.mjs'
import { policyOf, reviewDecision, POLICY_LABEL } from './policy.mjs'
import { PodHost, POD_API_VERSION, EXT_EVENTS } from './extensions.mjs'
import { scopeFor, writeScope, readScope, clearScope, READ_CMDS, WRITE_CMDS } from './scope.mjs'
import { statePath, migrateState, stateDir } from './state-dir.mjs'
import { personaPaths, readPersonaDocument, writePersonaDocument, PERSONA_MAX_CHARS } from './persona.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')
const CFG_FILE = store.CFG_FILE
const CRED_FILE = store.CRED_FILE
const PERSONA_FILE = store.PERSONA_FILE
const PENDING = statePath('pending-replies.json')
const DIARY_ROOT = store.DIARY_ROOT
const WORK_DIR = store.WORK_DIR
const PERSONA_PATHS = personaPaths({ dshHome: store.DSH_HOME, home: store.HOME, workDir: WORK_DIR })

let SCHED_STATUS = { ok: false, reason: '未启动', at: null }

export default {
  name: 'dsh-bili-pod',
  // ⚠️ 基座教训：inject 必须写成一个数组（对象字面量后键覆盖前键 → 静默不干活）
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {
    const disposers = []
    const extDisposers = []
    const loginSessions = new Map()
    // Retain revocations for this host lifetime: a cancelled request may arrive after a newer QR.
    const cancelledLoginRequests = new Set()
    let activeLoginRequest = ''
    let loginGeneration = 0
    const invalidateLogin = () => {
      if (activeLoginRequest) cancelledLoginRequests.add(activeLoginRequest)
      activeLoginRequest = ''; loginSessions.clear(); return ++loginGeneration
    }
    let sched = null
    let booted = false
    let disposed = false

    const log = (m) => { try { console.log(`[bili-pod] ${m}`) } catch { /* 没有控制台 */ } }
    log('[版本] 0.9.0 · 历史私信队列 / 请求保护 / 原生投递互斥 / 轻量看图')
    const readConfig = () => store.readConfig()
    const writeConfig = (patch) => store.writeConfig(patch)

    // ── 安全栅栏（原样保留基座的 fail-closed 实现）────────────────────────────
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0,host.indexOf(']')+1) : host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    function rejected(req, res, { strict = true } = {}) {
      if (!isLoopbackReq(req)) {
        let trusted=false
        try { const conn=ctx.get('connection')||ctx.connection; trusted=conn?.isTrusted?.(req)===true } catch {}
        if(!trusted){json(res,403,{ok:false,error:'不受信任的访问来源'});return true}
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) { rejected.warned = true; log('信任栅栏不可用：connection 服务缺失 → fail-closed') }
          if (strict) { json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true }
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        if (strict) { json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true }
        return false
      }
    }

    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch { /* 头已发 */ }
          }
        },
      }))
    }

    function json(res, code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    function readBody(req, limit = 128 * 1024) {
      return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }
    const bodyJson = async (req) => { const t = await readBody(req); try { return JSON.parse(t || '{}') } catch { return {} } }
    const execNode = (args, opts, cb) => {
      const node = resolveNodeRuntime(store.DSH_HOME)
      if (!node) { cb(new Error('找不到可用的 node 运行时（设置 DSH_NODE）')); return }
      execFile(node, args, { windowsHide: true, ...opts }, cb)
    }
    const resolveBiliMjs = () => {
      const cfg = readConfig()
      return cfg.toolsPath || path.join(PLUGIN_ROOT, 'tools', 'bili.mjs')
    }
    const safeJoin = (root, rel) => {
      const p = path.resolve(root, rel)
      return p === root || p.startsWith(root + path.sep) ? p : null
    }

    // ── mod 扩展宿主 ─────────────────────────────────────────────────────────
    const extensions = new PodHost({
      podId: 'dsh-bili-pod',
      workDir: WORK_DIR,
      log,
      readConfig,
      patchConfig: (patch) => {
        const { config } = writeConfig(patch ?? {})
        try { sched?.invalidate(true) } catch { /* 还没起 */ }
        if (patch?.extensions) void reloadExtensions().catch(e => log('扩展重载失败：' + e.message))
        return config
      },
      dirs: [path.join(PLUGIN_ROOT, 'extensions'), ...store.USER_EXT_DIRS],
    })

    function extDirsFromConfig() {
      const cfg = readConfig()
      const extra = (cfg.extensions?.dirs ?? []).filter(Boolean)
      return [...new Set([path.join(PLUGIN_ROOT, 'extensions'), ...store.USER_EXT_DIRS, ...extra])]
    }

    function mountExtRoutes() {
      while (extDisposers.length) { try { extDisposers.pop()() } catch { /* ignore */ } }
      if (disposed || readConfig().extensions?.enabled === false) return
      const enabled = readConfig().extensions?.items ?? {}
      for (const r of extensions.routes) {
        const e = extensions.ext.get(r.ext)
        if (!e || !extensions.isActive(e) || (enabled?.[r.ext]?.enabled === false)) continue
        const full = `/dsh-bili/api/ext/${r.ext}${r.expr}`
        extDisposers.push(ctx.webServer.register({
          kind: 'exact',
          path: full,
          handler: async (req, res) => {
            if (disposed || !extensions.isActive(e)) { json(res, 503, {ok:false}); return }
            if (rejected(req, res)) return
            try {
              const out = await r.handler({ req, res, json, bodyJson, readConfig, writeConfig, workDir: WORK_DIR, diaryRoot: DIARY_ROOT, podHost: extensions })
              if (out !== undefined && !res.writableEnded) json(res, 200, out)
            } catch (e) { try { json(res, 500, { ok: false, error: String(e?.message ?? e) }) } catch { /* ignore */ } }
          },
        }))
      }
    }

    // ── 设置 ────────────────────────────────────────────────────────────────
    async function reloadExtensions() {
      const list = await extensions.loadAll({ dirs: extDirsFromConfig() })
      mountExtRoutes()
      return list
    }

    // 顶层白名单（比基座多了 review / ledger / artifacts / extensions / scope）
    const KNOWN_KEYS = new Set(['reportLevel', 'commentPerRound', 'replyPerRound', 'replyToComments', 'favFolderId', 'search', 'persona', 'preferences', 'mistress', 'dm', 'notify', 'aliases', 'owner', 'self', 'quota', 'share', 'listen', 'diary', 'night', 'review', 'ledger', 'artifacts', 'extensions', 'scope', 'toolsPath'])

    route('exact', '/dsh-bili/api/settings', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readConfig()
        let personaInfo
        try {
          const document = readPersonaDocument(PERSONA_PATHS)
          const { text, ...info } = document
          personaInfo = { ...info, loadMode: cfg.persona.loadMode, maxChars: PERSONA_MAX_CHARS, instructionsPath: PERSONA_PATHS.instructionsFile }
        } catch (error) { personaInfo = { path: PERSONA_FILE, error: error.message } }
        json(res, 200, {
          ok: true,
          config: cfg,
          credentials: credentialState(),
          configPath: CFG_FILE,
          workDir: WORK_DIR,
          diaryRoot: DIARY_ROOT,
          persona: personaInfo,
          tide: { preview: previewTide(cfg.night), text: describeTide(cfg.night?.tide) },
          review: { policy: policyOf(cfg), label: POLICY_LABEL?.[policyOf(cfg)] ?? policyOf(cfg) },
          autoSent: (() => {
            try {
              const db = JSON.parse(fs.readFileSync(statePath('auto-sent.json'), 'utf8'))
              const day = new Date().toLocaleDateString('sv-SE')
              const rec = db.days?.[day]
              return rec ? { used: (rec.items ?? []).filter((x) => x.status !== 'rejected').length, max: cfg.review?.autoLimits?.perDay ?? 12 } : { used: 0, max: cfg.review?.autoLimits?.perDay ?? 12 }
            } catch { return { used: 0, max: cfg.review?.autoLimits?.perDay ?? 12 } }
          })(),
          scheduler: SCHED_STATUS,
          extensions: extensions.status(),
          extensionFields: extensions.fieldsForClient(),
          apiVersion: POD_API_VERSION,
          events: EXT_EVENTS,
          scope: { read: [...READ_CMDS], write: [...WRITE_CMDS] },
          qr: { available: qrAvailable() },
        })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await bodyJson(req)
      const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
      const filtered = {}
      for (const [k, v] of Object.entries(incoming)) if (KNOWN_KEYS.has(k)) filtered[k] = v
      // 扩展声明的字段也允许写（但只写它们声明过的 path）
      const extPaths = extensions.fields.map((f) => f.path.join('.'))
      const patch = { ...filtered }
      if (body.extensionValues && typeof body.extensionValues === 'object') {
        for (const [p, v] of Object.entries(body.extensionValues)) {
          if (!extPaths.includes(p)) continue
          const segs = p.split('.')
          let cur = patch
          for (let i = 0; i < segs.length - 1; i += 1) { cur[segs[i]] ??= {}; cur = cur[segs[i]] }
          cur[segs[segs.length - 1]] = v
        }
      }
      if (patch.night && (patch.night.mode ?? 'fixed') === 'fixed' && (!Array.isArray(patch.night.windows) || !patch.night.windows.length)) {
        json(res, 400, { ok: false, error: '至少要有一个作息窗口' }); return
      }
      const prev = readConfig()
      const { config, warns } = writeConfig(patch)
      // 「排班有没有变」按真正影响计划的字段比 —— 不能拿整份 night 对象比：
      // normalizeConfig 会补默认值（mode/windows/tide…），那样每次保存都会被判成「变了」，
      // 一保存就把当天已经排好的计划冲掉（基座的 bug，这里修掉）。
      const schedSignature = (c) => JSON.stringify({
        windows: c?.night?.windows ?? null,
        mode: c?.night?.mode ?? 'fixed',
        skipChance: c?.night?.skipChance ?? null,
        maxVideos: c?.night?.maxVideos ?? null,
        tide: c?.night?.tide ?? null,
      })
      const schedulingChanged =
        schedSignature(prev) !== schedSignature(config) ||
        prev.diary?.records?.join(',') !== config.diary?.records?.join(',')
      try { sched?.invalidate(schedulingChanged) } catch { /* ignore */ }
      if (JSON.stringify(prev.extensions) !== JSON.stringify(config.extensions)) await reloadExtensions()
      try { await extensions.emit('config:saved', { config }) } catch { /* ignore */ }
      json(res, 200, {
        ok: true,
        config,
        warns,
        tide: { preview: previewTide(config.night), text: describeTide(config.night?.tide) },
        scope: { read: [...READ_CMDS], write: [...WRITE_CMDS] },
      })
    })

    // ── 扫码登录 ────────────────────────────────────────────────────────────
    // 客户端先 GET /login/qr（拿 svg），随后每 2 秒 GET /login/poll?key=…
    route('exact', '/dsh-bili/api/login/qr', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const requestId = new URL(req.url, 'http://127.0.0.1').searchParams.get('requestId') || randomUUID()
      if (cancelledLoginRequests.has(requestId)) { json(res, 200, { ok: false, state: 'expired' }); return }
      const generation = invalidateLogin()
      activeLoginRequest = requestId
      if (!qrAvailable()) { json(res, 200, { ok: false, error: '二维码库缺失（vendor/qrcode.cjs 不在）—— 仍可手动粘 cookie', canManual: true }); return }
      try {
        const s = await loginStart()
        if (disposed || generation !== loginGeneration) { json(res, 200, { ok: false, state: 'expired' }); return }
        // 清掉过期的（>3 分钟）
        for (const [k, v] of loginSessions) if (Date.now() - v.created > 180_000) loginSessions.delete(k)
        loginSessions.set(s.key, { url: s.url, created: s.created, generation })
        json(res, 200, { ok: true, requestId, key: s.key, url: s.url, svg: qrSvg(s.url, { scale: 7 }), ascii: qrAscii(s.url), expiresInSec: 180 })
      } catch (e) {
        json(res, 200, { ok: false, error: `生成二维码失败：${String(e?.message ?? e)}`, canManual: true })
      }
    })

    route('exact', '/dsh-bili/api/login/cancel', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const { requestId } = await bodyJson(req)
      if (typeof requestId !== 'string' || !requestId) { json(res, 400, { ok: false, error: '缺少 requestId' }); return }
      cancelledLoginRequests.add(requestId)
      if (activeLoginRequest === requestId) invalidateLogin()
      json(res, 200, { ok: true })
    })

    route('exact', '/dsh-bili/api/login/poll', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const key = String(url.searchParams.get('key') ?? '')
      if (!key) { json(res, 400, { ok: false, error: '缺少 key' }); return }
      const session = loginSessions.get(key)
      const current = () => !disposed && session && loginSessions.get(key) === session && session.generation === loginGeneration && Date.now() - session.created <= 180_000
      const expired = () => json(res, 200, { ok: true, state: 'expired', detail: '二维码已失效，请重新生成' })
      if (!current()) { expired(); return }
      try {
        session.inflight ??= (async () => {
          const r=await loginPoll(key)
          if(!current())return {ok:true,state:'expired',detail:'二维码已失效，请重新生成'}
          if(r.state==='ok'&&r.credential){
            const saved=await saveCredential(r.credential,{check:()=>{if(!current())throw new Error('登录已取消或过期，未保存')}})
            const self=saved.self
            if(self)writeConfig({self})
            loginSessions.delete(key)
            try{await extensions.emit('login:ok',{self})}catch{}
            return {ok:true,state:'ok',self,detail:'✓ 登录成功：'+self.name+'（mid '+self.mid+'）',saved:saved.present}
          }
          if(r.state==='expired'){loginSessions.delete(key);return {ok:true,state:'expired',detail:'二维码过期了，请重新生成'}}
          return {ok:true,state:r.state,code:r.code,detail:r.state==='scanned'?'已扫描，请在手机上点确认':'等你扫码…'}
        })()
        json(res,200,await session.inflight)
      } catch(e) {
        if(!current()){expired();return}
        json(res,200,{ok:false,state:'error',error:'轮询失败：'+String(e?.message??e)})
      } finally {delete session.inflight}
    })

    // ── 手动粘 cookie（扫码失败时的退路，保留基座实现）────────────────────────
    route('exact', '/dsh-bili/api/cookie', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const pick = (raw, key) => {
        let v = String(raw ?? '').trim()
        const m = v.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
        if (m) return m[1].trim()
        v = v.replace(new RegExp('^' + key + '\\s*=', 'i'), '')
        return v.replace(/^["'\s]+|["';\s]+$/g, '')
      }
      const sessdata = pick(b.sessdata, 'SESSDATA')
      const bili_jct = pick(b.bili_jct, 'bili_jct')
      const buvid3 = pick(b.buvid3, 'buvid3')
      const problems = []
      if (!sessdata) problems.push('SESSDATA 空着（它是 HttpOnly，document.cookie 读不到，必须 F12 手动复制）')
      else if (sessdata.length < 20) problems.push(`SESSDATA 太短（长度 ${sessdata.length}）—— 大概只复制到一半`)
      if (!bili_jct) problems.push('bili_jct 空着')
      else if (!/^[0-9a-fA-F]{32}$/.test(bili_jct)) problems.push(`bili_jct 格式不对（长度 ${bili_jct.length}，应为 32 位十六进制）`)
      if (buvid3 && !/^[0-9A-Fa-f-]{20,}(?:infoc)?$/i.test(buvid3)) problems.push('buvid3 格式不像（可留空）')
      if (problems.length) {
        json(res, 400, { ok: false, error: '凭据有问题，没写入：\n  · ' + problems.join('\n  · ') + '\n\n建议直接用上面的「扫码登录」✓' })
        return
      }
      try {
        const generation = invalidateLogin()
        const saved = await saveCredential({ sessdata, bili_jct, buvid3 }, {check:()=>{if(disposed||generation!==loginGeneration)throw new Error('登录请求已失效，未保存')}})
        const self = saved.self
        if (!disposed && generation === loginGeneration && self) writeConfig({ self })
        json(res, 200, {
          ok: true, self,
          detail: self ? `已写入 ✓ 当前登录：${self.name}（mid ${self.mid}）` : '凭据已验证并保存',
        })
      } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); return }
    })

    // ── 人设 ────────────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/persona', async (req, res) => {
      if (req.method === 'GET') {
        const document = readPersonaDocument(PERSONA_PATHS)
        json(res, 200, { ok: true, ...document, loadMode: readConfig().persona.loadMode, maxChars: PERSONA_MAX_CHARS, instructionsPath: PERSONA_PATHS.instructionsFile })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const text = String(b.text ?? '')
      if (text.length > PERSONA_MAX_CHARS) { json(res, 400, { ok: false, error: `人设共 ${text.length} 字符，超过 ${PERSONA_MAX_CHARS} 上限；未保存、未截断。` }); return }
      let document
      try {
        document = writePersonaDocument(text, { config: readConfig(), paths: PERSONA_PATHS })
      } catch (e) { json(res, 500, { ok: false, error: '保存未完成：' + String(e?.message ?? e) }); return }
      const { bytes, path: sourcePath, version } = document
      json(res, 200, { ok: true, bytes, path: sourcePath, version, detail: text.trim() ? `✓ 已完整保存（${text.length} 字符 / ${bytes} 字节）—— 下一次唤醒或消息使用新版` : '✓ 已清空 —— 使用设置中的基本身份' })
    })

    // ── 依赖体检 ────────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/deps', async (req, res) => {
      const cfg = readConfig()
      const tools = cfg.toolsPath || path.join(PLUGIN_ROOT, 'tools', 'bili.mjs')
      if (!fs.existsSync(tools)) { json(res, 200, { ok: false, error: `找不到 bili.mjs：${tools}（在设置里填「工具目录」）`, items: [], scheduler: SCHED_STATUS }); return }
      execNode([tools, 'deps', '--json'], { timeout: 90_000 }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout || '{}'))
          let selfNow = null
          const ck = (parsed.items ?? []).find((it) => it.name === 'B站 cookie')
          const m = String(ck?.detail ?? '').match(/已登录：(.+?)（mid (\d+)）/)
          if (m) {
            selfNow = { name: m[1], mid: m[2] }
            const cur = readConfig()
            if (String(cur.self?.mid ?? '') !== selfNow.mid || String(cur.self?.name ?? '') !== selfNow.name) writeConfig({ self: selfNow })
          }
          let selftestPassed = false
          try { selftestPassed = fs.existsSync(statePath('selftest-passed.json')) } catch { /* ignore */ }
          json(res, 200, { ok: !!parsed.ok, items: parsed.items ?? [], node: parsed.node, self: selfNow, selftestPassed, scheduler: SCHED_STATUS })
        } catch {
          json(res, 200, { ok: false, error: String(stderr || err?.message || 'deps 跑失败').slice(0, 300), items: [] })
        }
      })
    })

    // ── 待审回复（review.policy 决定草稿还是直发；这里是人工队列 + 批量批准）────
    // 批准 = 宿主签发一次性凭据 → CLI 用同一段正文发送（评论 / 私信 / 分享私信都走这里）
    const approvalArgs = (item, token, operationId, cfgNow) => {
      if (item.kind === 'dm') {
        const a = ['dm', '--to', String(item.to ?? ''), '--msg', String(item.message ?? ''), '--approval', token, '--operation-id', operationId]
        if (item.share) a.push('--share', '--reason', String(item.reason || '主人批准的分享'), '--score', String(item.score || 13), '--rank', String(item.rank || 1))
        if (item.bvid) a.push('--target', String(item.bvid).replace(/^BV:/, ''))
        a.push('--go')
        return a
      }
      const a = ['comment', '--oid', String(item.oid), '--type', String(item.type ?? '1'),
        '--root', String(item.root), '--parent', String(item.parent || item.root),
        '--message', item.message, '--auto', '--reviewed', '--approval', token, '--operation-id', operationId,
        ...(cfgNow.listen?.oncePerPerson !== false ? ['--once-per-person'] : []),
        ...(cfgNow.review?.verify !== false ? ['--verify'] : []), '--go']
      if (item.bvid) a.push('--bvid', item.bvid)
      if (item.referer) a.push('--referer', item.referer)
      return a
    }

    const runApproval = (id, cb) => {
      let claim = claimDraft(id)
      if (!claim) {
        // 0.8.0：卡在「正在发送/结果不明」的草稿，先跟操作记录对账：
        //   accepted → 其实已发出（清掉）；uncertain/stale → 拉回 pending，再认领一次。
        // 以前只报「请先人工核对」，主人照着核对完还是点不动。
        const rec = reconcileDraft(id)
        if (rec.action === 'reset') claim = claimDraft(id)
        if (!claim) {
          cb({ ok: false, done: false, error: rec.reason ?? '草稿不存在', status: rec.action })
          return
        }
      }
      const { item, token, operationId } = claim
      execNode([resolveBiliMjs(), ...approvalArgs(item, token, operationId, readConfig())], { timeout: 120000, env: { ...process.env, BILI_POD_SCOPE: 'off' } }, (err, stdout, stderr) => {
        const text = String(stdout ?? '')
        const saved = readOperation(operationId)
        const receipt = /code=0(?:\s|$)/.test(text) ? (text.match(/已发布，评论 rpid=(\d+)/) ?? [])[1] : null
        // 成功判定看「子进程收据」：
        //   评论类子进程会自己写 operation=accepted；私信类靠 stdout 的 code=0。
        //   注意：不能把 saved.status==='approved' 当成拒绝 —— 那只是「宿主签发了批准」，
        //   还没发出去（0.7.2 前就是这么判的，私信批准永远落成 rejected）。
        const codeZero = /(^|\s)code=0(\s|$)/.test(text)
        // 私信 CLI 成功时打的是「✓ 已发送（HTTP 200）」，没有 code=0 —— 以前这里认不出，批准后永远落 uncertain。
        const dmOk = /✓ 已发送/.test(text)
        const status = saved?.status === 'accepted' || receipt || ((codeZero || dmOk) && !err) ? 'accepted'
          : saved?.status === 'rejected' || (err && /code=-?\d+/.test(text)) ? 'rejected'
          : 'uncertain'
        const rpid = saved?.rpid || receipt || null
        finishSend(operationId, status, { ...(rpid ? { rpid } : {}), reason: status === 'uncertain' ? '子进程没有可靠收据；请人工核对，勿重发' : '' })
        settleDraft(id, operationId, status)
        try {
          fs.appendFileSync(path.join(store.DSH_HOME, 'pod-log.jsonl'), JSON.stringify({
            at: new Date().toISOString(), kind: 'reply-' + status, operationId,
            target: item.who || item.parent || item.to, note: String(item.message).slice(0, 60),
          }) + '\n')
        } catch { /* operation state remains the authoritative receipt */ }
        cb({ ok: status === 'accepted', done: true, status, operationId, rpid, id, out: text.slice(-400), err: String(stderr ?? err?.message ?? '').slice(0, 300) })
      })
    }

    route('exact', '/dsh-bili/api/pending', async (req, res) => {
      let items = []
      try { items = JSON.parse(fs.readFileSync(PENDING, 'utf8')).items ?? [] } catch { /* 没有队列 */ }
      // 0.8.0：自动对账 —— uncertain / 超时的 sending 拉回 pending，accepted 清掉，
      // 否则设置页上那条会永远显示「审核未通过」且点「发」只报同一句错。
      for (const it of items) {
        if (it.operationId || (it.status && it.status !== 'pending')) {
          try { reconcileDraft(it.id) } catch { /* 一条失败不影响整页 */ }
        }
      }
      try { items = JSON.parse(fs.readFileSync(PENDING, 'utf8')).items ?? [] } catch { items = [] }
      const cfgNow = readConfig()
      json(res, 200, {
        ok: true, items,
        policy: policyOf(cfgNow),
        preReview: String(policyOf(cfgNow)) !== 'off',
        autoSend: cfgNow.dm?.autoSend === true,
        autoSendTo: cfgNow.dm?.autoSendTo ?? [],
      })
    })

    // 0.7.2：按「当前」档位重判旧草稿。
    //   草稿在生成那一刻就把判定结果带上了；你后来改了档位/打开了自动发送，
    //   旧草稿不会自己变（否则你否掉的东西可能被"重判"放出去）。
    //   这里只重判私信类（收信人身份是确定的）；评论类要按对方身份判，留在草稿上手动批。
    route('exact', '/dsh-bili/api/pending/reapply', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      let items = []
      try { items = JSON.parse(fs.readFileSync(PENDING, 'utf8')).items ?? [] } catch { /* 空队列 */ }
      const cfgNow = readConfig()
      const mistressMid = cfgNow.mistress?.enabled === true ? String(cfgNow.mistress?.mid ?? '') : ''
      const autoSend = cfgNow.dm?.autoSend === true
      const todo = []
      const skipped = []
      for (const it of items) {
        if (it.kind !== 'dm') { skipped.push({ id: it.id, why: '评论类草稿要按对方身份判定，请在草稿上手动批准' }); continue }
        const role = mistressMid && String(it.to) === mistressMid ? 'mistress' : 'owner'
        const d = reviewDecision({ kind: 'dm', role, relationship: 'mutual', share: !!it.share, cfg: cfgNow })
        if (d.required) { skipped.push({ id: it.id, why: d.reason }); continue }
        todo.push(it.id)
      }
      const results = []
      const next = (i) => {
        if (i >= todo.length) {
          json(res, 200, { ok: true, autoSend, approved: results.filter((r) => r.ok).length, results, skipped })
          return
        }
        runApproval(todo[i], (r) => { results.push({ id: todo[i], ...r }); next(i + 1) })
      }
      next(0)
    })

    // 批量批准（0.7.0）：一次点「全部批准」，逐条串行（不并发，避免同一个号短时间连发）
    route('exact', '/dsh-bili/api/pending/approve-many', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
      if (!ids.length) { json(res, 400, { ok: false, error: '需要 ids' }); return }
      const results = []
      const next = (i) => {
        if (i >= ids.length) { json(res, 200, { ok: results.every((r) => r.ok || !r.done), results }); return }
        runApproval(ids[i], (r) => { results.push({ id: ids[i], ...r }); next(i + 1) })
      }
      next(0)
    })

    route('exact', '/dsh-bili/api/pending/reject', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      execNode([resolveBiliMjs(), 'reply-draft', 'drop', id], { timeout: 20000 }, (err, stdout) => {
        if (!err) {
          try {
            fs.appendFileSync(path.join(store.DSH_HOME, 'pod-log.jsonl'),
              JSON.stringify({ at: new Date().toISOString(), kind: 'reply-rejected', target: null, note: `主人否掉了草稿 ${id}${b.reason ? '：' + String(b.reason).slice(0, 80) : ''}` }) + '\n')
          } catch { /* ignore */ }
        }
        json(res, 200, { ok: !err, out: String(stdout ?? '').slice(0, 300) })
      })
    })

    route('exact', '/dsh-bili/api/pending/approve', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      runApproval(id, (r) => {
        if (!r.done) { json(res, 409, r); return }
        json(res, 200, r)
      })
    })

    // ── 消息推送测试 ────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/notify-test', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const cfg = readConfig()
      const tools = cfg.toolsPath || path.join(PLUGIN_ROOT, 'tools', 'bili.mjs')
      const notifyMjs = path.join(path.dirname(tools), 'commands', 'notify.mjs')
      if (!fs.existsSync(notifyMjs)) { json(res, 200, { ok: false, error: `找不到 notify.mjs：${notifyMjs}` }); return }
      execNode([notifyMjs, '--test'], { timeout: 60_000 }, (err, stdout, stderr) => {
        json(res, 200, { ok: !err, out: String(stdout ?? '').slice(0, 800), err: String(stderr ?? '').slice(0, 800), type: cfg.notify?.type ?? 'none' })
      })
    })

    // ── 状态（只读）─────────────────────────────────────────────────────────
    const apiStateSafe = () => {
      try { return biliApi.apiState() } catch { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } }
    }

    route('exact', '/dsh-bili/api/status', async (req, res) => {
      const cfg = readConfig()
      const quota = store.readJson(statePath('quota.json'), { log: [] }) ?? { log: [] }
      const today = new Date().toLocaleDateString('sv-SE')
      const todays = (quota.log ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today)
      const night = store.readJson(path.join(store.DSH_HOME, 'pod-night.json'))
      const replied = store.readJson(statePath('replied.json'))
      const sent = store.readJson(SENT_FILE, { items: [] }) ?? { items: [] }
      const dsum = diary.summary(DIARY_ROOT, { kinds: cfg.diary?.records })
      const chain = ledger.verifyChain(WORK_DIR)
      json(res, 200, {
        ok: true, today,
        shares: todays.filter((x) => x.share).length,
        sharesMax: cfg.quota?.shareDaily ?? 3,
        commentsToday: todays.length,
        repliedPeople: Object.keys(replied?.byUid ?? {}).length,
        sentBatches: (sent.items ?? []).length,
        sentVerified: (sent.items ?? []).filter((x) => x.verified === 'visible').length,
        plan: night ? { date: night.date, action: night.action, atText: night.atText ?? null, wakes: Number(night.wakes ?? 0), windows: night.usedWindows ?? [] } : null,
        tide: { mode: cfg.night?.mode ?? 'fixed', text: describeTide(cfg.night?.tide), preview: previewTide(cfg.night) },
        // 2026-10-22：低价时段 / 女主人 / 口味
        cheap: { cheapNow: isCheapNow(cfg), text: describeCheap(cfg), windows: cfg.night?.cheap?.windows ?? [] },
        mistress: (() => {
          const m = cfg.mistress ?? {}
          const mq = store.readJson(statePath('dm-mistress.json'), {})
          return { enabled: m.enabled === true, mid: String(m.mid ?? ''), name: String(m.name ?? ''), title: String(m.title ?? '女主人'), shareDaily: Number(m.shareDaily ?? 1), sentToday: mq.date === today ? Number(mq.count ?? 0) : 0 }
        })(),
        taste: { like: cfg.preferences?.like ?? [], dislike: cfg.preferences?.dislike ?? [], selfAdjust: cfg.preferences?.selfAdjust !== false, learnFromInterest: cfg.preferences?.learnFromInterest !== false },
        diary: { root: DIARY_ROOT, today, kinds: dsum.kinds, lastArchive: dsum.lastArchive, archived: dsum.archived },
        ledger: { enabled: cfg.ledger?.enabled !== false, ok: chain.ok, count: chain.count, broken: chain.broken.length, last: ledger.tail(WORK_DIR, 3).map((r) => ({ day: r.day, name: r.name, title: r.meta.title ?? '', mode: r.meta.mode ?? '' })) },
        scheduler: SCHED_STATUS,
        scope: readScope(WORK_DIR),
        extensions: extensions.status(),
        artifacts: { enabled: cfg.artifacts?.enabled === true, dir: cfg.artifacts?.dir || path.join(WORK_DIR, 'artifacts') },
        // 2026-10-22（上游 v0.4.5）：接口缓存 / 熔断现状（被 412 时最想知道还要等多久）
        pluginVersion: '0.9.0',
        api: apiStateSafe(),
        traffic: (()=>{try{const s=trafficGuard().status();return {settings:riskSettings(),pausedUntil:s.until??null,reason:s.reason??null,manualAccounts:Object.keys(s.manual??{}).length,pending:Object.values(s.operations??{}).filter(o=>['unknown','pending'].includes(o.status)).length,last:s.last??null}}catch(e){return {error:e.message}}})(),
        // 2026-10-22：今天花了多少 token、哪件事最费（只读会话日志，按 mtime 缓存）
        spend: (() => {
          try {
            const rep = spend.report({ date: today, workDir: WORK_DIR })
            return {
              rounds: rep.rounds,
              tokens: rep.usage.totalTokens,
              input: rep.usage.inputTokens,
              cacheRead: rep.usage.cacheReadTokens,
              output: rep.usage.outputTokens,
              yuan: rep.yuan,
              topActivity: rep.byActivity?.[0] ? { label: rep.byActivity[0].activity, tokens: rep.byActivity[0].tokens } : null,
              topTool: rep.byTool[0] ? { label: rep.byTool[0].label, tokens: rep.byTool[0].tokens } : null,
              hostCostCny: rep.cost?.cny ?? null,
            }
          } catch (e) { return { error: e.message } }
        })(),
      })
    })

    // ── 峰谷预览（设置页拖动时实时看）────────────────────────────────────────
    // 「现在叫她起来」：设置页按钮 + 命令行/自动化都能用。人工动作，不受计划时间约束。
    route('exact', '/dsh-bili/api/wake-now', async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!sched) { json(res, 503, { ok: false, reason: '生物钟还没启动' }); return }
      const r = await sched.wakeNow()
      json(res, r.ok ? 200 : 409, r)
    })

    route('exact', '/dsh-bili/api/tide/preview', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const night = b.night ?? readConfig().night
      json(res, 200, { ok: true, preview: previewTide(night), text: describeTide(night?.tide) })
    })

    // ── 账本 ────────────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/ledger', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const n = Math.min(50, Math.max(1, Number(url.searchParams.get('n') ?? 10) || 10))
      const rows = ledger.tail(WORK_DIR, n).map((r) => ({ day: r.day, name: r.name, meta: r.meta, body: r.body }))
      json(res, 200, { ok: true, root: WORK_DIR, rows, chain: ledger.verifyChain(WORK_DIR) })
    })
    route('exact', '/dsh-bili/api/ledger/verify', async (req, res) => {
      const r = ledger.verifyChain(WORK_DIR)
      json(res, 200, { ok: r.ok, ...r })
    })
    route('exact', '/dsh-bili/api/ledger/file', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const name = String(url.searchParams.get('name') ?? '')
      if (!/^\d{4}-\d{2}-\d{2}\/[\w.\-]+\.md$/.test(name)) { json(res, 400, { ok: false, error: '文件名不合法' }); return }
      const file = safeJoin(path.join(WORK_DIR, 'rounds'), name)
      if (!file) { json(res, 400, { ok: false, error: '越界' }); return }
      try { json(res, 200, { ok: true, name, text: fs.readFileSync(file, 'utf8') }) } catch { json(res, 404, { ok: false, error: '没有这份账' }) }
    })

    // ── 开销 ────────────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/spend', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const date = String(url.searchParams.get('date') ?? '') || new Date().toLocaleDateString('sv-SE')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { ok: false, error: '日期格式要 YYYY-MM-DD' }); return }
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'pod'
      try {
        const rep = spend.report({ date, workDir: WORK_DIR, scope })
        json(res, 200, { ok: true, report: rep, lines: spend.reportLines(rep) })
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    })

    // ── 日记 / 记录 ─────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/diary', async (req, res) => {
      const cfg = readConfig()
      const sum = diary.summary(DIARY_ROOT, { kinds: cfg.diary?.records })
      json(res, 200, { ok: true, ...sum })
    })
    route('exact', '/dsh-bili/api/diary/archive', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const cfg = readConfig()
      const keepDays = Math.min(7, Math.max(1, Number((await bodyJson(req)).keepDays ?? 1) || 1))
      const res2 = diary.archiveDue(DIARY_ROOT, { keepDays, kinds: cfg.diary?.records })
      try { await extensions.emit('diary:archived', { results: res2 }) } catch { /* ignore */ }
      json(res, 200, { ok: true, results: res2 })
    })
    route('exact', '/dsh-bili/api/diary/index', async (req, res) => {
      const cfg = readConfig()
      json(res, 200, { ok: true, ...diary.rebuildIndex(DIARY_ROOT, { kinds: cfg.diary?.records }) })
    })
    route('exact', '/dsh-bili/api/diary/recall', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const q = String(url.searchParams.get('q') ?? '')
      const day = String(url.searchParams.get('day') ?? '')
      json(res, 200, { ok: true, hits: diary.recall(DIARY_ROOT, { query: q || undefined, day: day || undefined }) })
    })
    route('exact', '/dsh-bili/api/diary/file', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const rel = String(url.searchParams.get('path') ?? '')
      if (!/^(daily|owner|records|archive)\//.test(rel) || rel.includes('..')) { json(res, 400, { ok: false, error: '路径不合法' }); return }
      const file = safeJoin(DIARY_ROOT, rel)
      if (!file) { json(res, 400, { ok: false, error: '越界' }); return }
      try { json(res, 200, { ok: true, path: rel, text: fs.readFileSync(file, 'utf8') }) } catch { json(res, 404, { ok: false, error: '没有这个文件' }) }
    })

    // ── 手动复核最近发出的评论 ──────────────────────────────────────────────
    route('exact', '/dsh-bili/api/verify', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const r = await verifyRecent({ max: 6, log })
      try { await extensions.emit('verify:done', { checked: r.checked }) } catch { /* ignore */ }
      json(res, 200, { ok: true, ...r })
    })

    // ── 扩展管理 ────────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/extensions', async (req, res) => {
      json(res, 200, { ok: true, dirs: extensions.dirs, list: extensions.status(), fields: extensions.fieldsForClient(), apiVersion: POD_API_VERSION, events: EXT_EVENTS })
    })
    route('exact', '/dsh-bili/api/extensions/reload', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const list = await reloadExtensions()
      json(res, 200, { ok: true, list, dirs: extensions.dirs })
    })
    route('exact', '/dsh-bili/api/extensions/toggle', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      const cfg = readConfig()
      const items = { ...(cfg.extensions?.items ?? {}), [id]: { ...(cfg.extensions?.items?.[id] ?? {}), enabled: b.enabled !== false } }
      writeConfig({ extensions: { items } })
      await reloadExtensions()
      json(res, 200, { ok: true, list: extensions.status() })
    })

    // ── 启动（异步：扩展要先载入，路由也要挂）────────────────────────────────
    async function boot() {
      store.ensureWork()
      // 0.7.0：把基座时期散在 ~/.bili-ai 的运行状态复制进 <workDir>/state（只复制、不删、不覆盖）。
      try {
        const mig = migrateState({ workDir: WORK_DIR, log })
        if (mig?.moved?.length) log(`状态目录迁移：搬了 ${mig.moved.length} 个文件到 ${stateDir(WORK_DIR)}`)
      } catch (e) { log('状态迁移失败（不影响启动，旧文件还留在 ~/.bili-ai）：' + String(e?.message ?? e)) }
      try {
        await extensions.loadAll({ dirs: extDirsFromConfig() })
        if (disposed) return
        mountExtRoutes()
      } catch (e) { log('扩展载入失败：' + String(e?.message ?? e)) }
      if (disposed) return
      try {
        sched = startScheduler(ctx, {
          dshHome: store.DSH_HOME,
          biliMjs: resolveBiliMjs(),
          cwd: cfg => cfg?.cwd ?? WORK_DIR,
          sessionId: 'bili-pod',
          workDir: WORK_DIR,
          diaryRoot: DIARY_ROOT,
          log,
          host: {
            readConfig,
            writeConfig,
            extensions,
            emit: (event, payload) => extensions.emit(event, payload),
            scopeFor,
            writeScope,
            clearScope,
            ledger,
            diary,
            verifyRecent,
          },
        })
        SCHED_STATUS = { ok: true, reason: '已启动（每 60 秒 tick）', at: new Date().toISOString() }
      } catch (e) {
        SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
        log('生物钟启动失败：' + String(e?.message ?? e))
      }
      booted = true
    }
    boot().catch((e) => log('boot 失败：' + String(e?.message ?? e)))

    ctx.effect(() => () => {
      disposed = true
      invalidateLogin()
      try { sched?.stop() } catch { /* ignore */ }
      void extensions.close().catch(e => log('扩展卸载失败：' + e.message))
      while (extDisposers.length) { try { extDisposers.pop()() } catch { /* ignore */ } }
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    })

    log(`设置页已挂载：设置 → 鲸群 · 配置 ${CFG_FILE} · 工作目录 ${WORK_DIR}`)
  },
}

export { SCHED_STATUS }
