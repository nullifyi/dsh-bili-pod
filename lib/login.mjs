/**
 * lib/login.mjs —— B 站扫码登录（直接用 passport 接口，零第三方依赖）
 * ============================================================================
 * 流程（与 dsh-bili-scroll 的 lib/login.mjs 一致，独立重写、不拷它的 MCP 依赖）：
 *   ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-header
 *        → data.url（二维码内容）+ data.qrcode_key（轮询钥匙）
 *   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *        data.code: 86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *   ③ ⭐ 登录凭证在**轮询响应的 Set-Cookie** 里（不是 data.url；那里只有游戏票）
 *   ④ 落到 ~/.bili-ai/credentials.json（与工具链同一个文件，权限 0600）
 *
 * 注：这里只依赖全局 fetch（Node ≥18 / Electron 主进程都有），不引任何包。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const POLL = (key) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
export const CRED_FILE = path.join(HOME, '.bili-ai', 'credentials.json')

/** Set-Cookie 数组 → 我们要的四个字段 */
export function pickCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 兼容取 Set-Cookie：优先 getSetCookie()，退回合并头手工切分 */
function setCookiesOf(res) {
  const h = res.headers
  if (typeof h.getSetCookie === 'function') {
    const list = h.getSetCookie()
    if (Array.isArray(list) && list.length) return list
  }
  const merged = h.get('set-cookie') || ''
  if (!merged) return []
  // 粗略切分：cookie 之间以逗号 + 非空格(expires 里逗号后跟空格) 分隔
  return merged.split(/,(?=\s*[A-Za-z0-9_-]+=)/).map((s) => s.trim())
}

async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    const v = j?.data?.b_3
    if (v) jar.buvid3 = String(v)
  } catch { /* 拿不到就算了，buvid3 不是写操作必需 */ }
  return jar
}

/** ① 生成二维码。返回 { key, url, created } */
export async function loginStart() {
  const r = await fetch(GEN, { headers: { 'User-Agent': UA, referer: 'https://www.bilibili.com/' } })
  if (!r.ok) throw new Error(`生成二维码失败：HTTP ${r.status}`)
  const j = await r.json()
  const data = j?.data
  if (!data?.qrcode_key || !data?.url) throw new Error(`生成二维码失败：${j?.message || '返回里没有 qrcode_key'}`)
  return { key: data.qrcode_key, url: data.url, created: Date.now() }
}

/**
 * ② 轮询一次。
 * @returns {Promise<{state:'waiting'|'scanned'|'ok'|'expired'|'unknown', code:number, message?:string, credential?:object}>}
 */
export async function loginPoll(key) {
  const res = await fetch(POLL(key), { headers: { 'User-Agent': UA, referer: 'https://www.bilibili.com/' }, redirect: 'manual' })
  const list = setCookiesOf(res)
  let body = {}
  try { body = await res.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(list))
    if (!jar.sessdata) return { state: 'unknown', code, message: '登录成功了，但响应里没有 SESSDATA（记下来排查）' }
    return { state: 'ok', code, credential: jar }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code: Number(code ?? -1), message: body?.message || '' }
}

/** 用凭据查自己是谁（nav 只读） */
export async function fetchSelf(cred) {
  const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}`
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, referer: 'https://www.bilibili.com/', cookie },
  })
  const j = await r.json().catch(() => ({}))
  if (j?.code !== 0 || !j?.data?.isLogin) return null
  return { mid: String(j.data.mid), name: j.data.uname }
}

/**
 * ③ 写凭据文件（合并已有值，diff 只报"有没有"不报内容）。
 * @param {object} cred 至少 sessdata / bili_jct
 * @returns {{file:string, present:string[]}}
 */
export function saveCredential(cred) {
  const clean = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')
  const next = {
    sessdata: clean(cred.sessdata),
    bili_jct: clean(cred.bili_jct),
    buvid3: clean(cred.buvid3),
    dedeuserid: clean(cred.dedeuserid),
  }
  if (!next.sessdata) throw new Error('SESSDATA 为空')
  if (!/^[0-9a-fA-F]{32}$/.test(next.bili_jct)) throw new Error('bili_jct 格式不对（应为 32 位十六进制）')
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true })
  const payload = {}
  for (const [k, v] of Object.entries(next)) if (v) payload[k] = v
  fs.writeFileSync(CRED_FILE, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(CRED_FILE, 0o600) } catch { /* Windows 上多半无效，忽略 */ }
  return { file: CRED_FILE, present: Object.keys(payload) }
}

/** 读凭据（不回显内容） */
export function readCredential() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return {
      sessdata: String(j.sessdata ?? '').trim(),
      bili_jct: String(j.bili_jct ?? '').trim(),
      buvid3: String(j.buvid3 ?? '').trim(),
      dedeuserid: String(j.dedeuserid ?? '').trim(),
    }
  } catch { return null }
}

export const credentialState = () => {
  const c = readCredential()
  return { present: !!c, hasSess: !!c?.sessdata, hasJct: !!c?.bili_jct, hasBuvid: !!c?.buvid3 }
}
