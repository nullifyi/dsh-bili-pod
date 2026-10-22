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
import { claimDraft, settleDraft, readOperation, finishSend } from './comment-state.mjs'
import { PodHost, POD_API_VERSION, EXT_EVENTS } from './extensions.mjs'
import { scopeFor, writeScope, readScope, clearScope, READ_CMDS, WRITE_CMDS } from './scope.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')
const CFG_FILE = store.CFG_FILE
const CRED_FILE = store.CRED_FILE
const PERSONA_FILE = store.PERSONA_FILE
const PENDING = path.join(store.HOME, '.bili-ai', 'pending-replies.json')
const DIARY_ROOT = store.DIARY_ROOT
const WORK_DIR = store.WORK_DIR

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
    const readConfig = () => store.readConfig()
    const writeConfig = (patch) => store.writeConfig(patch)

    // ── 安全栅栏（原样保留基座的 fail-closed 实现）────────────────────────────
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    function rejected(req, res, { strict = true } = {}) {
      if (isLoopbackReq(req) === false) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return true }
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
    const KNOWN_KEYS = new Set(['reportLevel', 'commentPerRound', 'replyPerRound', 'replyToComments', 'favFolderId', 'search', 'persona', 'preferences', 'mistress', 'notify', 'aliases', 'owner', 'self', 'quota', 'share', 'listen', 'diary', 'night', 'review', 'ledger', 'artifacts', 'extensions', 'scope', 'toolsPath'])

    route('exact', '/dsh-bili/api/settings', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readConfig()
        let personaBytes = 0
        let personaUpdatedAt = null
        try { const st = fs.statSync(PERSONA_FILE); personaBytes = st.size; personaUpdatedAt = st.mtime.toISOString() } catch { /* 没写过 */ }
        json(res, 200, {
          ok: true,
          config: cfg,
          credentials: credentialState(),
          configPath: CFG_FILE,
          workDir: WORK_DIR,
          diaryRoot: DIARY_ROOT,
          persona: { bytes: personaBytes, updatedAt: personaUpdatedAt },
          tide: { preview: previewTide(cfg.night), text: describeTide(cfg.night?.tide) },
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
        const r = await loginPoll(key)
        if (!current()) { expired(); return }
        if (r.state === 'ok' && r.credential) {
          const self = await fetchSelf(r.credential)
          if (!current()) { expired(); return }
          const saved = saveCredential(r.credential)
          if (self) writeConfig({ self })
          loginSessions.delete(key)
          try { await extensions.emit('login:ok', { self }) } catch { /* ignore */ }
          json(res, 200, {
            ok: true, state: 'ok', self,
            detail: self ? `✓ 登录成功：${self.name}（mid ${self.mid}）` : '✓ 登录成功（但没查到昵称）',
            saved: saved.present,
          })
          return
        }
        if (r.state === 'expired') {
          loginSessions.delete(key)
          json(res, 200, { ok: true, state: 'expired', detail: '二维码过期了 —— 点「重新生成」再来一次' })
          return
        }
        json(res, 200, { ok: true, state: r.state, code: r.code, detail: r.state === 'scanned' ? '已扫描，请在手机上点确认' : '等你扫码…' })
      } catch (e) {
        json(res, 200, { ok: false, state: 'error', error: `轮询失败：${String(e?.message ?? e)}` })
      }
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
      if (buvid3 && !/^[0-9A-Fa-f-]{20,}$/.test(buvid3)) problems.push('buvid3 格式不像（可留空）')
      if (problems.length) {
        json(res, 400, { ok: false, error: '凭据有问题，没写入：\n  · ' + problems.join('\n  · ') + '\n\n建议直接用上面的「扫码登录」✓' })
        return
      }
      try {
        const generation = invalidateLogin()
        saveCredential({ sessdata, bili_jct, buvid3 })
        const self = await fetchSelf({ sessdata, bili_jct, buvid3 })
        if (!disposed && generation === loginGeneration && self) writeConfig({ self })
        json(res, 200, {
          ok: true, self,
          detail: self ? `已写入 ✓ 当前登录：${self.name}（mid ${self.mid}）` : '已写入，但 B站 不认这个 cookie —— 建议改用扫码登录',
        })
      } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); return }
    })

    // ── 人设 ────────────────────────────────────────────────────────────────
    route('exact', '/dsh-bili/api/persona', async (req, res) => {
      if (req.method === 'GET') {
        let text = ''
        try { text = fs.readFileSync(PERSONA_FILE, 'utf8') } catch { /* 没写过 */ }
        let updatedAt = null
        try { updatedAt = fs.statSync(PERSONA_FILE).mtime.toISOString() } catch { /* ignore */ }
        json(res, 200, { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), updatedAt })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = await bodyJson(req)
      const text = String(b.text ?? '')
      if (text.length > 20000) { json(res, 400, { ok: false, error: '太长（上限 20000 字），人设不用写论文' }); return }
      try {
        fs.mkdirSync(path.dirname(PERSONA_FILE), { recursive: true })
        fs.writeFileSync(PERSONA_FILE, text, 'utf8')
        try { fs.chmodSync(PERSONA_FILE, 0o600) } catch { /* Windows 上无效 */ }
      } catch (e) { json(res, 500, { ok: false, error: '写入失败：' + String(e?.message ?? e) }); return }
      const bytes = Buffer.byteLength(text, 'utf8')
      json(res, 200, { ok: true, bytes, detail: text.trim() ? `✓ 已保存（${bytes} 字节）—— 从下一次唤醒开始生效` : '✓ 已清空 —— 她回到「设置里的人设」那几行' })
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
          try { selftestPassed = fs.existsSync(path.join(store.HOME, '.bili-ai', 'selftest-passed.json')) } catch { /* ignore */ }
          json(res, 200, { ok: !!parsed.ok, items: parsed.items ?? [], node: parsed.node, self: selfNow, selftestPassed, scheduler: SCHED_STATUS })
        } catch {
          json(res, 200, { ok: false, error: String(stderr || err?.message || 'deps 跑失败').slice(0, 300), items: [] })
        }
      })
    })

    // ── 待审回复（review.preReview 由调度器决定草稿还是直发；这里是人工队列）────
    route('exact', '/dsh-bili/api/pending', async (req, res) => {
      let items = []
      try { items = JSON.parse(fs.readFileSync(PENDING, 'utf8')).items ?? [] } catch { /* 没有队列 */ }
      json(res, 200, { ok: true, items, preReview: readConfig().review?.preReview !== false })
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
      const claim = claimDraft(id)
      if (!claim) { json(res, 409, { ok: false, status: 'uncertain', error: '草稿不存在、正在发送或结果不明；请先人工核对' }); return }
      const { item, token, operationId } = claim
      const cfgNow = readConfig()
      const args = item.kind === 'dm' ? ['dm', '--to', item.to, '--msg', item.message, '--approval', token, '--operation-id', operationId, '--go'] : ['comment', '--oid', String(item.oid), '--type', String(item.type ?? '1'),
        '--root', String(item.root), '--parent', String(item.parent || item.root),
        '--message', item.message, '--auto', '--approval', token, '--operation-id', operationId,
        ...(cfgNow.listen?.oncePerPerson !== false ? ['--once-per-person'] : []),
        ...(cfgNow.review?.verify !== false ? ['--verify'] : []), '--go']
      if (item.kind !== 'dm' && item.bvid) args.push('--bvid', item.bvid)
      if (item.kind !== 'dm' && item.referer) args.push('--referer', item.referer)
      execNode([resolveBiliMjs(), ...args], { timeout: 120000, env: { ...process.env, BILI_POD_SCOPE: 'off' } }, (err, stdout, stderr) => {
        const text = String(stdout ?? '')
        const saved = readOperation(operationId)
        const receipt = /code=0(?:\s|$)/.test(text) ? (text.match(/已发布，评论 rpid=(\d+)/) ?? [])[1] : null
        const status = saved?.status === 'accepted' || receipt ? 'accepted'
          : saved?.status === 'rejected' || /code=-?\d+/.test(text) && !/code=0(?:\s|$)/.test(text) ? 'rejected'
          : saved?.status === 'approved' ? 'rejected' : 'uncertain'
        const rpid = saved?.rpid || receipt || null
        finishSend(operationId, status, { ...(rpid ? { rpid } : {}), reason: status === 'uncertain' ? '子进程没有可靠收据；请人工核对，勿重发' : '' })
        settleDraft(id, operationId, status)
        try {
          fs.appendFileSync(path.join(store.DSH_HOME, 'pod-log.jsonl'), JSON.stringify({
            at: new Date().toISOString(), kind: 'reply-' + status, operationId,
            target: item.who || item.parent, note: String(item.message).slice(0, 60),
          }) + '\n')
        } catch { /* operation state remains the authoritative receipt */ }
        json(res, 200, { ok: status === 'accepted', status, operationId, rpid, out: text.slice(-800), err: String(stderr ?? err?.message ?? '').slice(0, 400) })
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
      const quota = store.readJson(path.join(store.HOME, '.bili-ai', 'quota.json'), { log: [] }) ?? { log: [] }
      const today = new Date().toLocaleDateString('sv-SE')
      const todays = (quota.log ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today)
      const night = store.readJson(path.join(store.DSH_HOME, 'pod-night.json'))
      const replied = store.readJson(path.join(store.HOME, '.bili-ai', 'replied.json'))
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
          const mq = store.readJson(path.join(store.HOME, '.bili-ai', 'dm-mistress.json'), {})
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
        api: apiStateSafe(),
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
              topKind: rep.byKind[0] ? { label: rep.byKind[0].kindLabel, tokens: rep.byKind[0].tokens } : null,
              topTool: rep.byTool[0] ? { label: rep.byTool[0].label, tokens: rep.byTool[0].tokens } : null,
              hostCostCny: rep.cost?.cny ?? null,
            }
          } catch (e) { return { error: e.message } }
        })(),
      })
    })

    // ── 峰谷预览（设置页拖动时实时看）────────────────────────────────────────
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
