/**
 * lib/scope.mjs —— 「这一轮能做什么」的工具白名单（照 dsh-bili-scroll 的 mcpWhitelist 思路）
 * ============================================================================
 * ① 用 MCP 工具白名单来收窄 agent 的能力；基座是 CLI，没有工具白名单这一层。
 * 这里用最轻的方式补齐：每轮唤醒时宿主写一份 `scope.json`，`tools/bili.mjs`
 * 在派发前检查 —— 写命令不在本轮授权里就直接拒绝并说明怎么开。
 *
 * 设计取舍：
 *   · 只读命令永远放行（看视频/读评论/抽字幕本来就该随便看）；
 *   · 写命令按「这一轮为什么会醒」来授权：
 *       醒来刷视频   → comment（若分享开着）/ fav / reply-draft（草稿不是公开动作）
 *       监听别人找她 → comment / reply-draft
 *       私信监听     → comment / dm-await 已在外面，回复走 comment
 *   · 发动态 / 发弹幕 / 删评论 这类「不是为了这一轮目的」的动作默认**不给**，
 *     调用会被拒并提示「主人可以在设置里勾上，或手动跑」。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

/** 只读：永远放行 */
export const READ_CMDS = new Set([
  'session', 'thread', 'check-comment', 'check-dynamic', 'check-mention', 'watch', 'comment-await',
  'comment-digest', 'recon', 'video', 'subtitles', 'watch-video', 'debrief', 'comments', 'feed',
  'quota', 'likes', 'selftest', 'deps', 'diary', 'notify', 'night', 'search', 'covers', 'whois',
  'ledger', 'records', 'verify', 'login', 'extlist', 'tide', 'help',
])

/** 写：要授权 */
export const WRITE_CMDS = new Set(['comment', 'comment-del', 'dm', 'fav', 'dynamic', 'dynamic-image', 'dynamic-edit', 'danmaku', 'reply-draft'])

export const SCOPE_FILE = 'scope.json'

export const scopePath = (workDir) => path.join(workDir, SCOPE_FILE)

/**
 * 给这一轮算白名单。
 * @param {{reason:'wake'|'listen'|'dm'|'live'|'manual', config:object}} o
 */
export function scopeFor({ reason = 'manual', config = {} } = {}) {
  const allow = new Set(['reply-draft'])
  if (config.share?.enabled !== false) allow.add('comment')
  if (reason === 'wake' || reason === 'manual') allow.add('fav')
  if (reason === 'wake' && config.share?.enabled === true && ['dm', 'both'].includes(config.share?.via)) allow.add('dm')
  if (reason === 'dm') { allow.add('comment'); allow.add('dm') }
  if (reason === 'listen' || reason === 'live') allow.add('comment')
  if (config.scope?.allowDynamic === true) { allow.add('dynamic'); allow.add('dynamic-image'); allow.add('dynamic-edit') }
  if (config.scope?.allowDanmaku === true) allow.add('danmaku')
  if (config.scope?.allowDelete === true) allow.add('comment-del')
  if (reason !== 'manual' && config.commentPerRound === 0) allow.delete('comment')
  return {
    active: reason !== 'manual',
    reason,
    at: new Date().toISOString(),
    allowWrite: [...allow],
    note: reason === 'manual' ? '手动轮：不设写操作限制' : '',
  }
}

export function writeScope(workDir, scope) {
  fs.mkdirSync(workDir, { recursive: true })
  const file = scopePath(workDir)
  fs.writeFileSync(file, JSON.stringify(scope, null, 2) + '\n', 'utf8')
  return file
}

export function readScope(workDir) {
  try { return JSON.parse(fs.readFileSync(scopePath(workDir), 'utf8')) } catch { return null }
}

export function clearScope(workDir) {
  try { fs.unlinkSync(scopePath(workDir)) } catch { /* 本来就没有 */ }
}

/**
 * CLI 派发前的检查。
 * @param {object|null} scope
 * @param {string} cmd
 * @param {{now?:number, ttlMs?:number, bypass?:boolean}} [opt]
 * @returns {{ok:true, note?:string} | {ok:false, reason:string}}
 */
export function checkCommand(scope, cmd, opt = {}) {
  if (opt.bypass) return { ok: true, note: 'BILI_POD_SCOPE=off（本轮不限制）' }
  if (!scope || scope.active !== true) return { ok: true }
  const ttl = Number(opt.ttlMs ?? 4 * 3600_000)
  const at = Date.parse(scope.at ?? '')
  if (READ_CMDS.has(cmd)) return { ok: true }
  if (!Number.isFinite(at) || (opt.now ?? Date.now()) - at > ttl) {
    return { ok: false, reason: '自动轮权限单已过期或时间无效；等待宿主重新签发后再执行写操作。' }
  }
  if (!WRITE_CMDS.has(cmd)) return { ok: true } // 不认识的（扩展命令等）不拦
  if ((scope.allowWrite ?? []).includes(cmd)) return { ok: true }
  const allow = (scope.allowWrite ?? []).join(', ') || '（无）'
  return {
    ok: false,
    reason: `这一轮（${scope.reason ?? '自动'}）没有授权「${cmd}」这个写操作。\n` +
      `本轮可用：${allow}\n` +
      `要放开：设置 → 鲸群 → 权限（发动态/弹幕/删评论各有开关）；\n` +
      `或手动在终端跑（手动轮不设限制）；或在命令前设 \`BILI_POD_SCOPE=off\` 显式绕过。`,
  }
}

/** 拼进唤醒提示的那一行（让 agent 提前知道边界，而不是撞了才知道） */
export function scopeLine(scope) {
  if (!scope) return ''
  if (scope.active !== true) return ''
  const allow = (scope.allowWrite ?? []).join(', ') || '（本轮不允许任何写操作）'
  return `\n【本轮权限 · 代码强制】这一轮（${scope.reason}）允许的写操作：${allow}。\n` +
    `比这更"重"的动作（发动态、发弹幕、删评论）在本轮会被 \`bili.mjs\` 直接拒绝 —— 需要就先在设置里勾上。\n`
}
