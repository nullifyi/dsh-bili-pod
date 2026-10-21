# 鲸群的 mod 扩展

鲸群（dsh-bili-pod）预留了「不碰本体也能加功能」的接口 —— 像游戏 mod：
放一个 `.mjs` 到扩展目录，设置页点「重载扩展」，立刻生效（重启后也会自动载入）。

## 放哪里

按优先级：

1. 设置 → 鲸群 → 扩展 → 目录（逗号分隔，写绝对路径）
2. 环境变量 `BILI_POD_EXT`（默认 `~/.dsh/pod-ext`）
3. 插件自带的 `extensions/`（内置示例 `mod-example.mjs` 在这里）

同一个 id 只加载第一个；目录里的文件按文件名排序。

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
| `pod.route('/xxx', handler)` | HTTP 路由，实际路径 `/dsh-bili/api/ext/<id><expr>`；handler 与宿主路由同签名 `(req,res)` |
| `pod.field({path,label,hint,kind,options})` | 设置页字段；值读写 `config.extensions.items[<id>]`；`kind` = text/number/list/switch/select |
| `pod.dataDir()` | 自己的数据目录 `<work>/ext/<id>`（自动创建） |
| `pod.readConfig()` / `pod.patchConfig(patch)` | 读 / 合并写配置 |
| `pod.log(msg)` | 写 DSH 日志，前缀 `[ext:<id>]` |

## 事件

`tick`（每分钟）、`wake:before` / `wake:after`（醒来前后）、`round:start` / `round:end`（一轮会话前后）、
`ledger:write`（账本落笔）、`diary:archived`（日记归档）、`verify:done`（评论复核完）、
`comment:sent`（评论发出）、`login:ok`（扫码登录成功）、`extensions:loaded`（扩展载入完）。

每个回调有 8 秒超时，抛错只记到扩展自己的 `lastError`，不会连累其他 mod。

## 不能做的事

- 扩展跑在 DSH 主进程里 —— 别写死循环、别阻塞。
- 扩展拿到的配置只是副本；要改走 `pod.patchConfig`。
- 发评论 / 私信这类动作受本轮「权限单」约束（写扩展命令时用 `bili.mjs` 的既有命令，别自己造写接口）。
