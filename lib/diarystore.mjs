/**
 * lib/diarystore.mjs —— 「分栏日记 + 分类记录库」的存储层
 * ============================================================================
 * 主人要的样子（2026-10-22）：
 *   · 给自己的一份日记，时间久了会太厚 → 改成一个**文件夹**：
 *       daily/YYYY-MM-DD.md     今天还没归档的那一天
 *       archive/YYYY-MM/*.md    归档后的原文（主人需要时才 recall 出来看）
 *       owner/YYYY-MM-DD.md     给主人的那份日记（保持基座那种单篇写法）
 *   · 日记里带分类标记的句子，归档时摘进 records/<分类>.md（吐槽 / 思考 / 学习 …）
 *   · records/INDEX.md 是**总索引**：分类 → 条目数 → 最近日期 → 文件
 *   · 分类可以继续加（设置里加一格，或手工新建一个 records/<分类>.md，
 *     归档器遇到没见过的分类会自己建文件并在索引里登记）
 *
 * 日记里的标记写法（写进唤醒提示，agent 照这个写）：
 *   - [吐槽] 今天这个推荐算法又塞了一堆…
 *   - [思考] 「被推荐」和「主动找」之间的差别…
 *   - [学习] 学会了一个词：infrastructure as code
 *   - [想说的] 下次他要是问起，我想说…
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEFAULT_KINDS = ['吐槽', '思考', '学习', '想说的', '人际', '视频']

/** 分类别名 → 规范名（中英都认，agent 偶尔会写英文） */
export const KIND_ALIASES = {
  吐槽: '吐槽', tirades: '吐槽', rant: '吐槽', rants: '吐槽',
  思考: '思考', thoughts: '思考', thought: '思考', think: '思考',
  学习: '学习', learning: '学习', learn: '学习', study: '学习',
  想说的: '想说的', wants: '想说的', want: '想说的',
  人际: '人际', people: '人际',
  视频: '视频', videos: '视频', video: '视频', watch: '视频',
}

export const dayKey = (v = Date.now()) => new Date(v).toLocaleDateString('sv-SE')

function validateDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('日记日期 day 必须是有效的 YYYY-MM-DD 日期')
  }
  return day
}

function validateKind(kind) {
  if (typeof kind !== 'string' || !kind.trim() || /[<>:"/\\|?*\u0000-\u001f]/.test(kind)
    || /[. ]$/.test(kind) || /^index$/i.test(kind)) {
    throw new Error('记录分类 kind 不合法：不能包含路径字符或使用保留名 INDEX')
  }
  return kind
}

export function addDays(day, n) {
  validateDay(day)
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

export function layout(root) {
  return {
    root,
    dailyDir: path.join(root, 'daily'),
    ownerDir: path.join(root, 'owner'),
    archiveDir: path.join(root, 'archive'),
    recordsDir: path.join(root, 'records'),
    indexPath: path.join(root, 'records', 'INDEX.md'),
    statePath: path.join(root, '.state.json'),
    daily: (day) => path.join(root, 'daily', `${validateDay(day)}.md`),
    owner: (day) => path.join(root, 'owner', `${validateDay(day)}.md`),
    archive: (day) => path.join(root, 'archive', validateDay(day).slice(0, 7), `${day}.md`),
    ownerArchive: (day) => path.join(root, 'archive', validateDay(day).slice(0, 7), 'owner', `${day}.md`),
    record: (kind) => path.join(root, 'records', `${validateKind(kind)}.md`),
  }
}

export function ensureLayout(root) {
  const L = layout(root)
  for (const d of [L.root, L.dailyDir, L.ownerDir, L.archiveDir, L.recordsDir]) fs.mkdirSync(d, { recursive: true })
  return L
}

const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const writeText = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, s, 'utf8')
    fs.renameSync(tmp, p)
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
}
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12)

export function readState(root) {
  try { return JSON.parse(readText(layout(root).statePath) || '{}') } catch { return {} }
}
export function writeState(root, state) {
  writeText(layout(root).statePath, JSON.stringify(state, null, 2) + '\n')
}

