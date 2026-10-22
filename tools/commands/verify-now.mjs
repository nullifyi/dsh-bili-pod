#!/usr/bin/env node
// 复核本人登录下的评论观察结果；本页未查到不证明删除或未发送。
//
//   node tools/bili.mjs verify                 # 按间隔复核最多 6 条待确认记录
//   node tools/bili.mjs verify --max 3         # 少查几条
//   node tools/bili.mjs verify --rpid 123456   # 只查某一条（comment.mjs --verify 就是调这个）
//   node tools/bili.mjs verify --json          # 机器可读
//
// 缺失/网络异常可重试，达到次数上限后保留为未确认。
import { readSent, verifyRecorded, verifyRecent, readCred } from '../../lib/verifycomments.mjs'
import { config } from '../lib/config.mjs'

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
  const res = await verifyRecorded(rpid, { cred, review: config().review })
  if (JSON_OUT) console.log(JSON.stringify(res, null, 2))
  else {
    console.log(`rpid=${res.rpid} · ${res.bvid || rec.oid} → ${res.visible === true ? '本人登录可见' : '未确认（不代表未发出）'}`)
    console.log(`  依据：${res.how}${res.note ? ' · ' + res.note : ''}`)
  }
  // 2026-10-22 修：Node 24 + Windows 下 `process.exit()` 撞上 undici 正在关闭的
  //   套接字会触发 libuv 断言（handle->flags & UV_HANDLE_CLOSING）→ 退出码变 127 ✗
  //   复核本身已经成功，却让调用方以为失败。改成 exitCode + 自然退出 ✓
  process.exitCode = res.visible === true ? 0 : 4
} else {
  const max = Number(get('max', 6)) || 6
  const out = await verifyRecent({ max, cred, review: config().review, log: (s) => console.error('· ' + s) })
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
  else console.log(out.text.trim() || '（没有可复核的）')
  process.exitCode = 0
}
