# 只读 CLI 与原 scroll 能力对照（0.5.1）

入口为 `node tools/bili.mjs <命令> ...`。新增命令均注册到 scope 的只读集合，自动轮权限单过期或写白名单为空也能读取；没有增加任何对外写操作。它们是本地 Node CLI，不是模型 MCP 工具。

## 参数与输出

以下命令支持 `--help` 与 `--json`。省略 `--json` 时输出中文类别标题及格式化 JSON；使用 `--json` 时 stdout 只含 JSON。远端响应保留 API 的 `data` 结构，不承诺与原 Python 工具的精简 JSON 字段一致。参数不合法退出 2；HTTP、API code、非 JSON 或缺少 data 等失败退出 3，错误写 stderr，不输出成功 JSON。聚合中的任一请求失败会使整个命令失败。

| 命令 | 参数和默认值 |
| --- | --- |
| `popular` | `--pn 1 --ps 20`，热门视频 |
| `buzzwords` | `--pn 1 --ps 20`，热词图鉴；不是搜索框热搜榜 |
| `weekly` | 无期号读期数列表；`--number <正整数>` 读指定期 |
| `rank` | `--type all`；支持 all/original/rookie/douga/music/dance/game/knowledge/technology/sports/car/life/food/animal/fashion/ent/cinephile |
| `user-info <mid>` | 聚合 `{info, upstat, relation}`；可传 `--w-webid <access-id>` |
| `user-videos <mid>` | `--pn 1 --ps 30 --tid 0 --keyword <词> --order pubdate`；order 为 pubdate/click/stow；可传 `--w-webid <access-id>` |
| `fav-remote folders <mid>` | 远端收藏夹列表，必须明确 mid；不会把 `fav --list` 的本地记录当成远端列表 |
| `fav-remote contents <media_id>` | `--pn 1 --ps 20 --keyword <词> --order mtime`；order 为 mtime/view/pubtime |
| `messages [unread\|reply\|at\|like\|all]` | 默认 all，输出按分类命名的对象；每类只读一页，需要已有 SESSDATA，不自动登录 |

分页 pn 从 1 开始，ps 为 1–50；mid/media_id 使用正整数字符串，避免 JS 大整数精度丢失。未知、重复或缺值参数会报错。`rank --day` 明确拒绝：所用 V2 排行接口没有该过滤，原库 day 仅对 PGC 分类生效。消息命令不猜测未核对的翻页参数；已有 `comment-digest --pages N` 可汇总更多回复和 @ 页。

公开类请求不强制已有凭据；若凭据文件存在则沿用它。匿名、登录状态、风控、权限或 access-id 要求仍取决于服务端。`user-info` 与原工具吞掉统计请求错误不同：任一项失败就整体退出，避免将缺失数据伪装成完整统计。

## 协议来源与在线边界

