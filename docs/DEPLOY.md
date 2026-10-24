# 搬到另一台电脑：能搬什么、怎么搬、要不要云同步

这份文档回答三个问题：

1. 这个项目能在另一台电脑上**原样部署**吗？
2. 要不要专门做一套**存档方式**？
3. 需不需要坚果云这类**云同步**？

---

## 1. 一句话结论

| 东西 | 能不能搬 | 怎么搬 |
|---|---|---|
| 插件代码 | ✅ 能，而且本来就该这么搬 | `git clone`（或直接拷目录） |
| 配置（作息/口味/审核档/主人信息） | ✅ 能 | `bundle export` / `import` |
| 她的日记、分类记录、账本 | ✅ 能 | 同上 |
| 运行状态（配额/待审草稿/自动发送账/微信道状态） | ✅ 能 | 同上 |
| 人设 `persona.md` | ✅ 能 | 同上 |
| 登录凭据（cookie） | ⚠️ 能但**默认不搬** | 到了新机器扫码登录一次（推荐） |
| DSH 本体 + 配置档（profile） | ⚠️ 要重装 | 装 DSH，再跑 `scripts/install.mjs` |
| 会话日志 `~/.dsh/sessions/` | ❌ 不搬 | 属于 DSH，体积大；换机器就是新历史 |
| 本机补丁（app.asar 上下文面板补丁） | ❌ 不能搬 | 每台机器单独打，见 `F:\dsh\DSH NEXT\resources\apply-context-fix.cmd` |

**"原样部署"的准确含义**：代码 + 她的记忆能原样过去；但"机器"这一层要重来一遍（装 DSH、扫码、确认权限）。不存在一个"镜像"能连 DSH 本体一起搬过去还保持可用——DSH 是带原生模块和 Electron 的桌面应用。

---

## 2. 她的东西都在哪

| 内容 | 位置（默认） | 可否重建 |
|---|---|---|
| 代码 | 你 clone 的目录（如 `F:\dsh\project\robo\dsh-bili-pod`） | GitHub 上有 |
| 配置 | `~/.dsh/pod.config.json` | ❌ 手工配置的，要搬 |
| 运行状态 | `~/.dsh/pod-work/state/`（配额、待审草稿、自动发送账、私信状态…） | ❌ 是"她现在想到哪" |
| 账本 | `~/.dsh/pod-work/rounds/` | ❌ 哈希链历史 |
| 产出物 | `~/.dsh/pod-work/artifacts/`（默认关） | ❌ 写过才有 |
| 扩展 | `~/.dsh/pod-work/extensions.json` + 各 `ext` 目录 | 部分是 |
| 日记 | `~/.dsh/pod-diary/`（`daily/` `owner/` `records/` `archive/`） | ❌ 她的记忆本体 |
| 人设 | `$DSH_HOME/pod-persona.md` | 旧 `~/.bili-ai/persona.md` 首次复制兼容；存档仍使用 `home/persona.md` |
| 凭据 | `~/.bili-ai/credentials.json` | ✅ 扫码即可 |

> `~/.dsh` 可能是指向别处的 junction（本机就是 `F:\dsh\DSH_HOME`）。
> 插件认 `DSH_HOME` 环境变量；两台机器的路径结构不必一样，`bundle import` 会写到目标机自己的默认位置。

---

## 3. 要不要专门的存档方式？—— 要，而且已经做好了

```bash
# 打包（默认不含凭据；--with-credentials 才含，含了就等于账号密码）
node tools/bili.mjs bundle export --out pod-2026-10-23.zip

# 看一眼包里有什么、有没有被改坏（逐条 sha256）
node tools/bili.mjs bundle inspect pod-2026-10-23.zip

# 在新机器上导入（目标已有东西会拒绝；--force 会先备份成 .bak-<时间>）
node tools/bili.mjs bundle import pod-2026-10-23.zip
```

