/**
 * lib/state-dir.mjs —— 运行状态放哪儿（宿主 / CLI / 测试共用）
 * ============================================================================
 * 为什么要有这一层：她的脚本以前把草稿、配额、收据都写在 `~/.bili-ai/`，
 * 而那是工作目录之外 → DSH 的 workspace-write 沙箱每写一次就问一次「允许吗」。
 * 把**运行状态**搬进 `<workDir>/state/` 之后，cwd 内写入不再触发升级。
 *
 * 什么**不**搬：
 *   · credentials.json —— CLI 自己就得读它；它留在 ~/.bili-ai（仍是同用户进程，不是隔离沙箱）
 *   · persona.md       —— 你在设置页编辑的人设
 *   · 日记（pod-diary）—— 你随时想点开看
 *
 * 迁移策略：只复制、不删除；目标已存在就不覆盖；坏文件明确报错，绝不当空状态用。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

/** 工作目录（与 lib/store.mjs / tools/lib/paths.mjs 同一套解析顺序） */
export function defaultWorkDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const dsh = process.env.DSH_HOME || path.join(home, '.dsh')
  return process.env.BILI_POD_WORK || path.join(dsh, 'pod-work')
}

/** 状态目录；BILI_POD_STATE 可整体覆盖（测试/便携安装）。顺带保证目录存在。 */
export function stateDir(workDir = defaultWorkDir()) {
  const dir = process.env.BILI_POD_STATE || path.join(workDir, 'state')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 只读场景由调用方自己报错 */ }
  return dir
}

/** 状态文件路径（自动建目录由 ensureStateDir 负责） */
export function statePath(name, workDir = defaultWorkDir()) {
  return path.join(stateDir(workDir), name)
}

/** 旧位置（基座时期 ~/.bili-ai）——只用来做一次性迁移 */
export function legacyStateDir() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '.', '.bili-ai')
}

/**
 * 需要搬家的状态文件清单（按用途分组，注释写清）。
 * 顺序稳定 → 迁移标记文件里的 moved 列表可复现。
 */
export const STATE_FILES = [
  // 审核 / 草稿 / 收据
  'pending-replies.json',
  'comment-operations.json',
  'pod-sent.json',
  'pod-verify.json',
  'auto-sent.json',
  // 配额 / 计数
  'quota.json',
  'dm-quota.json',
  'dm-mistress.json',
  'replied.json',
  // 偏好回流
  'feedback.json',
  'silence-seen.json',
  'taste-log.jsonl',
  // 监听 / 等待状态
  'dm-await-state.json',
  'await-state.json',
  // 收藏 / 看过
  'favorites.json',
  'liked-videos.json',
  'commented-videos.md',
  // 设备与体检
  'dev_id',
  'selftest-passed.json',
  // 限流 / 缓存
  'api-cache.json',
  'api-ban.json',
  'api-requests.log',
  // 杂项日志
  'dm-tick-err.log',
]

export function ensureStateDir(workDir) {
  const dir = stateDir(workDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 一次性迁移：把旧目录里的状态文件复制到新目录。
 * - 只复制，原文件保留（出问题能退回）
 * - 目标已存在 → 跳过（不覆盖）
 * - 先写临时文件再 rename，避免半截文件
 * - 全部处理完写 `_migrated.json`（含时间、搬运清单、错误），下次启动照样可重入
 */
export function migrateState({ workDir, legacyDir = legacyStateDir(), files = STATE_FILES, log = () => {} } = {}) {
  const target = ensureStateDir(workDir)
  const marker = path.join(target, '_migrated.json')
  const moved = []
  const skipped = []
  const errors = []
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(marker, 'utf8')) } catch { /* 第一次 */ }
  for (const name of files) {
    const src = path.join(legacyDir, name)
    const dst = path.join(target, name)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dst)) { skipped.push(name); continue }
    try {
      const tmp = `${dst}.${process.pid}.migrating`
      fs.writeFileSync(tmp, fs.readFileSync(src))
      fs.renameSync(tmp, dst)
      moved.push(name)
    } catch (e) {
      errors.push({ name, message: String(e?.message ?? e) })
    }
  }
  const record = {
    at: new Date().toISOString(),
    stateDir: target,
    legacyDir,
    moved: [...new Set([...(previous?.moved ?? []), ...moved])],
    skipped,
    errors,
  }
  try { fs.writeFileSync(marker, JSON.stringify(record, null, 2) + '\n') } catch (e) { errors.push({ name: '_migrated.json', message: String(e?.message ?? e) }) }
  if (moved.length) log(`[state] 已把 ${moved.length} 个状态文件搬进 ${target}（原文件保留在 ${legacyDir}）`)
  if (errors.length) log(`[state] 迁移有 ${errors.length} 个文件失败：${errors.map((e) => e.name).join('、')}`)
  return record
}
