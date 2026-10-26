import fs from 'node:fs'
import path from 'node:path'
import {WORK_DIR} from '../../lib/store.mjs'
import {stateDir as sharedStateDir} from '../../lib/state-dir.mjs'
const bvPattern=/BV[0-9A-Za-z]{10}/g
const read=(root,name,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw Error(name+' 无法读取：'+e.message)}}
export function historyDate(input,now=new Date()) {
  if(!input)return ''
  const raw=String(input).trim();if(/T.*(?:Z|[+-]\d\d:?\d\d)$/.test(raw)&&!isNaN(Date.parse(raw)))return new Date(raw).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})
  let text=raw,m=text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if(!m){const short=text.match(/^(\d{1,2})[-/](\d{1,2})$/);if(!short)return /^\d{4}/.test(text)&&!isNaN(Date.parse(text))?new Date(text).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):'';let year=Number(now.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,4));if(new Date(year+'-'+short[1].padStart(2,'0')+'-'+short[2].padStart(2,'0'))>new Date(now.getTime()+2*86400000))year--;m=[null,String(year),short[1],short[2]]}
  const normalized=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');const parsed=new Date(normalized+'T00:00:00Z');return !isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===normalized?normalized:''
}
export function historyItems({stateDir=sharedStateDir(WORK_DIR),query={},now=new Date()}={}) {
  const found=new Map()
  const add=(id,{title='',at='',kind,description=''})=>{if(!/^BV[0-9A-Za-z]{10}$/.test(id??''))return;const prev=found.get(id)??{id,title:id,url:'https://www.bilibili.com/video/'+id,kinds:[],badges:[],subtitle:'',description:''};if(title&&title!==id)prev.title=String(title);const day=historyDate(at,now);if(day>prev.subtitle)prev.subtitle=day;prev.description=description||prev.description;if(!prev.kinds.includes(kind)){prev.kinds.push(kind);prev.badges.push(kind==='favorite'?'已收藏':'已评论')}found.set(id,prev)}
  for(const f of read(stateDir,'favorites.json',{items:[]}).items??[])add(f.bv,{title:f.title,at:f.at,kind:'favorite',description:f.reason})
  for(const c of read(stateDir,'quota.json',{log:[]}).log??[])if(c.type==='comment'&&(!c.status||c.status==='accepted'))add(String(c.target??'').replace(/^BV:/,''),{title:c.title,at:c.at??c.time??c.date,kind:'comment'})
  let audit='';try{audit=fs.readFileSync(path.join(stateDir,'commented-videos.md'),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
  for(const line of audit.split('\n')){if(!line.includes('|'))continue;const cells=line.split('|').map(c=>c.trim()).filter(Boolean);const last=cells.at(-1)??'',statusText=cells.length>=5||/state\s*=/.test(last)?last:'';const status=statusText.match(/state\s*=\s*(-?\d+)/);if(status?Number(status[1])!==0:/放弃|失败|被吞|未发出|rejected|uncertain/i.test(statusText))continue;const ids=line.match(bvPattern)??[];for(const id of ids)add(id,{title:cells.find(c=>c&&!/BV[0-9A-Za-z]{10}|^\d{1,4}[-/]\d/.test(c))??'',at:cells.find(c=>/^\d{1,4}[-/]\d/.test(c)),kind:'comment'})}
  const q=String(query.q??'').toLowerCase();const all=[...found.values()].filter(r=>(!query.kind||r.kinds.includes(query.kind))&&(!q||(r.title+' '+r.id+' '+r.description).toLowerCase().includes(q))).sort((a,b)=>b.subtitle.localeCompare(a.subtitle)||a.id.localeCompare(b.id));const page=Math.max(1,Math.floor(Number(query.page)||1)),size=20
  return {items:all.slice((page-1)*size,page*size),total:all.length,page,pageSize:size}
}
export default {setup(pod){pod.route('/videos',({req})=>historyItems({query:Object.fromEntries(new URL(req.url,'http://localhost').searchParams)}))}}
