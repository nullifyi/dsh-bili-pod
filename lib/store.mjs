/**
 * lib/store.mjs —— 宿主半边的路径 / 配置读写（工具链也用同一套语义）
 * ============================================================================
 * 为什么单独抽出来：宿主（lib/index.js）、扩展宿主（mods）、测试都要读写同一份
 * 配置和数据目录；散落在各处的 path.join 迟早分叉（基座时期就踩过一次：
 * 宿主写 $DSH_HOME/bili-whale.config.json，工具链却去 $HOME/.dsh 找）。
 *
 * 可被环境变量覆盖（测试 / 便携安装 / 多 profile）：
 *   DSH_HOME            DSH 数据根（默认 ~/.dsh）
 *   BILI_POD_CONFIG     配置文件路径（默认 $DSH_HOME/pod.config.json）
 *   BILI_POD_WORK       工作目录（默认 $DSH_HOME/pod-work）
 *   BILI_POD_DIARY      日记根目录（默认 $DSH_HOME/pod-diary）
 *   BILI_POD_PERSONA    人设源文件（默认 $DSH_HOME/pod-persona.md）
 *   BILI_POD_EXT        用户 mod 目录（逗号分隔，默认 $DSH_HOME/pod-ext）
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeDeep, normalizeConfig } from './defaults.mjs'
import { personaPaths, ensurePersonaSource } from './persona.mjs'

export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
export const dshPath = (...p) => path.join(DSH_HOME, ...p)
export const homePath = (...p) => path.join(HOME, ...p)

export const CFG_FILE = process.env.BILI_POD_CONFIG || dshPath('pod.config.json')
export const LEGACY_CFG_FILE = dshPath('bili-pod.config.json')     // 刚 fork 时的名字
export const BASE_CFG_FILE = dshPath('bili-whale.config.json')     // 基座（可导入）
export const CRED_FILE = homePath('.bili-ai', 'credentials.json')
export const PERSONA_FILE = personaPaths({ dshHome: DSH_HOME, home: HOME }).file
export const LEGACY_PERSONA_FILE = personaPaths({ dshHome: DSH_HOME, home: HOME }).legacyFile
export const WORK_DIR = process.env.BILI_POD_WORK || dshPath('pod-work')
export const DIARY_ROOT = process.env.BILI_POD_DIARY || dshPath('pod-diary')
export const USER_EXT_DIRS = String(process.env.BILI_POD_EXT || dshPath('pod-ext')).split(',').map((s) => s.trim()).filter(Boolean)
/** 随插件发布的内置 mod 目录（由调用方传插件根目录） */
export const builtinExtDir = (pluginRoot) => path.join(pluginRoot, 'extensions')

export const readJson = (file, dflt = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return dflt }
}
export const writeJson = (file, obj, { mode = 0o600 } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode })
  return file
}

/** 读配置：补默认 + 夹紧；顺带做一次「基座配置导入」（只导一次） */
export function readConfigRaw() {
  let raw = readJson(CFG_FILE, null)
  if (!raw) {
    const legacy = readJson(LEGACY_CFG_FILE, null) ?? readJson(BASE_CFG_FILE, null)
    if (legacy) {
      raw = legacy
      try { writeJson(CFG_FILE, normalizeConfig(legacy).config) } catch { /* 写不了就只在内存里用 */ }
    }
  }
  return raw ?? {}
}

export function readConfig() {
  const { config } = normalizeConfig(readConfigRaw())
  return config
}

/**
 * 写配置：深合并 + 归一，落盘。返回 {config, warns, configPath}。
 * @param {object} patch
 */
export function writeConfig(patch = {}) {
  const merged = mergeDeep(normalizeConfig(readConfigRaw()).config, patch ?? {})
  const { config, warns } = normalizeConfig(merged)
  // 注意：night.maxWakesPerDay 由窗口求和推出来（与基座一致）
  if (Array.isArray(config.night?.windows)) {
    config.night.maxWakesPerDay = Math.max(1, config.night.windows.reduce((s, w) => s + (Number(w?.wakes) || 1), 0))
  }
  writeJson(CFG_FILE, config, { mode: 0o600 })
  return { config, warns, configPath: CFG_FILE }
}

/** 工作目录 + 子目录（rounds / ext / artifacts / state） */
export function ensureWork() {
  for (const d of [WORK_DIR, path.join(WORK_DIR, 'rounds'), path.join(WORK_DIR, 'ext'), path.join(WORK_DIR, 'artifacts'), path.join(WORK_DIR, 'state')]) {
    fs.mkdirSync(d, { recursive: true })
  }
  ensurePersonaSource(personaPaths({ dshHome: DSH_HOME, home: HOME, workDir: WORK_DIR }))
  return WORK_DIR
}
