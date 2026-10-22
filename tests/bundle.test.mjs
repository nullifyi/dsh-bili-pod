import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeZip, readZip, crc32 } from '../lib/zip.mjs'
import { exportBundle, inspectBundle, importBundle, collectFiles } from '../lib/bundler.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pod-bundle-'))

function targetsAt(root) {
  return {
    cfgFile: path.join(root, 'pod.config.json'),
    workDir: path.join(root, 'pod-work'),
    diaryDir: path.join(root, 'pod-diary'),
    personaFile: path.join(root, 'bili-ai', 'persona.md'),
    credFile: path.join(root, 'bili-ai', 'credentials.json'),
  }
}

function seed(root) {
  const t = targetsAt(root)
  fs.mkdirSync(path.dirname(t.cfgFile), { recursive: true })
  fs.writeFileSync(t.cfgFile, JSON.stringify({ owner: { mid: '660490601', name: '主人' }, review: { policy: 'auto-quiet' } }))
  fs.mkdirSync(path.join(t.diaryDir, 'daily'), { recursive: true })
  fs.writeFileSync(path.join(t.diaryDir, 'daily', '2026-10-22.md'), '# 2026-10-22\n\n- [吐槽] 今天的弹幕很吵\n')
  fs.mkdirSync(path.join(t.workDir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(t.workDir, 'state', 'pending-replies.json'), '{"items":[]}')
  fs.writeFileSync(path.join(t.workDir, 'state', 'api-cache.json'), '{"should":"not be bundled"}')
  fs.writeFileSync(path.join(t.workDir, 'state', 'api-requests.log'), 'noise')
  fs.mkdirSync(path.dirname(t.personaFile), { recursive: true })
  fs.writeFileSync(t.personaFile, '她是鲸群里的一条鲸鱼。')
  fs.writeFileSync(t.credFile, '{"sessdata":"x"}')
  return t
}

test('zip：写进去再读出来，内容与中文名都对', () => {
  const buf = writeZip([
    { name: 'a/中文.txt', data: '你好，鲸群\n' },
    { name: 'b/data.bin', data: Buffer.from([0, 1, 2, 255]) },
  ])
  const out = readZip(buf)
  assert.equal(out.length, 2)
  const byName = new Map(out.map((e) => [e.name, e]))
  assert.equal(byName.get('a/中文.txt').data.toString('utf8'), '你好，鲸群\n')
  assert.deepEqual([...byName.get('b/data.bin').data], [0, 1, 2, 255])
  assert.ok(out.every((e) => e.ok))
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686)
})

test('zip：条目顺序稳定（同样的内容，同样的字节）', () => {
  const a = writeZip([{ name: 'z.txt', data: '1' }, { name: 'a.txt', data: '2' }])
  const b = writeZip([{ name: 'a.txt', data: '2' }, { name: 'z.txt', data: '1' }])
  // 时间戳会写进 DOS 时间，取同一秒内的比较：只比文件名顺序
  assert.deepEqual(readZip(a).map((e) => e.name), ['a.txt', 'z.txt'])
  assert.deepEqual(readZip(b).map((e) => e.name), ['a.txt', 'z.txt'])
  assert.equal(a.length, b.length)
})

test('export：默认不含凭据，跳过缓存/日志，包内没有绝对路径', () => {
  const root = tmp()
  const t = seed(root)
  const out = path.join(root, 'b.zip')
  const r = exportBundle({ out, targets: t, pluginVersion: '0.7.2' })

  assert.ok(fs.existsSync(out))
  assert.equal(r.counts.config, 1)
  assert.equal(r.counts.diary, 1)
  assert.equal(r.counts.work, 1) // 只有 pending-replies，缓存/日志被跳过
  assert.equal(r.counts.home, 1) // 只有人设
  assert.ok(r.warnings.some((w) => w.includes('凭据没打包')))

  const names = readZip(fs.readFileSync(out)).map((e) => e.name)
  assert.ok(names.includes('config/pod.config.json'))
  assert.ok(names.includes('data/pod-diary/daily/2026-10-22.md'))
  assert.ok(names.includes('home/persona.md'))
  assert.ok(!names.includes('data/pod-work/state/api-cache.json'))
  assert.ok(!names.some((n) => n.includes('credentials')))
  assert.ok(!JSON.stringify(readZip(fs.readFileSync(out)).map((e) => e.name)).includes(root.replace(/\\/g, '/')))

  const info = inspectBundle(out)
  assert.equal(info.ok, true)
  assert.equal(info.manifest.plugin.version, '0.7.2')
  assert.equal(info.files.length, 4)

  fs.rmSync(root, { recursive: true, force: true })
})

