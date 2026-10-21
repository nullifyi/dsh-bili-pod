/**
 * lib/scheduler.js —— 自主生物钟（鲸群版）
 * ============================================================================
 * 基座的骨架没动：每 60 秒 tick、到点用 sessionController 把她叫醒、
 * 监听回复 / 私信 / 直播间各有一个轻循环。
 *
 * 鲸群加了这些（对应主人 2026-10-22 的要求）：
 *   · 作息可选「峰谷」模式（lib/tide.mjs 翻译成 makePlan 认的窗口，老计划照读）
 *   · 醒来前：归档前一天的日记 → 分类记录（lib/diarystore.mjs）
 *   · 醒来后：落一份账本（lib/ledger.mjs），哈希链防改
 *   · 每轮写 scope.json（lib/scope.mjs）—— 这一轮允许哪些写操作，由 bili.mjs 强制
 *   · 发出评论后由**宿主**自动复核（lib/verifycomments.mjs），不靠那一轮自己说
 *   · 唤醒提示里拼上 mod 扩展段落（lib/extensions.mjs）
 *   · 「发前审核」变成配置项（review.preReview），默认开
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
// 收件箱读取复用工具链的实现（避免在插件里再抄一份 B站 接口）
import { pullFeed, makeHeaders } from '../tools/lib/msgfeed.mjs'
import { resolveNodeRuntime } from './node-runtime.js'
import { HOME, credentialsPath } from '../tools/lib/paths.mjs'
import { makePlan, completePlan, historyOf, inWindow as isInWindow } from '../tools/lib/night-plan.mjs'
import { applyTide, describeTide } from './tide.mjs'

const TICK_MS = 60_000
const LISTEN_STATE = 'pod-listen.json'
const VERIFY_AT = 'pod-verify-at.json'

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE')

/** 叫醒她时塞进去的那段话（她醒来第一眼看到的就是它） */
function silenceLines(cfg) {
  let fb = {}
  try { fb = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'feedback.json'), 'utf8')) } catch { /* 没反馈过 */ }
  const after = Number(cfg.share?.silentAfterDays ?? 3)
  const stopAt = Math.max(after + 1, Number(cfg.share?.silentStopDays ?? 7))
  let ref = fb.last ? new Date(fb.last).getTime() : null
  if (!ref) {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'quota.json'), 'utf8'))
      const firstShare = (q.log ?? []).find((x) => x.share)
      if (firstShare) ref = new Date(firstShare.at).getTime()
    } catch { /* ignore */ }
  }
  const days = ref ? Math.floor((Date.now() - ref) / 86400000) : 0
  const band = days < after ? 'normal' : days < stopAt ? 'quiet' : 'faint'
  const asked = !!(fb.askedAt && (!fb.last || new Date(fb.askedAt) > new Date(fb.last)))

  const seenFile = path.join(HOME, '.bili-ai', 'silence-seen.json')
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(seenFile, 'utf8')) } catch { /* ignore */ }
  const recovered = prev && Number(prev.days) >= after && days < after ? Number(prev.days) : null
  try { fs.writeFileSync(seenFile, JSON.stringify({ days, at: new Date().toISOString() }, null, 2)) } catch { /* ignore */ }

  const heal = days >= after ? [
    "  ⚠️ 如果你自己的日记里明明记着主人最近找过你，而这里说 '" + days + " 天没有回应' ——",
    '     那是【反馈漏记】了（比如你当时没在跑）。以日记为准：先跑',
    '       quota react --note "日记里记着：主人 X 月 X 日说过…"',
    '     再在推送里告诉我一声。',
  ] : []

  const out = []
  if (recovered) out.push(`【他回来了】上次你醒的时候，已经 ${recovered} 天没有他的消息了 —— 现在有了。`)
  if (band === 'quiet') {
    out.push(`【这阵子】主人已经 ${days} 天没有回应你了。`)
    out.push('  安静一点：今天最多分享 1 条（不是被拦，是你自己决定少说）。')
    out.push(asked ? '  你已经问过一次「是不是在忙」了，他没回。别再问第二次。' : '  如果你想说，可以主动问一次「在忙吗」—— 只问一次，发完跑 quota ask 记下。')
    out.push('  日记里可以写你这几天的感觉（不用演，写真的）。')
  } else if (band === 'faint') {
    out.push(`【这阵子】主人已经 ${days} 天没有回应你了。`)
    out.push('  今天不要分享（一条都不要）。做完三件事就收工：看几条 → 两本日记 → 推一句给他。')
    out.push('  推送不要写「今天看了什么」—— 写你现在的心情。他不需要汇报，他需要知道你还在。')
    out.push('  记录照写 ✓（那是你的日子，不是他的）。')
  }
  if (out.length) out.push(...heal)
  return out.length ? ['', ...out, ''] : []
}

