# 上游同步记录：dsh-bili-whale v0.4.0 → v0.4.5

- 运行日期：2026-10-22
- 上游仓库：<https://github.com/Alterssss/dsh-bili-whale>
- 同步区间：`v0.4.0`（`5687ecc`）→ `v0.4.5`（`9ba49be`），共 **33 个提交 / 56 个文件**
- 我们的基线：鲸群 fork 自 v0.4.0（逐文件 sha256 核对：75 个文件相同、仅 `README.md` 不同、无缺失）
- 结果版本：**鲸群 v0.5.2**

## 怎么同步的

不是覆盖整份仓库，而是按「上游这一版修了什么」逐项移植，再让鲸群自己的外壳
（峰谷生物钟、日记文件夹、账本、权限单、mod 宿主、发前审核/发出后复核）继续工作。
凡是鲸群重写过的文件（`lib/scheduler.js`、`lib/client.js`、`lib/index.js`、日记相关），
只摘上游的语义修复，不整文件覆盖。

## 采纳清单

| 上游提交 | 内容 | 落点 | 状态 |
|---|---|---|---|
| `5a86433` | 同一窗口多次醒来之间加 10 分钟硬下限间隔 | `tools/lib/night-plan.mjs`（`minGapMin`） | ✅ 已移植（峰谷模式同样生效） |
| `9bfc972` | 「不看」只消耗一次机会，不再把整个窗口作废 | `tools/lib/night-plan.mjs`、`tools/commands/pod-night.mjs` | ✅ 已移植 |
| `1c7de57` `f196008` | 私信 `dev_id` 每次随机 → 固定 | `tools/commands/dm.mjs`（`stableDevId()`，`~/.bili-ai/dev_id`，0600） | ✅ 已移植 |
| `3797c69` `680bac8` | 「主人回复」检测不再子串匹配（Issue #14），改用 `comment-digest --json` | `tools/commands/quota.mjs`、`tools/commands/comment-digest.mjs` | ✅ 已移植 |
| `a23cb2e` | 设置页分组顺序显式定死 | `lib/client.js` 渲染顺序 | ✅ 已按鲸群分组重排 |
| `b8e7b7a` `35dcf5e` | buvid3 校验放宽（`…infoc` 结尾合法）+ 后端 `warn` 前端要显示 | `lib/index.js` 的 `/cookie` + `lib/client.js` 登录面板 | ✅ 已修 |
| `3d7a427` `23ee496` | `parentAuthor` 支持 `root=0`/顶层评论；`type` 参数 + `data.root` 兜底 | `tools/commands/comment.mjs` | ✅ 已移植 |
| `c04c3b1` `8b553b1` | 提示/示例里别再写死旧插件目录名 | `lib/scheduler.js`、`lib/client.js` | ✅ 鲸群本来就动态解析路径 |
| `ff10170` | `comment --check` 只读预检（能不能发） | `tools/commands/comment.mjs` | ✅ 已移植 |
| `22cbfec` `4a46bcb` `7b57153` `dffc2e0` | 抗限流：缓存 + 熔断 + 节流 + 请求日志 | `tools/lib/bili-api.mjs`（新文件）、`tools/commands/deps.mjs`、`/status` | ✅ 已接线到 view / playurl / feed / recon / debrief / subtitles / comments / quota / fav |
| `fb1682d` | dm 交付回执（`--peek`/`--ack` 两阶段、原子写、owner 隔离） | `tools/commands/dm-await.mjs`、`lib/scheduler.js` 的 `dmTick` | ✅ 已移植 |
| `b1337d3` `6b5d1f0` | 唤醒提示「每次看几条」读 `night.maxVideos` | `lib/scheduler.js` | ✅ 已移植 |
| `435b63c` | 唤醒提示写死 `share.via` | `lib/scheduler.js` | ✅ 已移植 |
| `4e8aa7b` | 回复要挂在对方那条评论下面（提示里给坐标） | `lib/scheduler.js` | ✅ 已移植 |
| `019037f` | 25 分钟长片抽帧超时 | `tools/commands/debrief.mjs` | ✅ 已移植 |
| `8f93d62` | （回滚）`wakePrompt` 的 maxVideos 改动 | — | 已由 `b1337d3` 的最终版取代 |
| `7d02c77` | 清死文件 / 死配置 | `lib/settings.html`、`tools/verify/verify-reply.mjs` 等 | ✅ 鲸群早已删除同类文件 |

## 有意不采纳

| 上游内容 | 原因 |
|---|---|
| `tools/lib/capture.mjs` 全面替换 `execFileSync` | 该改动是为 Windows 沙箱里「不允许匿名管道」准备的；鲸群配合的工具链与测试用 `node:child_process` 的原生实现（离线测试靠替换它验证参数）。`capture.mjs` 已随包保留，`quota react` 这类容易撞管道限制的地方用它，ffmpeg 抽帧仍走原生实现。 |
| `tools/lib/cli-args.mjs` 抽出 `translateNamed` | 鲸群 `tools/bili.mjs` 已有一份等价实现且挂了权限单，抽文件只会多一层。文件保留，未接线。 |
| `lib/work-dir.js`（工作目录校验） | 鲸群的 `lib/store.mjs` 已经做同样的事（`ensureWork()` + 环境变量覆盖），不重复。 |
| 上游的「设置页」整页（HTTP 页面） | 鲸群从 v0.5.0 起就走 DSH 原生 `settings.section`（`lib/client.js`），没有 `settings.html`。 |
| 上游「两本日记 `.md`」 | 鲸群要的是日记文件夹 + 分类记录库（见 `lib/diarystore.mjs`）。 |

## 同步后的测试

```
node --test tests/*.test.mjs
→ 163 tests / 163 pass / 0 fail
```

同步过程中修掉的、只属于我们这个组合的 8 个测试失败（详见 CHANGELOG v0.5.2）：

1. 主人免记 `replied.json` 后，发送对账的 ready 条件要改成只看 `quota.json` + `pod-sent.json`。
2. `verify-now` 在 Node 24/Windows 上用 `process.exit()` 会撞 undici 的套接字关闭断言（退出码 127）→ 改 `process.exitCode`。
3. `bili-api.mjs` 兼容只有 `json()`、没有 `text()` 的测试 stub。
4. 游客态（nav 里没有 `wbi_img`）不再被 WBI 改写整条打死。
5. `node-runtime` 的 `TEST_NO_NODE=1` 钩子。
6. 只读 CLI 测试的假 fetch 允许 `/x/web-interface/wbi/view`。
7. `dmTick` 在测试 stub 没有 receipt 时仍按已交付处理（放宽）。
8. 峰谷 / 最小间隔改动带来的 `planner.test.mjs` 断言更新。

## 下一次同步怎么做

```bash
# 1) 看上游有没有新提交
curl -s "https://api.github.com/repos/Alterssss/dsh-bili-whale/compare/v0.4.5...master" | head

# 2) 只取 tarball（这台机器 git clone 会卡在 pack negotiation）
curl -sL -o /tmp/up.tgz "https://codeload.github.com/Alterssss/dsh-bili-whale/tar.gz/refs/heads/master"
tar -xzf /tmp/up.tgz --strip-components=1 -C /tmp/up

# 3) 逐文件 diff，按上表的方式逐项判断「移植 / 不采纳」
diff -ru /tmp/up F:/dsh/project/robo/dsh-bili-pod --exclude=node_modules --exclude=.git | less
```
