# 只读聚合接口来源（离线协议参考）

本文件供 Task5 实现和最终差集核对；不是在线接口验收。没有使用真人凭据，没有向下列 B站接口发送请求。

来源：scroll 声明依赖 `bilibili-api-python>=17.4.1,<18`。已读取 PyPI 固定发布 `17.4.1` 的 wheel 源码，不安装 Python/uv/SDK。元数据：<https://pypi.org/pypi/bilibili-api-python/17.4.1/json>。wheel：<https://files.pythonhosted.org/packages/07/50/520f98ef607687d686c9170b3ff2db944152bb0dc43bef0df7b4face8c5b/bilibili_api_python-17.4.1-py3-none-any.whl>。下载字节 SHA256 实测匹配 `3054b824f0f7ac81917329f19909f39d24fb3b7d9de1672c6dd4cb9fa6e5757d`；只在内存解压读取。原 GitHub 仓当前仅关闭声明，不能称该 SDK 当前仍维护。

## wheel 内具体定义

以下均 GET；基址 `https://api.bilibili.com`。数据定义位于 wheel 的 `bilibili_api/data/api/`；方法调用语义同时核对 `bilibili_api/hot.py`、`bilibili_api/rank.py`、`bilibili_api/user.py`。

| 定义 | 路径 | 来源参数 |
| --- | --- | --- |
| rank.json `info.hot` | `/x/web-interface/popular` | pn、ps、web_location=333.934；wbi=true |
| hot.json `buzzwords` | `/x/v2/dm/buzzword/list` | type_id=4、pn、ps |
| rank.json `info.weekly_series` | `/x/web-interface/popular/series/list` | web_location=333.934；wbi=true |
| rank.json `info.weekly_details` | `/x/web-interface/popular/series/one` | number、web_location=333.934；wbi=true |
| rank.json `info.v2_ranking` | `/x/web-interface/ranking/v2` | rid、type=all、web_location=333.934；wbi=true |
| user.json `info.info` | `/x/space/wbi/acc/info` | mid、w_webid；wbi=true、wbi2=true |
| user.json `info.upstat` | `/x/space/upstat` | mid |
| user.json `info.relation_stat` | `/x/relation/stat` | vmid |
| user.json `info.video` | `/x/space/wbi/arc/search` | mid、ps=30、tid=0、pn、keyword、w_webid；wbi=true、wbi2=true |
| favorite-list.json `info.list_list` | `/x/v3/fav/folder/created/list-all` | up_mid、可选type/rid、web_location=333.1387 |
| favorite-list.json `info.list_content` | `/x/v3/fav/resource/list` | media_id、pn、ps=20、keyword、order=mtime/view/pubtime、type=0、tid=0、platform=web、web_location=333.1387 |
| session.json `session.unread` | `/x/msgfeed/unread` | 需登录 |
| session.json `session.replies` | `/x/msgfeed/reply` | 需登录 |
| session.json `session.at` | `/x/msgfeed/at` | 需登录 |
| session.json `session.likes` | `/x/msgfeed/like` | 需登录 |

`user.py User.get_videos` 还传 `order`（VideoOrder）、`order_avoided=True`、`platform=web`，并由 get_access_id 获取 w_webid。当前项目已有 whois/WBI 能力可复用，但不得编造 access_id、绕验证码/风控或把假网络断言称为线上可用。若无法在本轮可靠接通该附加身份，应明确报告协议边界。

## 语义陷阱

- scroll 的 `bili_hot_buzzwords` 调用 `hot.get_hot_buzzwords`；SDK 17.4.1 实际是“热词图鉴”（弹幕热词），不是搜索热搜榜。CLI 帮助和最终差集必须纠正名称，不能擅自猜一个搜索榜路由替代。
- `RankDayType` 的3/7天只对 PGC 排行有效，普通 `/ranking/v2` 不消费 day。不得把普通榜 day 参数声称为已生效。
- `RankType` 中此发布的普通榜 rid：all=0、douga=1005、music=1003、dance=1004、game=1008、knowledge=1010、technology=1012、sports=1018、car=1013、life=160、food=1020、animal=1024、fashion=1014、ent=1002、cinephile=1001；origin/rookie 的 type 值由该枚举给出。但 `get_rank` 本身未透传枚举 type，有源代码缺口，不能复制此错误或假称原实现完全正确。这些是固定历史 SDK 映射，不代表当前投稿分区表。
- 分区表/视频投稿/多P投稿/专用 send_opus 不在只读 Task5 范围。已有 dynamic/image 不能无证据冒充专用 opus 等价。
- 消息接口只读请求不涉及发送；不能在读取函数里新增清未读/批量互动等写行为。

Task5 在提交报告中逐项列 CLI 映射、签名/身份边界、参数/API错误回归及剩余差异；来源只证明请求协议来自原依赖，不证明服务端现状。
