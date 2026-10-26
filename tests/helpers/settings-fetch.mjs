process.env.BILI_TRAFFIC_TEST='1' // Fake-network fixtures only.
import fs from 'node:fs'
globalThis.fetch=async(url,opts={})=>{
  const u=String(url);fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:u,method:opts.method??'GET',body:opts.body??''})+'\n')
  let data
  if(u.includes('/nav'))data={code:0,data:{isLogin:true,mid:111,uname:'offline',wbi_img:{img_url:'https://fake/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://fake/abcdefghijklmnopqrstuvwxyz012345.png'}}}
  else if(u.includes('/search/type'))data={code:0,data:{result:[]}}
  else if(u.includes('/folder/created/'))data={code:0,data:{list:[{id:9,title:'默认收藏夹'},{id:42,title:'学习'}]}}
  else if(u.includes('/web-interface/view'))data={code:0,data:{aid:1,title:'Offline tutorial',owner:{name:'offline'}}}
  else if(u.includes('/fav/resource/deal'))data={code:0}
  else if(u.includes('/relation'))data={code:0,data:{attribute:Number(process.env.TEST_RELATION_ATTRIBUTE??6)}}
  else if(u.includes('/send_msg')){if(process.env.TEST_DM_DELAY)await new Promise(r=>setTimeout(r,100));if(process.env.TEST_DM_UNCERTAIN)throw Error('offline unknown send');data={code:0,data:{}}}
  else if(u.includes('/reply/add'))data={code:0,data:{rpid_str:'9007199254740993'}}
  else throw Error('Network blocked: '+u)
  return {ok:true,status:200,json:async()=>data}
}
