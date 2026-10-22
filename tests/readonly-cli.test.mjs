import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {READ_CMDS,WRITE_CMDS,checkCommand} from '../lib/scope.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
function sandbox(t,enabled=false) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pod-readonly-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'dsh'),work=path.join(dsh,'work')
  fs.mkdirSync(work,{recursive:true});fs.mkdirSync(path.join(home,'.bili-ai'))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'offline-test-only',bili_jct:'a'.repeat(32),buvid3:'fixture'}))
  const config=path.join(dsh,'pod.config.json')
  fs.writeFileSync(config,JSON.stringify({artifacts:{enabled},extensions:{enabled:false}}))
  fs.writeFileSync(path.join(work,'scope.json'),JSON.stringify({active:true,at:'2000-01-01T00:00:00Z',allowWrite:[]}))
  return {...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_POD_CONFIG:config,BILI_POD_WORK:work,BILI_POD_DIARY:path.join(dsh,'diary'),BILI_POD_EXT:path.join(dsh,'ext'),BILI_POD_SCOPE:'',TEST_REQUESTS:path.join(home,'requests.jsonl'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/readonly-fetch.mjs')).href}
}
function run(env,args) {const r=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),...args],{env,encoding:'utf8',timeout:20000});assert.ifError(r.error);return r}
const requests=env=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
function query(env,pathname) {const found=requests(env).find(r=>new URL(r.url).pathname===pathname);assert.ok(found,'missing '+pathname);return new URL(found.url).searchParams}

