# DSH Bili Pod 验收修复计划

依据：F:/codex/projects/dsh-bili-whale-review-20261022.md 的17项要求；基线 aefd53718751453f618aeed1c91ecf9509b8edbf。

## Global Constraints

- 只在 F:/codex/projects/dsh-bili-pod-review 的 codex/acceptance-fixes-20261022 分支修改。原安装直接链接原仓，不修改原仓工作树、main 或真实用户数据。
- 不读取凭据或 .token；所有测试仅使用临时目录与明确模拟的网络边界，不真实发送。
- 必要修复用 TDD，先记录真实失败再最小修改；保留数据、现有合法分类与命令兼容性。
- 不删除/重建 GitHub 仓库，不伪造 fork 血缘。不把离线证据说成真实宿主验收。
- 交付独立分支、17项矩阵、能力差异和未解决项；没有完成验收不取消调度。

### Task 1: 日记路径与归档失败恢复

目标：针对实际日记/records命令可达的路径穿越与归档信息丢失修复，不重造存储框架。

范围：lib/diarystore.mjs、必要命令调用处、tests/features.test.mjs 或新的自动运行测试文件。

1. 先写并运行行为测试：kind含 ../ 或反斜杠、day含路径/非法日期须拒绝，不能越出日记目录；INDEX分类不能覆盖总索引。保留中文/英文正常扩展分类。
2. 复现 appendRecord 记录写入失败后重试被entryKeys误判已记入。修复顺序与去重：数据写成功才能提交状态；状态写入失败后重试也不能重复条目。可使用记录内稳定去重标记，兼容既有记录。
3. 验证归档在写入/状态更新失败后重试仍保留全部原文和记录；已有archive时不能静默丢弃新daily片段；仅owner日记也应能归档。
4. 最小修复共享存储层；覆盖跨日/重复归档/失败重试。不要添加无关加密、DB、通用事务框架。
5. 运行针对测试和全部38项原有测试，node --check，git diff --check；提交。报告RED/GREEN命令和结果。

### Task 2: 审核、发送结果、复核与账本一致性

证据：.superpowers/sdd/acceptance-plan-20261022/audit-send-report.md 与该报告链接的全离线探针。范围为实际 comment CLI、pending approval 路由、sent/verify/scheduler、ledger 及针对测试。

1. 真实 CLI 行为红测：data.root 提供 root===parent 的作者时须正确识别；缺 parent 但有 root 不能逃掉默认审核；普通 CLI 自加 --reviewed 不能充当已获宿主批准。采用宿主签发的一次性、绑定 oid/type/root/parent/message 的批准凭据，重复/改文案不得复用；不要把这个本地同权限机制称作恶意 agent 的安全沙箱。preReview=false 仍按现有用户配置允许发送；默认打开。明确 normalize root/parent，兼容原命令。
2. POST 已成功后先持久记录结果、配额/去重，再可选读回复复核。复核失败/卡住不能把成功变失败，不能重新放回待发送；host timeout 看到可靠 code=0/rpid 结果仍应视为已发送。发送结果不明不能自动重排再发，保留可读 uncertain 状态供人工核对，而非伪称成功。纯离线测试必须通过真实 comment 模块，不可整体 mock 掩盖调用契约。
3. 复核记录并保留 type、rpid 字符串精度；type=11 动态评论用对应类型；首次未找到或网络错误后按 verifyRounds/verifyIntervalSec 重试，达到上限明确标为未确认，不说“未发”。网络有有限超时。写回复核结果时重新读取/合并当前发送集合，不能覆盖并发新增记录。本人登录观察不得命名为所有人公开可见；可用无登录查询核实公开观察，明确查询范围/分页不能证明删除。
4. ledger 索引写失败后重试不产生第二份同轮账；稳定 operation/round id 幂等，与现有 CLI/调用者接通。不重造数据库、不自动删除旧账、不泛化安全框架。
5. 离线 TDD、全 npm test、语法与diff检查；提交自己的代码/tests，写task-2-report.md，包含准确 RED/GREEN 和剩余边界。

