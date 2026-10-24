import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = (t, tag = 'feat') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bili-pod-${tag}-`))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

// ── 配置归一 ────────────────────────────────────────────────────────────────
test('normalizeConfig clamps numbers and keeps unknown keys', async () => {
  const { normalizeConfig, DEFAULTS } = await import('../lib/defaults.mjs')
  const { config, warns } = normalizeConfig({
    night: { skipChance: 5, maxVideos: 99, mode: 'nonsense', windows: [{ start: '20:00', end: '22:00', wakes: 1 }] },
    quota: { shareDaily: 99 },
    review: { verifyIntervalSec: 1 },
    keepMe: { a: 1 },
  })
  assert.equal(config.night.skipChance, 0.95)
  assert.equal(config.night.maxVideos, 20)
  assert.equal(config.night.mode, 'fixed')
  assert.equal(config.quota.shareDaily, 20)
  assert.equal(config.review.verifyIntervalSec, 5)
  assert.equal(config.review.preReview, true)
  assert.equal(config.artifacts.enabled, false)
  assert.deepEqual(config.keepMe, { a: 1 })
  assert.equal(config.persona.ownerTitle, DEFAULTS.persona.ownerTitle)
  assert.ok(Array.isArray(warns))
})

test('zero wakes in fixed mode produces a warning', async () => {
  const { normalizeConfig } = await import('../lib/defaults.mjs')
  const { warns } = normalizeConfig({ night: { windows: [{ start: '20:00', end: '22:00', wakes: 0 }] } })
  assert.ok(warns.some((w) => w.includes('永远不会醒')))
})

// ── 峰谷作息 ────────────────────────────────────────────────────────────────
test('tide mode translates peak/valley into windows with per-window skip', async () => {
  const tide = await import('../lib/tide.mjs')
  const cfg = tide.applyTide({ mode: 'tide', tide: { ...tide.TIDE_DEFAULTS } })
  assert.equal(cfg.windowsMode, 'tide')
  assert.equal(cfg.windows.length, 2)
  const labels = cfg.windows.map((w) => `${w.start}–${w.end}`)
  assert.ok(labels.includes('19:00–23:00'))
  assert.ok(labels.includes('12:30–14:00'))
  // 峰：醒 2 次 / 跳过 0.1；谷：醒 1 次 / 跳过 0.6
  const peak = cfg.windows.find((w) => w.start === '19:00')
  const valley = cfg.windows.find((w) => w.start === '12:30')
  assert.equal(peak.wakes, 2)
  assert.equal(valley.wakes, 1)
  assert.equal(cfg.skipChanceFor({ label: '19:00–23:00' }), 0.1)
  assert.equal(cfg.skipChanceFor({ label: '12:30–14:00' }), 0.6)
  const preview = tide.previewTide({ mode: 'tide' })
  assert.equal(preview.length, 2)
  assert.ok(preview.every((w) => typeof w.skipChance === 'number'))
})

test('fixed mode passes windows through unchanged and keeps skipChance', async () => {
  const tide = await import('../lib/tide.mjs')
  const night = { mode: 'fixed', windows: [{ start: '09:00', end: '10:00', wakes: 3 }], skipChance: 0.25 }
  const cfg = tide.applyTide(night)
  assert.deepEqual(cfg.windows, night.windows)
  assert.equal(cfg.skipChanceFor({ label: 'whatever' }), 0.25)
})

test('tide windows are clipped to the active range', async () => {
  const tide = await import('../lib/tide.mjs')
  const wins = tide.tideWindows({ activeStart: '20:00', activeEnd: '22:00', valleyStart: '12:30', valleyEnd: '14:00' })
  // 谷完全落在清醒区间外 → 丢掉；峰 19:00–23:00 被剪成 20:00–22:00
  assert.equal(wins.length, 1)
  assert.equal(wins[0].start, '20:00')
  assert.equal(wins[0].end, '22:00')
})

test('tide keeps both clipped segments without multiplying the original wake budget', async () => {
  const { tideWindows } = await import('../lib/tide.mjs')
  for (const [wakesPeak, expected] of [[1, [1, 0]], [2, [1, 1]], [3, [2, 1]]]) {
    const wins = tideWindows({ activeStart: '00:00', activeEnd: '23:00', peakStart: '22:00', peakEnd: '02:00', wakesPeak, wakesValley: 0 })
    assert.deepEqual(wins.map(w => [w.start, w.end, w.wakes]), [['00:00', '02:00', expected[0]], ['22:00', '23:00', expected[1]]])
  }
})

// ── 日记文件夹 ──────────────────────────────────────────────────────────────
test('diary: write, archive, extract records and recall', async (t) => {
  const ds = await import('../lib/diarystore.mjs')
  const root = tmp(t, 'diary')
  const now = new Date('2026-10-22T10:00:00').getTime()
  ds.appendDaily(root, { day: '2026-10-20', text: '- [吐槽] 今天的推荐全是带货' })
  ds.appendDaily(root, { day: '2026-10-20', text: '- [思考] 显卡价格可能还要涨' })
  ds.appendDaily(root, { day: '2026-10-21', text: '- [学习] 学到了 PCIe 通道怎么分配' })
  ds.appendDaily(root, { day: '2026-10-22', text: '- [吐槽] 今天不想看，睡到中午' })
  ds.appendDaily(root, { day: '2026-10-20', kind: 'owner', text: '今天看到一条不错的片子' })

  const results = ds.archiveDue(root, { now, keepDays: 1 })
  const archived = results.filter((r) => r.archived).map((r) => r.day).sort()
  assert.deepEqual(archived, ['2026-10-20', '2026-10-21'])
  assert.ok(fs.existsSync(ds.layout(root).daily('2026-10-22')))

  // 分类记录：归档时摘出来
  const note = fs.readFileSync(ds.layout(root).record('吐槽'), 'utf8')
  assert.match(note, /带货/)
  const study = fs.readFileSync(ds.layout(root).record('学习'), 'utf8')
  assert.match(study, /PCIe/)
  // 总索引
  const idx = fs.readFileSync(ds.layout(root).indexPath, 'utf8')
  assert.match(idx, /INDEX|吐槽/)
  // 旧原文只在 recall 时出现
  const hits = ds.recall(root, { query: 'PCIe' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].day, '2026-10-21')
  const s = ds.summary(root, { now })
  assert.ok(s.kinds.length >= 2)
  assert.equal(s.todayDiary.includes('不想看'), true)
})

test('diary: appendRecord dedupes identical text on the same day', async (t) => {
  const ds = await import('../lib/diarystore.mjs')
  const root = tmp(t, 'diary2')
  ds.appendRecord(root, { kind: '吐槽', text: '同一句话', day: '2026-10-20' })
  ds.appendRecord(root, { kind: '吐槽', text: '同一句话', day: '2026-10-20' })
  const text = fs.readFileSync(ds.layout(root).record('吐槽'), 'utf8')
  assert.equal((text.match(/同一句话/g) ?? []).length, 1)
})

// ── 账本 ────────────────────────────────────────────────────────────────────
test('ledger: chain verifies and a tampered entry breaks it', async (t) => {
  const ledger = await import('../lib/ledger.mjs')
  const work = tmp(t, 'ledger')
  const a = ledger.appendRound({ root: work, mode: 'wake', title: '第一次醒', body: '看了三条视频' })
  const b = ledger.appendRound({ root: work, mode: 'verify', title: '复核', body: '两条可见' })
  assert.ok(a.hash && b.hash)
  assert.equal(ledger.verifyChain(work).ok, true)
  assert.equal(ledger.dayRounds(work).length, 2)
  // 链式校验靠「后一份的 prev」发现篡改；最后一份没有后继，只能靠账本外的人工核对，
  // 所以这里改的是第一份。
  fs.writeFileSync(a.file, fs.readFileSync(a.file, 'utf8').replace('看了三条视频', '看了三十条视频'), 'utf8')
  const bad = ledger.verifyChain(work)
  assert.equal(bad.ok, false)
  assert.ok(bad.broken.length >= 1)
})

test('ledger: unknown mode is rejected by the CLI contract', async () => {
  const ledger = await import('../lib/ledger.mjs')
  assert.ok(ledger.roundModes.includes('wake'))
  assert.ok(ledger.roundModes.includes('verify'))
  assert.ok(ledger.roundModes.includes('manual'))
})

// ── 权限单 ──────────────────────────────────────────────────────────────────
test('scope: wake round may favourite and draft, but not post a comment when sharing is off', async () => {
  const { scopeFor, checkCommand } = await import('../lib/scope.mjs')
  const scope = scopeFor({ reason: 'wake', config: { share: { enabled: false } } })
  assert.equal(checkCommand(scope, 'fav').ok, true)
  assert.equal(checkCommand(scope, 'reply-draft').ok, true)
  assert.equal(checkCommand(scope, 'watch').ok, true)
  const denied = checkCommand(scope, 'comment')
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /没有授权/)
})

test('scope: manual round is unrestricted; expired automatic scope denies writes; bypass wins', async () => {
  const { scopeFor, checkCommand } = await import('../lib/scope.mjs')
  const manual = scopeFor({ reason: 'manual', config: {} })
  assert.equal(checkCommand(manual, 'comment-del').ok, true)
  const stale = { active: true, reason: 'wake', at: new Date(Date.now() - 5 * 3600_000).toISOString(), allowWrite: ['fav'] }
  const r = checkCommand(stale, 'comment', { now: Date.now() })
  assert.equal(r.ok, false)
  assert.match(r.reason, /过期/)
  assert.equal(checkCommand(stale, 'comment', { bypass: true }).ok, true)
})

test('scope: optional write switches open dynamic/danmaku/delete', async () => {
  const { scopeFor, checkCommand } = await import('../lib/scope.mjs')
  const scope = scopeFor({ reason: 'manual', config: { scope: { allowDynamic: true, allowDanmaku: true, allowDelete: true } } })
  for (const cmd of ['dynamic', 'dynamic-image', 'danmaku', 'comment-del']) assert.equal(checkCommand(scope, cmd).ok, true)
})

// ── 扩展（mod）宿主 ─────────────────────────────────────────────────────────
test('extensions: load a mod, expose field/prompt/route, honour disabled flag', async (t) => {
  const { PodHost } = await import('../lib/extensions.mjs')
  const dir = tmp(t, 'ext')
  const work = tmp(t, 'extwork')
  fs.writeFileSync(path.join(dir, 'hello.mjs'), `
    export default {
      id: 'hello', name: 'Hello', version: '1.0.0', apiVersion: 1,
      async setup(pod) {
        pod.field({ path: ['extensions','items','hello','note'], label: '打个招呼', kind: 'text' })
        pod.addPromptSection({ id: 'hello/say', title: '招呼', text: () => '你今天也很准时' })
        pod.route('/ping', async () => ({ ok: true, pong: 1 }))
      },
    }
  `)
  let cfg = { extensions: { enabled: true, dirs: [], items: {} } }
  const host = new PodHost({ podId: 'dsh-bili-pod', workDir: work, dirs: [dir], readConfig: () => cfg, patchConfig: () => cfg })
  const list = await host.loadAll({ dirs: [dir] })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'hello')
  assert.equal(list[0].ok, true)
  assert.equal(host.fieldsForClient().length, 1)
  assert.match(host.promptText({}), /你今天也很准时/)
  assert.equal(host.routes.length, 1)
  assert.ok(fs.existsSync(host.registryFile))

  // 关掉之后：还在清单里，但不再执行 setup → 没有字段 / 提示段
  const h2 = new PodHost({ podId: 'dsh-bili-pod', workDir: work, dirs: [dir], readConfig: () => ({ extensions: { items: { hello: { enabled: false } } } }) })
  const list2 = await h2.loadAll({ dirs: [dir] })
  assert.equal(list2[0].enabled, false)
  assert.equal(h2.fieldsForClient().length, 0)
  assert.equal(h2.promptText({}), '')
})

// ── 低价时段（DeepSeek 折扣窗口）────────────────────────────────────────────
test('cheap mode: windows come from night.cheap, skip is per-window', async () => {
  const { normalizeConfig } = await import('../lib/defaults.mjs')
  const { applyTide } = await import('../lib/tide.mjs')
  const { config, warns } = normalizeConfig({ night: { mode: 'cheap', cheap: { wakes: 2, skipChance: 0.2 } } })
  assert.equal(config.night.mode, 'cheap')
  const night = applyTide(config.night, new Date('2026-10-23T03:00:00'))
  assert.equal(night.mode, 'cheap')
  // 低价窗口 + 配置里自定义窗口（默认 20:00–24:00）——「其他时间由自定义完成」
  assert.equal(night.windows.length, 2)
  assert.equal(night.windows[0].label, '低价 00:30–08:30')
  assert.equal(night.windows[0].wakes, 2)
  assert.equal(night.skipChanceFor(night.windows[0]), 0.2)
  assert.equal(night.windows[1].label, '自定义 20:00–24:00')
  assert.equal(night.skipChanceFor(night.windows[1]), 0.3)
  assert.ok(Array.isArray(warns))
})

test('cheap mode: isCheapNow / nextCheapAt / describeCheap', async () => {
  const { normalizeConfig } = await import('../lib/defaults.mjs')
  const { isCheapNow, nextCheapAt, describeCheap } = await import('../lib/pricing.mjs')
  const { config } = normalizeConfig({})
  assert.equal(isCheapNow(config, new Date('2026-10-23T02:00:00')), true)
  // 02:00Z 在 Asia/Shanghai 是 10:00，当然不是低价时段（窗口按本地时钟读）
  assert.equal(isCheapNow(config, new Date('2026-10-23T02:00:00Z')), false)
  assert.equal(isCheapNow(config, new Date('2026-10-23T16:00:00')), false)
  const next = nextCheapAt(config, new Date('2026-10-23T16:00:00'))
  assert.ok(next)
  assert.equal(next.getHours(), 0)
  assert.equal(next.getMinutes(), 30)
  assert.match(describeCheap(config), /00:30–08:30/)
})

test('cheap mode without windows falls back to the DeepSeek discount window', async () => {
  const { normalizeConfig } = await import('../lib/defaults.mjs')
  const { applyTide } = await import('../lib/tide.mjs')
  const { config } = normalizeConfig({ night: { mode: 'cheap', cheap: { windows: [] } } })
  assert.deepEqual(config.night.cheap.windows, [{ start: '00:30', end: '08:30' }])
  const night = applyTide(config.night, new Date())
  assert.ok(night.windows.length >= 1)
  assert.equal(night.windows[0].label, '低价 00:30–08:30')
})

// ── 女主人（第二位主人）────────────────────────────────────────────────────
test('mistress: normalisation, warnings and role separation', async () => {
  const { normalizeConfig } = await import('../lib/defaults.mjs')
  const on = normalizeConfig({ owner: { mid: '1', name: '主人' }, mistress: { enabled: true, mid: '2', name: '太太', shareDaily: 9, like: ['狗'] } })
  assert.equal(on.config.mistress.enabled, true)
  assert.equal(on.config.mistress.mid, '2')
  assert.equal(on.config.mistress.shareDaily, 9)
  assert.equal(normalizeConfig({ mistress: { shareDaily: 99 } }).config.mistress.shareDaily, 10)
  assert.deepEqual(on.config.mistress.like, ['狗'])
  assert.equal(on.config.mistress.title, '女主人')
  assert.deepEqual(on.warns, [])

  const bad = normalizeConfig({ mistress: { enabled: true, mid: 'abc' } }).warns
  assert.ok(bad.some((w) => w.includes('女主人')))
  const same = normalizeConfig({ owner: { mid: '7' }, mistress: { enabled: true, mid: '7' } }).warns
  assert.ok(same.some((w) => w.includes('一样')))
  const off = normalizeConfig({ mistress: { enabled: true, mid: '' } }).config
  assert.equal(off.mistress.mid, '')

  // 2026-10-22 追加：她发来的消息必须回，且回信不占「主动私信」额度（另有自己的日上限）
  const d = normalizeConfig({}).config.mistress
  assert.equal(d.replyAlways, true)
  assert.equal(d.replyMaxPerDay, 0)  // 0 = 不限
  assert.equal(d.splitLong, true)
  assert.equal(d.styleNotes, '')
  const clamped = normalizeConfig({ mistress: { replyMaxPerDay: 500, replyAlways: false } }).config.mistress
  assert.equal(clamped.replyMaxPerDay, 100)
  const unlimited = normalizeConfig({ mistress: { replyMaxPerDay: -5 } }).config.mistress
  assert.equal(unlimited.replyMaxPerDay, 0)
  assert.equal(clamped.replyAlways, false)
})

test('taste: selfAdjust and learnFromInterest default on, and survive merge', async () => {
  const { DEFAULTS, normalizeConfig } = await import('../lib/defaults.mjs')
  assert.equal(DEFAULTS.preferences.selfAdjust, true)
  assert.equal(DEFAULTS.preferences.learnFromInterest, true)
  const { config } = normalizeConfig({ preferences: { selfAdjust: false } })
  assert.equal(config.preferences.selfAdjust, false)
  assert.equal(config.preferences.learnFromInterest, true)
  // 默认值必须是拷贝：改一份不能污染 DEFAULTS
  config.preferences.selfAdjust = true
  assert.equal(DEFAULTS.preferences.selfAdjust, true)
})

// ── 私信主动额度（0.8.1）：不再只看 --share，plain notify 也要算
test('dm proactive cap: counts every proactive send and refuses at the limit', async () => {
  const { proactiveCap } = await import('../lib/dm-limits.mjs')
  assert.equal(proactiveCap({ used: 0, cap: 10 }).blocked, false)
  assert.equal(proactiveCap({ used: 9, cap: 10 }).next, 10)
  const over = proactiveCap({ used: 21, cap: 10 })
  assert.equal(over.blocked, true)
  assert.match(over.reason, /21 条（上限 10）/)
  assert.equal(proactiveCap({ used: 3, cap: 0 }).blocked, true)
})

test('store: creates pod.config.json, imports legacy whale config once', async (t) => {
  const home = tmp(t, 'home')
  const dsh = path.join(home, '.dsh')
  fs.mkdirSync(dsh, { recursive: true })
  const prev = { ...process.env }
  t.after(() => { process.env = { ...prev } })
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.DSH_HOME = dsh
  process.env.BILI_POD_CONFIG = path.join(dsh, 'pod.config.json')
  delete process.env.BILI_POD_WORK
  delete process.env.BILI_POD_DIARY
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '42', name: '旧主人' }, diary: { push: false } }))
  const store = await import(`../lib/store.mjs?t=${Date.now()}`)
  const cfg = store.readConfig()
  assert.equal(cfg.owner.mid, '42')
  assert.equal(cfg.diary.push, false)
  assert.ok(fs.existsSync(process.env.BILI_POD_CONFIG))
  const { config, warns } = store.writeConfig({ owner: { name: '新主人' } })
  assert.equal(config.owner.mid, '42')
  assert.equal(config.owner.name, '新主人')
  assert.ok(Array.isArray(warns))
  assert.equal(store.readConfig().owner.name, '新主人')
})
