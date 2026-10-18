/**
 * dsh-writing-slots — 槽位模板引擎。
 *
 * 四个模块的提示词都用**声明式块**写，变量用 `{槽位}` 占位，运行时填充。
 * 这个文件只做一件事：把模板 + 数据渲染成最终提示词，并且在渲染前
 * **把契约查清楚** —— 缺必填槽位就报错，而不是渲染出一段缺胳膊少腿的
 * 提示词交给模型。
 *
 * ## 语法
 * ```
 * {chapter_no}                 取槽位
 * {chapter_task.event}         取嵌套字段
 * {#if avoid_list}...{/if}     条件块（假值/空数组/空串都不渲染）
 * {#unless x}...{/unless}      取反
 * {#each cast as c}...{/each}  遍历（循环内用 {c}）
 * ```
 *
 * ## 为什么渲染前要校验
 * 「缺一个槽位」在散文式指令里看不出来 —— 模型会自己编一个补上，你还以为
 * 它照做了。所以在渲染前先把模板里用到的槽位全部收集出来，跟声明的
 * required / auto_injected / optional 对一遍，缺必填就直接失败。
 *
 * 同理，模板里写了但**没有声明**的槽位也算错（拼错了名字是最常见的 bug，
 * 不报错的话它会静默渲染成空字符串）。
 *
 * @module dsh-writing-slots/render
 */

/**
 * 模板里出现的所有槽位引用（含嵌套路径的根名）。
 *
 * 循环变量（`{#each x as c}` 里的 `c`）单独返回：它由循环提供，不是外部
 * 槽位。不区分的话，`{c}` 会被当成「未声明的槽位」而误报。
 *
 * @returns `{ slots, locals }` 两个 Set。
 */
export function collectSlots(template) {
  const text = String(template ?? '')
  const slots = new Set()
  const locals = new Set()

  // 先扫一遍，把循环变量收集出来。
  const eachRe = /\{#each\s+[A-Za-z_][\w.]*\s+as\s+([A-Za-z_]\w*)\}/g
  let e
  while ((e = eachRe.exec(text)) !== null) locals.add(e[1])

  // 再扫所有引用。条件/循环头的路径算槽位，循环变量本身不算。
  const re = /\{#(?:if|unless|each)\s+([A-Za-z_][\w.]*)|\{([A-Za-z_][\w.]*)\}/g
  let m
  while ((m = re.exec(text)) !== null) {
    const name = (m[1] ?? m[2] ?? '').split('.')[0]
    if (name === '') continue
    if (locals.has(name)) continue
    slots.add(name)
  }
  return { slots, locals }
}

/** 深取值：`a.b.c`。取不到返回 undefined，不抛。 */
export function pick(data, path) {
  const parts = String(path).split('.')
  let cur = data
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[p]
  }
  return cur
}

/** 真假判定：空串、空数组、0 条、false、null、undefined 都算假。 */
function truthy(v) {
  if (v === null || v === undefined || v === false) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * 把一个值转成可直接嵌进提示词的文本。
 *
 * 数组渲染成 `- 条目` 列表（比 JSON 好读，模型也更不容易看错边界）。
 */
export function stringify(value, options = {}) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (v !== null && typeof v === 'object') {
        // 对象数组：`- k: v；k2: v2`
        const parts = Object.entries(v).map(([k, vv]) => `${k}: ${scalar(vv)}`)
        return `- ${parts.join('；')}`
      }
      return `- ${scalar(v)}`
    }).join('\n')
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, vv]) => vv !== null && vv !== undefined && vv !== '')
      .map(([k, vv]) => (Array.isArray(vv) ? `${k}：\n${stringify(vv)}` : `${k}：${scalar(vv)}`))
      .join('\n')
  }
  return scalar(value, options)
}

