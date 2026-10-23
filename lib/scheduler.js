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
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { HOME, credentialsPath } from '../tools/lib/paths.mjs'
import { makePlan, completePlan, historyOf, inWindow as isInWindow } from '../tools/lib/night-plan.mjs'
import { applyTide, describeTide } from './tide.mjs'
import { describeCheap, isCheapNow } from './pricing.mjs'
import { mentionSummaryLines } from './mention-summary.js'
import { statePath } from './state-dir.mjs'
import { policyOf as reviewPolicyOf } from './policy.mjs'

const TICK_MS = 60_000
const LISTEN_STATE = 'pod-listen.json'
const VERIFY_AT = 'pod-verify-at.json'

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE')

/** 叫醒她时塞进去的那段话（她醒来第一眼看到的就是它） */
function silenceLines(cfg) {
  let fb = {}
  try { fb = JSON.parse(fs.readFileSync(statePath('feedback.json'), 'utf8')) } catch { /* 没反馈过 */ }
  const after = Number(cfg.share?.silentAfterDays ?? 3)
  const stopAt = Math.max(after + 1, Number(cfg.share?.silentStopDays ?? 7))
  let ref = fb.last ? new Date(fb.last).getTime() : null
  if (!ref) {
    try {
      const q = JSON.parse(fs.readFileSync(statePath('quota.json'), 'utf8'))
      const firstShare = (q.log ?? []).find((x) => x.share)
      if (firstShare) ref = new Date(firstShare.at).getTime()
    } catch { /* ignore */ }
  }
  const days = ref ? Math.floor((Date.now() - ref) / 86400000) : 0
  const band = days < after ? 'normal' : days < stopAt ? 'quiet' : 'faint'
  const asked = !!(fb.askedAt && (!fb.last || new Date(fb.askedAt) > new Date(fb.last)))

  const seenFile = statePath('silence-seen.json')
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
  return cfg.reportLevel === 'off' || cfg.diary?.push === false
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

/** Every round receives executable paths even though its cwd is the small pod workspace. */
export function resolvePromptPaths(text, { nodeExe, biliMjs, diaryRoot, today = dayKey() }) {
  const cli = `${JSON.stringify(nodeExe)} ${JSON.stringify(path.resolve(biliMjs))}`
  const prefix = [
    `【工具入口】${cli} <命令> [参数]。下文简写的命令（feed、dm、diary 等）均使用这个入口；不要从当前目录找 bili.mjs。`,
    `【日记与记忆根】${diaryRoot}。长期记录索引：${path.join(diaryRoot, 'records', 'INDEX.md')}；按需读相关分类，禁止自动读旧归档原文。`,
    `今天给自己：${path.join(diaryRoot, 'daily', today + '.md')}；给主人：${path.join(diaryRoot, 'owner', today + '.md')}。`,
  ].join('\n')
  return prefix + '\n\n' + String(text)
    .replaceAll('node bili.mjs', cli).replaceAll('node <插件>/tools/bili.mjs', cli)
    .replace(/`((?:records|daily|owner)\/[^`]+)`/g, (_, rel) => '`' + path.join(diaryRoot, rel) + '`')
}

// 0.7.0：发前审核四档（ask / auto-owner / auto-quiet / off）——这里只给她「该怎么走」的说明，
// 真正的判定在 CLI（lib/policy.mjs），她无权自己判断「主人会同意」。
const REVIEW_LINES = (cfg) => {
  const policy = reviewPolicyOf(cfg)
  const autoWho = []
  if (policy !== 'ask' && policy !== 'off') {
    if (cfg.dm?.autoSend === true) autoWho.push('私信（必须在「自动发送给」名单里）')
    if (policy === 'auto-owner') autoWho.push('主人的回复/评论')
    if (policy === 'auto-quiet') autoWho.push('主人的 + 互关的人（静音时段除外）')
  }
  if (policy === 'off') {
    return ['4) ⚠️ 宿主审核已关（policy=off，主人自己关的）：回复可以先 `--dry` 看一眼，确认后直接 `--go`。',
      '   仍然要：只回一两句能答清的；吵架 / 要隐私 / 长篇追问 / 代表主人承诺 → 不回。']
  }
  if (policy === 'ask') {
    return ['4) ⚠️ 发前审核=ask（每条都问）：所有回复先写成草稿交给主人审：',
      '   `node bili.mjs reply-draft add --oid … --bvid … --root … --parent … --who 对方昵称 --src "他说的话" --message "你的回复"`',
      '   → 由宿主签发一次性批准并发送；不发就 `reply-draft drop <id>`。']
  }
  return [`4) 发前审核=${policy}（自动档）：${autoWho.length ? '可以直接发的：' + autoWho.join('；') + '。' : '这一轮没有任何可直接发的通道。'}`,
    '   其余的人（陌生/关系未知/已超额度/静音时段）→ 先 `reply-draft add …` 写草稿，由主人点「发」。',
    '   ⚠️ 不要自己判断「主人会同意」——CLI 会自己拦，被拦时把它的原话交给主人。']
}

/**
 * 唤醒提示。st = makePlan 的计划；cfg = 归一后的配置。
 * @param {object} o
 */
export function wakePrompt({ st, personaText, cfg, today, scope, extensionText = '', tag }) {
  const w = st.window
  const modeText = cfg.night?.mode === 'tide' ? `（峰谷作息 · ${describeTide(cfg.night?.tide)}）`
    : cfg.night?.mode === 'cheap' ? `（DeepSeek 低价时段 · ${describeCheap(cfg)}）` : ''
  const mist = cfg.mistress?.enabled === true && /^\d+$/.test(String(cfg.mistress?.mid ?? '')) ? cfg.mistress : null
  const tasteLines = cfg.preferences?.selfAdjust !== false
    ? ['2.6) ⭐ 口味微调（可选，一天最多 3 条）：真看出来了才动',
      '   · 想多看点：`node bili.mjs taste add --like "词" --why "为什么"`',
      '   · 看烦了：`node bili.mjs taste add --dislike "词" --why "为什么"`',
      '   · 主人对某条分享表过态：`node bili.mjs taste signal --bvid BV… --level 1-5 [--note "他的原话"]`',
      '   （靠「主人感兴趣程度」自动回流口味；加错了 `taste remove --like "词"` 撤掉）']
    : ['2.6) 口味自改是关着的：这一轮不要动 preferences，只能靠主人手动改。']
  const mistressLines = mist
    ? ['4.5) ⭐ 女主人（权限比主人低一档，但话要好听）',
      `   · 她：${mist.name || '（未填昵称）'} · ${mist.title} · mid ${mist.mid}`,
      `   · 给她分享只走私信：\`reply-draft add --kind dm --to ${mist.mid} --message "…"\` → 主人在设置页点「发」才发；每天 ≤ ${Math.max(0, Number(mist.shareDaily ?? 1))} 条`,
      `   · 她的口味：${(mist.like ?? []).join('、') || '（还没记）'}；不爱看：${(mist.dislike ?? []).join('、') || '（还没记）'}`,
      '   · 奉承她：开头用她的称呼，夸要具体到视频内容里的一句，不空夸；她问什么就好好答，但不许越过主人',
      '   · 她的私信/评论：优先回、语气软；涉及钱/账号/线下的事一律说不清楚，交给主人']
    : []
  const artifacts = cfg.artifacts?.enabled === true && cfg.reportLevel !== 'off'
  return [
    ...(personaText ? [personaText, ''] : []),
    `【生物钟】你醒了 —— ${st.atText ?? ''}${w ? `（窗口 ${w}${st.withinWindow ? ' · ' + st.withinWindow : ''}）` : ''}${modeText}。`,
    '',
    ...(() => {
      try { if (fs.existsSync(statePath('selftest-passed.json'))) return [] } catch { /* ignore */ }
      return ['', '【还没跑启动测试】先提醒主人跑一次：`node <插件>/tools/bili.mjs selftest`',
        '  并告诉他：① 你的会话在 工作区 → 未分组 里 ② 要给那个会话「完全访问」权限', '']
    })(),
    ...silenceLines(cfg),
    `【本轮预算 · agent约定】每轮最多 ${cfg.commentPerRound ?? 1} 条评论；每轮最多回复 ${cfg.replyPerRound ?? 1} 条。这是执行预算，不是进程安全沙箱；0 评论由权限单另行禁止自动评论。`,
    cfg.replyToComments ? '自动回复开着：只处理已记录的自己评论的直接回复；@通知、间接楼中楼、无法确认目标均跳过。' : '自动回复关着：本轮不主动回复评论。',
    cfg.reportLevel === 'off' ? 'reportLevel=off：不生成可选报告、不 notify 日记摘要；日记、长期记录和账本照写。'
      : cfg.reportLevel === 'brief' ? 'reportLevel=brief：可选报告每条一两行（结论 + 链接）；日记与账本照写。' : 'reportLevel=full：保留完整可选报告；日记与账本照写。',
    '按下面走一遍（不要等主人说话，直接做）：',
    '1) `node bili.mjs deps` —— 体检红着就报备主人、只做读、别对外发',
    ...diaryLines(cfg, today),
    ...tasteLines,
    `3) \`feed\` 选题（≤${cfg.night?.maxVideos ?? 5} 条）→ 对这些跑 \`debrief --no-frames\``,
    '   排序看的是「偏好命中 + 弹幕密度」，**不看播放量** —— 冷门但对的也可以看。',
    '3.5) 挑 2–3 条深读（完整 `debrief`）',
    '   · 深读的那几条里，某条「我想留着」→ `fav <BV> --reason "…" --dry` → `--go`',
    '     判据（缺一条就别收）：① 三个月后还会想点开 ② 说得出为什么留（≥6 字）③ 同类已 ≥2 条要 --better',
    '     ⚠️ 一天最多 3 条 · 同一视频 30 天一次 · 收藏不占分享额度',
    '4) 按「标尺」打分排序，只对第一名考虑分享（**先看 share.via**）：',
    '   · via=dm：`dm --msg "<分享内容> https://www.bilibili.com/video/<BV>/" --share --target <BV> --reason "至少八字的分享理由" --score <0-20> --rank 1 --dry` → `--go`',
    '     ⚠️ 必须带 --share（共用 ≤3/天 的额度账）· 必须带视频链接（BV 是判重依据）',
    '   · via=comment：`comment --share --auto --reason … --score … --rank 1`',
    '   · via=both：先走同一条公开 comment 分享，成功收据的 operationId 记账 complete 后，再 `dm --share --continuation <operationId> --target <同BV> --msg "<原公开正文> https://www.bilibili.com/video/<BV>/" --reason … --score … --rank 1 --go`；仅主人互关、一次续送，共计一次分享额度；uncertain 不重试。',
    ...mistressLines,
    '5) 写日记（两种，都写在下面这些文件里）：',
    `   · 给自己：往 \`daily/${today}.md\` 里追加，**每条一句、前面写分类标记** ——`,
    '     `- [吐槽] 今天推荐算法又塞…` / `- [思考] 「被推荐」和「主动找」的区别…` / `- [学习] 学会了一个词…`',
    '     （标记句会在归档时自动摘进 records/<分类>.md —— 这是你以后的长期记忆，写详细一点值得）',
    `   · 给主人：往 \`owner/${today}.md\` 里写今天想对他说的话（散文，不用表格）。`,
    '   · 两本日记里都**不要抄私信/评论草稿的原文和链接**：只记「走了草稿 <id>」和一句你自己的话；链接属于私信正文，属于草稿，不属于日记。',
    '6) `node bili.mjs diary archive` —— 归档昨天及更早：原文进 archive/，标记句进 records/，重建索引',
    '   （归档后旧日记就不再读了；主人要看你的时候，你能 `diary recall` 翻出来 ✓）',
    '7) ⭐ `comment-digest --hours 24` —— 查看评论；只在自动回复开启时处理自己的直接回复；报告关闭时不发可选汇总',
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
  // Electron 回退到 ELECTRON_RUN_AS_NODE 时，子进程必须带同一个环境变量
  let NODE_ENV = { ...process.env }
  try { NODE_ENV = { ...nodeEnv(dshHome) } } catch { /* 解析失败时 runBili 自己会报未找到 */ }
  const lifetime = new AbortController()
  const children = new Set()

  const runBili = (args, timeout = 120_000) => new Promise((resolve) => {
    if (!NODE_EXE) return resolve({ ok: false, out: '', err: '未找到可用的 node 运行时（设置 DSH_NODE）' })
    const child = execFile(NODE_EXE, [biliMjs, ...args], { timeout, windowsHide: true, env: NODE_ENV }, (err, stdout, stderr) => {
      children.delete(child)
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
    children.add(child)
  })

  const safeEmit = async (event, payload) => { try { return await host.emit?.(event, payload) } catch (e) { log(`[bili-pod] 扩展事件 ${event} 出错：${e.message}`); return null } }

  let sessionReady = false
  let activeSessionId = sessionId
  let creating = null
  const sessionRef = path.join(workDir, 'state', 'agent-session.json')
  try {
    const saved = JSON.parse(fs.readFileSync(sessionRef, 'utf8'))
    if (saved.sessionId && saved.cwd === cwdOf(readConfig())) { activeSessionId = saved.sessionId; sessionReady = true }
  } catch { /* first start */ }
  async function ensureSession() {
    if (sessionReady) return
    if (!creating) creating = (async () => {
      const cwd = cwdOf(readConfig())
      let result
      let usedCwd = cwd
      try {
        result = await ctx.sessionController.create({ sessionId: activeSessionId, cwd })
      } catch (err) {
        // 会话是按「sessionId + 工作目录」绑定的。搬过 DSH_HOME / 改过工作目录之后，
        // 旧会话还挂在老目录上，create 会一直抛：
        //   session "bili-pod" belongs to "C:\Users\…\pod-work", not "F:\…\pod-work"
        // 不删旧会话、也不另起影子会话：沿用旧会话自己的 cwd 把这场对话续上（状态文件都是绝对路径，不受影响）。
        const m = /belongs to "(.+?)"/.exec(String(err?.message ?? err))
        if (!m) throw err
        usedCwd = m[1]
        log?.(`会话 ${activeSessionId} 原本在 ${usedCwd}（不是现在的 ${cwd}），沿用原目录续上`)
        result = await ctx.sessionController.create({ sessionId: activeSessionId, cwd: usedCwd })
      }
      if (stopped) return
      if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error('sessionController.create 未返回实际 sessionId')
      activeSessionId = result.sessionId
      fs.mkdirSync(path.dirname(sessionRef), { recursive: true })
      fs.writeFileSync(sessionRef, JSON.stringify({sessionId: activeSessionId, cwd: usedCwd}) + '\n')
      sessionReady = true
    })().finally(() => { creating = null })
    return creating
  }

  async function deliver(reason, text, details = {}) {
    if (stopped) return false
    await ensureSession()
    if (stopped) return false
    await safeEmit('round:start', { reason, sessionId: activeSessionId, ...details })
    if (stopped) return false
    const result = await ctx.sessionController.prompt({
      requestId: `bili-pod-${reason}-${Date.now()}`, sessionId: activeSessionId, mode: 'queue',
      content: [{type: 'text', text: resolvePromptPaths(text, {nodeExe: NODE_EXE, biliMjs, diaryRoot})}],
    }, lifetime.signal)
    if (result?.accepted !== true) throw new Error('sessionController.prompt 未确认接收')
    if (stopped) return false
    await safeEmit('round:delivered', { reason, sessionId: activeSessionId, accepted: true, ...details })
    return !stopped
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
        else if (e.name === 'session.v4.jsonl.zstd' && p.includes(activeSessionId)) {
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
    try {
      const result = host.ledger.appendRound({ root: workDir, mode, title, body: lines.join('\n'), extra, operationId })
      if (result?.committed) void safeEmit('ledger:write', { mode, operationId, file: result.file, reused: result.reused })
      return result
    } catch (e) { log('[bili-pod] 账本写入失败：' + e.message); return null }
  }

  let stopped = false
  let resetAfterDelivery = false
  // force=true：设置页「现在叫她起来」——跳过「计划没到点/冷却/她还在忙」的判断，
  //   但依旧尊重 stopped 与会话存在性。计划次数照常 +1（这是真的一轮）。
  async function tick(force = false) {
    if (stopped || waking || !ctx.sessionController) return
    if (!force && sheIsBusy()) return
    waking = true
    try {
      const cfg = readConfig()
      await safeEmit('tick', { at: Date.now() })
      if (stopped) return
      const planCfg = applyTide(cfg.night ?? {}, Date.now())
      const prevState = readState() ?? {}
      const st = makePlan(planCfg, prevState, Date.now(), Math.random)
      // makePlan 在「计划还没到点」时原样返回上一份计划（同一个对象）——
      // 那就别再写盘了：每分钟重写一次盘既没必要，也会把测试 / 备份里的
      // 时间戳搅乱。只有真排出了新计划才落盘。
      if (st !== prevState) writeState(st)
      if (!force && (st.action === 'done' || Date.now() < st.atMs)) return

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
      host.writeScope(workDir, scope) // fail closed: no scope means no automatic prompt
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
      if (!await deliver('wake', text, {plan: st, scope})) return
      const completed = completePlan(st)
      writeState(resetAfterDelivery ? historyOf(completed) : completed)
      resetAfterDelivery = false
      busyUntil = Date.now() + COOLDOWN_MS

      writeLedgerAuto({
        operationId: `wake:${activeSessionId}:${st.date}:${st.atMs}:${st.window ?? ''}`,
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
      await safeEmit('wake:after', { plan: st, scope, accepted: true, sessionId: activeSessionId })
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
  const inWindow = (cfg) => isInWindow(applyTide(cfg?.night ?? {}, Date.now()))

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
      // 上游 v0.4.5 同步：两阶段交付 —— 先 --peek 拿凭据并持久化 pending，
      //   宿主确认 prompt 被接收后才 --ack 推进已读；中间断了下次 tick 还会读到同一条（不会丢）
      const r = await runBili(['dm-await', '--once', '--json', '--peek'])
      if (stopped) return
      const line = String(r.out ?? '').trim().split('\n').pop() ?? ''
      let j = null
      try { j = JSON.parse(line) } catch { j = null }
      // 老版本 dm-await 没有 receipt（两阶段确认是 v0.4.5 才有的）→ 没有就按一次性交付处理
      if (!j?.hit) return
      const scope = host.scopeFor({ reason: 'dm', config: cfg })
      host.writeScope(workDir, scope)
      const delivered = await deliver('dm', [
            personaLine(cfg),
            ...(j.role === 'mistress'
              ? [
                  `【女主人私信】${j.name}（mid ${j.mid}）刚给你发私信：`, '',
                  String(j.text ?? '').slice(0, 800), '',
                  '【这一条必须回】她发来的消息，不适用「一天一次主动私信」的额度 —— 回信不是主动打扰，是礼貌。',
                  `直接回：\`node bili.mjs dm --to ${j.mid} --msg "…" --reply --go\``,
                  '   · 回复同样过审核档/自动发送名单；被拦下会存草稿，把草稿 id 告诉主人即可，别重试；',
                  '   · 一条回不完就分两条（每条 ≤300 字，第二条用 `--reply` 继续），宁可两条也不要塞成一段；',
                  '   · 语气按人设走，可以更亲近、更会夸，但具体、不空泛；不许提钱、账号、线下安排 —— 那些请示主人；',
                  '   · 回完写进今天日记（`- [人际] 女主人说…`）。',
                ]
              : [
                  `【主人私信】${j.name}（mid ${j.mid}）刚给你发私信：`, '',
                  String(j.text ?? '').slice(0, 500), '',
                  `【本轮预算 · agent约定】每轮最多回复 ${cfg.replyPerRound ?? 1} 条（不是进程安全沙箱）。`,
                  ...(reviewPolicyOf(cfg) === 'off'
                    ? ['发前审核关着：`node bili.mjs dm --to <主人mid> --msg "…" --dry` 看一眼，确认后 `--go`（仍须互关）。']
                    : ['直接回主人这一句：`node bili.mjs dm --to <主人mid> --msg "…" --go`。',
                      '   · 如果设置里开了「私信自动发送」且收信人在名单里 → 直接发出，不再问你；',
                      '   · 否则 CLI 会把草稿存进待审列表并在输出里给你草稿 id —— 把这件事告诉主人即可，别自己重试。']),
                  '回短一点、像聊天（私信不是评论区）；回完写进今天日记（`- [人际] 主人说…`）。',
                ]),
            scope?.active ? `（本轮权限：${(scope.allowWrite ?? []).join(', ')}）` : '',
          ].filter(Boolean).join('\n'), {who: j.name})
      // 只有本轮真正交到会话里才确认凭据；否则保留 pending，下次读到同一条
      if (delivered && j.receipt) {
        const ack = await runBili(['dm-await', '--ack', String(j.receipt)])
        if (!ack.ok) log('[bili-pod] 私信已投递但确认失败（下次可能再提示一次）：' + String(ack.err || ack.out).trim().slice(0, 120))
      }
    } catch (e) {
      try { fs.appendFileSync(statePath('dm-tick-err.log'), new Date().toISOString() + ' ' + (e?.stack ?? e) + '\n') } catch { /* ignore */ }
    } finally { dmBusy = false }
  }

  async function listenTick() {
    if (stopped || listening) return
    const cfg = readConfig()
    const L = cfg.listen ?? {}
    if (L.comment === false || cfg.replyToComments === false) return
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
      if (stopped) return
      if (cfg.replyToComments !== true && String(L.scope ?? 'both') !== 'reply') {
        try { items.push(...(await pullFeed('at', { headers: H, pages: 1 })).items) } catch { /* @ 拉不到就算了 */ }
      }
      if (stopped) return
      if (!since) { writeL({ lastSeen: Math.floor(Date.now() / 1000) }); return }
      let ownComments = []
      if (cfg.replyToComments === true) {
        try { ownComments = JSON.parse(fs.readFileSync(statePath('pod-sent.json'), 'utf8')).items ?? [] } catch { /* no known own comment => no auto reply */ }
      }
      const fresh = items.filter((x) => Number(x.t) > since && (!L.onlyOwner || String(x.mid) === String(cfg.owner?.mid ?? ''))
        && (cfg.replyToComments !== true || x.kind === 'reply' && x.targetId && ownComments.some(c => String(c.rpid) === x.targetId && String(c.oid) === x.oid && String(c.type ?? '1') === String(x.business))))
      if (!fresh.length) return
      fresh.sort((a, b) => a.t - b.t)
      const who = fresh.map((x) => `${x.who}（${x.kind === 'at' ? '@' : '回复'}）`).join('、')
      // 2026-10-22（上游）：主人在 @ 里点名「总结一下」→ 才给总结段；默认关
      const summaryLines = mentionSummaryLines(cfg, fresh)
      const scope = host.scopeFor({ reason: 'listen', config: cfg })
      host.writeScope(workDir, scope)
      if (!await deliver('listen', [
            personaLine(cfg),
            `【有人找你】${fresh.length} 条新消息：${who}。`, '',
            `【本轮预算 · agent约定】每轮最多回复 ${cfg.replyPerRound ?? 1} 条（不是进程安全沙箱）；只处理以上确认的直接回复。`,
            '按「倾听」做（不要等主人说话）：',
            '1) `node bili.mjs comment-digest --hours 24` —— 把积压的一起看',
            '2) 只回「一两句能答清的提问 + 轻互动」，一条收住；吵架 / 要隐私 / 长篇追问 / 代表主人承诺 → 不回',
            '3) 所有回复均按审核开关处理（包括主人）：',
            ...(cfg.review?.preReview === false
              ? ['   审核关着，确认后可直接 `comment --go`（仍要 `--auto` + `--once-per-person`）']
              : ['   `reply-draft add …` 写草稿 → `notify "有 N 条回复待你审核"`，由主人在宿主审批后发送']),
            '4) 处理完把对话写进今天日记（`- [人际] …`），再 `diary log` 记一笔',
            '5) 别贪多：这一批处理完就停',
            ...summaryLines,
          ].join('\n'), {count: fresh.length})) return
      writeL({ lastSeen: Math.max(...fresh.map((x) => Number(x.t))) })
      log(`[bili-pod] 监听命中 ${fresh.length} 条（${who}）→ 已叫醒`)
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
          if (cfg.ledger?.enabled !== false) {
            const row = host.ledger.appendRound({
            operationId: `verify:${lastVerifyAt}:${r.checked.map(c => c.rpid).join(',')}`,
            root: workDir, mode: 'verify', title: `复核 ${r.checked.length} 条`,
            body: ['## 复核结果', '', ...r.checked.map((c) => `- \`${c.bvid || 'oid'}\` rpid ${c.rpid} —— ${c.visible === true ? '本人登录可见' : '未确认'}（${c.how}）`), '', ...(r.skipped ? [`（另有 ${r.skipped} 条未到复核时间或已结束）`] : [])].join('\n'),
            })
            if (row?.committed) await safeEmit('ledger:write', { mode: 'verify', file: row.file, reused: row.reused })
          }
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
      if (stopped) return
      if (liveStopping) { liveStopping = false; return }
      const out = String(stdout ?? '')
      if (/AWAIT_HIT|DANMAKU_HIT/.test(out)) {
        liveWaking = true
        const lines = out.split('\n').map((s) => s.trim()).filter((s) => /AWAIT_HIT|DANMAKU_HIT|@/.test(s)).slice(-3).join(' / ').slice(0, 300)
        ;(async () => {
          try {
            const scope = host.scopeFor({ reason: 'live', config: readConfig() })
            host.writeScope(workDir, scope)
            if (!await deliver('live', [
                  personaLine(),
                  `【直播间有人叫你】${lines || '（看输出）'}`, '',
                  '范围按主人设置（只回主人 / 只回 @她的）；回一句就收住（弹幕不是评论区）。',
                  '发弹幕：`node bili.mjs danmaku send --msg "…" --reply-mid <mid> --reply-name <昵称>` → `--dry` → `--go`',
                  scope?.active && !(scope.allowWrite ?? []).includes('danmaku') ? '⚠️ 本轮没有「发弹幕」权限 —— 设置 → 鲸群 → 权限 里打开，或只在心里记着。' : '',
                ].filter(Boolean).join('\n'))) return
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
    async wakeNow() {
      if (stopped || !ctx.sessionController) return { ok: false, reason: '生物钟还没挂上（缺 sessionController）' }
      busyUntil = 0
      writeState(historyOf(readState() ?? {})) // 丢掉当前还没到点的计划，让 tick 重新排
      await tick(true)
      return { ok: true, plan: readState() }
    },
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
      lifetime.abort()
      ;[boot1, boot2, bootDm, boot3, bootV].forEach(clearTimeout)
      ;[timer, timer2, timer3, timerDm, timerV].forEach(clearInterval)
      try { liveProc?.kill() } catch { /* ignore */ }
      for (const child of children) { try { child.kill() } catch { /* ignore */ } }
    },
    tick,
    listenTick,
    dmTick,
    liveTick,
    verifyTick,
  }
}
