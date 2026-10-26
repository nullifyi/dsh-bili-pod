import { guardedFetch as fetch } from '../lib/traffic.mjs'
// 搜索 B 站视频（WBI 签名 + cookie）。用法: node search.mjs <关键词> [页码]
import fs from 'node:fs'
import path from 'node:path'
import { wbiSigner } from '../lib/wbi.mjs'

import { config } from '../lib/config.mjs'
const args = process.argv.slice(2), positional = [], opts = {}
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
  else positional.push(args[i])
}
const kw = opts.kw ?? positional[0]
const page = Number(opts.page ?? positional[1] ?? 1)
const order = opts.order ?? config().search?.order ?? 'totalrank'
if (typeof kw !== 'string' || !kw.trim() || !Number.isInteger(page) || page < 1 || !['totalrank','click','pubdate','dm','stow','scores'].includes(order) || Object.keys(opts).some(k => !['kw','page','order'].includes(k))) {
  console.error('用法: search <关键词> [正整数页码] [--order totalrank|click|pubdate|dm|stow|scores]'); process.exit(2)
}

const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie }
const jget = async (u) => (await fetch(u, { headers: H })).json()

const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
const wbi = wbiSigner(nav)

const qs = wbi({ search_type: 'video', keyword: kw, page, order })
const d = await jget(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`)
const list = d.data?.result ?? d.data?.results ?? []
console.log(`搜索「${kw}」 page=${page}  code=${d.code} ${d.message ?? ''}  结果数=${list.length}`)
if (d.code !== 0 || !list.length) {
  console.log(`data 的字段: ${Object.keys(d.data ?? {}).join(', ') || '(空)'}`)
  if (!list.length) console.log(JSON.stringify(d).slice(0, 400))
  process.exit(0)
}
for (const [i, r] of list.entries()) {
  const title = String(r.title ?? '').replace(/<[^>]+>/g, '')
  console.log(`\n[${i + 1}] ${title}`)
  console.log(`    BV=${r.bvid}  UP=${r.author}  播放=${r.play}  弹幕=${r.video_review}  时长=${r.duration}  日期=${new Date((r.pubdate ?? 0) * 1000).toLocaleDateString('zh-CN')}`)
  if (r.description) console.log(`    简介: ${String(r.description).replace(/<[^>]+>/g, '').slice(0, 120)}`)
  if (r.tag) console.log(`    标签: ${String(r.tag).replace(/<[^>]+>/g, '').slice(0, 100)}`)
}
