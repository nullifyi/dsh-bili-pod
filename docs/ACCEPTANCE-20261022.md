# 17 项验收与修复记录（2026-10-22）

这是文档交付时点的证据记录，不是「所有 17 项通过」声明。离线修复已经形成 0.5.1；GitHub fork 前置条件未满足，真实安装/宿主未验，最终分支发布及调度终结尚待 controller 核实。

## 固定范围和仓库事实

| 项目 | 精确值/本轮只读核对结果 |
| --- | --- |
| 原交付基线、原 main | `aefd53718751453f618aeed1c91ecf9509b8edbf`，0.5.0 |
| 修复分支 | `codex/acceptance-fixes-20261022`，隔离工作树 `F:/codex/projects/dsh-bili-pod-review` |
| 最终生产代码提交 | `f1438c11941f82fd730048fb281c836d395d9594`，package 0.5.1；后续文档/控制记录提交不代表新增生产代码 |
| 固定上游比较参考 | `Alterssss/dsh-bili-whale` 的 `270cbf0d7a6523746f9b88e4527a4cd5589cd03d` |
| 上游期间更新 | 本轮 `ls-remote upstream HEAD` 已见 `3d7a427af8558f7c8252f6a0bd82a2f8b38fb961`；未将该新上游混入修复，不声称已验证其兼容性 |
| GitHub 元数据快照 | `nullifyi/dsh-bili-pod`，`private=false`、`visibility=public`、`fork=false`、无 parent/source，default branch main |
| 共同祖先 | 非 shallow；`git merge-base aefd53718751453f618aeed1c91ecf9509b8edbf 270cbf0d7a6523746f9b88e4527a4cd5589cd03d` 退出 1、无输出 |
| 分支发布状态 | 快照 `ls-remote origin` 仅有 main=上述基线，修复分支当时未推送；[目标分支地址](https://github.com/nullifyi/dsh-bili-pod/tree/codex/acceptance-fixes-20261022) 是拟交付位置，不作为已存在证据 |
| 署名与 About | LICENSE 保留 ALTERSSSS MIT 及 nullifyi 署名；GitHub About 历史“fork 自”描述未改。署名核对不是法律审计，代码派生不等 GitHub fork |
| 原安装 | 原仓 `F:/dsh/project/robo/dsh-bili-pod` 为干净 main、0.5.0；DSH desktop 的 node_modules/dsh-bili-pod Junction 仍指向该原仓，未指向本修复工作树 |

上述远端与安装是本轮 controller 已完成的只读快照；文档实现没有再次连接账号、网络或真实宿主。最终公开交付必须另记推送后的精确 HEAD、main 是否保持基线及终结状态，不能拿本地 commit 或版本号冒充上线。

## 17 项矩阵

“已修复（离线）”指源码路径及假宿主/假网络测试有证据；不代表真实 DSH、平台接口或对外发送已通过。链接行号对应上述生产提交的仓库文件。

| # | 原要求与状态 | 实现/核对证据 | 验证与剩余边界 |
| --- | --- | --- | --- |
| 1 | 扫码：已修复（离线）；实机无法验证 | [二维码/取消/轮询/手动保存](../lib/index.js#L273)、[UI requestId 生命周期](../lib/client.js#L423)、[登录回归](../tests/settings-login.test.mjs#L57) | waiting/scanned/expired、取消、旧 key/旧取消不得覆盖新凭据、复用有假网覆盖；未申请真人扫码或读取真实凭据 |
| 2 | 两项目能力对比：轻量差集已补，仍有未实现 | [完整能力/设置差集](CAPABILITY-DIFF.md)、[原 27 函数映射](readonly-cli.md#L45)、[真实 CLI 路由回归](../tests/readonly-cli.test.mjs#L39) | 新增热门等只读聚合；ASR、uv、MCP、投稿、批采等逐项列明，不以 CLI 数量宣称全等价 |
| 3 | 基座单轮：已修复（离线） | [create 实际 sessionId / prompt](../lib/scheduler.js#L227)、[原生协议/停机回归](../tests/runtime-contract.test.mjs#L126) | 采用 whale sessionController；accepted 仅接收；未验真实宿主运行完成 |
| 4 | 基座设置：已核对并修复接线（离线），仍有旧提示 | [原生 section](../lib/client.js#L984)、[配置归一](../lib/defaults.mjs#L93)、[设置回归](../tests/settings-login.test.mjs#L23)、[遗留提示](../lib/client.js#L82) | whale 本来就是原生 section；UI/server/config/CLI/prompt 已接线，legacy 保存迁移有覆盖；审核/复核旧措辞及分钟误标仍需处理，真实设置页未操作 |
| 5 | 可选、默认开审核：已修复（离线） | [默认值](../lib/defaults.mjs#L61)、[评论审核](../tools/commands/comment.mjs#L119)、[普通 DM 审核](../tools/commands/dm.mjs#L75)、[发送契约](../tests/send-contract.test.mjs#L35)、[DM 回归](../tests/dm-review-continuation.test.mjs#L9) | 主人不免审；自带 --reviewed 不算批准；目标/正文绑定、一次认领，uncertain 不自动重发；可显式关闭 |
| 6 | mod：已修复（离线） | [扩展宿主清理](../lib/extensions.mjs#L137)、[注册失败回滚](../lib/extensions.mjs#L386)、[重载/回滚/CLI 回归](../tests/runtime-contract.test.mjs#L75)、[接口文档](../extensions/README.md) | 字段/提示/命令/路由/真实事件可用；可信 Node，非沙箱，HTTP/CLI 不自动注册模型 MCP |
| 7 | 可选峰谷：已修复（离线） | [调度消费 tide](../lib/scheduler.js#L331)、[跨午夜与分配回归](../tests/runtime-contract.test.mjs#L39)、[作息用法](../README.md#生物钟固定窗口-或-峰谷) | fixed 保留；所有交集按时长最大余数分配原总 wakes，0 段仍监听，未用额度不跨段转移 |
| 8 | 原词“评论复合”：发后复核已修复（离线） | [精确 rpid 与观察范围](../lib/verifycomments.mjs#L36)、[有限公平重试](../lib/verifycomments.mjs#L81)、[发送契约测试](../tests/send-contract.test.mjs#L51) | 依 scroll 实际语义；本人登录可见≠所有人公开可见；未查到不能判未发/删除，不重发、不删帖 |
| 9 | 分栏日记/分类/索引/归档：已修复（离线） | [分类校验/布局](../lib/diarystore.mjs#L47)、[记录幂等](../lib/diarystore.mjs#L163)、[归档](../lib/diarystore.mjs#L248)、[失败恢复回归](../tests/diarystore.test.mjs#L125) | daily 与 owner 原文分开，月度归档；稳定记录/片段标记、正文先于状态、索引完成才删源；默认不读取旧 archive，仅 recall 按需读取 |
| 10 | 人设+记录实际上下文：已修复（离线） | [绝对路径解析及唤醒提示](../lib/scheduler.js#L103)、[隔离路径回归](../tests/runtime-contract.test.mjs#L104) | 人设、今日 daily/owner、records/INDEX/分类提示已接线；不再以 duty 为核心；无法保证模型实际读完所有文件 |
| 11 | agent/API/生命周期：已修复（离线）；宿主无法验证 | [启动/清理](../lib/index.js#L613)、[投递与 abort](../lib/scheduler.js#L242)、[生命周期回归](../tests/runtime-contract.test.mjs#L126) | create 错误传播、停机不迟投递、真实 CLI 派发有覆盖；没有可靠 round:end/CLI comment:sent，宿主删会话不自动恢复，未证明整服务真实执行完成 |
| 12 | 产出默认关闭：已修复（离线） | [默认 false](../lib/defaults.mjs#L66)、[媒体工具回归](../tests/runtime-contract.test.mjs#L150)、[字幕/封面回归](../tests/readonly-cli.test.mjs#L104)、[输出规则](readonly-cli.md#字幕与封面产出开关) | debrief/watch-video 及独立 subtitles/covers 均覆盖；关时不写媒体、不删旧产物，字幕 stdout/封面 URL；日记/账本/状态仍正常写 |
| 13 | 账本及重试：已修复（离线） | [appendRound/operationId](../lib/ledger.mjs#L89)、[索引恢复](../lib/ledger.mjs#L139)、[链检查](../lib/ledger.mjs#L172)、[发送测试](../tests/send-contract.test.mjs#L51) | 同 operationId 重试可复用、索引失败可恢复；哈希链不是防篡改；不声称所有不同操作的全局恰好一次 |
| 14 | 指定视频背景：部分完成，未完整观看 | 本轮只读公开 API 读取 `BV1EPnG6DEJC` 简介与前 8 条热评；[指定视频](https://www.bilibili.com/video/BV1EPnG6DEJC/) | 网页读取失败；未下载/观看整片，不把背景资料当互动授权，也不以 API 摘要冒充完整观看 |
| 15 | 先 fork 再修改：**未满足** | 本文仓库快照：API fork=false，无 parent/source；固定两 SHA merge-base exit 1；[署名说明](../NOTICE.md#L5) | 已保留派生代码/原署名并纠正文案；不能用改 README、删除重建或伪造历史补成“通过”；后续仓库关系操作另行处理 |
| 16 | GitHub 公开分支交付：**尚待终结核实** | 仓库 public 快照、精确本地生产 SHA 和拟交付分支见上表 | 文档时点没有修复分支已推送证据；controller 需最终独立审查并推送、ls-remote 对照精确 HEAD；不合并/强推 main，不代表 npm/市场发布 |
| 17 | 安装及交付清单：**原版已安装，修复版未安装/宿主未验** | 原仓 main 0.5.0 与 Junction 快照；[package 0.5.1](../package.json#L3)、本文矩阵/决定/验证记录 | 未覆盖运行中 DSH、未破坏既有数据；没有修复版加载/真实发送证据。后续需可回滚加载精确交付 SHA，不能凭“已装插件”算修复生效 |

## 修复和验证记录

Task 1 修复日记分类边界、正文/状态失败恢复、合并归档及索引重试；Task 2 修复审批认领、字符串 ID、unknown/accepted 发送状态、复核与账本幂等；Task 3 修复原生会话、停止/卸载、提示路径、扩展失败回滚、tide 跨午夜和媒体默认产出；Task 4 修复扫码代际取消、设置迁移、直接回复开关、主人 DM 审核、both 续送和相关 Windows 文件锁；Task 5 补只读聚合、独立字幕/封面开关并标 0.5.1。Task 1–5 均经过各自独立门禁；本文档 Task 6 与最终全分支审查另行进行，不能把阶段通过等同于终结完成。

上次中断的实际原因是 **usage limit**：Task 3、Task 5 分别留下未完成的红测试草稿，未形成完成交付；不是原需求被取消。controller 只读确认普通额度恢复后续接原实现者，没有购买或重置额度。本次已补齐这些生产路径与回归。中途 134/134 只覆盖当时已提交的 Task 1–4，不包含 Task 5 红稿，不能拿来证明 Task 5 完成。

| 检查 | 已记录证据及适用范围 |
| --- | --- |
| 完整测试 | Task 5 生产提交 `f1438c11941f82fd730048fb281c836d395d9594` 上 `npm test`：161 tests，161 pass，0 fail，0 skipped，17587.3184 ms |
| Task 5 focused | 47/47：新增 27 个只读/媒体相关用例与既有 20 个设置用例；9 项语法检查及 git diff --check 通过 |
| 实际命令入口 | [package.json test](../package.json#L17) 包含 10 文件；[readonly CLI](../tests/readonly-cli.test.mjs#L39)、[真实发送子进程契约](../tests/send-contract.test.mjs#L51)、[runtime](../tests/runtime-contract.test.mjs#L126) 使用临时 HOME、假网络/宿主、阻断未匹配网络 |
| 中途失败处理 | 旧 fixture 按已批准新默认值更新；Windows lock EPERM 保存原失败并聚焦诊断，再作 5 秒内有界重试；[相关测试](../tests/file-state.test.mjs#L13) 覆盖暂态、永久权限及 PID 写失败清理，不靠反复全套掩盖 |
| TDD 证据局限 | 依据各实现者红绿运行记录，不冒称本轮重演全部历史；QR 专属最初 baseline RED 未记录，后续跨代取消/legacy 保存修复有 RED，不能补造完整轨迹 |
| 本次文档自检 | 只核对四份文档 diff、相对链接与证据行号，不再次运行整套、不读取真实账号/凭据、不执行 DSH 或对外发送；具体文档提交及自检结果记在 controller 最终记录 |

## 代用户作出的决定、理由和代价

以下对恢复记录中的所有 Ruling 去重，保留决定、理由和代价。最新 DSH 反馈属于建议，不修改用户原 17 项要求。

| 决定 | 理由 | 代价/边界 |
| --- | --- | --- |
| 保留现仓，不删仓重建或伪造 fork 历史 | 授权是独立修复分支，不是删除仓库；文案不能创造共同祖先 | #15 保持未满足，后续真实 GitHub 仓库关系操作另做 |
| 隔离分支修复，不覆盖运行中安装 | 用户明确区分代码验收与真实安装授权 | 原 0.5.0 仍运行，修复不会自动生效，#17 无法按修复通过 |
| 日记采用稳定 HTML 记录/片段标记、正文先于状态、保留源至索引成功 | 单纯调整顺序不能覆盖状态失败；兼容现有分类与原文 | 纯文本可能看到标记，需保留格式；非备份保证 |
| --reviewed 不算批准；accepted 不降级、uncertain 不自动重发 | 默认审核和重复对外发言约束必须在实际发送路径成立 | 网络不确定或本地记账不全需人工核对，不能自动补发 |
| 主人及普通 DM 回复也默认审核，可明确关闭 | 原要求默认开启，没有主人免审例外；不恢复 DSH 建议的免审 | 主人主动回复也多一次批准；关闭后仍受原目标/额度限制 |
| active 自动轮权限超过 4 小时/时间无效拒写 | 过期自动放行会扩大旧授权，不恢复 DSH 建议的过期放行 | 卡住超过 4 小时需宿主重新签发；只读仍可用、手动无 active 单另处理 |
| 视频与评论只读作为背景 | 背景不是新的操作授权；困难语义优先补源码证据 | 只读简介+8 热评不等整片观看；#14 明示部分完成 |
| 按原生协议使用实际 sessionId，accepted 只记接收 | 真实 API create 可返回不同 ID，prompt 接受不能证明 agent 完成 | 没有可靠完成事件；删会话后的自动重建未支持，真实兼容需加载后验收 |
| tide 所有交集按时长最大余数静态分原整数 wakes，0 段监听 | 保留 planner 原预算/窗口历史，不增加总额与共享状态 | 未用额度不跨段挪用；短段可分到 0 次 |
| Task 1–6 串行、独立任务门禁，最终全分支审查 | 宽泛报告可能掩盖轻量差集遗漏；拆出只读与文档阶段 | 增加门禁次数与时间，不改变用户范围 |
| both 限 accepted 且记账完整的公开分享 operationId 一次续送同正文/BV | 才实际符合双渠道，复用共享额度/七天记录；需当前主人且互关 | 多一份续送状态；pending/rejected/uncertain/记账不全不能续，未知不重试 |
| replyToComments 新/空配置 false；仅 raw 旧显式 listen.comment=true 且缺新字段才迁移 true | 保留旧明确启用意图，不扩大新安装默认行动；显式新值优先 | 仅 known-own rpid 直接回复，旧 both 中 @/无法归属通知范围收窄 |
| 独立 subtitles/covers 也复用 artifacts 开关 | #12 必须覆盖实际全部媒体输出入口，不能只管 debrief/watch | 默认仅 stdout 字幕或封面 URL，需开启才落文件；开启同名文件可能覆盖，建议 --out 独立目录 |
| Windows exclusive-open 暂态 EPERM 有界重试，维持原 5 秒上限 | 新审批/续送消费共享锁，与真实发送状态相关；不掩盖永久错误 | 最小相关底层修复；不回收活锁或猜测陈旧锁，遗留锁需人工核对，永久 EACCES/超时仍失败 |
| 分支包标 0.5.1，保留原安装 0.5.0 | 同版本号难核验修复是否加载，需配合精确 SHA | 不是 npm/市场发布、不是已安装，最终文档提交可在生产 SHA 之后 |
| mergeDeep 只承担 JSON 配置合并，不为未调用组合加函数克隆框架 | defaults/持久化 patch 消费 JSON；applyTide 的 skipChanceFor 只供 planner/inWindow/preview，当前没有回灌路径，与最新 DSH 说明一致 | 后续 mod 若把运行时函数传入 writeConfig 仍可 DataCloneError，调用方应提取 JSON 字段；最终审查核对调用边界 |
| 核心缺陷直接修核心，新接口保持模块化 | 日记/发送/扫码问题是默认执行路径，未加载 mod 不能替它们修复；不引入无关框架 | 扩展不承担安全沙箱；未来 ASR/MCP 等可独立模块接入，但仍要真实协议和生命周期实现 |
| 终结时对同目标 daily 调度作可恢复 PAUSED，由 controller 核实 | 旧 dsh-bili-whale hourly 文件本轮已不存在；当前 codex-agent-md daily 在重复本轮反馈，应避免交付后重放 | 尚未执行暂停；不拿历史 ACTIVE 或无状态渲染卡片当当前证据，需最终检查实际配置 |
| 按已指定独立分支交付，保留隔离工作树及 scratch | 用户已选择分支交付，不需要再问通用合并菜单，也未要求 PR | 不另建 PR、不合并或删工作树；后续审查/恢复材料保留 |

## 未完成项与后续交接

完整能力缺口与建议见[能力差集](CAPABILITY-DIFF.md#未支持与建议)。仍未支持的具体能力包括：本地 ASR/模型与 uv/Python 自举、真实 MCP server/原 schema、单 P/多 P 投稿及完整 opus 编排、可靠当前上传分区、单条批采、原全日挑选额度/日报解析自动收藏/补收藏今天/收藏夹下拉、搜索热搜、自动获取 WBI2/access-id、自动检查更新、可靠 agent 完成事件及被删会话自动重建。PNG 二维码没有实现，SVG/终端字符足够当前登录用途。部分原参数和输出格式也不等价，参见 27 行映射。

尚无法验证：真实 DSH 版本/UI/插件加载与整轮 agent 完成、真人扫码/账号会话复用、B 站接口当前可用性/平台风控/真实发送及所有人可见性、完整视频观看、修复提交真实安装。不同 approved operationId 并发回复同 UID 的 once-per-person 预检查不是全局发送预留，不能承诺跨所有操作绝对一次；本地锁/哈希链/可信 mod 都不是同用户进程安全边界。

文档自查另外确认设置页 `lib/client.js:82–84` 尚有“回别人”“公开可见”旧提示和 `verifyIntervalSec` 分钟误标，后端实际按所有回复、本人观察、秒单位处理；这不是文档更改已修复的生产行为，交 controller 最终门禁处理。

controller 后续须完成本文档独立门禁与最强全分支只读审查，处理实际发现后推送独立分支，并记录远端精确 HEAD、公开性及 main 未被改动。调度方面，本轮旧 `dsh-bili-whale` 文件已不在；当前同目标 `codex-agent-md` 为 ACTIVE、每天 11 点、prompt 重复本轮 DSH 反馈。交付后由 controller 可恢复暂停并核实不再触发，不能把旧 hourly 状态继续当作当前事实。本文不宣称最终审查、推送或暂停已经发生。真实安装仍需后续按精确交付 SHA 可回滚加载，保留原数据并分开验证宿主和线上接口。

## 后续：0.6.0 追加（2026-10-22）

主人提出四项新要求，已在 0.6.0 落地并全量回归：纯 Node、无新依赖，`npm test` → 177/177 通过。

- 修「设置页 → 消息推送 → 发条测试」失败：类型 `dm` 时 `notify --test` 被发前审核闸拦（`exit 1`）。测试文案现在带 `--test` 跳过审核闸；普通私信仍然必须审核。
- 新增 `lib/pricing.mjs`（DeepSeek 折扣窗口）与 `night.mode='cheap'`；新增 `tools/commands/taste.mjs`（口味自改 + 兴趣度反推）；新增 `mistress` 配置、`dm --to` 第二收信人、`reply-draft --kind dm`。
- 这些仍属**本地验证**：真实账号私信/评论、微信/主机通知投递、真实 DSH 重启后的设置页渲染，仍须由主人按「装完立刻跑这一条」与设置页操作确认。

---

## 追加：0.6.1 开销监控（2026-10-22 晚）

主人问「有没有办法看小鲸鱼一天里什么工作花费的 token」。实现为只读监控，不改会话日志：

- `lib/spend.mjs`（多帧 zstd 会话解析 + 轮次/类别/工具归因）、`tools/commands/spend.mjs`（today / --date / --days / --all / --json / --watch）、
  `tools/bili.mjs` 注册 `spend`（只读，权限单放行）、`/dsh-bili/api/spend`、`/status.spend`、设置页「开销」面板。
- 口径：缓存读便宜、输出贵；¥ 按宿主 cost-meter 当日合计摊分（估算）；工具归因按步均分。
- 测试：`tests/spend.test.mjs` 5 例，全量 177/177。
