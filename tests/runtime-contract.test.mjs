import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PodHost } from '../lib/extensions.mjs'
import { scopeFor, checkCommand } from '../lib/scope.mjs'
import { tideWindows } from '../lib/tide.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
function sandbox(t, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-runtime-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'profile')
  fs.mkdirSync(dsh); fs.mkdirSync(path.join(home, '.bili-ai'))
  const cfg = path.join(dsh, 'pod.config.json')
  fs.writeFileSync(cfg, JSON.stringify({ listen: { comment: false, dm: false, live: false }, ...config }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'fake-local', bili_jct: 'a'.repeat(32) }))
  return { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_POD_CONFIG: cfg, BILI_POD_WORK: path.join(dsh, 'pod-work'), BILI_POD_DIARY: path.join(dsh, 'pod-diary'), BILI_POD_EXT: path.join(dsh, 'pod-ext'), NODE_OPTIONS: '' }
}
function run(env, file, args = []) {
  const r = spawnSync(process.execPath, [path.join(root, file), ...args], { env, encoding: 'utf8', timeout: 15000 })
  assert.ifError(r.error)
  return r
}

test('automatic DM sharing is granted only when enabled; stale scopes deny writes', () => {
  assert.equal(checkCommand(scopeFor({ reason: 'wake', config: { share: { enabled: true, via: 'dm' } } }), 'dm').ok, true)
  assert.equal(checkCommand(scopeFor({ reason: 'wake', config: { share: { enabled: false, via: 'dm' } } }), 'dm').ok, false)
  for (const at of ['2000-01-01', 'invalid']) {
    const scope = { active: true, at, allowWrite: ['comment'] }
    assert.equal(checkCommand(scope, 'comment', { now: Date.now() }).ok, false)
    assert.equal(checkCommand(scope, 'video', { now: Date.now() }).ok, true)
  }
})
test('midnight active range preserves post-midnight valley and crossing peak', () => {
  const wins = tideWindows({ activeStart: '22:00', activeEnd: '06:00', peakStart: '23:00', peakEnd: '01:00', valleyStart: '02:00', valleyEnd: '03:00', extraStart: '10:00', extraEnd: '11:00', wakesExtra: 1 })
  assert.deepEqual(wins.map(w => [w.start, w.end]).sort(), [['02:00','03:00'], ['23:00','01:00']])
})
test('automatic DM scope still requires the configured owner and mutual following in the actual CLI', t => {
  const cfg={share:{enabled:true,via:'dm'},owner:{mid:'222',name:'Owner'}}
  const env=sandbox(t,cfg)
  env.NODE_OPTIONS='--import='+pathToFileURL(path.join(root,'tests/helpers/mock-fetch.mjs')).href
  env.TEST_REQUESTS=path.join(env.DSH_HOME,'requests.jsonl')
  fs.mkdirSync(env.BILI_POD_WORK,{recursive:true})
  fs.writeFileSync(path.join(env.BILI_POD_WORK,'scope.json'),JSON.stringify(scopeFor({reason:'wake',config:cfg})))
  const args=['dm','--msg','https://www.bilibili.com/video/BV1234567890','--share','--reason','这条视频值得认真分享给主人','--score','18','--rank','1','--dry']
  let result=run(env,'tools/bili.mjs',args)
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/mid 222/)
  env.TEST_RELATION_ATTRIBUTE='2';result=run(env,'tools/bili.mjs',args)
  assert.equal(result.status,4,result.stderr);assert.match(result.stderr,/未互关/)
  fs.writeFileSync(env.BILI_POD_CONFIG,JSON.stringify({...cfg,owner:{mid:''}}))
  assert.equal(run(env,'tools/bili.mjs',args).status,2)
  assert.doesNotMatch(fs.readFileSync(env.TEST_REQUESTS,'utf8'),/send_msg/)
})

