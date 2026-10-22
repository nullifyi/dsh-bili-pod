// 口味（preferences）—— 2026-10-22 主人三条要求：
//   ① 「口味 / 不爱看」要能由小鲸鱼**自己改**（她看完一轮可以顺手加一条，写清理由）；
//   ② 也要能由主人对**她推荐的视频**的感兴趣程度反向调整（感兴趣 → 加进喜欢；不感兴趣 → 加进不爱看）；
//   ③ 女主人的口味单独记，不污染主人的口味。
//
// 所有改动都留痕：~/.bili-ai/taste-log.jsonl 一行一次，主人可以在「设置 → 鲸群 → 日记」下面的
// 账本 / 状态里看到最近的调整。
//
// 用法：
//   node taste.mjs show [--json]
//   node taste.mjs add --like "词" --why "为什么"           （她自改：每天最多 3 条）
//   node taste.mjs add --dislike "词" --why "…"
//   node taste.mjs add --mistress-like "词" --why "…"       （女主人那边）
//   node taste.mjs remove --like "词" / --dislike "词" / --mistress-like "词"
//   node taste.mjs signal --bvid BV1xx411c7mD --level 5 [--note "主人说好看"] [--json]
//   node taste.mjs recent [--n 10] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { writeConfig } from '../../lib/store.mjs'
import { apiGet, signWbi } from '../lib/bili-api.mjs'
import { stateFile } from '../lib/paths.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const LOG = stateFile('taste-log.jsonl')
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'show'
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = v; i += 1 }
}
const JSONOUT = argv.includes('--json')
const cfg = config()
const write = (patch) => {
  const r = writeConfig(patch)
  return r.config
}
const log = (row) => {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
  } catch { /* 留痕失败不影响口味本身 */ }
}
const today = () => new Date().toLocaleDateString('sv-SE')
const todayCount = () => {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((x) => String(x.at).startsWith(today()) && x.action === 'add').length
  } catch { return 0 }
}
const list = (arr) => (Array.isArray(arr) ? arr : []).map((x) => String(x))
const pushUnique = (arr, word) => {
  const w = String(word ?? '').trim().slice(0, 20)
  if (!w) return arr
  const cur = list(arr)
  return cur.includes(w) ? cur : [...cur, w].slice(0, 60)
}
const dropWord = (arr, word) => list(arr).filter((x) => x !== String(word ?? '').trim())

if (cmd === 'show') {
  const out = {
    like: cfg.preferences?.like ?? [],
    dislike: cfg.preferences?.dislike ?? [],
    selfAdjust: cfg.preferences?.selfAdjust !== false,
    learnFromInterest: cfg.preferences?.learnFromInterest !== false,
    todayAdded: todayCount(),
    mistress: cfg.mistress?.enabled ? { like: cfg.mistress.like ?? [], dislike: cfg.mistress.dislike ?? [] } : null,
  }
  if (JSONOUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }
  console.log('== 她的口味 ==')
  console.log(`  喜欢：${list(out.like).join('、') || '（空）'}`)
  console.log(`  不爱看：${list(out.dislike).join('、') || '（空）'}`)
  console.log(`  自改：${out.selfAdjust ? '开' : '关'} · 从感兴趣程度学习：${out.learnFromInterest ? '开' : '关'} · 今天已自改 ${out.todayAdded} 条`)
  if (out.mistress) {
    console.log('== 女主人的口味（单独记得） ==')
    console.log(`  喜欢：${list(out.mistress.like).join('、') || '（空）'}`)
    console.log(`  不爱看：${list(out.mistress.dislike).join('、') || '（空）'}`)
  }
  process.exit(0)
}