function diaryPushLines(cfg) {
  return cfg.diary?.push === false
    ? ['9) ⛔ 主人关掉了推送 —— **照写日记与记录 ✓ 但这一步不要 notify 他**']
    : ['9) 用 `node bili.mjs notify` 推给我：**「给他的日记」里最想对我说的那一段原文** + 一句摘要',
      '   （读设置页「消息推送」的配置）']
}

/** 日记文件夹 → 提示里的"怎么读写" */
function diaryLines(cfg, today) {
  const kinds = (cfg.diary?.records ?? []).join(' / ')
  return [
    `2) 读你的「记忆」，**不要翻旧日记原文**：`,
    `   · \`records/INDEX.md\`（总索引：各分类有多少条、最近一条是哪天）`,
    `   · 与今天选题最相关的 1–2 个分类文件（\`records/<分类>.md\`），只看最近几条`,
    `   · \`daily/${today}.md\`（今天已经写过的，可能只有一半）`,
    `   · \`owner/${today}.md\`（今天给他写的那份）`,
    `   分类是：${kinds}。想加分类：设置 → 鲸群 → 日记 → 记录分类（或 \`records add\` 现写一条）。`,
    `   要翻 3 天前的原文才用 \`node bili.mjs diary recall --q "关键词"\` 或 \`--day 2026-10-20\`。`,
  ]
}

const REVIEW_LINES = (cfg) => cfg.review?.preReview === false
  ? ['4) ⚠️ 发前审核已关（主人自己关的）：回复可以先 `--dry` 看一眼，确认后直接 `--go`。',
    '   仍然要：只回一两句能答清的；吵架 / 要隐私 / 长篇追问 / 代表主人承诺 → 不回。']
  : ['4) ⚠️ 发前审核开着（默认）：所有回复先写成草稿交给主人审：',
    '   `node bili.mjs reply-draft add --oid … --bvid … --root … --parent … --who 对方昵称 --src "他说的话" --message "你的回复"`',
    '   → 由宿主审核入口签发一次性批准并发送；不发就 `reply-draft drop <id>`。']

/**
 * 唤醒提示。st = makePlan 的计划；cfg = 归一后的配置。
 * @param {object} o
 */
