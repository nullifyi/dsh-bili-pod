# 0.7.0 修改框架：审批降噪 · 私信自动发送 · 收信人 · 开销叙事化

> 状态：**设计稿（未实现）**。定稿后按 §8 的顺序落地，一次发布为 0.7.0。
> 写作日期：2026-10-22。依据：用户 m02575 的四点反馈 + 20:24 那一轮的会话证据。
> 技术复核：2026-10-22，对照本地与 GitHub `main` 的 `32cff3773d76ceb86a91fdf011b3761ec54ca0ad`（0.6.3）。下列模块、接口和测试均是 **0.7 建议，不是已经实现**；本次只修订计划。
> 基线源码：[0.6.3 快照](https://github.com/nullifyi/dsh-bili-pod/tree/32cff3773d76ceb86a91fdf011b3761ec54ca0ad)；既有发送状态机、CLI 与 spend 均以此为准。
> 20:24 / 21:24 的日志描述来自原计划作者，本次未独立重读这些真实会话日志。实施前须复核基线；本文不授权修改宿主权限、覆盖安装或重启 DSH。

---

## 0. 先把「每次都要审核」拆成两层（你问的「完全权限是否还会这样」）

你在 20:24 那轮一共被弹了 **2 次 DSH 工具审批** + **1 次插件发前审核**，是三件不同的事：

| 层 | 谁在问 | 触发条件 | 20:24 的实际证据 | 「完全权限」能不能关掉 |
|---|---|---|---|---|
| ① DSH 工具审批 | DSH 宿主 | 她的会话是 `workspace-write`，脚本要写 `C:\Users\czm\.bili-ai`（草稿）和 `C:\Users\czm\.dsh\pod-diary`（日记）——都在 cwd `~/.dsh/pod-work` 之外 | 会话日志里 `approval/asked` 两次：`ops_bash` 写草稿目录、`pwsh` 升级 danger-full-access 写日记 | **能**。改成完全访问后 `approval/policy` 变 `never`，那一轮后半段再没弹过 |
| ② 插件发前审核 | 鲸群自己（`lib/comment-state.mjs`） | 当前 0.6.3：评论回复默认审核（不因对方是主人豁免）；普通私信默认审核，但 `--share` / `--test` 当前有免审分支，不能称“所有私信都审”。0.7 需要按下文统一判定 | `pending-replies.json` 的草稿属于这一层；是否弹 DSH 工具审批是另一回事 | **不能**。这是插件审核，与 DSH 权限无关 |
| ③ 配额/分享策略 | 鲸群自己 | 分享 3 条/天、同视频 7 天、私信 1 收信人/天…… | 没弹窗，只拦发送 | 不涉及弹窗 |

所以：**完全访问通常能消除该类越界写入审批，② 仍独立存在**。不能据此保证任何工具审批永远不出现；插件审核的降噪要单独改（§2）。

另外 ① 可以通过 **把运行状态从 `~/.bili-ai` 复制迁入 `pod-work`**（§5）减少越界写入审批。但凭据读取、现有日记路径、其他工具及宿主策略仍可能触发权限要求，不能保证“搬家后永远零审批”。完全访问也不等于关闭插件审核或平台风控。

---

## 1. 目标和原则

1. **已授权的正常流程尽量不打扰**：用户明确选择免审档、开启相应自动开关且宿主权限满足时，正常一轮以 0 次额外点击为目标；不把它当作旧配置或默认关闭 DM 时的保证。
2. **免审范围明确**：评论回复与私信按统一策略决定；陌生人、女主人不因“完全权限”自动获免审。删除等其他写动作不在本轮降噪范围内，不顺带放宽，也不宣称当前已有同样的审核入口。
3. **配置和迁移可回滚，发送可追踪**：每次发送保存 operation 与收据；私信不冒充评论复核记录。已发送的内容不能承诺一定可以撤回，`accepted` / `uncertain` 不自动重发。
4. **不引入新依赖**；配置仍是单个 JSON；旧配置自动迁移。

---

## 2. 审批策略：`review.policy`（四档）+ 批量批准

### 2.1 配置结构

```jsonc
"review": {
  "preReview": true,            // 旧字段：仅当 policy 缺失时用于迁移
  "policy": "auto-owner",       // 新安装建议值；旧配置按 §2.4 迁移，不静默切换
  "verify": true,
  "verifyIntervalSec": 20,
  "autoLimits": {               // policy 非 ask/off 时生效的硬上限
    "perDay": 12,               // 全天自动发出的评论+私信条数
    "perPersonPerDay": 1,       // 同一个人当天最多自动发几条
    "quietHours": ["00:30", "08:30"]  // 自动发送避开的时间段（睡觉别吵人）
  }
}
```

四档语义：

| policy | 评论回复 | 私信 | 适用 |
|---|---|---|---|
| `ask` | 评论回复先草稿；顶层分享沿原 share 规则，不伪称现有分享评论也审核 | 所有私信先草稿，分享私信也不凭 `--share` 自动免审 | 人工审核档 |
| **`auto-owner`（新安装建议值）** | 回**主人**可免审；回别人仍草稿 | 仅给主人具备免审资格，还须开启 §3 的 `dm.autoSend` | 日常降噪 |
| `auto-quiet` | 可增加已核实互关/粉丝的评论回复，受 autoLimits | 仍限已配置的主人/女主人白名单，并与 §3 开关取交集；不向任意粉丝发 DM | 更宽的评论回复档 |
| `off` | 免去插件人工审核 | 仍须开启 `dm.autoSend` 才能免审发送 | 不是关闭发送闸门 |

`off` 仅关闭人工审核，不绕过有效 scope、白名单、互关、禁发/分享策略、去重、收信人日锁或实际 DM 限额。分享评分继续只认现有 `share.minScore`，不再增加一个同义的 `minReplyScore`。

### 2.2 实现落点

- `tools/commands/comment.mjs:153`：
  ```js
  const needsApproval = reviewDecision({ kind: 'comment', recipientRole, relationship, share: SHARE, cfg, now }).required
  ```
- `tools/commands/dm.mjs` 同构，传 `kind:'dm'` 和已经核实的收信人角色/关系，再按 §2.4 与 DM 总开关取交集。
- 新 `lib/policy.mjs`：纯策略 `reviewDecision({kind,recipientRole,relationship,share,cfg,now}) → {required, reason, auto}`。角色/关系必须由配置与真实查询确定，不能信任 CLI 自报 `toOwner=true`。状态预留另用同模块函数，不在纯预览里扣额度。
- 计数文件：`<state>/auto-sent.json` 按日期、operationId 和统一字符串 recipientMid 保存预留/结果；不能只做“读 total → 请求 → total++”。`auto-*` 档的自动条数按实际 comment / DM 分别统计，分享账则仍按一次分享计算，见 §10.3。
- `lib/index.js` `/status` 增 `review{policy,autoToday,limits}`；required 是目标相关的预览结果，不是所有消息共用一个布尔值。`/pending/approve` 支持 `{all:true}` 批量批准（严格按 pending 列表逐条签发 token，不跳指纹校验）。
- 设置页：单选四档 + 一句「这一档会让哪些话不经你手」+ 自动总量/单人量/静音时间段 + 「今天已自动发 n/12」。预览必须说明 DM 独立总开关是否关闭。

### 2.3 批量批准（保留人工路径也不痛）

本轮先加 `[全部批准]`。`[这位以后自动]` / `[本轮全自动]` 是改变未来授权，不是批准当前草稿，建议暂缓，不混在批量批准中暗中修改策略。
后端 `/pending/approve {all:true, scope:'round'|'all'}`；每条仍走 `issueApproval` 签发匹配 token，保证 `comment-state.mjs` 的指纹约束不被绕过。

### 2.4 新旧配置和两套开关的唯一优先级

- 显式合法 `review.policy` 优先；只在它缺失时迁移旧 `preReview`：`false → off`，`true` 或旧配置缺省 → `ask`。非法 policy 回退 ask 并告警。新安装才采用建议的 `auto-owner`，旧用户不因升级被自动开免审。
- `review.policy` 决定“谁有资格免审”；DM 再与 `dm.autoSend && autoSendTo.includes(role)` 取交集。两者任一不允许，就进草稿，不是直接丢消息。`dm.autoSend=true` 不能越过 `policy=ask`。
- 评论与 DM 的发送资格闸门始终先保留；任何 policy 都不能扩大 DM 的收件人白名单。`auto-quiet` 的陌生人扩展只针对明确允许的评论关系。
- `auto-*` 的静音时段/自动预算不足时转待审或延后，不能在代码里临时改成 `off` 绕过。用户显式 off 不启用 autoLimits，但仍保留 DM 总开关及硬限额。手动批准仍须现有硬闸门，但不伪装成自动发送额度；具体日期沿项目现有日界线，测试固定时间。
- 旧配置缺少新增的 `dm.autoSend` 时仍按 false 处理，升级提示必须讲清“评论审核意图保留，但 DM 新总开关未开启”，不能宣称旧 off 用户的私信行为完全不变。
- `normalizeConfig` 必须在默认值注入前判别旧字段，随后持久化迁移结果；局部保存 self、导入旧文件、重复读取都不能反复切换策略。

---

## 3. 私信自动发送（独立开关）

### 3.1 配置

```jsonc
"dm": {
  "autoSend": false,                 // 总开关（默认关 —— 自动发消息是「对外说话」，要你亲手开）
  "autoSendTo": ["owner"],           // 允许自动发的收信人：owner / mistress
  "maxPerDay": 1,                    // 自动 DM 的实际消息条数上限；分享/普通都计入
  "minGapMinutes": 240,              // 两条私信之间至少隔 4 小时
  "allowTest": true                  // 仅固定宿主测试消息；普通 CLI --test 不是来源证明
}
```

### 3.2 行为

- 只有 §2.4 的策略交集允许时才 `needsApproval=false`，其余闸门全保留（dev_id、配额、分享策略、`minGapMinutes`、`maxPerDay`、日志、收据）。
- 自动私信沿 `comment-operations.json` 保存 accepted / rejected / uncertain 和记账结果，`pod-log.jsonl` 写摘要（operationId、to、chars、reason），不把 DM 塞进只支持评论坐标的 `pod-sent.json`。
- 明确拒绝（如未登录/验证码/风控）不自动重试，可保留待处理草稿；暂停本次批次并提示账号状态。超时、断线、无法判断是否发出的结果必须是 `uncertain`，不可退回普通可重发草稿。`accepted` 后本地记账失败也不能再 POST。
- 故障通知优先宿主/状态面板；当 `notify.type=dm` 时不能再次走坏掉的 DM 通道，防止失败通知触发递归发送。
- 提示词（`lib/scheduler.js`）分三句写清：
  - `autoSend=false`：`发之前交草稿，主人点头才发`（0.7 目标，当前分享/测试豁免需一并接线）；
  - `autoSend=true, to=owner` 且 policy 允许：`可以在预算内直接发给主人；一天最多配置的条数，且必须真的有事`；
  - `to` 含 mistress：`给女主人仍要先走草稿，除非 review 那档也放了`。

### 3.3 新增硬要求：分享私信必须带可打开的视频链接

- 推荐/分享视频的 DM 必须包含 `https://www.bilibili.com/video/<BV号>/`，包括给主人、启用的女主人，以及 `via=both` 的 DM。仅一个 BV 号不算满足；普通聊天/固定测试消息不硬塞无关链接，不编造来源。
- 优先使用结构化 `bvid` / `--target`；正文已有对应视频链接时不重复追加。不一致的 BV / 链接应拒绝并让她修正，不能悄悄把 A 视频的话接到 B 链接。
- 先构造最终全文，再做 300 字限制、预览、草稿持久化、指纹、批准和发送。超长时报错，不截断已经批准的文字；预览内容必须等于最终 POST 内容。
- 建议新增 `lib/dm-message.mjs` 的共享纯函数 `buildDmMessage({message,bvid,share})`；`dm.mjs`、`reply-draft.mjs`、宿主批准入口和 both continuation 共用。不在批准之后才补 URL。
- 当前 `claimShareContinuation()` 的 expected 正文是原评论加视频 URL，必须改为调用同一 builder，保留同 BV / 同源 accepted operation / 配额只记一次 / 一次续送 / uncertain 禁重发约束。旧 accepted 原文不可改写；旧草稿若需要补链接，必须重新预览并批准。
- DM 草稿保存 bvid，宿主批准时也要透传；不能只在 `scheduler.js` 的自然语言提示里要求她“记得放链接”。

---

## 4. 收信人：主人 / 女主人（两个选项的显式化）

现状已经能用（`dm --to <mid>` 白名单、女主人独立配额 `dm-mistress.json`），缺的是「让她明确知道今天该找谁、别乱试」：

- `lib/defaults.mjs` 增 `dm.recipients: ["owner"]`（可多选）；`dm.mjs` 的 `--to` 继续白名单校验，未在 `recipients` 里的拒绝（exit 7）。
- 女主人未启用（`mistress.enabled=false` 或 mid 空）→ 提示词里**完全不提**她，设置页显示灰色「未启用（填 mid 后可用）」。
- 多选只表示“允许的候选人”，不自动取消既有“一天锁定一个收信人”。当天第一次发送时原子预留收信人；同时给两位的并发请求只能一位获得当日资格，避免主人/女主人分账绕过全局日锁。
- 主人分享沿用实际 `quota.shareDaily`，女主人沿用 `mistress.shareDaily`；另有普通 DM 账。新增自动 DM 条数不能代替或重复这些分享账，`via=both` 也不得再记一次分享。
- 语气分层写进提示词：主人 = 平等、有话直说；女主人 = 客气、奉承要具体（夸她今天分享的那条视频哪里有意思），但不许承诺钱/线下/账号。

---

## 5. 会话状态迁入工作区（减少越界写入审批）

### 5.1 问题

原计划作者观察到的会话中，写 `~/.bili-ai/*` 和日记涉及 cwd 外路径，触发了 workspace-write 的升级请求；不等于任意会话每写一次都会问。更小的切口是**把运行状态迁入 cwd**，并单独说明仍在外部的人设、凭据与日记路径。

### 5.2 方案

新增 `lib/state-dir.mjs`：

```js
export const STATE_DIR = process.env.BILI_POD_STATE || path.join(WORK_DIR, 'state')
// 示意，不是可直接照抄的完整 manifest：只复制，保留原件，不自动定期删除
const FILES = ['pending-replies.json','comment-operations.json','dm-quota.json','dm-mistress.json',
               'dev_id','pod-sent.json','pod-verify.json','auto-sent.json','replied.json','feedback.json',
               'silence-seen.json','taste-log.jsonl','api-cache.json','api-ban.json']
```

- **凭据 `credentials.json`、`persona.md` 维持原路径**。CLI 本身需要读凭据，不能宣称“她碰不到”；这是同用户进程下的路径约定，不是凭据隔离沙箱。
- 宿主 `lib/store.mjs` 与 CLI `tools/lib/paths.mjs` 共用路径解析，共享模块不反向依赖这两个使用者，避免循环导入；不全局替换 `.bili-ai`。逐项建立状态 manifest，区分配置、凭据、人设、日记、日志与运行状态；现有清单还漏 `quota.json`、`favorites.json`、`liked-videos.json`、`commented-videos.md`、`dm-await-state.json`、`await-state.json`、`selftest-passed.json`、`api-requests.log` 等。`pod-night.json` / `pod-log.jsonl` 在 DSH_HOME，是否迁也要逐项列明；已在 workDir 的文件不能再套一层。
- 迁移不是机械替换：暂停 scheduler / 监听 / 活跃写入并确认没有在途 CLI writer，锁内校验源文件；只对目标不存在的项使用临时文件 + 原子替换，目标存在不覆盖，坏 JSON 明确报错而非当空状态。每项可重入，全部校验后才写迁移完成 marker；中途失败可重跑，原文件不删，`dev_id` 内容保持不变。
- 一旦切到新目录，所有新 host 子进程与 agent shell 都必须读写同一位置，防止两套配额/批准账分叉。仅给宿主 `execFile` 加 env 不够：当前 session create 只有 cwd，不能假设宿主已支持 env 注入；agent 命令也要通过共享解析或明确路径获得一致结果。
- `/status` 显示实际 stateDir、迁移状态/错误。日记沿 §9 保持原路径；因此迁移能减少状态写入审批，不能承诺消除日记/凭据/其他工具审批。

### 5.3 兜底

`/status` 增加 `session{sandboxMode, approvalPolicy}`（读她 session 的 `sandbox/mode`、`approval/policy` 最近事件），设置页状态面板显示：
「她的会话：完全访问 / workspace-write / 未知」。若只有日志最近事件，标明“最近观察到”，不当作当前权限保证；无可靠宿主接口时不编造字段，也不由插件擅自升级权限。

---

## 6. 开销叙事化：按「她在干什么」而不是「她点了什么工具」

### 6.1 现状

`lib/spend.mjs` 已经能按 `工具 · 命令` 归因（`ops_bash · debrief` …）。你要的是人话。

### 6.2 活动分类（固定 8 类，可在 `lib/activity.mjs` 里改表）

| 活动 | 覆盖命令 | 你看到的解释 |
|---|---|---|
| 刷视频 | `feed` `popular` `search` `weekly` `rank` `buzzwords` `covers` | 挑今天看什么 |
| 看视频 / 分析 | 实际命令 `video` `watch-video` `debrief` `subtitles` `comments`；`thread` / `comment-digest` 等只读上下文另行标注 | 读简介、字幕、评论或分析抽帧，不把未执行的观看说成看过 |
| 写日记 / 整理 | `diary` `records` `taste` | 写日记、归档、整理口味 |
| 发私信 | `dm`；DM 草稿按 kind 区分 | 尝试发送/处理私信，不把等待或 rejected 都称已发出 |
| 回评论 | `comment`；评论草稿按 kind 区分 | 处理评论回复；发送成功另看收据 |
| 想事情 | 无工具调用的步（`toolCalls=0`） | 无工具生成/整理的估算分类，不是对真实思考过程的测量 |
| 巡检 / 维护 | `deps` `selftest` `quota` `verify` `ledger` `notify` `extlist` `spend` `night` `watch` `comment-await` `dm-await`；识别到的 `compress` | 体检、监听、记账、复核、上下文整理；`watch` 实际是监听评论 |
| 其他 / 未知 | 其余 | 工具台、文件操作等 |

### 6.3 归因算法

1. 一轮 = `turn/start … turn/end`；一轮里的 `step` 按「本步 `tool/call` 的命令」定活动；一步多工具 → 按调用数平分该步 token。
2. 一步无工具 → 「想事情（无工具生成估算）」。有工具但解析不了则归“其他”，不能补成“思考”。同一步多个命令保留全部，不能沿现有首命令字段只算第一个。
3. 轮内活动占比再摊该轮的 ¥（沿用 `apportionYuan`），明确标成比例估算。缺费用记录显示 null / 未知；真实零与缺数区分，不新造一套计价系统。
4. 输出：**主表按活动**（token、占比、¥、一句人话解释），**附表按工具**（折叠）。

示例输出（今天）：

```
今天（2026-10-22）她一共花了 3.2M tokens ≈ ¥0.84
  看视频/分析   1.9M  59%   debrief 读字幕 + 深读记笔记
  想事情         0.6M  19%   读完之后自己想、写结论
  刷视频         0.4M  12%   挑片
  写日记/整理    0.2M   6%
  发私信         0.1M   3%
  巡检/维护      <0.1M  1%
```

### 6.4 面板

- `SpendPanel` 默认显示活动表 + 每轮列表（点开看该轮的活动拆分）。
- 设置页状态行：`开销：今天 6 轮 · 3.2M tokens ≈ ¥0.84 · 最贵：看视频/分析`。
- `/spend?view=activity|tool`（默认 activity）。

---

## 7. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `lib/policy.mjs` | **新**：纯 `reviewDecision()` + 独立原子额度预留/结算、`quietHours` |
| `lib/state-dir.mjs` | **新**：`STATE_DIR`、`statePath()`、一次性迁移 |
| `lib/dm-message.mjs` | **新**：分享 DM 规范链接与最终正文构造，所有入口共用 |
| `lib/activity.mjs` | **新**：活动表 + `activityOf(cmd)` |
| `lib/defaults.mjs` | `review.policy/autoLimits`、`dm.autoSend/autoSendTo/maxPerDay/minGapMinutes/recipients`；normalize + warns |
| `lib/spend.mjs` | 增 `byActivity`、`reportActivities`、`ACTIVITY` 归因 |
| `lib/scheduler.js` | 提示词跟随有效策略、链接和收信人；实际权限单/运行路径一致。不把 prompt 的 accepted 当执行完成；无可靠完成信号时由 spend 查询时统计，不新增虚构的 round:spend 完成事件 |
| `lib/client.js` | 审核四档 + autoLimits；私信自动发送开关与收件人；待审核「全部批准」；开销活动表；会话权限状态 |
| `lib/index.js` | `/pending/approve {all,scope}`；`/spend?view`；`/status` 增 `review/dm/session` |
| `tools/commands/comment.mjs` `dm.mjs` | 统一审核决策，保留所有硬闸门/一次性 operation / 收据状态；DM 使用最终正文 |
| `tools/commands/reply-draft.mjs` `lib/comment-state.mjs` | DM bvid 与最终正文、both 同源续送、草稿/批准一致性 |
| `lib/store.mjs` `tools/lib/paths.mjs` 及状态写入者 | 共用 `statePath()`；按 manifest 审核迁移，不触碰凭据/人设/日记路径 |
| `docs/` | 本文件 + README「审批」章节重写 + CHANGELOG 0.7.0 |

---

## 8. 实施顺序（一次性发布 0.7.0）

1. **P0 契约先行**：先冻结 §2.4 决策矩阵、新旧配置迁移与 §3.3 链接正文契约；分别写能失败的测试，再实现纯 policy / dm-message，不先改真实发送行为。
2. **P1 审核与 DM 接线**：CLI + 草稿 + host approve + both + 有界额度预留/结算 + UI/提示词。跑现有 `features` / `send-contract` / `dm-review-continuation` / `mistress` / `settings-login` 及新增专项。
3. **P2 状态迁移**：在 P0 新状态路径实际启用前完成 manifest、统一解析和可重入复制；临时目录中测断点恢复，防两套账。不是批量替换 `.bili-ai`。
4. **P3 批量批准**：冻结 ID 快照、逐条 claim / 单次签发 / 独立结果；先不实现永久白名单或临时全自动策略。
5. **P4 开销叙事化**：增量扩现有 spend 解析与兼容输出，再接活动视图；未知/估算明确标注。
6. 每步先记录真实 RED → GREEN；最后按当时 package 脚本跑完整 `npm test`，报告实际数量，不预定“178+12”。新增 test 文件须登记到显式文件列表。UI 验收要实际交互、刷新持久化、空/错/部分失败状态，关键词命中和 console.error=0 不足以证明可用。
7. 更新 README / CHANGELOG，输出改动、验证及未验证项；独立分支交付后，安装/重启/权限修改另按用户明确安排，不将这些当成本计划已获授权步骤。

---

## 9. 我替你定的默认值（你只要否掉哪条，说一声）

| 决策 | 我选的默认 | 理由 |
|---|---|---|
| 默认审核档 | 新安装建议 `auto-owner`；旧配置保留 ask/off 意图 | 降噪不等于静默放宽老用户；仍需按 §2.4 与 DM 开关取交集 |
| 私信自动发送 | **默认关** | 「主动找人说事」风险最高；你开了才开，开关旁边写清后果 |
| 自动发送上限 | 12 条/天、同一人 1 条、静音时段 00:30–08:30 | 有护栏的自动才敢默认开给 owner |
| 状态目录 | `<workDir>/state`（默认 `~/.dsh/pod-work/state`） | 减少越界状态写入；含配额/批准/收据，不能当缓存随意删除重置 |
| 日记目录 | **保持 `~/.dsh/pod-diary`**（不搬） | 保留可访问路径；越界授权需求单独说明，不自动升级完全权限 |
| 女主人默认 | 未启用，两道配额（1/天、独立文件） | 现状态，符合你说的「先不发她那轮」 |
| 开销口径 | token 为主、¥ 为辅（标注「摊出来的」） | 与现有 0.6.1 口径一致 |

这些是待实施设计，不是已开通的权限。是否给 DSH 会话完全访问单独决定；本轮只完善计划，不修改会话权限。保持日记旧路径时仍可能需要宿主授权，不能以插件审核关闭代替宿主权限。

---

## 10. 对照当前 GitHub 框架的实施与测试建议

### 10.1 不另造发送系统，接现有 operation 状态机

当前 0.6.3 已有 `coordinates / issueApproval / checkApproval / beginSend / finishSend`、`claimDraft / settleDraft` 与 both 的 `claimShareContinuation`。复用这些接口，不再引入“传 --reviewed 就放行”的第二条通道。

建议发送链：

`解析角色/视频 → 构造最终正文 → 校验长度与发送资格 → 纯 policy 决策 → 人工一次性批准或自动额度预留 → beginSend → 单次 POST → finishSend → 幂等结算`

- DM 的指纹当前绑定 `kind / to / message`；链接必须已在 message 内。评论的旧 fingerprint 结构不要顺手改坏。
- `lib/index.js` 当前批准 DM 只传 to/msg/approval/operation-id；新增 bvid 等必要上下文要保存、透传并校验，不能信任请求传来的收信人角色。若扩展分享草稿，reason/score/share/sourceOperationId 等发送所需信息也要端到端绑定，不能批准一种消息却按另一条车道发出。
- 当前 `dm.mjs` 的 `!SHARE && !TEST` 免审判断须由有效策略接管。`notify.mjs --test` 也能从普通 CLI 调起，布尔 flag 不能证明来自宿主；固定测试消息可复用现有一次性批准，或限定在宿主入口构造。任意 `--test --msg 自由文本` 不得成为万能免审口令。
- `minGapMinutes` / 当天配额是代码闸门，不靠 prompt 自觉；评分仍是已有分享策略，不用一个新自报分数替代批准。
- 评论 `recipientRole` 必须来自实际 root/parent 作者查询，不能从正文里的 @ 或 CLI 声明推断。当前作者查询部分依赖 once/check 分支；即使关闭 once-per-person，新 policy 也必须独立核实目标，查不到时不自动认作主人。

### 10.2 私信链接的最小回归矩阵

扩展现有 `tests/dm-review-continuation.test.mjs` 及其 fake-fetch worker，新增纯函数测试 `tests/dm-message.test.mjs`：

| 场景 | 必须断言 |
|---|---|
| 分享正文只有文字 + 结构化 BV | 预览/草稿/批准指纹/最终 POST 都带同一规范 URL，只有一次 |
| 已含同一视频 URL；重复调用 builder | 不重复；输出幂等 |
| 正文 URL 与 bvid 不一致、缺 BV、非法 BV | 在请求前拒绝，不发错链接 |
| 最终全文超过 300 字 | 不发送、不截断批准文本 |
| 先批准再改链接、正文或收信人 | 凭据失效，不能 POST |
| owner / 启用 mistress / both | 三条路径都检查实际 POST 正文，不只检查提示词含“链接” |
| both 源已 accepted、并发续送、uncertain | 同源/同 BV/最终 DM 一致；至多一次续送，分享账一次，不重试未知结果 |
| 普通聊天、固定测试消息 | 不强加无关视频链接；测试 flag 不绕过自由文本审核 |

### 10.3 自动预算和并发：先预留，后联网，再结算

复用 `lib/file-state.mjs` 的 `withFileLock(file, fn)` 与 `atomicJson(file, value)`。锁内按 operationId 检查并预留全局自动量、单人量、DM 当天收信人/条数/间隔；网络在锁外，返回后锁内结算。现有 JSON 锁不是跨文件事务，因此统一预留必须有可恢复状态和幂等关联，不能声称几个独立 JSON 天然原子。

- `accepted` 占用；`uncertain` 也占用并禁止重发；明确 `rejected` 可释放。崩溃后遗留 sending 不能当未发送自动放回额度，否则可能超发。
- `via=both` 是一份分享、两条真实消息：分享 quota 只记一次，自动条数按实际 comment / DM 各一次，DM 日限额按一条。默认同一人每天 1 条自动量时，不得偷偷放过第二条；第二条转待审，或由用户显式调高上限。
- 人工批准不计自动额度，但原平台/收信人/分享硬闸门照旧。不要让 partial accounting failure 触发再次发送。
- 新增 `tests/review-policy.test.mjs` / `tests/auto-send.test.mjs`：覆盖四档 × owner/mistress/陌生人 × dm.autoSend 开关、缺/错配置、静音跨午夜边界；两进程争最后一格、两收信人争日锁、重放同 operationId、accepted 后记账失败、超时未知、明确拒绝释放。真实发送命令 + 假 fetch 断言 POST 次数，不能只测纯函数。

### 10.4 迁移与批量批准的行为测试

- `tests/state-dir.test.mjs` 用临时 HOME / USERPROFILE / DSH_HOME / WORK / DIARY / CONFIG，所有环境变量在 import 前设定，未知网络一律拒绝；不碰真实 `~/.bili-ai` 或现有日记。
- 迁移覆盖：首次/重复运行、目标已有文件、坏 JSON、复制一半中断后恢复、源不变、dev_id 不变、旧 writer 未退出时拒绝切换；凭据/人设/日记路径维持原状。
- 宿主 child process 与 agent cwd 下启动的真实 CLI 分别读取同一测试状态，证明路径一致，而不是只测 `statePath()` 返回字符串。
- 在现有 host/settings 测试中覆盖：旧配置导入后反复 read / 局部 save 仍保留 ask/off；新默认不泄漏到旧配置。
- 批量批准冻结点击时的 pending ID 快照，逐项 `claimDraft → issueApproval → 发送 → settleDraft`；返回每项 accepted/rejected/uncertain/skipped。中途新来的草稿不加入本次授权；并发两次点击同 ID 至多发送一次。遇验证/风控/unknown 停止余队，不把已 accepted 项重新 pending。`scope=round` 必须按真实 roundId 筛选，缺 roundId 不扩大成 all。

### 10.5 spend 增量扩展，而不是重写计费器

- 在现有 `lib/spend.mjs` 的 `buildRounds / summarize / report` 上增加 `byActivity`，保留 `usage / byTool / byKind / byCmd / topRounds` 等旧 JSON 字段与缓存行为；CLI、`/spend` 与 SpendPanel 使用同一结果。
- `activityOf` 对照真实 `tools/bili.mjs` 分派：`video` 不是 `video-content`；`watch-video` 才是抽帧；`watch` 是监听评论；`dm-await` / `comment-await` 是等待，不算已发送；`danmaku` 分读/发子动作，不全部称看视频。
- 当前解析只留一次 tool call 的首个 bili 命令，新活动归因须保留全部识别命令；单 shell 多条命令、多工具同 step 分摊后 token 总量守恒，未知工具留其他，不新增 shell 执行或复杂依赖。
- 扩 `tests/spend.test.mjs` 的假 zstd 多帧 fixtures：同 step 两活动、同一活动多个调用、无工具、未知/非 bili、混合 shell 命令、旧字段兼容、截断尾帧/缓存刷新；活动 token 之和等于原口径 total，费用按比例估算且不重复计入缓存 token。
- 日期沿当前轮起始时间归属口径，不顺手改跨午夜报表算法。缺 ¥ 记录为 unknown/null，真实零保留零；没有可靠执行完成事件时查询时算，`prompt.accepted` 不触发“本轮已完成花费”。

### 10.6 交付门槛

1. 小步提交：契约/链接 → 审核与 DM → 路径迁移 → 批量 → spend/UI；每步附行为红绿证据，不先改实现再补“看起来覆盖”的断言。
2. 不增加 Python / MCP / 后台服务或新依赖；沿当前 Node ESM、真实 CLI worker、fake fetch 和原生设置面板。
3. `package.json` 当前 `scripts.test` 显式枚举文件，新增测试要纳入；最终跑 `npm test`、所有改动 JS/MJS 的 `node --check`、`git diff --check`。报告命令、实际数量及失败/未验证项，不把已有提交说明的 178/178 当本轮实测。
4. UI 至少实际操作：切策略与 DM 开关、保存/刷新、批量部分成功、链接预览、迁移错误、开销空数据/unknown。可用现有 harness 辅助，不以关键词匹配替代功能验收。
5. 最终说明哪些是离线验证、哪些尚待真实宿主/平台验证；本计划不要求为了测试向真人多发消息，不在写文档阶段跑真实 selftest、改凭据或重启安装。

---

## 实施记录（2026-10-22 实做）

| 计划项 | 状态 | 落地位置 / 说明 |
|---|---|---|
| §2 审核四档 | ✅ | `lib/policy.mjs`（`reviewDecision`）、`tools/commands/comment.mjs` / `dm.mjs` 接线、设置页下拉（`lib/client.js` FIELDS） |
| 旧配置迁移 | ✅ | `policyOf()`：旧 `preReview=false → off`，其余 → `auto-quiet`（主人指定第三档） |
| §3 私信自动发送 | ✅ | `dm.autoSend` + `dm.autoSendTo` + `state/auto-sent.json` 额度闸；设置页「私信自动发送」「自动发给谁」 |
| 分享型私信必须带链接 | ✅ | `lib/dm-message.mjs`；构造/指纹/发送/记账同一段正文，超 300 报错不截断 |
| §4 收件人（主人/女主人） | ✅ | `dm --to` 白名单 + 女主人独立配额（`dm-mistress.json`，迁移后在 state） |
| §5 状态目录 | ✅ | `lib/state-dir.mjs`；23 个状态文件首次启动从 `~/.bili-ai` 复制（不删旧文件、不搬凭据/人设）；测试见 `tests/policy.test.mjs` |
| §6 批量批准 | ✅（限评论类） | `POST /pending/approve-many` + 设置页「全部批准」；私信草稿与 uncertain 不自动批（与计划一致） |
| §6 开销活动化 | ✅ | `lib/spend.mjs` 的 `activityOf` / `byActivity`；状态行与 `spend` 输出改主视角 |
| §8「现在叫她起来」 | ✅（计划外增补） | `POST /wake-now` + `wakeNow()`；人工动作不走计划时间，但算当天一次 |
| §2 短窗口 | ✅（计划外修） | `night-plan.mjs`：<5 分钟的窗口忽略最小间隔且不掷 skip —— 设了窗口一定醒（主人 18:00–18:01 的 bug） |

### 与计划的偏离（需要主人知道）
1. **`quietHours` 默认空**（计划里是 `23:30–08:30`）。原因：低价时段生物钟会在 00:30–08:30 醒来，硬静音会把那几轮自动消息全转草稿，等于半夜设了等于没设。想要的话在设置里填 `23:30–08:30` 即可。
2. **`--reviewed` 不跳档位**：它只是注记；真正的通行证是绑定坐标与正文的 approval token。计划 §2.2 的「手动改档」没有做，靠档位下拉即可。
3. **分享型评论/私信不走进审核档**：由 share 闸（理由/评分/配额/七天去重）把关，仍可 --reason 复核；这是主人「分享不必每次问」的直接结果。
4. **女主人沿用 family 规则**：`auto-owner`/`auto-quiet` 下她与主人同属「自家人」；权限低一档靠 `dm.autoSendTo` 是否包含她来收。