补充已复现配置隔离：normalizeConfig({}).config.review 与 DEFAULTS.review 是同一个对象；修改前者 preReview=false 后新缺省配置也变false（离线 import 输出 defaultReview:false,nextReview:false,sameReview:true）。深拷贝默认嵌套对象/数组以保留默认审核 true；加行为回归，不扩大成通用schema框架。审核不保留未获用户授权的“主人免审”例外；回复均按同一默认开关处理。

### Task 3: agent路径、扩展生命周期、默认产出与峰谷

证据：.superpowers/sdd/acceptance-plan-20261022/audit-runtime-report.md。范围 lib/index.js、scheduler/store/extensions/scope/tide、实际 debrief/watch 与 CLI 扩展分发，必要测试。

1. 默认 pod-work cwd 中提示使用可执行的绝对 CLI 路径和真实 diary/records 路径；不要写错根目录，不把旧归档原文自动读回。人设+记录内容或明确可达路径实际进入 agent 上下文。保留专用小工作区和 sessionController，不搬回用户主目录、不新增 headless runner。
2. mod 总开关和单项 toggle 真实 reload：禁用移除事件/prompt/routes/commands，启用 setup；setup 返回 disposer 在禁用/重载/卸载时运行；失败/超时 setup 不残留注册。prompt 回调异常只记录该扩展错误，不阻断唤醒。已声明11事件要在真实契约位置触发，或删除不真实的承诺并记录合理未支持原因，不能空接口冒充。
3. pod.command 在实际 CLI 可执行，仅本地已启用扩展命令，内置命令不可劫持，参数交接清晰；不要持久任意脚本执行接口或伪称是 MCP server。启动/异步 setup 期间卸载后不得启动 scheduler；stop 后已开始的网络读取返回也不得再投递会话。
4. artifacts.enabled=false 必须覆盖自动 debrief/watch 的封面、字幕、抽帧、视频等持久写出。允许按需要做内存只读摘要；必要临时文件有限且 finally 清理，不写额外产出物、不删除既有用户文件；true 保留现有能力。日记与账本是明确需求，不因此禁掉。测试真实命令写盘而非仅检查默认值。
5. share.via=dm 在显式启用分享且主人/互粉校验通过时权限可执行，不放宽陌生人 DM 红线。scope 不能将过期自动轮当作手动轮放行写操作；自动轮写scope失败不能继续投递并退化成不受限，应用隔离失败回归。明确这只是命令策略不是系统沙箱。峰谷正确保留跨午夜谷/峰；监听时窗消费 applyTide 同一配置。fixed 默认和关闭能力保持。
6. 已只读核对已安装 DSH 2.0.19-next 的 app.asar 内 dsh-api-session-controller：prompt 返回 accepted 是接收确认，不是 agent 本轮完成；create 返回实际 sessionId，指定已有非空 session 可能改建新会话。实现和回归须遵循原生契约，不吞真实创建失败、不把投递完成冒称工作完成；事件文档区分接收与实际完成，缺乏可靠完成来源时明确未支持，不自己发明宿主 API。保持可复用会话意图并尊重实际返回身份。
7. TDD，离线模拟会话与网络、临时目录，全部测试/语法/diff检查并提交，task-3-report.md 精确记录证据。

### Task 4: 扫码生命周期与轻量运行设置

先读本任务正文，不必读取其他任务历史。全局约束同上：仅隔离分支；fake HOME/USERPROFILE/DSH_HOME 和阻断未匹配网络；不得真实登录、发送、改安装、读凭据/.token；使用现有 Node/原生设置，不新框架。TDD、提交自己的生产/tests/docs，不带 controller 的计划文件；完整报告 task-4-report.md。

