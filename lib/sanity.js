/**
 * dsh-writing-slots — 确定性检查（写后必过）。
 *
 * 这几项**不需要模型判断**，纯规则就能查出来，所以放在渲染之前当门禁跑：
 * 头部项目（Oh Story 7717★）把它叫「写后检查截断、工程词和常见 AI 句式」。
 *
 * 三项的共同点：**读者一眼看出、作者常常看不见**。
 *
 *   1. **截断** —— 生成被掐断，最后一句没有收尾。这是最伤的一种：
 *      读者读到一半突然没了，比写得差更劝退。
 *   2. **工程词泄漏** —— 大纲/字段/提示词里的词跑进了正文
 *      （「本章」「伏笔」「爽点」「信息差」「压力档位」…）。
 *      这是插件化写作特有的翻车方式，人工读稿时反而容易漏。
 *   3. **占位符残留** —— `{槽位}`、`TODO`、`XXX` 没被替换。
 *
 * @module dsh-writing-slots/sanity
 */

/** 句末标点。结尾没有它们基本可以判定没收尾。 */
const SENTENCE_END = /[。！？…”」』）)]\s*$/

/** 工程词：这些词出现在**正文**里就是泄漏。 */
export const ENGINEERING_TERMS = [
  '本章任务', '本章', '伏笔', '爽点', '信息差', '压力档位', '共情锚点',
  '温度曲线', '欲望-障碍-代价', '槽位', '风格锚点', 'style-guide',
  '去 AI 味', '去AI味', '自检', 'TODO', 'FIXME',
]

/** 占位符残留。 */
const PLACEHOLDER = /\{[a-zA-Z_][\w.]*\}|\[\[[^\]]+\]\]|\bXXX+\b|\bTODO\b|\bFIXME\b/

/**
 * 跑一遍确定性检查。
 *
 * @param text 正文。
 * @param options `{ minChars, minTailChars, allowedTerms }`。
 *   `allowedTerms`：项目本来就在用的词（比如「伏笔」可能出现在人物对话里，
 *   由作者显式放行），避免一刀切误伤。
 */
export function check(text, options = {}) {
  const s = String(text ?? '')
  const issues = []
  const allowed = new Set(options.allowedTerms ?? [])

  // 1) 太短：多半是生成被掐断
  const minChars = options.minChars ?? 300
  if (s.trim() !== '' && s.length < minChars) {
    issues.push({
      id: 'too-short', severity: 'critical',
      detail: `正文只有 ${s.length} 字，低于 ${minChars} —— 很可能被掐断了`,
    })
  }

  // 2) 截断：结尾没有句末标点
  if (s.trim() !== '') {
    const tail = s.trimEnd()
    const tailChars = options.minTailChars ?? 12
    if (!SENTENCE_END.test(tail)) {
      issues.push({
        id: 'truncated', severity: 'critical',
        detail: `结尾没有句末标点，最后一段是「…${tail.slice(-tailChars)}」—— 像是没写完`,
      })
    }
  }

  // 3) 悬空的对话引号（开了没关）
  const straight = (s.match(/"/g) ?? []).length
  if (straight % 2 !== 0) {
    issues.push({ id: 'unclosed-quote', severity: 'critical', detail: '直引号数量是奇数，有一段对话没关上' })
  }
  const leftQuote = (s.match(/[「『]/g) ?? []).length
  const rightQuote = (s.match(/[」』]/g) ?? []).length
  if (leftQuote !== rightQuote) {
    issues.push({ id: 'unclosed-quote', severity: 'critical', detail: `「」/『』不配对（左 ${leftQuote}，右 ${rightQuote}）` })
  }

  // 4) 工程词泄漏
  const leaked = []
  for (const term of ENGINEERING_TERMS) {
    if (allowed.has(term)) continue
    if (s.includes(term)) leaked.push(term)
  }
  if (leaked.length > 0) {
    issues.push({
      id: 'engineering-leak', severity: 'warning',
      detail: `正文里出现工程词：${leaked.join('、')} —— 这些是给作者看的，不该进正文`,
    })
  }

  // 5) 占位符残留
  const ph = PLACEHOLDER.exec(s)
  if (ph !== null) {
    issues.push({ id: 'placeholder-left', severity: 'critical', detail: `占位符没被替换：${ph[0]}` })
  }

  const blocking = issues.filter((x) => x.severity === 'critical')
  return {
    ok: issues.length === 0,
    // 门禁：critical 一律阻断
    pass: blocking.length === 0,
    issues,
    chars: s.length,
  }
}

/** 渲染成给人看的一段话。 */
export function format(result) {
  if (result.ok === true) return `确定性检查通过（${result.chars} 字）。`
  const lines = [result.pass === true ? '有警告但不阻断：' : '检查未通过（有阻断项）：']
  for (const i of result.issues) lines.push(`- [${i.severity}] ${i.id}：${i.detail}`)
  return lines.join('\n')
}
