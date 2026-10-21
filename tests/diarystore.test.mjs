import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as ds from '../lib/diarystore.mjs'

const DAY = '2026-10-20'
const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pod-diary-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'diary')
  return { dir, root, L: ds.ensureLayout(root) }
}
const textAt = (file) => fs.readFileSync(file, 'utf8')
const occurrences = (text, phrase) => text.split(phrase).length - 1
const failWrite = (t, predicate) => {
  const original = fs.writeFileSync
  const mock = t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (predicate(String(file))) throw new Error('injected write failure')
    return original.call(this, file, ...args)
  })
  return () => mock.mock.restore()
}

// Removing validation would permit writes outside records/ or into its index.
test('records reject path categories and the reserved index without changing files', (t) => {
  const { root, L } = fixture(t)
  fs.writeFileSync(L.indexPath, 'existing index')
  for (const kind of ['../escape', '..\\escape', 'nested/name', 'nested\\name', 'INDEX', 'index', 'Index', 'INDEX.', 'bad:name']) {
    assert.throws(() => ds.appendRecord(root, { kind, day: DAY, text: 'must not escape' }), /分类|kind/i, kind)
    assert.throws(() => L.record(kind), /分类|kind/i, kind)
  }
  assert.equal(textAt(L.indexPath), 'existing index')
  assert.equal(fs.existsSync(path.join(root, 'escape.md')), false)
  assert.equal(fs.existsSync(L.statePath), false)
})

test('Chinese and English extension categories retain their names and aliases work', (t) => {
  const { root, L } = fixture(t)
  for (const kind of ['读书笔记', 'Book Notes', 'design-notes']) {
    ds.appendRecord(root, { kind, day: DAY, text: `内容 ${kind}` })
    assert.match(textAt(L.record(kind)), new RegExp(`内容 ${kind}`))
  }
  ds.appendRecord(root, { kind: 'thoughts', day: DAY, text: 'alias content' })
  assert.match(textAt(L.record('思考')), /alias content/)
})

// Without real calendar validation, traversal and rolled-over dates are accepted.
test('all diary date consumers reject paths and impossible calendar dates', (t) => {
  const { root, L } = fixture(t)
  for (const day of ['../escape', '..\\escape', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-1-02', '']) {
    for (const run of [
      () => ds.appendDaily(root, { day, text: 'no' }),
      () => ds.appendDaily(root, { day, kind: 'owner', text: 'no' }),
      () => ds.appendRecord(root, { day, kind: '学习', text: 'no' }),
      () => ds.archiveDay(root, day),
      () => ds.recall(root, { day }),
      () => L.daily(day), () => L.owner(day), () => L.archive(day), () => L.ownerArchive(day),
    ]) assert.throws(run, /日期|day/i, day)
  }
  ds.appendDaily(root, { day: '2024-02-29', text: 'valid leap day' })
  assert.match(textAt(L.daily('2024-02-29')), /valid leap day/)
})

test('records and diary CLI reject unsafe inputs before writing user content', (t) => {
  const { dir, root, L } = fixture(t)
  for (const args of [
    ['records', 'add', '../escape', 'no'],
    ['records', 'add', '..\\escape', 'no'],
    ['records', 'add', 'INDEX', 'no'],
    ['records', 'show', '../escape'],
    ['records', 'add', '学习', 'no', '--day', '2026-02-29'],
    ['diary', 'add', '--kind', '学习', '--text', 'no', '--day', '../escape'],
    ['diary', 'today', '--day', '../escape'],
    ['diary', 'recall', '--day', '2026-04-31'],
  ]) {
    const [command, ...rest] = args
    const run = spawnSync(process.execPath, [`tools/commands/${command}.mjs`, ...rest], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, DSH_HOME: path.join(dir, 'dsh'), BILI_POD_CONFIG: path.join(dir, 'config.json'), BILI_POD_WORK: path.join(dir, 'work'), BILI_POD_DIARY: root },
    })
    assert.notEqual(run.status, 0, args.join(' '))
    assert.match(run.stderr, /分类|kind|日期|day/i)
  }
  assert.equal(fs.existsSync(path.join(root, 'escape.md')), false)
  assert.equal(fs.existsSync(L.indexPath), false)
})

