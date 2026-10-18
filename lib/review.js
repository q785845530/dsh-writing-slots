/**
 * dsh-writing-slots — Review Pass（审稿通道）的契约校验。
 *
 * 要求里最关键的一条是 **`CONTEXT_ISOLATION: true`**：审稿要在「不知道作者
 * 是谁」的独立上下文里跑，避免护短。这不是一句口号，得在代码层面保证：
 *
 *   1. 渲染审稿提示词时**只允许** draft / bible_snapshot / prev_summary 三个
 *      槽位。别的一律拒绝 —— 包括 style-guide。理由很直接：审稿看的是
 *      「人物崩没崩、事实矛盾没有」，不是「文风像不像」。把 style-guide
 *      塞进去，审稿就会开始点评文笔，而要求明说「不评价文笔好坏」。
 *   2. 输出强制 JSON，且逐条查字段 —— 散文式的编辑意见没法按 severity
 *      过滤，也没法定位到段落。
 *
 * @module dsh-writing-slots/review
 */

/** 四个检查维度。 */
export const DIMENSIONS = [
  'character_consistency',
  'factual_contradiction',
  'information_density',
  'hook_effectiveness',
]

/** 三色灯。 */
export const SEVERITIES = ['fatal', 'warning', 'pass']

/** 审稿**只允许**看到这三样。多一样都算破坏隔离。 */
export const ISOLATION_ALLOWLIST = ['draft', 'bible_snapshot', 'prev_summary']

/** 交付给审稿模块的槽位声明（写死在代码里，不受调用方影响）。 */
export const REVIEW_CONTRACT = {
  required: ['draft'],
  auto_injected: ['bible_snapshot', 'prev_summary'],
  optional: [],
}

/**
 * 检查调用方给的槽位有没有越过隔离边界。
 *
 * @returns `{ ok, offending }`：`offending` 是越界的槽位名。
 */
export function checkIsolation(data) {
  const keys = Object.keys(data ?? {})
  const offending = keys.filter((k) => !ISOLATION_ALLOWLIST.includes(k))
  return { ok: offending.length === 0, offending, allowed: ISOLATION_ALLOWLIST }
}

/**
 * 非原子的修改指令。
 *
 * 要求明写「不给出『建议重写整章』这类非原子指令」。判据是**能不能落地
 * 到一个具体位置**：能指到段落/句子的才算原子。
 */
const NON_ATOMIC = [
  /重写整章/, /整体重写/, /推翻重来/, /全部重写/, /大改一遍/,
  /建议重新(写|构思)/, /推倒重来/,
]

/** 整体评语（要求说不输出）。 */
const OVERALL_COMMENT = [
  /整体(来|上)?(说|看)/, /全文(来|上)?(说|看)/, /通篇/, /总的来说/, /总体而言/,
  /文笔(不错|很好|一般|欠佳)/, /写得(不错|很好|一般)/,
]

/**
 * 校验审稿输出。
 *
 * @param payload 模型返回的东西：可以是数组，也可以是 `{findings: [...]}`。
 * @returns `{ ok, findings, errors, stats }`。
 */
export function validateFindings(payload) {
  let list = null
  if (Array.isArray(payload)) list = payload
  else if (payload !== null && typeof payload === 'object' && Array.isArray(payload.findings)) list = payload.findings
  else if (typeof payload === 'string') {
    // 允许传 JSON 字符串：模型经常带 markdown 代码块
    const cleaned = payload.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    try {
      const parsed = JSON.parse(cleaned)
      return validateFindings(parsed)
    } catch {
      return { ok: false, errors: ['输出不是合法 JSON'], findings: [], stats: null }
    }
  }

  if (list === null) {
    return { ok: false, errors: ['输出既不是数组，也不是 {findings: [...]}'], findings: [], stats: null }
  }

  const errors = []
  const findings = []
  list.forEach((raw, i) => {
    const at = `第 ${i + 1} 条`
    if (raw === null || typeof raw !== 'object') { errors.push(`${at}：不是对象`); return }
    const { dimension, severity, location, finding, action } = raw

    if (!DIMENSIONS.includes(dimension)) {
      errors.push(`${at}：dimension 必须是 ${DIMENSIONS.join(' / ')}（给了 ${JSON.stringify(dimension)}）`)
    }
    if (!SEVERITIES.includes(severity)) {
      errors.push(`${at}：severity 必须是 ${SEVERITIES.join(' / ')}（给了 ${JSON.stringify(severity)}）`)
    }
    // pass 项不需要 location/action（没问题就没得定位）
    const needDetail = severity !== 'pass'
    if (needDetail && (typeof location !== 'string' || location.trim() === '')) {
      errors.push(`${at}：${severity} 必须给 location（定位到段落或句子）`)
    }
    if (typeof finding !== 'string' || finding.trim() === '') {
      errors.push(`${at}：缺 finding（具体问题）`)
    }
    if (needDetail && (typeof action !== 'string' || action.trim() === '')) {
      errors.push(`${at}：${severity} 必须给 action（可操作的修改方向）`)
    }

    const text = `${finding ?? ''} ${action ?? ''}`
    for (const re of NON_ATOMIC) {
      if (re.test(text)) errors.push(`${at}：出现非原子指令（${re.source}）—— 要求只给能定位到具体段落的修改方向`)
    }
    for (const re of OVERALL_COMMENT) {
      if (re.test(String(finding ?? ''))) errors.push(`${at}：finding 里出现整体评语（${re.source}）—— 要求只描述具体问题`)
    }

    findings.push({
      dimension, severity,
      location: typeof location === 'string' ? location.trim() : null,
      finding: String(finding ?? '').trim(),
      action: typeof action === 'string' ? action.trim() : null,
    })
  })

  const stats = {
    total: findings.length,
    fatal: findings.filter((f) => f.severity === 'fatal').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    pass: findings.filter((f) => f.severity === 'pass').length,
    byDimension: Object.fromEntries(DIMENSIONS.map((d) => [d, findings.filter((f) => f.dimension === d).length])),
  }

  // 门禁结论：有 fatal 就打回（多智能体质检里已验证的三色灯规则）。
  const verdict = stats.fatal > 0 ? 'reject' : (stats.warning > 0 ? 'revise' : 'pass')

  return {
    ok: errors.length === 0,
    errors,
    findings,
    stats,
    verdict,
    // 哪些维度压根没查（漏查比查出错更危险）
    uncovered: DIMENSIONS.filter((d) => stats.byDimension[d] === 0),
  }
}

/** 按 severity 过滤（要求里说「后续可以接脚本按 severity 过滤」）。 */
export function filterBySeverity(findings, severities) {
  const want = new Set(severities ?? [])
  return (findings ?? []).filter((f) => want.has(f.severity))
}

/** 把问题清单渲染成可读的逐条列表（给人看）。 */
export function formatFindings(findings) {
  const icon = { fatal: '⛔', warning: '⚠', pass: '✓' }
  return (findings ?? []).map((f) => {
    const loc = f.location === null ? '' : `｜${f.location}`
    const act = f.action === null ? '' : `\n    改法：${f.action}`
    return `${icon[f.severity] ?? '?'} [${f.severity}] ${f.dimension}${loc}\n    问题：${f.finding}${act}`
  }).join('\n')
}
