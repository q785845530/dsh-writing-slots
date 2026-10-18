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
  // —— 从分享里补的三条：都是可判定、不依赖「写得好不好」的 ——
  'empathy_test',          // 本章有没有一个瞬间让读者能对上自己的真实体验
  'info_gap_effectiveness',// 本章结束时读者知情状态有没有可指认的变化
  'voice_fingerprint',     // 抽三句对话去掉说话人标签，能否辨认是谁
]

/**
 * 严重度。
 *
 * 三色灯（fatal/warning/pass）保留兼容，另加高分辨率四档
 * （critical/high/medium/low）—— 分享里参考的 reviewer 设计用这四档，
 * 且 `severity=critical` 默认阻断。
 */
export const SEVERITIES = ['fatal', 'warning', 'pass', 'critical', 'high', 'medium', 'low']

/** 默认阻断的严重度。 */
export const BLOCKING = ['fatal', 'critical']

/** 分类。 */
export const CATEGORIES = ['character', 'pacing', 'continuity', 'prose']

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
export function validateFindings(payload, options = {}) {
  let list = null
  if (Array.isArray(payload)) list = payload
  else if (payload !== null && typeof payload === 'object' && Array.isArray(payload.findings)) list = payload.findings
  else if (typeof payload === 'string') {
    // 允许传 JSON 字符串：模型经常带 markdown 代码块
    const cleaned = payload.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    try {
      const parsed = JSON.parse(cleaned)
      return validateFindings(parsed, options)
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
    // 新 schema 的字段名：description / evidence / fix_hint / category / blocking
    const description = raw.description ?? finding
    const fixHint = raw.fix_hint ?? action
    const evidence = raw.evidence ?? null
    const category = raw.category ?? null

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
    if (typeof description !== 'string' || description.trim() === '') {
      errors.push(`${at}：缺 finding / description（具体问题）`)
    }
    if (needDetail && (typeof fixHint !== 'string' || fixHint.trim() === '')) {
      errors.push(`${at}：${severity} 必须给 action / fix_hint（可操作的修改方向）`)
    }
    if (category !== null && !CATEGORIES.includes(category)) {
      errors.push(`${at}：category 必须是 ${CATEGORIES.join(' / ')}（给了 ${JSON.stringify(category)}）`)
    }
    // blocking 显式给时必须是布尔
    if (raw.blocking !== undefined && typeof raw.blocking !== 'boolean') {
      errors.push(`${at}：blocking 必须是布尔值`)
    }

    const text = `${description ?? ''} ${fixHint ?? ''}`
    for (const re of NON_ATOMIC) {
      if (re.test(text)) errors.push(`${at}：出现非原子指令（${re.source}）—— 要求只给能定位到具体段落的修改方向`)
    }
    for (const re of OVERALL_COMMENT) {
      if (re.test(String(finding ?? ''))) errors.push(`${at}：finding 里出现整体评语（${re.source}）—— 要求只描述具体问题`)
    }

    findings.push({
      dimension, severity,
      category,
      location: typeof location === 'string' ? location.trim() : null,
      finding: String(description ?? '').trim(),
      evidence: typeof evidence === 'string' ? evidence.trim() : null,
      action: typeof fixHint === 'string' ? fixHint.trim() : null,
      // 没显式给就按严重度推断：fatal/critical 默认阻断
      blocking: raw.blocking ?? BLOCKING.includes(severity),
    })
  })

  const stats = {
    total: findings.length,
    fatal: findings.filter((f) => BLOCKING.includes(f.severity)).length,
    warning: findings.filter((f) => f.severity === 'warning' || f.severity === 'medium').length,
    pass: findings.filter((f) => f.severity === 'pass').length,
    blocking: findings.filter((f) => f.blocking === true).length,
    byDimension: Object.fromEntries(DIMENSIONS.map((d) => [d, findings.filter((f) => f.dimension === d).length])),
    bySeverity: Object.fromEntries(SEVERITIES.map((x) => [x, findings.filter((f) => f.severity === x).length])),
  }

  // 门禁结论：有阻断项就打回。fatal/critical 都算阻断。
  const verdict = stats.blocking > 0 ? 'reject'
    : (stats.warning > 0 ? 'revise' : 'pass')

  return {
    ok: errors.length === 0,
    errors,
    findings,
    stats,
    verdict,
    // 哪些维度压根没查（漏查比查出错更危险）。
    // 三个新维度是「按需启用」的：没给共情锚点/信息差矩阵时它们无从判定，
    // 所以那种情况下不算漏查，但要显式标出来，不能假装查过了。
    uncovered: (options?.requiredDimensions ?? DIMENSIONS).filter((d) => stats.byDimension[d] === 0),
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
