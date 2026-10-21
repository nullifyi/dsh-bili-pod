import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../../', import.meta.url))
const home = process.env.USERPROFILE
const scenario = process.argv[2]
const draft = { id: 'offline-draft', oid: '45', type: '11', referer: 'https://www.bilibili.com/opus/offline', root: '2', parent: '2', message: 'offline reply', who: 'root-author' }
const sentPath = path.join(home, '.bili-ai/pod-sent.json')
const pendingPath = path.join(home, '.bili-ai/pending-replies.json')
const requests = () => fs.existsSync(process.env.TEST_REQUESTS) ? fs.readFileSync(process.env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const run = args => cp.spawnSync(process.execPath, [path.join(repo, 'tools/bili.mjs'), ...args], { env: process.env, encoding: 'utf8', timeout: 20000 })
if (scenario === 'draft') {
  const args = ['reply-draft', 'add', '--oid', '45', '--type', '11', '--referer', draft.referer, '--root', '2', '--message', draft.message]
  const added = run(args); assert.equal(added.status, 0, added.stdout + added.stderr)
  const item = JSON.parse(fs.readFileSync(pendingPath)).items[0]
  assert.equal(item.type, '11'); assert.equal(item.referer, draft.referer); assert.equal(item.parent, '2')
  const another = [...args]; another[another.indexOf('--oid') + 1] = '46'
  assert.equal(run(another).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(pendingPath)).items.length, 2)
} else if (scenario === 'approval' || scenario.startsWith('verify-send-')) {
  const s = await import('../../lib/comment-state.mjs')
  if (scenario.startsWith('verify-send-')) process.env.TEST_VERIFY = scenario.slice('verify-send-'.length)
  const issued = s.issueApproval(draft)
  const args = ['comment', '--oid', '45', '--type', '11', '--referer', draft.referer, '--root', '2', '--parent', '2', '--message', draft.message, '--approval', issued.token, '--operation-id', issued.operationId, '--go']
  if (process.env.TEST_VERIFY) args.push('--verify')
  const changed = [...args]; changed[changed.indexOf('--message') + 1] = 'altered'
  assert.equal(run(changed).status, 7)
  const first = run(args); assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.notEqual(run(args).status, 0)
  assert.equal(requests().filter(x => x.method === 'POST').length, 1)
  const sent = JSON.parse(fs.readFileSync(sentPath)).items[0]
  assert.equal(sent.rpid, '9007199254740993'); assert.equal(sent.type, '11')
  assert.equal(s.readOperation(issued.operationId).status, 'accepted')
  if (process.env.TEST_VERIFY !== 'accounting') assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.bili-ai/quota.json'))).log.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.bili-ai/replied.json'))).byUid['333'].length, 1)
  if (process.env.TEST_VERIFY === 'accounting') {
    assert.equal(s.readOperation(issued.operationId).accountingStatus, 'incomplete')
    assert.equal(sent.verifyAttempts, 0)
    assert.equal(requests().filter(x => x.cookie && x.url?.includes('/reply/reply')).length, 0)
  } else if (process.env.TEST_VERIFY) {
    assert.equal(sent.verifyAttempts, 1); assert.equal(sent.observation, 'error')
    assert.equal(requests().find(x => x.event === 'verification-accounting')?.ready, true)
  }
} else if (scenario.startsWith('host-')) {
  const exec = cp.execFile
  cp.execFile = (exe, args, options, callback) => exec(exe, args, options, (err, stdout, stderr) => {
    if (scenario === 'host-receipt' && args.includes('comment')) {
      const file = path.join(home, '.bili-ai/comment-operations.json'), db = JSON.parse(fs.readFileSync(file))
      db.items[0].status = 'sending'; delete db.items[0].rpid
      fs.writeFileSync(file, JSON.stringify(db))
    }
    callback(['host-timeout', 'host-receipt'].includes(scenario) && args.includes('comment') ? new Error('offline simulated post-success host timeout') : err, stdout, stderr)
  })
  syncBuiltinESMExports()
  // Disable host scheduling only; real spawned CLI retains ordinary timers.
  globalThis.setInterval = () => ({})
  if (scenario === 'host-uncertain') process.env.TEST_POST = 'uncertain'
  if (scenario === 'host-rejected') process.env.TEST_POST = 'reject'
  fs.writeFileSync(pendingPath, JSON.stringify({ items: [draft] }))
  const { default: plugin } = await import('../../lib/index.js')
  const routes = new Map()
  plugin.apply({ get: () => ({ requestRejection: () => null }), webServer: { register(r) { routes.set(r.path, r.handler); return () => {} } }, effect: () => {} })
  const approve = () => new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ id: draft.id }))]); req.method = 'POST'; req.headers = { host: '127.0.0.1' }; req.url = '/dsh-bili/api/pending/approve'
    routes.get(req.url)(req, { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }).catch(reject)
  })
  const first = await approve()
  const queue = JSON.parse(fs.readFileSync(pendingPath)).items
  if (['host-timeout', 'host-receipt'].includes(scenario)) { assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.rpid, '9007199254740993'); assert.equal(queue.length, 0) }
  else if (scenario === 'host-uncertain') { assert.equal(first.status, 'uncertain'); assert.equal(queue[0].status, 'uncertain'); await approve() }
  else { assert.equal(first.status, 'rejected'); assert.equal(queue[0].status, 'pending') }
  assert.equal(requests().filter(x => x.method === 'POST').length, 1)
  if (['host-timeout', 'host-receipt'].includes(scenario)) {
    const posted = requests().find(x => x.method === 'POST'); assert.equal(new URLSearchParams(posted.body).get('type'), '11')
    assert.ok(JSON.parse(fs.readFileSync(sentPath)).items.length)
  }
} else if (scenario === 'verify') {
  const v = await import('../../lib/verifycomments.mjs')
  const cfg = { verifyRounds: 2, verifyIntervalSec: 5 }
  v.writeSent({ items: [{ rpid: '9007199254740992', oid: '45', type: '11', root: '', at: '2026-10-22T00:00:00Z' }] })
  let count = 0
  globalThis.fetch = async (url, opts) => {
    assert.equal(new URL(url).searchParams.get('type'), '11')
    assert.ok(opts.signal, 'finite network timeout required')
    count++
    if (count === 1) {
      const writer = cp.spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'append-sent', '222'], { env: process.env, encoding: 'utf8' })
      assert.equal(writer.status, 0, writer.stderr)
    }
    return { text: async () => JSON.stringify({ code: 0, data: { replies: [{ rpid_str: '9007199254740993', rpid: 9007199254740993 }] } }) }
  }
  const a = await v.verifyRecent({ max: 1, cred: { sessdata: 'fake' }, now: 10000, review: cfg })
  assert.equal(a.checked[0].visible, null)
  assert.deepEqual(v.readSent().items.map(x => x.rpid), ['9007199254740992', '222'])
  assert.equal(v.readSent().items[0].verifyAttempts, 1)
  assert.equal(v.readSent().items[0].verified, null)
  await v.verifyRecent({ max: 1, cred: { sessdata: 'fake' }, now: 11000, review: cfg })
  assert.equal(v.readSent().items[0].verifyAttempts, 1)
  // The old due item wins over a newer item on the second round.
  await v.verifyRecent({ max: 1, cred: { sessdata: 'fake' }, now: 16000, review: cfg })
  assert.equal(v.readSent().items[0].verified, 'unconfirmed')
  assert.equal(v.readSent().items[0].verifyAttempts, 2)
  globalThis.fetch = async () => { throw new Error('offline network error') }
  const error = await v.verifyOne({ rpid: '222', oid: '1' }, { headers: {} })
  assert.equal(error.observation, 'error')
  globalThis.fetch = async () => ({ text: async () => JSON.stringify({ code: 0, data: { replies: [{ rpid_str: '222' }] } }) })
  const own = await v.verifyOne({ rpid: '222', oid: '1' }, { headers: { cookie: 'fake' } })
  assert.equal(own.audience, 'account'); assert.doesNotMatch(own.how, /公开/)
  await v.verifyRecorded('222', { cred: { sessdata: 'fake' }, now: 22000, review: cfg })
  assert.equal(v.readSent().items[1].verified, 'visible')
} else if (scenario === 'scheduler-verify') {
  const v = await import('../../lib/verifycomments.mjs')
  v.recordSent({ rpid: '55', oid: '45', type: '11' })
  let now = 10000000
  Date.now = () => now
  const timers = []
  globalThis.setInterval = globalThis.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }
  globalThis.clearInterval = globalThis.clearTimeout = () => {}
  const { startScheduler, wakePrompt } = await import('../../lib/scheduler.js')
  const cfg = { review: { verify: true, verifyRounds: 2, verifyIntervalSec: 5 }, ledger: { enabled: false }, diary: {}, listen: {}, night: {} }
  let observations = 0, ledgerCalls = 0
  const sched = startScheduler({}, { dshHome: process.env.DSH_HOME, workDir: process.env.BILI_POD_WORK, diaryRoot: process.env.BILI_POD_DIARY, log() {}, host: {
    readConfig: () => cfg,
    verifyRecent: async opts => { assert.deepEqual(opts.review, cfg.review); observations++; return { checked: [{ rpid: '55', visible: null, how: '本人登录观察' }] } },
    ledger: { appendRound() { ledgerCalls++ } },
  } })
  assert.ok(timers.some(t => t.ms === 5000))
  await sched.verifyTick(); assert.equal(observations, 1)
  now += 4999; await sched.verifyTick(); assert.equal(observations, 1)
  now++; await sched.verifyTick(); assert.equal(observations, 2)
  assert.equal(ledgerCalls, 0)
  sched.stop()
  const text = wakePrompt({ st: { date: '2026-10-22', atMs: 123 }, cfg, today: '2026-10-22' })
  assert.match(text, /operation-id "report:2026-10-22:123"/)
  assert.doesNotMatch(text, /主人.*免审/)
} else if (scenario === 'append-sent') {
  const v = await import('../../lib/verifycomments.mjs')
  v.recordSent({ rpid: process.argv[3], oid: '1', type: '1' })
} else if (scenario === 'sent-race') {
  const v = await import('../../lib/verifycomments.mjs')
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    cp.execFile(process.execPath, [fileURLToPath(import.meta.url), 'append-sent', String(i + 1)], { env: process.env }, err => err ? reject(err) : resolve())
  })))
  assert.equal(v.readSent().items.length, 8)
} else if (scenario === 'stale-lock') {
  const { withFileLock } = await import('../../lib/file-state.mjs')
  const file = path.join(home, 'fake-state.json')
  fs.writeFileSync(file + '.lock', '2147483647')
  let clock = 0
  Date.now = () => clock += 6000
  assert.throws(() => withFileLock(file, () => assert.fail('must not acquire a stale lock automatically')), /State lock timeout/)
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), '2147483647')
} else if (scenario === 'ledger') {
  const l = await import('../../lib/ledger.mjs')
  const root = process.env.BILI_POD_WORK
  fs.mkdirSync(path.join(root, 'rounds/INDEX.md'), { recursive: true })
  const args = { root, mode: 'manual', title: 'one round', body: 'one accepted action', operationId: 'offline-operation' }
  const a = l.appendRound(args)
  assert.equal(a.committed, true); assert.ok(a.indexError)
  const b = l.appendRound(args)
  assert.equal(a.file, b.file); assert.equal(l.listRounds(root).length, 1)
  fs.rmdirSync(path.join(root, 'rounds/INDEX.md'))
  const c = l.appendRound(args); assert.equal(c.indexError, null); assert.equal(l.verifyChain(root).ok, true)
  const cli = ['ledger', 'write', '--mode', 'manual', '--body', 'CLI round', '--operation-id', 'cli-stable']
  assert.equal(run(cli).status, 0); assert.equal(run(cli).status, 0); assert.equal(l.listRounds(root).length, 2)
}
process.exit(0) // Host boot timers must not outlive this isolated contract probe.
