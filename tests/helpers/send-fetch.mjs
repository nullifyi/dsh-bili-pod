import fs from 'node:fs'
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ url: u, method: opts.method ?? 'GET', body: opts.body ?? '', cookie: opts.headers?.cookie ?? '' }) + '\n')
  let data
  if (u.includes('/nav')) data = { code: 0, data: { isLogin: true, mid: 111, uname: 'offline-account' } }
  else if (u.includes('/reply/add')) {
    if (process.env.TEST_POST === 'uncertain') throw new Error('offline connection dropped after write')
    if (process.env.TEST_VERIFY === 'accounting') fs.mkdirSync(process.env.USERPROFILE + '/.bili-ai/quota.json')
    data = process.env.TEST_POST === 'reject' ? { code: -101 } : { code: 0, data: { rpid_str: '9007199254740993' } }
  } else if (u.includes('/reply/reply')) {
    if (process.env.TEST_VERIFY && opts.headers?.cookie) {
      const base = process.env.USERPROFILE + '/.bili-ai/'
      const ready = !!(JSON.parse(fs.readFileSync(base + 'quota.json')).log.length && JSON.parse(fs.readFileSync(base + 'replied.json')).byUid['333'].length && JSON.parse(fs.readFileSync(base + 'pod-sent.json')).items.length)
      fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({ event: 'verification-accounting', ready }) + '\n')
      if (!ready) throw new Error('accounting must precede observation')
      if (process.env.TEST_VERIFY === 'hang') return new Promise(() => {})
      throw new Error('offline verification error after accepted send')
    }
    data = { code: 0, data: { root: { rpid_str: '2', mid: 333, member: { mid: 333, uname: 'root-author' } }, replies: [] } }
  }
  else throw new Error('Offline test forbids URL: ' + u)
  return { status: 200, ok: true, json: async () => data, text: async () => JSON.stringify(data) }
}
