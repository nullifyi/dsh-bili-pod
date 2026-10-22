// 女主人通道（2026-10-22 主人要求）：路由拒绝 / 草稿允许 / 配置文件位置。
// 只验证「谁允许被发给」这一层 —— 真发要真账号，离线测试不碰网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const NODE = process.execPath

function sandbox(t, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pod-mistress-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, '.dsh')
  fs.mkdirSync(path.join(home, '.bili-ai'), { recursive: true })
  fs.mkdirSync(dsh, { recursive: true })
  const cfgPath = path.join(dsh, 'pod.config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ owner: { mid: '1', name: '主人' }, ...config }))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, BILI_POD_CONFIG: cfgPath, BILI_POD_WORK: path.join(dsh, 'pod-work'), BILI_POD_DIARY: path.join(dsh, 'pod-diary'), BILI_NO_CACHE: '1' }
  return { home, dsh, env }
}

function run(t, env, args) {
  return spawnSync(NODE, [path.join(ROOT, 'tools', 'commands', args[0] + '.mjs'), ...args.slice(1)], { env, encoding: 'utf8', timeout: 30000 })
}

test('dm --to only accepts the owner and the enabled mistress', (t) => {
  const { env } = sandbox(t, { mistress: { enabled: true, mid: '900', name: '太太' } })
  const bad = run(t, env, ['dm', '--to', '123456', '--msg', 'hi', '--go'])
  assert.equal(bad.status, 7)
  assert.match(bad.stdout + bad.stderr, /主人|女主人/)
})

test('dm --to the mistress is allowed to reach the network stage (no credentials → clear error)', (t) => {
  const { env } = sandbox(t, { mistress: { enabled: true, mid: '900', name: '太太' } })
  const r = run(t, env, ['dm', '--to', '900', '--msg', 'hi', '--go'])
  // 没有凭据 / 审核闸都算「路径通了但前置条件不满足」：只要不是「不认识这个收信人」的 exit 7
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.stdout + r.stderr, /不认识的收信人/)
})

test('reply-draft accepts a draft for the mistress, rejects a random uid', (t) => {
  const { env } = sandbox(t, { mistress: { enabled: true, mid: '900', name: '太太' } })
  const ok = run(t, env, ['reply-draft', 'add', '--kind', 'dm', '--to', '900', '--message', '太太晚上好', '--src', 'BV1test'])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const bad = run(t, env, ['reply-draft', 'add', '--kind', 'dm', '--to', '777', '--message', 'x', '--src', 'BV1test'])
  assert.equal(bad.status, 2)
})

test('mistress disabled → her mid is not a valid recipient', (t) => {
  const { env } = sandbox(t, { mistress: { enabled: false, mid: '900', name: '太太' } })
  const r = run(t, env, ['dm', '--to', '900', '--msg', 'hi', '--go'])
  assert.equal(r.status, 7)
})
