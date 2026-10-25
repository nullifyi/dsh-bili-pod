import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildPersonaContext, parsePersonaDocument, readPersonaDocument, writePersonaDocument } from '../lib/persona.mjs'

const cli = fileURLToPath(new URL('../tools/bili.mjs', import.meta.url))
const fullText = '# 测试角色\n\n## 身份\n保留自己的主见。\n\n## 不同场景的语气参考\n仅参考语气。\n\n### 夸奖\n被夸时可以高兴。\n\n### 关心\n对方拒绝就收住。\n\n### 技术\n认真解释也保留自己的口吻。\n\n## 最后一节\n这段也不能丢。\n'
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-persona-'))
  const paths = { file: path.join(root, 'profile', 'pod-persona.md'), legacyFile: path.join(root, 'home', '.bili-ai', 'persona.md'), instructionsFile: path.join(root, 'profile', 'pod-work', 'AGENTS.md') }
  fs.mkdirSync(path.dirname(paths.file), { recursive: true })
  fs.mkdirSync(path.dirname(paths.legacyFile), { recursive: true })
  fs.mkdirSync(path.dirname(paths.instructionsFile), { recursive: true })
  const config = { persona: { loadMode: 'workspace' } }
  const cfgFile = path.join(root, 'profile', 'pod.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify(config))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, USERPROFILE: path.join(root, 'home'), DSH_HOME: path.join(root, 'profile'), DSH_NODE: process.execPath, BILI_POD_CONFIG: cfgFile, BILI_POD_PERSONA: paths.file, BILI_POD_WORK: path.dirname(paths.instructionsFile) }
  const run = (...args) => spawnSync(process.execPath, [cli, 'persona', ...args], { env, encoding: 'utf8' })
  return { root, paths, config, env, run, build: () => buildPersonaContext({ config, paths }) }
}

test('workspace and inline retain every example without keyword selection', t => {
  const f = fixture(t)
  fs.writeFileSync(f.paths.file, fullText)
  fs.writeFileSync(f.paths.instructionsFile, '# Existing workspace instruction\n')
  const result = f.build()
  assert.equal(parsePersonaDocument(fullText).body, fullText.trim())
  assert.equal(result.exampleCount, 3)
  const projected = fs.readFileSync(f.paths.instructionsFile, 'utf8')
  assert.ok(projected.startsWith('# Existing workspace instruction\n'))
  assert.ok(projected.includes(fullText.trim()))
  const inline = buildPersonaContext({ paths: f.paths, config: { persona: { loadMode: 'inline' } }, reason: 'dm', message: '你好' })
  assert.ok(inline.prompt.includes(fullText.trim()))
})

test('next build reads the latest source and replaces the earlier projection', t => {
  const f = fixture(t)
  fs.writeFileSync(f.paths.file, fullText)
  const old = f.build()
  const latest = fullText.replace('保留自己的主见。', '主人最新确认的新设定。')
  fs.writeFileSync(f.paths.file, latest)
  const current = f.build()
  assert.notEqual(current.version, old.version)
  const projected = fs.readFileSync(f.paths.instructionsFile, 'utf8')
  assert.ok(projected.includes(latest.trim()))
  assert.equal(projected.includes(old.version), false)
})

test('missing current source never reads or silently copies the legacy persona', t => {
  const f = fixture(t)
  fs.writeFileSync(f.paths.legacyFile, '旧人设不应自动生效')
  const current = readPersonaDocument(f.paths)
  assert.equal(current.path, f.paths.file)
  assert.equal(current.exists, false)
  assert.equal(current.text, '')
  assert.match(f.build().prompt, /人设未加载/)
  assert.equal(fs.existsSync(f.paths.file), false)
  const info = f.run('info')
  assert.equal(info.status, 0, info.stderr)
  assert.equal(JSON.parse(info.stdout).exists, false)
})

test('CLI full read and save share the settings source and projection', t => {
  const f = fixture(t)
  fs.writeFileSync(f.paths.legacyFile, '原旧文件保持原样')
  writePersonaDocument(fullText, f)
  const shown = f.run('show')
  assert.equal(shown.status, 0, shown.stderr)
  assert.equal(shown.stdout, fullText)
  const draft = path.join(f.root, 'complete-draft.md')
  const changed = fullText.replace('保留自己的主见。', '通过统一入口保存的新设定。')
  fs.writeFileSync(draft, changed)
  const saved = f.run('save', '--file', draft)
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(JSON.parse(saved.stdout).path, f.paths.file)
  assert.equal(fs.readFileSync(f.paths.file, 'utf8'), changed)
  assert.ok(fs.readFileSync(f.paths.instructionsFile, 'utf8').includes(changed.trim()))
  assert.equal(fs.readFileSync(f.paths.legacyFile, 'utf8'), '原旧文件保持原样')
})

test('editing the generated block cannot become a competing persona source', t => {
  const f = fixture(t)
  fs.writeFileSync(f.paths.file, fullText)
  f.build()
  const original = fs.readFileSync(f.paths.instructionsFile, 'utf8')
  fs.writeFileSync(f.paths.instructionsFile, original.replace('保留自己的主见。', '误改生成文件。'))
  f.build()
  assert.equal(fs.readFileSync(f.paths.instructionsFile, 'utf8'), original)
  assert.equal(fs.readFileSync(f.paths.file, 'utf8'), fullText)
  assert.match(original, /直接改它会被源文件覆盖/)
})

test('legacy import is explicit and cannot overwrite an established source', t => {
  const f = fixture(t)
  fs.writeFileSync(f.paths.legacyFile, fullText)
  const imported = f.run('import-legacy')
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(fs.readFileSync(f.paths.file, 'utf8'), fullText)
  fs.writeFileSync(f.paths.file, '已经建立的新设定')
  const again = f.run('import-legacy')
  assert.equal(again.status, 1)
  assert.equal(fs.readFileSync(f.paths.file, 'utf8'), '已经建立的新设定')
})
