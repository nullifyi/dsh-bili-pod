// 统一配置层 —— 工具链这边只做「缓存 + 兼容旧导出」。
//
// 真正的合并 / 归一 / 夹紧在 lib/defaults.mjs + lib/store.mjs（宿主与工具链共用一份）。
// 这里保留 `config()` 这个名字，是因为 tools/ 下几十个脚本都是这样用的。
//
// 顺带补两个基座时期的坑：
//   · 配置文件名从 bili-pod.config.json 改成 pod.config.json（旧文件首次启动自动导入）
//   · 默认值以前有两套（lib/index.js 与 tools/lib/config.mjs 各写一份，新字段总是漏一边）
import fs from 'node:fs'
import { DEFAULTS as SHARED_DEFAULTS } from '../../lib/defaults.mjs'
import { readConfig, CFG_FILE } from '../../lib/store.mjs'

export { DEFAULTS as SHARED, CFG_FILE }
export const configPath = CFG_FILE
export const DEFAULTS = SHARED_DEFAULTS

let cache = null

/** 读取合并后的配置（带缓存，一次进程内只读一次） */
export function config() {
  if (cache) return cache
  cache = { ...readConfig() }
  try { cache.__hasUserFile = fs.existsSync(CFG_FILE) } catch { cache.__hasUserFile = false }
  return cache
}

/** 改完配置后让缓存失效（同进程内再读一次） */
export function invalidateConfig() { cache = null }

export default config
