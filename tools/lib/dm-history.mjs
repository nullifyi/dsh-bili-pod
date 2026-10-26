import { parseJsonExact, exactJson } from './json-exact.mjs'
import crypto from 'node:crypto'
import { guardedFetch as fetch } from './traffic.mjs'
import { apiGet, signWbi } from './bili-api.mjs'

export function normalizeMessage(row) {
  const ts=Number(row.timestamp),sender=String(row.sender_uid??'')
  if(!Number.isFinite(ts)||ts<0||!sender)throw Error('私信历史消息缺少有效时间或发送者')
  const type=Number(row.msg_type ?? 1)
  let withdrawn=null
  if(type===5){try{const v=parseJsonExact(String(row.content));withdrawn=String(v?.msg_key ?? v?.msg_key_str ?? v)}catch{withdrawn=String(row.content??'')}}
  let text=String(row.content??'')
  try {const j=parseJsonExact(text);text=String(j.content??j.text??text)} catch {}
  const seq=String(row.msg_seqno??'')
  const key=String(row.msg_key??(seq||crypto.createHash('sha256').update(JSON.stringify([ts,sender,row.content])).digest('hex')))
  if(type===7||type===8)text='【B站分享卡片】'+text
  return {ts,sender,text,key,type,withdrawn,seq:/^\d+$/.test(seq)?seq:null}
}

export async function readHistory(owner,headers,state,{baseline=false}={}) {
  const nav=await apiGet('https://api.bilibili.com/x/web-interface/nav',headers)
  if(nav.code!==0||!nav.data?.wbi_img)throw Error('私信历史签名密钥不可用，保留游标')
  const seen=new Set(),all=[]
  let cursor='0'
  const boundary=Number(state.lastSeen??0),known=new Set(state.lastKeys??(state.lastKey?[state.lastKey]:[]))
  for(let page=0;page<10;page++) {
    const query=signWbi({talker_id:owner,session_type:1,size:30,begin_seqno:cursor},nav.data.wbi_img)
    const response=await fetch('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?'+query,{headers})
    const body=await exactJson(response)
    if(!response.ok||body.code!==0)throw Error('私信历史读取失败，保留游标（code='+body.code+'）')
    // 2026-10-26：跟某个账号「还没有过私信会话」时，B站 会返回 code=0 但 data 里没有 messages
    //   （女主人刚启用就是这样）。以前把它当读取失败抛错 → dmTick 每 4 分钟失败一次，
    //   主人的私信也跟着收不到了。没有 messages 只代表「这个 talker 没历史」，按空处理。
    const rawMessages=body.data?.messages
    if(rawMessages==null)break
    if(!Array.isArray(rawMessages))throw Error('私信历史读取失败，保留游标（messages 不是数组）')
    const rows=rawMessages.map(normalizeMessage)
    for(const row of rows)if(!seen.has(row.key)){seen.add(row.key);all.push(row)}
    // First run deliberately considers only the newest page; no unbounded historical replay.
    const more=body.data.has_more
    if(baseline||state.lastSeen===undefined||rows.some(r=>r.ts<boundary)||more===0||more==='0'||more===false||(!rows.length&&more===undefined)|| (more===undefined&&rows.length<30))break
    const seqs=rows.filter(r=>r.seq).map(r=>BigInt(r.seq))
    if(!seqs.length)throw Error('私信历史分页缺少序号，保留游标')
    const next=seqs.reduce((a,b)=>a<b?a:b).toString()
    if(next===cursor||(cursor!=='0'&&BigInt(next)>=BigInt(cursor)))throw Error('私信历史分页未前进，保留游标')
    if(page===9)throw Error('私信积压超过单次 10 页，未推进游标；请人工检查')
    cursor=next
  }
  all.sort((a,b)=>a.ts-b.ts||(a.seq&&b.seq?(BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0):a.key.localeCompare(b.key)))
  const withdrawn=new Set(all.filter(r=>r.type===5).map(r=>r.withdrawn))
  return {all,messages:all.filter(r=>[1,7,8].includes(r.type)&&!withdrawn.has(r.key)&&r.sender===owner&&(r.ts>boundary||(r.ts===boundary&&!known.has(r.key))))}
}