/** 规范分类名：认识的别名归一，不认识的按原样（trim、去 emoji 级空白） */
export function normalizeKind(raw, kinds = DEFAULT_KINDS) {
  const k = String(raw ?? '').trim().replace(/[:：]$/, '')
  if (!k) return ''
  const norm = KIND_ALIASES[k] ?? KIND_ALIASES[k.toLowerCase()]
  if (norm) return norm
  return k
}

/**
 * 从日记正文里抽出带分类标记的句子。
 * 支持三种写法：`- [吐槽] x` / `[吐槽] x` / `## 吐槽` 后跟若干行。
 * @returns {{kind:string, text:string}[]}
 */
export function entriesFrom(text, kinds = DEFAULT_KINDS) {
  const out = []
  let section = null
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (/^<!-- diary-fragment:[a-f0-9]{12} -->$/.test(line) || /^#\s/.test(line)) {
      section = null
      continue
    }
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const maybe = normalizeKind(heading[1].replace(/[（(].*$/, ''), kinds)
      section = kinds.includes(maybe) || KIND_ALIASES[heading[1].trim()] ? maybe : null
      continue
    }
    const marked = /^\s*(?:[-*·]\s*)?\[([^\]]{1,12})\]\s*(.+)$/.exec(line)
    if (marked) {
      const kind = normalizeKind(marked[1], kinds)
      if (kind) out.push({ kind, text: marked[2].trim() })
      continue
    }
    if (section) {
      const plain = /^\s*(?:[-*·]\s*)?(.+)$/.exec(line)
      if (plain && plain[1].trim() && !/^\s*（空）/.test(plain[1])) out.push({ kind: section, text: plain[1].trim() })
    }
  }
  return out
}

/** 追加一段到今天的（或指定日的）日记 */
export function appendDaily(root, { day = dayKey(), kind = 'self', text }) {
  const L = ensureLayout(root)
  const file = kind === 'owner' ? L.owner(day) : L.daily(day)
  const had = fs.existsSync(file)
  const head = had ? '' : (kind === 'owner'
    ? `# ${day} · 给主人的日记\n\n`
    : `# ${day} · 她的日记\n\n（每条一句，前面加分类标记：[吐槽] / [思考] / [学习] / [想说的] / [人际] / [视频]）\n\n`)
  fs.appendFileSync(file, `${head}${String(text).trim()}\n`, 'utf8')
  return file
}

const RECORD_HEADER = (kind) => `# 记录 · ${kind}\n\n> 由每日日记自动归档（日记里写 \`- [${kind}] …\`）。\n> 总索引见 [INDEX.md](INDEX.md)；要加分类：设置里加一格，或直接新建 \`records/<分类>.md\`。\n\n`

/** 正文成功后才保存去重状态；正文中的稳定标记支持状态失败后的重试。 */
export function appendRecord(root, { kind, text, day, source }) {
  validateDay(day)
  const L = ensureLayout(root)
  const k = normalizeKind(kind) || '其他'
  const file = L.record(k)
  const state = readState(root)
  state.entryKeys ??= {}
  const list = (state.entryKeys[k] ??= [])
  const key = sha(`${day}|${k}|${text}`)
  if (list.includes(key)) return { file, added: false }
  const marker = `<!-- diary-entry:${key} -->`
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const added = !existing.includes(marker)
  if (added) {
    if (!fs.existsSync(file)) writeText(file, RECORD_HEADER(k))
    const src = source ? `来源 ${source}` : `来源 ${day}`
    fs.appendFileSync(file, `- **${day}** · ${src}\n  「${text}」 ${marker}\n`, 'utf8')
  }
  list.push(key)
  if (list.length > 5000) state.entryKeys[k] = list.slice(-5000)
  writeState(root, state)
  return { file, added }
}

