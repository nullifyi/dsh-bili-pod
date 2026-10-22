# 能力与设置差集（2026-10-22，0.5.1）

参照项目为 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 与 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)。whale 是代码派生来源；GitHub `fork=false` 的事实及固定比较提交见[验收记录](ACCEPTANCE-20261022.md)。本清单以本轮读取的原源码为准，不声称已合入最新上游。

## 三方结构

| 能力 | whale | scroll | 本项目及边界 |
| --- | --- | --- | --- |
| 单轮运行 | 宿主 `sessionController` | 子进程 headless DSH | 沿 whale；使用 create 返回的实际 ID，prompt accepted 仅指收到请求，不是执行完成 |
| 设置形态 | 已有原生 `settings.section` | 原生设置区及插件面板 | 沿 whale 原生 section（设置 → 鲸群），不是从独立 HTML 改造 |
| 登录 | 手动 cookie | 扫码、手动、登录状态 | Node 扫码/轮询、手动导入与凭据复用；取消按 requestId 隔离旧轮询；真实扫码未验 |
| 作息 | 固定窗口、随机跳过 | 峰谷、中午/夜间开关 | 默认 fixed，可选 tide；跨午夜保留所有交集，拆段不增加总 wakes |
| 回复 | 评论、主人互关私信 | 评论回复、DM 投递 | 所有回复默认审核，可关；包括主人，不能用 `--reviewed` 自批 |
| 「评论复合」 | 无新增复核机制 | 发出后查评论 | 解释为发后复核；字符串 rpid、次数/间隔、有界公平重试；本人登录观察非全网公开证明 |
| 日记与上下文 | 自己/给主人两篇日记 | 日报、章程 | daily/owner 分离、分类记录+索引、月度归档；人设+今日+记录路径实际进入唤醒提示；默认不读旧归档 |
| 账本 | 日志 | 章程 hash 台账、日报 | rounds Markdown、prev 链、稳定 operationId；本地完整性线索，不保证防篡改或对外 exactly-once |
| 产出 | 视频处理材料 | 日报及转写材料 | artifacts 默认关，独立字幕/封面也受同一开关约束；不禁止必要日记、账本、凭据/状态文件 |
| 权限 | 既有 CLI | 模型 MCP 白名单 | CLI scope 命令策略；active 自动轮 4 小时过期拒写，只读可用；不是模型工具隐藏或系统沙箱 |
| 扩展 | 在原结构扩展源码 | MCP/脚本结构 | fields/prompts/commands/routes/11 个实际事件，支持启停/清理/失败回滚；可信 Node 代码，不自动变成 MCP |
| 通知、直播及既有写能力 | 通知、动态/图文、直播弹幕等 | 部分评论/私信/投稿工具 | 沿 whale；未为凑对照新增投稿、任意 UID 私信或真实互动 |

