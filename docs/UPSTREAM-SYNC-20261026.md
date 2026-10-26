# 2026-10-26 上游增量同步（鲸群0.9.0）

主参考：Alterssss/dsh-bili-whale，v0.4.5（9ba49be）到当前main 8b0009f8ce2ebdc421afcb2e727b19ac18912ec6（0.4.6），33提交、94文件。
辅助参考：c1overzz/dsh-bili-scroll，本地旧参考4d90553a803f4a644570502484af52975b25aa6d到d75464ba6ac9f4e704364f0d6feb2674b726c818（2.2.1）。

这次保留鲸群自己的原生会话、日记文件夹、审核/续送/账本、女主人、峰谷/低价时段和完整系统身份加载，逐项合入语义；未用上游整页或整份调度器覆盖。

## 主参考增量映射

| 更新 | 实际落点与边界 |
|---|---|
| 跨进程请求间隔/单并发、读写预算、Retry-After、登录/验证码暂停、不确定写操作防重 | tools/lib/traffic.mjs及所有内置网络入口；状态放工作区state。默认1.5s、读600/h与3000/d、写12/h与30/d；普通回信免私信冷却，仍受平台风控与总请求预算。BILI_NO_CACHE不绕过保护。保留播放地址的内容限制-412例外，HTTP412仍暂停。 |
| 冷却等待与评论后私信通知 | 发送前最多等180s，只等已知未发送的冷却；实际派发时再次检查，冷却从实际发送计时；不会因“结果不明”自动重发。 |
| 正常空闲不降速，仅错误退避 | 私信/评论基础60s，连续失败最长15min；空收件箱exit1不算失败；禁用后清理计时，窗口检查不吃掉间隔；无关设置保存不清游标、不强制轮询。 |
| 卡住的prompt永久静默 | 三个投递通道超过15min只告警一次，保持单次投递所有权；不以超时为由解除锁后重复发。 |
| 私信补收与可靠确认 | fetch_session_msgs历史分页，按时间及序号排队，同秒多消息去重；持久peek/ack；稳定requestId固定到原生会话，确认前不轮换。保留主人+女主人及旧seen/keys状态。 |
| 撤回、进程锁、长消息 | 排除撤回与非聊天事件；OS随进程释放的命名管道/本地端口锁；取消500/800字符截断，尾部真正进入prompt后才ack。首次无游标只查最近一页，超过10页停止而不跳过。 |
| 私信互动不计沉默 | 记录实际收到的主人文字/分享卡片原时间，和feedback.last取较新有效时间；本人发出的消息不推进收信游标。 |
| 会话队列、可选消息人设去重/轮换 | lib/session-delivery.mjs；两个开关默认false/0。重启首次与人设换版仍全文。轮换复制模型、权限、Agent模式、日记恢复指引，旧会话保留；不支持完整继承时拒绝轮换。系统身份全文加载不去重。 |
| 分享前疑似AI评论样本检查 | ai-share sample/record，当前模型逐条判断，30%阈值、20条样本/近阈值扩40条、账号隔离缓存6h、提醒去重；默认关，只管主动公开视频分享，both的公开阶段也受检查。不认定作者身份。 |
| 大整数ID | json-exact在通知、楼层、私信历史、API读写结果中保留超安全整数为字符串；动态type17/root0回读和发前只读目标预检。 |
| 动态CSRF/退出码/记账 | 编辑、文字、图片创建的CSRF放正文，按实际查询重签；API拒绝非零退出，成功写账。仍受既有动态授权开关约束。 |
| 扫码与凭据保存 | 既有SVG/终端二维码等价保留，无新qrcode依赖；增加并发轮询合并、验证后原子保存、取消/过期竞态保护、待审草稿禁止跨账号替换、Windows权限保护。 |
| feed/抽帧/路径 | 搜索每词一种排序、10min按账号缓存、切词及候选多样性、真实评论账本排除；--tile 240–1280默认720、长片超时按时长算；deps、notify、selftest和女主人日志跟DSH_HOME。 |
| 深色主题/局域网 | 主按钮前景取配对token；宿主isTrusted允许的LAN可访问，后续requestRejection认证保留；IPv6回环Host修复。 |
| 提示压缩、设置删项与旧日记表格 | 只采用精简的流程要求，保留鲸群特有日记/审核预算与权限；间隔设置在这里实际生效，所以不照搬“无效输入框”删除；文件日记不走旧Markdown表格日期/空列解析。 |
| 直播移除与其revert、工具组移除与revert、at_name_to_mid及撤回 | 按上游最终结果保留直播/工具入口，不重新引入已撤回的提及参数。 |

