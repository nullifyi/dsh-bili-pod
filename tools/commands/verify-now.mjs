#!/usr/bin/env node
// 复核「我们发出去的评论，现在公开可见没有」。
//
//   node tools/bili.mjs verify                 # 复核最近最多 6 条（跳过 7 天内已确认可见的）
//   node tools/bili.mjs verify --max 3         # 少查几条
//   node tools/bili.mjs verify --rpid 123456   # 只查某一条（comment.mjs --verify 就是调这个）
//   node tools/bili.mjs verify --json          # 机器可读
//
// 纪律（和 ① 一致）：看不到 ≠ 没发出去。结论只有两种 ——「公开可见」/「没查到」。
import { readSent, verifyOne, verifyRecent, readCred } from '../../lib/verifycomments.mjs'

const argv = process.argv.slice(2)
const get = (k, d = null) => {
  const i = argv.indexOf('--' + k)
  if (i < 0) return d
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const JSON_OUT = argv.includes('--json')
const cred = readCred()
if (!cred) {
  console.error('⚠️ 还没有登录凭据（~/.bili-ai/credentials.json）—— 复核要用你自己的登录态。')
  console.error('   先在 设置 → 鲸群 → 扫码登录（或 bili.mjs login）之后再来。')
  process.exit(3)
}

const rpid = get('rpid')
if (rpid) {
  const db = readSent()
  const rec = db.items.find((x) => String(x.rpid) === String(rpid))
  if (!rec) { console.error(`待复核清单里没有 rpid=${rpid}`); process.exit(2) }
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const headers = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}`,
  }
  const res = await verifyOne(rec, { headers, aidCache: new Map() })
  if (JSON_OUT) console.log(JSON.stringify(res, null, 2))
  else {
    console.log(`rpid=${res.rpid} · ${res.bvid || rec.oid} → ${res.visible === true ? '公开可见' : '没查到'}`)
    console.log(`  依据：${res.how}${res.note ? ' · ' + res.note : ''}`)
  }
  process.exit(res.visible === true ? 0 : 4)
}

const max = Number(get('max', 6)) || 6
const out = await verifyRecent({ max, cred, log: (s) => console.error('· ' + s) })
if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
else console.log(out.text.trim() || '（没有可复核的）')
process.exit(0)
