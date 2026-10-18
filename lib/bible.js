/**
 * dsh-writing-slots — 上游模块：世界观与人物。
 *
 * 规格里这两块的要求是「不要一次『生成』，要『逼出代价』」。所以它们不只是
 * 提示词模板，还配了**结构校验**：
 *
 *   - 力量体系**必须**写明使用代价与限制 —— 这是规格里加粗的那句。
 *     一个没有代价的力量体系，写起来必然悬浮。
 *   - 人物必须有「表面欲望 / 真实需求 / 致命缺陷」三项，且**三者之间要冲突**。
 *     光有名字年龄外貌的角色撑不起剧情。
 *
 * 校验在这里的意义和别处一样：模型很容易交出一份「看起来完整」的东西，
 * 缺项可能被它自己圆过去。代码查一遍，缺什么说什么。
 *
 * @module dsh-writing-slots/bible
 */

/** 力量体系必须体现的两个词。没有它们基本可以断定没写代价。 */
const COST_WORDS = /(代价|成本|付出|损耗|反噬|折寿|代价|消耗)/
const LIMIT_WORDS = /(限制|上限|不能|无法|禁止|界限|边界|除非|只有.*才)/

/** 世界观必需章节。 */
export const WORLD_SECTIONS = [
  { id: 'basics', title: '基础设定', pattern: /#{2,4}\s*基础设定/ },
  { id: 'power', title: '力量体系', pattern: /#{2,4}\s*力量体系/ },
  { id: 'society', title: '社会结构', pattern: /#{2,4}\s*社会结构/ },
  { id: 'events', title: '重大事件', pattern: /#{2,4}\s*(近百年|重大事件)/ },
  { id: 'hidden', title: '隐藏规则', pattern: /#{2,4}\s*隐藏规则/ },
  { id: 'daily', title: '日常场景', pattern: /#{2,4}\s*(普通人|日常场景)/ },
  { id: 'selfcheck', title: '自检', pattern: /#{2,4}\s*自检/ },
]

/** 人物必需字段。 */
export const CHARACTER_FIELDS = [
  { id: 'surface', title: '表面欲望', pattern: /(表面欲望|他以为(自己)?想要|她以为(自己)?想要|表面上)/ },
  { id: 'need', title: '真实需求', pattern: /(真实需求|真正需要|没意识到的需求)/ },
  { id: 'flaw', title: '致命缺陷', pattern: /(致命缺陷|性格缺陷|缺陷)/ },
  { id: 'soliloquy', title: '内心独白', pattern: /(内心独白|独白)/ },
  { id: 'trauma', title: '过往创伤', pattern: /(过往创伤|创伤|往事)/ },
  { id: 'behaviors', title: '标志行为', pattern: /(标志行为|愤怒.*恐惧.*狂喜|情绪.*行为)/ },
]

/** 数一段文字的字数（汉字 + 英文词 + 数字）。 */
function countCharsLocal(text) {
  const s = String(text ?? '')
  const han = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  const words = (s.match(/[A-Za-z]+/g) ?? []).length
  return han + words
}

/** 按 `##` 级标题切成小节，返回 `{ title, body }[]`。 */
export function splitSections(md) {
  const s = String(md ?? '')
  const out = []
  const re = /^(#{2,4})\s*(.+?)\s*$/gm
  const marks = []
  let m
  while ((m = re.exec(s)) !== null) marks.push({ level: m[1].length, title: m[2], at: m.index, end: re.lastIndex })
  for (let i = 0; i < marks.length; i += 1) {
    const cur = marks[i]
    const stop = i + 1 < marks.length ? marks[i + 1].at : s.length
    out.push({ level: cur.level, title: cur.title, body: s.slice(cur.end, stop).trim() })
  }
  return out
}

/**
 * 校验世界观的输出。
 *
 * @param markdown 模型交回的世界观文档。
 * @param options `{ minSectionChars, minHidden }`。
 */
export function validateWorld(markdown, options = {}) {
  const md = String(markdown ?? '')
  const minChars = options.minSectionChars ?? 100
  const minHidden = options.minHidden ?? 2
  const errors = []
  const warnings = []

  if (md.trim() === '') return { ok: false, errors: ['内容为空'], warnings: [], sections: [] }

  const sections = splitSections(md)
  const found = {}
  for (const need of WORLD_SECTIONS) {
    const hit = sections.find((sec) => need.pattern.test(`## ${sec.title}`))
    if (hit === undefined) { errors.push(`缺章节：${need.title}`); continue }
    found[need.id] = hit
    // 每维度 150—300 字是规格里的要求；给个宽容下限（100）以免误杀
    if (countCharsLocal(hit.body) < minChars) {
      warnings.push(`${need.title} 只有 ${countCharsLocal(hit.body)} 字，规格要求 150—300 字`)
    }
  }

  // 力量体系必须写明代价与限制 —— 规格里加粗的那条
  if (found.power !== undefined) {
    const body = found.power.body
    if (!COST_WORDS.test(body)) errors.push('力量体系没写「使用代价」——规格要求必须写明')
    if (!LIMIT_WORDS.test(body)) errors.push('力量体系没写「限制」——规格要求必须写明')
  }

  // 隐藏规则至少两条
  if (found.hidden !== undefined) {
    const items = found.hidden.body.split('\n').filter((l) => /^\s*([-*\d]|第)/.test(l))
    const n = items.length
    if (n < minHidden) errors.push(`隐藏规则只列了 ${n} 条，规格要求至少 ${minHidden} 条`)
  }

  // 日常场景三个
  if (found.daily !== undefined) {
    const items = found.daily.body.split('\n').filter((l) => /^\s*([-*\d]|第|场景)/.test(l))
    if (items.length > 0 && items.length < 3) errors.push(`日常场景只列了 ${items.length} 个，规格要求三个`)
  }

  // 自检必须真的提出疑问（规格：有没有「我自己也解释不清楚」的部分）
  if (found.selfcheck !== undefined && countCharsLocal(found.selfcheck.body) < 10) {
    warnings.push('自检一节太短，看着像走过场')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sections: Object.keys(found),
    stats: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, countCharsLocal(v.body)])),
  }
}

/**
 * 校验人物设计。
 *
 * 关键一条：表面欲望 / 真实需求 / 致命缺陷 **三者必须冲突**。
 * 冲突无法自动判定（那是理解题），所以代码查的是**三者都在**，
 * 并把「互相冲突」作为硬性约束写进提示词；同时在结果里提示人重点看这一条。
 */
export function validateCharacter(markdown, options = {}) {
  const md = String(markdown ?? '')
  const errors = []
  const warnings = []
  if (md.trim() === '') return { ok: false, errors: ['内容为空'], warnings: [], fieldsFound: [] }

  const fieldsFound = []
  for (const f of CHARACTER_FIELDS) {
    if (f.pattern.test(md)) fieldsFound.push(f.id)
    else errors.push(`缺字段：${f.title}`)
  }

  // 内心独白约 100 字
  const solo = /(内心独白|独白)[^\n]*\n+([\s\S]{0,600}?)(?=\n#{2,4}\s|\n\*\*[^*]+\*\*\s*[:：]|$)/.exec(md)
  if (solo !== null) {
    const n = countCharsLocal(solo[2])
    // 给宽容区间：60—160 都算「约 100 字」
    if (n < 60) warnings.push(`内心独白只有 ${n} 字，规格要求约 100 字`)
    else if (n > 160) warnings.push(`内心独白有 ${n} 字，规格要求约 100 字`)
  }

  // 三档情绪的标志行为
  const missingMood = ['愤怒', '恐惧', '狂喜'].filter((m) => !md.includes(m))
  if (missingMood.length > 0) errors.push(`标志行为缺情绪档位：${missingMood.join('、')}`)

  // 创伤要冷静笔触，不煽情 —— 出现高强度抒情词就提醒
  const traumaSec = splitSections(md).find((s) => /创伤/.test(s.title))
  if (traumaSec !== undefined && /(痛不欲生|撕心裂肺|万念俱灰|生不如死)/.test(traumaSec.body)) {
    warnings.push('「过往创伤」一节出现了高强度抒情词，规格要求冷静笔触、不煽情')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fieldsFound,
    // 这一条自动判不了，交给人看
    needsHumanCheck: '表面欲望 / 真实需求 / 致命缺陷 三者之间是否真的冲突 —— 这条机器判不了，需要人读一遍。',
  }
}
