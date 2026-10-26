process.env.BILI_TRAFFIC_TEST='1' // Fake-network fixtures only.
import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import assert from 'node:assert/strict'
const fakeFfmpeg=path.join(process.env.DSH_HOME,'fake-ffmpeg.exe')
fs.writeFileSync(fakeFfmpeg,'fake');process.env.FFMPEG=fakeFfmpeg
cp.execFileSync=(exe,args)=>{
  assert.equal(exe,fakeFfmpeg,'unexpected subprocess')
  const last=args.at(-1)
  if(last==='-')return ''
  fs.writeFileSync(last,'fake-frame')
  if(process.env.TEST_MEDIA_FFMPEG_FAIL)throw Error('fixture extraction failure')
  return ''
}
syncBuiltinESMExports()
globalThis.fetch=async input=>{
  const u=new URL(input), p=u.pathname
  let value
  if(p==='/x/web-interface/nav')value={code:0,data:{wbi_img:{}}}
  else if(p==='/x/web-interface/view')value={code:0,data:{cid:1,aid:2,title:'fake title',duration:30,pubdate:1,owner:{name:'fake'},stat:{},pic:'https://fixture.local/cover'}}
  else if(p==='/x/player/wbi/v2')value={code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://fixture.local/subtitle'}]}}}
  else if(p==='/subtitle')value={body:[{from:0,to:5,content:'fake subtitle'}]}
  else if(p==='/x/v2/reply')value={code:0,data:{replies:[]}}
  else if(p==='/x/player/playurl')value={code:0,data:{quality:64,durl:[{url:'https://fixture.local/video'}]}}
  else if(u.hostname==='comment.bilibili.com')return new Response('<i></i>')
  else if(u.hostname==='fixture.local'&&['/cover','/video'].includes(p))return new Response('fake-media')
  else throw Error('unmatched network '+input)
  return new Response(JSON.stringify(value))
}
