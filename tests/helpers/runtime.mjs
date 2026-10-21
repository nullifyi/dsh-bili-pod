import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
const scenario = process.env.TEST_RUNTIME_CASE
const realDate = Date, now = new Date(scenario === 'tide-double-listen' ? '2026-10-22T22:30:00' : '2026-10-22T02:30:00').getTime()
globalThis.Date = class extends realDate { constructor(...a) { super(...(a.length ? a : [now])) } static now() { return now } }
const timers = []
globalThis.setTimeout = globalThis.setInterval = fn => { const t = {fn}; timers.push(t); return t }
globalThis.clearTimeout = globalThis.clearInterval = t => { t.cleared = true }
let releaseIO, releaseCreate, prompts = [], creates = [], events = [], scopeFails = false
cp.execFile = (exe, args, opts, cb) => {
  assert.ok(args.includes('dm-await'), `unexpected subprocess ${args}`)
  releaseIO = () => cb(null, JSON.stringify({hit:true,name:'Owner',mid:'222',text:'hello'}), '')
  return { kill() {} }
}
syncBuiltinESMExports()
let fetchCount = 0
globalThis.fetch = async u => {
  assert.match(String(u), /\/x\/msgfeed\/reply/)
  fetchCount++
  if (scenario === 'stop-listen') await new Promise(r => { releaseIO = r })
  return {json:async()=>({code:0,data:{items:[{id:1,reply_time:Math.floor(now/1000),user:{mid:'222',nickname:'Owner'},item:{}}]}})}
}
const dsh = process.env.DSH_HOME, work = process.env.BILI_POD_WORK, diary = process.env.BILI_POD_DIARY
const config = { night: { windows: [{start:'00:00',end:'04:00',wakes:1}],skipChance:0 }, listen: {comment:false,dm:false,live:false}, diary:{push:false}, review:{verify:false} }
fs.writeFileSync(process.env.BILI_POD_CONFIG,JSON.stringify(config))
fs.mkdirSync(work,{recursive:true}); fs.mkdirSync(diary,{recursive:true})
fs.writeFileSync(path.join(process.env.HOME,'.bili-ai/persona.md'),'persona sentinel')
const scope = await import('../../lib/scope.mjs')
const store = await import('../../lib/store.mjs')
const controller = {
  create:async p => { creates.push(p); if(scenario==='create-failure') throw Error('create unavailable'); if(scenario==='stop-dm') await new Promise(r=>{releaseCreate=r}); return {sessionId:'actual-returned-session'} },
  prompt:async(p,signal)=>{assert.ok(signal instanceof AbortSignal);assert.equal(signal.aborted,false);if(scenario==='prompt-failure')throw Error('delivery unavailable');prompts.push(p);return {accepted:scenario!=='not-accepted'}},
}
const host = {readConfig:()=>store.readConfig(), scopeFor:scope.scopeFor, writeScope:(...a)=>{if(scopeFails)throw Error('scope readonly');return scope.writeScope(...a)}, emit:async(e,p)=>events.push([e,p]), diary:{archiveDue:()=>[]}, ledger:{appendRound:p=>({committed:true,file:'fake-ledger',...p})},verifyRecent:async()=>({checked:[]}),extensions:{promptText:()=>''}}
if (scenario === 'plugin-lifecycle') {
  const dir = process.env.BILI_POD_EXT
  fs.mkdirSync(dir)
  const trace = path.join(dir,'trace')
  fs.writeFileSync(path.join(dir,'slow.mjs'),`import fs from 'node:fs';export default {id:'slow',async setup(p){if(!globalThis.releaseMod)await new Promise(r=>{globalThis.releaseMod=r});p.route('/active',()=>({ok:true}));p.addPromptSection({text:'enabled'});return ()=>fs.appendFileSync(${JSON.stringify(trace)},'D')}}`)
  const { default: plugin } = await import('../../lib/index.js')
  const routes = new Map(); let cleanup
  const ctx = {sessionController:controller,get:()=>({requestRejection:()=>null}),webServer:{register(r){routes.set(r.path,r.handler);return()=>routes.delete(r.path)}},effect:f=>{cleanup=f()}}
  plugin.apply(ctx)
  while(!globalThis.releaseMod) await new Promise(r=>setImmediate(r))
  cleanup(); globalThis.releaseMod()
  for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r))
  assert.equal(timers.filter(t=>!t.cleared).length,0,'unload during boot must not start timers')
  assert.equal(routes.size,0,'unload must not remount routes')
  assert.equal(fs.readFileSync(trace,'utf8'),'D')
  // New instance: the native toggle and global settings routes actually reload.
  plugin.apply(ctx)
  while(!routes.has('/dsh-bili/api/ext/slow/active'))await new Promise(r=>setImmediate(r))
  async function request(url,body) {
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={host:'127.0.0.1'}
    return new Promise((resolve,reject)=>routes.get('/dsh-bili/api/'+url)(req,{writeHead(){},end(s){resolve(JSON.parse(s))}}).catch(reject))
  }
  await request('extensions/toggle',{id:'slow',enabled:false});assert.equal(routes.has('/dsh-bili/api/ext/slow/active'),false)
  await request('extensions/toggle',{id:'slow',enabled:true});assert.equal(routes.has('/dsh-bili/api/ext/slow/active'),true)
  await request('settings',{extensions:{enabled:false}});assert.equal(routes.has('/dsh-bili/api/ext/slow/active'),false)
  cleanup();process.exit(0)
}
const { startScheduler } = await import('../../lib/scheduler.js')
const cli = path.resolve('tools/bili.mjs')
const options = {dshHome:dsh,biliMjs:cli,workDir:work,diaryRoot:diary,host}
const sched = startScheduler({sessionController:controller},options)
const pending = {schema:2,date:'2026-10-22',action:'wake',fired:false,atMs:now-100,endsAt:now+3600000,window:'00:00–04:00',windowKey:'2026-10-22:00:00–04:00',usedCount:{},skippedWindows:[]}
fs.writeFileSync(path.join(dsh,'pod-night.json'),JSON.stringify(pending))
if(scenario==='session') {
  await sched.tick();assert.equal(prompts.length,1)
  assert.equal(prompts[0].sessionId,'actual-returned-session');assert.equal(creates[0].cwd,work)
  const text=prompts[0].content[0].text
  assert.ok(text.includes(JSON.stringify(process.execPath)),text)
  assert.ok(text.includes(JSON.stringify(cli)),text)
  assert.ok(text.includes(path.join(diary,'records','INDEX.md')),text)
  assert.ok(text.includes(path.join(diary,'daily','2026-10-22.md')),text)
  assert.match(text,/persona sentinel/);assert.doesNotMatch(text,/`node bili\.mjs/)
  assert.ok(events.some(([e])=>e==='round:start'));assert.ok(events.some(([e])=>e==='round:delivered'));assert.ok(events.some(([e])=>e==='ledger:write'))
  assert.equal(events.some(([e])=>e==='round:end'),false)
  sched.stop()
  const restarted = startScheduler({sessionController:controller},options)
  fs.writeFileSync(path.join(dsh,'pod-night.json'),JSON.stringify(pending));await restarted.tick();restarted.stop()
  assert.equal(creates.length,1,'restart reuses the persisted actual identity without asking native create to replace a nonempty session')
  assert.equal(prompts.at(-1).sessionId,'actual-returned-session')
} else if(['create-failure','scope-failure','prompt-failure','not-accepted'].includes(scenario)) {
  scopeFails=scenario==='scope-failure'
  await sched.tick();assert.equal(prompts.length,scenario==='not-accepted'?1:0)
  assert.equal(events.some(([e])=>e==='round:delivered'),false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dsh,'pod-night.json'))).fired,false)
} else {
  config.listen={comment:scenario!=='stop-dm',dm:scenario==='stop-dm',allDay:!['tide-listen','tide-double-listen'].includes(scenario),scope:'reply'}
  config.night={mode:'tide',windows:[{start:'12:00',end:'13:00',wakes:1}],tide:{activeStart:'22:00',activeEnd:'06:00',peakStart:'23:00',peakEnd:'01:00',valleyStart:'02:00',valleyEnd:'03:00'}}
  if(scenario==='tide-double-listen') config.night.tide={activeStart:'00:00',activeEnd:'23:00',peakStart:'22:00',peakEnd:'02:00',wakesPeak:1,wakesValley:0}
  fs.writeFileSync(process.env.BILI_POD_CONFIG,JSON.stringify(config))
  fs.writeFileSync(path.join(dsh,'pod-listen.json'),JSON.stringify({lastSeen:Math.floor(now/1000)-100}))
  if(scenario==='stop-dm') {
    const job=sched.dmTick();while(!releaseIO)await new Promise(r=>setImmediate(r))
    releaseIO();while(!releaseCreate)await new Promise(r=>setImmediate(r))
    sched.stop();releaseCreate();await job;assert.equal(prompts.length,0)
  } else if(scenario==='stop-listen') {
    const job=sched.listenTick();while(!releaseIO)await new Promise(r=>setImmediate(r))
    sched.stop();releaseIO();await job;assert.equal(prompts.length,0)
  } else {await sched.listenTick();assert.equal(fetchCount,1);assert.equal(prompts.length,1)}
}
sched.stop()
