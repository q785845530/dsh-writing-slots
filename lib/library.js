/**
 * dsh-writing-slots — 指令库。
 *
 * 这是「**多次读小说 → 沉淀 → 勾选组合 → 最终写作指令**」闭环的落点。
 *
 * ## 为什么要有这一层
 * 前面那些槽位是**过程**：读一本、拆一本、跑一次锚点，产出散在各处。但你真正
 * 要的不是「跑过多少模块」，是**攒下来一套能反复用的写作指令**。
 *
 * 所以这一层做的事：
 *   1. **沉淀** —— 每次分析（文风锚点 / 拆文 / 手写）产出的东西，落成**条目**；
 *   2. **组合** —— 条目清单里勾选，按顺序拼成一份**最终指令**；
 *   3. **复用** —— 那份指令可以喂给 Chapter Pack，写每一章都带着它。
 *
 * ## 条目是「可执行的指令片段」，不是「资料」
 * 资料是给人读的（「这本书节奏很好」），指令是给模型执行的
 * （「每章至少一次信息差变化，且必须落在那一条被点亮上」）。
 * 所以每条都有 `body`，合成的就是这些 body。
 *
 * ## 存储
 * `<工作目录>/指令库/<id>.json`，一条一个文件。
 *
 * 不塞进一个总 JSON：那样两条同时写就互相覆盖；一条一个文件，坏一条也只坏一条。
 *
 * @module dsh-writing-slots/library
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 库目录名。 */
export const LIB_DIR = '指令库'

/** 条目类型。 */
export const KINDS = [
  { id: 'style', label: '文风', desc: '句长、节奏、感官偏好、比喻指纹' },
  { id: 'structure', label: '结构', desc: '信息差、钩子、张力曲线、章节骨架' },
  { id: 'character', label: '人物', desc: '压力反应、共情锚点、声音指纹' },
  { id: 'trope', label: '桥段', desc: '可复用的情节机关与转折设计' },
  { id: 'rule', label: '硬规则', desc: '禁止事项、必须满足的约束' },
  { id: 'material', label: '素材', desc: '设定、名词、灵感碎片' },
]

/** 类型 → 中文。 */
export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]))

/** 合成时的默认顺序：先硬规则，再文风，再结构/人物/桥段，最后素材。 */
export const DEFAULT_ORDER = ['rule', 'style', 'structure', 'character', 'trope', 'material']

const safeId = (s) => String(s ?? '').replace(/[^\w.-]/g, '_').slice(0, 80)

/** 库目录。 */
export function libDir(workspace) {
  return join(workspace, LIB_DIR)
}

/** 条目的落盘路径。 */
export function itemPath(workspace, id) {
  return join(libDir(workspace), `${safeId(id)}.json`)
}

/** 生成一个稳定 id（带时间前缀，列表按文件名排就是时间序）。 */
export function newId(kind = 'style') {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const r = Math.random().toString(36).slice(2, 6)
  return `${t}-${safeId(kind)}-${r}`
}

/**
 * 规范化一个条目。
 *
 * 宽进：模型产出、手写、别处导入的都能收；严出：存进库的一定是完整结构。
 */
export function normalize(input, options = {}) {
  const raw = input ?? {}
  const kind = KINDS.some((k) => k.id === raw.kind) ? raw.kind : 'rule'
  const name = String(raw.name ?? raw.title ?? '').trim().slice(0, 120)
  const body = String(raw.body ?? raw.content ?? raw.instruction ?? '').trim()
  const errors = []
  if (name === '') errors.push('缺 name（条目名）')
  if (body === '') errors.push('缺 body（指令正文 —— 合成的就是它）')
  // 一遍就成的「资料」不是指令，提醒一下：指令要能被执行
  const looksLikeData = body.length < 20 && !/[，。；：、]/.test(body)
  const warnings = []
  if (looksLikeData) warnings.push('正文太短，可能不是一条可执行的指令')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    item: {
      id: safeId(raw.id ?? options.id ?? newId(kind)),
      kind,
      name,
      summary: String(raw.summary ?? raw.desc ?? '').trim().slice(0, 300),
      body,
      source: String(raw.source ?? options.source ?? '').trim().slice(0, 200),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      order: Number.isFinite(raw.order) ? Math.floor(raw.order) : DEFAULT_ORDER.indexOf(kind) * 100,
      tags: Array.isArray(raw.tags) ? raw.tags.map((x) => String(x).slice(0, 40)).slice(0, 12) : [],
      stats: raw.stats !== null && typeof raw.stats === 'object' ? raw.stats : null,
      createdAt: raw.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

/** 读一条。 */
export async function get(workspace, id) {
  try {
    const parsed = JSON.parse(await readFile(itemPath(workspace, id), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** 列出全部条目（按 order、再按文件名）。 */
export async function list(workspace) {
  const dir = libDir(workspace)
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
  } catch { return { ok: true, dir, items: [], counts: {} } }

  const items = []
  const broken = []
  for (const n of names) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, n), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string') items.push(parsed)
      else broken.push({ file: n, reason: '结构不对' })
    } catch (e) {
      broken.push({ file: n, reason: e?.message ?? String(e) })
    }
  }
  items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)))

  const counts = {}
  for (const k of KINDS) counts[k.id] = items.filter((x) => x.kind === k.id).length
  return { ok: true, dir, items, counts, broken, enabled: items.filter((x) => x.enabled !== false).length }
}

