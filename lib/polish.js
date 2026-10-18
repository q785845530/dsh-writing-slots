/**
 * dsh-writing-slots — De-AI Polish（去味层）的规则引擎。
 *
 * 这一层**不负责「写好」，只负责删掉不像人的部分**。所以判断依据全部来自
 * Style Anchor 产出的 forbidden_list，而不是模型自己对「自然」的猜测。
 *
 * ## 职责怎么分
 * 代码能确定的事就由代码做，别交给模型：
 *   - **检测**：五条规则里，四条是查得到的模式，一条是统计（短句占比）。
 *     这些全在这里算，给出**带定位的证据**。
 *   - **改写**：只有这一步需要模型。提示词里给它的是「哪一句犯了哪条」，
 *     不是「帮我润色一下」。
 *   - **复验**：改完再跑一遍同样的检测。短句占比这类统计指标如果没达标，
 *     如实报出来，而不是说一句「已润色」就完事。
 *
 * 这样「有没有去干净」是可验证的，不是靠模型自述。
 *
 * @module dsh-writing-slots/polish
 */
import { countChars, plainText, splitParagraphs, splitSentences, sentenceStats } from './style.js'

/**
 * 五条去味规则。
 *
 * 每条都有 `id`、`rule`（给人看的一句话）、`detect`（返回命中列表）。
 * `detect` 返回的每一项带 `evidence`（原文片段）与 `where`（段/句定位），
 * 这样提示词能指出「哪一句犯了哪条」，而不是笼统地说「去去 AI 味」。
 */
export const POLISH_RULES = [
  {
    id: 'pronoun-run',
    rule: '禁止段首连续以同一人称代词开头',
    detect(text) {
      const paras = splitParagraphs(text)
      const hits = []
      let runStart = -1
      let runPronoun = null
      let run = 0
      paras.forEach((p, i) => {
        const m = /^[「“"']?\s*(他|她|它|我|你|他们|她们)/.exec(p)
        const pronoun = m === null ? null : m[1]
        if (pronoun !== null && pronoun === runPronoun) {
          run += 1
          if (run >= 2) {
            hits.push({
              where: `第 ${i + 1} 段`,
              evidence: p.slice(0, 40),
              note: `与第 ${runStart + 1} 段起连续 ${run} 段以「${pronoun}」开头`,
            })
          }
        } else {
          runStart = i
          runPronoun = pronoun
          run = 1
        }
      })
      return hits
    },
  },
  {
    id: 'as-if',
    rule: '禁止「仿佛 / 似乎 / 宛如」这类明喻引导词',
    detect(text) {
      return matchAll(text, /[^。！？\n]{0,20}(仿佛|似乎|宛如|犹如)[^。！？\n]{0,20}/g)
    },
  },
  {
    id: 'a-kind-of-feeling',
    rule: '禁止「一种……的感觉 / 莫名的……」这种抽象情绪句式',
    detect(text) {
      return matchAll(text, /[^。！？\n]{0,16}(一种[^。！？\n]{0,12}的(感觉|情绪|滋味)|莫名的)[^。！？\n]{0,16}/g)
    },
  },
  {
    id: 'saying-tag',
    rule: '禁止对话后除「说道 / 问道」外的描述性标签',
    detect(text) {
      return detectSayingTags(text)
    },
  },
  {
    id: 'summary-tail',
    rule: '禁止在场景结束时替读者总结意义',
    detect(text) {
      const paras = splitParagraphs(text)
      const hits = []
      paras.forEach((p, i) => {
        // 只看段落最后一句
        const sents = splitSentences(p)
        const last = sents[sents.length - 1] ?? ''
        if (/^(这一刻|这一切|他知道|她明白|从此|也许|或许)[^。！？]{0,40}[。！？]?$/.test(last.trim())
          || /(这一刻|这一切)[^。！？]{0,30}[。！？]/.test(last)) {
          hits.push({ where: `第 ${i + 1} 段末句`, evidence: last.slice(0, 50) })
        }
      })
      return hits
    },
  },
]

/**
 * 找出「对话标签」违规。
 *
 * ## 为什么不能简单搜 `X道`
 * 第一版就是那么写的，结果在真稿上误报 11 处 —— `知道`、`一道`、`岭道`
 * 全被当成对话标签。「X道」这个模式在中文里太常见了。
 *
 * ## 改成靠引号配对判定
 * 一个对话标签的必要条件是**紧跟在闭引号之后**。所以：
 *   1. 先扫引号，按奇偶判断哪个是闭引号（`「」『』”` 本身就能区分）；
 *   2. 闭引号之后紧跟的 1—4 个字若以 道/说/问/答 收尾，才算标签；
 *   3. 标签整体是「说道 / 问道 / 问 / 答」则放行，其余算犯规。
 *
 * 这样 `"不知道` 里的引号是**开**引号，直接跳过 —— 误报的根源就没了。
 */
function detectSayingTags(text) {
  const s = String(text ?? '')
  const hits = []
  let straight = 0   // 直引号计数，奇数表示这是闭引号
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    let isClosing = false
    if (ch === '"' || ch === "'") {
      straight += 1
      isClosing = straight % 2 === 0
    } else if (ch === '」' || ch === '』' || ch === '”' || ch === '’') {
      isClosing = true
    } else {
      continue
    }
    if (!isClosing) continue

    // 闭引号后紧跟的标签候选（最多 6 个字，到标点为止）
    const rest = s.slice(i + 1, i + 16)
    const m = /^\s*([\u4e00-\u9fff]{1,6}?)(道|说|问|答)(?=[，。：；\s]|$)/.exec(rest)
    if (m === null) continue
    const tag = m[1] + m[2]

    // 只拦**带方式状语**的标签。「他说」「吴常说」是普通归属语，是正常中文；
    // 「他低声道」「她轻笑道」才是 AI 腔 —— 后者在描述「怎么说」，
    // 而不是交代「谁在说」。
    if (!MANNER.test(tag)) continue

    const para = s.slice(0, i).split(/\n\s*\n/).length
    hits.push({ where: `第 ${para} 段`, evidence: `…${tag}`, note: '带方式状语的对话标签' })
  }
  return hits
}