if (cmd === 'add' || cmd === 'remove') {
  const why = String(opt.why ?? '').trim()
  const fields = [
    ['like', 'preferences.like', cfg.preferences?.like],
    ['dislike', 'preferences.dislike', cfg.preferences?.dislike],
    ['mistress-like', 'mistress.like', cfg.mistress?.like],
    ['mistress-dislike', 'mistress.dislike', cfg.mistress?.dislike],
  ].filter(([k]) => typeof opt[k] === 'string' && String(opt[k]).trim())
  if (fields.length !== 1) { console.error('一次只改一条：--like / --dislike / --mistress-like / --mistress-dislike 里给一个'); process.exit(2) }
  const [flag, label, cur] = fields[0]
  const word = String(opt[flag]).trim()
  if (!word) { console.error('词是空的'); process.exit(2) }
  const isMistress = flag.startsWith('mistress-')
  if (isMistress && cfg.mistress?.enabled !== true) { console.error('女主人还没启用 —— 先去设置里打开并填她的 mid'); process.exit(2) }
  if (cmd === 'add' && !isMistress) {
    if (cfg.preferences?.selfAdjust === false) { console.error('设置里关掉了「她自己调口味」→ 只能主人手动改'); process.exit(2) }
    if (!why) { console.error('她自改口味要写理由（--why "为什么"），不然主人没法复盘 ✗'); process.exit(2) }
    if (todayCount() >= 3) { console.error('今天的自改额度（3 条）用完了 —— 明天再说'); process.exit(2) }
  }
  const next = cmd === 'add' ? pushUnique(cur, word) : dropWord(cur, word)
  const patch = isMistress
    ? { mistress: { ...(cfg.mistress ?? {}), ...(flag === 'mistress-like' ? { like: next } : { dislike: next }) } }
    : { preferences: { ...(cfg.preferences ?? {}), ...(flag === 'like' ? { like: next } : { dislike: next }) } }
  write(patch)
  log({ action: cmd, field: label, word, why, by: isMistress ? 'self(mistress)' : 'self' })
  console.log(`✓ ${cmd === 'add' ? '加进' : '移出'} ${label}：${word}${why ? `（${why}）` : ''}`)
  process.exit(0)
}

if (cmd === 'signal') {
  if (cfg.preferences?.learnFromInterest === false) { console.error('设置里关掉了「从感兴趣程度学习」'); process.exit(2) }
  const bvid = String(opt.bvid ?? '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) { console.error('要一个有效的 --bvid'); process.exit(2) }
  const level = Number(opt.level ?? 3)
  const note = String(opt.note ?? '').slice(0, 200)
  let words = []
  let title = ''
  try {
    const j = await apiGet(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${bvid}`, {}, { cache: true })
    const d = j?.data ?? {}
    title = String(d.title ?? '')
    if (d.tname) words.push(String(d.tname))
    for (const tag of Array.isArray(d.tags) ? d.tags : []) if (tag?.tag_name) words.push(String(tag.tag_name))
  } catch { /* 拉不到标签就只用 note 里的词 */ }
  words = words.map((w) => w.trim()).filter((w) => w && w.length <= 12)
  const nextLike = level >= 4 ? words.reduce(pushUnique, cfg.preferences?.like ?? []) : cfg.preferences?.like ?? []
  const nextDislike = level <= 2 ? words.reduce(pushUnique, cfg.preferences?.dislike ?? []) : cfg.preferences?.dislike ?? []
  write({ preferences: { ...(cfg.preferences ?? {}), like: nextLike, dislike: nextDislike } })
  log({ action: 'signal', bvid, level, note, words, title })
  const out = { ok: true, bvid, title, level, added: level >= 4 ? words : level <= 2 ? words : [], like: nextLike, dislike: nextDislike }
  if (JSONOUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }
  console.log(`已记下：${title || bvid} · 感兴趣程度 ${level}/5`)
  if (!words.length) console.log('  （没抓到标签，只留了记录；下次可以 --note 里写关键词）')
  else console.log(`  ${level >= 4 ? '加进喜欢' : level <= 2 ? '加进不爱看' : '中性，只留记录'}：${words.join('、')}`)
  process.exit(0)
}

if (cmd === 'recent') {
  const n = Math.max(1, Math.min(50, Number(opt.n) ?? 10))
  let rows = []
  try {
    rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-n).reverse()
  } catch { /* 没调整过 */ }
  if (JSONOUT) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }
  if (!rows.length) { console.log('（还没有口味调整记录）'); process.exit(0) }
  for (const r of rows) {
    const t = new Date(r.at).toLocaleString('zh-CN', { hour12: false })
    console.log(`  ${t}  ${r.action} ${r.field ?? r.bvid ?? ''} ${r.word ?? ''} ${r.why ?? r.note ?? ''}`.trim())
  }
  process.exit(0)
}

console.error('用法: taste.mjs show|add|remove|signal|recent  （见文件头）')
process.exit(2)
