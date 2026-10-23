// 0.7.0 的审核档 / 私信正文 / 状态目录：纯函数与临时目录，不起插件、不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reviewDecision, policyOf, needsPolicyMigration, reserveAuto, autoBudget, settleAuto, inQuietHours, DEFAULT_AUTO_LIMITS } from '../lib/policy.mjs'
import { buildDmMessage, bvidsIn, DM_MAX } from '../lib/dm-message.mjs'
import { stateDir, statePath, migrateState, STATE_FILES } from '../lib/state-dir.mjs'

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pod-policy-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }

test('policyOf：显式档位优先；旧配置（只有 preReview）按主人要求进第三档 auto-quiet', () => {
  assert.equal(policyOf({ review: { policy: 'ask' } }), 'ask')
  assert.equal(policyOf({ review: { policy: 'off' } }), 'off')
  assert.equal(policyOf({ review: { preReview: false } }), 'off')
  assert.equal(policyOf({ review: { preReview: true } }), 'auto-quiet', '旧配置不该静默变成「每次都问」')
  assert.equal(policyOf({}), 'auto-quiet')
  assert.equal(needsPolicyMigration({ review: { preReview: true } }), true)
  assert.equal(needsPolicyMigration({ review: { policy: 'ask' } }), false)
})

test('ask：连回主人都要审', () => {
  const d = reviewDecision({ kind: 'comment', role: 'owner', relationship: 'mutual', cfg: { review: { policy: 'ask' } } })
  assert.equal(d.required, true)
  assert.equal(d.auto, false)
})

test('auto-owner：主人免审，别人要审', () => {
  const cfg = { review: { policy: 'auto-owner' } }
  assert.equal(reviewDecision({ kind: 'comment', role: 'owner', relationship: 'mutual', cfg }).required, false)
  assert.equal(reviewDecision({ kind: 'comment', role: 'stranger', relationship: 'none', cfg }).required, true)
})

test('auto-quiet：互关/关注者免审，陌生人要审', () => {
  const cfg = { review: { policy: 'auto-quiet' } }
  assert.equal(reviewDecision({ kind: 'comment', role: 'stranger', relationship: 'mutual', cfg }).required, false)
  assert.equal(reviewDecision({ kind: 'comment', role: 'stranger', relationship: 'fan', cfg }).required, false)
  assert.equal(reviewDecision({ kind: 'comment', role: 'stranger', relationship: 'none', cfg }).required, true)
  assert.equal(reviewDecision({ kind: 'comment', role: 'stranger', relationship: 'unknown', cfg }).required, true, '关系查不到要 fail-closed')
})

test('静音时段：本该自动的消息也转成草稿', () => {
  const now = new Date('2026-10-22T14:00:00') // 本地 14:00
  const cfg = { review: { policy: 'auto-quiet', autoLimits: { quietHours: [{ start: '13:30', end: '14:30' }] } } }
  const d = reviewDecision({ kind: 'comment', role: 'owner', relationship: 'mutual', cfg, now })
  assert.equal(d.required, true)
  assert.equal(d.quiet, true)
  assert.ok(inQuietHours([{ start: '23:00', end: '07:00' }], new Date('2026-10-22T02:00:00')), '跨午夜也要算')
})

test('私信：autoSend 关着就一律进草稿；开着还要看 autoSendTo 名单', () => {
  const base = { review: { policy: 'auto-owner' } }
  assert.equal(reviewDecision({ kind: 'dm', role: 'owner', cfg: base }).required, true, '默认 autoSend=false')
  const on = { ...base, dm: { autoSend: true, autoSendTo: ['owner'] } }
  assert.equal(reviewDecision({ kind: 'dm', role: 'owner', cfg: on }).required, false)
  assert.equal(reviewDecision({ kind: 'dm', role: 'mistress', cfg: on }).required, true, '名单里没有女主人')
  const both = { ...base, dm: { autoSend: true, autoSendTo: ['owner', 'mistress'] } }
  assert.equal(reviewDecision({ kind: 'dm', role: 'mistress', cfg: both }).required, false)
})

test('policy=off：连私信也不再走审核（主人自己关掉了闸）', () => {
  assert.equal(reviewDecision({ kind: 'dm', role: 'owner', cfg: { review: { policy: 'off' } } }).required, false)
})

test('自动额度：按天计数、超额拒绝、幂等结算', (t) => {
  const dir = tmp(t)
  const limits = { perDay: 2, perPersonPerDay: 1, quietHours: [] }
  const now = Date.now()
  assert.equal(reserveAuto(dir, { opId: 'a', kind: 'comment', mid: '1', now, limits }).ok, true)
  assert.equal(reserveAuto(dir, { opId: 'a', kind: 'comment', mid: '1', now, limits }).ok, true, '同一个 opId 重复预留是幂等的')
  assert.equal(reserveAuto(dir, { opId: 'b', kind: 'comment', mid: '1', now, limits }).ok, false, '同一个人当天只自动一次')
  assert.equal(reserveAuto(dir, { opId: 'c', kind: 'comment', mid: '2', now, limits }).ok, true)
  assert.equal(reserveAuto(dir, { opId: 'd', kind: 'comment', mid: '3', now, limits }).ok, false, '超当天总量')
  assert.equal(autoBudget(dir, now).total, 2)
  assert.ok(settleAuto(dir, 'a', 'accepted'), '结算返回被结算的那一条')
  assert.equal(settleAuto(dir, 'zzz', 'accepted'), null, '没有这条记录就不该成功')
  assert.equal(autoBudget(dir, now).total, 2, '结算不改变已用数')
  assert.equal(DEFAULT_AUTO_LIMITS.perDay, 12)
})