## 辅助参考增量映射

- 未设关键词时使用账号首页推荐，不自动回退所有人共用的固定词；显式关键词继续搜索。推荐流跳过广告、直播卡，保留偏好排序、去重和随机化。
- 7/8型分享卡片保留标题、链接和完整ID，不冒充普通空文字；女主人通道仍可用。
- 公共评论风格提示接入唤醒/评论监听；用comment-history复用现有成功评论收据看最近记录，不再添一份平行账本。私信人格仍以当前完整人设为准。
- 新增cover/frames轻量看图，使用公开封面/故事板，index空时pvdata兜底与一次重试；不用下载整片。图片CDN不带Cookie。原生read_image读取输出图片，返回路径不等于已经看过。
- 临时预览必须显式--transient，放工作区vision-cache，标明临时；仅下次预览时清理24小时以上且有本工具生成标记的目录。原artifacts开关、旧watch/covers的行为保留。
- want/actual时间、多P仅首P和实际故事板覆盖范围明确输出；不把稀疏帧称为完整观看。竖屏/小字仍可能读不清。
- 跨宿主定时轮OS互斥、子进程停止清理、稳定requestId避免重复投递；保留本机原生单轮诊断。

以下不是当前架构缺失的同类流程，不移植其实现：Python/uv/venv安装器、独立headless duty profile、向共享Python MCP增加ASR后台job和25秒直接调用上限。鲸群没有这个转写入口，且当前请求已明确存在内存压力；不为一次同步增加转写引擎与模型下载。原生CLI独立子进程不共享该MCP事件循环。参考中已删除的任意投稿能力也不带回。

## 使用

~~~text
node tools/bili.mjs recommend --n 20
node tools/bili.mjs frames BVxxxxxxxxxx --transient --n 3
node tools/bili.mjs frames BVxxxxxxxxxx --transient --at 20,60,100
node tools/bili.mjs cover BVxxxxxxxxxx --transient
node tools/bili.mjs comment-history --days 7 --limit 8
node tools/bili.mjs traffic status
~~~

frames/cover返回的contactSheet/cover路径需再用宿主read_image打开。分享前检查、人设消息去重、会话轮换在设置页可选，安装不会替使用者打开它们。traffic resume/resolve只在人工处理登录/验证码、回读确认发送结果后执行；不能用来跳过平台等待。

## 验证

完整回归291项全部通过；96个变更JS/MJS通过语法检查，差异空白检查通过。过程证据和真实只读请求的结果保存在本次本机交付报告。用真实账号读取了首页推荐；对BV13xnt6QE6s取得31/61/91秒三帧、首P覆盖121/126秒，并打开图片核验。未用测试向B站发消息，也未进行真实动态发布或重新扫码；这两类发送/账户写入验证采用隔离假服务及真实CLI进程。

## 来源

- https://github.com/Alterssss/dsh-bili-whale/commit/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6
- https://github.com/c1overzz/dsh-bili-scroll/commit/d75464ba6ac9f4e704364f0d6feb2674b726c818
- 两项目原MIT署名与许可证保留；新增单元测试基于其公开回归样本，测试文件以upstream-标识并适配鲸群契约。
