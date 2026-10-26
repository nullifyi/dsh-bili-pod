import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCredentialStore, parseManualCookie } from '../lib/credentials.js'
const cookies={sessdata:'fixture-session-not-real',bili_jct:'a'.repeat(32),buvid3:''}
function storeFixture(t, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'credentials.json'), pending = path.join(dir, 'pending-replies.json')
  fs.writeFileSync(file, JSON.stringify(cookies))
  const store = createCredentialStore({ file, pending, verify, protect: () => {} })
  return { file, pending, store }
}
test('failed verification and cancelled save preserve old credentials', async t => {
  const f = storeFixture(t, async () => { throw Error('登录验证失败') })
  await assert.rejects(f.store.save({ ...cookies, sessdata: 'new-valid-fixture-session' }), /验证/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  const next = createCredentialStore({ file: f.file, pending: f.pending, verify: async () => ({ mid: '111', name: 'ok' }), protect: () => {} })
  await assert.rejects(next.save(cookies, { check() { throw Error('cancelled') } }), /cancelled/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
})
test('pending drafts block cross-account or unverifiable-account replacement but permit same account', async t => {
  const next = { ...cookies, sessdata: 'new-valid-fixture-session' }
  let oldMid = '111'
  const f = storeFixture(t, async c => ({ mid: c.sessdata === cookies.sessdata ? oldMid : '222', name: 'ok' }))
  fs.writeFileSync(f.pending, JSON.stringify({ items: [{ id: 'old' }] }))
  await assert.rejects(f.store.save(next), /待审/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  oldMid = '222'
  await f.store.save(next)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).sessdata, next.sessdata)
})
test('atomic persistence failure leaves the original file and removes temporary credentials', async t => {
  const f = storeFixture(t, async () => ({ mid: '111', name: 'ok' }))
  const broken = createCredentialStore({ file: f.file, pending: f.pending, verify: async () => ({ mid: '111', name: 'ok' }), protect() { throw Error('permissions failed') } })
  await assert.rejects(broken.save({ ...cookies, sessdata: 'new-valid-fixture-session' }), /保存/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), cookies)
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['credentials.json'])
})
test('manual import accepts existing paste formats without weakening required fields', () => {
  assert.deepEqual(parseManualCookie({ sessdata: `SESSDATA=${cookies.sessdata}; bili_jct=${cookies.bili_jct}`, bili_jct: cookies.bili_jct }), cookies)
  assert.throws(() => parseManualCookie({ sessdata: 'short', bili_jct: 'bad' }), /凭据/)
})