/**
 * 方式状语词表。
 *
 * 这是「描述性标签」的判据：标签里出现这些词，说明它在描述说话方式，
 * 而不只是交代说话人。
 */
const MANNER = /(低声|轻声|沉声|高声|大声|小声|冷笑|轻笑|苦笑|微笑|嗤笑|皱眉|点头|摇头|叹|怒|急|忙|缓缓|淡淡|幽幽|喃喃|嘟囔|嘀咕|咬牙|哼|哽咽|颤声|厉声|柔声|冷声)/

/** 在文本里找所有命中，带上片段与大致位置。 */
function matchAll(text, re) {
  const s = String(text ?? '')
  const hits = []
  let m
  re.lastIndex = 0
  while ((m = re.exec(s)) !== null) {
    // 定位：数到命中处有几个换行，得出大致段号
    const upto = s.slice(0, m.index)
    const para = upto.split(/\n\s*\n/).length
    hits.push({
      where: `第 ${para} 段`,
      evidence: m[0].trim().slice(0, 60),
    })
    if (m.index === re.lastIndex) re.lastIndex += 1
  }
  return hits
}

/**
 * 跑一遍全部规则。
 *
 * `forbiddenList` 来自 Style Anchor 的 forbidden_list —— 只有**样本里从未
 * 出现**的句式才会进那个清单，所以它本身就是「这份稿子不该出现的东西」。
 * 这里用它来裁剪要跑哪些规则：清单里没有的规则不跑（作者本来就用）。
 *
 * @param text 待检测文本。
 * @param options `{ forbiddenList, shortFloor }`。
 */
export function detect(text, options = {}) {
  const forbidden = options.forbiddenList ?? null
  // 禁忌清单缺省时全跑（宁可多查）；给了清单就只查清单里的。
  const allowedIds = forbidden === null || !Array.isArray(forbidden)
    ? null
    : new Set(forbidden.map((f) => (typeof f === 'string' ? ruleIdOf(f) : f.id)).filter((x) => x !== null))

  const violations = []
  for (const rule of POLISH_RULES) {
    if (allowedIds !== null && !allowedIds.has(rule.id)) continue
    let hits = []
    try { hits = rule.detect(text) } catch { hits = [] }
    if (hits.length > 0) {
      violations.push({ id: rule.id, rule: rule.rule, count: hits.length, hits })
    }
  }

  // 统计指标：短句占比
  const stats = sentenceStats(splitSentences(plainText(text)))
  const floor = options.shortFloor ?? null
  const shortOk = floor === null ? null : (stats.short_ratio_value ?? 0) >= floor

  return {
    violations,
    totalHits: violations.reduce((a, v) => a + v.count, 0),
    stats,
    shortFloor: floor,
    shortOk,
    // 统计不达标单独列：它不是「哪句话犯了规」，而是整体节奏问题。
    rhythm: shortOk === false
      ? `短句占比 ${stats.short_ratio}，低于基线下限 ${Math.round(floor * 100)}%`
      : null,
  }
}

/** 从规则文本反查 id（禁忌清单里存的是文本）。 */
function ruleIdOf(text) {
  const hit = POLISH_RULES.find((r) => r.rule === text)
  return hit === undefined ? null : hit.id
}

/**
 * 复验：改完之后再跑一遍。
 *
 * @returns `{ ok, before, after, remaining, improved }`。
 *   `ok` 只表示「检查跑完了」，**不表示改干净了** —— 干净与否看 `remaining`。
 */
export function verify(beforeText, afterText, options = {}) {
  const before = detect(beforeText, options)
  const after = detect(afterText, options)
  const beforeChars = countChars(plainText(beforeText))
  const afterChars = countChars(plainText(afterText))
  return {
    ok: true,
    before: { hits: before.totalHits, violations: before.violations.length, chars: beforeChars, shortRatio: before.stats.short_ratio },
    after: { hits: after.totalHits, violations: after.violations.length, chars: afterChars, shortRatio: after.stats.short_ratio },
    remaining: after.violations,
    rhythm: after.rhythm,
    // 去味应该越改越少；变多了要提醒（多半是改写时引入了新毛病）
    improved: after.totalHits <= before.totalHits,
    charDelta: afterChars - beforeChars,
  }
}

/**
 * 生成 change_log。
 *
 * 要求写的是「只列改动类型，不列解释」。所以这里输出的是**计数**，
 * 不是一段说明文字。
 */
export function changeLog(beforeText, afterText, options = {}) {
  const v = verify(beforeText, afterText, options)
  const lines = []
  if (v.before.violations > 0 || v.after.violations > 0) {
    lines.push(`命中条目：${v.before.hits} → ${v.after.hits}`)
  }
  if (v.before.shortRatio !== v.after.shortRatio) {
    lines.push(`短句占比：${v.before.shortRatio} → ${v.after.shortRatio}`)
  }
  if (v.charDelta !== 0) {
    lines.push(`字数：${v.charDelta > 0 ? '+' : ''}${v.charDelta}`)
  }
  return {
    ...v,
    lines,
    cleaned: v.after.hits === 0 && (v.rhythm === null),
  }
}
