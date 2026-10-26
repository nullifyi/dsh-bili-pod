import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { apiGet } from './bili-api.mjs'
import { guardedFetch as fetch } from './traffic.mjs'
import { workDir } from './paths.mjs'
import { requireFfmpeg } from './ffmpeg.mjs'

export function snapshotEntries(snapshot,duration=0,pvdata) {
 let entries=(snapshot.index??[]).map((item,i)=>({seconds:Number(typeof item==='object'?item?.timestamp:item),tile:i})).filter(e=>Number.isFinite(e.seconds)&&e.seconds>=0)
 if(!entries.length&&pvdata){if(pvdata.length%2||pvdata.length>40000)throw Error('pvdata不是有效的uint16时间索引');entries=Array.from({length:pvdata.length/2},(_,i)=>({seconds:pvdata.readUInt16BE(i*2),tile:i}));return entries}
 const biggest=Math.max(0,...entries.map(e=>e.seconds))
 if(duration>0&&biggest>duration*1.5)entries=entries.map(e=>({...e,seconds:e.seconds/1000}))
 return entries
}
export function planFrames(view,snapshot,{count=3,at,pvdata}={}) {
 if(!Number.isInteger(count)||count<1||count>6)throw Error('抽帧数量必须为1–6')
 let covered=Number(view.pages?.[0]?.duration)||Number(view.duration)||0
 const entries=snapshotEntries(snapshot,covered,pvdata)
 if(!entries.length||!snapshot.image?.length)throw Error('该视频没有可用故事板')
 const last=Math.max(...entries.map(e=>e.seconds));if(last>0)covered=covered>0?Math.min(covered,last):last
 const requested=at?.length?at.slice(0,6):Array.from({length:count},(_,i)=>covered*(i+1)/(count+1))
 if(requested.some(v=>!Number.isFinite(v)||v<0))throw Error('抽帧时间必须为非负秒数')
 const frames=requested.map(t=>{const target=Math.min(t,Math.max(0,covered-0.1));const e=entries.reduce((a,b)=>Math.abs(a.seconds-target)<=Math.abs(b.seconds-target)?a:b);return {requestedSeconds:Math.round(target*10)/10,actualSeconds:Math.round(e.seconds*10)/10,tile:e.tile}})
 return {coveredSeconds:Math.round(covered*10)/10,pages:Math.max(1,view.pages?.length??0),frames}
}
export function imageDimensions(b) {
 if(b.length>=24&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)}
 if(b.length>=4&&b[0]===255&&b[1]===216){let p=2;while(p+4<=b.length){if(b[p++]!==255)break;while(b[p]===255)p++;const marker=b[p++];if(marker===216||marker===217)continue;const length=b.readUInt16BE(p);if(length<2||p+length>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)return {width:b.readUInt16BE(p+5),height:b.readUInt16BE(p+3)};p+=length}}
 throw Error('无法识别故事板图片尺寸（需要JPEG或PNG）')
}
function mediaUrl(value) {
 const u=new URL(String(value).startsWith('//')?'https:'+value:String(value))
 if(u.protocol!=='https:'||u.username||u.password||u.port||!['hdslb.com','biliimg.com','bilibili.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw Error('视频素材地址不是B站HTTPS图片源')
 return u.href
}
async function bytes(url,max=8*1024*1024) {
 // Public CDN requests deliberately never receive an account Cookie.
 const r=await fetch(mediaUrl(url),{headers:{'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/','accept':'image/jpeg,image/png,*/*'},signal:AbortSignal.timeout(30000)})
 if(!r.ok)throw Error('图片下载HTTP '+r.status)
 const chunks=[];let size=0
 if(r.body){for await(const part of r.body){size+=part.length;if(size>max){await r.body.cancel?.().catch(()=>{});throw Error('视频素材超过大小上限')}chunks.push(Buffer.from(part))}}else{const part=Buffer.from(await r.arrayBuffer());if(part.length>max)throw Error('视频素材超过大小上限');chunks.push(part)}
 return Buffer.concat(chunks)
}
function previewDirectory(bvid,root=path.join(workDir,'vision-cache')) {
 root=path.resolve(root);fs.mkdirSync(root,{recursive:true})
 for(const e of fs.readdirSync(root,{withFileTypes:true})){if(!e.isDirectory()||!/^BV[0-9A-Za-z]{10}-/.test(e.name))continue;const dir=path.resolve(root,e.name);if(!dir.startsWith(root+path.sep)||fs.lstatSync(dir).isSymbolicLink())continue;try{const m=JSON.parse(fs.readFileSync(path.join(dir,'.generated.json'),'utf8'));if(m.by==='dsh-bili-pod-vision'&&Date.now()-m.at>86400000)fs.rmSync(dir,{recursive:true,force:true})}catch{}}
 const dir=fs.mkdtempSync(path.join(root,bvid+'-'));fs.writeFileSync(path.join(dir,'.generated.json'),JSON.stringify({by:'dsh-bili-pod-vision',at:Date.now(),temporary:true}));return dir
}
export async function createVisionPreview(bvid,{headers={},mode='frames',count=3,at}={}) {
 if(!/^BV[0-9A-Za-z]{10}$/.test(bvid))throw Error('需要有效BV号')
 const j=await apiGet('https://api.bilibili.com/x/web-interface/view?bvid='+bvid,headers)
 if(j.code!==0||!j.data)throw Error('视频信息读取失败：'+String(j.message??j.code))
 const view=j.data,ffmpeg=requireFfmpeg(),dir=previewDirectory(bvid)
 if(mode==='cover'){
  const input=path.join(dir,'cover-original.jpg'),output=path.join(dir,'cover.jpg');fs.writeFileSync(input,await bytes(view.pic));execFileSync(ffmpeg,['-y','-loglevel','error','-i',input,'-vf','scale=512:-1','-frames:v','1',output],{timeout:15000,windowsHide:true});fs.rmSync(input,{force:true});return {ok:true,bvid,title:view.title,duration:view.duration,cover:output,temporary:true,viewed:false,hint:'请用read_image打开cover；路径返回不代表已经看到图片。'}
 }
 const cid=view.pages?.[0]?.cid??view.cid
 if(!cid)throw Error('视频信息缺少cid')
 let snapshot,plan,error
 for(let attempt=0;attempt<2;attempt++){
  try{const s=await apiGet('https://api.bilibili.com/x/player/videoshot?bvid='+bvid+'&cid='+encodeURIComponent(String(cid))+'&index=1',headers,{noCache:true});if(s.code!==0)throw Error('故事板接口：'+String(s.message??s.code));snapshot=s.data??{};const pv=!(snapshot.index?.length)&&snapshot.pvdata?await bytes(snapshot.pvdata,40000):undefined;plan=planFrames(view,snapshot,{count,at,pvdata:pv});break}catch(e){error=e;if(attempt===0)await delay(1000)}
 }
 if(!plan)throw error??Error('故事板不可用')
 const cache=new Map(),frames=[],failed=[]
 async function sheet(no){if(no>=snapshot.image.length)throw Error('故事板拼图不存在');if(!cache.has(no)){const file=path.join(dir,'sheet-'+no+'.jpg');const b=await bytes(snapshot.image[no]);const dimensions=imageDimensions(b);fs.writeFileSync(file,b);cache.set(no,{file,...dimensions})}return cache.get(no)}
 const first=await sheet(0),tw=Number(snapshot.img_x_size)||Math.floor(first.width/(Number(snapshot.img_x_len)||10)),th=Number(snapshot.img_y_size)||Math.floor(first.height/(Number(snapshot.img_y_len)||10))
 const cols=Math.floor(first.width/tw),rows=Math.floor(first.height/th),capacity=cols*rows
 if(!Number.isInteger(tw)||!Number.isInteger(th)||tw<1||th<1||capacity<1)throw Error('故事板网格尺寸无效')
 for(const [i,p] of plan.frames.entries())try{
  const no=Math.floor(p.tile/capacity),pos=p.tile%capacity,s=await sheet(no),x=pos%cols*tw,y=Math.floor(pos/cols)*th
  if(x+tw>s.width||y+th>s.height)throw Error('故事板切片超出图片范围')
  const file=path.join(dir,'frame-'+String(i).padStart(2,'0')+'.jpg')
  execFileSync(ffmpeg,['-y','-loglevel','error','-i',s.file,'-vf','crop='+tw+':'+th+':'+x+':'+y+',scale=720:-1','-frames:v','1','-q:v','3',file],{timeout:15000,windowsHide:true})
  frames.push({...p,file})
 }catch(e){failed.push({...p,error:e.message})}
 let contactSheet
 if(frames.length){contactSheet=path.join(dir,'preview.jpg');const inputs=frames.flatMap(f=>['-i',f.file]);const columns=Math.min(3,frames.length),layout=frames.map((_,i)=>(i%columns*720)+'_'+(Math.floor(i/columns)*Math.round(th/tw*720))).join('|');const filter=frames.length===1?'null':'xstack=inputs='+frames.length+':layout='+layout+':fill=black';execFileSync(ffmpeg,['-y','-loglevel','error',...inputs,'-filter_complex',filter,'-frames:v','1','-q:v','3',contactSheet],{timeout:15000,windowsHide:true})}
 for(const x of cache.values())fs.rmSync(x.file,{force:true})
 return {ok:frames.length>0,bvid,title:view.title,duration:view.duration,...plan,frames,failed,contactSheet,temporary:true,viewed:false,hint:'用read_image打开contactSheet或frame文件；按actualSeconds描述时间。故事板是稀疏预览，多P只覆盖第1P，不等于看完整片。'}
}
