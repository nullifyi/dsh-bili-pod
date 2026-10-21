import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
for(const scenario of ['default-review','review-disabled','draft','approval-binding','host-once','host-uncertain','both','both-concurrent','both-uncertain','both-invalid','both-owner','both-unmutual'])test('DM offline contract: '+scenario,t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pod-dm-contract-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const dsh=path.join(home,'dsh');fs.mkdirSync(dsh);fs.mkdirSync(path.join(home,'.bili-ai'))
 const cfg=path.join(dsh,'pod.config.json');fs.writeFileSync(cfg,JSON.stringify({owner:{mid:'222',name:'Owner'},share:{via:'both'},listen:{comment:false},review:{verify:false},notify:{type:'none'}}))
 fs.writeFileSync(path.join(home,'.bili-ai/credentials.json'),JSON.stringify({sessdata:'offline-test-credential',bili_jct:'a'.repeat(32),buvid3:'fake'}))
 const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_POD_CONFIG:cfg,BILI_POD_WORK:path.join(dsh,'work'),BILI_POD_DIARY:path.join(dsh,'diary'),BILI_POD_SCOPE:'off',TEST_REQUESTS:path.join(dsh,'requests'),NODE_OPTIONS:'--import='+pathToFileURL(path.join(root,'tests/helpers/settings-fetch.mjs')).href}
 const r=spawnSync(process.execPath,[path.join(root,'tests/helpers/dm-review-worker.mjs'),scenario],{env,encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr+r.stdout)
})