包里长这样：

```
manifest.json                 包信息 + 每个文件的 sha256 + 导出时的提醒
config/pod.config.json
data/pod-diary/…              日记 / 分类记录库 / 归档
data/pod-work/…               state / rounds / artifacts / extensions.json
home/persona.md               人设
home/credentials.json         只有 --with-credentials 才有
plugin/…                      只有 --with-plugin 才有（一般不需要，代码走 git）
```

设计上的几个取舍：

- **默认不打包凭据**：凭据跟账号走，不该躺在压缩包里到处飞。到了新机器扫一次码只要 20 秒。
- **不打包会话日志**：那是 DSH 的东西，几百 MB，且换机器后历史没有意义。
- **导入前全量校验**：sha256 有一条对不上就一条都不写。
- **默认不覆盖**：目标已有数据 → 报错退出；`--force` 才覆盖，并且先把旧目录改名备份。
- **包内不含绝对路径**：换机器不泄露用户名，也不会把路径写死。

建议节奏：

- 每次大改作息/口味/女主人配置后打一个包（几十 KB，随手存）。
- 每周一个包，保留最近 8 个；放**你自己的私有位置**（不要放公共网盘）。
- 包 = 存档；GitHub = 代码存档 + 版本历史。两者互补，不重复。

---

## 4. 具体搬家步骤（推荐路径）

### 旧机器

```bash
cd <插件目录>
git pull                                  # 先升级到最新
npm test                                  # 顺手确认代码是好的
node tools/bili.mjs bundle export --out pod-<日期>.zip
```

> 如果她正在跑（比如刚醒来），等这一轮结束再打；包里的 `state/` 是"某一瞬间"的状态，正在写的时候打会得到半截 JSON。
> 简单判断：`node tools/bili.mjs deps` 正常、`~/.dsh/pod-work/state/` 里没有 `.tmp` 文件即可。

把 zip 传过去（U 盘、私有网盘都行；若用了 `--with-credentials`，先给它加个密码再传）。

### 新机器

```bash
# 1) 装 DSH 桌面版（带网页界面），随便哪个盘

# 2) 拿代码
git clone https://github.com/nullifyi/dsh-bili-pod /path/to/dsh-bili-pod

# 3) 挂进 DSH 配置档（等价于 dsh plugin --profile desktop add "link:…"）
node /path/to/dsh-bili-pod/scripts/install.mjs

# 4) 导入她的记忆
node /path/to/dsh-bili-pod/tools/bili.mjs bundle import pod-<日期>.zip

# 5) 体检 + 登录
node /path/to/dsh-bili-pod/tools/bili.mjs deps
```

然后**重启 DSH**，打开「设置 → 鲸群」：

1. 扫码登录（或手动粘 cookie）
2. 核对「主人 mid」是不是你（导入的配置会带过来，但账号要重新登录）
3. 点「保存」
4. `node tools/bili.mjs selftest`

### 验证清单（30 秒）

- [ ] 设置页 → 状态：作息模式、主人 mid 正确
- [ ] `node tools/bili.mjs diary show` 能看到旧日记
- [ ] `node tools/bili.mjs ledger verify` 显示链完好
- [ ] `node tools/bili.mjs spend` 不报错
- [ ] 设置 → 鲸群 → 点一次「现在叫她起来」，看她会不会用自己的语气回一句

---

## 5. 云同步：要不要、选哪个

先说结论：**代码不需要云同步（GitHub 已经是了）；她的记忆建议"打包 + 定时上传"，而不是"双向实时同步整个目录"。**