// Accepting these CLI kinds poisons an otherwise valid diary for future archival.
test('diary CLI rejects unsafe self categories before changing an existing daily', (t) => {
  const { dir, root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '- [学习] kept text' })
  const before = textAt(L.daily(DAY))
  for (const kind of ['../escape', '..\\escape', 'nested/name', 'nested\\name', 'INDEX', 'index']) {
    const run = spawnSync(process.execPath, ['tools/commands/diary.mjs', 'add', '--kind', kind, '--text', 'rejected text', '--day', DAY], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, DSH_HOME: path.join(dir, 'dsh'), BILI_POD_CONFIG: path.join(dir, 'config.json'), BILI_POD_WORK: path.join(dir, 'work'), BILI_POD_DIARY: root },
    })
    assert.notEqual(run.status, 0, kind)
    assert.match(run.stderr, /分类|kind/i)
    assert.equal(textAt(L.daily(DAY)), before)
  }
  assert.equal(ds.archiveDay(root, DAY).entries, 1)
  assert.match(textAt(L.record('学习')), /kept text/)
  assert.doesNotMatch(textAt(L.archive(DAY)), /rejected text/)
})

test('owner diary CLI preserves prose containing path-like or reserved category words', (t) => {
  const { dir, root, L } = fixture(t)
  const text = '给主人的记录含 ../escape、INDEX 和 [..\\escape] 原文'
  const run = spawnSync(process.execPath, ['tools/commands/diary.mjs', 'add', '--kind', '../escape', '--text', text, '--day', DAY, '--owner'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, USERPROFILE: dir, DSH_HOME: path.join(dir, 'dsh'), BILI_POD_CONFIG: path.join(dir, 'config.json'), BILI_POD_WORK: path.join(dir, 'work'), BILI_POD_DIARY: root },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(textAt(L.owner(DAY)), `# ${DAY} · 给主人的日记\n\n${text}\n`)
  assert.equal(fs.existsSync(L.daily(DAY)), false)
  assert.equal(ds.archiveDay(root, DAY).entries, 0)
  assert.equal(textAt(L.ownerArchive(DAY)), `# ${DAY} · 给主人的日记\n\n${text}\n`)
})

// Moving writeState before the body append falsely consumes this record on retry.
test('record body append failure can be retried without losing the entry', (t) => {
  const { root, L } = fixture(t)
  const original = fs.appendFileSync
  const mock = t.mock.method(fs, 'appendFileSync', function (file, ...args) {
    if (file === L.record('学习')) throw new Error('injected append failure')
    return original.call(this, file, ...args)
  })
  const entry = { kind: '学习', day: DAY, text: 'append survives retry' }
  assert.throws(() => ds.appendRecord(root, entry), /injected append failure/)
  mock.mock.restore()
  assert.equal(ds.appendRecord(root, entry).added, true)
  assert.equal(occurrences(textAt(L.record('学习')), entry.text), 1)
})

// Losing state after a committed body must not duplicate that body on restart.
test('record state write failure retries from the persisted entry without duplication', (t) => {
  const { root, L } = fixture(t)
  const restore = failWrite(t, (file) => path.basename(file).startsWith('.state.json'))
  const entry = { kind: '学习', day: DAY, text: 'state survives retry' }
  assert.throws(() => ds.appendRecord(root, entry), /injected write failure/)
  assert.equal(fs.existsSync(L.record('学习')), true, 'record body must commit before state')
  assert.equal(occurrences(textAt(L.record('学习')), entry.text), 1)
  restore()
  assert.equal(ds.appendRecord(root, entry).added, false)
  assert.equal(occurrences(textAt(L.record('学习')), entry.text), 1)
  assert.equal(ds.readState(root).entryKeys['学习'].length, 1)
  ds.appendRecord(root, { ...entry, day: '2026-10-21' })
  assert.equal(occurrences(textAt(L.record('学习')), entry.text), 2)
})

test('existing unmarked records continue to dedupe through their saved keys', (t) => {
  const { root, L } = fixture(t)
  ds.appendRecord(root, { kind: '学习', day: DAY, text: 'legacy body' })
  fs.writeFileSync(L.record('学习'), textAt(L.record('学习')).replace(/\s*<!-- diary-entry:[^>]+ -->/g, ''))
  assert.equal(ds.appendRecord(root, { kind: '学习', day: DAY, text: 'legacy body' }).added, false)
  assert.equal(occurrences(textAt(L.record('学习')), 'legacy body'), 1)
})

test('existing archive and a newly written daily fragment both survive repeated archiving', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '- [读书] old fragment' })
  ds.appendDaily(root, { day: DAY, kind: 'owner', text: 'old owner fragment' })
  ds.archiveDay(root, DAY)
  ds.appendDaily(root, { day: DAY, text: '- [学习] new fragment' })
  ds.appendDaily(root, { day: DAY, kind: 'owner', text: 'new owner fragment' })
  assert.equal(ds.archiveDay(root, DAY).archived, true)
  assert.equal(ds.archiveDay(root, DAY).archived, false)
  for (const phrase of ['old fragment', 'new fragment']) assert.equal(occurrences(textAt(L.archive(DAY)), phrase), 1)
  for (const phrase of ['old owner fragment', 'new owner fragment']) assert.equal(occurrences(textAt(L.ownerArchive(DAY)), phrase), 1)
  assert.match(textAt(L.record('读书')), /old fragment/)
  assert.match(textAt(L.record('学习')), /new fragment/)
  const archived = ds.readState(root).archived
  assert.equal(archived.length, 1)
  assert.equal(archived[0].entries, 2)
  assert.deepEqual(archived[0].kinds.sort(), ['学习', '读书'].sort())
  assert.equal(fs.existsSync(L.daily(DAY)), false)
  assert.equal(fs.existsSync(L.owner(DAY)), false)
})

