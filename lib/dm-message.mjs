/**
 * lib/dm-message.mjs —— 私信正文的唯一构造入口（纯函数）
 * ============================================================================
 * 为什么必须只有一处：
 *   分享型私信要求「正文里有能直接点开的视频链接」，而这条消息会经过
 *     构建 → 预览 → 存草稿 → 宿主批准 → 真的 POST
 *   四个环节。任何一环各写各的，就会出现「批准的是 A、发出去的是 B」。
 *   所以：所有地方都调 buildDmMessage()，批准只认它算出来的最终正文。
 *
 * 规则（PLAN-0.7 §3.3）：
 *   · 分享必须给 bvid；正文里的 BV 必须和 bvid 一致（不许把 A 的话接到 B 链接）
 *   · 正文没有规范链接时自动补一行；已有就不重复
 *   · 补完之后超过 max 字 → 直接报错，不截断（截断会让「批准的文字」和「发出的文字」不一样）
 *   · 普通聊天不强塞链接
 * ============================================================================
 */

/** 私信正文上限（B站私信太长发不出去，也会像刷屏） */
export const DM_MAX = 300

const BV_RE = /BV[0-9A-Za-z]{10}/g
const BV_ONE = /^BV[0-9A-Za-z]{10}$/

/** 正文里出现的所有 BV 号（去重、保序） */
export function bvidsIn(text) {
  const found = String(text ?? '').match(BV_RE) ?? []
  return [...new Set(found)]
}

/** 规范视频链接（结尾带斜杠，和 B站 分享出来的一致） */
export function videoUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}/`
}

/**
 * 构造最终私信正文。
 * @param {object} p
 * @param {string} p.message  她写的正文
 * @param {string} [p.bvid]   要分享的 BV 号（结构化字段，不靠正文猜）
 * @param {boolean} [p.share] 是不是分享型
 * @param {number} [p.max]
 * @returns {{ok:boolean, text:string, bvid:string|null, addedUrl:boolean, reason?:string}}
 */
export function buildDmMessage({ message, bvid, share = false, max = DM_MAX } = {}) {
  const text = String(message ?? '').trim()
  const want = String(bvid ?? '').trim()
  const hasBv = BV_ONE.test(want)
  if (!share) {
    return { ok: text.length <= max, text, bvid: hasBv ? want : null, addedUrl: false, ...(text.length > max ? { reason: `私信太长（${text.length} > ${max} 字）` } : {}) }
  }
  if (!hasBv) return { ok: false, text, bvid: null, addedUrl: false, reason: '分享视频的私信必须给 --target BV号（结构化字段，别只在正文里写）' }

  const found = bvidsIn(text)
  const others = found.filter((b) => b !== want)
  if (others.length) {
    return { ok: false, text, bvid: want, addedUrl: false, reason: `正文里的视频（${others[0]}）和要分享的（${want}）不是同一个 → 拒绝，别把 A 的话接到 B 链接上` }
  }

  const url = videoUrl(want)
  let out = text
  let addedUrl = false
  if (!text.includes(url)) {
    out = text ? `${text}\n${url}` : url
    addedUrl = true
  }
  if (out.split(url).length > 2) {
    return { ok: false, text: out, bvid: want, addedUrl: false, reason: '同一条私信里出现了两次同样的视频链接' }
  }
  if (out.length > max) {
    return { ok: false, text: out, bvid: want, addedUrl, reason: `加上链接后 ${out.length} 字，超过 ${max} 字上限 → 请把正文砍短（不截断已批准的文字）` }
  }
  return { ok: true, text: out, bvid: want, addedUrl }
}
