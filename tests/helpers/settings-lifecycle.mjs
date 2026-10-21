import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {Readable} from 'node:stream'
const scenario=process.argv[2], flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const timers=[]
globalThis.setInterval=globalThis.setTimeout=fn=>{const t={fn};timers.push(t);return t}
globalThis.clearInterval=globalThis.clearTimeout=t=>{if(t)t.cleared=true}
if(scenario==='client') {
  let api,states=[],saved=0,requests=[]
  const window={__ModuleLoader__:{load({factory}){api=factory(()=>({}))}}}
  vm.runInNewContext(fs.readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),{window,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,AbortController,console})
  let pending=deferred()
  const flow=api.createLoginFlow({request:async(url)=>{requests.push(url);if(url.includes('/cancel'))return {ok:true};return pending.promise},update:s=>states.push(s),onSaved:()=>saved++})
  const firstQR=pending,firstStart=flow.start();pending=deferred();const secondStart=flow.start()
  pending.resolve({ok:true,key:'newer',svg:'newer'});await secondStart;firstQR.resolve({ok:true,key:'stale',svg:'stale'});await firstStart
  assert.equal(states.at(-1).qr.key,'newer');flow.cancel()
  pending=deferred()
  const old=flow.start();flow.cancel();pending.resolve({ok:true,key:'old',svg:'old'});await old
  assert.equal(states.at(-1).state,'');assert.equal(timers.filter(t=>!t.cleared).length,0)
  pending=deferred();const live=flow.start();pending.resolve({ok:true,key:'live'});await live
  pending=deferred();const poll=timers.find(t=>!t.cleared);assert.ok(poll);const work=poll.fn();flow.cancel();pending.resolve({ok:true,state:'ok'});await work
  assert.equal(saved,0);assert.equal(states.at(-1).state,'')
  pending=deferred();const next=flow.start();flow.dispose();pending.resolve({ok:true,key:'after-unmount'});await next
  assert.equal(timers.filter(t=>!t.cleared).length,0);assert.ok(requests.some(x=>x.includes('/cancel')))
  process.exit(0)
}
let generation=0, blockedGen,blockedPoll, pollCode=86101
globalThis.fetch=async url=>{
  const u=String(url)
  if(u.includes('/qrcode/generate')) {
    const id=++generation;if(blockedGen){const p=blockedGen;blockedGen=null;await p.promise}
    return {ok:true,json:async()=>({data:{qrcode_key:'key'+id,url:'https://fake-login/'+id}})}
  }
  if(u.includes('/qrcode/poll')) {
    const code=pollCode;if(blockedPoll){const p=blockedPoll;blockedPoll=null;await p.promise}
    return {headers:{getSetCookie:()=>['SESSDATA=qr-session-test-only','bili_jct='+'b'.repeat(32),'buvid3=fake']},json:async()=>({data:{code}})}
  }
  if(u.includes('/nav'))return {json:async()=>({code:0,data:{isLogin:true,mid:111,uname:'offline'}})}
  throw Error('Unexpected network: '+u)
}
const routes=new Map();let cleanup
const {default:plugin}=await import('../../lib/index.js')
plugin.apply({get:()=>({requestRejection:()=>null}),webServer:{register(r){routes.set(r.path,r.handler);return()=>routes.delete(r.path)}},effect:f=>{cleanup=f()}})
function req(endpoint,body={},method='GET') {
  const full='/dsh-bili/api/'+endpoint,pathname=full.split('?')[0],handler=routes.get(pathname)
  if(!handler)throw Error('Route missing: '+pathname)
  const request=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(request,{method,url:full,headers:{host:'127.0.0.1'}})
  return new Promise((resolve,reject)=>handler(request,{statusCode:200,writeHead(n){this.statusCode=n},end(t){resolve({status:this.statusCode,data:JSON.parse(t)})}}).catch(reject))
}
const {loadCred}=await import('../../tools/lib/cred.mjs')
const original=loadCred().sessdata
if(scenario==='store-migration'||scenario==='store-import') {
  const store=await import('../../lib/store.mjs')
  if(scenario==='store-migration') {
    fs.writeFileSync(store.CFG_FILE,JSON.stringify({listen:{comment:true}}))
    assert.equal(store.readConfig().replyToComments,true)
    store.writeConfig({self:{mid:'111'}})
    assert.equal(store.readConfig().replyToComments,true,'partial save must preserve legacy opt-in')
    store.writeConfig({replyToComments:false})
    store.writeConfig({self:{mid:'112'}})
    assert.equal(store.readConfig().replyToComments,false,'explicit new false must persist')
  } else {
    for(const legacy of [store.LEGACY_CFG_FILE,store.BASE_CFG_FILE]) {
      fs.rmSync(store.CFG_FILE)
      fs.writeFileSync(legacy,JSON.stringify({listen:{comment:true}}))
      assert.equal(store.readConfig().replyToComments,true,'first legacy import')
      assert.equal(store.readConfig().replyToComments,true,'persisted legacy import')
      fs.rmSync(legacy)
    }
  }
} else if(scenario.startsWith('client-')) {
  let api;const states=[]
  const window={__ModuleLoader__:{load({factory}){api=factory(()=>({}))}}}
  vm.runInNewContext(fs.readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),{window,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,AbortController,console})
  let delayCancel=false,delayGenerate=false
  const cancels=[],generates=[]
  const flow=api.createLoginFlow({request:async(url,opts={})=>{
    const send=async()=> (await req(url.split('/api/')[1],opts.body?JSON.parse(opts.body):{},opts.method||'GET')).data
    if(url.includes('/cancel')&&delayCancel){const gate=deferred();cancels.push({gate,send});await gate.promise}
    if(url.includes('/qr')&&delayGenerate){const gate=deferred();generates.push({gate,send});await gate.promise}
    return send()
  },update:s=>states.push(s)})
  if(scenario==='client-late-cancel') {
    await flow.start();delayCancel=true;await flow.start()
    assert.equal(cancels.length,1);cancels[0].gate.resolve();await flush()
    assert.equal((await req('login/cancel',{},'POST')).status,400,'unscoped cancel must not invalidate active QR')
    const poll=timers.filter(t=>!t.cleared).at(-1);await poll.fn()
    assert.equal(states.at(-1).state,'waiting','old cancel must not expire new QR')
  } else if(scenario==='client-generating-cancel') {
    const hold=blockedGen=deferred(),start=flow.start();await flush();flow.cancel();await flush();hold.resolve();await start
    assert.equal(states.at(-1).state,'')
    assert.equal((await req('login/poll?key=key1')).data.state,'expired','cancel during generation must invalidate host session')
  } else {
    delayGenerate=true;const start=flow.start();await flush();flow.cancel();await flush()
    assert.equal(generates.length,1);delayGenerate=false;await flow.start();generates[0].gate.resolve();await start
    assert.equal(generation,1,'cancelled generation must not reach loginStart')
    assert.equal((await req('login/poll?key=key1')).data.state,'waiting','late old generation must not invalidate new QR')
  }
  flow.dispose()
} else if(scenario==='settings') {
  const saved=await req('settings',{reportLevel:'brief',commentPerRound:0,replyPerRound:4,replyToComments:true,favFolderId:'42',search:{order:'pubdate'},share:{via:'both'}},'POST')
  assert.equal(saved.data.config.reportLevel,'brief');assert.equal(saved.data.config.commentPerRound,0);assert.equal(saved.data.config.replyPerRound,4);assert.equal(saved.data.config.replyToComments,true);assert.equal(saved.data.config.search.order,'pubdate');assert.equal(saved.data.config.favFolderId,'42')
  assert.equal((await req('settings')).data.config.share.via,'both')
  await req('settings',{listen:{comment:true},replyToComments:false},'POST')
  assert.equal((await req('settings')).data.config.replyToComments,false)
} else if(['prompts','notifications'].includes(scenario)) {
  cleanup()
  const {normalizeConfig}=await import('../../lib/defaults.mjs'), {wakePrompt,startScheduler}=await import('../../lib/scheduler.js')
  const cfg=normalizeConfig({reportLevel:'off',commentPerRound:0,replyPerRound:3,replyToComments:true,listen:{comment:true,allDay:true,scope:'both'},diary:{push:true}}).config
  if(scenario==='prompts') {
    const text=wakePrompt({st:{date:'2026-10-22',atMs:1},cfg,today:'2026-10-22'})
    assert.match(text,/每轮最多 0 条评论/);assert.match(text,/每轮最多回复 3 条/);assert.match(text,/reportLevel=off/);assert.match(text,/日记/);assert.match(text,/ledger write/);assert.doesNotMatch(text,/9\) 用 .*notify/)
    const brief=wakePrompt({st:{date:'2026-10-22'},cfg:{...cfg,reportLevel:'brief'},today:'2026-10-22'});assert.match(brief,/每条一两行/)
  } else {
    fs.writeFileSync(path.join(process.env.DSH_HOME,'pod-listen.json'),JSON.stringify({lastSeen:1}))
    globalThis.fetch=async u=>({json:async()=>({code:0,data:{items:[{id:1,reply_time:2,user:{mid:'333',nickname:'Direct'},item:{subject_id:'1',root_id:'10',source_id:'11',target_id:'9'}},{id:2,reply_time:3,user:{mid:'444',nickname:'Indirect'},item:{subject_id:'1',root_id:'10',source_id:'12',target_id:'88'}}]}})})
    fs.writeFileSync(path.join(process.env.USERPROFILE,'.bili-ai/pod-sent.json'),JSON.stringify({items:[{rpid:'9',oid:'1'}]}))
    const prompts=[], s=await import('../../lib/scope.mjs')
    const sched=startScheduler({sessionController:{create:async()=>({sessionId:'test'}),prompt:async p=>{prompts.push(p.content[0].text);return {accepted:true}}}},{dshHome:process.env.DSH_HOME,biliMjs:path.resolve('tools/bili.mjs'),workDir:process.env.BILI_POD_WORK,diaryRoot:process.env.BILI_POD_DIARY,host:{readConfig:()=>cfg,scopeFor:s.scopeFor,writeScope:s.writeScope}})
    await sched.listenTick();sched.stop();assert.equal(prompts.length,1);assert.match(prompts[0],/Direct/);assert.doesNotMatch(prompts[0],/Indirect/);assert.match(prompts[0],/每轮最多回复 3 条/);assert.match(prompts[0],/reply-draft/)
  }
} else if(scenario==='states') {
  const qr=await req('login/qr');assert.equal(qr.data.ok,true,JSON.stringify(qr));const key=qr.data.key
  assert.equal((await req('login/poll?key='+key)).data.state,'waiting');pollCode=86090;assert.equal((await req('login/poll?key='+key)).data.state,'scanned')
  pollCode=0;const ok=await req('login/poll?key='+key);assert.equal(ok.data.state,'ok');assert.equal(loadCred().sessdata,'qr-session-test-only');assert.doesNotMatch(JSON.stringify(ok),/qr-session-test-only|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/)
  assert.equal((await req('login/poll?key=unissued')).data.state,'expired')
} else if(scenario==='generate-order') {
  const hold=blockedGen=deferred(),old=req('login/qr');await flush();const current=await req('login/qr');hold.resolve();const stale=await old
  assert.equal(stale.data.ok,false);assert.equal((await req('login/poll?key='+stale.data.key)).data.state,'expired');assert.equal((await req('login/poll?key='+current.data.key)).data.state,'waiting')
} else {
  const qr=await req('login/qr');assert.equal(qr.data.ok,true)
  pollCode=0;const hold=blockedPoll=deferred(), old=req('login/poll?key='+qr.data.key);await flush()
  if(scenario==='cancel')assert.equal((await req('login/cancel',{requestId:qr.data.requestId},'POST')).data.ok,true)
  else if(scenario==='regenerate')await req('login/qr')
  else if(scenario==='manual')await req('cookie',{sessdata:'manual-saved-credential-only',bili_jct:'c'.repeat(32)},'POST')
  else if(scenario==='expired'){pollCode=86038;assert.equal((await req('login/poll?key='+qr.data.key)).data.state,'expired')}
  else if(scenario==='unload')cleanup()
  hold.resolve();assert.equal((await old).data.state,'expired');assert.equal(loadCred().sessdata,scenario==='manual'?'manual-saved-credential-only':original)
}
cleanup()