test('mod reload removes registrations, disposes once, and respects global/item enable', async t => {
  const env = sandbox(t), dir = env.BILI_POD_EXT
  fs.mkdirSync(dir)
  const marker = path.join(dir, 'trace.txt')
  fs.writeFileSync(path.join(dir, 'hello.mjs'), `import fs from 'node:fs';export default {id:'hello',setup(p){fs.appendFileSync(${JSON.stringify(marker)},'S');p.on('tick',()=>{});p.addPromptSection({text:'hello'});p.route('/hi',()=>1);p.command({name:'hello',script:${JSON.stringify(path.join(dir,'_cmd.mjs'))}});return ()=>fs.appendFileSync(${JSON.stringify(marker)},'D')}}`)
  let cfg = {}
  const h = new PodHost({ workDir: env.BILI_POD_WORK, dirs: [dir], readConfig: () => cfg })
  await h.loadAll(); assert.match(h.promptText(), /hello/)
  cfg = { extensions: { enabled: false } }; await h.loadAll()
  assert.equal(h.promptText(), ''); assert.equal(h.routes.length, 0); assert.equal(h.commands.size, 0)
  assert.equal((await h.emit('tick')).length, 0)
  cfg = {}; await h.loadAll()
  cfg = { extensions: { items: { hello: { enabled: false } } } }; await h.loadAll()
  assert.equal(h.promptText(), '')
  await h.close(); await h.close()
  assert.equal(fs.readFileSync(marker, 'utf8'), 'SDSD')
})
test('failed/timed out setup rolls back all registrations and ignores late work', async t => {
  const env = sandbox(t), dir = env.BILI_POD_EXT
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'bad.mjs'), `export default {id:'bad',setup(p){p.on('tick',()=>{});p.field({path:['bad']});p.addPromptSection({text:'bad'});p.route('/bad',()=>1);p.command({name:'bad',script:import.meta.filename});throw Error('bad setup')}}`)
  fs.writeFileSync(path.join(dir, 'late.mjs'), `export default {id:'late',async setup(p){p.addPromptSection({text:'too early'});await new Promise(r=>setTimeout(r,40));p.addPromptSection({text:'too late'});return ()=>{}}}`)
  const h = new PodHost({ workDir: env.BILI_POD_WORK, dirs: [dir], timeoutMs: 10 })
  await h.loadAll(); await new Promise(r => setTimeout(r, 60))
  assert.equal(h.promptText(), ''); assert.equal(h.routes.length, 0); assert.equal(h.fields.length, 0); assert.equal(h.commands.size, 0)
  assert.equal((await h.emit('tick')).length, 0)
  assert.equal(h.status().filter(e => !e.ok).length, 2)
  await h.close()
})
test('throwing/async prompt section is isolated from healthy mod', async t => {
  const env = sandbox(t), dir = env.BILI_POD_EXT
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'prompt.mjs'), `export default {setup(p){p.addPromptSection({id:'bad',text:()=>{throw Error('broken prompt')}});p.addPromptSection({id:'async',text:async()=>{throw Error('async prompt')}});p.addPromptSection({id:'good',text:'healthy'})}}`)
  const h = new PodHost({ workDir: env.BILI_POD_WORK, dirs: [dir] })
  await h.loadAll(); assert.match(h.promptText(), /healthy/); assert.equal(h.status()[0].ok, false)
  await new Promise(r => setImmediate(r)); await h.close()
})
test('late timed-out disposer cannot remove a replacement instance registrations', async t => {
  const env=sandbox(t),dir=env.BILI_POD_EXT
  fs.mkdirSync(dir)
  const key='releaseTimedOutMod',trace=path.join(dir,'disposed')
  t.after(()=>{delete globalThis[key]})
  fs.writeFileSync(path.join(dir,'replacement.mjs'),`import fs from 'node:fs';let n=0;export default {id:'replacement',setup(p){if(++n===1)return new Promise(r=>{globalThis.${key}=()=>{p.addPromptSection({text:'old'});r(()=>fs.appendFileSync(${JSON.stringify(trace)},'old'))}});p.addPromptSection({text:'replacement healthy'});p.on('tick',()=>fs.appendFileSync(${JSON.stringify(trace)},'tick'));return ()=>fs.appendFileSync(${JSON.stringify(trace)},'new')}}`)
  const h=new PodHost({workDir:env.BILI_POD_WORK,dirs:[dir],timeoutMs:10})
  await h.loadAll();await h.loadAll();assert.match(h.promptText(),/replacement healthy/)
  globalThis[key]();await new Promise(r=>setImmediate(r))
  assert.match(h.promptText(),/replacement healthy/)
  await h.emit('tick');assert.equal(fs.readFileSync(trace,'utf8'),'oldtick')
  await h.close();assert.equal(fs.readFileSync(trace,'utf8'),'oldticknew')
})