/** 归类统计 */
export function stats(root, kinds = DEFAULT_KINDS) {
  const L = layout(root)
  const found = []
  let files = []
  try { files = fs.readdirSync(L.recordsDir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md') } catch { /* 还没建 */ }
  for (const f of files) {
    const kind = f.replace(/\.md$/, '')
    const text = readText(path.join(L.recordsDir, f))
    const dates = [...text.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\*\*/g)].map((m) => m[1]).sort()
    found.push({ kind, count: dates.length, last: dates[dates.length - 1] ?? '', file: `records/${f}` })
  }
  const extras = kinds.filter((k) => !found.some((x) => x.kind === k)).map((k) => ({ kind: k, count: 0, last: '', file: `records/${k}.md` }))
  return [...found, ...extras].sort((a, b) => (b.last || '').localeCompare(a.last || '') || a.kind.localeCompare(b.kind, 'zh'))
}

/** 重写 records/INDEX.md（总索引） */
export function rebuildIndex(root, { kinds = DEFAULT_KINDS, archived = [] } = {}) {
  const L = ensureLayout(root)
  const rows = stats(root, kinds)
  const total = rows.reduce((n, r) => n + r.count, 0)
  const state = readState(root)
  const recent = (archived.length ? archived : state.archived ?? []).slice(-12).reverse()
  const lines = []
  lines.push('# 记录总索引')
  lines.push('')
  lines.push('> 这是鲸群的「长期记忆」总目录：每天写完日记后，前一天的日记会被归档，')
  lines.push('> 里面带 `[吐槽]` / `[思考]` / `[学习]` / `[想说的]` / `[人际]` / `[视频]` 标记的句子')
  lines.push('> 会被摘到对应分类文件里。归档后的原文留在 `archive/`，只有你主动 recall 时才再翻出来读。')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push(`- 分类：${rows.length} 个 · 记录条目：${total} 条`)
  lines.push(`- 目录：\`${root}\``)
  lines.push('')
  lines.push('| 分类 | 条目 | 最近一条 | 文件 |')
  lines.push('| --- | ---: | --- | --- |')
  for (const r of rows) lines.push(`| ${r.kind} | ${r.count} | ${r.last || '—'} | [${r.file}](${r.file}) |`)
  lines.push('')
  lines.push('## 最近归档')
  if (!recent.length) lines.push('（还没有归档 —— 第二天醒来写完日记后会自动归档前一天）')
  else {
    lines.push('| 日期 | 归档文件 | 摘出 | 分类 |')
    lines.push('| --- | --- | ---: | --- |')
    for (const a of recent) {
      lines.push(`| ${a.day} | [${a.file}](${a.file}) | ${a.entries ?? 0} | ${(a.kinds ?? []).join(' / ') || '—'} |`)
    }
  }
  lines.push('')
  lines.push('## 怎么扩展')
  lines.push('1. 设置 → 鲸群 → 日记 → 记录分类里加一个名字（例如「读书」）；')
  lines.push('2. 以后日记里写 `- [读书] …`，归档时会自动建 `records/读书.md` 并写进这张总索引；')
  lines.push('3. 想立刻手记：`node tools/bili.mjs records add 读书 "…"`。')
  lines.push('')
  writeText(L.indexPath, lines.join('\n'))
  return { indexPath: L.indexPath, total, rows }
}

/**
 * 归档某一天：日记原文移进 archive/，标记句摘进 records/，最后重建索引。
 * @returns {{day:string, archived:boolean, entries:number, kinds:string[], file?:string, reason?:string}}
 */
export function archiveDay(root, day, { kinds = DEFAULT_KINDS, keepIndex = true } = {}) {
  validateDay(day)
  const L = ensureLayout(root)
  const src = L.daily(day)
  const dst = L.archive(day)
  const osrc = L.owner(day)
  const odst = L.ownerArchive(day)
  const hasSelf = fs.existsSync(src)
  const hasOwner = fs.existsSync(osrc)
  if (!hasSelf && !hasOwner) return { day, archived: false, entries: 0, kinds: [], reason: '那一天没有日记' }

  // 先写副本，状态与索引完成前保留源文件。标记让失败重试不重复拼接片段。
  const preserve = (from, to) => {
    const text = fs.readFileSync(from, 'utf8')
    const existing = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : ''
    const marker = `<!-- diary-fragment:${sha(text)} -->`
    if (!fs.existsSync(to)) writeText(to, text)
    else if (existing !== text && !existing.includes(marker)) writeText(to, `${existing}\n${marker}\n${text}`)
  }
  if (hasSelf) preserve(src, dst)
  if (hasOwner) preserve(osrc, odst)

  // 从完整归档重建统计，旧片段与状态失败前已摘出的记录仍计入本日。
  const entries = entriesFrom(fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '', kinds)
  const used = new Set()
  for (const e of entries) {
    appendRecord(root, { kind: e.kind, text: e.text, day, source: `archive/${day.slice(0, 7)}/${day}.md` })
    used.add(e.kind)
  }

  const file = fs.existsSync(dst) ? `archive/${day.slice(0, 7)}/${day}.md` : `archive/${day.slice(0, 7)}/owner/${day}.md`
  const state = readState(root)
  state.archived ??= []
  state.archived = state.archived.filter((a) => a.day !== day)
  state.archived.push({ day, file, entries: entries.length, kinds: [...used], at: new Date().toISOString() })
  state.lastArchive = day
  writeState(root, state)
  if (keepIndex) rebuildIndex(root, { kinds })
  if (hasSelf) fs.unlinkSync(src)
  if (hasOwner) fs.unlinkSync(osrc)
  return { day, archived: true, entries: entries.length, kinds: [...used], file }
}

/**
 * 归档所有「今天是 day 之前 keepDays 天」的日记。
 * keepDays=1 表示：今天写完 → 归档昨天及更早。
 */
export function archiveDue(root, { now = Date.now(), keepDays = 1, kinds = DEFAULT_KINDS } = {}) {
  const L = layout(root)
  const today = dayKey(now)
  const cutoff = addDays(today, -keepDays) // 只归档 <= cutoff
  const files = new Set()
  for (const dir of [L.dailyDir, L.ownerDir]) {
    try { for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) files.add(f) } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  const res = []
  for (const f of [...files].sort()) {
    const day = f.replace(/\.md$/, '')
    if (day > cutoff) continue
    res.push(archiveDay(root, day, { kinds }))
  }
  return res
}

/** 翻旧账：按日期或关键词在 archive/ 里找 */
export function recall(root, { day, query, limit = 5 } = {}) {
  const L = layout(root)
  const hits = []
  const scanFile = (file, fallbackDay) => {
    const text = readText(file)
    if (query) {
      const idx = text.toLowerCase().indexOf(String(query).toLowerCase())
      if (idx < 0) return
      hits.push({ day: dayKey(fallbackDay), file, snippet: text.slice(Math.max(0, idx - 80), idx + 160).replace(/\n+/g, ' ') })
    } else {
      hits.push({ day: fallbackDay, file, snippet: text.slice(0, 400).replace(/\n+/g, ' ') })
    }
  }
  if (day !== undefined) {
    const f = L.archive(day)
    if (fs.existsSync(f)) scanFile(f, day)
    for (const v of [L.ownerArchive(day), L.daily(day), L.owner(day)]) if (fs.existsSync(v)) scanFile(v, day)
    return hits
  }
  const months = (() => { try { return fs.readdirSync(L.archiveDir) } catch { return [] } })()
  const files = []
  for (const m of months) {
    const dir = path.join(L.archiveDir, m)
    let list = []
    try { list = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { /* ignore */ }
    for (const f of list) files.push({ m, f })
    const odir = path.join(dir, 'owner')
    let olist = []
    try { olist = fs.readdirSync(odir).filter((f) => f.endsWith('.md')) } catch { /* ignore */ }
    for (const f of olist) files.push({ m, f, owner: true })
  }
  files.sort((a, b) => b.m.localeCompare(a.m) || b.f.localeCompare(a.f))
  for (const x of files) {
    if (hits.length >= limit) break
    scanFile(x.owner ? path.join(L.archiveDir, x.m, 'owner', x.f) : path.join(L.archiveDir, x.m, x.f), x.f.replace(/\.md$/, ''))
  }
  return hits
}

/** 人读摘要：今日 + 分类统计 + 最近归档 */
export function summary(root, { now = Date.now(), kinds = DEFAULT_KINDS } = {}) {
  const L = ensureLayout(root)
  const today = dayKey(now)
  const state = readState(root)
  return {
    root,
    today,
    todayDiary: readText(L.daily(today)),
    ownerDiary: readText(L.owner(today)),
    kinds: stats(root, kinds),
    lastArchive: state.lastArchive ?? '',
    archived: (state.archived ?? []).slice(-5).reverse(),
  }
}