export function wakePrompt({ st, personaText, cfg, today, scope, extensionText = '', tag }) {
  const w = st.window
  const modeText = cfg.night?.mode === 'tide' ? `（峰谷作息 · ${describeTide(cfg.night?.tide)}）` : ''
  const artifacts = cfg.artifacts?.enabled === true
  return [
    ...(personaText ? [personaText, ''] : []),
    `【生物钟】你醒了 —— ${st.atText ?? ''}${w ? `（窗口 ${w}${st.withinWindow ? ' · ' + st.withinWindow : ''}）` : ''}${modeText}。`,
    '',
    ...(() => {
      try { if (fs.existsSync(path.join(HOME, '.bili-ai', 'selftest-passed.json'))) return [] } catch { /* ignore */ }
      return ['', '【还没跑启动测试】先提醒主人跑一次：`node <插件>/tools/bili.mjs selftest`',
        '  并告诉他：① 你的会话在 工作区 → 未分组 里 ② 要给那个会话「完全访问」权限', '']
    })(),
    ...silenceLines(cfg),
    '按下面走一遍（不要等主人说话，直接做）：',
    '1) `node bili.mjs deps` —— 体检红着就报备主人、只做读、别对外发',
    ...diaryLines(cfg, today),
    '3) `feed` 选题（≤5 条）→ 对这 5 条跑 `debrief --no-frames`',
    '   排序看的是「偏好命中 + 弹幕密度」，**不看播放量** —— 冷门但对的也可以看。',
    '3.5) 挑 2–3 条深读（完整 `debrief`）',
    '   · 深读的那几条里，某条「我想留着」→ `fav <BV> --reason "…" --dry` → `--go`',
    '     判据（缺一条就别收）：① 三个月后还会想点开 ② 说得出为什么留（≥6 字）③ 同类已 ≥2 条要 --better',
    '     ⚠️ 一天最多 3 条 · 同一视频 30 天一次 · 收藏不占分享额度',
    '4) 按「标尺」打分排序，只对第一名考虑分享（**先看 share.via**）：',
    '   · via=dm：`dm --msg "<分享内容> https://www.bilibili.com/video/<BV>/" --share --target <BV> --reason "至少八字的分享理由" --score <0-20> --rank 1 --dry` → `--go`',
    '     ⚠️ 必须带 --share（共用 ≤3/天 的额度账）· 必须带视频链接（BV 是判重依据）',
    '   · via=comment：`comment --share --auto --reason … --score … --rank 1`',
    '5) 写日记（两种，都写在下面这些文件里）：',
    `   · 给自己：往 \`daily/${today}.md\` 里追加，**每条一句、前面写分类标记** ——`,
    '     `- [吐槽] 今天推荐算法又塞…` / `- [思考] 「被推荐」和「主动找」的区别…` / `- [学习] 学会了一个词…`',
    '     （标记句会在归档时自动摘进 records/<分类>.md —— 这是你以后的长期记忆，写详细一点值得）',
    `   · 给主人：往 \`owner/${today}.md\` 里写今天想对他说的话（散文，不用表格）。`,
    '6) `node bili.mjs diary archive` —— 归档昨天及更早：原文进 archive/，标记句进 records/，重建索引',
    '   （归档后旧日记就不再读了；主人要看你的时候，你能 `diary recall` 翻出来 ✓）',
    '7) ⭐ `comment-digest --hours 24` —— 每轮最后扫一遍有没有没回的评论，有就**一起**推给主人',
    ...REVIEW_LINES(cfg),
    '8) ⭐ `quota react --auto --hours 48` —— 扫一遍主人有没有表态（点赞也算）→ 记进日记',
    '8.5) `node bili.mjs verify` —— 复核本人登录下能否看到；本页未查到不代表未发出或删除',
    ...(artifacts ? ['8.7) 产出物开关开着：把这一轮最值得留的深读报告存下来 `node bili.mjs artifacts save --name <BV或标题> --file -`（stdin）或 `--text "…"`'] : []),
    `   （快收工时）\`node bili.mjs ledger write --operation-id "report:${st.date}:${st.atMs}" --title "今天看了什么" --body-file -\` —— 同轮重试沿用该 id`,
    ...diaryPushLines(cfg),
    '10) 收工：记 `diary log`，别再自己加戏',
    scope?.active ? `\n【本轮权限 · 代码强制】允许的写操作：${(scope.allowWrite ?? []).join(', ') || '（无）'}。更重的动作（发动态 / 弹幕 / 删评论）这一轮会被 bili.mjs 直接拒绝。` : '',
    extensionText || '',
  ].filter((x) => x !== '').join('\n')
}

