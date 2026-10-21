/**
 * lib/ledger.mjs —— 账本（仿 dsh-bili-scroll 的 `out/<date>.md`，但加了条哈希链）
 * ============================================================================
 * 每一轮醒来 / 监听回复，都落一份**人可读的账**：
 *   <root>/rounds/YYYY-MM-DD/HHMM-<mode>.md
 *   <root>/rounds/INDEX.md                    总目录（最近 40 条）
 *
 * 文件头是 front-matter，里面带 `prev`（上一份账的 sha256 前 16 位）——
 * 所以有人（或 agent 自己）偷偷改旧账，`ledger verify` 立刻能发现断裂。
 * 账本不是「必须可信」，而是「被动过就会留痕」，这比"希望它不改"实在。
 *
 * 正文结构（写入提示里也这么教 agent）：
 *   ## 看了什么      · BV… 标题 —— 一句话
 *   ## 判断          值不值得 / 为什么
 *   ## 对外动作       分享 / 评论 / 收藏 / 私信（没做就写「无」）
 *   ## 复核           发出的东西公开可见吗（没查到 ≠ 没发出）
 *   ## 记下的         今天日记里归档出的分类条目
 *   ## 备注
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const GENESIS = 'GENESIS'
export const roundModes = ['peak', 'valley', 'night', 'manual', 'listen', 'dm', 'live', 'skip', 'verify', 'wake']

export const layout = (root) => ({
  root,
  roundsDir: path.join(root, 'rounds'),
  indexPath: path.join(root, 'rounds', 'INDEX.md'),
})

export const ensure = (root) => {
  const L = layout(root)
  fs.mkdirSync(L.roundsDir, { recursive: true })
  return L
}

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

/** 列出所有账本文件（按时间正序） */
export function listRounds(root) {
  const L = layout(root)
  const out = []
  let days = []
  try { days = fs.readdirSync(L.roundsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) } catch { return out }
  for (const day of days.sort()) {
    const dir = path.join(L.roundsDir, day)
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { continue }
    for (const f of files.sort()) out.push({ day, file: path.join(dir, f), name: f })
  }
  return out
}

/** 读一份账（front-matter + 正文） */
export function parseRound(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text, prev: '', id: '' }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: m[2], prev: meta.prev ?? '', id: meta.id ?? '' }
}

/** 上一份账的指纹（没有就是 GENESIS） */
export function lastHash(root) {
  const all = listRounds(root)
  if (!all.length) return GENESIS
  const last = all[all.length - 1]
  return sha(read(last.file))
}

/**
 * 落一份账。
 * @param {object} o
 * @param {string} o.root
 * @param {'peak'|'valley'|'night'|'manual'|'listen'|'dm'|'live'|'skip'} o.mode
 * @param {string} o.title
 * @param {string} o.body
 * @param {object} [o.extra] 额外 front-matter（window / session / score …）
 * @param {Date} [o.at]
 */
export function appendRound({ root, mode = 'manual', title = '', body = '', extra = {}, at = new Date() }) {
  const L = ensure(root)
  const day = at.toLocaleDateString('sv-SE')
  // 文件名必须能按「写入顺序」排序（verifyChain 依赖 listRounds 的顺序）：
  // 只到分钟时，同一分钟里的 verify/wake 会按字母序错位 → 误报链断。
  const hhmmss = `${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}`
  const ms = String(at.getMilliseconds()).padStart(3, '0')
  const dir = path.join(L.roundsDir, day)
  fs.mkdirSync(dir, { recursive: true })
  let c = 0
  let file = path.join(dir, `${hhmmss}-${ms}${String(c).padStart(2, '0')}-${mode}.md`)
  while (fs.existsSync(file) && c < 99) {
    c += 1
    file = path.join(dir, `${hhmmss}-${ms}${String(c).padStart(2, '0')}-${mode}.md`)
  }

  const prev = lastHash(root)
  const meta = {
    id: path.basename(file, '.md'),
    at: at.toISOString(),
    mode,
    title: String(title || '').replace(/\n/g, ' ').slice(0, 120),
    prev,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v).replace(/\n/g, ' ').slice(0, 200)])),
  }
  const front = Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')
  const text = `---\n${front}\n---\n\n${String(body).trim()}\n`
  fs.writeFileSync(file, text, 'utf8')
  rebuildLedgerIndex(root)
  return { file, rel: `${day}/${path.basename(file)}`, meta, hash: sha(text) }
}

/** 重建 rounds/INDEX.md */
export function rebuildLedgerIndex(root) {
  const L = ensure(root)
  const all = listRounds(root)
  const rows = all.slice(-40).reverse().map((x) => {
    const p = parseRound(read(x.file))
    const m = p.meta
    const actions = (p.body.match(/^## 对外动作[\s\S]*?(?=\n## |$)/m)?.[0] ?? '').replace(/\n/g, ' ').slice(0, 80)
    return `| ${String(m.at ?? '').replace('T', ' ').slice(0, 16)} | ${m.mode ?? ''} | ${(m.title ?? '').slice(0, 40)} | ${m.prev ? m.prev.slice(0, 8) : '—'} | [${x.day}/${x.name}](${x.day}/${x.name}) |`
  })
  const lines = [
    '# 账本 · 总目录',
    '',
    '> 每一轮醒来 / 每次监听回复，都会来这里落一份账。',
    '> 头部 `prev:` 是上一份账的 sha256（前 16 位），`node tools/bili.mjs ledger verify` 可查链条有没有断。',
    '',
    `- 账本数：${all.length}`,
    `- 最近更新：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 目录：\`${root}\``,
    '',
    '| 时间 | 模式 | 标题 | prev | 文件 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ]
  fs.writeFileSync(L.indexPath, lines.join('\n'), 'utf8')
  return L.indexPath
}

/** 校验哈希链：任何一份被改过，后面的 prev 就对不上 */
export function verifyChain(root) {
  const all = listRounds(root)
  const broken = []
  let prev = GENESIS
  for (const x of all) {
    const text = read(x.file)
    const p = parseRound(text)
    if (p.prev !== prev) broken.push({ file: x.file, day: x.day, name: x.name, expectedPrev: prev, actualPrev: p.prev })
    prev = sha(text)
  }
  return { ok: broken.length === 0, count: all.length, broken }
}

/** 最近 n 份账（倒序） */
export function tail(root, n = 5) {
  return listRounds(root).slice(-n).reverse().map((x) => {
    const p = parseRound(read(x.file))
    return { day: x.day, name: x.name, file: x.file, meta: p.meta, body: p.body }
  })
}

/** 某一天的全部账（不传 day 就是今天） */
export function dayRounds(root, day = new Date().toLocaleDateString('sv-SE')) {
  return listRounds(root).filter((x) => x.day === day).map((x) => ({ ...x, ...parseRound(read(x.file)) }))
}
