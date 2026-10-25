import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompanionIdentityHook } from '../lib/companion-identity.mjs'

const assembly = () => ({
  sections: [{ name: 'deployment:persona-prefix', text: 'You are a coding agent.' }, { name: 'permission', text: 'Keep the permission rules.' }],
  tools: [{ name: 'read' }], contexts: [{ name: 'cwd' }], variables: { model: 'same-model' },
})

test('the very first assembly carries full literal character prose and preserves tools and policy', async () => {
  const original = assembly()
  const text = '# 角色\n{{literal}}\n### 示例\n最后一段'
  const hook = createCompanionIdentityHook({ isCompanion: a => a?.id === 'whale', readDocument: () => ({ exists: true, text }) })
  const result = await hook(original, { agent: { id: 'whale' } }, async () => original)
  assert.equal(result.sections[0].text, text)
  assert.equal(result.sections[0].interpolate, false)
  assert.equal(original.sections[0].text, 'You are a coding agent.')
  assert.deepEqual(result.sections.slice(1), original.sections.slice(1))
  for (const key of ['tools', 'contexts', 'variables']) assert.equal(result[key], original[key])
})

test('a changed source is used on the current assembly, without a prior model step', async () => {
  let text = '旧全文'
  const hook = createCompanionIdentityHook({ isCompanion: () => true, readDocument: () => ({ exists: true, text }) })
  const original = assembly()
  assert.equal((await hook(original, {}, async () => original)).sections[0].text, '旧全文')
  text = '新全文'
  assert.equal((await hook(original, {}, async () => original)).sections[0].text, '新全文')
})

test('other agents and missing source keep the original identity', async () => {
  const original = assembly()
  let reads = 0
  const hook = createCompanionIdentityHook({ isCompanion: a => a?.id === 'whale', readDocument: () => { reads++; return { exists: false, text: '' } } })
  assert.equal(await hook(original, { agent: { id: 'other' } }, async () => original), original)
  assert.equal(reads, 0)
  assert.equal(await hook(original, { agent: { id: 'whale' } }, async () => original), original)
})

test('a composition without a persona section receives one without losing its guidance', async () => {
  const original = assembly(); original.sections.shift()
  const hook = createCompanionIdentityHook({ isCompanion: () => true, readDocument: () => ({ exists: true, text: '全文' }) })
  const result = await hook(original, {}, async () => original)
  assert.equal(result.sections[0].name, 'deployment:persona-prefix')
  assert.equal(result.sections[1], original.sections[0])
})

test('an authored dialogue cue stays last after tool guidance and is never duplicated', async () => {
  const original = assembly()
  const text = '# 角色\n完整正文\n\n## 开口时\n直接给主人说话。\n\n保留 {{literal}} 和全部提醒。\n\n## 来源\n这是下一节。\n'
  const hook = createCompanionIdentityHook({ isCompanion: () => true, readDocument: () => ({ exists: true, text }) })
  const result = await hook(original, {}, async () => original)
  assert.equal(result.sections[0].text, text.trim())
  assert.equal(result.sections.at(-1).name, 'dsh-bili-pod:dialogue-cue')
  assert.equal(result.sections.at(-1).text, '直接给主人说话。\n\n保留 {{literal}} 和全部提醒。')
  assert.equal(result.sections.at(-1).interpolate, false)
  assert.equal(result.sections[1], original.sections[1])
  const repeated = await hook(result, {}, async () => result)
  assert.equal(repeated.sections.filter(s => s.name === 'dsh-bili-pod:dialogue-cue').length, 1)
})
