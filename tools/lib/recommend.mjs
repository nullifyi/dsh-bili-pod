import { apiGet } from './bili-api.mjs'
export async function readRecommendations({headers={},limit=20,request=apiGet}={}) {
 if(!Number.isInteger(limit)||limit<1||limit>30)throw Error('推荐数量必须为1–30的整数')
 const u=new URL('https://api.bilibili.com/x/web-interface/index/top/feed/rcmd')
 u.search=new URLSearchParams({fresh_type:'3',ps:String(limit),fresh_idx:'1',fresh_idx_1h:'1',web_location:'1430650'}).toString()
 const j=await request(u.href,headers)
 if(j.code!==0||!Array.isArray(j.data?.item??j.data))throw Error('首页推荐读取失败：'+String(j.message??j.code))
 return (j.data.item??j.data).filter(x=>(!x.goto||x.goto==='av')&&/^BV[0-9A-Za-z]{10}$/.test(x.bvid??'')).slice(0,limit).map(x=>({bvid:x.bvid,title:String(x.title??'').replace(/<[^>]+>/g,''),author:x.owner?.name??'',duration:Number(x.duration??0),play:Number(x.stat?.view??0),danmaku:Number(x.stat?.danmaku??0),reason:String(x.rcmd_reason?.content??'')}))
}
