import {readRecommendations} from '../lib/recommend.mjs'
import {loadCred} from '../lib/cred.mjs'
import {makeHeaders} from '../lib/msgfeed.mjs'
const args=process.argv.slice(2),i=args.indexOf('--n'),limit=Number(i<0?20:args[i+1])
try{let headers={'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/'};try{headers=makeHeaders(loadCred())}catch{};const videos=await readRecommendations({headers,limit});console.log(JSON.stringify({ok:true,source:'recommend',count:videos.length,videos},null,2))}catch(e){console.error(e.message);process.exitCode=3}
