import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import assert from 'node:assert/strict'
const scenario=process.argv[2],home=fs.mkdtempSync(path.join(os.tmpdir(),'pod-scheduler-sync-')),dsh=path.join(home,'dsh'),work=path.join(dsh,'work')
fs.mkdirSync(work,{recursive:true});fs.mkdirSync(path.join(home,'.bili-ai'));fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fake'}));fs.writeFileSync(path.join(dsh,'pod-persona.md'),'UNIQUE FULL PERSONA SENTINEL')
Object.assign(process.env,{USERPROFILE:home,HOME:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_POD_WORK:work,BILI_POD_STATE:path.join(work,'state'),BILI_POD_CONFIG:path.join(dsh,'pod.config.json')})
const ActualDate=Date;let now=Date.now();globalThis.Date=class extends ActualDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}
globalThis.setInterval=globalThis.setTimeout=()=>({});globalThis.clearInterval=globalThis.clearTimeout=()=>{}
let ackCount=0,receipt='stable-receipt',release;const attempts=[],accepted=new Set(),created=[],models=[],permissions=[],logs=[],agents=new Map()
cp.execFile=(exe,args,opts,cb)=>{queueMicrotask(()=>{if(args.includes('--ack')){ackCount++;cb(scenario==='retry'&&ackCount===1?Object.assign(Error('ack failed'),{code:3}):null,'ok','')}else cb(null,JSON.stringify({hit:true,role:'owner',mid:'222',name:'Owner',text:'long-message-'+('x'.repeat(1100))+'-END',receipt}),'')});return {kill(){}}};syncBuiltinESMExports()
const cfg={owner:{mid:'222'},listen:{dm:true,comment:false,live:false},review:{policy:'off'},night:{windows:[]},sessionRotateDays:0}
const model={provider:'fixture-route',model:'fixture-model',reasoningEffort:'high'}
const controller={agents:{selectForNextRequest:(agent,m)=>models.push({id:agent.id,model:m})},selectModel:()=>{throw Error('must not change global defaults')},create:async r=>{created.push(r);const a={id:r.sessionId,session:{id:r.sessionId}};agents.set(a.id,a);return {sessionId:a.id}},prompt:async r=>{attempts.push(r);if(scenario==='timeout'||scenario==='cross-host')await new Promise(x=>release=x);accepted.add(r.requestId);return {accepted:true}}}
const registry={agents:{get:id=>agents.get(id)},sessionProjections:{snapshot:()=>({values:{agentPreset:'standard',modelSelection:{next:null,lastUsed:model}}})},permissionPresets:{current:()=> 'danger-full-access',resolve:x=>assert.equal(x,'danger-full-access'),set:(s,p)=>permissions.push({id:s.id,preset:p})}}
const {startScheduler}=await import('../../lib/scheduler.js')
const scheduler=startScheduler({sessionController:controller,get:key=>registry[key]},{dshHome:dsh,workDir:work,diaryRoot:path.join(dsh,'diary'),biliMjs:path.resolve('tools/bili.mjs'),log:x=>logs.push(x),host:{readConfig:()=>cfg,scopeFor:()=>({active:false}),writeScope:()=>{}}})
try{
 if(scenario==='cross-host'){
  cfg.diary={enabled:false};cfg.ledger={enabled:false};const first=scheduler.wakeNow();while(!release)await new Promise(r=>setImmediate(r));const other=startScheduler({sessionController:controller,get:key=>registry[key]},{dshHome:dsh,workDir:work,diaryRoot:path.join(dsh,'diary'),biliMjs:path.resolve('tools/bili.mjs'),host:{readConfig:()=>cfg,scopeFor:()=>({active:false}),writeScope:()=>{}}});try{const second=await other.wakeNow();assert.equal(second.ok,false);assert.equal(attempts.length,1);release();assert.equal((await first).ok,true)}finally{other.stop()}
 }else if(scenario==='timeout'){
  const first=scheduler.dmTick();while(!release)await new Promise(r=>setImmediate(r));now+=16*60000;await scheduler.dmTick();await scheduler.dmTick();assert.equal(attempts.length,1);assert.equal(logs.filter(l=>l.includes('保持单次投递锁')).length,1);release();await first
 }else{
  await scheduler.dmTick();assert.ok(attempts[0].content[0].text.endsWith('-END'));assert.ok(attempts[0].content[0].text.length>1100)
  cfg.sessionRotateDays=1;now+=2*86400000
  if(scenario==='rotation')receipt='next-receipt'
  await scheduler.dmTick()
  if(scenario==='retry'){assert.equal(attempts[0].requestId,attempts[1].requestId);assert.equal(accepted.size,1);assert.equal(created.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(work,'state/session-delivery.json'))).pendingRequest,undefined)}
  else{assert.equal(created.length,2);assert.equal(created[1].agentPreset,'standard');assert.notEqual(attempts[1].sessionId,attempts[0].sessionId);assert.deepEqual(models,[{id:attempts[1].sessionId,model}]);assert.deepEqual(permissions,[{id:attempts[1].sessionId,preset:'danger-full-access'}]);assert.match(attempts[1].content[0].text,/会话续接/);assert.match(attempts[1].content[0].text,/UNIQUE FULL PERSONA SENTINEL/);assert.ok(agents.has(attempts[0].sessionId));assert.equal(JSON.parse(fs.readFileSync(path.join(work,'state/agent-session.json'))).sessionId,attempts[1].sessionId)}
 }
 console.log('PASS '+scenario)
}finally{scheduler.stop();assert.ok(path.basename(home).startsWith('pod-scheduler-sync-'));fs.rmSync(home,{recursive:true,force:true})}
