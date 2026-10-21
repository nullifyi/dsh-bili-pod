#!/usr/bin/env node
// 峰谷作息（可选生物钟）—— 看它今天会怎么安排。
//
//   node tools/bili.mjs tide            # 当前模式 + 今天算出来的窗口（人读）
//   node tools/bili.mjs tide preview [--json]
//
// 固定窗口（fixed）是基座原来的样子；峰谷（tide）是后来加的：
//   峰 = 状态好的时段 → 醒得多、跳过概率低
//   谷 = 犯困的时段   → 醒得少、跳过概率高
//   两者都被「清醒区间 activeStart–activeEnd」夹着。
// 设置 → 鲸群 → 作息 里切换，两种模式共用同一套记账 / 补跑逻辑。
import { applyTide, previewTide, describeTide, normalizeTide } from '../../lib/tide.mjs'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show'
const JSON_OUT = argv.includes('--json')
const cfg = config()
const night = cfg.night ?? {}
const mode = night.mode === 'tide' ? 'tide' : 'fixed'
const wins = previewTide(night)

if (sub === 'preview' || sub === 'show') {
  if (JSON_OUT) {
    console.log(JSON.stringify({ mode, mode_desc: mode === 'tide' ? describeTide(night.tide ?? {}) : '固定窗口', active: night.tide ?? normalizeTide({}), windows: wins, maxVideos: night.maxVideos }, null, 2))
    process.exit(0)
  }
  console.log(`作息模式：${mode === 'tide' ? '峰谷（tide）' : '固定窗口（fixed）'}`)
  if (mode === 'tide') console.log(describeTide(night.tide ?? {}))
  if (!wins.length) {
    console.log('⚠️ 今天没有任何窗口 —— 她不会醒。检查设置 → 鲸群 → 作息。')
    process.exit(0)
  }
  console.log(`\n今天算出来的窗口（${wins.length} 个）：`)
  for (const w of wins) console.log(`  ${String(w.label).padEnd(18)} 醒 ${w.wakes} 次   跳过概率 ${Math.round(Number(w.skipChance) * 100)}%`)
  const total = wins.reduce((n, w) => n + w.wakes, 0)
  console.log(`\n合计最多醒 ${total} 次/天 · 每条窗口最多看 ${night.maxVideos ?? 5} 个视频`)
  console.log('（实际要不要醒还掷骰子；跳过也会记账本，不是静默消失）')
  process.exit(0)
}

console.error('用法：tide show | tide preview [--json]')
process.exit(2)
