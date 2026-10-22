/**
 * lib/defaults.mjs —— 配置默认值（宿主 / 工具链 / 测试共用同一份）
 * ============================================================================
 * 基座把 DEFAULTS 写在 lib/index.js 里；鲸群把它挪出来是因为：
 *   · 工具链（tools/lib/config.mjs）也要知道新字段的默认值；
 *   · 测试要能直接拿 DEFAULTS 断言；
 *   · mod / 扩展面板要能读同一套 schema。
 *
 * 兼容性：老配置（基座时期写的）缺字段一律用这里补；未知字段原样保留。
 * ============================================================================
 */
import { TIDE_DEFAULTS } from './tide.mjs'
import { DEFAULT_KINDS } from './diarystore.mjs'

export const DEFAULTS = {
  reportLevel: 'full',
  commentPerRound: 1,
  replyPerRound: 1,
  replyToComments: false,
  favFolderId: '',
  search: { order: 'totalrank' },
  owner: { mid: '', name: '' },
  night: {
    // mode: fixed = 基座的「固定窗口」；tide = 峰谷生物钟（可选）
    mode: 'fixed',
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,
    maxVideos: 5,
    tide: { ...TIDE_DEFAULTS },
  },
  preferences: {
    like: ['显卡', '编程', 'AI', '解剖', '科普'],
    dislike: ['带货', '营销号', '战争', '擦边'],
    keywords: [],
  },
  quota: { shareDaily: 3 },
  diary: {
    push: true,
    enabled: true,
    dir: '',
    autoArchive: true,
    records: [...DEFAULT_KINDS],
  },
  persona: { name: '', ownerTitle: '主人', selfClaim: '我', diaryTitle: '今日摘要' },
  aliases: [],
  self: { mid: '', name: '' },
  notify: { type: 'none', url: '', template: 'text', cmd: '', args: [] },
  listen: {
    comment: true,
    commentIntervalSec: 300,
    scope: 'both',
    oncePerPerson: true,
    // 2026-10-22（上游 v0.4.5）：主人在 @ 里点「总结」时才回一份摘要（默认关）
    mentionSummary: false,
    allDay: false,
    dm: false,
    live: false,
    liveRoom: '',
    liveScope: 'owner',
  },
  share: { enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3, decayPerDay: 1 },
  // 发前审核 & 发出后复核（主人要求：审核默认开启，可以关）
  review: { preReview: true, verify: true, verifyRounds: 2, verifyIntervalSec: 20 },
  // 每轮工具白名单的「额外放宽」（默认都关：发动态/弹幕/删评论不是刷视频这一轮该干的事）
  scope: { allowDynamic: false, allowDanmaku: false, allowDelete: false },
  ledger: { enabled: true },
  // 产出物（每轮深读报告 / 抽帧图）默认不落盘
  artifacts: { enabled: false, dir: '' },
  // mod 扩展
  extensions: { enabled: true, dirs: [], items: {} },
  toolsPath: '',
}

export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** 深合并：over 覆盖 base；数组整体替换（不要合并出奇怪的下标） */
export function mergeDeep(base, over) {
  if (!isObj(base)) return structuredClone(over === undefined ? base : over)
  const out = structuredClone(base)
  if (!isObj(over)) return over === undefined ? out : structuredClone(over)
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : structuredClone(v)
  }
  return out
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/** 归一 + 夹紧越界值；返回 {config, warns} */
export function normalizeConfig(raw = {}) {
  const cfg = mergeDeep(DEFAULTS, raw ?? {})
  const warns = []
  cfg.reportLevel = ['full', 'brief', 'off'].includes(cfg.reportLevel) ? cfg.reportLevel : 'full'
  cfg.commentPerRound = Math.floor(clampNum(cfg.commentPerRound, 0, 20, 1))
  cfg.replyPerRound = Math.floor(clampNum(cfg.replyPerRound, 1, 10, 1))
  cfg.replyToComments = Object.hasOwn(raw ?? {}, 'replyToComments') ? raw.replyToComments === true : raw?.listen?.comment === true
  cfg.share.via = ['comment', 'dm', 'both'].includes(cfg.share.via) ? cfg.share.via : 'comment'
  cfg.favFolderId = /^[1-9]\d*$/.test(String(cfg.favFolderId)) ? String(cfg.favFolderId) : ''
  cfg.search = isObj(cfg.search) ? cfg.search : {}
  cfg.search.order = ['totalrank', 'click', 'pubdate', 'dm', 'stow', 'scores'].includes(cfg.search.order) ? cfg.search.order : 'totalrank'
  const n = cfg.night
  n.maxWakesPerDay = clampNum(n.maxWakesPerDay, 0, 12, 0)
  n.skipChance = clampNum(n.skipChance, 0, 0.95, 0.3)
  n.maxVideos = clampNum(n.maxVideos, 1, 20, 5)
  n.mode = n.mode === 'tide' ? 'tide' : 'fixed'
  n.tide = mergeDeep({ ...TIDE_DEFAULTS }, n.tide && typeof n.tide === 'object' ? n.tide : {})

  cfg.quota.shareDaily = clampNum(cfg.quota.shareDaily, 0, 20, 3)
  cfg.share.minScore = clampNum(cfg.share.minScore, 0, 20, 13)
  cfg.listen.commentIntervalSec = clampNum(cfg.listen.commentIntervalSec, 60, 86400, 300)
  cfg.review.preReview = cfg.review.preReview !== false
  cfg.review.verify = cfg.review.verify !== false
  cfg.review.verifyRounds = clampNum(cfg.review.verifyRounds, 1, 5, 2)
  cfg.review.verifyIntervalSec = clampNum(cfg.review.verifyIntervalSec, 5, 300, 20)
  cfg.artifacts.enabled = cfg.artifacts.enabled === true
  cfg.ledger.enabled = cfg.ledger.enabled !== false
  cfg.scope.allowDynamic = cfg.scope.allowDynamic === true
  cfg.scope.allowDanmaku = cfg.scope.allowDanmaku === true
  cfg.scope.allowDelete = cfg.scope.allowDelete === true

  if (!Array.isArray(cfg.diary.records) || cfg.diary.records.length === 0) cfg.diary.records = [...DEFAULT_KINDS]
  cfg.diary.records = cfg.diary.records.map((s) => String(s).trim()).filter(Boolean).slice(0, 24)

  if (!Array.isArray(cfg.extensions.dirs)) cfg.extensions.dirs = []
  if (!isObj(cfg.extensions.items)) cfg.extensions.items = {}

  // 保存时顺手提醒几个「一看就知道想要什么」的坑
  if (n.mode === 'fixed') {
    const sum = (n.windows ?? []).reduce((s, w) => s + (Number(w?.wakes) || 0), 0)
    if (sum === 0) warns.push('作息窗口的「醒来次数」全是 0 → 她永远不会醒')
  }
  if (cfg.share.enabled && cfg.quota.shareDaily > 6) warns.push('每天分享上限 > 6，B站可能会当成刷屏')
  if (n.mode === 'tide' && (!n.tide.peakStart || !n.tide.valleyStart)) warns.push('峰谷模式缺少峰/谷时间')
  return { config: cfg, warns }
}

/** 给客户端 / 扩展看的「哪些字段敏感」清单（永不回显的值） */
export const SECRET_KEYS = ['sessdata', 'bili_jct', 'buvid3', 'dedeuserid']
