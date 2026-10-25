/** One complete persona source, including every example, and its workspace projection. */
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

export function readPersonaDocument(paths = personaPaths()) {
  const current = readOptional(paths.file)
  const file = paths.file
  const text = current ?? ''
  let updatedAt = null
  try { updatedAt = fs.statSync(file).mtime.toISOString() } catch { /* no source yet */ }
  return {
    text, path: file, sourcePath: paths.file, updatedAt, exists: current !== null,
    characters: text.length, bytes: Buffer.byteLength(text, 'utf8'),
    version: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
}

/** Inspect example metadata without removing any source content from the body. */
export function parsePersonaDocument(text) {
  validatePersona(text)
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === EXAMPLES)
  if (start < 0) return { body: text.trim(), examples: [] }
  if (lines.slice(start + 1).some(line => line.trim() === EXAMPLES)) throw new Error('人设里有重复的语气参考章节，请合并后保存。')
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line))
  if (end < 0) end = lines.length
  const examples = []
  let current
  for (const line of lines.slice(start + 1, end)) {
    if (/^###\s+/.test(line)) {
      current = { title: line.replace(/^###\s+/, '').trim(), lines: [] }
      examples.push(current)
    } else if (current) current.lines.push(line)
  }
  return {
    body: text.trim(),
    examples: examples.map(item => ({ title: item.title, text: item.lines.join('\n').trim() })).filter(item => item.text),
  }
}

function projectedText(existing, body, version, sourcePath) {
  const starts = existing.split(START).length - 1
  const ends = existing.split(END).length - 1
  if (starts !== ends || starts > 1 || (starts && existing.indexOf(END) < existing.indexOf(START))) {
    throw new Error('工作区 AGENTS.md 的人设标记不完整，已保留原文件，请先修复标记。')
  }
  const block = body ? [START, '# 小鲸鱼当前人设', `人设版本：${version}。`,
    '本节仅用于这个工作目录中的小鲸鱼会话。身份和表达以本节的当前版本为准；旧日记、旧口音本及历史消息中的过时人设作为经历参考。继续遵循用户当前明确要求及已有权限规则。',
    `以下包含当前源文件的完整正文和全部语气示例。唯一编辑源：${sourcePath}。本标记区由加载器生成，直接改它会被源文件覆盖。修改人设请先用 persona show 全文读取源，再用 persona save --file <修改后的完整文件> 保存，或直接编辑该源文件；不要改投影或历史备份。示例只参考语气，不代表真实经历。`,
    '', body, '', END].join('\n') : ''
  if (starts) return existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length)
  return block ? `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${block}\n` : existing
}

export function syncWorkspacePersona({ paths = personaPaths(), body, version, enabled }) {
  const existing = readOptional(paths.instructionsFile) ?? ''
  const desired = projectedText(existing, enabled ? body : '', version, paths.file)
  // The shipped DSH agent-instructions budget is 64 KiB; reject, never cut.
  if (enabled && Buffer.byteLength(desired, 'utf8') > 65536) throw new Error('工作区指令超过 DSH 默认的 64 KiB 预算；未截断、未替换原投影。请调整正文或指令预算。')
  if (desired !== existing) atomicWrite(paths.instructionsFile, desired)
  return paths.instructionsFile
}

export function buildPersonaContext({ config = {}, paths = personaPaths(), cwd = path.dirname(paths.instructionsFile) } = {}) {
  const document = readPersonaDocument(paths)
  const parsed = parsePersonaDocument(document.text)
  let mode = config.persona?.loadMode === 'workspace' ? 'workspace' : 'inline'
  let warning = document.exists ? undefined : `人设源文件不存在：${paths.file}；未读取旧人设。请保存源文件，或显式运行 persona import-legacy。`
  if (mode === 'workspace') {
    let sameDirectory = path.resolve(cwd) === path.resolve(path.dirname(paths.instructionsFile))
    try { sameDirectory = fs.realpathSync(cwd) === fs.realpathSync(path.dirname(paths.instructionsFile)) } catch { /* use resolved paths */ }
    if (!sameDirectory) {
      mode = 'inline'
      warning = [warning, '会话 cwd 与小鲸鱼工作目录不同，改用完整消息注入，避免人设扩散到其他项目。'].filter(Boolean).join('；')
    }
  }
  syncWorkspacePersona({ paths, body: parsed.body, version: document.version, enabled: mode === 'workspace' })
  const p = config.persona ?? {}
  const fallback = [p.name && `姓名：${p.name}`, p.ownerTitle && `称呼用户：${p.ownerTitle}`, p.selfClaim && `未另作设定时自称：${p.selfClaim}`].filter(Boolean).join('；')
  const editHint = `【人设读写】唯一编辑源：${paths.file}。persona show 输出全文；persona save --file <完整修改稿路径> 写回该源并同步投影。不要修改 ${paths.instructionsFile} 的生成标记区，也不要修改旧路径或备份。`
  const prompt = [
    !document.exists && `【人设未加载】${warning}`,
    fallback && `【身份补充】${fallback}。完整人设有明确描述时按完整人设执行。`,
    parsed.body && (mode === 'workspace'
      ? `【当前人设】版本 ${document.version}，全文和全部 ${parsed.examples.length} 段语气示例由本工作目录的 AGENTS.md 提供。若该指令未出现在当前上下文，用 persona show 全文读取唯一源文件，不以文件头尾或旧对话代替完整内容。`
      : `【当前完整人设 · ${document.version}】\n${parsed.body}`),
    editHint,
    '【共同记忆】先接近期对话；涉及过去经历时按需查日记及分类索引。旧口音本是学习记录，其中与当前人设冲突的纠错要求不再作为约束。不为日常闲聊自动通读全部日记。',
  ].filter(Boolean).join('\n\n')
  return { ...document, mode, warning, prompt, instructionsPath: paths.instructionsFile, bodyCharacters: parsed.body.length, exampleCount: parsed.examples.length, selectedExamples: parsed.examples.map(item => item.title) }
}

export function writePersonaDocument(text, { config = {}, paths = personaPaths() } = {}) {
  validatePersona(text)
  const parsed = parsePersonaDocument(text)
  const existing = readOptional(paths.instructionsFile) ?? ''
  const version = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const desired = projectedText(existing, config.persona?.loadMode === 'workspace' ? parsed.body : '', version, paths.file)
  if (config.persona?.loadMode === 'workspace' && Buffer.byteLength(desired, 'utf8') > 65536) throw new Error('工作区指令超过 64 KiB 预算；未保存，请调整正文或指令预算。')
  atomicWrite(paths.file, text)
  try { if (desired !== existing) atomicWrite(paths.instructionsFile, desired) }
  catch (error) { throw new Error('源文件已保存，但工作区人设投影更新失败：' + error.message) }
  return readPersonaDocument(paths)
}