function scalar(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

/**
 * 渲染模板。
 *
 * @param template 模板文本。
 * @param data 槽位数据。
 * @param options `maxSlotChars`：单个槽位渲染后的字数上限（超出截断并标注），
 *                用来防止把整本书塞进提示词。
 * @returns 渲染后的文本。
 */
export function render(template, data, options = {}) {
  const maxSlotChars = options.maxSlotChars ?? 0
  let out = String(template ?? '')

  // 1) 条件块。从最内层往外替换，支持嵌套。
  const blockRe = /\{#(if|unless)\s+([A-Za-z_][\w.]*)\}([\s\S]*?)\{\/\1\}/g
  let guard = 0
  while (blockRe.test(out)) {
    if (++guard > 64) break // 嵌套过深就停，避免死循环
    out = out.replace(blockRe, (_all, kind, path, body) => {
      const v = truthy(pick(data, path))
      const show = kind === 'if' ? v : !v
      return show ? body : ''
    })
  }

  // 2) 循环。
  const eachRe = /\{#each\s+([A-Za-z_][\w.]*)\s+as\s+([A-Za-z_]\w*)\}([\s\S]*?)\{\/each\}/g
  guard = 0
  while (eachRe.test(out)) {
    if (++guard > 64) break
    out = out.replace(eachRe, (_all, path, alias, body) => {
      const list = pick(data, path)
      if (!Array.isArray(list)) return ''
      return list.map((item) => {
        const scope = { ...data, [alias]: item }
        // 循环体内只替换 {alias} 与 {alias.field}，其余的留给外层
        return body.replace(new RegExp(`\\{${alias}(\\.[\\w.]+)?\\}`, 'g'), (_m, sub) => {
          const v = sub === undefined ? item : pick(item, sub.slice(1))
          return stringify(v)
        })
      }).join('')
    })
  }

  // 3) 普通占位符。
  out = out.replace(/\{([A-Za-z_][\w.]*)\}/g, (_all, path) => {
    const v = pick(data, path)
    let text = stringify(v)
    if (maxSlotChars > 0 && text.length > maxSlotChars) {
      // 截断要留标记：静默截断会让人以为「模型没读到」是模型的错。
      text = `${text.slice(0, maxSlotChars)}\n…（已截断，原文 ${text.length} 字）`
    }
    return text
  })

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 校验槽位契约。
 *
 * @param template 模板。
 * @param declared `{ required: [], auto_injected: [], optional: [] }`。
 * @param data 实际提供的槽位。
 * @returns `{ ok, missing, unknown, unused }`。
 *   - `missing`：声明必填但没给（**致命**）
 *   - `unknown`：模板里用了但没声明（多半是拼错，**致命**）
 *   - `unused`：声明了但模板里没用到（提醒，不拦）
 */
export function checkContract(template, declared, data) {
  const required = declared?.required ?? []
  const auto = declared?.auto_injected ?? []
  const optional = declared?.optional ?? []
  const declaredNames = new Set([...required, ...auto, ...optional])

  const { slots: used } = collectSlots(template)
  const missing = []
  for (const name of required) {
    if (!truthy(pick(data, name))) missing.push(name)
  }

  const unknown = []
  for (const name of used) {
    if (!declaredNames.has(name)) unknown.push(name)
  }

  // 声明了却没用到的：只提示。自动注入项常常是「有则用」，不算错。
  const unused = [...declaredNames].filter((n) => !used.has(n) && !required.includes(n))

  return {
    ok: missing.length === 0 && unknown.length === 0,
    missing,
    unknown,
    unused,
    required,
  }
}

/**
 * 一步到位：校验 + 渲染。
 *
 * @returns `{ ok: true, prompt, warnings }` 或 `{ ok: false, errors }`。
 */
export function compose(template, declared, data, options = {}) {
  const check = checkContract(template, declared, data)
  if (check.ok !== true) {
    const errors = []
    if (check.missing.length > 0) errors.push(`缺少必填槽位：${check.missing.join('、')}`)
    if (check.unknown.length > 0) errors.push(`模板用了但未声明的槽位：${check.unknown.join('、')}（多半是拼错了）`)
    return { ok: false, errors, contract: check }
  }
  return {
    ok: true,
    prompt: render(template, data, options),
    warnings: check.unused.length > 0 ? [`声明了但模板未用到：${check.unused.join('、')}`] : [],
    contract: check,
  }
}

/**
 * 做一份槽位摘要，用于「把 style-guide 的摘要版作为固定前缀注入」。
 *
 * 取的是**可判定的指标**（句长、短句占比、禁忌清单），不取散文式描述 ——
 * 摘要要能直接约束写作，而不是一句「文风简洁」。
 */
export function digestOf(styleGuide, options = {}) {
  const maxChars = options.maxChars ?? 600
  if (styleGuide === null || styleGuide === undefined) return ''
  const lines = []
  const s = styleGuide.sentence_length_baseline
  if (s !== undefined) {
    lines.push(`句长：均 ${s.mean ?? '?'} 字，短句占比 ${s.short_ratio ?? '?'}（下限 ${options.shortFloor ?? '—'}）`)
  }
  const p = styleGuide.paragraph_rhythm
  if (p !== undefined) lines.push(`段落：每段约 ${p.median_lines ?? '?'} 行，对话段占比 ${p.dialogue_ratio ?? '?'}`)
  const b = styleGuide.sensory_bias
  if (b !== undefined) {
    const prefer = Array.isArray(b.prefer) ? b.prefer.join('、') : b.prefer
    const avoid = Array.isArray(b.avoid) ? b.avoid.join('、') : b.avoid
    lines.push(`感官：偏好 ${prefer ?? '—'}；回避 ${avoid ?? '—'}`)
  }
  const m = styleGuide.metaphor_fingerprint
  if (m !== undefined) {
    const spots = Array.isArray(m.typical_sources) ? m.typical_sources.join('、') : m.typical_sources
    lines.push(`比喻：多落在 ${spots ?? '—'}，密度 ${m.density ?? '?'}`)
  }
  const f = styleGuide.forbidden_list
  if (Array.isArray(f) && f.length > 0) {
    lines.push(`禁忌：\n${f.map((x) => `- ${typeof x === 'string' ? x : x.rule ?? JSON.stringify(x)}`).join('\n')}`)
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（摘要已截断）`
  return text
}
