import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Serializes admission, not generation completion. Unacknowledged DM receipts
// pin their native session so retries use the same requestId after a restart.
export function createSessionDelivery({ stateFile, selectSession, deliver, config, rotate, isBusy=()=>false, now=Date.now, log=()=>{} }) {
 let state={},tail=Promise.resolve()
 try {state=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(!state||typeof state!=='object'||Array.isArray(state))throw Error('invalid state')}
 catch(e){if(e.code!=='ENOENT')throw Error('会话投递状态损坏，请检查 '+stateFile)}
 function save(next){fs.mkdirSync(path.dirname(stateFile),{recursive:true});const tmp=stateFile+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,stateFile)}finally{fs.rmSync(tmp,{force:true})}}
 return {
  send(request,signal,{retainUntilAck=false}={}) {
   const task=tail.then(async()=>{
    signal?.throwIfAborted()
    let sessionId=state.sessionId??await selectSession()
    const cfg=config(),days=Number(cfg.sessionRotateDays??0)
    state.startedAt??=now()
    if(!state.pendingRequest&&rotate&&days>0&&now()-state.startedAt>=days*86400000&&now()-Number(state.deliveredAt??0)>=8*60000&&!isBusy()){
     const old=sessionId;sessionId=await rotate(old);state={sessionId,startedAt:now()};log('会话轮换：'+old+' → '+sessionId+'；旧会话保留')
    }
    state={...state,sessionId}
    if(retainUntilAck){if(!request.requestId)throw Error('可靠交付需要 requestId');state.pendingRequest=request.requestId}
    save(state)
    signal?.throwIfAborted()
    const result=await deliver({...request,sessionId},signal)
    if(result?.accepted!==true)throw Error('sessionController.prompt 未确认接收')
    state={...state,deliveredAt:now()}
    try{save(state)}catch(e){log('会话已投递，但保存交付标记失败：'+e.message)}
    return result
   });tail=task.catch(()=>{});return task
  },
  confirm(requestId){const task=tail.then(()=>{if(state.pendingRequest!==requestId)return;const next={...state};delete next.pendingRequest;save(next);state=next});tail=task.catch(()=>{});return task},
 }
}
