import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const RealDate=Date
let now=new RealDate('2026-10-21T22:00:00').getTime()
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
const timers=[]
globalThis.setInterval=globalThis.setTimeout=(fn)=>{const t={fn};timers.push(t);return t}
globalThis.clearInterval=globalThis.clearTimeout=t=>{t.cleared=true}
const {startScheduler}=await import('../../lib/scheduler.js')
const {makePlan,completePlan,historyOf}=await import('../../tools/lib/night-plan.mjs')
const store=await import('../../lib/store.mjs')
const scopeLib=await import('../../lib/scope.mjs')
const ledgerLib=await import('../../lib/ledger.mjs')
const diaryLib=await import('../../lib/diarystore.mjs')
const dsh=process.env.DSH_HOME,state=path.join(dsh,'pod-night.json')
const workDir=path.join(dsh,'pod-work'),diaryRoot=path.join(dsh,'pod-diary')
fs.mkdirSync(workDir,{recursive:true});fs.mkdirSync(diaryRoot,{recursive:true})
const cfg={night:{windows:[{start:'23:00',end:'01:00',wakes:1}],skipChance:0},listen:{comment:false,dm:false,live:false},diary:{push:false}}
fs.writeFileSync(process.env.BILI_POD_CONFIG,JSON.stringify(cfg))
const persona=path.join(process.env.USERPROFILE,'.bili-ai/persona.md')
fs.writeFileSync(persona,'测试专属人设')
const host={
  readConfig:()=>store.readConfig(),
  writeConfig:(p)=>store.writeConfig(p),
  extensions:{promptText:()=>'',emit:async()=>[]},
  emit:async()=>[],
  scopeFor:({reason})=>scopeLib.scopeFor({reason,config:store.readConfig()}),
  writeScope:(w,s)=>scopeLib.writeScope(w,s),
  clearScope:(w)=>scopeLib.clearScope(w),
  ledger:ledgerLib,
  diary:diaryLib,
  verifyRecent:async()=>({checked:0,skipped:0,text:''}),
}
const opts=()=>({dshHome:dsh,biliMjs:'unused',cwd:process.env.USERPROFILE,workDir,diaryRoot,host})
const messages=[]
let fail=true,attempts=0
const sched=startScheduler({sessionController:{create:async()=>({sessionId:'fake-scheduler-session'}),prompt:async p=>{attempts++;if(fail)throw Error('delivery failure');messages.push(p.content[0].text);return {accepted:true}}}},opts())
const samples=[.75,.9];const p=makePlan(cfg.night,{},now,()=>samples.shift())
fs.writeFileSync(state,JSON.stringify(p))
await sched.tick();assert.equal(attempts,0)
now=new RealDate('2026-10-22T00:30:00').getTime()
await sched.tick();assert.equal(attempts,1)
assert.equal(JSON.parse(fs.readFileSync(state)).fired,false)
fail=false;await sched.tick();assert.equal(attempts,2)
assert.ok(messages[0].includes('测试专属人设'))
assert.ok(messages[0].includes('关掉了推送'))
await sched.tick();assert.equal(attempts,2)
const before=JSON.parse(fs.readFileSync(state))
sched.invalidate(true)
const after=JSON.parse(fs.readFileSync(state))
assert.deepEqual(after.usedCount,before.usedCount)
sched.stop();assert.ok(timers.every(t=>t.cleared))
for(const t of timers)t.fn()
await new Promise(r=>setImmediate(r));assert.equal(attempts,2)
// Skip branch uses the same persisted history and respects diary.push=false.
now=new RealDate('2026-10-23T23:00:00').getTime()
cfg.night.skipChance=1;fs.writeFileSync(process.env.BILI_POD_CONFIG,JSON.stringify(cfg))
const skip=makePlan(cfg.night,historyOf(before,now),now,()=>0)
fs.writeFileSync(state,JSON.stringify(skip))
const s2=startScheduler({sessionController:{create:async()=>({sessionId:'fake-scheduler-session'}),prompt:async p=>{messages.push(p.content[0].text);return {accepted:true}}}},opts())
await s2.tick();s2.stop()
assert.match(messages.at(-1),/今晚不看/);assert.ok(messages.at(-1).includes('关掉了推送'))
assert.ok(messages.at(-1).includes('测试专属人设'))
const end=JSON.parse(fs.readFileSync(state));assert.ok((end.usedCount?.[skip.windowKey]??0)>0,'skip 应消耗一次机会')

// 0.7.4：搬过 DSH_HOME（或改过工作目录）之后，旧会话还挂在老目录上，
//   sessionController.create 会因为「belongs to 老目录」失败。
//   正确做法：不删旧会话、也不另起影子会话 —— 沿用旧会话的 cwd 把这场对话续上。
fs.rmSync(path.join(workDir,'state','agent-session.json'),{force:true})
const oldCwd=path.join(process.env.USERPROFILE,'old-pod-work')
fs.mkdirSync(oldCwd,{recursive:true})
const calls=[]
let first=true
const s3=startScheduler({sessionController:{
  create:async(o)=>{calls.push(o.cwd);if(first){first=false;throw new Error('session "bili-pod" belongs to "'+oldCwd+'", not "'+o.cwd+'"')}return {sessionId:'adopted-session'}},
  prompt:async p=>{messages.push(p.content[0].text);return {accepted:true}},
}},opts())
const tonight=new RealDate('2026-10-22T20:10:00').getTime()
now=tonight
fs.writeFileSync(state,JSON.stringify(makePlan(cfg.night,{},now,()=>0.1)))
await s3.tick(true)
assert.equal(calls.length,2,'第一次失败后应重试一次')
assert.equal(calls[1],oldCwd,'重试应沿用旧会话的工作目录')
assert.ok(messages.at(-1).includes('测试专属人设'),'续上旧会话后应真的投递')
s3.stop()
