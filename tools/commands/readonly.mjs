// Readonly aggregates over pinned upstream GET definitions; see docs/readonly-cli.md.
import fs from 'node:fs'
import {CRED_PATH, loadCred} from '../lib/cred.mjs'
import {makeHeaders} from '../lib/msgfeed.mjs'
import {wbiSigner} from '../lib/wbi.mjs'

const ranks = {
  all:[0,'all'], original:[0,'origin'], rookie:[0,'rookie'], douga:[1005,'all'],
  music:[1003,'all'], dance:[1004,'all'], game:[1008,'all'], knowledge:[1010,'all'],
  technology:[1012,'all'], sports:[1018,'all'], car:[1013,'all'], life:[160,'all'],
  food:[1020,'all'], animal:[1024,'all'], fashion:[1014,'all'], ent:[1002,'all'], cinephile:[1001,'all'],
}
const help = {
  popular:'热门视频：popular [--pn 1] [--ps 20（1–50）] [--json]',
  buzzwords:'热词图鉴（非搜索热搜）：buzzwords [--pn 1] [--ps 20（1–50）] [--json]',
  weekly:'每周必看：weekly [--number 正整数期号] [--json]；省略期号读期数列表',
  rank:`视频排行：rank [--type ${Object.keys(ranks).join('|')}] [--json]；不支持 --day（V2接口无此过滤）`,
  'user-info':'用户资料/投稿统计/关系统计：user-info <mid> [--w-webid access-id] [--json]',
  'user-videos':'用户投稿：user-videos <mid> [--pn 1] [--ps 30（1–50）] [--tid 0] [--keyword 词] [--order pubdate|click|stow] [--w-webid access-id] [--json]',
  'fav-remote':'远端收藏：fav-remote folders <mid> [--json] 或 fav-remote contents <media_id> [--pn 1] [--ps 20（1–50）] [--keyword 词] [--order mtime|view|pubtime] [--json]；fav --list 仅为本地记录',
  messages:'消息聚合：messages [unread|reply|at|like|all] [--json]；需要已有凭据，每类读取一页；更多回复/@页用 comment-digest --pages N',
}
const [command,...args] = process.argv.slice(2)
if (!help[command]) {console.error('未知只读命令');process.exit(2)}
if (args.length === 1 && ['--help','-h'].includes(args[0])) {console.log(help[command]);process.exit(0)}
const opts = Object.create(null), positional = []
function invalid(message) {throw Object.assign(new Error(`${message}\n${help[command]}`),{exitCode:2})}
function integer(value, label, {min=1,max=Number.MAX_SAFE_INTEGER}={}) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) invalid(`${label} 必须是 ${min}–${max} 的整数`)
  return Number(value)
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) invalid(`${label} 必须是正整数ID`)
  return value // IDs may exceed JS safe integers.
}
function choice(value,allowed,label) {if(!allowed.includes(value))invalid(`${label} 可选：${allowed.join('|')}`);return value}

