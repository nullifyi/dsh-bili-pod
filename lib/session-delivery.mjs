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
 // 0.9.2：串行链（tail）里只要有一笔投递卡死，后面所有投递都会排队等它 —— 通道永久哑掉。
 //   这里记录「链上那笔是什么时候开始的」；超过 150s 还没结束就认定它已经死了，
 //   扔掉旧链继续下一笔（旧的那笔若之后才返回，会被 requestId 去重兜住）。
 let tailStartedAt=0
 const STUCK_MS=150000
 return {
  send(request,signal,{retainUntilAck=false}={}) {
   if(tailStartedAt&&now()-tailStartedAt>STUCK_MS){log('上一笔投递超过 ' + Math.round(STUCK_MS/1000) + 's 没有返回，判定为卡死：放弃它、继续后面的投递');tail=Promise.resolve();tailStartedAt=0}
   const task=tail.then(async()=>{
    tailStartedAt=now()
    try{
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
    }finally{tailStartedAt=0}
   });tail=task.catch(()=>{});return task
  },
  confirm(requestId){const task=tail.then(()=>{if(state.pendingRequest!==requestId)return;const next={...state};delete next.pendingRequest;save(next);state=next});tail=task.catch(()=>{});return task},
 }
}
