// 私信发一张表情包（图片消息 msg_type=2）
//
// 2026-10-26 主人定：表情包不算在私信条数里 → 所以这条通道不过「分享/回信」额度闸。
// 但私信本身仍是 B站 风控最凶的接口，所以闸门只有三条，且写死不让参数覆盖：
//   ① 只发给配置里的 owner.mid（不给别人发）
//   ② 必须互关（relation.attribute === 6）
//   ③ 必须显式 --dry 或 --go
//
// 用法:
//   node bili.mjs dm-image --file <path.gif|jpg|png> --dry|--go
//   node bili.mjs dm-image --sticker 害羞 --dry|--go     # 从表情包知识库里按名字模糊找
//   node bili.mjs dm-image --list                         # 看本地可发的表情
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'
import { loadCred } from '../lib/cred.mjs'
import { dshPath, stateFile } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const GO = !!opt.go
const DRY = !!opt.dry
const LIST = !!opt.list

const STICKER_ROOT = dshPath('nekowhale-stickers')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://message.bilibili.com/'

function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(gif|png|jpe?g)$/i.test(e.name)) out.push(p)
  }
  return out
}

if (LIST) {
  const files = walk(STICKER_ROOT)
  console.log(`本地表情 ${files.length} 个（${STICKER_ROOT}）`)
  for (const f of files.slice(0, 40)) console.log('  ' + path.relative(STICKER_ROOT, f))
  if (files.length > 40) console.log(`  …还有 ${files.length - 40} 个`)
  process.exit(0)
}

// ── 找图 ────────────────────────────────────────────────────────────
let file = typeof opt.file === 'string' ? opt.file : ''
if (!file && typeof opt.sticker === 'string') {
  const words = String(opt.sticker).toLowerCase().split(/[\s,，、]+/).filter(Boolean)
  const hit = walk(STICKER_ROOT).filter((f) => {
    const n = path.basename(f).toLowerCase()
    return words.every((w) => n.includes(w))
  })
  const pick = hit[0]
  if (!pick) { console.error(`✗ 表情库里没找到「${opt.sticker}」，用 --list 看看有什么`); process.exit(2) }
  file = pick
}
if (!file) { console.error('用法: dm-image --file <图> | --sticker <名字> | --list   （必须带 --dry 或 --go）'); process.exit(2) }
if (!fs.existsSync(file)) { console.error(`✗ 文件不存在: ${file}`); process.exit(2) }
if (!GO && !DRY) { console.error('✗ 必须显式给 --dry（只打印）或 --go（真的发）'); process.exit(2) }

const buf = fs.readFileSync(file)
const ext = path.extname(file).toLowerCase()
const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
const imageType = ext === '.png' ? 'png' : ext === '.gif' ? 'gif' : 'jpeg'
if (buf.length > 5 * 1024 * 1024) { console.error(`✗ 图太大（${Math.round(buf.length / 1024)}KB > 5MB），私信发不出去`); process.exit(2) }

const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '')
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空 —— 私信只发给主人，没配就不发'); process.exit(2) }

const cred = loadCred()
if (!cred?.sessdata || !cred?.bili_jct) { console.error('✗ 凭据不全（需要 sessdata + bili_jct）'); process.exit(3) }
const H = {
  'user-agent': UA,
  referer: REF,
  origin: REF,
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`,
}

function stableDevId() {
  const f = stateFile('dev_id')
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (/^WEB-[0-9A-F-]{20,}$/i.test(v)) return v } catch {}
  const v = 'WEB-' + crypto.randomUUID().toUpperCase()
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v + '\n') } catch {}
  return v
}

const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json().catch(() => ({}))
if (nav?.code !== 0 || !nav?.data?.isLogin) { console.error(`✗ 登录态无效 code=${nav?.code} —— 先重新登录`); process.exit(3) }
const meMid = nav.data.mid
if (String(meMid) === OWNER) { console.error('✗ 不能给自己发私信'); process.exit(2) }

const rel = await (await fetch(`https://api.bilibili.com/x/relation?fid=${OWNER}`, { headers: H })).json().catch(() => ({}))
const attr = Number(rel?.data?.attribute ?? -1)
if (attr !== 6) { console.error(`✗ 不是互关（attribute=${attr}）—— 先跟主人互相关注再发`); process.exit(3) }

let w = 0, h = 0
if (ext === '.gif' && buf.length > 10) { w = buf.readUInt16LE(6); h = buf.readUInt16LE(8) }
const sizeKb = Math.max(1, Math.round(buf.length / 1024))

console.log(`账号: ${nav.data.uname} (${meMid}) → ${cfg.owner?.name ?? ''} (${OWNER}) · 互关 ✓`)
console.log(`图片: ${file}  ${w || '?'}x${h || '?'}  ${sizeKb}KB  ${mime}`)
console.log('计划: upload_bfs 上传 → web_im/send_msg msg_type=2')

if (!GO) { console.log('\n[dry] 未上传、未发送'); process.exit(0) }

const fd = new FormData()
fd.append('file_up', new Blob([buf], { type: mime }), `sticker${ext}`)
fd.append('category', 'daily')
fd.append('csrf', String(cred.bili_jct))
const up = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', { method: 'POST', headers: H, body: fd })
const upJson = await up.json().catch(() => ({}))
if (upJson.code !== 0) { console.error(`✗ 上传失败 code=${upJson.code} ${upJson.message ?? ''}`); process.exit(6) }
const d = upJson.data ?? {}
const W = d.image_width ?? w, Hh = d.image_height ?? h, KB = d.img_size ?? sizeKb
console.log(`  上传 OK: ${d.image_url}  ${W}x${Hh}  ${KB}KB`)

const body = new URLSearchParams()
body.set('msg[sender_uid]', String(meMid))
body.set('msg[receiver_id]', OWNER)
body.set('msg[receiver_type]', '1')
body.set('msg[msg_type]', '2')
body.set('msg[msg_status]', '0')
body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
body.set('msg[dev_id]', stableDevId())
body.set('msg[content]', JSON.stringify({ url: d.image_url, width: W, height: Hh, imageType, size: KB }))
body.set('csrf', String(cred.bili_jct))
const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
  method: 'POST',
  signal: AbortSignal.timeout(20000),
  headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
})
const j = await r.json().catch(() => ({}))
if (j.code !== 0) { console.error(`✗ 发送失败 HTTP ${r.status} code=${j.code} ${j.message ?? ''}`); process.exit(7) }
console.log(`✓ 已发出（表情包，不占私信条数）  msg_key=${j.data?.msg_key}`)