/** 写盘（原子：先写临时文件再改名）。 */
async function writeItem(workspace, item) {
  const dir = libDir(workspace)
  await mkdir(dir, { recursive: true })
  const path = itemPath(workspace, item.id)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(item, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return path
}

/** 新增/覆盖一条。 */
export async function put(workspace, input, options = {}) {
  const n = normalize(input, options)
  if (n.ok !== true) return { ok: false, errors: n.errors, warnings: n.warnings }
  const before = await get(workspace, n.item.id)

  // 没显式给 order 时，排在现有条目**之后**。
  //
  // 不能都用「类型默认值」：那样同类型条目的 order 全一样，排序会落到 id 上，
  // 而 id 带随机后缀 —— 结果就是新加的条目位置随机，很反直觉。
  if (raw_has_no_order(input)) {
    const l = await list(workspace)
    const max = l.items.reduce((a, x) => Math.max(a, Number(x.order) || 0), -1)
    n.item.order = max + 1
  }

  // 覆盖时保留原 createdAt
  if (before !== null && typeof before.createdAt === 'string') n.item.createdAt = before.createdAt
  const path = await writeItem(workspace, n.item)
  return { ok: true, item: n.item, path, warnings: n.warnings }
}

/** 调用方有没有显式给 order。 */
function raw_has_no_order(input) {
  return !(input !== null && typeof input === 'object' && Number.isFinite(input.order))
}

/** 批量导入（模型产出的一批条目）。 */
export async function importItems(workspace, inputs, options = {}) {
  const list0 = Array.isArray(inputs) ? inputs : []
  if (list0.length === 0) return { ok: false, reason: '没有条目', added: 0 }
  const added = []
  const skipped = []
  for (const raw of list0.slice(0, 200)) {
    const n = normalize(raw, { source: options.source })
    if (n.ok !== true) { skipped.push({ name: raw?.name ?? '(无名)', errors: n.errors }); continue }
    const before = await get(workspace, n.item.id)
    if (before !== null && options.overwrite !== true) {
      // 不覆盖：换个 id 存成新条目，宁可多一条也别悄悄改掉旧的
      n.item.id = `${n.item.id}-${Math.random().toString(36).slice(2, 5)}`
    }
    await writeItem(workspace, n.item)
    added.push(n.item)
  }
  return { ok: added.length > 0, added: added.length, skipped, items: added.map((x) => ({ id: x.id, name: x.name, kind: x.kind })) }
}

/** 改一条（部分字段）。 */
export async function patch(workspace, id, changes = {}) {
  const before = await get(workspace, id)
  if (before === null) return { ok: false, reason: `没有这个条目：${id}` }
  const merged = { ...before, ...changes, id: before.id, createdAt: before.createdAt, updatedAt: new Date().toISOString() }
  if (changes.kind !== undefined && !KINDS.some((k) => k.id === changes.kind)) return { ok: false, reason: `不认识的类型：${changes.kind}` }
  if (changes.body !== undefined && String(changes.body).trim() === '') return { ok: false, reason: 'body 不能清空' }
  const n = normalize(merged, { id: before.id })
  if (n.ok !== true) return { ok: false, errors: n.errors }
  await writeItem(workspace, n.item)
  return { ok: true, item: n.item }
}

/** 删一条。 */
export async function remove(workspace, id) {
  const path = itemPath(workspace, id)
  if (!existsSync(path)) return { ok: false, reason: `没有这个条目：${id}` }
  await unlink(path)
  return { ok: true, id }
}

/** 批量启用/停用。 */
export async function setEnabled(workspace, ids, enabled) {
  const list0 = Array.isArray(ids) ? ids : []
  let n = 0
  for (const id of list0) {
    const r = await patch(workspace, id, { enabled: enabled === true })
    if (r.ok === true) n += 1
  }
  return { ok: true, changed: n }
}

/** 调整顺序（把 id 列表按给定次序重排）。 */
export async function reorder(workspace, ids) {
  const list0 = Array.isArray(ids) ? ids : []
  let n = 0
  for (let i = 0; i < list0.length; i += 1) {
    const r = await patch(workspace, list0[i], { order: i })
    if (r.ok === true) n += 1
  }
  return { ok: true, changed: n }
}

/**
 * 合成最终指令。
 *
 * @param ids 要参与合成的条目 id；不给则用全部 `enabled !== false` 的。
 * @param options `{ title, includeSource, groupByKind }`。
 */
export async function compose(workspace, ids, options = {}) {
  const all = await list(workspace)
  const picked = Array.isArray(ids) && ids.length > 0
    ? all.items.filter((x) => ids.includes(x.id))
    : all.items.filter((x) => x.enabled !== false)

  if (picked.length === 0) {
    return { ok: false, reason: '没有可合成的条目（清单是空的，或一条都没勾）', text: '', used: [] }
  }

  // 合成时按**类型优先级**排（硬规则最前、素材最后），同类内维持加入顺序。
  //
  // 列表那边是按加入顺序显示的 —— 两个需求不同，所以分开：
  // order 负责「第几个加进来的」，kind 优先级只在合成时生效。
  const kindRank = (k) => {
    const i = DEFAULT_ORDER.indexOf(k)
    return i < 0 ? DEFAULT_ORDER.length : i
  }
  const sorted = [...picked].sort((a, b) => {
    const d = kindRank(a.kind) - kindRank(b.kind)
    if (d !== 0) return d
    return (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id))
  })
  const title = String(options.title ?? '写作指令').trim() || '写作指令'

  const pending = all.items.filter((x) => (x.tags ?? []).includes('待整理') && x.enabled === false).length
  const lines = [`# ${title}`, '', `（由指令库 ${sorted.length} 条合成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}）`]
  if (pending > 0) lines.push('', `> 另有 ${pending} 条标着「待整理」的原料没算进来 —— 它们是提取来的原文，整理成可执行的指令后再启用。`)
  lines.push('')
  const used = []

  if (options.groupByKind === true) {
    // 按类型分组：一份指令里同类的东西挨在一起，模型更容易当成一组约束看
    const byKind = new Map()
    for (const it of sorted) {
      if (!byKind.has(it.kind)) byKind.set(it.kind, [])
      byKind.get(it.kind).push(it)
    }
    const orderedKinds = [...DEFAULT_ORDER.filter((k) => byKind.has(k)), ...[...byKind.keys()].filter((k) => !DEFAULT_ORDER.includes(k))]
    for (const k of orderedKinds) {
      lines.push(`## ${KIND_LABEL[k] ?? k}`, '')
      for (const it of byKind.get(k)) {
        lines.push(`### ${it.name}${options.includeSource === true && it.source !== '' ? `（来源：${it.source}）` : ''}`)
        if (it.summary !== '') lines.push(`> ${it.summary}`)
        lines.push('', it.body, '')
        used.push({ id: it.id, name: it.name, kind: it.kind, chars: it.body.length })
      }
    }
  } else {
    for (const it of sorted) {
      lines.push(`## ${it.name}`, '')
      if (it.summary !== '') lines.push(`> ${it.summary}`)
      if (options.includeSource === true && it.source !== '') lines.push(`> 来源：${it.source}`)
      lines.push('', it.body, '')
      used.push({ id: it.id, name: it.name, kind: it.kind, chars: it.body.length })
    }
  }

  const text = `${lines.join('\n').trimEnd()}\n`
  return {
    ok: true,
    title,
    text,
    used,
    chars: text.length,
    // 给界面显示：这份指令由哪些类型构成
    byKind: used.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] ?? 0) + 1; return acc }, {}),
    pending,
    // 指令太长会淹掉真正的约束，提醒一下
    warning: text.length > 12000 ? `合出来 ${text.length} 字，偏长 —— 约束太多模型会顾此失彼，考虑精简。` : null,
  }
}