try {
  for (let i=0;i<args.length;i++) {
    const a=args[i]
    if (!a.startsWith('--')) {positional.push(a);continue}
    const k=a.slice(2)
    if (Object.hasOwn(opts,k)) invalid('重复参数 --'+k)
    if (k==='json') opts[k]=true
    else {
      if (args[i+1]===undefined || args[i+1].startsWith('--')) invalid('参数缺值 --'+k)
      opts[k]=args[++i]
    }
  }
  const paged=['popular','buzzwords','user-videos'].includes(command) || (command==='fav-remote'&&positional[0]==='contents')
  const allowed={popular:[],buzzwords:[],weekly:['number'],rank:['type'],'user-info':['w-webid'],'user-videos':['tid','keyword','order','w-webid'],'fav-remote':['keyword','order'],messages:[]}[command]
  const keys=['json',...allowed,...(paged?['pn','ps']:[])]
  for (const k of Object.keys(opts))if(!keys.includes(k))invalid('不支持参数 --'+k)
  const pn=paged?integer(opts.pn??1,'pn'):undefined
  const ps=paged?integer(opts.ps??(command==='user-videos'?30:20),'ps',{max:50}):undefined
  let route, params={}, signed=false, mid, kinds
  if (['popular','buzzwords'].includes(command)) {
    if(positional.length)invalid('不接受位置参数')
    route=command==='popular'?'/x/web-interface/popular':'/x/v2/dm/buzzword/list'
    params=command==='popular'?{pn,ps,web_location:'333.934'}:{pn,ps,type_id:4}
    signed=command==='popular'
  } else if(command==='weekly') {
    if(positional.length)invalid('期号请用 --number')
    route='/x/web-interface/popular/series/'+(opts.number===undefined?'list':'one')
    params={web_location:'333.934'}
    if(opts.number!==undefined)params.number=integer(opts.number,'number')
    signed=true
  } else if(command==='rank') {
    if(positional.length)invalid('分类请用 --type')
    const category=choice(opts.type??'all',Object.keys(ranks),'type')
    const [rid,type]=ranks[category]
    route='/x/web-interface/ranking/v2';params={rid,type,web_location:'333.934'};signed=true
  } else if(['user-info','user-videos'].includes(command)) {
    if(positional.length!==1)invalid('需要一个 mid')
    mid=id(positional[0],'mid');params={mid}
    if(opts['w-webid']!==undefined) {
      if(!opts['w-webid'].trim())invalid('w-webid 不能为空')
      params.w_webid=opts['w-webid']
    }
    route=command==='user-info'?'/x/space/wbi/acc/info':'/x/space/wbi/arc/search';signed=true
    if(command==='user-videos')Object.assign(params,{pn,ps,tid:integer(opts.tid??0,'tid',{min:0}),keyword:opts.keyword??'',order:choice(opts.order??'pubdate',['pubdate','click','stow'],'order'),order_avoided:true,platform:'web'})
  } else if(command==='fav-remote') {
    if(positional.length!==2)invalid('需要 folders <mid> 或 contents <media_id>')
    const kind=choice(positional[0],['folders','contents'],'收藏操作'), value=id(positional[1],'收藏ID')
    if(kind==='folders') {
      if(Object.keys(opts).some(k=>k!=='json'))invalid('folders 仅接受 --json')
      route='/x/v3/fav/folder/created/list-all';params={up_mid:value,web_location:'333.1387'}
    } else {
      route='/x/v3/fav/resource/list';params={media_id:value,pn,ps,keyword:opts.keyword??'',order:choice(opts.order??'mtime',['mtime','view','pubtime'],'order'),type:0,tid:0,platform:'web',web_location:'333.1387'}
    }
  } else {
    if(positional.length>1)invalid('只接受一种消息分类')
    const kind=choice(positional[0]??'all',['unread','reply','at','like','all'],'消息分类')
    kinds=kind==='all'?['unread','reply','at','like']:[kind]
  }

  const cred=fs.existsSync(CRED_PATH)?loadCred():{}
  if(command==='messages'&&!cred.sessdata)throw Error('消息读取需要已有登录凭据（SESSDATA）')
  const headers=makeHeaders(cred)
  if(!cred.sessdata)delete headers.cookie
  async function get(route,params={},sign=false) {
    const query=sign?sign(params):new URLSearchParams(params).toString()
    const r=await fetch('https://api.bilibili.com'+route+(query?'?'+query:''),{headers})
    if(!r.ok)throw Error(`${route} HTTP ${r.status}`)
    let result
    try{result=await r.json()}catch{throw Error(`${route} 响应不是JSON`)}
    if(!result||result.code!==0)throw Error(`${route} 响应失败 code=${result?.code??'missing'} ${result?.message??''}`)
    if(result.data===null||typeof result.data!=='object')throw Error(`${route} 响应缺少data`)
    return result.data
  }
  let sign
  if(signed) {
    const nav=await get('/x/web-interface/nav')
    if(!nav.wbi_img?.img_url||!nav.wbi_img?.sub_url)throw Error('nav 响应缺少WBI签名材料')
    sign=wbiSigner({data:nav})
  }
  let data
  if(command==='messages') {
    data={}
    for(const kind of kinds)data[kind]=await get('/x/msgfeed/'+kind)
  } else {
    data=await get(route,params,sign)
    if(command==='user-info')data={info:data,upstat:await get('/x/space/upstat',{mid}),relation:await get('/x/relation/stat',{vmid:mid})}
  }
  if(!opts.json)console.log(help[command].split('：')[0])
  console.log(JSON.stringify(data,null,2))
} catch(e) {
  console.error(e.message)
  process.exitCode=e.exitCode??3
}