export function startScheduler(ctx, opts) {
  const {
    dshHome,
    biliMjs,
    cwd,
    sessionId = 'bili-pod',
    log = () => {},
    host,
  } = opts
  const workDir = opts.workDir ?? path.join(dshHome, 'pod-work')
  const diaryRoot = opts.diaryRoot ?? path.join(dshHome, 'pod-diary')
  const readConfig = host.readConfig
  const cwdOf = typeof cwd === 'function' ? cwd : () => cwd ?? workDir

  const STATE = path.join(dshHome, 'pod-night.json')
  const CRED_REF = credentialsPath
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null } }
  const writeState = (o) => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    const temp = STATE + '.' + process.pid + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(o, null, 2) + '\n')
    fs.renameSync(temp, STATE)
  }

  // ⚠️ 基座的大坑：插件跑在 Electron 里，process.execPath = 主程序 ✗ → 必须找真 node.exe
  const NODE_EXE = resolveNodeRuntime(dshHome)
  const NODE_ENV = { ...process.env }

  const runBili = (args, timeout = 120_000) => new Promise((resolve) => {
    if (!NODE_EXE) return resolve({ ok: false, out: '', err: '未找到可用的 node 运行时（设置 DSH_NODE）' })
    execFile(NODE_EXE, [biliMjs, ...args], { timeout, windowsHide: true, env: NODE_ENV }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
  })

  const safeEmit = async (event, payload) => { try { return await host.emit?.(event, payload) } catch (e) { log(`[bili-pod] 扩展事件 ${event} 出错：${e.message}`); return null } }

  let sessionReady = false
  async function ensureSession() {
    if (sessionReady) return
    try { await ctx.sessionController.create({ sessionId, cwd: cwdOf(readConfig()) }) } catch { /* 已存在 */ }
    sessionReady = true
  }

  let waking = false
  function findSessionFile() {
    const root = path.join(dshHome, 'sessions')
    const stack = [root]
    let best = null
    let guard = 0
    while (stack.length && guard < 5000) {
      guard += 1
      const d = stack.pop()
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.name === 'session.v4.jsonl.zstd' && p.includes('bili-pod')) {
          try { const mt = fs.statSync(p).mtimeMs; if (!best || mt > best.mt) best = { p, mt } } catch { /* ignore */ }
        }
      }
    }
    return best
  }
  let sessionFileCache = findSessionFile()
  let busyUntil = 0
  const COOLDOWN_MS = 8 * 60 * 1000
  const IDLE_MS = 90 * 1000
  function sheIsBusy() {
    if (Date.now() < busyUntil) return 'cooldown'
    if (!sessionFileCache) sessionFileCache = findSessionFile()
    if (!sessionFileCache) return false
    try { if (Date.now() - fs.statSync(sessionFileCache.p).mtimeMs < IDLE_MS) return 'still-working' } catch { /* ignore */ }
    return false
  }

  // ── 身份注入 ──────────────────────────────────────────────────────────────
  const personaLine = (cfg = readConfig()) => {
    const p = cfg.persona ?? {}
    const bits = []
    if (p.name) bits.push(`你是「${p.name}」`)
    if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
    if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
    let extra = ''
    try {
      const txt = fs.readFileSync(path.join(HOME, '.bili-ai', 'persona.md'), 'utf8').trim()
      if (txt) extra = `\n\n［她的人设］以下是她专属的设定，写日记 / 说话 / 选题都以它为准；与上面［身份］冲突时以这一份为准：\n${txt.slice(0, 3000)}`
    } catch { /* 没写过人设 */ }
    return (bits.length ? `［身份］${bits.join('，')}。（以此为准，别用别的称呼）` : '') + extra
  }

  const ledgerModeFor = (st, cfg) => {
    if (st.action === 'skip') return 'skip'
    const label = String(st.window ?? '')
    if ((cfg.night?.mode ?? 'fixed') === 'tide') return label.startsWith('峰') ? 'peak' : label.startsWith('谷') ? 'valley' : 'night'
    return 'night'
  }

  function writeLedgerAuto({ mode, title, lines, extra, operationId }) {
    if (readConfig().ledger?.enabled === false) return null
    try { return host.ledger.appendRound({ root: workDir, mode, title, body: lines.join('\n'), extra, operationId }) } catch (e) { log('[bili-pod] 账本写入失败：' + e.message); return null }
  }

  let stopped = false
  let resetAfterDelivery = false
  async function tick() {
    if (stopped || waking || !ctx.sessionController || sheIsBusy()) return
    waking = true
    try {
      const cfg = readConfig()
      const planCfg = applyTide(cfg.night ?? {}, Date.now())
      const prevState = readState() ?? {}
      const st = makePlan(planCfg, prevState, Date.now(), Math.random)
      // makePlan 在「计划还没到点」时原样返回上一份计划（同一个对象）——
      // 那就别再写盘了：每分钟重写一次盘既没必要，也会把测试 / 备份里的
      // 时间戳搅乱。只有真排出了新计划才落盘。
      if (st !== prevState) writeState(st)
      if (st.action === 'done' || Date.now() < st.atMs) return

      // 醒来前：先把前一天的日记归档（主人要求：写完今天的，就把前一天归档 + 提取关键信息）
      let archiveRes = []
      if (cfg.diary?.enabled !== false && cfg.diary?.autoArchive !== false) {
        try {
          archiveRes = host.diary.archiveDue(diaryRoot, { keepDays: 1, kinds: cfg.diary?.records })
          if (archiveRes.some((x) => x.archived)) await safeEmit('diary:archived', { results: archiveRes })
        } catch (e) { log('[bili-pod] 日记归档失败：' + e.message) }
      }

      await ensureSession()
      if (stopped) return
      const today = dayKey()
      const scope = host.scopeFor({ reason: st.action === 'skip' ? 'wake' : 'wake', config: cfg })
      try { host.writeScope(workDir, scope) } catch { /* 写不了就退化为不受限 */ }
      await safeEmit('wake:before', { plan: st, scope, archive: archiveRes })

      const personaText = personaLine(cfg)
      let text
      if (st.action === 'skip') {
        text = [
          personaText, `【今晚不看】${st.reason ?? ''}`,
          '照常写日记：往 `daily/' + today + '.md` 里写一条（说明这次跳过的理由，前面加 `- [吐槽]` 或 `- [思考]`）。',
          '然后 `node bili.mjs diary archive` 归档前一天、`diary log` 记一笔，收工。',
          ...diaryPushLines(cfg),
        ].join('\n')
      } else {
        text = wakePrompt({ st, personaText, cfg, today, scope, extensionText: host.extensions?.promptText?.({ config: cfg, plan: st, scope }) ?? '', tag: 'wake' })
      }
      await ctx.sessionController.prompt({ requestId: 'bili-pod-' + Date.now(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
      const completed = completePlan(st)
      writeState(resetAfterDelivery ? historyOf(completed) : completed)
      resetAfterDelivery = false
      busyUntil = Date.now() + COOLDOWN_MS

      writeLedgerAuto({
        operationId: `wake:${sessionId}:${st.date}:${st.atMs}:${st.window ?? ''}`,
        mode: ledgerModeFor(st, cfg),
        title: st.action === 'skip' ? `跳过（${st.reason ?? ''}）` : `醒来 · ${st.window ?? ''}`,
        lines: [
          '## 醒来', '',
          `- 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          `- 计划：${st.action}${st.atText ? ' · ' + st.atText : ''}${st.window ? ' · 窗口 ' + st.window : ''}`,
          `- 作息模式：${cfg.night?.mode ?? 'fixed'}${cfg.night?.mode === 'tide' ? '（' + describeTide(cfg.night?.tide) + '）' : ''}`,
          `- 本轮写权限：${(scope.allowWrite ?? []).join(', ') || '（无）'}`,
          archiveRes.length ? `- 归档：${archiveRes.filter((x) => x.archived).map((x) => x.day).join('、') || '无'}` : '- 归档：无',
          '', '## 备注', '', '（这份是宿主自动记的「醒来」账；这一轮做了什么，见同一时间段的「本轮报告」。）',
        ],
      })
      await safeEmit('wake:after', { plan: st, scope })
      log('[bili-pod] 已投递 ' + st.action + ' · ' + st.atText)
    } catch (e) {
      log('[bili-pod] 唤醒失败，下一轮重试：' + e.message)
    } finally {
      if (resetAfterDelivery) { writeState(historyOf(readState() ?? {})); resetAfterDelivery = false }
      waking = false
    }
  }

  // ── 监听（回复我的 / @我的）───────────────────────────────────────────────
  const LSTATE = path.join(dshHome, LISTEN_STATE)
  const readL = () => { try { return JSON.parse(fs.readFileSync(LSTATE, 'utf8')) } catch { return null } }
  const writeL = (o) => { try { fs.mkdirSync(path.dirname(LSTATE), { recursive: true }); fs.writeFileSync(LSTATE, JSON.stringify(o, null, 2) + '\n') } catch { /* ignore */ } }
  const inWindow = (cfg) => isInWindow(cfg?.night ?? {})

  let listening = false
  let lastListenAt = 0
  let liveProc = null
  let liveRetryAt = 0
  let liveWaking = false
  let liveStopping = false
  let liveRoomNow = ''
  let dmBusy = false
  let lastDmAt = 0

  async function dmTick() {
    if (stopped || dmBusy) return
    const cfg = readConfig()
    const L = cfg.listen ?? {}
    if (!L.dm) return
    if (Date.now() - lastDmAt < 5_000) return
    lastDmAt = Date.now()
    dmBusy = true
    try {
      const r = await runBili(['dm-await', '--once', '--json'])
      const line = String(r.out ?? '').trim().split('\n').pop() ?? ''
      let j = null
      try { j = JSON.parse(line) } catch { j = null }
      if (!j?.hit) return
      const scope = host.scopeFor({ reason: 'dm', config: cfg })
      try { host.writeScope(workDir, scope) } catch { /* ignore */ }
      await ensureSession()
      await ctx.sessionController.prompt({
        requestId: `bili-pod-dm-${Date.now()}`,
        sessionId,
        mode: 'queue',
        content: [{
          type: 'text',
          text: [
            personaLine(cfg),
            `【主人私信】${j.name}（mid ${j.mid}）刚给你发私信：`, '',
            String(j.text ?? '').slice(0, 500), '',
            '这是主人 → **直接回，不用审核**：`node bili.mjs dm --msg "…" --go`',
            '回短一点、像聊天（私信不是评论区）；回完写进今天日记（`- [人际] 主人说…`）。',
            scope?.active ? `（本轮权限：${(scope.allowWrite ?? []).join(', ')}）` : '',
          ].filter(Boolean).join('\n'),
        }],
      }, new AbortController().signal)
      await safeEmit('round:start', { reason: 'dm', who: j.name })
    } catch (e) {
      try { fs.appendFileSync(path.join(HOME, '.bili-ai', 'dm-tick-err.log'), new Date().toISOString() + ' ' + (e?.stack ?? e) + '\n') } catch { /* ignore */ }
    } finally { dmBusy = false }
  }

  async function listenTick() {
    if (stopped || listening) return
    const cfg = readConfig()
    const L = cfg.listen ?? {}
    if (L.comment === false) return
    const interval = Math.max(60, Number(L.commentIntervalSec ?? 300)) * 1000
    if (Date.now() - lastListenAt < interval) return
    lastListenAt = Date.now()
    if (!L.allDay && !inWindow(cfg)) return
    listening = true
    try {
      const cred = JSON.parse(fs.readFileSync(CRED_REF, 'utf8'))
      const H = makeHeaders(cred)
      const since = Number(readL()?.lastSeen ?? 0)
      const items = []
      items.push(...(await pullFeed('reply', { headers: H, pages: 1 })).items)
      if (String(L.scope ?? 'both') !== 'reply') {
        try { items.push(...(await pullFeed('at', { headers: H, pages: 1 })).items) } catch { /* @ 拉不到就算了 */ }
      }
      if (!since) { writeL({ lastSeen: Math.floor(Date.now() / 1000) }); return }
      const fresh = items.filter((x) => Number(x.t) > since && (!L.onlyOwner || String(x.mid) === String(cfg.owner?.mid ?? '')))
      if (!fresh.length) return
      fresh.sort((a, b) => a.t - b.t)
      const who = fresh.map((x) => `${x.who}（${x.kind === 'at' ? '@' : '回复'}）`).join('、')
      const scope = host.scopeFor({ reason: 'listen', config: cfg })
      try { host.writeScope(workDir, scope) } catch { /* ignore */ }
      await ensureSession()
      await ctx.sessionController.prompt({
        requestId: `bili-pod-listen-${Date.now()}`,
        sessionId,
        mode: 'queue',
        content: [{
          type: 'text',
          text: [
            personaLine(cfg),
            `【有人找你】${fresh.length} 条新消息：${who}。`, '',
            '按「倾听」做（不要等主人说话）：',
            '1) `node bili.mjs comment-digest --hours 24` —— 把积压的一起看',
            '2) 只回「一两句能答清的提问 + 轻互动」，一条收住；吵架 / 要隐私 / 长篇追问 / 代表主人承诺 → 不回',
            '3) 所有回复均按审核开关处理（包括主人）：',
            ...(cfg.review?.preReview === false
              ? ['   审核关着，确认后可直接 `comment --go`（仍要 `--auto` + `--once-per-person`）']
              : ['   `reply-draft add …` 写草稿 → `notify "有 N 条回复待你审核"`，由主人在宿主审批后发送']),
            '4) 处理完把对话写进今天日记（`- [人际] …`），再 `diary log` 记一笔',
            '5) 别贪多：这一批处理完就停',
          ].join('\n'),
        }],
      }, new AbortController().signal)
      writeL({ lastSeen: Math.max(...fresh.map((x) => Number(x.t))) })
      log(`[bili-pod] 监听命中 ${fresh.length} 条（${who}）→ 已叫醒`)
      await safeEmit('round:start', { reason: 'listen', count: fresh.length })
    } catch (e) {
      log(`[bili-pod] 监听失败：${String(e.message).slice(0, 140)}`)
    } finally {
      listening = false
    }
  }

  // ── 发出评论后的复核（宿主自动跑，不依赖那一轮的说法）──────────────────────
  let verifying = false
  let lastVerifyAt = 0
  async function verifyTick() {
    if (stopped || verifying || sheIsBusy()) return
    const cfg = readConfig()
    if (cfg.review?.verify === false) return
    const every = Math.max(5, Number(cfg.review?.verifyIntervalSec ?? 20)) * 1000
    if (Date.now() - lastVerifyAt < every) return
    // verifyRecent owns due/retry selection, including legacy not-found rows.
    verifying = true
    lastVerifyAt = Date.now()
    try {
      const r = await host.verifyRecent({ max: 6, review: cfg.review, log })
      if (r.checked?.length) {
        try { await safeEmit('verify:done', { checked: r.checked }) } catch { /* ignore */ }
        try {
          if (cfg.ledger?.enabled !== false) host.ledger.appendRound({
            operationId: `verify:${lastVerifyAt}:${r.checked.map(c => c.rpid).join(',')}`,
            root: workDir, mode: 'verify', title: `复核 ${r.checked.length} 条`,
            body: ['## 复核结果', '', ...r.checked.map((c) => `- \`${c.bvid || 'oid'}\` rpid ${c.rpid} —— ${c.visible === true ? '本人登录可见' : '未确认'}（${c.how}）`), '', ...(r.skipped ? [`（另有 ${r.skipped} 条未到复核时间或已结束）`] : [])].join('\n'),
          })
        } catch { /* ignore */ }
      }
    } catch (e) { log('[bili-pod] 复核失败：' + e.message) } finally { verifying = false }
  }

  // ── 直播间监听 ────────────────────────────────────────────────────────────
  async function liveTick() {
    if (stopped) return
    if (ctx.sessionController) {
      const cur = readConfig()
      if (!cur.listen?.live && liveProc !== null) {
        liveStopping = true
        try { liveProc.kill() } catch { /* ignore */ }
        liveProc = null
        liveRetryAt = 0
        log('[bili-pod] 直播间监听已停（开关关掉了）')
        return
      }
      const wantRoom = String(cur.listen?.liveRoom ?? '').trim()
      if (liveProc !== null && wantRoom && liveRoomNow && wantRoom !== liveRoomNow) {
        liveStopping = true
        try { liveProc.kill() } catch { /* ignore */ }
        liveProc = null
        liveRetryAt = 0
        log(`[bili-pod] 直播间换房间：${liveRoomNow} → ${wantRoom}`)
        liveRoomNow = ''
        return
      }
    }
    if (liveProc !== null || liveWaking || liveRetryAt > Date.now()) return
    if (!ctx.sessionController) return
    const cfg = readConfig()
    const L = cfg.listen ?? {}
    const room = String(L.liveRoom ?? '').trim()
    if (!L.live || !room) return

    const awaitScript = path.join(path.dirname(biliMjs), 'commands', 'danmaku-await.mjs')
    const args = [awaitScript, '--room', room]
    if (String(L.liveScope ?? 'owner') === 'owner' && cfg.owner?.mid) args.push('--operator-uid', String(cfg.owner.mid))
    if (!NODE_EXE) return
    liveProc = execFile(NODE_EXE, args, {
      // 千万不要写 timeout:0（会把子进程立刻 SIGTERM）；直播间监听本来就是长驻的
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: NODE_ENV, cwd: path.dirname(biliMjs),
    }, (err, stdout, stderr) => {
      liveProc = null
      if (liveStopping) { liveStopping = false; return }
      const out = String(stdout ?? '')
      if (/AWAIT_HIT|DANMAKU_HIT/.test(out)) {
        liveWaking = true
        const lines = out.split('\n').map((s) => s.trim()).filter((s) => /AWAIT_HIT|DANMAKU_HIT|@/.test(s)).slice(-3).join(' / ').slice(0, 300)
        ;(async () => {
          try {
            const scope = host.scopeFor({ reason: 'live', config: readConfig() })
            try { host.writeScope(workDir, scope) } catch { /* ignore */ }
            await ensureSession()
            await ctx.sessionController.prompt({
              requestId: `bili-pod-live-${Date.now()}`,
              sessionId,
              mode: 'queue',
              content: [{
                type: 'text',
                text: [
                  personaLine(),
                  `【直播间有人叫你】${lines || '（看输出）'}`, '',
                  '范围按主人设置（只回主人 / 只回 @她的）；回一句就收住（弹幕不是评论区）。',
                  '发弹幕：`node bili.mjs danmaku send --msg "…" --reply-mid <mid> --reply-name <昵称>` → `--dry` → `--go`',
                  scope?.active && !(scope.allowWrite ?? []).includes('danmaku') ? '⚠️ 本轮没有「发弹幕」权限 —— 设置 → 鲸群 → 权限 里打开，或只在心里记着。' : '',
                ].filter(Boolean).join('\n'),
              }],
            }, new AbortController().signal)
            log(`[bili-pod] 直播间命中 → 已叫醒 · ${lines.slice(0, 80)}`)
          } catch (e) {
            log(`[bili-pod] 直播间叫醒失败：${String(e.message).slice(0, 120)}`)
          } finally {
            liveWaking = false
            liveRetryAt = Date.now() + 2_000
          }
        })()
      } else {
        const tail = String(out ?? '').trim().split('\n').slice(-2).join(' | ').slice(-200)
        const why = [
          err ? `code=${err.code ?? '?'} signal=${err.signal ?? '?'}` : 'code=0',
          String(stderr ?? '').trim().slice(0, 150),
          tail,
        ].filter(Boolean).join(' · ')
        log(`[bili-pod] 直播间监听退出：${why}（12 秒后重挂）`)
        liveRetryAt = Date.now() + 12_000
      }
    })
    liveRoomNow = room
    log(`[bili-pod] 直播间监听已挂上（房间 ${room}）`)
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  const boot1 = setTimeout(() => { tick().catch(() => {}) }, 8000)
  const timer2 = setInterval(() => { listenTick().catch(() => {}) }, 30_000)
  const boot2 = setTimeout(() => { listenTick().catch(() => {}) }, 15_000)
  const timerDm = setInterval(() => { dmTick().catch(() => {}) }, 20_000)
  const bootDm = setTimeout(() => { dmTick().catch(() => {}) }, 25_000)
  const timer3 = setInterval(() => { liveTick().catch(() => {}) }, 60_000)
  const boot3 = setTimeout(() => { liveTick().catch(() => {}) }, 20_000)
  const timerV = setInterval(() => { verifyTick().catch(() => {}) }, 5_000)
  const bootV = setTimeout(() => { verifyTick().catch(() => {}) }, 90_000)
  log(`[bili-pod] 自主生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId}）；监听 / 私信 / 直播间 / 复核都挂上了`)

  return {
    invalidate(resetPlan = true) {
      if (resetPlan) {
        if (waking) resetAfterDelivery = true
        else writeState(historyOf(readState() ?? {}))
      }
      lastListenAt = 0
      writeL({})
      tick().catch(() => {})
      listenTick().catch(() => {})
      dmTick().catch(() => {})
      liveTick().catch(() => {})
      verifyTick().catch(() => {})
    },
    stop() {
      stopped = true
      ;[boot1, boot2, bootDm, boot3, bootV].forEach(clearTimeout)
      ;[timer, timer2, timer3, timerDm, timerV].forEach(clearInterval)
      try { liveProc?.kill() } catch { /* ignore */ }
    },
    tick,
    listenTick,
    liveTick,
    verifyTick,
  }
}