test('archive state failure leaves originals retryable and preserves all records', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '- [学习] archive retry body' })
  ds.appendDaily(root, { day: DAY, kind: 'owner', text: 'archive retry owner' })
  ds.appendRecord(root, { kind: '学习', day: DAY, text: 'archive retry body' })
  const restore = failWrite(t, (file) => path.basename(file).startsWith('.state.json'))
  assert.throws(() => ds.archiveDay(root, DAY), /injected write failure/)
  restore()
  const result = ds.archiveDay(root, DAY)
  assert.equal(result.archived, true)
  assert.equal(result.entries, 1)
  assert.deepEqual(result.kinds, ['学习'])
  assert.equal(occurrences(textAt(L.archive(DAY)), 'archive retry body'), 1)
  assert.equal(occurrences(textAt(L.ownerArchive(DAY)), 'archive retry owner'), 1)
  assert.equal(occurrences(textAt(L.record('学习')), 'archive retry body'), 1)
  assert.equal(ds.readState(root).archived.length, 1)
  assert.match(textAt(L.indexPath), /学习 \| 1/)
})

test('failed archive rewrite preserves the existing archive and daily for retry', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '- [学习] original archive body' })
  ds.archiveDay(root, DAY)
  const before = textAt(L.archive(DAY))
  ds.appendDaily(root, { day: DAY, text: '- [学习] later daily body' })
  const original = fs.writeFileSync
  const mock = t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (String(file).includes(`${path.sep}archive${path.sep}`)) {
      original.call(this, file, 'partial output', 'utf8')
      throw new Error('injected partial write failure')
    }
    return original.call(this, file, ...args)
  })
  assert.throws(() => ds.archiveDay(root, DAY), /injected partial write failure/)
  mock.mock.restore()
  assert.equal(textAt(L.archive(DAY)), before)
  assert.match(textAt(L.daily(DAY)), /later daily body/)
  assert.equal(ds.archiveDay(root, DAY).archived, true)
  assert.equal(occurrences(textAt(L.archive(DAY)), 'original archive body'), 1)
  assert.equal(occurrences(textAt(L.archive(DAY)), 'later daily body'), 1)
  assert.equal(occurrences(textAt(L.record('学习')), 'later daily body'), 1)
})