test('私信正文：分享必须带视频链接，缺了补上、超长不截断', () => {
  const ok = buildDmMessage({ message: '这条真好', bvid: 'BV1xx411c7mD', share: true })
  assert.equal(ok.ok, true)
  assert.match(ok.text, /https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD\//)
  assert.equal(ok.addedUrl, true)

  const has = buildDmMessage({ message: `看 https://www.bilibili.com/video/BV1xx411c7mD/ 好看`, bvid: 'BV1xx411c7mD', share: true })
  assert.equal(has.ok, true)
  assert.equal(has.addedUrl, false, '已经有链接就不再补')

  const wrong = buildDmMessage({ message: '看 https://www.bilibili.com/video/BV1yy411c7mD/', bvid: 'BV1xx411c7mD', share: true })
  assert.equal(wrong.ok, false, '正文里的 BV 和要分享的不是同一条 → 拒')

  const noBv = buildDmMessage({ message: '没有视频号', share: true })
  assert.equal(noBv.ok, false)

  const long = buildDmMessage({ message: '长'.repeat(DM_MAX + 10), share: false })
  assert.equal(long.ok, false, '超长报错而不是悄悄截断')

  const plain = buildDmMessage({ message: '晚安，早点睡。' })
  assert.equal(plain.ok, true)
  assert.equal(plain.text, '晚安，早点睡。')
  assert.deepEqual(bvidsIn('a BV1xx411c7mD b BV1yy411c7mE'), ['BV1xx411c7mD', 'BV1yy411c7mE'])
})

test('状态目录：默认在 <pod-work>/state，BILI_POD_STATE 可覆盖', () => {
  assert.equal(stateDir('/x/pod-work'), path.join('/x/pod-work', 'state'))
  const old = process.env.BILI_POD_STATE
  try {
    process.env.BILI_POD_STATE = '/x/custom-state'
    assert.equal(stateDir('/x/pod-work'), '/x/custom-state')
    assert.equal(statePath('pending-replies.json', '/x/pod-work'), path.join('/x/custom-state', 'pending-replies.json'))
  } finally {
    if (old == null) delete process.env.BILI_POD_STATE
    else process.env.BILI_POD_STATE = old
  }
})

test('状态迁移：只搬白名单、目标已存在不覆盖、凭据和人设不动', (t) => {
  const home = tmp(t)
  const work = path.join(home, 'pod-work')
  const legacy = path.join(home, 'legacy')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'pending-replies.json'), '{"items":[1]}')
  fs.writeFileSync(path.join(legacy, 'quota.json'), '{"old":true}')
  fs.writeFileSync(path.join(legacy, 'credentials.json'), '{"sessdata":"x"}')
  fs.writeFileSync(path.join(legacy, 'persona.md'), '人设')
  fs.writeFileSync(path.join(legacy, 'not-a-state-file.txt'), 'x')
  fs.mkdirSync(stateDir(work), { recursive: true })
  fs.writeFileSync(path.join(stateDir(work), 'quota.json'), '{"keep":true}')

  const res = migrateState({ workDir: work, legacyDir: legacy })
  assert.equal(fs.existsSync(path.join(stateDir(work), 'pending-replies.json')), true)
  assert.equal(fs.readFileSync(path.join(stateDir(work), 'quota.json'), 'utf8'), '{"keep":true}', '已有文件不能被旧数据覆盖')
  assert.equal(fs.existsSync(path.join(stateDir(work), 'credentials.json')), false, '凭据不搬')
  assert.equal(fs.existsSync(path.join(stateDir(work), 'persona.md')), false, '人设不搬')
  assert.equal(fs.existsSync(path.join(stateDir(work), 'not-a-state-file.txt')), false, '白名单外不搬')
  const manifest = JSON.parse(fs.readFileSync(path.join(stateDir(work), '_migrated.json'), 'utf8'))
  assert.ok(manifest.moved.includes('pending-replies.json'))
  assert.ok(manifest.skipped.includes('quota.json'))
  assert.ok(STATE_FILES.includes('auto-sent.json'))
  // 第二次跑不重复搬、也不报错
  const again = migrateState({ workDir: work, legacyDir: legacy })
  assert.equal(again.errors.length, 0, '重跑不该报错')
  assert.deepEqual(again.skipped.sort(), ['pending-replies.json', 'quota.json'].sort())
})

test('dmGapBlocks: 同话题续发不卡间隔，新话题按分钟数等', async () => {
  const { dmGapBlocks } = await import('../lib/policy.mjs')
  const now = Date.parse('2026-10-24T12:00:00Z')
  // 5 分钟前刚发过，间隔 30 分钟 → 新话题要等 25 分钟；同一话题/拆分续发立刻可发
  const last = now - 5 * 60000
  assert.deepEqual(dmGapBlocks({ lastAt: last, now, gapMin: 30 }), { blocked: true, leftMin: 25 })
  assert.deepEqual(dmGapBlocks({ lastAt: last, now, gapMin: 30, sameThread: true }), { blocked: false })
  // 间隔调成 0 / 没发过 / 时间坏掉 → 一律放行
  assert.deepEqual(dmGapBlocks({ lastAt: last, now, gapMin: 0 }), { blocked: false })
  assert.deepEqual(dmGapBlocks({ lastAt: NaN, now, gapMin: 30 }), { blocked: false })
  // 已经等够 → 放行
  assert.deepEqual(dmGapBlocks({ lastAt: now - 31 * 60000, now, gapMin: 30 }), { blocked: false })
})