/**
 * 从模型产出里解析条目。
 *
 * 模型爱在 JSON 外面套 ```` ```json ```` 或加一段说明，所以宽容一点：
 * 先试整体 JSON，再试从第一个 `[` 到最后一个 `]`。
 */
export function parseItems(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: '内容是空的', items: [] }

  const tryParse = (s) => {
    try {
      const v = JSON.parse(s)
      if (Array.isArray(v)) return v
      if (v !== null && typeof v === 'object' && Array.isArray(v.items)) return v.items
      if (v !== null && typeof v === 'object' && Array.isArray(v.指令)) return v.指令
      if (v !== null && typeof v === 'object') return [v]
      return null
    } catch { return null }
  }

  const cleaned = raw.replace(/^\s*```(?:json|yaml|yml)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  let items = tryParse(cleaned)
  if (items === null) {
    const a = cleaned.indexOf('[')
    const b = cleaned.lastIndexOf(']')
    if (a >= 0 && b > a) items = tryParse(cleaned.slice(a, b + 1))
  }
  if (items === null) {
    const a = cleaned.indexOf('{')
    const b = cleaned.lastIndexOf('}')
    if (a >= 0 && b > a) items = tryParse(cleaned.slice(a, b + 1))
  }
  if (items === null) return { ok: false, reason: '解析不出条目（要 JSON 数组）', items: [] }
  return { ok: items.length > 0, items, count: items.length }
}

// ————————————————————————— 与写作槽位的关系 —————————————————————————

/**
 * 类型 → 哪些槽位用得上。
 *
 * 「送到写作槽点功能对应列表」就靠这张表：选中某个槽位时，只列出它用得上的条目。
 */
export const SLOT_KINDS = {
  style_anchor: ['style', 'rule', 'material'],
  world_builder: ['material', 'rule'],
  character_designer: ['character', 'rule', 'material'],
  chapter_pack: ['structure', 'character', 'trope', 'style', 'rule', 'material'],
  reader_sim: ['character', 'structure'],
  review_pass: ['structure', 'character', 'rule'],
  deai_polish: ['rule', 'style'],
  prose_sanity: ['rule'],
  auto_continue: [],
  workspace: [],
  novel_site: [],
  reader: [],
  instruction_library: [],
}

/** 某个槽位用得上哪些类型。 */
export function kindsForSlot(slot) {
  return SLOT_KINDS[slot] ?? []
}

/**
 * 给某个槽位取可用条目（只取启用的、类型对得上的）。
 *
 * 这是「写作槽位里的清单选项」的数据来源。
 */
export async function forSlot(workspace, slot) {
  const kinds = kindsForSlot(slot)
  const l = await list(workspace)
  const items = l.items.filter((x) => kinds.includes(x.kind))
  return {
    ok: true,
    slot,
    kinds,
    items,
    enabled: items.filter((x) => x.enabled !== false).length,
    totalChars: items.reduce((a, x) => a + (x.body?.length ?? 0), 0),
  }
}

/**
 * 给某个槽位合成指令（只取勾选的那几条；不勾则取该槽位全部启用的）。
 *
 * 这就是「由这个页签做为写作的最终指令」在槽位侧的落点：写第 N 章时，
 * 把跟这一章相关的那几条条目拼进去。
 */
export async function composeForSlot(workspace, slot, ids, options = {}) {
  const pool = (await forSlot(workspace, slot)).items
  const picked = Array.isArray(ids) && ids.length > 0
    ? pool.filter((x) => ids.includes(x.id))
    : pool.filter((x) => x.enabled !== false)
  if (picked.length === 0) return { ok: false, reason: `「${slot}」没有可用的条目`, text: '', used: [] }
  const r = await compose(workspace, picked.map((x) => x.id), {
    title: options.title ?? `${slot} 指令`,
    groupByKind: options.groupByKind !== false,
  })
  return { ...r, slot, poolSize: pool.length }
}

// ————————————————————————— 从工作目录提取素材 —————————————————————————

/** 提取时扫描哪些目录、归成哪一类。 */
export const EXTRACT_SOURCES = [
  { dir: '素材', kind: 'material', label: '素材' },
  { dir: '拆文库', kind: 'structure', label: '拆文库' },
  { dir: '样本', kind: 'style', label: '样本' },
  { dir: '设定', kind: 'material', label: '设定' },
]

/**
 * 从工作目录里**提取素材**成条目。
 *
 * 这是「训练越多，清单越长」的入口：读进来的小说、拆出来的东西、攒的样本，
 * 都在工作目录里 —— 但躺在目录里没用，得变成**可勾选的条目**。
 *
 * `dryRun: true` 只报告会提到什么，不写盘（界面上先给人看一眼）。
 */
export async function extractFromWorkspace(workspace, options = {}) {
  const only = Array.isArray(options.dirs) && options.dirs.length > 0 ? new Set(options.dirs) : null
  const maxPerDir = Number.isFinite(options.maxPerDir) ? Math.max(1, options.maxPerDir) : 200
  const existing = await list(workspace)
  const haveNames = new Set(existing.items.map((x) => `${x.source}|${x.name}`))

  const found = []
  for (const src of EXTRACT_SOURCES) {
    if (only !== null && !only.has(src.dir)) continue
    let names = []
    try {
      const { readdir } = await import('node:fs/promises')
      names = (await readdir(join(workspace, src.dir))).filter((n) => /\.[a-z0-9]+$/i.test(n) && !n.startsWith('.'))
    } catch { continue }
    for (const n of names.slice(0, maxPerDir)) {
      const name = n.replace(/\.[a-z0-9]+$/i, '')
      if (haveNames.has(`${src.dir}/${name}|${name}`) || haveNames.has(`${src.dir}|${name}`)) continue
      found.push({ dir: src.dir, kind: src.kind, file: n, name, path: join(workspace, src.dir, n) })
    }
  }

  if (options.dryRun === true) {
    return { ok: true, dryRun: true, count: found.length, found: found.map((x) => ({ dir: x.dir, kind: x.kind, name: x.name })) }
  }

  const added = []
  const skipped = []
  for (const f of found) {
    let text = ''
    try {
      text = await readFile(f.path, 'utf8')
    } catch (e) { skipped.push({ name: f.name, reason: '读不了' }); continue }
    const body = String(text).trim()
    // 太短的当不了指令，跳过并说明
    if (body.length < 30) { skipped.push({ name: f.name, reason: `内容只有 ${body.length} 字，太短` }); continue }
    // 混淆内容不进库（同一套判据）
    const pua = [...body].filter((c) => c.codePointAt(0) >= 0xe000 && c.codePointAt(0) <= 0xf8ff).length
    if (pua > 0) { skipped.push({ name: f.name, reason: `含 ${pua} 个私有区字符（字体混淆）` }); continue }

    const r = await put(workspace, {
      kind: f.kind,
      name: f.name.slice(0, 100),
      summary: `从 ${f.dir}/ 提取（${body.length} 字）—— 待整理成指令`,
      // 原文先原样存着，人再把它改成可执行的指令。
      //
      // **默认不参与合成**（enabled: false）：原文不是指令，三万字的原文拼进
      // 「写作指令」只会把提示词撑爆、把真正的约束淹掉。整理成可执行的句子后
      // 再启用 —— 提取是原料，加工是你（或拆文入库）的事。
      body: body.slice(0, 4000),
      source: f.dir,
      enabled: false,
      tags: ['待整理'],
    })
    if (r.ok === true) added.push({ id: r.item.id, name: r.item.name, kind: r.item.kind, dir: f.dir })
    else skipped.push({ name: f.name, reason: (r.errors ?? []).join('；') })
  }
  return { ok: added.length > 0, added: added.length, items: added, skipped, scanned: found.length }
}

/** 汇总一份统计（界面顶部的概览）。 */
export async function summary(workspace) {
  const l = await list(workspace)
  const totalChars = l.items.reduce((a, x) => a + (x.body?.length ?? 0), 0)
  const sources = [...new Set(l.items.map((x) => x.source).filter((x) => x !== ''))]
  return {
    ...l,
    totalChars,
    sources,
    kinds: KINDS.map((k) => ({ ...k, count: l.counts[k.id] ?? 0 })),
  }
}
