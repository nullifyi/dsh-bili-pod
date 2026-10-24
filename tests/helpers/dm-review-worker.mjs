import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync,spawn} from 'node:child_process'
import {Readable} from 'node:stream'
import {coordinates,issueApproval,readOperation,OPERATIONS_FILE,PENDING_FILE} from '../../lib/comment-state.mjs'
const scenario=process.argv[2],root=path.resolve(import.meta.dirname,'../..'),bv='BV1234567890',publicText='@Owner 今天这份教程非常值得学习',dmText=publicText+' https://www.bilibili.com/video/'+bv+'/'
const run=(args,env={})=>{const r=spawnSync(process.execPath,[path.join(root,'tools/bili.mjs'),...args],{env:{...process.env,...env},encoding:'utf8',timeout:10000});assert.ifError(r.error);return r}
const concurrent=(args,env={})=>new Promise(resolve=>{const c=spawn(process.execPath,[path.join(root,'tools/bili.mjs'),...args],{env:{...process.env,...env}});let out='';c.stdout.on('data',s=>out+=s);c.stderr.on('data',s=>out+=s);c.on('close',code=>resolve({status:code,stdout:out,stderr:out}))})
const allReq=()=>fs.existsSync(process.env.TEST_REQUESTS)?fs.readFileSync(process.env.TEST_REQUESTS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
const dmPosts=()=>allReq().filter(x=>x.url.includes('/send_msg'))
const cfgChange=patch=>fs.writeFileSync(process.env.BILI_POD_CONFIG,JSON.stringify({...JSON.parse(fs.readFileSync(process.env.BILI_POD_CONFIG,'utf8')),...patch}))
const assertOk=r=>assert.equal(r.status,0,r.stdout+r.stderr),assertBad=r=>assert.notEqual(r.status,0,r.stdout+r.stderr)
const ordinary=['dm','--msg','主人刚才问的问题已经查到了','--go']
const shareArgs=['--share','--target',bv,'--reason','这段讲解详细而且正好命中偏好','--score','18','--rank','1']
const continuation=id=>['dm',...shareArgs,'--continuation',id,'--msg',dmText,'--go']
function source() {
 const r=run(['comment','--oid','1','--bvid',bv,'--message',publicText,'--auto',...shareArgs,'--go']);assertOk(r)
 const db=JSON.parse(fs.readFileSync(OPERATIONS_FILE));const op=db.items.at(-1);assert.equal(op.status,'accepted');assert.equal(op.accountingStatus,'complete');return op
}
function quotaOne(){const q=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'.bili-ai/quota.json')));assert.equal(q.log.filter(x=>x.share).length,1)}
if(scenario==='default-review') {
 assert.equal(run(ordinary).status,7);assert.equal(run([...ordinary,'--reviewed']).status,7);assert.equal(run([...ordinary,'--approval','forged','--operation-id','unknown']).status,7);assert.equal(dmPosts().length,0)
} else if(scenario==='review-disabled') {
 cfgChange({review:{policy:'off',verify:false}});assertBad(run(ordinary,{TEST_RELATION_ATTRIBUTE:'2'}));assert.equal(dmPosts().length,0);assertOk(run(ordinary));assert.equal(dmPosts().length,1)
} else if(scenario==='draft') {
 assertOk(run(['reply-draft','add','--kind','dm','--to','222','--message',ordinary[2]]));const draft=JSON.parse(fs.readFileSync(PENDING_FILE)).items[0];assert.equal(draft.kind,'dm');assert.equal(draft.to,'222');assert.equal(draft.message,ordinary[2]);assertBad(run(['reply-draft','add','--kind','dm','--to','999','--message','wrong owner']))
} else if(scenario==='approval-binding') {
 const ap=issueApproval({kind:'dm',to:'222',message:ordinary[2]});const a=['--approval',ap.token,'--operation-id',ap.operationId]
 assertBad(run(['dm','--msg','different',...a,'--go']));assert.equal(dmPosts().length,0)
 cfgChange({owner:{mid:'999',name:'Else'}});assertBad(run([...ordinary,...a]));assert.equal(dmPosts().length,0)
 cfgChange({owner:{mid:'222',name:'Owner'}});assertOk(run([...ordinary,...a]));assertBad(run([...ordinary,...a]));assert.equal(dmPosts().length,1)
 assert.equal(readOperation(ap.operationId).status,'accepted')
} else if(scenario.startsWith('host-')) {
 assertOk(run(['reply-draft','add','--kind','dm','--to','222','--message',ordinary[2]]));const id=JSON.parse(fs.readFileSync(PENDING_FILE)).items[0].id
 const routes=new Map();let clean;const realInterval=globalThis.setInterval,realTimeout=globalThis.setTimeout
 globalThis.setInterval=globalThis.setTimeout=()=>0
 const {default:plugin}=await import('../../lib/index.js');plugin.apply({get:()=>({requestRejection:()=>null}),webServer:{register(r){routes.set(r.path,r.handler);return()=>{}}},effect:f=>{clean=f()}})
 globalThis.setInterval=realInterval;globalThis.setTimeout=realTimeout
 if(scenario==='host-uncertain')process.env.TEST_DM_UNCERTAIN='1'
 const approve=()=>new Promise((resolve,reject)=>{const req=Readable.from([Buffer.from(JSON.stringify({id}))]);Object.assign(req,{method:'POST',headers:{host:'127.0.0.1'}});routes.get('/dsh-bili/api/pending/approve')(req,{writeHead(){},end:t=>resolve(JSON.parse(t))}).catch(reject)})
 const results=await Promise.all([approve(),approve()]);assert.equal(dmPosts().length,1)
 if(scenario==='host-once'){assert.equal(results.filter(x=>x.status==='accepted').length,1);assert.equal(JSON.parse(fs.readFileSync(PENDING_FILE)).items.length,0)}
 else {
  // 0.8.0：结果不明 → 允许「对账后重试」，所以再点一次会真的再发一次（不再永远卡住）
  assert.equal(JSON.parse(fs.readFileSync(PENDING_FILE)).items[0].status,'uncertain')
  assert.equal((await approve()).ok,false)
  assert.equal(dmPosts().length,2)
}
 clean()
} else {
 const op=source()
 if(scenario==='both') {assertOk(run(continuation(op.operationId)));assertBad(run(continuation(op.operationId)));assert.equal(dmPosts().length,1);quotaOne();assert.equal(readOperation(op.operationId).continuation.status,'accepted');assertBad(run(['dm',...shareArgs,'--msg',dmText,'--go']));assert.equal(dmPosts().length,1)}
 if(scenario==='both-concurrent'){const results=await Promise.all([concurrent(continuation(op.operationId),{TEST_DM_DELAY:'1'}),concurrent(continuation(op.operationId),{TEST_DM_DELAY:'1'})]);assert.equal(results.filter(r=>r.status===0).length,1,JSON.stringify(results));assert.equal(dmPosts().length,1);quotaOne()}
 if(scenario==='both-uncertain'){assertBad(run(continuation(op.operationId),{TEST_DM_UNCERTAIN:'1'}));assert.equal(readOperation(op.operationId).continuation.status,'uncertain');assertBad(run(continuation(op.operationId)));assert.equal(dmPosts().length,1);quotaOne()}
 if(scenario==='both-unmutual'){assertBad(run(continuation(op.operationId),{TEST_RELATION_ATTRIBUTE:'2'}));assert.equal(dmPosts().length,0)}
 if(scenario==='both-owner'){cfgChange({owner:{mid:'999',name:'Else'}});assertBad(run(continuation(op.operationId)));assert.equal(dmPosts().length,0)}
 if(scenario==='both-invalid') {
  assertBad(run(continuation('unknown')))
  assertBad(run(continuation(op.operationId).map(x=>x===bv?'BV0987654321':x)))
  assertBad(run(continuation(op.operationId).map(x=>x===dmText?'arbitrary body '+bv:x)))
  for(const patch of [{status:'uncertain'},{status:'rejected'},{status:'sending'},{share:false},{root:'2',parent:'2'},{accountingStatus:'incomplete'},{channel:'dm'}]){
   fs.writeFileSync(OPERATIONS_FILE,JSON.stringify({items:[{...op,...patch}]}));assertBad(run(continuation(op.operationId)))
  }
  fs.writeFileSync(OPERATIONS_FILE,JSON.stringify({items:[op]}));fs.writeFileSync(path.join(process.env.USERPROFILE,'.bili-ai/quota.json'),JSON.stringify({log:[]}));assertBad(run(continuation(op.operationId)));assert.equal(dmPosts().length,0)
 }
}
