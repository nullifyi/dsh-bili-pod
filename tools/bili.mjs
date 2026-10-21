#!/usr/bin/env node
// 统一入口：node bili.mjs <命令> [参数...]
// 只是把你转到 commands/ 或 verify/ 下的具体脚本，参数原样透传。
//
// 鲸群新增的一层：**本轮权限单**（lib/scope.mjs）。
//   宿主每轮醒来/监听会写一份 <work>/scope.json，写明这一轮允许哪些写操作。
//   写命令（comment / dm / fav / dynamic / danmaku / comment-del）不在单子里 → 这里直接拒绝。
//   只读命令永远放行；没有自动轮权限单才视作手动轮，过期自动轮拒绝写操作。
//   显式绕过：BILI_POD_SCOPE=off node bili.mjs …
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from './lib/nodebin.mjs'   // 别用 process.execPath（Electron 里它是主程序 ✗）
import { checkCommand, readScope } from '../lib/scope.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const map = {
  // —— 读（不需要写操作，安全） ——
  session: ['verify/session.mjs', '确认凭据属于哪个号'],
  thread: ['verify/thread.mjs', '导出一条评论的完整楼中楼结构'],
  'check-comment': ['verify/comment-exists.mjs', '按 rpid 复核评论是否存在'],
  'check-dynamic': ['verify/dynamic-inspect.mjs', '看动态的结构化内容（类型/图片/节点）'],
  'check-mention': ['verify/mention-check.mjs', '确认动态里的 @ 是不是真提及（查 opus 页）'],
  watch: ['verify/watch-replies.mjs', '盯一条评论的楼中楼等新回复：--aid --root --bvid [--uid 只认某人] [--minutes]'],
  'comment-await': ['commands/comment-await.mjs', '评论版"叫我起床"：廉价进程守「回复我的」，命中即退出叫醒 agent（0 token）：--minutes --interval [--only-owner]'],
  'comment-digest': ['commands/comment-digest.mjs', '今天谁找过人家（回复+@ 两个收件箱汇总，只读）：--hours 24 --pages 2 [--only-unread]'],
  recon: ['verify/dryrun.mjs', '发评论前的侦查：BV→aid + 评论区状态 + WBI 材料'],
  video: ['commands/video-content.mjs', '不点开视频也能还原它讲什么（读文字：简介/字幕/弹幕/评论）'],
  subtitles: ['commands/subtitles.mjs', '拉官方字幕全文（WBI 签名，带时间戳）：<BV> [--lan ai-zh] [--print N] —— 看视频最省的一条腿'],
  'watch-video': ['commands/bili-watch.mjs', '真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼九宫格 → 交给 read_image：<BV> [3x3|4x4] [--uniform]'],
  debrief: ['commands/debrief.mjs', '看懂一条视频（一条龙）：封面+简介+官方字幕+弹幕热区(对齐字幕)+热评+画面抽帧：<BV> [--bucket 30] [--top 5] [--grid 3x3] [--no-frames]'],
  comments: ['commands/comments.mjs', '热评 / 最新评论（只读，匿名可读）：<BV> [--ps 20] [--pn 1] [--sort hot|time] [--json]'],
  feed: ['commands/feed.mjs', '选题器（只读）：照日记里的「爱看」捞候选，排除看过的/已评论过的：<BV> [--n 6] [--per 2]'],
  quota: ['commands/quota.mjs', '限额闸（代码强制部分）：status / check --auto|--share / record / set --daily N / react / ask / allow'],
  likes: ['commands/likes.mjs', '谁赞了她（「收到的赞」通知流，含点赞者 mid/昵称）：--hours 24 [--owner] [--json]'],
  selftest: ['commands/selftest.mjs', '启动测试（装完先跑这个）：配置/凭据/登录态/目录/ffmpeg + 下一步两件事'],
  deps: ['commands/deps.mjs', '依赖体检（装完先跑它）：cookie / ffmpeg / Node / 数据目录；--json 给 agent 判断'],
  diary: ['commands/diary.mjs', '日记文件夹：show 摘要 / today / log / archive 归档并摘记录 / recall 翻旧账 / tail'],
  records: ['commands/records.mjs', '分类记录库：list（各分类条目数）/ add 手记一条 / show <分类> / index 重建总索引'],
  ledger: ['commands/ledger.mjs', '账本：write 落一份 / list / show <day>/<file> / verify 查哈希链 / index'],
  verify: ['commands/verify-now.mjs', '复核最近发出的评论「公开可见没有」（看不到 ≠ 没发出，只写「没查到」）'],
  login: ['commands/login.mjs', '扫码登录：qr 在终端画二维码并轮询 / status 看当前凭据'],
  extlist: ['commands/extlist.mjs', 'mod 扩展：列出目录、已装扩展、注册的命令/路由/字段（不出网）'],
  tide: ['commands/tide.mjs', '峰谷作息：show 看当前配置 / preview 看今天算出来的窗口'],
  artifacts: ['commands/artifacts.mjs', '产出物（默认关）：status / save --name x --text … / list / show'],
  notify: ['commands/notify.mjs', '通知分发（后端 stdout/file/webhook/command，由 config.notify 决定）'],
  night: ['commands/pod-night.mjs', '生物钟（旧的 CLI 版）：plan / clock / mark / status —— 插件里由宿主调度，一般不用手动跑'],
  search: ['commands/search.mjs', '按关键词搜视频（WBI 签名）：标题/UP/播放/简介/标签'],
  covers: ['diagnostics/fetch-covers.mjs', '抓视频元信息 + 封面图存到 covers/（供看图理解内容）'],
  whois: ['diagnostics/whois.mjs', '按 mid 查昵称（@ 人前先核准名字）'],
  // —— 写（会真的发出去；都必须显式 --dry 或 --go） ——
  'dm-await': ['commands/dm-await.mjs', '私信监听（只认主人；命中打印 DM_HIT）'],
  fav: ['commands/fav.mjs', '收藏（我想留着）：判据强制 · --list / --check / <BV> --reason … --dry|--go'],
  dm: ['commands/dm.mjs', '私信（专属通道）：一天只锁定 1 个收信人 · 只发主人 · 必须互关'],
  comment: ['commands/comment.mjs', '发一条视频评论；带 --root/--parent 就是二级回复；--verify 发完立刻复核'],
  'reply-draft': ['commands/reply-draft.mjs', '待审回复（发前审核）：add 进队列 / list / show / drop / take'],
  'comment-del': ['commands/comment-del.mjs', '删除自己发的一条评论（x/v2/reply/del，只能删自己的）'],
  dynamic: ['commands/dynamic.mjs', '动态：post / rm / check'],
  'dynamic-image': ['commands/dynamic-image.mjs', '发图文动态（上传图片 + 可带 @节点）'],
  'dynamic-edit': ['commands/edit-dynamic.mjs', '编辑已存在的动态（文字/图片都能改，id 不变、评论与点赞保留）：<dyn_id> <文本文件> [--go]'],
  danmaku: ['commands/danmaku.mjs', '直播间弹幕：pre 预检 / send 发送 / history 回读 / live 实时流'],
  await: ['commands/danmaku-await.mjs', '直播间"叫我起床"：出现该回的弹幕就退出，交给 agent 回'],
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log('用法: node bili.mjs <命令> [参数...]\n')
  console.log('命令:')
  for (const [name, [, desc]] of Object.entries(map)) console.log(`  ${name.padEnd(16)} ${desc}`)
  console.log('\n安全约定（脚本里也强制）:')
  console.log('  · 写操作必须显式给 --dry（只打印请求）或 --go（真的发）')
  console.log('  · 先跑 session 确认是哪个号；写操作后一定用 verify / thread / history 回读复核')
  console.log('  · 自动轮里还有「本轮权限单」：不在白名单的写操作会被直接拒绝')
  console.log('  · 一次一条。批量、定时、多房间铺量不是这套工具的用途')
  process.exit(cmd ? 0 : 2)
}

