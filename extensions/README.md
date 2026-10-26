# 鲸群功能 mod

打开“设置 → 鲸群 → 功能 mod”：卡片各自有启停、设置、面板和“单独重载”。配置改完点全页“保存”；入口或清单改完点对应卡片“单独重载”；新包放进目录后点“重载全部”。不需要重启 DSH。

关模块会撤销其提示、控件、面板与路由，不删配置和记录。内置控件模块关闭后恢复原输入方式。未保存的配置或人设正文会阻止启停/重载；人设仍通过“注入人设”独立写入，配置保存不会冒充人设已写入。

## 内核与模块

内核统一管理身份、会话、调度、发送审批、配额、凭据和数据路径。mod 接入独立功能，不自起后台 Node 服务，也不绕过发送权限；新增通用宿主能力仍需扩展内核。

| 包 | 功能 |
| --- | --- |
| favorite-picker | 读取本人收藏夹，中文下拉；失败保留 ID，不执行收藏 |
| watched-library | 本地已收藏/已评论的视频足迹，支持搜索筛选，不代表完整观看 |
| sharing-controls | 自动私信对象多选、搜索和报告中文下拉，不自动开启发送 |
| public-comment-style | 自然/简短/交流三种公开评论语气；只作用 wake/listen，不改私聊人设 |

## 加一个包，不改客户端

在插件 extensions/ 或 BILI_POD_EXT（默认 DSH_HOME/pod-ext）下新建 my-note/。mod.json：
~~~json
{
  "id": "my-note",
  "name": "我的提醒",
  "version": "1.0.0",
  "apiVersion": 2,
  "main": "index.mjs",
  "fields": [{
    "path": ["extensions", "items", "my-note", "note"],
    "label": "提醒内容",
    "kind": "textarea"
  }]
}
~~~
index.mjs：
~~~js
export default {
  setup(pod) {
    pod.addPromptSection({
      id: 'note',
      title: '我的提醒',
      reasons: ['wake'],
      text: ({config}) => config.extensions?.items?.['my-note']?.note || '',
    })
  },
}
~~~

配置、逻辑、展示属于同一包。本次内置包的运行逻辑均自包含于入口；单独重载刷新入口和清单，不承诺清空 Node 对任意静态导入依赖的缓存。共享内核改动按插件版本升级验证。

## 控件与面板契约

field kind 支持 text、textarea、number、list、switch、select、multiselect。options 可为字符串或 {value,label}。number 可声明 min/max/step。path 为数组，自定义配置建议放 extensions.items.<id> 下。default 是表单初值，运行逻辑也应提供相同默认值。数字、布尔、数组在服务端校验；非法值不落盘；禁用不清值。

optionsRoute 是模块内只读路由，如 /folders；返回 {options:[{value:'1',label:'学习'}]}。界面自动处理读取、刷新、错误和旧选项保留。

panels 可声明 collection 面板：
~~~json
{"id":"history","title":"记录","kind":"collection","route":"/items","filters":[{"key":"kind","label":"分类","options":[{"value":"","label":"全部"}]}]}
~~~
pod.route('/items', handler) 返回 {items:[{id,title,url,subtitle,description,badges:[]}],total,page,pageSize}。通用界面传入 q/page 和声明的筛选参数；路由自己查询数据。文本由 React 转义，仅 HTTP(S) 链接可点击，不支持 HTML 注入。

## 生命周期与兼容

API v2 保留单文件 .mjs/API v1 和 pod.on/addPromptSection/command/route/field/dataDir/readConfig/patchConfig/log，新增 pod.panel。旧提示段默认 wake；可声明 reasons，实际渠道调用仍由宿主决定，当前接线为 wake/listen，不默认给 DM 注入。

静态清单可让禁用包不 import 入口；legacy 单 .mjs 读取导出仍须 import。副作用放在 setup 中，返回 disposer 清理资源。mod 是可信本地 Node 代码，异步超时不是进程沙箱，不能中断同步死循环或撤销已执行的外部动作。

单项重载只回收该实例；旧回调不能借同 id 的新实例恢复执行。失败 setup 回滚注册；字段/命令冲突拒绝新模块，保留健康模块；提示段 id 按模块区分。每目录先扫描 legacy 文件再扫描包，同类按文件名稳定排序；id 必须唯一。

事件为 tick、wake:before/after、round:start/delivered、ledger:write、diary:archived、verify:done、config:saved、login:ok、extensions:loaded。delivered 仅是接收确认；独立 CLI 没有可靠 comment:sent 或 round:end 总线。
