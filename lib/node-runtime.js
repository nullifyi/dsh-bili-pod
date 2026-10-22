/**
 * node 运行时解析（index.js 与 scheduler.js 共用）
 *
 * 2026-10-22（上游 v0.4.5 移植）：不再只看「文件存在」，而是**真的试跑一次**
 * （`probeRuntime` 让候选 node 执行 `-e "writeFileSync(proof, versions.node)"`）。
 * 原因：DSH Desktop 里 process.execPath 是 Electron 主程序，存在、能启动、
 * 但传脚本进去会静默返回空 stdout —— 只查 existsSync 会把这种情况当成功 ✗
 *
 * 解析顺序：$DSH_NODE → $DSH_DESKTOP_NODE_EXECUTABLE → $DSH_HOME/dsh-runtimes/* →
 *          $HOME/.dsh/dsh-runtimes/* → PATH 上的 node → Program Files\nodejs →
 *          （仅非 Electron）当前进程 → （Electron 且能试跑时）ELECTRON_RUN_AS_NODE。
 * 找不到就显式抛错，不静默回退。
 */
import { resolveRuntime } from '../tools/lib/runtime.mjs'

const cache = new Map()

/** 返回 { file, env }（带缓存；同一个 dshHome 只探测一次） */
export function nodeRuntime(dshHome) {
  // 测试钩子：模拟「这台机器上没有可用 node」（集成测试靠它验降级路径）
  if (process.env.TEST_NO_NODE === '1') throw new Error('[bili-pod] 找不到可用的 node 运行时（TEST_NO_NODE）')
  if (!cache.has(dshHome)) cache.set(dshHome, resolveRuntime(dshHome))
  return cache.get(dshHome)
}

/** 兼容旧调用：只要可执行文件路径 */
export function resolveNodeRuntime(dshHome) {
  try {
    return nodeRuntime(dshHome).file
  } catch (e) {
    throw new Error('[bili-pod] ' + String(e.message).replace(/^\[bili-whale\]\s*/, ''))
  }
}

/** 执行脚本时该带的环境变量（Electron 回退时含 ELECTRON_RUN_AS_NODE=1） */
export const nodeEnv = (dshHome) => nodeRuntime(dshHome).env
