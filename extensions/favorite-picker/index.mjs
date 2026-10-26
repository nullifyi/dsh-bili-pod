import {apiGet as readApi} from '../../tools/lib/bili-api.mjs'
import {readCredential} from '../../lib/login.mjs'
export async function loadFolders({apiGet=readApi,credential=readCredential()}={}) {
  if(!credential?.sessdata)throw Error('尚未登录，请先在登录页扫码')
  const headers={'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',cookie:'SESSDATA='+credential.sessdata+'; bili_jct='+(credential.bili_jct??'')+'; buvid3='+(credential.buvid3??'')}
  const nav=await apiGet('https://api.bilibili.com/x/web-interface/nav',headers)
  if(nav.code!==0||!nav.data?.isLogin||!nav.data?.mid)throw Error('登录已失效或登录验证失败，请重新登录')
  const result=await apiGet('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid='+encodeURIComponent(String(nav.data.mid)),headers)
  if(result.code!==0)throw Error('收藏夹读取失败：'+String(result.message??result.code))
  if(!Array.isArray(result.data?.list))throw Error('收藏夹列表格式不正确，请稍后重试')
  return {options:[{value:'',label:'默认收藏夹'},...result.data.list.filter(f=>!f.mid||String(f.mid)===String(nav.data.mid)).map(f=>({value:String(f.id),label:String(f.title??f.id)+'（'+Number(f.media_count??0)+' 条）'}))]}
}
export default {setup(pod){pod.route('/folders',()=>loadFolders())}}
