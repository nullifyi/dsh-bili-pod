# 只读差集接口来源（验收用）

2026-10-22 只读核对原 scroll 所依赖的公开发布源码；不是在线接口验收，也不安装 Python 运行时。

- 发布元数据：https://pypi.org/pypi/bilibili-api-python/17.4.1/json
- wheel：https://files.pythonhosted.org/packages/07/50/520f98ef607687d686c9170b3ff2db944152bb0dc43bef0df7b4face8c5b/bilibili_api_python-17.4.1-py3-none-any.whl
- SHA256：`3054b824f0f7ac81917329f19909f39d24fb3b7d9de1672c6dd4cb9fa6e5757d`，已对下载字节核验；ZIP 在内存读取，未安装或写入用户数据。
- 原 GitHub 仓库当前仅关停说明且没有原历史；此处固定已发布版本，不称当前受维护，也不保证服务器仍接受旧协议。
- 参考调用：`F:/dsh/project/robo/dsh-bili-scroll/vendor/bilibili-mcp/mcp_server.py`。实现不得改参考仓。

以下均 GET，主机为 `https://api.bilibili.com`。JSON 定义来自 wheel 的 `bilibili_api/data/api/`；参数名称不凭回忆填写。

| 能力 | 来源键 | 路径 | 来源参数与注意 |
|---|---|---|---|
| 热门视频 | rank.json `info.hot` | `/x/web-interface/popular` | pn、ps、web_location=333.934；定义标 wbi |
| 每周列表 | rank.json `info.weekly_series` | `/x/web-interface/popular/series/list` | web_location=333.934；wbi |
| 指定每周一期 | rank.json `info.weekly_details` | `/x/web-interface/popular/series/one` | number、web_location=333.934；wbi |
| 视频排行 | rank.json `info.v2_ranking` | `/x/web-interface/ranking/v2` | rid、type、web_location=333.934；wbi；原 feed 已有此路由 |
| 热词图鉴 | hot.json `buzzwords` / hot.py `get_hot_buzzwords` | `/x/v2/dm/buzzword/list` | type_id=4、pn、ps；**原函数实际是热词图鉴，不是搜索框热搜** |
| 用户资料 | user.json `info.info` | `/x/space/wbi/acc/info` | mid、w_webid；wbi/wbi2；复用已有 whois，缺 access-id 支持不得虚称完整在线兼容 |
| 用户统计 | user.json `info.upstat` | `/x/space/upstat` | mid |
| 用户关系统计 | user.json `info.relation_stat` | `/x/relation/stat` | vmid |
| 用户投稿 | user.json `info.video` / user.py `User.get_videos` | `/x/space/wbi/arc/search` | mid、ps、tid、pn、keyword、order、order_avoided=true、platform=web、w_webid；wbi/wbi2 |
| 远端收藏夹 | favorite-list.json `info.list_list` | `/x/v3/fav/folder/created/list-all` | up_mid、可选type/rid、web_location=333.1387；fav 已有路由 |
| 收藏内容 | favorite-list.json `info.list_content` | `/x/v3/fav/resource/list` | media_id、pn、ps=20、keyword、order=mtime/view/pubtime、type=0、tid=0、platform=web、web_location=333.1387 |
| 未读数 | session.json `session.unread` | `/x/msgfeed/unread` | verify=true，需要既有凭据；本任务只能假凭据测试 |
| 回复通知 | session.json `session.replies` | `/x/msgfeed/reply` | verify=true；先复用现有 msgfeed/comment-digest |
| @通知 | session.json `session.at` | `/x/msgfeed/at` | verify=true |
| 赞通知 | session.json `session.likes` | `/x/msgfeed/like` | verify=true |

rank.py 的 RankType 视频 rid 映射：all=0、douga=1005、music=1003、dance=1004、game=1008、knowledge=1010、technology=1012、sports=1018、car=1013、life=160、food=1020、animal=1024、fashion=1014、ent=1002、cinephile=1001；Original 定义 type=origin、Rookie 定义 type=rookie。不要把这份排行表当作当前完整上传分区表。RankDayType 的3/7天**只对PGC**有效；本次视频排行不能虚称按天筛选生效。若现有适配不足，清楚拒绝或标未实现，不静默忽略参数。

实现继续复用现有 Node 网络/WBI 与错误处理；只读 CLI 不增对外写入动作。SDK 的 wbi2/access-id 依赖、未知接口变化、风控均是在线边界，不能为了测试绕过或读取真实浏览器凭据。未知 mock 请求必须失败，错误不包装成成功空数组。
