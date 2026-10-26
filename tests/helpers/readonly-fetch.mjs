process.env.BILI_TRAFFIC_TEST='1' // Fake-network fixtures only.
// Offline boundary for real CLI subprocesses: exact hosts/routes only, no network fallback.
import fs from 'node:fs'
import path from 'node:path'
import {syncBuiltinESMExports} from 'node:module'

const home = path.resolve(process.env.HOME)
for (const method of ['mkdirSync', 'writeFileSync']) {
  const original = fs[method]
  fs[method] = (target, ...args) => {
    const relative = path.relative(home, path.resolve(String(target)))
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Fixture blocked output outside fake HOME: ' + target)
    return original(target, ...args)
  }
}
syncBuiltinESMExports()
const allowed = new Set([
  '/x/web-interface/popular', '/x/web-interface/popular/series/list', '/x/web-interface/popular/series/one',
  '/x/web-interface/ranking/v2', '/x/v2/dm/buzzword/list', '/x/space/wbi/acc/info',
  '/x/space/upstat', '/x/relation/stat', '/x/space/wbi/arc/search',
  '/x/v3/fav/folder/created/list-all', '/x/v3/fav/resource/list',
  '/x/msgfeed/unread', '/x/msgfeed/reply', '/x/msgfeed/at', '/x/msgfeed/like',
])
globalThis.fetch = async (input, options = {}) => {
  const u = new URL(input), method = options.method ?? 'GET'
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({url:u.href,method,headers:options.headers})+'\n')
  if (method !== 'GET') throw Error('Network blocked: non-GET ' + method)
  let value
  if (u.origin === 'https://api.bilibili.com') {
    if (u.pathname === '/x/web-interface/nav') value = {code:0,data:{wbi_img:{img_url:'https://fixture.local/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://fixture.local/abcdefghijklmnopqrstuvwxyz012345.png'}}}
    else if (u.pathname === '/x/web-interface/view' || u.pathname === '/x/web-interface/wbi/view') value = {code:0,data:{bvid:'BV1234567890',aid:2,cid:1,title:'fixture title',owner:{name:'fixture',mid:1},duration:30,pic:'https://fixture.local/cover',stat:{},pubdate:1}}
    else if (u.pathname === '/x/player/wbi/v2') value = {code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://fixture.local/subtitle'}]}}}
    else if (allowed.has(u.pathname)) {
      if (process.env.TEST_API_FAIL) value = {code:-352,message:'fixture rejected'}
      else value = {code:0,data:{marker:u.pathname,list:[{id:9,title:'fixture result'}],items:[],cursor:{is_end:true}}}
    } else throw Error('Network blocked: ' + u.href)
  } else if (u.origin === 'https://fixture.local' && u.pathname === '/subtitle') {
    value = {body:[{from:0,to:5,content:'fixture first subtitle'},{from:5,to:8,content:'fixture second subtitle'}]}
  } else if (u.origin === 'https://fixture.local' && u.pathname === '/cover') {
    return new Response('fixture-cover')
  } else throw Error('Network blocked: ' + u.href)
  if (process.env.TEST_HTTP_FAIL && allowed.has(u.pathname)) return new Response('unavailable',{status:503})
  if (process.env.TEST_MALFORMED && allowed.has(u.pathname)) return new Response(JSON.stringify({data:{}}))
  return new Response(JSON.stringify(value))
}
