/**
 * 示例 mod —— 鲸群的扩展（mod）写法示范。
 * ============================================================
 * 想给鲸群加东西，不必改插件本体：
 *   1. 在 设置 → 鲸群 → 扩展 → 目录 里加一个目录（默认 ~/.dsh/pod-ext 也行）
 *   2. 丢一个 .mjs 进去，默认导出 {id,name,version,apiVersion,setup(pod)}
 *   3. 设置页点「重载扩展」
 *
 * pod 提供的能力（全部可选、按需用）：
 *   pod.on(event, fn)          订阅事件：tick / wake:before / wake:after / round:start /
 *                              round:end / ledger:write / diary:archived / verify:done /
 *                              comment:sent / login:ok / extensions:loaded
 *   pod.addPromptSection({id,title,text,priority})
 *                              往醒来的提示里插一段（text 可以是函数，拿到 {config,plan,scope}）
 *   pod.command({name,desc,script})    给 bili.mjs 加一个命令（script 是 .mjs 绝对路径）
 *   pod.route('/api/…', handler)      加 HTTP 路由，挂在 /dsh-bili/api/ext/<id><expr>
 *   pod.field({path,label,hint,kind,options})
 *                              在设置页加一个字段，值存在 config.extensions.items[<id>]
 *   pod.dataDir()              自己的数据目录（<work>/ext/<id>）
 *   pod.readConfig() / pod.patchConfig(patch)
 *   pod.log(msg)
 *
 * 这个示例本身什么也不干（note 为空时不插提示），可以当模板抄。
 */
import fs from 'node:fs'
import path from 'node:path'

export default {
  id: 'mod-example',
  name: '示例 mod（可删）',
  version: '0.1.0',
  apiVersion: 1,
  description: '演示扩展接口：设置字段 / 提示段 / HTTP 路由 / 事件订阅。默认不产生任何影响。',

  async setup(pod) {
    const cfgOf = () => (pod.readConfig() ?? {})
    const mine = () => cfgOf().extensions?.items?.['mod-example'] ?? {}
    const note = () => String(mine().note ?? '').trim()

    pod.field({ path: ['extensions', 'items', 'mod-example', 'note'], label: '示例 mod · 一句话', kind: 'text',
      hint: '填了就会出现在她每次醒来的提示里（演示用）' })

    pod.addPromptSection({
      id: 'mod-example/note',
      title: '示例 mod 留言',
      priority: 200,
      text: () => (note() ? `主人留了个话：“${note()}”` : ''),
    })

    pod.route('/note', async () => ({ ok: true, note: note(), ext: 'mod-example' }))

    pod.on('comment:sent', (payload) => {
      try {
        const dir = pod.dataDir()
        fs.appendFileSync(path.join(dir, 'sent.log'),
          `${new Date().toISOString()} ${JSON.stringify(payload)}\n`, 'utf8')
      } catch (e) { pod.log('记 sent.log 失败：' + e.message) }
    })

    pod.log('示例 mod 已就绪（note 为空 = 不影响任何东西）')
  },
}
