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
5. share.via=dm 在显式启用分享且主人/互粉校验通过时权限可执行，不放宽陌生人 DM 红线。scope 不能将过期自动轮当作手动轮放行写操作；明确这只是命令策略不是系统沙箱。峰谷正确保留跨午夜谷/峰；监听时窗消费 applyTide 同一配置。fixed 默认和关闭能力保持。
6. TDD，离线模拟会话与网络、临时目录，全部测试/语法/diff检查并提交，task-3-report.md 精确记录证据。

### Task 4: 能力差集、登录回归与完整验收交付

核对原始GitHub上游和共同祖先、公开性、准确提交；对照scroll/whale真实代码形成17项矩阵与差异。独立审查本分支，运行相关测试，提交推送独立分支，不合并、不覆盖安装。最终记录修复与未实现/无法验证项，满足完成条件才取消并核实小时调度。

扫码须用假网络覆盖 waiting/scanned/expired、会话取消/旧key不能覆盖新凭据、正确保存字段及复用，不回显值；不申请真人扫码。能力清单逐项补全 reportLevel、commentPerRound/replyPerRound、楼中楼开关、DM both、search order、检查更新以及原清单全部条目。可安全实现的轻量差集补齐；ASR/uv/MCP等明确重依赖或新子系统不自动下载安装，记录边界和理由，不伪称已支持。基座设置实际已是原生section，修正文档错误。第14项已用无凭据公开API读取指定视频简介与前8热评，网页读取失败；未声称完整观看视频。第15项API fork=false、merge-base退出1，保留原仓并记录需后续GitHub仓库操作；不得删仓或伪造提交血缘。