// Wrong route/default, lost page/order, or skipped WBI would break these real dispatch calls.
const routes=[
  {args:['popular','--pn','2','--ps','7'],route:'/x/web-interface/popular',want:{pn:'2',ps:'7',web_location:'333.934'},wbi:true},
  {args:['buzzwords','--pn','3','--ps','8'],route:'/x/v2/dm/buzzword/list',want:{pn:'3',ps:'8',type_id:'4'}},
  {args:['weekly'],route:'/x/web-interface/popular/series/list',want:{web_location:'333.934'},wbi:true},
  {args:['weekly','--number','123'],route:'/x/web-interface/popular/series/one',want:{number:'123',web_location:'333.934'},wbi:true},
  {args:['rank','--type','original'],route:'/x/web-interface/ranking/v2',want:{rid:'0',type:'origin'},wbi:true},
  {args:['rank','--type','rookie'],route:'/x/web-interface/ranking/v2',want:{rid:'0',type:'rookie'},wbi:true},
  {args:['rank','--type','technology'],route:'/x/web-interface/ranking/v2',want:{rid:'1012',type:'all'},wbi:true},
  {args:['user-videos','123','--pn','4','--ps','12','--order','stow','--keyword','学习 视频','--tid','7','--w-webid','fixture-id'],route:'/x/space/wbi/arc/search',want:{mid:'123',pn:'4',ps:'12',order:'stow',keyword:'学习 视频',tid:'7',platform:'web',order_avoided:'true',w_webid:'fixture-id'},wbi:true},
  {args:['fav-remote','folders','123'],route:'/x/v3/fav/folder/created/list-all',want:{up_mid:'123',web_location:'333.1387'}},
  {args:['fav-remote','contents','42','--pn','3','--ps','11','--order','view','--keyword','猫'],route:'/x/v3/fav/resource/list',want:{media_id:'42',pn:'3',ps:'11',order:'view',keyword:'猫',type:'0',tid:'0',platform:'web',web_location:'333.1387'}},
]
for(const row of routes) test('actual readonly CLI: '+row.args.join(' '),t=>{
  const env=sandbox(t),r=run(env,[...row.args,'--json'])
  assert.equal(r.status,0,r.stderr+r.stdout)
  assert.equal(JSON.parse(r.stdout).marker,row.route)
  const q=query(env,row.route)
  for(const [key,value] of Object.entries(row.want))assert.equal(q.get(key),value,key)
  if(row.wbi){assert.match(q.get('w_rid'),/^[a-f0-9]{32}$/);assert.match(q.get('wts'),/^\d+$/)}
  assert.equal(requests(env).every(x=>x.method==='GET'),true)
})
test('user-info includes profile, video stats and relationship stats',t=>{
  const env=sandbox(t),r=run(env,['user-info','9007199254740993','--w-webid','fixture-id','--json'])
  assert.equal(r.status,0,r.stderr+r.stdout)
  const out=JSON.parse(r.stdout)
  assert.equal(out.info.marker,'/x/space/wbi/acc/info');assert.equal(out.upstat.marker,'/x/space/upstat');assert.equal(out.relation.marker,'/x/relation/stat')
  assert.equal(query(env,'/x/space/wbi/acc/info').get('mid'),'9007199254740993')
  assert.equal(query(env,'/x/space/wbi/acc/info').get('w_webid'),'fixture-id')
  assert.equal(query(env,'/x/space/upstat').get('mid'),'9007199254740993');assert.equal(query(env,'/x/relation/stat').get('vmid'),'9007199254740993')
})
for(const kind of ['unread','reply','at','like','all'])test('messages '+kind+' reads exact notification endpoints with fake credentials',t=>{
  const env=sandbox(t),r=run(env,['messages',kind,'--json'])
  assert.equal(r.status,0,r.stderr+r.stdout)
  const out=JSON.parse(r.stdout)
  for(const key of kind==='all'?['unread','reply','at','like']:[kind]) {
    assert.equal(out[key].marker,'/x/msgfeed/'+key)
    const call=requests(env).find(x=>new URL(x.url).pathname==='/x/msgfeed/'+key)
    assert.match(call.headers.cookie,/SESSDATA=offline-test-only/)
  }
})
test('readonly commands are explicitly allowed by expired empty scope; help describes actual options',t=>{
  const env=sandbox(t)
  for(const cmd of ['popular','buzzwords','weekly','rank','user-info','user-videos','fav-remote','messages']){
    assert.equal(READ_CMDS.has(cmd),true,cmd);assert.equal(WRITE_CMDS.has(cmd),false,cmd)
    assert.equal(checkCommand({active:true,at:'2000-01-01',allowWrite:[]},cmd).ok,true)
    const r=run(env,[cmd,'--help']);assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/--json/)
  }
  const help=run(env,['buzzwords','--help']);assert.match(help.stdout,/热词图鉴/)
  assert.equal(requests(env).length,0)
})
test('invalid readonly inputs reject before any request; unsupported rank day cannot silently pretend to work',t=>{
  const env=sandbox(t)
  const rows=[['popular','--pn','0'],['popular','--ps','1.5'],['popular','--ps','51'],['buzzwords','--pn','-1'],['weekly','--number','0'],['weekly','--number'],['rank','--type','bad'],['rank','--day','7'],['user-info','oops'],['user-videos','123','--order','bad'],['user-videos','123','--ps','0'],['fav-remote','contents','0'],['fav-remote','contents','42','--order','bad'],['messages','send'],['messages','reply','--pn','2'],['popular','unexpected'],['popular','--json','false']]
  for(const args of rows){const r=run(env,args);assert.equal(r.status,2,args.join(' ')+': '+r.stderr+r.stdout)}
  assert.equal(requests(env).length,0)
})
test('API, HTTP and malformed failures produce nonzero exit with no success JSON',t=>{
  for(const failure of ['TEST_API_FAIL','TEST_HTTP_FAIL','TEST_MALFORMED']){
    const env={...sandbox(t),[failure]:'1'},r=run(env,['popular','--json'])
    assert.notEqual(r.status,0);assert.equal(r.stdout,'');assert.match(r.stderr,/code=-352|HTTP 503|响应/)
  }
})
test('unsupported prototype-shaped option is rejected before any request',t=>{
  const env=sandbox(t),r=run(env,['popular','--__proto__','ignored','--json'])
  assert.equal(r.status,2,r.stderr+r.stdout)
  assert.match(r.stderr,/不支持参数 --__proto__/)
  assert.equal(requests(env).length,0)
})
test('notification reads without credentials fail before network and public popular stays anonymous',t=>{
  const env=sandbox(t);fs.unlinkSync(path.join(env.HOME,'.bili-ai/credentials.json'))
  let r=run(env,['messages','unread','--json']);assert.notEqual(r.status,0);assert.equal(requests(env).length,0)
  r=run(env,['popular','--json']);assert.equal(r.status,0,r.stderr+r.stdout)
})
test('strict fixture blocks unknown network rather than falling through to real fetch',t=>{
  const env=sandbox(t),r=spawnSync(process.execPath,['-e',"await fetch('https://unmatched.invalid/nope')"],{env,encoding:'utf8'})
  assert.notEqual(r.status,0);assert.match(r.stderr,/Network blocked/)
})
for(const enabled of [false,true])test('standalone subtitles respects artifacts.enabled='+enabled,t=>{
  const env=sandbox(t,enabled),out=path.join(env.HOME,'subtitle-output')
  const r=run(env,['subtitles','BV1234567890','--out',out,'--print','1'])
  assert.equal(r.status,0,r.stderr+r.stdout)
  assert.equal(fs.existsSync(out),enabled)
  if(enabled){assert.equal(fs.readdirSync(out).length,3);assert.match(fs.readFileSync(path.join(out,'BV1234567890-zh-CN-plain.txt'),'utf8'),/fixture second subtitle/)}
  else assert.match(r.stdout,/fixture second subtitle/,'disabled output must return the complete subtitle text')
})
for(const enabled of [false,true])test('standalone covers respects artifacts.enabled='+enabled+' and fetches image only when writing',t=>{
  const env=sandbox(t,enabled),out=path.join(env.HOME,'cover-output')
  const r=run(env,['covers','BV1234567890','--out',out])
  assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/fixture title/)
  assert.equal(fs.existsSync(out),enabled)
  assert.equal(requests(env).filter(x=>x.url==='https://fixture.local/cover').length,enabled?1:0)
  if(enabled)assert.equal(fs.readFileSync(path.join(out,'BV1234567890.jpg'),'utf8'),'fixture-cover')
})
test('disabled standalone outputs preserve existing artifacts without touching their content',t=>{
  const env=sandbox(t),out=path.join(env.HOME,'existing');fs.mkdirSync(out)
  const sentinel=path.join(out,'BV1234567890.jpg');fs.writeFileSync(sentinel,'keep')
  const r=run(env,['covers','BV1234567890','--out',out]);assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(fs.readFileSync(sentinel,'utf8'),'keep')
  const sub=path.join(out,'BV1234567890-zh-CN.txt');fs.writeFileSync(sub,'existing subtitles')
  assert.equal(run(env,['subtitles','BV1234567890','--out',out]).status,0);assert.equal(fs.readFileSync(sub,'utf8'),'existing subtitles')
})
