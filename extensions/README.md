# 鲸群的 mod 扩展

鲸群（dsh-bili-pod）预留了「不碰本体也能加功能」的接口 —— 像游戏 mod：
放一个 `.mjs` 到扩展目录，设置页点「重载扩展」，立刻生效（重启后也会自动载入）。

## 放哪里

按优先级：

1. 插件自带的 `extensions/`（内置示例 `mod-example.mjs` 在这里）
2. 环境变量 `BILI_POD_EXT`（默认 `~/.dsh/pod-ext`）
3. 设置 → 鲸群 → 扩展 → 目录（逗号分隔，写绝对路径）

目录里的文件按文件名排序。请给每个 mod 使用唯一 id。

## 最小骨架

```js
export default {
  id: 'my-mod',          // 必填，小写字母开头，可含数字与 -
  name: '我的扩展',
  version: '0.1.0',
  apiVersion: 1,          // 宿主 API 版本；比宿主高会被拒
  description: '一句话说明',
  async setup(pod) {
    pod.log('hello')
  },
}
```

`setup(pod)` 里可以（全部可选）：

| 接口 | 作用 |
| --- | --- |
| `pod.on(event, fn)` | 订阅事件（见下表） |
| `pod.addPromptSection({id,title,text,priority})` | 往「她醒来」的提示里插一段；`text` 可以是函数，收到 `{config,plan,scope}` |
| `pod.command({name,desc,script})` | 给 `bili.mjs` 注册命令（`script` 是 `.mjs` 绝对路径），之后 `node bili.mjs <name>` 可跑 |
| `pod.route('/xxx', handler)` | HTTP 路由，实际路径 `/dsh-bili/api/ext/<id><expr>`；handler 接收 `{req,res,json,bodyJson,readConfig,writeConfig,workDir,diaryRoot,podHost}`，可返回 JSON 值 |
| `pod.field({path,label,hint,kind,options})` | 设置页字段；值读写 `config.extensions.items[<id>]`；`kind` = text/number/list/switch/select |
| `pod.dataDir()` | 自己的数据目录 `<work>/ext/<id>`（自动创建） |
| `pod.readConfig()` / `pod.patchConfig(patch)` | 读 / 合并写配置 |
| `pod.log(msg)` | 写 DSH 日志，前缀 `[ext:<id>]` |

## 事件

`tick` 在未忙碌的分钟调度检查中触发；`wake:before` 是定时唤醒投递前，`wake:after` 是投递被接收且计划已记账后。
`round:start` 在 wake / dm / listen / live 调用会话前触发；`round:delivered` 只表示原生 `prompt` 返回 `accepted:true`。
`ledger:write` 是宿主定时唤醒/复核成功提交账本；`diary:archived` 是宿主归档后；`verify:done` 是宿主复核完。
`config:saved` 是设置 API 保存后；`login:ok` 是扫码登录成功；`extensions:loaded` 是重载结束。

DSH 当前接收确认不提供可靠的 agent 工作完成信号，所以不提供 `round:end`。独立 CLI 发送进程没有回传事件总线，因此不承诺 `comment:sent`；CLI 写账本也不会触发宿主事件。

每个回调有 8 秒超时，抛错只记到扩展自己的 `lastError`，不会连累其他 mod。

`setup` 可以返回（或异步返回）disposer。重载、禁用和卸载会调用一次；失败/超时回滚已注册内容，晚到的注册被忽略。prompt 的 `text` 回调必须同步返回文本，异常只记录该 mod 的错误。

总开关、单项开关和扩展目录的设置保存会真正重载。`bili.mjs <name>` 仅按当前配置加载本地 mod 并执行注册脚本，扩展参数保持原样；内置同名命令优先。`extensions.json` 只是状态索引，不提供可注入脚本的分发入口。这些接口不是 MCP server，也不会自动注册成模型工具。

## 不能做的事

- 扩展跑在 DSH 主进程里 —— 别写死循环、别阻塞。
- 只安装可信的本地 mod。超时只能隔离异步注册，不能中断 JS 死循环或撤销 mod 自己做的文件/网络操作；禁用项取 manifest 时仍可能 import 模块，副作用应放在 setup 并在 disposer 清理。
- 扩展拿到的配置只是副本；要改走 `pod.patchConfig`。
- 发评论 / 私信这类动作受本轮「权限单」约束（写扩展命令时用 `bili.mjs` 的既有命令，别自己造写接口）。