证据入口：[调度与原生会话](../lib/scheduler.js#L227)、[设置 section](../lib/client.js#L984)、[扫码服务](../lib/index.js#L273)、[CLI 权限](../lib/scope.mjs#L83)、[扩展契约](../extensions/README.md)。

## 原公开工具逐项映射

原 scroll 的 `vendor/bilibili-mcp/mcp_server.py` 有 **27 个**公开 `bili_` 函数，准确拆分为 **3 个登录/凭据 + 24 个业务**。完整 27 行、参数/输出差异与协议来源在[只读 CLI 对照](readonly-cli.md#L45)，不能用本项目 CLI 命令数量替代等价性：

| 原函数组（均为 bili_ 前缀） | 本项目入口 | 实际差异 |
| --- | --- | --- |
| login / login_check / check_credential | `login`、内部轮询、`session` / `login status` | 非原 MCP 两阶段 schema，无单独同名 check 工具 |
| search / comments / subtitle / danmaku / video_info | `search`、`comments`、`subtitles`、`video`、`covers` | 官方字幕无 ASR；video 的 XML 弹幕预览前 20 条，不能把直播 `danmaku` 当视频弹幕工具 |
| reply / send_dynamic / send_opus / send_message | `comment`、`dynamic post`、`dynamic-image`、`dm` | 沿既有受限写路径；图文不是完整 opus 富文本编排；私信只限主人且互关，不等于任意 receiver_uid |
| crawl | `search` 后对选中 BV 分别读 `comments` + `subtitles` | 可组合，没有原 max_videos 单条批采及汇总 JSON；单视频 `debrief` 不是批采等价物 |
| upload_video / upload_video_multi / video_zones | 未支持 | 单 P/多 P 投稿是新写能力；旧静态分区表不能冒充当前上传分区 |
| hot_videos / hot_buzzwords / weekly_hot / rank | `popular`、`buzzwords`、`weekly`、`rank` | 热词图鉴不是搜索热搜；weekly 省略期号读列表；rank 支持原 V2 分类，不接受无效 day 参数 |
| user_info / user_videos | `user-info`、`user-videos` | info/upstat/relation 聚合任一失败整体报错；投稿分页/关键词/排序；WBI2/access-id 自动获取未支持 |
| favorite_lists / favorite_content | `fav-remote folders` / `contents` | 远端数据，不是本地 `fav --list`；必须显式 mid，不支持原 uid=0 推断快捷语义 |
| unread_messages / received_replies / received_at_and_likes | `messages unread/reply/at/like/all`、既有 `comment-digest` | messages 每类一页、API data 输出，like/likes 键及聚合格式不同；摘要可用已有 pages 参数 |

本轮补齐轻量只读聚合：热门、热词图鉴、周榜、排行、用户资料/投稿、远端收藏夹/内容及消息。来源固定为 `bilibili-api-python 17.4.1` 发布定义，见[协议索引](reference/bilibili-api-17.4.1-readonly.md)；未安装 Python 依赖，未以真实请求证明今天仍可用。假网络只证明派发、参数、错误传播与输出行为。公开类可匿名尝试，消息需已有凭据，服务端权限与风控仍可能拒绝。

## scroll 设置和操作对照

原字段以原项目 `index.js:49–90`、默认对象 `index.js:198–200` 与 `client.js:370–575` 为本轮本地读取证据；它们不随本包分发。本项目落点为[默认/归一](../lib/defaults.mjs#L15)、[设置字段](../lib/client.js#L62)、[提示生成](../lib/scheduler.js#L82)。同名或相似设置不代表限制完全相同。

| 原设置/操作 | 本项目对应 | 差异与决定 |
| --- | --- | --- |
| perDay 每日挑选 5 条 | `night.maxVideos` 每轮上限、`quota.shareDaily` 默认每日分享 3 条 | 挑选与分享口径不同，没有同语义的全日挑选计数；需要时先明确计数对象再实现，不拿分享额度冒充 |
| peakValley、noon、night | `night.mode`、fixed windows 或 `night.tide` | 时段可配，非照搬两个固定开关；tide 可关闭 |
| autoComment、mentionName | `share.enabled`、`owner.mid/name`、`share.via=comment` | 分享评分、理由、去重仍有效；不是自动给任意人发评论 |
| dmMode off / only / both、dmUid | `share.via=comment/dm/both`、`owner.mid` | both 为已接受公开分享的一次同正文/BV DM 续送，只记一次分享额度；主人互关限制保留 |
| transcribe、asrModel | 无 | 未装 Whisper/模型；字幕优先，必要时开启 artifacts 用抽帧/硬字幕图辅助，不能声称完整听懂无字幕视频 |
| commentPerRound、replyPerRound | 同名，0–20 / 1–10 | UI→保存→配置→真实 CLI/prompt 已接线；预算主要靠 agent 遵循，0 评论另撤销自动评论权限，不是逐次硬计数沙箱 |
| replyToComments | 新/空配置默认 false | 旧 raw 明确 listen.comment=true 且缺新字段时迁移 true，显式新值优先；只回复 target_id 匹配已记录本人 rpid 的直接回复，不消费 @ 或无法归属通知，不是楼层深度开关 |
| keywords | `preferences.keywords` | 实际进入 feed/唤醒；章程不再作为默认关键词来源 |
| 搜索工具 order 参数 | `search.order` 设置与 `search --order` | 默认 totalrank，可选 click/pubdate/dm/stow/scores；CLI 显式值优先，非法值拒绝；不是全局 feed 排序或热门榜切换 |
| pythonPath、dshBin、headlessProfile、overlayMcp | 无同名配置 | 采用原生会话+Node CLI；`toolsPath` 不是 Python/headless/MCP 叠加配置的等价物 |
| workspace | 宿主专用工作目录及 `diary.dir` | 会话 cwd 与提示绝对路径由宿主解析；没有相同 headless 工作区字段 |
| reportLevel full / brief / off | 同名、默认 full | 控制可选报告/摘要推送；off 不关闭日记、记录和账本，不等于原 off 完全不写日报 |
| favFolderId、收藏夹下拉 | 同名 ID 输入、`fav --folder` | 只使用本人收藏夹，空值沿用默认夹；原 0 是不开自动收藏，语义不同；没有远端列表驱动的设置下拉 |
| fav-today 补收藏今天 | 无自动补收藏/日报侧车 | agent 当场判断后调 `fav`；理由/日限/30 天去重保留；不能说与宿主自动解析日报收藏完全等价 |
| 人设/章程、工作区资料 | `persona.md` + 今日日记 + records/INDEX/分类记录 | 实际提示路径已修；不创建新的 duty.md 核心，不保证模型每次都读完全部文件 |
| 扫码、手动登录、状态/依赖检查 | 登录面板、`login/session/deps/selftest`、状态面板 | 真实 DSH UI、账号登录及依赖体检未在本轮执行，不能把离线 fixture 当实机通过 |
| 检查更新按钮 / update | 无 | 未增加版本抓取/安装器；需手动核对可信发布与 SHA，再决定升级；本分支 0.5.1 不是 npm/市场发布 |
| 运行状态/日志 | 设置页状态/计划/账本/日志及事件 | `round:delivered` 是接收；没有可靠 agent 完成事件或失去宿主会话后的自动重建 |

设置页仍有遗留文案：[审核/复核提示](../lib/client.js#L82) 写“回别人”“公开可见”，并把 `verifyIntervalSec` 标为分钟；后端实际是所有回复默认审、本人登录观察、秒单位。接线回归不证明这些提示准确，本轮文档明确揭示，生产文案修复交 controller 判断。

## 未支持与建议

| 未支持/无法验证项 | 原因、建议及实现边界 |
| --- | --- |
| 本地 ASR、Python/uv 自举 | 重依赖及下载/模型管理不在本次；需要时设计可选独立模块，并先明确安装位置与资源预算 |
| 真 MCP server、原 `bili_*` 工具 schema | HTTP/CLI 注册不足以实现 MCP；需要独立协议适配、真实模型工具注册及生命周期测试，可用模块接入，不靠命名冒充 |
| 投稿、多 P、完整 opus/当前分区 | 新对外写入或缺可靠当前协议；后续单独设计权限、去重和账号验收，不为填矩阵直接开放 |
| 原批采、日报侧车/全日挑选数、收藏夹下拉、补收藏今天 | 组合读取/当场 fav 只部分覆盖；确需原语义时分别补聚合、计数和 UI，不把近似入口标等价 |
| 搜索热搜、WBI2/access-id 自动获取、原输出 schema | 热词图鉴与热搜不同；用户接口只接受显式 w_webid；先查当前原始协议证据，再单独扩充 |
| PNG 二维码 | 当前 SVG/终端字符已经支持登录用途；确需 PNG 导出可独立增加，不为显示而添依赖 |
| 自动更新、真实宿主/真实网络/真实发送、完整视频观看 | 本轮没有相应执行证据；按精确交付 SHA 后续可回滚加载与最小验证；不覆盖运行中安装 |
| GitHub fork 血缘、发布推送与调度终结 | fork 前置要求未满足；不能删仓造历史。分支发布和最终调度终结由 controller 核实，本文不是完成证明 |

核心缺陷直接修在生产路径，新增接口保持模块化；不能把日记幂等、发送审批或扫码竞态塞进未默认加载的 mod 来回避核心修复。扩展运行的是可信 Node 代码，8 秒超时不能隔离同步死循环、直接 IO 或撤销副作用。

配置合并边界：[mergeDeep](../lib/defaults.mjs#L75) 消费 defaults、JSON 配置及持久化 patch；[writeConfig](../lib/store.mjs#L68) 不接收 `applyTide` 的运行时函数对象。`applyTide` 产生的 `skipChanceFor` 只用于 planner/inWindow/preview，当前没有回灌路径，因此未扩修通用函数克隆。以后若把函数传入 writeConfig，仍可能抛 `DataCloneError`，调用者应提取可持久化 JSON 字段。
