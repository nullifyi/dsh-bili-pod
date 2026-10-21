# 能力对照与差集清单

三个项目的关系：

- **基座** = [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（本项目的代码血缘，MIT）
- **①** = [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（参照对象，MIT）
- **鲸群** = 本项目

本文分两部分：**A. 三方能力矩阵**（一眼看差在哪）；**B. 差集清单**（① 有、鲸群没有的，逐条给结论：已实现 / 近似实现 / 留待以后，附落点与做法）。

---

## A. 三方能力矩阵

| 能力 | 基座 whale | ① scroll | 鲸群 pod | 说明 |
|---|---|---|---|---|
| 登录方式 | 手动 F12 抠 cookie | 扫码 + 手动 | **扫码 + 手动** | 鲸群二维码是内联 SVG + 终端 ASCII，不依赖 python |
| 一轮怎么跑 | `sessionController` 唤醒会话 | 子进程跑 headless `dsh` | **`sessionController`**（同基座） | 按需求「一轮运行方式采用基座」 |
| 设置界面 | 自有 `settings.html` 网页 | 原生 `settings.section` | **原生 section（「鲸群」）** | 按需求「设置用基座」；独立网页已删 |
| 作息 | 固定窗口 | 峰/谷时段（12–14 谷、18–09 夜） | **固定窗口 或 峰谷（可切）** | `night.mode = fixed \| tide`，默认 fixed |
| 发评论 | 直接发 | 可选自动评论 | **可选自动评论 + 发前审核（默认开）** | 审核开着时非主人的回复必须先落草稿 |
| 发出后复核 | 无 | 有（`x/v2/reply/main`） | **有（同 ① 的思路）** | 措辞只有「公开可见 / 没查到」 |
| 日记 | 两篇 md（公开 + 私密） | `out/<date>.md` 日报 | **文件夹：daily/ owner/ records/ archive/ + INDEX** | 按需求 9 |
| 章程 | 无 | `duty.md` + sha256 台账 | **无章程**；换成「人设 + 记录库」 | 按需求 10 |
| 账本 | 无（只有 `pod-log.jsonl`） | duty 台账 + 日报 | **哈希链账本（rounds/ + verify）** | 按需求 13，按 ① 仿制并升级为 prev 链 |
| 产生文件 | 日记 / 日志 | `out/` 日报 | **artifacts（默认关）** | 按需求 12 |
| 权限收敛 | 无（工具链全开） | 每轮 MCP 工具白名单 | **权限单 `scope.json`**（命令级，4h 过期） | 近似实现 ① 的白名单 |
| 扩展机制 | 无（改源码） | 无 | **mod 宿主（11 事件 + fields/routes/commands/提示段）** | 按需求 6 |
| 通知 | file/desktop/dm/webhook/command | 无独立通知 | **同基座 + 测试按钮** | |
| 语音转写 | 无 | 本地 Whisper（~1GB） | **无（用字幕）** | 见 B-4 |
| Python / uv 自举 | 无（纯 JS） | 有 | **无（纯 JS，零第三方依赖）** | 见 B-1 |
| 私信 | 有（只给主人、互粉） | 有（dmMode）+ 可选自动 | **同基座** | 三条红线不接受覆盖 |
| 弹幕 / 直播 | 有 | 无 | **同基座** | |
| 行情 | 有（动态 / 图文动态） | 无 | **同基座** | |

---

## B. 差集清单：① 有、鲸群没有的

### 已实现（照 ① 做的）

| 能力 | 落点 |
|---|---|
| 扫码登录 | `lib/login.mjs` + `lib/qr.mjs` + `GET /login/qr`、`GET /login/poll` + 设置页「登录」面板 + `bili.mjs login` |
| 峰谷时段 | `lib/tide.mjs` + `night.tide` 配置 + 设置页 `TideEditor` + `POST /tide/preview` + `bili.mjs tide` |
| 发出后复核 | `lib/verifycomments.mjs` + `tools/commands/verify-now.mjs` + `verifyTick`（5 分钟一扫，间隔/条数可配）+ `POST /verify` |
| 哈希链账本 | `lib/ledger.mjs`（`prev` = 上一份全文 sha256）+ `tools/commands/ledger.mjs` + `GET /ledger`、`POST /ledger/verify` + `ledgerModeFor` 分 mode |
| 产出物（类似 `out/`） | `tools/commands/artifacts.mjs` + `artifacts.enabled`（默认关） |
| 工具白名单思路 | `lib/scope.mjs`（权限单，命令级）—— 粒度不同，见下 |

### 近似实现（思路对上了，做法不同）

**B-1. 每轮工具白名单（① `mcpWhitelist()`）**
① 靠「只有 4–6 个 MCP 工具暴露给模型」来控制越权；鲸群没有 MCP，改为**每轮醒来写一张权限单** `pod-work/scope.json`：本轮只放行 `READ_CMDS` + 该轮需要的写命令（默认只有 `fav` / `reply-draft`，分享开时加 `comment`，私信时加 `dm`；`dynamic` / `danmaku` / `comment-del` 必须在设置「写权限」里显式打开）。命令脚本入口 `tools/bili.mjs` 统一查这张单，拒绝时 exit 3。过期（4 小时）自动放行并按手动轮处理；`BILI_POD_SCOPE=off` 可显式绕过（人工批准回复时宿主就是这么绕的）。
> 想要更细（按工具/按接口而不是按命令）时，做法是把 `scope.json` 从「命令名集合」升级成「命令 + 参数白名单」，落点只在 `lib/scope.mjs:checkCommand()`，其它地方不用动。

### 留待以后（还没做）

**B-2. `uv` 自举 + Python 环境**
① 用 uv 下载一套 python 来跑它自带的 MCP server 和 ASR。鲸群是纯 JS、零第三方依赖（`npm test` 不需要 `npm install`），引入 Python 会毁掉这个性质，所以没做。
> 要的话建议做成 mod（`pod.dataDir()` 存环境、`pod.command` 暴露入口），不污染主仓。

**B-3. 内置 MCP server + 30 多个 `bili_*` 工具**
① 的主体就是 MCP server。鲸群走 `bili.mjs` 命令族（30 条）+ 权限单，功能和它基本重合（搜索/字幕/评论/信息/回复/私信/动态/收藏/投稿相关除外）。
> 真的需要 MCP 形态时，写一个 mod 在 `setup(pod)` 里 `pod.route()` + `pod.command()` 就能对模型暴露 `bili_*` 名字。

**B-4. 本地 Whisper 语音转写（约 84 MB / 装完 ~1 GB）**
① 用来「听懂视频」。鲸群走「字幕优先 + `debrief` 通读」，没有字幕的视频只能靠标题/简介/评论判断。
> 这是清单里**最影响能力上限**的两项之一。要做：mod 里 `pod.command('asr')` 调 `yt-dlp`+`whisper.cpp`（可复用 `tools/lib/ffmpeg.mjs` 找二进制的逻辑），把转写文本喂给 `video-content`。

**B-5. 二维码 PNG 图片**
① 用 `qrcode[pil]` 生成 PNG 给网页显示。鲸群直接出内联 **SVG**（设置页）+ 终端 ASCII（CLI），少一个依赖、少一次磁盘写。

**B-6. `duty.md` 章程 + sha256「章程升级台账」**
按需求 10 明确不要章程。等价物：`~/.bili-ai/persona.md`（人设，只有她能改）+ `pod-diary/records/`（从日记里提炼的长期记录库）。`ledger` 的哈希链正好接管了「防篡改」这件事，只是对象从章程变成每轮流水。

**B-7. 子进程 headless 跑一轮**
① 用 `spawn(dsh --profile headless --patch …)`（因此有「desktop NEXT 自动跑会挂」的老问题）。鲸群按需求 3 用基座的 `sessionController`，没有这个问题。

**B-8. `fav` 侧车脚本（`lib/favops.py`）**
① 在一轮结束后解析日报里的 `### BV` 自动收藏；鲸群把「收藏」放进醒来协议第 5 步（判据：3 个月后还想点开 / 理由 ≥6 字 / 同日 ≤3 / 同视频 30 天一次），由她自己判断并调 `bili.mjs fav`。能力等价，触发点不同（她当场判断 vs 事后解析报告）。

**B-9. 楼中楼「回复的回复」单独开关**
① 有 `replyToComments` 单独控制是否回复别人的楼中楼。鲸群用 `listen.oncePerPerson` + 发前审核覆盖了同类风险（同一人只回一次、非主人回复必须过审），但没有「只回楼中楼/只回主楼」的细分开关。
> 需要时：`listen` 里加 `depth: 'root' | 'sub' | 'both'`，落点 `lib/scheduler.js:listentick` 的过滤条件。

---

## C. 维护这份清单的约定

- ① 升级新能力时，先在这里登记一行（能力 / 是否做 / 落点），再动代码 —— 免得「能力对照」散在聊天记录里。
- 「留待以后」的四项按影响排序：**B-4 ASR > B-9 楼中楼细分 > B-3 MCP 形态 > B-2 uv**。
