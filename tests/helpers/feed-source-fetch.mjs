process.env.BILI_TRAFFIC_TEST='1'
import fs from 'node:fs'
globalThis.fetch=async(input,opts={})=>{const u=new URL(input);if(opts.method&&opts.method!=='GET')throw Error('read-only test forbids write');fs.appendFileSync(process.env.TEST_FEED_REQUESTS,u.pathname+u.search+'\n');let data
if(u.pathname.endsWith('/nav'))data={code:0,data:{wbi_img:{img_url:'https://i.example/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png'}}}
else if(u.pathname.endsWith('/feed/rcmd'))data={code:0,data:{item:[{goto:'av',bvid:'BV1234567891',title:'AI 账号推荐',duration:60,owner:{name:'UP'},stat:{view:600,danmaku:6}}]}}
else if(u.pathname.includes('/search/type'))data={code:0,data:{result:[{bvid:'BV1234567890',title:'AI 模型教程',duration:'1:00',danmaku:6,play:600,author:'UP'}]}}
else if(u.pathname.includes('/web-dynamic/'))data={code:0,data:{items:[]}}
else throw Error('unexpected feed endpoint '+u.pathname)
return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})}
