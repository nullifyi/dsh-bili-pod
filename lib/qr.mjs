/**
 * lib/qr.mjs —— 二维码渲染（服务端）
 * ============================================================================
 * 为什么要自己渲染：扫码登录的二维码必须在**设置页里直接看到**，
 * 不能依赖 Python 的 `qrcode`（基座承诺零第三方依赖，用户机器上也没有 venv），
 * 也不能把 URL 甩去第三方二维码服务（登录 URL 不该出本机）。
 *
 * 实现：内置 vendor/qrcode.cjs（qrcode-generator 1.4.4 · MIT · Kazuhiko Arase），
 * 只是把它的模块矩阵转成 SVG / 终端 ASCII，不再有别的依赖。
 * ============================================================================
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/** @type {(typeNumber:number, ec:'L'|'M'|'Q'|'H') => any} */
let QR = null
try {
  QR = require('../vendor/qrcode.cjs')
} catch (e) {
  QR = null
}

export const qrAvailable = () => typeof QR === 'function'

/**
 * 生成模块矩阵。
 * @param {string} text
 * @param {{ec?: 'L'|'M'|'Q'|'H'}} [opt]
 * @returns {boolean[][]} rows[row][col] = true 表示黑块
 */
export function qrMatrix(text, opt = {}) {
  if (!QR) throw new Error('二维码库缺失：vendor/qrcode.cjs 不在（重装插件即可）')
  const ec = opt.ec ?? 'M'
  const code = QR(0, ec) // typeNumber 0 = 自动选最小版本
  code.addData(String(text))
  code.make()
  const n = code.getModuleCount()
  const rows = []
  for (let r = 0; r < n; r += 1) {
    const row = []
    for (let c = 0; c < n; c += 1) row.push(code.isDark(r, c) === true)
    rows.push(row)
  }
  return rows
}

/**
 * 画成一段自包含 SVG（前端直接 innerHTML，无需图片请求）。
 * @param {string} text
 * @param {{margin?: number, scale?: number, dark?: string, light?: string, ec?: string}} [opt]
 */
export function qrSvg(text, opt = {}) {
  const margin = Number.isFinite(opt.margin) ? opt.margin : 3
  const scale = Number.isFinite(opt.scale) ? opt.scale : 6
  const dark = opt.dark ?? '#141414'
  const light = opt.light ?? '#ffffff'
  const m = qrMatrix(text, { ec: /** @type {any} */ (opt.ec ?? 'M') })
  const n = m.length
  const size = (n + margin * 2) * scale
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="登录二维码">`)
  parts.push(`<rect width="${size}" height="${size}" fill="${light}"/>`)
  parts.push(`<path fill="${dark}" d="`)
  let d = ''
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!m[r][c]) continue
      const x = (c + margin) * scale
      const y = (r + margin) * scale
      d += `M${x} ${y}h${scale}v${scale}h${-scale}z`
    }
  }
  parts.push(d + '"/>')
  parts.push('</svg>')
  return parts.join('')
}

/**
 * 画成终端里能直接扫的 ASCII（两个模块一行，用半块字符压扁高度）。
 * @param {string} text
 * @param {{margin?: number}} [opt]
 */
export function qrAscii(text, opt = {}) {
  const margin = Number.isFinite(opt.margin) ? opt.margin : 2
  const m = qrMatrix(text)
  const n = m.length
  const at = (r, c) => (r >= 0 && r < n && c >= 0 && c < n ? m[r][c] : false)
  const lines = []
  for (let r = -margin; r < n + margin; r += 2) {
    let line = ''
    for (let c = -margin; c < n + margin; c += 1) {
      const top = at(r, c)
      const bottom = at(r + 1, c)
      // " ▀▄█"：上黑下白=▀，上白下黑=▄，全黑=█，全白=空格
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
