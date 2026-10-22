// 开销：小鲸鱼一天里哪件事最费 token（数据全部来自 DSH 会话日志，只读）。
//
//   node tools/bili.mjs spend                 # 今天（只算她自己的会话）
//   node tools/bili.mjs spend --date 2026-10-22
//   node tools/bili.mjs spend --all           # 连带你自己在这个项目里的会话
//   node tools/bili.mjs spend --json
//   node tools/bili.mjs spend --watch --interval 60   # 挂着一个持续刷新的小仪表盘
import { report, reportLines, fmtTokens } from '../../lib/spend.mjs'
import { workDir } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes('--' + n)
const val = (n, d = '') => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const JSON_OUT = flag('json')
const ALL = flag('all')
const WATCH = flag('watch')
const DATE = val('date', new Date().toLocaleDateString('sv-SE'))
const INTERVAL = Math.max(15, Number(val('interval', '60')) || 60)
const DAYS = Math.max(0, Number(val('days', '0')) || 0)

function once() {
  const rep = report({ date: DATE, workDir, scope: ALL ? 'all' : 'pod', price: config().spend?.price !== false })
  return rep
}

if (DAYS > 1) {
  // 近 N 天：一天一行，先看「量」再看趋势
  const rows = []
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000).toLocaleDateString('sv-SE')
    try {
      const rep = report({ date: d, workDir, scope: ALL ? 'all' : 'pod', price: config().spend?.price !== false })
      rows.push({ date: d, rounds: rep.rounds, tokens: rep.usage.totalTokens, output: rep.usage.outputTokens, yuan: rep.yuan, top: rep.byKind[0]?.kindLabel ?? '—' })
    } catch (e) {
      rows.push({ date: d, rounds: 0, tokens: 0, output: 0, yuan: null, top: '读不到：' + e.message })
    }
  }
  if (JSON_OUT) console.log(JSON.stringify(rows, null, 2))
  else {
    console.log(`📒 最近 ${DAYS} 天开销（${ALL ? '全部会话' : '小鲸鱼自己的会话'}）`)
    for (const r of rows) console.log(`   ${r.date}  ${String(r.rounds).padStart(2)} 轮  ${fmtTokens(r.tokens).padStart(8)}  tokens  输出 ${fmtTokens(r.output).padStart(7)}${r.yuan != null ? '  ≈¥' + r.yuan.toFixed(3) : ''}  最费：${r.top}`)
  }
} else if (WATCH) {
  let last = ''
  const tick = () => {
    try {
      const rep = once()
      const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${rep.date}  ${rep.rounds} 轮  ${fmtTokens(rep.usage.totalTokens)} tokens` +
        (rep.yuan != null ? `  ≈¥${rep.yuan.toFixed(3)}` : '') +
        (rep.byKind[0] ? `  最费：${rep.byKind[0].kindLabel}(${fmtTokens(rep.byKind[0].tokens)})` : '')
      if (line.split('  ').slice(1).join('  ') !== last) {
        console.log(line)
        last = line.split('  ').slice(1).join('  ')
      }
    } catch (e) {
      console.error('· 这轮没读到：' + e.message)
    }
  }
  console.log(`📒 开销监视（每 ${INTERVAL}s 刷新，Ctrl+C 退出）—— 只算小鲸鱼的会话`)
  tick()
  setInterval(tick, INTERVAL * 1000)
} else {
  const rep = once()
  if (JSON_OUT) console.log(JSON.stringify(rep, null, 2))
  else console.log(reportLines(rep).join('\n'))
}
