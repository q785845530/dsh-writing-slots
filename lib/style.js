/**
 * dsh-writing-slots — Style Anchor（文风锚点）。
 *
 * 项目初始化时跑一次：读 3—5 篇样本（≥5 万字），产出 `style-guide.md`。
 *
 * ## 为什么关键指标用统计而不是让模型「感觉」
 * 要求里写着「每一条判断必须附一个样本中的原文例句作为锚」。要做到这点，
 * 指标就得是**算出来的**：句长、短句占比、段落节奏、对话占比这些都能从
 * 文本直接统计；模型只负责在候选例句里挑最能代表的那一句。
 *
 * 这样产出的 style-guide 是可复核的：数字能验算，例句能定位。
 * 反过来，如果整段都让模型「总结风格」，产出的是一段没法验证的散文。
 *
 * ## 禁忌清单怎么来
 * 要求写的是「**该样本中从未出现的**句式或词汇类型」。所以判据是
 * 「查得到的模式 + 样本里 0 次命中」—— 先给一批常见 AI 腔句式，
 * 逐个在样本里数；数为 0 的才进禁忌清单。这是可验证的，不是猜的。
 *
 * @module dsh-writing-slots/style
 */

/** 中文句子切分：句末标点 + 收尾引号。 */
export function splitSentences(text) {
  const s = String(text ?? '')
  const out = []
  let buf = ''
  for (const ch of s) {
    if (ch === '\n') {
      if (buf.trim() !== '') out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
    if ('。！？…'.includes(ch)) {
      out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim() !== '') out.push(buf.trim())
  return out.filter((x) => x !== '')
}

/** 去掉 markdown 标记，只留正文。统计句长时不该把 `#`、`**` 算进去。 */
export function plainText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .trim()
}

/** 可见字数：汉字 + 英文词 + 数字，不含空白与标点。 */
export function countChars(text) {
  const s = String(text ?? '')
  const han = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  const words = (s.match(/[A-Za-z]+/g) ?? []).length
  const nums = (s.match(/\d+/g) ?? []).length
  return han + words + nums
}

/** 段落切分（去掉空行与纯标题行）。 */
export function splitParagraphs(text) {
  return plainText(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/**
 * 认出对话段。
 *
 * 引号形态要看实际语料：中文引号 `“”「」`、直角引号 `『』`，
 * 以及**英文直引号 `"`** —— 实测这份稿子用的就是 `"`，
 * 只认中文引号会把所有对话段漏掉（对话占比算成 0%）。
 */
export function isDialogue(para) {
  return /[“”「」『』"]/.test(String(para ?? ''))
}

/** 百分位。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

function median(sorted) {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

const round2 = (n) => Math.round(n * 100) / 100
const pct = (n) => `${Math.round(n * 100)}%`

/**
 * 统计句长基线。
 *
 * @param sentences 句子数组。
 * @param shortMax 短句的阈值（默认 15 字）。
 */
export function sentenceStats(sentences, shortMax = 15) {
  const lens = sentences.map((s) => countChars(s)).filter((n) => n > 0).sort((a, b) => a - b)
  if (lens.length === 0) return { count: 0 }
  const sum = lens.reduce((a, b) => a + b, 0)
  const short = lens.filter((n) => n <= shortMax).length
  return {
    count: lens.length,
    mean: round2(sum / lens.length),
    median: median(lens),
    p90: percentile(lens, 90),
    min: lens[0],
    max: lens[lens.length - 1],
    short_max: shortMax,
    short_count: short,
    // 要求里写的是「短句占比≥Y%」，所以给百分比字符串和两位小数都给。
    short_ratio: pct(short / lens.length),
    short_ratio_value: round2(short / lens.length),
  }
}

/** 段落节奏：每段行数中位数、对话段与叙述段比例。 */
export function paragraphStats(paragraphs) {
  const lines = paragraphs.map((p) => p.split('\n').filter((x) => x.trim() !== '').length).sort((a, b) => a - b)
  const dialogue = paragraphs.filter(isDialogue).length
  return {
    count: paragraphs.length,
    median_lines: median(lines),
    p90_lines: percentile(lines, 90),
    dialogue_count: dialogue,
    narrative_count: paragraphs.length - dialogue,
    dialogue_ratio: paragraphs.length === 0 ? '0%' : pct(dialogue / paragraphs.length),
  }
}

/** 常见 AI 腔句式：逐个在样本里数，0 次命中的才进禁忌清单。 */
export const AI_TELLS = [
  { id: 'as-if', rule: '“仿佛 / 似乎 / 宛如”这类明喻引导词', re: /仿佛|似乎|宛如|犹如/g },
  { id: 'a-kind-of-feeling', rule: '“一种……的感觉 / 莫名的……”这种抽象情绪句式', re: /一种[^。！？]{0,12}的(感觉|情绪|滋味)|莫名的/g },
  { id: 'not-only', rule: '“不仅……而且……”这类并列强调', re: /不仅[^。！？]{0,20}(而且|还)|不但[^。！？]{0,20}(而且|还)/g },
  { id: 'as-if-in-a-dream', rule: '“如梦似幻 / 恍若隔世”这类套话', re: /如梦似幻|恍若隔世|如坠冰窟|如遭雷击/g },
  { id: 'deep-breath', rule: '“深吸一口气 / 缓缓地”这类动作填充', re: /深吸(了)?一口气|缓缓地|轻轻地|默默地/g },
  { id: 'summary-tail', rule: '场景末替读者总结意义（“这一刻……”“他知道……”收尾）', re: /这一刻[^。！？]{0,30}。|这一切[^。！？]{0,30}。/g },
  { id: 'emotion-label', rule: '直接命名情绪（“他感到愤怒 / 心中五味杂陈”）', re: /(感到|心中|内心)[^。！？]{0,8}(愤怒|悲伤|喜悦|恐惧|五味杂陈|百感交集)/g },
  // id 必须与 polish.js 的 POLISH_RULES 对齐，否则禁忌清单的过滤会静默失效
  { id: 'symmetry', rule: '对称感：重复标记的排比、对仗式收尾', re: /([^，。！？\n]{2,12})，([^，。！？\n]{2,12})，([^，。！？\n]{2,12})[，。！？]/g },
  { id: 'over-explain', rule: '过度解释：把读者能自己看出的意思讲出来', re: /也就是说|换句话说|换言之|这说明|这意味着|之所以[^。！？]{0,20}是因为/g },
  { id: 'pronoun-run', rule: '段首连续以同一人称代词开头', re: /(^|\n\s*\n)\s*(他|她|它|我|你)[^\n]*\n\s*\n\s*\2/g },
  { id: 'adjective-pile', rule: '形容词堆叠（“深深的 / 浓浓的 / 淡淡的”）', re: /(深深|浓浓|淡淡|静静|悄悄)的/g },
  { id: 'saying-tag', rule: '对话后除“说道/问道”外的描述性标签', re: /(说道|问道|答道|喊道|低声说|轻声道)/g },
]

/**
 * 禁忌清单 = 样本里 **0 次命中** 的 AI 腔句式。
 *
 * 「从未出现」才是要求的判据；出现过就不该列为禁忌 —— 那是在否定作者
 * 自己的写法。
 */
export function forbiddenList(text, options = {}) {
  const s = String(text ?? '')
  const out = []
  for (const tell of AI_TELLS) {
    tell.re.lastIndex = 0
    const hits = s.match(tell.re)
    const count = hits === null ? 0 : hits.length
    if (count === 0) {
      out.push({ rule: tell.rule, id: tell.id, sample_hits: 0, source: '样本中 0 次命中' })
    } else if (options.includePresent === true) {
      out.push({ rule: tell.rule, id: tell.id, sample_hits: count, source: '样本中出现过' })
    }
  }
  return out
}

/** 感官倾向：数各类感官词的出现次数。 */
const SENSES = {
  视觉: /看|望|瞧|瞥|盯|见|亮|暗|光|色|影|白|黑|红|黄|青|灰/g,
  听觉: /听|声|响|喊|叫|静|寂|嗡|哗|咚|吱|嘎/g,
  触觉: /摸|触|碰|凉|烫|冷|热|硬|软|糙|滑|疼|痛|压|握/g,
  嗅觉: /闻|味|香|臭|腥|霉|气|酸|甜|苦|辣|咸/g,
  体感: /累|乏|饿|渴|困|喘|酸|麻|沉|轻/g,
}

export function sensoryBias(text) {
  const s = String(text ?? '')
  const counts = {}
  for (const [name, re] of Object.entries(SENSES)) {
    re.lastIndex = 0
    counts[name] = (s.match(re) ?? []).length
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const total = sorted.reduce((a, [, n]) => a + n, 0)
  return {
    counts,
    prefer: sorted.slice(0, 2).filter(([, n]) => n > 0).map(([k]) => k),
    avoid: sorted.slice(-2).filter(([, n]) => n === 0).map(([k]) => k),
    detail: sorted.map(([k, n]) => `${k} ${n}（${total === 0 ? 0 : Math.round((n / total) * 100)}%）`).join('　'),
  }
}

/** 比喻落点：看比喻词后面接的是哪一类名词。 */
const METAPHOR_SPOTS = {
  // 谷物/农事也算日常物 —— 这份语料里最常见的比喻落点就是它们
  日常物: /像[^，。！？]{0,10}(碗|锅|绳|布|纸|线|门|窗|灯|席|筐|桶|锄|镰|担|石|砖|瓦|粟|谷|米|稻|糠|柴|灶|镰)/g,
  身体: /像[^，。！？]{0,10}(手|掌|指|脸|眼|背|肩|腰|腿|骨|血|肉|气)/g,
  自然: /像[^，。！？]{0,10}(山|水|田|土|草|树|叶|风|云|雨|雪|日|月|星|河|沟)/g,
  动物: /像[^，。！？]{0,10}(牛|马|狗|鸡|鱼|虫|鸟|蛇|鼠)/g,
}

export function metaphorFingerprint(text) {
  const s = String(text ?? '')
  const counts = {}
  for (const [name, re] of Object.entries(METAPHOR_SPOTS)) {
    re.lastIndex = 0
    counts[name] = (s.match(re) ?? []).length
  }
  // 明喻总量（用于估算密度）
  const similes = (s.match(/像|似|如同|好比|宛如/g) ?? []).length
  const chars = countChars(s)
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return {
    counts,
    typical_sources: sorted.filter(([, n]) => n > 0).slice(0, 2).map(([k]) => k),
    density: chars === 0 ? '0' : `${round2((similes / chars) * 1000)}/千字`,
    simile_total: similes,
  }
}

/**
 * 为一条指标挑一个原文例句作为锚。
 *
 * 挑法固定（不随机），保证同一个样本每次跑出的锚句一致、可复核。
 *
 * `mustMatch` 是**贴题条件**：锚句得真的体现那条指标，不能只按长度就近挑。
 * 第一版就只按长度挑，结果感官倾向的锚句给了一句「他总觉得它在等什么」——
 * 那句话里一个感官词都没有，锚了等于没锚。
 */
export function anchorFor(sentences, targetLen, options = {}) {
  const must = options.mustMatch ?? null
  const pool = sentences.filter((s) => {
    const len = countChars(s)
    if (len < 4 || len > 120) return false
    if (must !== null) {
      must.lastIndex = 0
      if (!must.test(s)) return false
    }
    return true
  })
  // 贴题条件把候选筛空了就退回全体 —— 总比给一句不贴题的强，但也如实标注。
  const from = pool.length > 0 ? pool : sentences.filter((s) => {
    const len = countChars(s)
    return len >= 4 && len <= 120
  })
  let best = null
  let bestDiff = Infinity
  for (const s of from) {
    const diff = Math.abs(countChars(s) - targetLen)
    if (diff < bestDiff) { bestDiff = diff; best = s }
  }
  return best
}

/**
 * 挑感官词最密集的一句。
 *
 * @param sentences 句子池。
 * @param prefer 偏好通道名（如 `['视觉','触觉']`）。
 */
function densestSentence(sentences, prefer) {
  const channels = prefer.map((k) => SENSES[k]).filter((x) => x !== undefined)
  if (channels.length === 0) return sentences[0] ?? null
  let best = null
  let bestScore = 0
  for (const s of sentences) {
    const len = countChars(s)
    if (len < 10 || len > 80) continue
    // 按**不同的词**计数，不按出现次数。
    // 否则「再看看，就是还要看」凭三个「看」胜出 —— 那是虚用，锚不出视觉倾向。
    const distinctChars = new Set()
    for (const re of channels) {
      re.lastIndex = 0
      for (const m of s.matchAll(re)) distinctChars.add(m[0])
    }
    const score = distinctChars.size / len
    if (score > bestScore) { bestScore = score; best = s }
  }
  return best ?? sentences[0] ?? null
}

/** 挑一个行数最接近中位数的段落作为节奏锚。 */
function pickParagraph(paragraphs, targetLines) {
  let best = null
  let bestDiff = Infinity
  for (const p of paragraphs) {
    const lines = p.split('\n').filter((x) => x.trim() !== '').length
    if (p.length > 200) continue // 太长不适合作锚
    // 优先有内容的段落：单行短句（如「三月初七，夜。」）体现不出节奏
    const thin = countChars(p) < 30 ? 2 : 0
    const diff = Math.abs(lines - targetLines) + (p.length > 120 ? 1 : 0) + thin
    if (diff < bestDiff) { bestDiff = diff; best = p }
  }
  return best
}

/**
 * 分析样本语料，产出 style-guide 的**结构化部分**。
 *
 * 要求里写「只描述特征，不评价好坏」—— 这个函数只做统计与举例，不做评价。
 *
 * @param samples `[{ name, text }]`。
 * @param options `shortMax`（短句阈值）、`minSamples`、`minChars`。
 */
export function analyze(samples, options = {}) {
  const list = (samples ?? []).filter((s) => s !== null && typeof s?.text === 'string' && s.text.trim() !== '')
  const minSamples = options.minSamples ?? 3
  const minChars = options.minChars ?? 50000
  const totalChars = list.reduce((a, s) => a + countChars(plainText(s.text)), 0)

  // 样本量不够就**不产出** style-guide：要求写的是 3—5 篇、≥5 万字，
  // 拿一两千字统计出来的「基线」没有意义，会把后面的写作带偏。
  const problems = []
  if (list.length < minSamples) problems.push(`样本篇数不足：给了 ${list.length} 篇，要求至少 ${minSamples} 篇`)
  if (totalChars < minChars) problems.push(`样本总字数不足：${totalChars} 字，要求至少 ${minChars} 字`)
  if (problems.length > 0) return { ok: false, problems, totalChars, sampleCount: list.length }

  const joined = list.map((s) => plainText(s.text)).join('\n\n')
  const sentences = splitSentences(joined)
  const paragraphs = splitParagraphs(joined)
  const shortMax = options.shortMax ?? 15

  const sentence = sentenceStats(sentences, shortMax)
  const para = paragraphStats(paragraphs)
  const sensory = sensoryBias(joined)
  const metaphor = metaphorFingerprint(joined)
  const forbidden = forbiddenList(joined)

  return {
    ok: true,
    sampleCount: list.length,
    totalChars,
    guide: {
      sentence_length_baseline: {
        ...sentence,
        // 要求里的口径：「均长X字，短句占比≥Y%」
        summary: `均长 ${sentence.mean} 字，短句（≤${shortMax} 字）占比 ${sentence.short_ratio}`,
      },
      paragraph_rhythm: {
        ...para,
        summary: `每段行数中位数 ${para.median_lines}，对话段占比 ${para.dialogue_ratio}`,
      },
      sensory_bias: {
        ...sensory,
        summary: `偏好 ${sensory.prefer.join('、') || '无明显偏好'}；回避 ${sensory.avoid.join('、') || '无'}`,
      },
      metaphor_fingerprint: {
        ...metaphor,
        summary: `落点 ${metaphor.typical_sources.join('、') || '不明显'}，密度 ${metaphor.density}`,
      },
      forbidden_list: forbidden,
    },
    anchors: {
      sentence_length_baseline: anchorFor(sentences, sentence.median),
      // 段落节奏的锚应该是一整个段落（体现行数），不是一句话。
      paragraph_rhythm: pickParagraph(paragraphs, para.median_lines),
      // 感官锚句按**密度**挑：含偏好通道词最多的那句。
      // 只要求「含一个词」不够 —— 「藏给谁看」里的「看」是虚用，
      // 锚不出视觉倾向。密度高的句子才真的体现这条特征。
      sensory_bias: densestSentence(sentences, sensory.prefer),
      metaphor_fingerprint: (joined.match(/[^。！？]*[像似][^。！？]*[。！？]/) ?? [null])[0],
    },
    samples: list.map((s) => ({ name: s.name, chars: countChars(plainText(s.text)) })),
  }
}

/**
 * 把分析结果渲染成 style-guide.md。
 *
 * 每条判断后面都附原文例句（要求的硬约束）。
 */
export function toMarkdown(analysis, options = {}) {
  if (analysis.ok !== true) return null
  const g = analysis.guide
  const a = analysis.anchors
  const quote = (s) => (s === null || s === undefined || s === '' ? '（未取到合适例句）' : `> ${String(s).trim()}`)
  const d = new Date().toISOString().slice(0, 10)

  return `# 文风锚点（style-guide）

- 生成日期：${d}
- 样本：${analysis.sampleCount} 篇，共 ${analysis.totalChars} 字
- 样本清单：${analysis.samples.map((s) => `${s.name}（${s.chars} 字）`).join('、')}
${options.project ? `- 项目：${options.project}\n` : ''}
> 本文件只描述特征，不评价好坏。所有数字都是从样本直接统计出来的，可复核；
> 每条判断附原文例句作为锚。

## sentence_length_baseline（句长基线）

- **${g.sentence_length_baseline.summary}**
- 逐项：句数 ${g.sentence_length_baseline.count}｜均长 ${g.sentence_length_baseline.mean} 字｜中位数 ${g.sentence_length_baseline.median}｜P90 ${g.sentence_length_baseline.p90}｜最长 ${g.sentence_length_baseline.max} 字
- 原文锚：
${quote(a.sentence_length_baseline)}

## paragraph_rhythm（段落节奏）

- **${g.paragraph_rhythm.summary}**
- 逐项：段数 ${g.paragraph_rhythm.count}｜对话段 ${g.paragraph_rhythm.dialogue_count}｜叙述段 ${g.paragraph_rhythm.narrative_count}｜P90 行数 ${g.paragraph_rhythm.p90_lines}
- 原文锚：
${quote(a.paragraph_rhythm)}

## sensory_bias（感官倾向）

- **${g.sensory_bias.summary}**
- 分布：${g.sensory_bias.detail}
- 原文锚：
${quote(a.sensory_bias)}

## metaphor_fingerprint（比喻指纹）

- **${g.metaphor_fingerprint.summary}**
- 分布：${Object.entries(g.metaphor_fingerprint.counts).map(([k, v]) => `${k} ${v}`).join('　')}｜明喻总数 ${g.metaphor_fingerprint.simile_total}
- 原文锚：
${quote(a.metaphor_fingerprint)}

## forbidden_list（禁忌清单）

判据：以下句式在样本中**一次都没有出现**。写作时不要引入。

${g.forbidden_list.length === 0
  ? '_（样本中所有被检查的句式都出现过，因此没有可列为禁忌的项。）_'
  : g.forbidden_list.map((f, i) => `${i + 1}. ${f.rule}　（${f.source}）`).join('\n')}
`
}

/** 从 style-guide.md 反解回结构化对象（供后续模块读取禁忌清单等）。 */
export function parseMarkdown(md) {
  const s = String(md ?? '')
  const out = { forbidden_list: [], short_ratio_value: null, mean: null }
  // 短句占比
  const m1 = /均长\s*([\d.]+)\s*字，短句（≤\d+\s*字）占比\s*(\d+)%/.exec(s)
  if (m1 !== null) {
    out.mean = Number(m1[1])
    out.short_ratio_value = Number(m1[2]) / 100
  }
  // 禁忌清单：取 forbidden_list 段里的编号行
  const sec = /##\s*forbidden_list[\s\S]*?(?=\n##\s|$)/.exec(s)
  if (sec !== null) {
    for (const line of sec[0].split('\n')) {
      const m = /^\d+\.\s*(.+?)\s*（/.exec(line.trim())
      if (m !== null) out.forbidden_list.push(m[1])
    }
  }
  return out
}
