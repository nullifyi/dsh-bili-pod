// 把一张图设成 B站 账号头像
//
// 2026-10-26 主人说"你自己制作一张…当做头像吧" → 这是给这个账号换头像的通道。
//
// 接口是扒 account 设置页 JS 扒出来的（index.9b5e203d.js）：
//   POST https://api.bilibili.com/x/member/web/face/update?csrf=<bili_jct>
//   multipart: face=<图片文件>
// 踩过的坑：
//   · 传 face=<url> 字符串 → 40012 头像格式错误（它要的是文件本体，不是 url）
//   · 先 upload_bfs 再交 url → 那个老路径 /x/member/web/account/face/upload 已经 404
//   · 连着试参数会踩 -702 请求频率过高，探测时每次隔 2-3 秒
//
// 用法:
//   node bili.mjs face-set --file <path.png|jpg|gif> --dry|--go
import fs from 'node:fs'
import path from 'node:path'
import { loadCred } from '../lib/cred.mjs'
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
const file = typeof opt.file === 'string' ? opt.file : ''

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_BYTES = 5 * 1024 * 1024

function fail(msg) { console.error(`✗ ${msg}`); process.exit(2) }

if (!file) fail('用法: face-set --file <图> --dry|--go')
if (!fs.existsSync(file)) fail(`没有这个文件：${file}`)
const buf = fs.readFileSync(file)
if (buf.length > MAX_BYTES) fail(`图太大：${Math.round(buf.length / 1024)}KB（上限 5MB）`)
const ext = path.extname(file).toLowerCase()
const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
if (!['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) fail(`不认识的格式：${ext}`)

const cred = loadCred()
const H = {
  'user-agent': UA,
  referer: 'https://account.bilibili.com/account/home',
  origin: 'https://account.bilibili.com',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`,
}

const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json()
if (nav?.code !== 0) fail(`读不到账号信息：${nav?.code} ${nav?.message ?? ''}`)
const who = `${nav.data.uname} (${nav.data.mid})`
console.log(`账号：${who}`)
console.log(`当前头像：${nav.data.face}`)
console.log(`新图：${file} · ${Math.round(buf.length / 1024)}KB · ${mime}`)
if (!GO) { console.log('[dry] 没有提交，加 --go 才真换'); process.exit(0) }

const fd = new FormData()
fd.append('face', new Blob([buf], { type: mime }), path.basename(file))
fd.append('csrf', cred.bili_jct)
const r = await fetch(`https://api.bilibili.com/x/member/web/face/update?csrf=${cred.bili_jct}`, {
  method: 'POST', headers: H, body: fd,
})
const j = await r.json().catch(() => ({}))
if (j.code !== 0) fail(`换头像失败：${j.code} ${j.message ?? ''}（-702 是频率限制，等十几秒再试）`)

const after = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json()
const face = after?.data?.face
console.log(`✓ 已换头像：${face}`)
if (!face || /noface/.test(face)) console.log('  注意：读回来的还是默认头像，可能要多等一会儿生效')
