/**
 * 私信额度的纯判定（0.8.1）
 * ============================================================================
 * 只做一件事：把「今天还能不能主动发」从 dm.mjs 里抽出来，好在测试里直接断言。
 * 背景：以前只有 --share 会检查上限，notify / 续聊都能绕过去 ——
 * 主人看到她「主动第 21 条（上限 10 条/天）」却还是发出去了，又在她想正式分享时报额度没了。
 */
export function proactiveCap({ used, cap }) {
  const u = Math.max(0, Number(used ?? 0))
  const c = Math.max(0, Math.floor(Number(cap ?? 0)))
  if (c <= 0) return { blocked: true, reason: '上限是 0（设置里调大，或先用草稿手动发）' }
  if (u >= c) return { blocked: true, reason: `今天主动私信已发 ${u} 条（上限 ${c}）` }
  return { blocked: false, next: u + 1, cap: c }
}
