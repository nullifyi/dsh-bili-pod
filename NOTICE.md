# NOTICE · 第三方与免责

本项目（`dsh-bili-pod`）自身代码以 **MIT** 许可发布（见 `LICENSE`）。

代码派生自 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（MIT，Copyright (c) 2026 ALTERSSSS），
保留上游及 nullifyi 的现有版权署名；`CHANGELOG.md` 的 v0.5.0 一节记录原交付增量。
2026-10-22 的 GitHub 元数据为 `public`、`fork=false`，没有 parent/source；固定基线与上游参考无共同祖先。
代码派生、版权署名和 GitHub fork 关系是不同事实，不能据此宣称已经「先 fork 再修改」。核对范围见[验收记录](docs/ACCEPTANCE-20261022.md)，本说明不构成完整法律审计。

## 它依赖/参考了这些第三方

| 名称 | 用途 | 许可 / 说明 |
|---|---|---|
| **Bilibili API** | 读取及评论、私信等操作；部分接口需要账号凭据 | 非官方接口调用；不代表所有接口均可匿名访问或已获平台授权 |
| **dsh-bili-scroll** | 扫码登录流程、评论复核措辞、权限白名单思路的参考 | MIT（代码为按接口独立实现，未复制其文件） |
| **qrcode-generator** | 生成登录二维码（`vendor/qrcode.cjs`，vendored） | MIT © Kazuhiko Arase |
| **bilibili-API-collect** | `tools/docs/` 里的接口文档整理自该项目（社区维护的 B 站接口文档） | 遵循其原项目许可；仅作接口说明用，**不随本项目分发**时请以原仓库为准 |
| **ffmpeg** | 抽帧 / 看画面（`tools/lib/ffmpeg.mjs` 只是**定位并调用**它） | **LGPL v2.1+**（若用 GPL 构建则为 GPL）。本项目**不打包** ffmpeg：请自行安装，或使用发布页附带的 LGPL 构建（附其 LICENSE 与源码链接：https://ffmpeg.org）|
| **Node.js** | 运行环境 | MIT |

## 免责

- 本项目是**个人自用工具的公开版**：它用**你自己的账号**在 B 站做评论/回复/发动态等动作，**后果由使用者自负**。
- 不要用于批量刷量、水军、骚扰、绕过风控或任何违反 B 站用户协议的行为。
- 遵循平台规则，撞到风控（验证码 / 限流 / 判刷屏）就该停手，本项目内置了"撞到就停"的护栏。
- 本项目与 B 站、DeepSeek 官方均无隶属关系。