1. 扫码使用真实 host 路由与假网络覆盖 waiting/scanned/expired/成功。增加取消操作；只允许当前有效会话提交凭据。重新生成、取消、过期、手动保存或卸载后，在途旧 poll/QR 响应均不能覆盖新凭据/新 UI。生成请求本身的乱序也须覆盖。成功凭据可通过现有读取逻辑复用、不回显值。客户端取消/卸载清理计时与在途响应；用行为测试，不只 grep。
2. 原scroll F:/dsh/project/robo/dsh-bili-scroll/index.js 是运行语义参考；不得修改参考仓。补全可直接接入的设置并保持原缺省行为：reportLevel full/brief/off（仅控制可选报告/notify，不禁掉要求的日记/账本）、commentPerRound 0–20、replyPerRound 1–10、replyToComments（只处理直接回复自己评论的通知，不是楼层深度）、share.via comment/dm/both。both 表示公开分享再给主人私信，须沿用原审核/主人互关/现有共享日配额与去重，不能双倍计入同一分享或靠提示绕过代码闸门。若实际已有策略不能安全支持双渠道，先向controller报具体接口冲突，不擅自放开额度或凭空宣称已支持。
3. 每轮数量是沿scroll的agent预算设置，必须实际进入对应 wake/listen prompt；清楚标明它不是进程安全沙箱。零评论必须使自动轮无评论写权限；所有回复继续默认审核。新 replyToComments 过滤必须在实际通知消费路径生效，不能只加UI；保留现有用户设置兼容，缺省不扩大对外行动。
   普通DM回复也用现有pending/宿主批准/一次性状态接线，绑定目标与正文；不得以listen.dm默认关闭代替实际发送闸门，移除prompt的主人免审例外。默认preReview开启时普通非share DM须批准；可选关闭后仍保留主人互关限制。both只允许已accepted且share=true的公开评论operationId的单次主人DM续送，严格同正文、同BV，原配额已提交则不重复入账，uncertain不自动重试，不允许普通reply冒充分享豁免。保持comment既有fingerprint兼容（DM显式kind分支），不得破坏Task2已审接口。
4. search 增加真实 order 选择、参数校验和CLI接线；收藏夹可选 ID 接入现有 fav 的 dry/go 选夹流程，保留默认选择及原发送红线。配置/UI/实际调用一致；不新增投稿/批量发送。
5. 先针对失败测试，再最小实现；覆盖配置保存/缺省/升级、真实CLI请求参数、真实scheduler prompt和通知过滤、取消乱序。运行focused迭代，提交前一次全 npm test、受改JS语法与diff检查。无新增重依赖。报告明确哪些设置仅agent预算、哪些代码强制，真实宿主仍未验证。

### Task 5: 原只读聚合能力差集

以scroll vendor/bilibili-mcp/mcp_server.py原公开函数为参考，补齐可轻量接入现有Node CLI的只读聚合：热门视频、热词图鉴（不是搜索热搜）、每周必看（列表/指定期）、排行、用户信息/投稿、远端收藏夹/内容、未读/回复/@和赞。先盘点现有命令避免重复，CLI有清楚帮助/参数与scope只读注册，错误不能伪成功。相关B站请求route/参数只用本项目现有代码或原依赖的实际API定义为依据，不凭记忆猜；可读公开上游源码，禁止使用真人cookie或发起登录接口验收。

controller已核对原依赖固定发布wheel和SHA256，具体路径/参数与来源见 .superpowers/sdd/acceptance-plan-20261022/readonly-api-sources.md，Task5先读该文件，不必重复下载。原scroll的hot_buzzwords实际是热词图鉴，界面/报告准确命名，不能冒称搜索热搜榜；若搜索热搜未实现，差异中单独说明。原库rank day只对PGC生效，V2分类不要把day当真实有效参数。旧原库/接口定义不代表当前在线可用。

视频分区数据若没有可靠当前来源，不复制过时上传分区表冒充当前数据；明确未支持原因。视频弹幕已有video命令读取则标复用不再造。保留现有JSON/文本惯例，用一个职责清楚模块批量处理同形只读请求，不引入Python/uv/MCP或泛化框架。接口结果只代表模拟协议通过，不能声称在线可用。