for (const scenario of ['session', 'create-failure', 'prompt-failure', 'not-accepted', 'scope-failure', 'stop-listen', 'stop-dm', 'tide-listen', 'plugin-lifecycle']) {
  test(`runtime boundary: ${scenario}`, t => {
    const env = sandbox(t); env.TEST_RUNTIME_CASE = scenario
    const r = run(env, 'tests/helpers/runtime.mjs'); assert.equal(r.status, 0, r.stderr + r.stdout)
  })
}
test('CLI executes only enabled local commands, preserves args and builtin precedence', t => {
  const env = sandbox(t), dir = env.BILI_POD_EXT
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, '_command.mjs'), `console.log(JSON.stringify(process.argv.slice(2)))`)
  fs.writeFileSync(path.join(dir, 'hello.mjs'), `import {fileURLToPath} from 'node:url';export default {id:'hello',setup(p){const script=fileURLToPath(new URL('./_command.mjs',import.meta.url));p.command({name:'hello',script});p.command({name:'tide',script})}}`)
  const first = run(env, 'tools/bili.mjs', ['hello', 'a b', '--bvid', 'BVfake'])
  assert.equal(first.status, 0, first.stderr); assert.deepEqual(JSON.parse(first.stdout), ['a b','--bvid','BVfake'])
  const builtin = run(env, 'tools/bili.mjs', ['tide'])
  assert.equal(builtin.status, 0, builtin.stderr); assert.doesNotMatch(builtin.stdout, /^\[/)
  fs.writeFileSync(env.BILI_POD_CONFIG, JSON.stringify({ extensions: { items: { hello: { enabled: false } } } }))
  assert.equal(run(env, 'tools/bili.mjs', ['hello']).status, 2)
  fs.writeFileSync(env.BILI_POD_CONFIG, JSON.stringify({ extensions: { enabled: false } }))
  assert.equal(run(env, 'tools/bili.mjs', ['hello']).status, 2)
  fs.mkdirSync(env.BILI_POD_WORK, {recursive:true})
  fs.writeFileSync(path.join(env.BILI_POD_WORK,'extensions.json'), JSON.stringify({commands:[{name:'injected',script:path.join(dir,'_command.mjs')}]}))
  assert.equal(run(env, 'tools/bili.mjs', ['injected']).status, 2)
})
for (const enabled of [false, true]) {
  test(`actual debrief/watch honor artifacts.enabled=${enabled}`, t => {
    const env = sandbox(t, { artifacts: { enabled } })
    env.NODE_OPTIONS = '--import=' + pathToFileURL(path.join(root, 'tests/helpers/media-runtime.mjs')).href
    const d = run(env, 'tools/commands/debrief.mjs', ['BVfake', ...(enabled ? ['--no-frames'] : ['--substrip'])])
    assert.equal(d.status, 0, d.stderr)
    if (enabled) assert.match(fs.readFileSync(path.join(env.DSH_HOME, 'shots/subs/BVfake-debrief.txt'),'utf8'), /fake subtitle/)
    else assert.match(d.stdout, /fake subtitle/)
    const w = run(env, 'tools/commands/bili-watch.mjs', ['BVfake', '1x1'])
    assert.equal(w.status, 0, w.stderr)
    const shots = path.join(env.DSH_HOME, 'shots')
    if (enabled) {
      assert.ok(fs.existsSync(path.join(shots, 'covers/BVfake.jpg')))
      assert.ok(fs.readdirSync(path.join(shots,'video')).some(p => p.endsWith('.mp4')))
    } else assert.equal(fs.existsSync(shots), false)
  })
}
test('failed watch extraction removes only its temporary frames', t => {
  const env = sandbox(t, {artifacts:{enabled:true}})
  env.NODE_OPTIONS = '--import=' + pathToFileURL(path.join(root, 'tests/helpers/media-runtime.mjs')).href
  env.TEST_MEDIA_FFMPEG_FAIL = '1'
  const out = path.join(env.DSH_HOME,'shots/video')
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'existing-user-file'),'keep')
  const result=run(env,'tools/commands/bili-watch.mjs',['BVfake','1x1'])
  assert.equal(result.status,6,result.stderr)
  assert.equal(fs.readFileSync(path.join(out,'existing-user-file'),'utf8'),'keep')
  assert.equal(fs.readdirSync(out).some(f=>f.startsWith('.frames-')),false)
})
