# 2026-10-27 参考核对与模块化交付

主参考 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，HEAD 8b0009f8ce2ebdc421afcb2e727b19ac18912ec6，仍与本项目0.9.0同步记录相同。辅助参考 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，HEAD 4af98392ee078e02f50a7fd0bf0491033f4675ed，版本2.2.2。

从 [scroll设置界面](https://github.com/c1overzz/dsh-bili-scroll/blob/4af98392ee078e02f50a7fd0bf0491033f4675ed/client.js) 借鉴选项卡、收藏夹下拉、视频记录卡片，在现有 PodHost 上增加四个可独立开关的包，没有替换整份客户端。

2.2.2的[更新记录](https://github.com/c1overzz/dsh-bili-scroll/blob/4af98392ee078e02f50a7fd0bf0491033f4675ed/CHANGELOG.md)主要是Windows SID凭据权限、Python收藏导入、headless回退、日报复核幂等等修复。本项目采用Node凭据/收藏、原生会话与独立复核状态，没有相同实现路径，不能机械照抄或声称这些都作为mod加入。视频日期处理已覆盖短日期、斜线和ISO跨北京时间午夜，未据此改动原有价格策略。

视频足迹读取成功收藏/评论记录并去重，排除明确失败审计行；它不表示完整观看。不新增外部写入。ASR模型下载、投稿、多账号私信、远程mod市场和自动升级不在此次范围。

契约见 [模块说明](../extensions/README.md)。独立审查发现的未保存人设保护、状态目录覆盖、审计状态识别、旧实例事件回调、面板回收均已补回归；实际宿主验证结果写入交付验收记录。
