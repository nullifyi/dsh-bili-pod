import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {normalizeConfig} from '../lib/defaults.mjs'
import {scopeFor,checkCommand} from '../lib/scope.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
function sandbox(t,cfg={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pod-settings-'))
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
  const dsh=path.join(home,'dsh');fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
  const file=path.join(dsh,'pod.config.json');fs.writeFileSync(file,JSON.stringify({owner:{mid:'222',name:'Owner'},listen:{comment:false},review:{verify:false},...cfg}))
  fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'offline-credential-test-only',bili_jct:'a'.repeat(32),buvid3:'fake'}))
  return {...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_POD_CONFIG:file,BILI_POD_WORK:path.join(dsh,'work'),BILI_POD_DIARY:path.join(dsh,'diary'),BILI_POD_EXT:path.join(dsh,'ext'),TEST_REQUESTS:path.join(dsh,'requests'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/settings-fetch.mjs')).href}
}
function run(env,file,args=[]) {const r=spawnSync(process.execPath,[path.join(root,file),...args],{env,encoding:'utf8',timeout:20000});assert.ifError(r.error);return r}
const requests=env=>fs.existsSync(env.TEST_REQUESTS)?fs.readFileSync(env.TEST_REQUESTS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]

test('runtime settings normalize old configs and integer budgets without widening defaults',()=>{
  const cfg=normalizeConfig({}).config
  assert.equal(cfg.reportLevel,'full');assert.equal(cfg.commentPerRound,1);assert.equal(cfg.replyPerRound,1);assert.equal(cfg.replyToComments,false)
  const changed=normalizeConfig({reportLevel:'bad',commentPerRound:22.8,replyPerRound:-4,replyToComments:true,share:{via:'both'},favFolderId:'123'}).config
  assert.equal(changed.reportLevel,'full');assert.equal(changed.commentPerRound,20);assert.equal(changed.replyPerRound,1);assert.equal(changed.replyToComments,true);assert.equal(changed.share.via,'both');assert.equal(changed.favFolderId,'123')
  assert.equal(normalizeConfig({commentPerRound:2.9,replyPerRound:3.9,share:{via:'bad'}}).config.commentPerRound,2)
  assert.equal(normalizeConfig({share:{via:'bad'}}).config.share.via,'comment')
  assert.equal(cfg.search.order,'totalrank');assert.equal(normalizeConfig({search:{order:'bad'}}).config.search.order,'totalrank')
  assert.equal(normalizeConfig({listen:{comment:true}}).config.replyToComments,true)
  assert.equal(normalizeConfig({listen:{comment:false}}).config.replyToComments,false)
  const explicitlyOff=normalizeConfig({listen:{comment:true},replyToComments:false}).config
  assert.equal(explicitlyOff.replyToComments,false);assert.equal(normalizeConfig(JSON.parse(JSON.stringify(explicitlyOff))).config.replyToComments,false)
})
test('zero comment budget removes automatic comment capability',()=>{
  for(const reason of ['wake','listen','dm','live']) assert.equal(checkCommand(scopeFor({reason,config:{commentPerRound:0}}),'comment').ok,false,reason)
})
test('actual CLI preserves named search order and validates order/page before network',t=>{
  const env=sandbox(t)
  const r=run(env,'tools/bili.mjs',['search','--kw','测试关键词','--page','2','--order','pubdate'])
  assert.equal(r.status,0,r.stderr+r.stdout)
  const url=new URL(requests(env).find(x=>x.url.includes('/search/type')).url)
  assert.equal(url.searchParams.get('keyword'),'测试关键词');assert.equal(url.searchParams.get('page'),'2');assert.equal(url.searchParams.get('order'),'pubdate')
  for(const args of [['测试','1','--order','bad'],['测试','-1'],['测试','1.5']]) {
    const before=requests(env).length;const bad=run(env,'tools/bili.mjs',['search',...args]);assert.equal(bad.status,2,bad.stdout+bad.stderr);assert.equal(requests(env).length,before)
  }
})
test('fav uses configured or explicit owned folder for both dry/go and keeps duplicate rules',t=>{
  const env=sandbox(t,{favFolderId:'42'})
  let r=run(env,'tools/bili.mjs',['fav','BV1234567890','--reason','学习这条详细教程','--dry']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/media_id=42/)
  r=run(env,'tools/bili.mjs',['fav','BV1234567890','--reason','学习这条详细教程','--folder','9','--go']);assert.equal(r.status,0,r.stderr)
  assert.equal(new URLSearchParams(requests(env).find(x=>x.method==='POST').body).get('add_media_ids'),'9')
  assert.notEqual(run(env,'tools/bili.mjs',['fav','BV1234567890','--reason','学习这条详细教程','--go']).status,0)
  const other=sandbox(t,{favFolderId:'999'});assert.notEqual(run(other,'tools/bili.mjs',['fav','BV1234567890','--reason','学习这条详细教程','--go']).status,0);assert.equal(requests(other).filter(x=>x.method==='POST').length,0)
})
for(const scenario of ['states','cancel','regenerate','generate-order','manual','expired','unload','settings','prompts','notifications','client']) test('real lifecycle behavior: '+scenario,t=>{
  const env=sandbox(t);const r=run(env,'tests/helpers/settings-lifecycle.mjs',[scenario]);assert.equal(r.status,0,r.stderr+r.stdout)
})
