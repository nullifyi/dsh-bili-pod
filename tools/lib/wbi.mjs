// Existing search/whois WBI algorithm, shared with the readonly GET commands.
import crypto from 'node:crypto'
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const clean = (v) => String(v).replace(/[!'()*]/g, '')

export function wbiSigner(nav) {
  const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  return (params) => {
    const wts = Math.round(Date.now() / 1000)
    const q = Object.keys({ ...params, wts }).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
    return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
  }
}