test('index failure retries the same archive without duplicating text or entries', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '- [学习] index retry body' })
  const restore = failWrite(t, (file) => path.basename(file).startsWith('INDEX.md'))
  assert.throws(() => ds.archiveDay(root, DAY), /injected write failure/)
  restore()
  assert.equal(ds.archiveDay(root, DAY).archived, true)
  assert.equal(occurrences(textAt(L.archive(DAY)), 'index retry body'), 1)
  assert.equal(occurrences(textAt(L.record('学习')), 'index retry body'), 1)
  assert.match(textAt(L.indexPath), /学习 \| 1/)
})

test('archiveDue includes owner-only days and keeps today while crossing a month', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: '2026-09-30', kind: 'owner', text: 'September owner only' })
  ds.appendDaily(root, { day: '2026-10-01', text: '- [学习] October self' })
  ds.appendDaily(root, { day: '2026-10-02', kind: 'owner', text: 'today owner' })
  const results = ds.archiveDue(root, { now: new Date('2026-10-02T12:00:00'), keepDays: 1 })
  assert.deepEqual(results.map((result) => result.day), ['2026-09-30', '2026-10-01'])
  assert.equal(results.every((result) => result.archived), true)
  assert.match(textAt(L.ownerArchive('2026-09-30')), /September owner only/)
  assert.equal(ds.recall(root, { day: '2026-09-30' }).length, 1)
  assert.equal(fs.existsSync(L.owner('2026-09-30')), false)
  assert.match(textAt(L.owner('2026-10-02')), /today owner/)
  assert.equal(ds.archiveDue(root, { now: new Date('2026-10-02T12:00:00') }).length, 0)
  assert.equal(ds.readState(root).archived.find((entry) => entry.day === '2026-09-30').file, 'archive/2026-09/owner/2026-09-30.md')
})

// A section extending through the join must not turn recovery comments into entries.
test('merging section-based diary fragments extracts only original diary entries', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '## 学习\n- original section entry' })
  ds.archiveDay(root, DAY)
  ds.appendDaily(root, { day: DAY, text: '## 思考\n- later section entry' })
  assert.equal(ds.archiveDay(root, DAY).entries, 2)
  assert.equal(occurrences(textAt(L.record('学习')), 'original section entry'), 1)
  assert.doesNotMatch(textAt(L.record('学习')), /diary-fragment/)
  assert.match(textAt(L.record('思考')), /later section entry/)
})

// Batch archival must keep the failed day discoverable until its index commits.
test('archiveDue index failure remains retryable from the daily directory', (t) => {
  const { root, L } = fixture(t)
  ds.appendDaily(root, { day: DAY, text: '- [学习] batch index retry' })
  const restore = failWrite(t, (file) => path.basename(file).startsWith('INDEX.md'))
  const options = { now: new Date('2026-10-22T12:00:00') }
  assert.throws(() => ds.archiveDue(root, options), /injected write failure/)
  restore()
  assert.equal(ds.archiveDue(root, options)[0]?.archived, true)
  assert.equal(occurrences(textAt(L.archive(DAY)), 'batch index retry'), 1)
  assert.equal(occurrences(textAt(L.record('学习')), 'batch index retry'), 1)
  assert.match(textAt(L.indexPath), /学习 \| 1/)
})
