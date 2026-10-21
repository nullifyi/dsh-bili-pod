import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {Readable} from 'node:stream'
import assert from 'node:assert/strict'
globalThis.setInterval=()=>({});globalThis.setTimeout=()=>({});globalThis.clearInterval=()=>{};globalThis.clearTimeout=()=>{}
cp.execFile=(exe,args,options,cb)=>{
  if(args.includes('comment')) {
    const success=process.env.TEST_SEND_SUCCESS==='1'
    queueMicrotask(()=>cb(success?null:new Error('mock send failure'),success?'code=0\n已发布，评论 rpid=123':'code=-101',''))
  } else {
    assert.ok(args.includes('take')||args.includes('add'))
    const r=cp.spawnSync(exe,args,{...options,encoding:'utf8'})
    queueMicrotask(()=>cb(r.status?new Error(r.stderr):null,r.stdout,r.stderr))
  }
  return {kill(){}}
}
syncBuiltinESMExports()
const {default:plugin}=await import('../../lib/index.js')
const routes=new Map()
plugin.apply({get:()=>({requestRejection:()=>null}),webServer:{register(r){routes.set(r.path,r.handler);return ()=>{}}},effect:()=>{}})
async function request(url,body={},method='POST') {
  const [pathname,qs]=String(url).split('?')
  const full='/dsh-bili/api/'+pathname
  const handler=routes.get(full)
  if(!handler) throw new Error('没有这个路由：'+full)
  return new Promise((resolve,reject)=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={host:'127.0.0.1'};req.url=full+(qs?'?'+qs:'')
    const res={statusCode:200,writeHead(code){this.statusCode=code},end(text){resolve({status:this.statusCode,data:JSON.parse(text)})}}
    handler(req,res).catch(reject)
  })
}
if(process.env.TEST_NO_NODE) {
  // boot() 是异步的（先 ensureWork 再载扩展，最后才 startScheduler）；
  // 这里等它把 SCHED_STATUS 写出来，再断言「找不到 node」。
  let r=await request('status',{},'GET')
  for(let i=0;i<500&&r.data.scheduler.reason==='未启动';i++){
    await new Promise(res=>setImmediate(res))
    r=await request('status',{},'GET')
  }
  assert.equal(r.data.scheduler.ok,false)
  assert.match(r.data.scheduler.reason,/node/)
} else {
  const stateFile=path.join(process.env.DSH_HOME,'pod-night.json')
  const preserved={schema:2,date:new Date().toLocaleDateString('sv-SE'),action:'skip',fired:false,atMs:Date.now()+3600000,endsAt:Date.now()+7200000,usedCount:{},skippedWindows:[]}
  fs.writeFileSync(stateFile,JSON.stringify(preserved))
  const settings=await request('settings',{diary:{push:false}})
  assert.equal(settings.data.config.diary.push,false)
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)),preserved)
  const text='测试人设：使用简洁句子。'
  assert.equal((await request('persona',{text})).status,200)
  assert.equal((await request('persona',{},'GET')).data.text,text)
  await request('persona',{text:''})
  assert.equal((await request('persona',{},'GET')).data.text,'')
  await request('cookie',{sessdata:'replacement-cookie-local-test',bili_jct:'b'.repeat(32)})
  const {loadCred}=await import('../../tools/lib/cred.mjs')
  assert.equal(loadCred().sessdata,'replacement-cookie-local-test')
  const pending=path.join(process.env.USERPROFILE,'.bili-ai/pending-replies.json')
  fs.writeFileSync(pending,JSON.stringify({items:[{id:'test',oid:'1',bvid:'BV1234567890',root:'2',parent:'2',message:'local draft'}]}))
  const response=await request('pending/approve',{id:'test'})
  await new Promise(r=>setImmediate(r))
  assert.equal(response.data.ok,process.env.TEST_SEND_SUCCESS==='1')
  const queue=JSON.parse(fs.readFileSync(pending,'utf8')).items
  assert.equal(queue.length,process.env.TEST_SEND_SUCCESS==='1'?0:1)

  // ── 新路由的「读」这一侧（不碰网络）────────────────────────────────────
  const st=await request('status',{},'GET')
  assert.ok(st.data.diary && st.data.ledger && st.data.scheduler, 'status 里缺 diary/ledger/scheduler')
  assert.ok(Array.isArray(st.data.scope?.write ?? []))

  const d=await request('diary',{},'GET')
  assert.equal(d.data.ok,true)
  assert.ok(Array.isArray(d.data.kinds))

  const lead=await request('ledger',{},'GET')
  assert.equal(lead.data.ok,true)
  assert.ok(Array.isArray(lead.data.rows))
  assert.equal((await request('ledger/verify')).data.ok,true)

  const ext=await request('extensions',{},'GET')
  assert.equal(ext.data.ok,true)
  assert.ok(Array.isArray(ext.data.list))
  assert.equal(ext.data.apiVersion,1)

  const tide=await request('tide/preview',{night:{mode:'tide'}})
  assert.equal(tide.data.ok,true)
  assert.equal(tide.data.preview.length,2)
  assert.match(tide.data.text,/峰/)

  // diary recall 走的是 query 字段（曾经写成 q 导致永远查不到）
  const {appendDaily,archiveDue}=await import('../../lib/diarystore.mjs')
  const {diaryDir}=await import('../../tools/lib/paths.mjs')
  appendDaily(diaryDir,{day:'2026-01-01',text:'- [学习] 鲸群召回测试'})
  archiveDue(diaryDir,{now:new Date('2026-02-01T10:00:00').getTime(),keepDays:1})
  const hit=await request('diary/recall?q='+encodeURIComponent('召回测试'),{},'GET')
  assert.equal(hit.data.hits.length>=1,true,'diary recall 没命中')
}
