// Exit codes: 0=message/ack/baseline; 1=normal empty; 2=invalid input; 3=failure.
// A single OS-owned lock and persisted queue cover both configured recipients.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../lib/config.mjs'
import { stateFile, credentialsPath } from '../lib/paths.mjs'
import { readHistory } from '../lib/dm-history.mjs'
import { acquireProcessLock } from '../lib/process-lock.mjs'
const argv=process.argv.slice(2),peek=argv.includes('--peek'),json=argv.includes('--json')
const cfg=config(),owner=String(cfg.owner?.mid??'').trim()
const talkers=[{mid:owner,role:'owner',name:String(cfg.owner?.name??'主人')},...(cfg.mistress?.enabled&&cfg.mistress.mid&&String(cfg.mistress.mid)!==owner?[{mid:String(cfg.mistress.mid),role:'mistress',name:String(cfg.mistress.title??'女主人')}]:[])]
const file=stateFile('dm-await-state.json')
function save(s) {
 const tmp=file+'.'+crypto.randomUUID()+'.tmp'
 try{fs.writeFileSync(tmp,JSON.stringify(s,null,2)+'\n');fs.renameSync(tmp,file)}finally{fs.rmSync(tmp,{force:true})}
}
function normalize(raw) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('私信状态损坏')
 const s={...raw,owner,seen:{...raw.seen},keys:{...raw.keys},lastKeysByTalker:{...raw.lastKeysByTalker},lastIncomingByTalker:{...raw.lastIncomingByTalker},queue:raw.queue??[]}
 if(!Array.isArray(s.queue))throw Error('私信待交付队列损坏')
 if(raw.owner&&raw.lastSeen!==undefined) {
  s.seen[raw.owner]=Math.max(Number(s.seen[raw.owner]??0),Number(raw.lastSeen))
  s.lastKeysByTalker[raw.owner]=raw.lastKeys??(raw.lastKey?[raw.lastKey]:[])
  if(raw.lastIncoming)s.lastIncomingByTalker[raw.owner]=Math.max(Number(s.lastIncomingByTalker[raw.owner]??0),Number(raw.lastIncoming))
 }
 if(raw.owner&&raw.lastKey)s.keys[raw.owner]=String(raw.lastKey)
 for(const ts of Object.values(s.seen))if(!Number.isFinite(Number(ts))||Number(ts)<0)throw Error('私信游标损坏，已停止读取')
 const allowed=new Set(talkers.map(t=>t.mid))
 s.queue=s.queue.filter(r=>allowed.has(String(r.mid??owner)))
 if(s.pending&&!allowed.has(String(s.pending.mid)))throw Error('待确认私信的收件人已变化，请先人工核对回执')
 return s
}
function ack(s,msg) {
 const mid=String(msg.mid),same=Number(s.seen[mid])===Number(msg.ts)
 const previous=s.lastKeysByTalker[mid]??(s.keys[mid]?[s.keys[mid]]:[])
 s.seen[mid]=Number(msg.ts);s.keys[mid]=String(msg.key)
 s.lastKeysByTalker[mid]=[...new Set([...(same?previous:[]),String(msg.key)])]
 s.pending=null;s.at=new Date().toISOString()
 if(mid===owner){s.lastSeen=s.seen[mid];s.lastKey=s.keys[mid];s.lastKeys=s.lastKeysByTalker[mid]}
 return s
}
function emit(m){console.log(json?JSON.stringify(m):'DM_HIT role='+m.role+' mid='+m.mid+' text='+m.text)}
async function main() {
 if(!owner){console.error('配置里 owner.mid 为空');return 2}
 let raw={};try{raw=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('私信状态无法读取，已停止推进已读位置：'+e.message)}
 const s=normalize(raw),at=argv.indexOf('--ack')
 if(at>=0){if(!s.pending||s.pending.receipt!==argv[at+1]){console.error('私信确认凭据不匹配，未推进已读状态');return 2}save(ack(s,s.pending));console.log('私信交付已确认');return 0}
 if(s.pending&&!argv.includes('--baseline')){emit(s.pending);return 0}
 if(!s.queue.length||argv.includes('--baseline')) {
  const cred=JSON.parse(fs.readFileSync(credentialsPath,'utf8'))
  const headers={'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',cookie:'SESSDATA='+cred.sessdata+'; bili_jct='+cred.bili_jct+'; buvid3='+cred.buvid3}
  const collected=[]
  for(const t of talkers) {
   const cursor={lastSeen:s.seen[t.mid],lastKey:s.keys[t.mid],lastKeys:s.lastKeysByTalker[t.mid]}
   const result=await readHistory(t.mid,headers,cursor,{baseline:argv.includes('--baseline')})
   if(argv.includes('--baseline')) {
    const latest=result.all.at(-1),ts=latest?.ts??0
    s.seen[t.mid]=ts;s.keys[t.mid]=latest?.key;s.lastKeysByTalker[t.mid]=result.all.filter(r=>r.ts===ts).map(r=>r.key)
   } else {
    collected.push(...result.messages.map(r=>({...r,...t})))
    const times=result.messages.filter(r=>[1,7,8].includes(r.type)&&r.ts<=Math.floor(Date.now()/1000)).map(r=>r.ts)
    if(times.length)s.lastIncomingByTalker[t.mid]=Math.max(Number(s.lastIncomingByTalker[t.mid]??0),...times)
   }
  }
  s.lastIncoming=s.lastIncomingByTalker[owner]
  if(argv.includes('--baseline')){s.lastSeen=s.seen[owner];s.lastKey=s.keys[owner];s.lastKeys=s.lastKeysByTalker[owner];s.pending=null;s.queue=[];save(s);console.log('已把当前私信状态标记为已读');return 0}
  s.queue=collected.sort((a,b)=>a.ts-b.ts||a.mid.localeCompare(b.mid)||(a.seq&&b.seq?(BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0):a.key.localeCompare(b.key)))
  save(s)
 }
 if(!s.queue.length){console.log(json?JSON.stringify({hit:false}):'无新私信');return 1}
 const [row,...rest]=s.queue
 const t=talkers.find(t=>t.mid===String(row.mid??owner))
 const msg={hit:true,...t,text:row.text,ts:row.ts,key:row.key,receipt:crypto.randomUUID()}
 s.queue=rest
 if(peek){s.pending=msg;save(s)}else save(ack(s,msg))
 emit(msg);return 0
}
let release
try{fs.mkdirSync(path.dirname(file),{recursive:true});release=await acquireProcessLock(file);process.exitCode=await main()}
catch(e){console.error(e.message);process.exitCode=3}
finally{if(release)await release()}
