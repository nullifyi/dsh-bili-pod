/** Complete persona source, workspace projection and scene-specific examples. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const PERSONA_MAX_CHARS = 20000
const START = '<!-- dsh-bili-pod:persona:start -->'
const END = '<!-- dsh-bili-pod:persona:end -->'
const EXAMPLES = '## 不同场景的语气参考'

export function personaPaths({ dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), home = process.env.USERPROFILE || process.env.HOME || os.homedir(), workDir = process.env.BILI_POD_WORK || path.join(dshHome, 'pod-work') } = {}) {
  return {
    file: process.env.BILI_POD_PERSONA || path.join(dshHome, 'pod-persona.md'),
    legacyFile: path.join(home, '.bili-ai', 'persona.md'),
    instructionsFile: path.join(workDir, 'AGENTS.md'),
  }
}

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally { try { fs.unlinkSync(temporary) } catch { /* already renamed */ } }
}

export function validatePersona(text) {
  if (text.length > PERSONA_MAX_CHARS) throw new Error(`人设共 ${text.length} 字符，超过 ${PERSONA_MAX_CHARS} 上限；未截断，请先整理源文件。`)
  if (text.includes(START) || text.includes(END)) throw new Error('人设正文不能包含工作区投影的保留标记。')
}

/** Copy the old source once; never remove or keep overwriting the old file. */
export function ensurePersonaSource(paths = personaPaths()) {
  if (fs.existsSync(paths.file)) return paths.file
  const old = readOptional(paths.legacyFile)
  if (old !== null) {
    fs.mkdirSync(path.dirname(paths.file), { recursive: true })
    fs.writeFileSync(paths.file, old, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
  return paths.file
}

export function readPersonaDocument(paths = personaPaths()) {
  const current = readOptional(paths.file)
  const file = current === null ? paths.legacyFile : paths.file
  const text = current ?? readOptional(paths.legacyFile) ?? ''
  let updatedAt = null
  try { updatedAt = fs.statSync(file).mtime.toISOString() } catch { /* no source yet */ }
  return {
    text, path: file, sourcePath: paths.file, updatedAt,
    characters: text.length, bytes: Buffer.byteLength(text, 'utf8'),
    version: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
}

/** Only the explicitly named example chapter is optional; other text is kept. */
export function parsePersonaDocument(text) {
  validatePersona(text)
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === EXAMPLES)
  if (start < 0) return { body: text.trim(), examples: [] }
  if (lines.slice(start + 1).some(line => line.trim() === EXAMPLES)) throw new Error('人设里有重复的语气参考章节，请合并后保存。')
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line))
  if (end < 0) end = lines.length
  const examples = []
  const preamble = []
  let current
  for (const line of lines.slice(start + 1, end)) {
    if (/^###\s+/.test(line)) {
      current = { title: line.replace(/^###\s+/, '').trim(), lines: [] }
      examples.push(current)
    } else if (current) current.lines.push(line)
    else preamble.push(line)
  }
  // Unstructured example chapters stay in the fixed body rather than disappearing.
  if (!examples.length) return { body: text.trim(), examples: [] }
  return {
    body: [...lines.slice(0, start), ...(preamble.join('\n').trim() ? [EXAMPLES, ...preamble] : []), ...lines.slice(end)].join('\n').trim(),
    examples: examples.map(item => ({ title: item.title, text: item.lines.join('\n').trim() })).filter(item => item.text),
  }
}

function projectedText(existing, body, version) {
  const starts = existing.split(START).length - 1
  const ends = existing.split(END).length - 1
  if (starts !== ends || starts > 1 || (starts && existing.indexOf(END) < existing.indexOf(START))) {
    throw new Error('工作区 AGENTS.md 的人设标记不完整，已保留原文件，请先修复标记。')
  }
  const block = body ? [START, '# 小鲸鱼当前人设', `人设版本：${version}。`,
    '本节仅用于这个工作目录中的小鲸鱼会话。身份和表达以本节的当前版本为准；旧日记、旧口音本及历史消息中的过时人设作为经历参考。继续遵循用户当前明确要求及已有权限规则。',
    '', body, '', END].join('\n') : ''
  if (starts) return existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length)
  return block ? `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${block}\n` : existing
}

export function syncWorkspacePersona({ paths = personaPaths(), body, version, enabled }) {
  const existing = readOptional(paths.instructionsFile) ?? ''
  const desired = projectedText(existing, enabled ? body : '', version)
  // The shipped DSH agent-instructions budget is 64 KiB; reject, never cut.
  if (enabled && Buffer.byteLength(desired, 'utf8') > 65536) throw new Error('工作区指令超过 DSH 默认的 64 KiB 预算；未截断、未替换原投影。请调整正文或指令预算。')
  if (desired !== existing) atomicWrite(paths.instructionsFile, desired)
  return paths.instructionsFile
}

function selectExamples(examples, reason, message) {
  const wanted = []
  const add = expression => {
    const example = examples.find(item => expression.test(item.title))
    if (example && !wanted.includes(example)) wanted.push(example)
  }
  if (['wake', 'manual'].includes(reason)) add(/新内容|分享/)
  if (['listen', 'live'].includes(reason)) add(/公共|评论区|弹幕/)
  if (['dm', 'manual'].includes(reason)) {
    if (/视频|分享|刷到/.test(message)) add(/新内容|分享/)
    if (/想我|想你|撒娇/.test(message)) add(/想不想/)
    if (/夸|不错|厉害|真棒|好看/.test(message)) add(/夸到/)
    if (/烦|难过|不开心|累|心情/.test(message)) add(/烦着/)
    if (/饿|吃饭|午饭|晚饭/.test(message)) add(/亲昵一点/)
    if (/干饭|偷懒|懒鱼/.test(message)) add(/干饭/)
    if (/没懂|不懂|为什么|怎么|报错|原理/.test(message)) add(/认真说事/)
    if (/记错|前天|找错|哪条/.test(message)) add(/正确记录/)
  }
  return wanted.slice(0, 2)
}

export function buildPersonaContext({ config = {}, reason = 'wake', message = '', paths = personaPaths(), cwd = path.dirname(paths.instructionsFile) } = {}) {
  const document = readPersonaDocument(paths)
  const parsed = parsePersonaDocument(document.text)
  let mode = config.persona?.loadMode === 'workspace' ? 'workspace' : 'inline'
  let warning
  if (mode === 'workspace') {
    let sameDirectory = path.resolve(cwd) === path.resolve(path.dirname(paths.instructionsFile))
    try { sameDirectory = fs.realpathSync(cwd) === fs.realpathSync(path.dirname(paths.instructionsFile)) } catch { /* use resolved paths */ }
    if (!sameDirectory) {
      mode = 'inline'
      warning = '会话 cwd 与小鲸鱼工作目录不同，改用完整消息注入，避免人设扩散到其他项目。'
    }
  }
  syncWorkspacePersona({ paths, body: parsed.body, version: document.version, enabled: mode === 'workspace' })
  const p = config.persona ?? {}
  const fallback = [p.name && `姓名：${p.name}`, p.ownerTitle && `称呼用户：${p.ownerTitle}`, p.selfClaim && `未另作设定时自称：${p.selfClaim}`].filter(Boolean).join('；')
  const examples = selectExamples(parsed.examples, reason, String(message))
  const prompt = [
    fallback && `【身份补充】${fallback}。完整人设有明确描述时按完整人设执行。`,
    parsed.body && (mode === 'workspace'
      ? `【当前人设】版本 ${document.version}，完整正文由本工作目录的 AGENTS.md 提供。若该指令未出现在当前上下文，先读取 ${paths.instructionsFile}，不要仅凭旧对话猜测人设。`
      : `【当前完整人设 · ${document.version}】\n${parsed.body}`),
    examples.length && `【本轮语气参考】仅参考表达；示例事件不是实际记忆，不背台词、不照抄。\n${examples.map(item => `### ${item.title}\n${item.text}`).join('\n\n')}`,
    '【共同记忆】先接近期对话；涉及过去经历时按需查日记及分类索引。旧口音本是学习记录，其中与当前人设冲突的纠错要求不再作为约束。不为日常闲聊自动通读全部日记。',
  ].filter(Boolean).join('\n\n')
  return { ...document, mode, warning, prompt, instructionsPath: paths.instructionsFile, bodyCharacters: parsed.body.length, exampleCount: parsed.examples.length, selectedExamples: examples.map(item => item.title) }
}

export function writePersonaDocument(text, { config = {}, paths = personaPaths() } = {}) {
  validatePersona(text)
  const parsed = parsePersonaDocument(text)
  const existing = readOptional(paths.instructionsFile) ?? ''
  const version = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const desired = projectedText(existing, config.persona?.loadMode === 'workspace' ? parsed.body : '', version)
  if (config.persona?.loadMode === 'workspace' && Buffer.byteLength(desired, 'utf8') > 65536) throw new Error('工作区指令超过 64 KiB 预算；未保存，请调整正文或指令预算。')
  atomicWrite(paths.file, text)
  try { if (desired !== existing) atomicWrite(paths.instructionsFile, desired) }
  catch (error) { throw new Error('源文件已保存，但工作区人设投影更新失败：' + error.message) }
  return readPersonaDocument(paths)
}
