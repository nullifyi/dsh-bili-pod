import {createVisionPreview} from '../lib/vision.mjs'
import {loadCred} from '../lib/cred.mjs'
import {makeHeaders} from '../lib/msgfeed.mjs'
const args=process.argv.slice(2),mode=args.shift(),bvid=args.shift(),i=args.indexOf('--n'),a=args.indexOf('--at')
try{if(!args.includes('--transient'))throw Error('临时看图入口请带 --transient；只生成24小时预览缓存，不保存为正式素材');const count=i<0?3:Number(args[i+1]),at=a<0?undefined:String(args[a+1]).split(',').map(Number);let headers={};try{headers=makeHeaders(loadCred())}catch{};const r=await createVisionPreview(bvid,{mode,headers,count,at});console.log(JSON.stringify(r,null,2));if(!r.ok)process.exitCode=3}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=3}