本次盘点还发现直接CLI产出绕过：tools/commands/subtitles.mjs:99-104 无条件写字幕json/txt/plain；tools/diagnostics/fetch-covers.mjs:9,18 无条件建目录并写封面。Task5顺手补这两个已确认实际入口的产出开关，沿Task3同一artifacts.enabled：关闭时只返回内存/标准输出文字，不创建产出目录、不请求仅为落盘的封面、不删除既有文件；开启时保留可选写出，测试输出必须临时目录，不能污染repo/真实用户目录。补行为红绿回归，不扩展到日记/账本/凭据等明确需要的状态。核对原bili_crawl对应现有search/comments/video/debrief可组合能力，未有一条批量命令就准确注明组合方式/差异，不拿单视频命令冒称完整批采。

TDD通过真实CLI及假fetch：参数透传、分页/排序、API错误和未知网络阻断；fake用户目录，先红后绿；一次全套/语法/diff检查后提交。报告 task-5-report.md，列每个scroll能力的CLI对应、剩余差异及理由。不要改controller计划或最终验收报告；不新增任何对外写能力/下载/付费/真实账号操作，不派子代理。

本审查分支交付版本定为0.5.1（原安装/基线为0.5.0），更新实际包版本及必要一致性引用，不发布npm/市场、不改真实安装；便于区分将来加载的修复包与原版。最终测试和报告记录精确提交，不以版本号代替SHA。

### Task 6: 能力差集与完整验收交付

核对原始GitHub上游和共同祖先、公开性、准确提交；对照scroll/whale真实代码形成17项矩阵与差异。独立审查本分支，运行相关测试，提交推送独立分支，不合并、不覆盖安装。最终记录修复与未实现/无法验证项，满足完成条件才取消并核实小时调度。

扫码须用假网络覆盖 waiting/scanned/expired、会话取消/旧key不能覆盖新凭据、正确保存字段及复用，不回显值；不申请真人扫码。能力清单逐项补全 reportLevel、commentPerRound/replyPerRound、楼中楼开关、DM both、search order、检查更新以及原清单全部条目。可安全实现的轻量差集补齐；ASR/uv/MCP等明确重依赖或新子系统不自动下载安装，记录边界和理由，不伪称已支持。基座设置实际已是原生section，修正文档错误。第14项已用无凭据公开API读取指定视频简介与前8热评，网页读取失败；未声称完整观看视频。第15项API fork=false、merge-base退出1，保留原仓并记录需后续GitHub仓库操作；不得删仓或伪造提交血缘。

能力盘点必须以scroll实际公开函数为底表：bili_search/comments/subtitle/danmaku/video_info/reply/crawl/send_dynamic/upload_video/upload_video_multi/send_opus/video_zones/hot_videos/hot_buzzwords/weekly_hot/rank/user_info/user_videos/favorite_lists/favorite_content/send_message/unread_messages/received_replies/received_at_and_likes，再核对原README的日报/每日额度/关键词/人设工作区/收藏夹/依赖/更新/运行状态等设置。不要说“30条CLI基本重合”而漏掉原只读聚合或投稿功能；未实现应准确列出具体能力、理由和建议，非实际支持的MCP名字/哈希链不能冒充MCP或防篡改。新对外写入能力与重型子系统不得为填矩阵擅自启用；测试不调用真实接口。

差集应纠正语义错误而非照旧清单实施：scroll replyToComments 的描述为仅直接回复自己所发评论的消息，不能未经核实改成楼层深度开关；DM both 是原配置具体投递语义，需读原代码。whale 设置现已是原生section；本人登录态复核只说明当前观察结果，非所有人公开可见；本地可改写哈希链只是完整性线索，不是防篡改保证；mod HTTP路由/CLI命令不自动成为模型MCP工具。
