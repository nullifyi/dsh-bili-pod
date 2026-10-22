// 抓视频元信息；仅 artifacts.enabled 时写封面，不启用则只打印封面URL。
//   node fetch-covers.mjs BV1xxx BV2yyy ... [--out 目录]
import fs from 'node:fs'
import path from 'node:path'
import {config} from '../lib/config.mjs'
import {dshPath} from '../lib/paths.mjs'
const args=process.argv.slice(2), bvids=[]
let outDir=dshPath('shots','covers')
for(let i=0;i<args.length;i++) {
  if(args[i]==='--out'&&args[i+1]&&!args[i+1].startsWith('--'))outDir=args[++i]
  else if(/^BV[0-9A-Za-z]+$/.test(args[i]))bvids.push(args[i])
  else {console.error('用法: covers <BV>… [--out 目录]；artifacts.enabled 开启才写封面');process.exit(2)}
}
if(!bvids.length){console.error('用法: covers <BV>… [--out 目录]');process.exit(2)}
const enabled=config().artifacts?.enabled===true
const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }
for (const bv of bvids) {
  try {
    const response=await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H })
    if(!response.ok)throw Error(`view HTTP ${response.status}`)
    const d = await response.json()
    if (d.code !== 0) throw Error(`code=${d.code} ${d.message}`)
    const v = d.data
    let coverInfo=`${v.pic}（产出物已关闭，不下载封面）`
    if(enabled) {
      const img = await fetch(v.pic, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })
      if(!img.ok)throw Error(`封面 HTTP ${img.status}`)
      const bytes=Buffer.from(await img.arrayBuffer())
      fs.mkdirSync(outDir, { recursive: true })
      const cover = path.join(outDir, `${bv}.jpg`)
      fs.writeFileSync(cover,bytes)
      coverInfo=`${cover}  (${(bytes.length / 1024).toFixed(0)} KiB)`
    }
    console.log(`\n===== ${bv} =====`)
    console.log(`标题: ${v.title}`)
    console.log(`UP: ${v.owner?.name} (mid ${v.owner?.mid})   播放=${v.stat?.view} 点赞=${v.stat?.like} 弹幕=${v.stat?.danmaku} 回复=${v.stat?.reply}`)
    console.log(`分区: ${v.tname}   时长=${v.duration}s   发布=${new Date(v.pubdate * 1000).toLocaleString('zh-CN')}`)
    console.log(`封面: ${coverInfo}`)
    console.log(`简介: ${String(v.desc ?? '').slice(0, 400)}`)
  } catch (e) {
    console.error(`${bv}: 失败 ${e.message}`)
    process.exitCode=3
  }
}
