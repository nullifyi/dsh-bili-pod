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
  // 女主人（2026-10-22 主人要求）：权限比主人低一档，但她是「要尽量奉承」的人。
  //   · 只给她分享（不替她发评论），每天 1 条，且必须过发前审核
  //   · 她喜欢的口味单独记，不污染主人的口味
  mistress: {
    enabled: false,
    mid: '',
    name: '',
    title: '女主人',
    shareDaily: 1,
    replyAlways: true,
    replyMaxPerDay: 0,
    splitLong: true,
    like: [],
    dislike: [],
    notes: '',
    styleNotes: '',
  },
  night: {
    // mode: fixed = 固定窗口；tide = 自己划峰谷；cheap = DeepSeek API 低价时段
    mode: 'fixed',
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,
    maxVideos: 5,
    tide: { ...TIDE_DEFAULTS },
    // 低价时段（DeepSeek 折扣窗口，北京时间 00:30–08:30）—— 窗口/次数/跳过率都可改
    cheap: {
      windows: [{ start: '00:30', end: '08:30' }],
      wakes: 2,
      skipChance: 0.15,
    },
  },
  preferences: {
    like: ['显卡', '编程', 'AI', '解剖', '科普'],
    dislike: ['带货', '营销号', '战争', '擦边'],
    keywords: [],
    // 允许她自己微调口味（按当天看到的、主人反馈的）；关了就只能主人手动改
    selfAdjust: true,
    // 主人对她分享视频的「感兴趣 / 不感兴趣」信号回流成口味微调
    learnFromInterest: true,
  },
  quota: { shareDaily: 3 },
  diary: {
    push: true,
    enabled: true,
    dir: '',
    autoArchive: true,
    records: [...DEFAULT_KINDS],
  },
  persona: { name: '', ownerTitle: '主人', selfClaim: '我', diaryTitle: '今日摘要', loadMode: 'inline' },
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
  // 私信（2026-10-22 主人要求可自动发）——注意这是「第二道门」：
  //   review.policy 决定「谁有资格免审」，这里决定「私信到底要不要自动发」。
  //   · autoSend 默认关（主人强调：可选，不要偷偷放宽）
  //   · autoSendTo 默认只自动给主人；女主人要自己勾
  //   · maxPerDay / minGapMinutes：防刷屏，也防「一分钟连发三条」
  dm: {
    autoSend: false,
    autoSendTo: ['owner'],
    recipients: ['owner'],
    maxPerDay: 1,
    minGapMinutes: 240,
  },
  // 发前审核 & 发出后复核
  //   review.policy（0.7.0）四档：ask / auto-owner / auto-quiet / off
  //   · 旧配置迁移：没写 policy 时，preReview=false → off，其余 → auto-quiet（主人 2026-10-22 拍板「第三档」）
  //   · 新装默认 auto-owner：自家人（主人）直接发，陌生人先存草稿
  review: {
    preReview: true,
    policy: 'auto-owner',
    verify: true,
    verifyRounds: 2,
    verifyIntervalSec: 20,
    // 自动发出的闸门（只统计「没经过主人手」的消息；草稿不占额度）
    autoLimits: { perDay: 12, perPersonPerDay: 1, quietHours: [] },
  },
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
  cfg.persona.loadMode = cfg.persona.loadMode === 'workspace' ? 'workspace' : 'inline'
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
  n.mode = ['fixed', 'tide', 'cheap'].includes(n.mode) ? n.mode : 'fixed'
  n.tide = mergeDeep({ ...TIDE_DEFAULTS }, n.tide && typeof n.tide === 'object' ? n.tide : {})
  n.cheap = isObj(n.cheap) ? n.cheap : {}
  n.cheap.windows = Array.isArray(n.cheap.windows) && n.cheap.windows.length
    ? n.cheap.windows.slice(0, 4).map((w) => ({ start: String(w?.start ?? '00:30'), end: String(w?.end ?? '08:30') }))
    : [{ start: '00:30', end: '08:30' }]
  n.cheap.wakes = clampNum(n.cheap.wakes, 1, 12, 2)
  n.cheap.skipChance = clampNum(n.cheap.skipChance, 0, 0.95, 0.15)

  // 女主人（可选）：只在她启用 + 填了 mid 时才参与分享
  cfg.mistress = isObj(cfg.mistress) ? cfg.mistress : {}
  cfg.mistress.enabled = cfg.mistress.enabled === true
  cfg.mistress.mid = /^\d+$/.test(String(cfg.mistress.mid ?? '')) ? String(cfg.mistress.mid) : ''
  cfg.mistress.name = String(cfg.mistress.name ?? '').trim().slice(0, 40)
  cfg.mistress.title = String(cfg.mistress.title ?? '女主人').trim().slice(0, 20) || '女主人'
  cfg.mistress.shareDaily = clampNum(cfg.mistress.shareDaily, 0, 10, 1)
  // 2026-10-22 主人追加：她发来的消息必须回（回信不占主动私信额度，但有自己的日上限）；
  //   一条塞不下可以分两条；称呼与语气随人格生长（styleNotes 由她自己在日记里慢慢补）。
  cfg.mistress.replyAlways = cfg.mistress.replyAlways !== false
  // 0 = 不限：她发消息来就回，不受「防刷屏」拦（要限就填正数）
  cfg.mistress.replyMaxPerDay = clampNum(cfg.mistress.replyMaxPerDay, 0, 100, 0)
  cfg.mistress.splitLong = cfg.mistress.splitLong !== false
  cfg.mistress.styleNotes = String(cfg.mistress.styleNotes ?? '').slice(0, 1000)
  for (const k of ['like', 'dislike']) {
    cfg.mistress[k] = Array.isArray(cfg.mistress[k]) ? cfg.mistress[k].map((s) => String(s).trim()).filter(Boolean).slice(0, 40) : []
  }
  cfg.mistress.notes = String(cfg.mistress.notes ?? '').slice(0, 500)
  if (cfg.mistress.enabled && !cfg.mistress.mid) warns.push('女主人已启用，但没填她的 mid → 不会给她分享')
  if (cfg.mistress.enabled && cfg.mistress.mid && cfg.mistress.mid === String(cfg.owner?.mid ?? '')) warns.push('女主人 mid 和主人 mid 一样 → 请填另一个账号')

  cfg.preferences.selfAdjust = cfg.preferences.selfAdjust !== false
  cfg.preferences.learnFromInterest = cfg.preferences.learnFromInterest !== false

  cfg.quota.shareDaily = clampNum(cfg.quota.shareDaily, 0, 20, 3)
  cfg.share.minScore = clampNum(cfg.share.minScore, 0, 20, 13)
  cfg.listen.commentIntervalSec = clampNum(cfg.listen.commentIntervalSec, 60, 86400, 300)
  // ── 审核档位（0.7.0）────────────────────────────────────────────────
  // 显式 policy 永远优先；只有「旧配置（有 review 段但没有 policy）」才从 preReview 迁移：
  //   preReview === false → off（他明确关过，尊重）
  //   其余（默认开）      → auto-quiet（主人 2026-10-22 拍板：旧配置进第三档）
  // 全新安装（raw 里连 review 都没有）→ DEFAULTS 的 auto-owner。
  const POLICIES = ['ask', 'auto-owner', 'auto-quiet', 'off']
  const reviewRaw = isObj(raw?.review) ? raw.review : null
  const explicitPolicy = reviewRaw?.policy
  if (POLICIES.includes(explicitPolicy)) cfg.review.policy = explicitPolicy
  else if (reviewRaw) cfg.review.policy = reviewRaw.preReview === false ? 'off' : 'auto-quiet'
  else cfg.review.policy = 'auto-owner'
  // preReview 保留为「off 的镜像」，兼容老代码与老测试（真实决策只看 policy）
  cfg.review.preReview = cfg.review.policy !== 'off'
  cfg.review.verify = cfg.review.verify !== false
  cfg.review.verifyRounds = clampNum(cfg.review.verifyRounds, 1, 5, 2)
  cfg.review.verifyIntervalSec = clampNum(cfg.review.verifyIntervalSec, 5, 300, 20)
  cfg.review.autoLimits = isObj(cfg.review.autoLimits) ? cfg.review.autoLimits : {}
  cfg.review.autoLimits.perDay = Math.floor(clampNum(cfg.review.autoLimits.perDay, 0, 100, 12))
  cfg.review.autoLimits.perPersonPerDay = Math.floor(clampNum(cfg.review.autoLimits.perPersonPerDay, 0, 20, 1))
  const quietHours = Array.isArray(cfg.review.autoLimits.quietHours) ? cfg.review.autoLimits.quietHours : []
  cfg.review.autoLimits.quietHours = quietHours
    .map((r) => ({ start: String(r?.start ?? '').trim(), end: String(r?.end ?? '').trim() }))
    .filter((r) => /^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.end))
    .slice(0, 4)

  // ── 私信（0.7.0）────────────────────────────────────────────────────
  cfg.dm = isObj(cfg.dm) ? cfg.dm : {}
  const roles = (v, dflt) => {
    const list = Array.isArray(v) ? v.map((s) => String(s)) : []
    const kept = [...new Set(list.filter((r) => r === 'owner' || r === 'mistress'))]
    return kept.length ? kept : dflt
  }
  cfg.dm.autoSend = cfg.dm.autoSend === true
  cfg.dm.autoSendTo = roles(cfg.dm.autoSendTo, ['owner'])
  cfg.dm.recipients = roles(cfg.dm.recipients, ['owner'])
  cfg.dm.maxPerDay = Math.floor(clampNum(cfg.dm.maxPerDay, 0, 10, 1))
  cfg.dm.minGapMinutes = Math.floor(clampNum(cfg.dm.minGapMinutes, 0, 1440, 240))
  if (cfg.dm.autoSend && cfg.review.policy === 'ask') warns.push('私信自动发送开了，但审核档还是「每次都问我」→ 私信仍会转成草稿')
  if (cfg.dm.autoSend && cfg.dm.autoSendTo.includes('mistress') && !cfg.mistress.enabled) warns.push('私信要自动发给女主人，但女主人还没启用 → 这一项暂时不起作用')
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
  if (n.mode === 'cheap' && (!n.cheap?.windows?.length)) warns.push('低价时段没设窗口 → 会退回「固定窗口」')
  return { config: cfg, warns }
}

/** 给客户端 / 扩展看的「哪些字段敏感」清单（永不回显的值） */
export const SECRET_KEYS = ['sessdata', 'bili_jct', 'buvid3', 'dedeuserid']
