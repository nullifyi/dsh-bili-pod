import assert from 'node:assert/strict'
import fs from 'node:fs'
import {Readable} from 'node:stream'
import path from 'node:path'
globalThis.setInterval=()=>({});globalThis.clearInterval=()=>{};globalThis.setTimeout=()=>({});globalThis.clearTimeout=()=>{};globalThis.fetch=()=>{throw Error('unexpected network')}
const extraDir=path.join(process.env.DSH_HOME,'mods');fs.mkdirSync(extraDir,{recursive:true})
for(const id of ['state-a','state-b']){const d=path.join(extraDir,id);fs.mkdirSync(d);fs.writeFileSync(path.join(d,'mod.json'),JSON.stringify({id,apiVersion:2,main:'index.mjs',fields:id==='state-a'?[{path:['extensions','items',id,'note'],kind:'text'}]:[]}));fs.writeFileSync(path.join(d,'index.mjs'),'import fs from "node:fs";export default {setup(p){fs.appendFileSync(p.dataDir()+"/setups","S")}}')}
const initial=JSON.parse(fs.readFileSync(process.env.BILI_POD_CONFIG,'utf8'));initial.extensions={dirs:[extraDir]};fs.writeFileSync(process.env.BILI_POD_CONFIG,JSON.stringify(initial))
const routes=new Map(),cleanup=[]
const {default:plugin}=await import('../../lib/index.js')
plugin.apply({get:()=>({requestRejection:()=>null}),webServer:{register(r){routes.set(r.path,r.handler);return ()=>routes.delete(r.path)}},effect:fn=>{cleanup.push(fn())}})
async function request(p,body={},method='POST'){return new Promise((resolve,reject)=>{const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={host:'127.0.0.1'};req.url='/dsh-bili/api/'+p;const res={writeHead(status){this.status=status},end(text){resolve({status:this.status,data:JSON.parse(text)})}};routes.get(req.url)(req,res).catch(reject)})}
let meta
for(let i=0;i<300;i++){meta=(await request('settings',{},'GET')).data;if(meta.extensions.some(e=>e.id==='state-b'))break;await new Promise(r=>setImmediate(r))}
assert.ok(meta.extensionPanels.some(p=>p.ext==='watched-library'))
assert.equal((await request('settings',{extensionValues:{'dm.autoSendTo':['owner'],'reportLevel':'brief'}})).status,200)
const runtime=await request('settings',{config:{personaOncePerSession:true,sessionRotateDays:3}});assert.equal(runtime.data.config.personaOncePerSession,true);assert.equal(runtime.data.config.sessionRotateDays,3);
assert.equal((await request('settings',{extensionValues:{'extensions.items.state-a.note':'changed'}})).status,200);assert.equal(fs.readFileSync(path.join(process.env.BILI_POD_WORK,'ext/state-a/setups'),'utf8'),'SS');assert.equal(fs.readFileSync(path.join(process.env.BILI_POD_WORK,'ext/state-b/setups'),'utf8'),'S');
const before=fs.readFileSync(process.env.BILI_POD_CONFIG,'utf8')
assert.equal((await request('settings',{extensionValues:{'dm.autoSendTo':'owner'}})).status,400)
assert.equal(fs.readFileSync(process.env.BILI_POD_CONFIG,'utf8'),before)
assert.equal((await request('extensions/reload',{id:'sharing-controls'})).status,200)
assert.equal((await request('extensions/toggle',{id:'missing',enabled:false})).status,400)
const videos=await new Promise((resolve,reject)=>{const url='/dsh-bili/api/ext/watched-library/videos',req=Readable.from([]);req.method='GET';req.headers={host:'127.0.0.1'};req.url=url;const res={writeHead(){},end(t){resolve(JSON.parse(t))}};routes.get(url)(req,res).catch(reject)})
assert.deepEqual(videos.items,[])
console.log('MODULE_API_OK')
for(const fn of cleanup)if(typeof fn==='function')await fn()
