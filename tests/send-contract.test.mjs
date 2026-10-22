import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
function sandbox(t, cfg = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-send-contract-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'fake-dsh')
  fs.mkdirSync(dsh); fs.mkdirSync(path.join(home, '.bili-ai'))
  const config = path.join(dsh, 'pod.config.json')
  fs.writeFileSync(config, JSON.stringify({ owner: { mid: '333', name: 'Owner' }, listen: { oncePerPerson: true, comment: false }, review: { preReview: true, verify: false }, notify: { type: 'none' }, ...cfg }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'FAKE-OFFLINE', bili_jct: 'a'.repeat(32), buvid3: 'fake' }))
  return { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_POD_CONFIG: config, BILI_POD_WORK: path.join(dsh, 'work'), BILI_POD_DIARY: path.join(dsh, 'diary'), BILI_POD_SCOPE: 'off', TEST_REQUESTS: path.join(home, 'requests.jsonl'), NODE_OPTIONS: '--import=' + pathToFileURL(path.join(repo, 'tests/helpers/send-fetch.mjs')).href }
}
function run(env, file, args = []) {
  const r = spawnSync(process.execPath, [path.join(repo, file), ...args], { env, encoding: 'utf8', timeout: 30000 })
  assert.ifError(r.error)
  return r
}
const comment = ['comment', '--oid', '1', '--bvid', 'BV1234567890', '--root', '2', '--parent', '2', '--message', 'offline reply', '--go']
const posts = env => fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.method === 'POST') : []

test('default configuration remains isolated after a caller disables review and changes arrays', async () => {
  const { normalizeConfig, DEFAULTS } = await import('../lib/defaults.mjs')
  const a = normalizeConfig({}).config
  a.review.preReview = false; a.preferences.like.push('private-only')
  assert.equal(normalizeConfig({}).config.review.preReview, true)
  assert.equal(DEFAULTS.preferences.like.includes('private-only'), false)
})
for (const variant of ['root-only', 'reviewed', 'owner']) test('actual CLI requires host approval for ' + variant, t => {
  const env = sandbox(t)
  const args = variant === 'root-only' ? comment.filter((x, i) => x !== '--parent' && comment[i - 1] !== '--parent') : [...comment, ...(variant === 'reviewed' ? ['--reviewed'] : [])]
  const r = run(env, 'tools/bili.mjs', args)
  assert.equal(r.status, 7, r.stdout + r.stderr)
  assert.equal(posts(env).length, 0)
})
test('actual CLI recognizes data.root author and preserves normalized coordinates with review off', t => {
  const env = sandbox(t, { review: { preReview: false, verify: false } })
  const r = run(env, 'tools/bili.mjs', comment.filter((x, i) => x !== '--parent' && comment[i - 1] !== '--parent'))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(posts(env).length, 1)
  assert.equal(new URLSearchParams(posts(env)[0].body).get('parent'), '2')
  // 2026-10-22（上游 v0.4.5 语义）：被回复的是「主人本人」→ 不记 once-per-person、也不进 replied.json ✓
  const repliedPath = path.join(env.HOME, '.bili-ai/replied.json')
  const replied = fs.existsSync(repliedPath) ? JSON.parse(fs.readFileSync(repliedPath)) : { byUid: {} }
  assert.equal((replied.byUid['333'] ?? []).length, 0)
})
for (const scenario of ['draft', 'approval', 'host-timeout', 'host-receipt', 'host-uncertain', 'host-rejected', 'verify', 'scheduler-verify', 'scheduler-legacy-not-found', 'credentials-bom', 'verify-send-error', 'verify-send-hang', 'verify-send-accounting', 'sent-race', 'stale-lock', 'ledger']) test('offline contract: ' + scenario, t => {
  const r = run(sandbox(t), 'tests/helpers/send-contract-worker.mjs', [scenario])
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