// 参数翻译：有些脚本只认位置参数（argv[2]/argv[3]…），help 里教的却是 --key 形式。
// 只在"给出的键正好是期望顺序的前缀"时才转；给不全就不动，让脚本自己的报错暴露出来。
const POSITIONAL_SPEC = {
  recon: ['bvid'],
  thread: ['oid', 'bvid', 'root'],
  'check-comment': ['rpid', 'aid', 'bvid'],
  'check-dynamic': ['dyn'],
  'check-mention': ['dyn', 'mid', 'name'],
  'watch-video': ['bvid', 'grid', 'outDir'],
  'dynamic-edit': ['dyn', 'textFile'],
  video: ['bvid'],
  'records': [],
  'ledger': [],
}
function translateNamed(cmd, args) {
  const spec = POSITIONAL_SPEC[cmd]
  if (!spec || !spec.length || !args.length) return args
  if (!String(args[0]).startsWith('--')) return args
  const named = {}
  const flags = []
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i])
    if (!a.startsWith('--')) return args
    const k = a.slice(2)
    const v = args[i + 1]
    if (v === undefined || String(v).startsWith('--')) flags.push('--' + k)
    else { named[k] = v; i += 1 }
  }
  const given = spec.filter((k) => named[k] !== undefined)
  if (!given.length) return args
  const isPrefix = given.every((k, i) => k === spec[i])
  if (!isPrefix) return args
  return [...given.map((k) => named[k]), ...flags]
}

const entry = map[cmd]

// ── 本轮权限单 ────────────────────────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const WORK = process.env.BILI_POD_WORK || path.join(DSH_HOME, 'pod-work')
const scope = readScope(WORK)
const bypass = String(process.env.BILI_POD_SCOPE || '').toLowerCase() === 'off'
const gate = checkCommand(scope, cmd, { now: Date.now(), bypass })
if (!gate.ok) {
  console.error('⛔ ' + gate.reason)
  process.exit(3)
}
if (gate.note) console.error('· ' + gate.note)

let script = entry ? path.join(here, entry[0]) : null
let modHost
if (!entry) {
  const [store, {PodHost}] = await Promise.all([import('../lib/store.mjs'), import('../lib/extensions.mjs')])
  const config = store.readConfig()
  if (config.extensions?.enabled !== false) {
    modHost = new PodHost({workDir: WORK, readConfig: store.readConfig, dirs: [path.resolve(here, '../extensions'), ...store.USER_EXT_DIRS, ...(config.extensions?.dirs ?? [])]})
    await modHost.loadAll()
    script = modHost.commands.get(cmd)?.script
  }
  if (!script) {
    await modHost?.close()
    console.error(`未知或未启用的本地命令: ${cmd}\n跑 "node bili.mjs help" 看内置清单。`)
    process.exit(2)
  }
}
const r = spawnSync(NODE_EXE, [script, ...(entry ? translateNamed(cmd, rest) : rest)], { stdio: 'inherit' })
await modHost?.close()
process.exit(r.status ?? 1)
