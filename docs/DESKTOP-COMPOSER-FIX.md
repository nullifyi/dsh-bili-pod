# DSH 桌面输入框补丁

## 修改内容

在检查过的 DSH 桌面应用中，`dsh-client-ui-conversation` 的 `clearCommittedDraft` 发送后清空全部段落，再选择空根节点。补丁保留一个空段落再定位光标，使其与初始化、恢复草稿的行为一致。

这是独立的桌面应用补丁；只升级鲸群插件不会自动修改应用包。当前仅确认修改后应用可以正常启动，完整的“发送第一条后再次输入”流程尚待实际使用确认。

## 应用

先从应用菜单退出 DSH，然后在本仓库目录运行（需要 Python 3）：

```bash
py -3 scripts/fix-desktop-composer.py --asar 'F:\dsh\DSH NEXT\resources\app.asar' --backup-dir 'F:\dsh\backups\composer'
```

按实际安装位置调整路径。脚本会：

- 只修改已识别的 `clearCommittedDraft` 片段；源码不匹配时停止。
- 保持被修改文件及 ASAR 数据区域的长度，重算该文件的 SHA256 完整性字段。
- 先在指定目录保留原应用包，再替换应用包，并输出备份路径。
- 已包含同一补丁时直接退出，不重复修改。

完成后从正常快捷方式启动 DSH。

## 回退与更新

退出 DSH，将脚本输出的原应用包备份复制回 `resources/app.asar`，再启动 DSH。

DSH 更新或其他应用包补丁可能覆盖本次修改。更新后不要直接用旧备份覆盖新版本；如仍有输入问题，应重新检查新版本代码。

## 本次核验范围

插件文件经过 Node 语法解析；补丁脚本经过 Python 语法解析。本次没有运行测试套件，也没有发送真实模型请求或 B 站私信。

原生 JS 弹窗可能引起的另一类失焦问题见 [Electron issue 40212](https://github.com/electron/electron/issues/40212)。鲸群的“现在叫醒”已移除重复的 `window.confirm`。