| 方案 | 适合 | 优点 | 代价 / 风险 |
|---|---|---|---|
| GitHub（代码） | 插件代码 | 有历史、能回滚、能协作 | 不适合自动提交运行态（JSON 冲突、历史噪音） |
| `bundle` 包 + 私有云盘（坚果云/OneDrive/Google Drive） | 她的记忆 | 简单、通用、能随时下回来 | 需要记得上传；云盘隐私；大包占流量 |
| 私有 Git 仓库（运行态） | 想要版本历史 | 每次导出都留档、可 diff | 日记属隐私；仓库要私有；提交策略要定 |
| Syncthing / 坚果云"同步目录"（直接同步 `~/.dsh`） | 想两台机器"无缝" | 改哪台都一样 | ⚠️ **高风险**：两台同时写同一份 JSON、云盘生成"冲突副本"、凭据被同步、B站双开风控 |

### 坚果云这类服务能不能用？

能，但**只把它当"运输工具"**，不要当"运行目录"：

- ✅ 做法：`bundle export --out <坚果云目录>/pod-latest.zip`，另一台 `bundle import`。
- ❌ 别做：让坚果云直接同步 `~/.dsh/pod-work` / `pod-diary`。原因：
  1. 她每轮都在写 `pod-night.json`、`pending-replies.json`，双向同步必然出现"两个版本都在写"；
  2. 坚果云/OneDrive 冲突时会生成 `xxx (冲突副本).json`，插件读的是原文件名 → 两边看到的状态不一致；
  3. 同步盘会把你**已经决定不打包的凭据**也传上去；
  4. 两台机器同时用同一个 B 站 cookie 跑，风控和重复发言都会找上门。

### 两台机器同时跑会怎样（务必读）

- 调度状态（`pod-night.json`）各算各的 → 同一晚可能各醒一轮，评论/私信翻倍；
- 配额（`quota.json`、`auto-sent.json`）各算各的 → "一天最多 3 条分享"变成 6 条；
- 待审草稿各存各的 → 你在 A 机批准，B 机不知道；
- 同一 cookie 双开 → B 站可能要求验证、甚至短期封控；
- 账本哈希链各自续写 → 两份互不相连的历史（不报错，但会困惑）。

**规则：同一时间只让一台机器"值班"。** 另一台要么不装，要么装好但不启动 DSH（或者把她的作息窗口设成 0 次唤醒，只留设置页）。

---

## 6. 常见问题

**Q：新机器上没有 `dsh` 命令怎么办？**
A：不用它。`scripts/install.mjs` 直接改配置档 `package.json` + 建 `node_modules` 链接，效果等价于 `dsh plugin add`。卸装用 `scripts/uninstall.mjs`（不动数据）。

**Q：DSH 版本不一样会不会坏？**
A：插件只依赖宿主注入的三个东西：`sessionController`、`webServer`、`connection`。网页版配置档有这些；无界面（headless）没有，插件会停在 `pending` 并说明原因。换大版本前先 `deps` + 手动叫醒一轮验证。

**Q：没有 ffmpeg 行不行？**
A：行，只影响"抽帧看画面"那一路，其余全正常；`deps` 里会标出来。

**Q：换一台电脑后 B 站账号要不要换？**
A：不强制。但两台机器别同时跑同一个账号（见上）。如果一台给主人、一台给女主人，反而是合理的双机玩法。

**Q：我在新机器上已经装过旧版本，导入旧包会怎样？**
A：默认拒绝覆盖；加 `--force` 会先把 `pod-work`、`pod-diary`、`pod.config.json`、`persona.md` 改名成 `.bak-<时间>` 再写。回滚就把这些目录名改回去。

**Q：bundle 包会不会包含我的隐私？**
A：会——日记、待审草稿、口味记录都在里面，这是它的目的。**但默认不含凭据**。放的时候按"包含你私人日记"的标准对待；需要更强保护就先压缩加密（7z/WinRAR 带密码）。

**Q：`~/.dsh` 换了位置（比如 D 盘）怎么办？**
A：插件全部走 `DSH_HOME` 环境变量 + 默认路径；`bundle export/import` 也认 `DSH_HOME`。所以只要新机器的 DSH 正常启动，路径不用手改。
