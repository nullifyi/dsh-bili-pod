#!/usr/bin/env node
// 扫码登录（照 dsh-bili-scroll 的流程，二维码在终端里画，不依赖 python / 图片库）
//
//   node tools/bili.mjs login            # 画二维码 → 手机 B 站扫 → 自动保存凭据
//   node tools/bili.mjs login status      # 看当前凭据是哪个号（只读）
//
// 为什么要扫码：SESSDATA 是 HttpOnly，F12 里复制得到但容易复制错/过期。
// 扫一扫拿到的 cookie 是完整的（含 bili_jct / DedeUserID / buvid3）。
// 凭据写到 ~/.bili-ai/credentials.json（0600），与基座共用同一个文件。
import { loginStart, loginPoll, saveCredential, fetchSelf, credentialState, readCredential } from '../../lib/login.mjs'
import { qrAscii } from '../../lib/qr.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'qr'

if (sub === 'status') {
  const st = credentialState()
  console.log(`凭据文件：${st.present ? '有' : '没有'}`)
  console.log(`  SESSDATA ${st.hasSess ? '✓' : '✗'}   bili_jct ${st.hasJct ? '✓' : '✗'}   buvid3 ${st.hasBuvid ? '✓' : '✗'}`)
  const cred = readCredential()
  if (!cred) { console.log('  → 还没登录：跑 `bili.mjs login`，或在设置页点「扫码登录」'); process.exit(0) }
  const self = await fetchSelf(cred)
  if (self) console.log(`  → 当前号：${self.name}（mid ${self.mid}）`)
  else console.log('  → 凭据在，但这会儿查不到登录态（网络 / cookie 过期）')
  process.exit(0)
}

let start = null
try { start = await loginStart() } catch (e) { console.error(String(e?.message ?? e)); process.exit(3) }
if (!start?.key) { console.error('拿不到二维码（passport 接口失败），稍后再试'); process.exit(3) }
console.log('手机 B 站 → 扫一扫，扫下面这个码：\n')
console.log(qrAscii(start.url, { margin: 1 }))
console.log('\n（也可以把这条链接发到手机：' + start.url + '）')
console.log('有效期 180 秒，扫完在手机上点「确认登录」。等待中…\n')

const deadline = Date.now() + 180_000
let last = ''
let ok = null
while (Date.now() < deadline) {
  const r = await loginPoll(start.key)
  if (r.state !== last) {
    last = r.state
    if (r.state === 'waiting') console.log('  · 还没扫')
    if (r.state === 'scanned') console.log('  · 扫到了，等你在手机上点确认')
    if (r.state === 'expired') console.log('  · 二维码过期了')
  }
  if (r.state === 'ok' && r.credential) { ok = r.credential; break }
  if (r.state === 'expired') break
  await new Promise((res) => setTimeout(res, 2000))
}

if (!ok) {
  console.error('\n没登上（超时或过期）。再跑一次 `bili.mjs login` 就行。')
  process.exit(4)
}
await saveCredential(ok)
const self = await fetchSelf(ok)
if (self) {
  console.log(`\n✅ 登录成功：${self.name}（mid ${self.mid}）`)
  console.log('   凭据已写入 ~/.bili-ai/credentials.json（0600）')
  console.log('   下一步：确认 设置 → 鲸群 → 「她是谁」里主人 mid 填的就是接收 @ 的那个号。')
} else {
  console.log('\n✅ 凭据已保存，但这会儿没查到昵称（不影响使用，连上之后会自动补）')
}
process.exit(0)
