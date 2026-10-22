/**
 * lib/zip.mjs —— 够用就好的 ZIP（只用「不压缩」模式）
 * ============================================================================
 * 为什么自己写：插件是零依赖的（README 里那条「不需要安装任何第三方依赖」是红线），
 * 而 Node 标准库没有 zip 写入。存档包里的内容以 JSON / Markdown 为主，
 * 体积本来就不大，用 store（method 0）已经够；换来的是：
 *
 *   - 不依赖系统 tar.exe / 7z / PowerShell Compress-Archive（各平台行为不一致）
 *   - 生成的包任何解压软件都能打开（Windows 资源管理器、macOS 归档工具、unzip）
 *   - 能自己校验 CRC（`bundle inspect` 会逐条验）
 *
 * 读的时候只接受 store 模式；别人用压缩模式重打的包会明确报错，而不是读出乱码。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** 本地时间 -> DOS 时间/日期（ZIP 规范只有这两项，且不存时区） */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear())
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { date, time }
}

/**
 * 写 ZIP。
 * @param {Array<{name:string,data:Buffer|string,mtime?:Date}>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const list = entries
    .map((e) => ({ name: String(e.name).replace(/\\/g, '/'), data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8'), mtime: e.mtime ?? new Date() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const locals = []
  const centrals = []
  let offset = 0
  for (const e of list) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const { date, time } = dosTime(e.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, e.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + e.data.length
  }

  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralDir, eocd])
}

/**
 * 读 ZIP（只支持 store 模式，也就是本模块写出来的包）。
 * @param {Buffer} buf
 * @returns {Array<{name:string,data:Buffer,crc:number,ok:boolean}>}
 */
export function readZip(buf) {
  // 找 EOCD：从尾部往前扫（注释最长 64KB）
  let eocd = -1
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 ZIP 文件（找不到 End of Central Directory）')

  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  if (cdOff + cdSize > buf.length) throw new Error('ZIP 已损坏：中央目录越界')

  const out = []
  let p = cdOff
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`ZIP 已损坏：第 ${i} 条中央目录签名不对`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (method !== 0) throw new Error(`不支持压缩过的条目：${name}（method=${method}）；请用本插件导出的包`)
    if (usize !== csize) throw new Error(`条目大小不一致：${name}`)

    if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`ZIP 已损坏：${name} 的本地头不对`)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataStart, dataStart + usize)
    out.push({ name, data: Buffer.from(data), crc, ok: crc32(data) === crc })

    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 写出到文件（顺便返回字节数） */
export function writeZipFile(file, entries) {
  const buf = writeZip(entries)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return { file, size: buf.length }
}

/** 从文件读 ZIP */
export function readZipFile(file) {
  return readZip(fs.readFileSync(file))
}