路径和参数依据原 scroll 实际依赖的 `bilibili-api-python 17.4.1` 发布 wheel 定义，已由 controller 核对 SHA256：`3054b824f0f7ac81917329f19909f39d24fb3b7d9de1672c6dd4cb9fa6e5757d`。本次未安装或再下载该依赖。定义索引见 [固定协议来源](reference/bilibili-api-17.4.1-readonly.md)；一手发布元数据为 [PyPI 17.4.1](https://pypi.org/pypi/bilibili-api-python/17.4.1/json)。

新增请求仅 GET `https://api.bilibili.com`：

| 能力 | 路径 | 关键参数 |
| --- | --- | --- |
| 热门 | `/x/web-interface/popular` | pn, ps, web_location=333.934，WBI |
| 热词图鉴 | `/x/v2/dm/buzzword/list` | type_id=4, pn, ps |
| 周榜列表/指定期 | `/x/web-interface/popular/series/list`、`/x/web-interface/popular/series/one` | web_location=333.934，指定期 number，WBI |
| 排行 | `/x/web-interface/ranking/v2` | rid, type, web_location=333.934，WBI；original 为 0/origin，rookie 为 0/rookie |
| 用户资料 | `/x/space/wbi/acc/info` | mid，可传 w_webid，WBI |
| 投稿统计/关系统计 | `/x/space/upstat`、`/x/relation/stat` | 分别 mid、vmid |
| 用户投稿 | `/x/space/wbi/arc/search` | mid, pn, ps, tid, keyword, order, order_avoided=true, platform=web，可传 w_webid，WBI |
| 收藏夹/内容 | `/x/v3/fav/folder/created/list-all`、`/x/v3/fav/resource/list` | 前者 up_mid；后者 media_id,pn,ps,keyword,order,type=0,tid=0,platform=web；均 web_location=333.1387 |
| 消息 | `/x/msgfeed/unread`、`/x/msgfeed/reply`、`/x/msgfeed/at`、`/x/msgfeed/like` | 已有登录凭据 |

WBI 复用现有 search 的签名算法与 nav 签名材料，只提取成共享函数，不重写搜索行为。原 user 接口同时标记 wbi2；本实现只支持显式透传 w_webid，没有自动获取 access-id 或新 WBI2 流程。本地假 fetch 只验证路由、参数、错误传播、权限分派与落盘行为；未连接真实 B 站、真实账号或 DSH，不能据此声称在线可用。

## 原公开函数逐项对照

原 `vendor/bilibili-mcp/mcp_server.py` 公开 `bili_` 函数准确计数是 **27 个：3 个登录 + 24 个业务**。CLI 数量、组合命令数量与公开函数数量不能互相替代；下表是逐项能力对照，不是全量等价声明。既有写命令只列映射，本次没有新增写能力，也没有执行任何真实发送。

| 原公开函数 | 本项目入口 | 差异/边界 |
| --- | --- | --- |
| `bili_login` | `login` / 设置页扫码 | 已有 Node 二维码与轮询流程；不是原 MCP 二阶段工具 |
| `bili_login_check` | `login` 内部轮询 | 没有单独公开同名 check CLI |
| `bili_check_credential` | `session`、`login status` | 已有凭据与登录态检查，输出不同 |
| `bili_search` | `search <关键词> [页码] --order totalrank\|click\|pubdate\|dm` | 已有真实排序参数与校验；文本/schema 不同 |
| `bili_comments` | `comments <BV> --pn N --ps N --sort hot\|time --json` | 已有读取；分页/输出不同 |
| `bili_subtitle` | `subtitles <BV> [--lan ...]` | 官方字幕；没有 ASR；产出开关见下节 |
| `bili_danmaku` | `video <BV>` | 复用已有 XML 视频弹幕读取，文本预览前 20 条；不是任意条数的独立原 JSON 弹幕工具；`danmaku` CLI 是直播弹幕，不能混同 |
| `bili_video_info` | `video <BV>`、`covers <BV>` | 元信息及统计已有，输出不同，并伴随各自其他读取 |
| `bili_reply` | `comment --root/--parent ... --dry\|--go` | 已有受审核、权限和额度约束的评论发送；本次未改写能力 |
| `bili_crawl` | 组合 `search` → 对选中 BV 分别 `comments` + `subtitles`；单视频也可 `video`/`debrief` | **没有单条批采命令**；需调用者循环与汇总。单视频预览/深读不等价于原 max_videos 批量评论与全文字幕 JSON |
| `bili_send_dynamic` | `dynamic post` | 已有受限制动态发送，非原 Python schema |
| `bili_upload_video` | 未支持 | 投稿/上传涉及新写能力及较重依赖，不在本次范围 |
| `bili_upload_video_multi` | 未支持 | 多 P 投稿同上 |
| `bili_send_opus` | `dynamic-image` | 已有图文动态相关写入口，参数与能力不是原 opus 完全等价；未新增原富文本编排 |
| `bili_video_zones` | 未支持 | 原为静态旧上传分区表；没有可靠当前来源，不冒充现行分区 |
| `bili_hot_videos` | `popular` | 新增真实只读入口；返回 API data，不做原精简投影 |
| `bili_hot_buzzwords` | `buzzwords` | 新增热词图鉴；原标签“热搜”不准确，搜索热搜未实现 |
| `bili_weekly_hot` | `weekly` / `weekly --number N` | 省略 number 读列表，未接受原 week=0 参数名 |
| `bili_rank` | `rank --type ...` | 完整覆盖原列出的 V2 分类；拒绝无效 day，返回原始 data |
| `bili_user_info` | `user-info <mid>` | 聚合 info/upstat/relation；任一请求失败整体报错，schema 不同 |
| `bili_user_videos` | `user-videos <mid> ...` | 分页/关键词/pubdate、click、stow；WBI2/access-id 自动获取未支持 |
| `bili_favorite_lists` | `fav-remote folders <mid>` | 必须显式 mid，不提供原 uid=0 从凭据推断自己的快捷语义 |
| `bili_favorite_content` | `fav-remote contents <media_id> ...` | 远端分页/关键词/排序；与本地 fav 记录区分 |
| `bili_send_message` | `dm` | 已有只向配置主人且需互关的受限私信；不等价于原任意 receiver_uid |
| `bili_unread_messages` | `messages unread` | 新增已有凭据的未读读取 |
| `bili_received_replies` | `messages reply`；已有 `comment-digest` | 新增一页原始数据，原也只一页；摘要可按既有 pages 遍历 |
| `bili_received_at_and_likes` | `messages at` + `messages like`，或 `messages all` | all 还包含 unread/reply；返回键为 like，非原 likes；任一请求失败整体退出 |

## 字幕与封面产出开关

两条独立入口沿用配置 `artifacts.enabled`，只有明确 `true` 才落盘：

- 关闭：`subtitles` 将完整字幕打印 stdout（此时 `--print` 不截断）；`covers` 打印元信息与封面 URL，不请求封面图片。不会创建产出目录、写文件或删除已有产物。
- 开启：`subtitles` 写原 JSON、带时间戳 TXT、纯文本 TXT，并保留 `--print N` 预览；`covers` 下载写出 `<BV>.jpg`。默认分别位于 DSH 数据目录 `shots/subs` 与 `shots/covers`，可用 `--out <目录>` 覆盖。开启时与既有字幕行为一样，同名输出可能重写；使用不同输出目录可保留先前导出。

测试仅写临时 fake HOME，并阻断任何未匹配的网络请求；没有改真实安装或创建真实用户产物。