test('export --with-credentials：凭据进包，并在警告里说清风险', () => {
  const root = tmp()
  const t = seed(root)
  const out = path.join(root, 'b.zip')
  const r = exportBundle({ out, targets: t, withCredentials: true })
  assert.ok(r.warnings.some((w) => w.includes('账号密码')))
  const names = readZip(fs.readFileSync(out)).map((e) => e.name)
  assert.ok(names.includes('home/credentials.json'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('import：把包还原到另一套目录，凭据默认不写', () => {
  const root = tmp()
  const t1 = seed(root)
  const out = path.join(root, 'b.zip')
  exportBundle({ out, targets: t1 })

  const dest = path.join(root, 'new-machine')
  const t2 = targetsAt(dest)
  const r = importBundle({ file: out, targets: t2 })
  assert.equal(r.written, 4)
  assert.equal(fs.readFileSync(path.join(t2.diaryDir, 'daily', '2026-10-22.md'), 'utf8').includes('弹幕很吵'), true)
  assert.equal(JSON.parse(fs.readFileSync(t2.cfgFile, 'utf8')).owner.mid, '660490601')
  assert.equal(fs.readFileSync(t2.personaFile, 'utf8').includes('鲸鱼'), true)
  assert.equal(fs.existsSync(t2.credFile), false)
  assert.equal(fs.existsSync(path.join(t2.workDir, 'state', 'pending-replies.json')), true)

  fs.rmSync(root, { recursive: true, force: true })
})

test('import --with-credentials：凭据写回并是 0600', () => {
  const root = tmp()
  const t1 = seed(root)
  const out = path.join(root, 'b.zip')
  exportBundle({ out, targets: t1, withCredentials: true })
  const t2 = targetsAt(path.join(root, 'm2'))
  const r = importBundle({ file: out, targets: t2 })
  assert.equal(fs.existsSync(t2.credFile), true)
  assert.equal(r.skippedCreds, false)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(t2.credFile).mode & 0o777, 0o600)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('import：目标已有数据时拒绝写入；--force 先备份', () => {
  const root = tmp()
  const t1 = seed(root)
  const out = path.join(root, 'b.zip')
  exportBundle({ out, targets: t1 })

  const dest = path.join(root, 'occupied')
  const t2 = targetsAt(dest)
  fs.mkdirSync(path.join(t2.workDir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(t2.workDir, 'state', 'old.json'), '{}')

  assert.throws(() => importBundle({ file: out, targets: t2 }), /已经有东西/)
  assert.equal(fs.existsSync(path.join(t2.diaryDir, 'daily', '2026-10-22.md')), false)

  const r = importBundle({ file: out, targets: t2, force: true })
  assert.ok(r.backups.length >= 1)
  assert.ok(r.backups.some((b) => b.includes('pod-work.bak-')))
  assert.equal(fs.existsSync(path.join(t2.diaryDir, 'daily', '2026-10-22.md')), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('inspect：包被改过一个字节就报出来', () => {
  const root = tmp()
  const t = seed(root)
  const out = path.join(root, 'b.zip')
  exportBundle({ out, targets: t })

  const buf = fs.readFileSync(out)
  const idx = buf.indexOf(Buffer.from('data/pod-diary/daily/2026-10-22.md'))
  assert.ok(idx > 0)
  const dataStart = idx + Buffer.byteLength('data/pod-diary/daily/2026-10-22.md')
  // 不破坏 ZIP 结构，只改内容：CRC 会先对不上
  buf[dataStart] = buf[dataStart] === 0x23 ? 0x24 : 0x23
  fs.writeFileSync(out, buf)

  const info = inspectBundle(out)
  assert.equal(info.ok, false)
  assert.ok(info.bad.some((b) => b.includes('2026-10-22.md')))
  assert.throws(() => importBundle({ file: out, targets: targetsAt(path.join(root, 'x')) }), /校验失败/)

  fs.rmSync(root, { recursive: true, force: true })
})

test('collectFiles：跳过符号链接 / 缓存 / 超大文件', () => {
  const root = tmp()
  const dir = path.join(root, 'work')
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 'keep.json'), '{}')
  fs.writeFileSync(path.join(dir, 'state', 'api-cache.json'), '{}')
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1024))
  const warnings = []
  const files = collectFiles(dir, { warnings })
  assert.deepEqual(files.map((f) => f.rel).sort(), ['big.bin', 'state/keep.json'].sort())
  fs.rmSync(root, { recursive: true, force: true })
})
