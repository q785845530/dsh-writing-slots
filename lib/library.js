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

/**
 * 条目的**内容身份**。
 *
 * 同一个「江哲」不管导入几次，都该是同一条 —— 所以去重不能靠 id
 * （id 带时间戳与随机后缀，每次导入都不一样），要靠「类型 + 名字」。
 *
 * 名字要先归一化：去掉空白与标点，这样「江哲（字随云）」和
 * 「江哲(字随云)」算同一条。
 */
export function itemKey(item) {
  const kind = String(item?.kind ?? '')
  const name = String(item?.name ?? '').replace(/[\s：:（）()【】\[\]、，,。.·—\-"']/g, '').toLowerCase()
  return `${kind}|${name}`
}

/** 扫一遍现有条目，建「内容身份 → 条目」索引。 */
export async function indexByKey(workspace) {
  const l = await list(workspace)
  const index = new Map()
  const dups = []   // 已经存在的重复（同 key 多条）
  for (const it of l.items) {
    const k = itemKey(it)
    if (index.has(k)) { dups.push(it); continue }
    index.set(k, it)
  }
  return { index, items: l.items, dups }
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
  if (list0.length === 0) return { ok: false, reason: '没有条目', added: 0, updated: 0 }

  // 去重策略：
  //   'update'（默认）—— 同内容的已有条目就更新它（内容变了才写）
  //   'skip'           —— 已有就跳过，不碰
  //   'new'            —— 强行存成新条目（会重复，只在明确要一份副本时用）
  //
  // 第一版是「换个 id 存成新条目」，本意保护手工调的条目，但逻辑图重导时
  // 变成全量复制 —— 191 条里 147 条是重复的。
  const policy = options.onDuplicate ?? 'update'
  const { index } = await indexByKey(workspace)

  const added = []
  const updated = []
  const skipped = []
  for (const raw of list0.slice(0, 500)) {
    const n = normalize(raw, { source: options.source })
    if (n.ok !== true) { skipped.push({ name: raw?.name ?? '(无名)', errors: n.errors }); continue }

    const k = itemKey(n.item)
    const existing = index.get(k)

    if (existing === undefined) {
      await writeItem(workspace, n.item)
      index.set(k, n.item)
      added.push(n.item)
      continue
    }

    if (policy === 'skip') { skipped.push({ name: n.item.name, reason: '已存在（skip）' }); continue }
    if (policy === 'new') {
      n.item.id = `${n.item.id}-${Math.random().toString(36).slice(2, 5)}`
      await writeItem(workspace, n.item)
      added.push(n.item)
      continue
    }

    // update：沿用原 id 与 createdAt，只更新内容与标签（标签取并集，不丢段号）
    const merged = {
      ...existing,
      ...n.item,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      tags: [...new Set([...(existing.tags ?? []), ...(n.item.tags ?? [])])],
      // 出处也取并集：同一节点可能来自不同段
      source: existing.source !== '' && existing.source !== n.item.source
        ? `${existing.source}；${n.item.source}`.slice(0, 400)
        : n.item.source,
    }
    // 正文用更长的那个（信息更全）
    if ((existing.body?.length ?? 0) > (merged.body?.length ?? 0)) merged.body = existing.body
    if ((existing.summary?.length ?? 0) > (merged.summary?.length ?? 0)) merged.summary = existing.summary
    // 已经启用的不要被新导入关掉
    if (existing.enabled !== false) merged.enabled = true
    await writeItem(workspace, merged)
    index.set(k, merged)
    updated.push(merged)
  }
  return {
    ok: added.length > 0 || updated.length > 0,
    added: added.length,
    updated: updated.length,
    skipped,
    items: [...added, ...updated].map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
  }
}

/**
 * 清掉库里已有的重复条目（同内容多条）。
 *
 * 保留哪一条：**信息最全的那条**（正文最长、标签最多），其余删掉。
 * 合并时把被删条目的标签与出处并进保留的那条，不丢信息。
 */
export async function dedupe(workspace, options = {}) {
  const l = await list(workspace)
  const groups = new Map()
  for (const it of l.items) {
    const k = itemKey(it)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(it)
  }

  const removed = []
  const mergedGroups = []
  let kept = 0

  for (const [k, group] of groups) {
    if (group.length === 1) { kept += 1; continue }
    // 排序：正文最长的优先，其次标签最多的，最后更新时间新的
    const sorted = [...group].sort((a, b) => {
      const d = (b.body?.length ?? 0) - (a.body?.length ?? 0)
      if (d !== 0) return d
      const t = (b.tags?.length ?? 0) - (a.tags?.length ?? 0)
      if (t !== 0) return t
      return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
    })
    const winner = sorted[0]
    const losers = sorted.slice(1)

    // 合并标签与出处
    const tags = new Set(winner.tags ?? [])
    const sources = new Set(String(winner.source ?? '').split('；').filter((x) => x !== ''))
    let enabled = winner.enabled
    for (const x of losers) {
      for (const t of x.tags ?? []) tags.add(t)
      for (const s of String(x.source ?? '').split('；')) if (s !== '') sources.add(s)
      if (x.enabled !== false) enabled = true
    }
    const mergedItem = {
      ...winner,
      tags: [...tags],
      source: [...sources].join('；').slice(0, 400),
      enabled,
      updatedAt: new Date().toISOString(),
    }
    await writeItem(workspace, mergedItem)

    // dryRun 时也要记「会删几条」，否则界面看到 removed=0 会以为没重复
    for (const x of losers) {
      removed.push({ id: x.id, name: x.name, key: k })
      if (options.dryRun !== true) await unlink(itemPath(workspace, x.id)).catch(() => {})
    }
    mergedGroups.push({ key: k, name: winner.name, kept: winner.id, removed: losers.length })
    kept += 1
  }

  return {
    ok: true,
    before: l.items.length,
    after: l.items.length - removed.length,
    removed: removed.length,
    groups: mergedGroups.filter((g) => g.removed > 0),
    dryRun: options.dryRun === true,
    message: removed.length === 0
      ? '没有重复'
      : `${options.dryRun === true ? '会清掉' : '清掉'} ${removed.length} 条重复，保留 ${kept} 条`,
  }
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
  // 本地书是**整本小说**（阅读器放进来的），也是最有价值的素材来源
  { dir: '本地书', kind: 'structure', label: '本地书' },
]

/**
 * 读文本文件，**自动认编码**。
 *
 * 本地 txt 小说十有八九是 GBK —— 直接按 utf8 读会得到一屏乱码，
 * 而且乱码进库比读不到更坏（统计全错还看不出来）。
 */
export async function readTextSmart(path) {
  const buf = await readFile(path)
  // BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8')
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf)
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)

  // 先试严格 utf8：能过就是 utf8
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch { /* 不是 utf8，往下走 */ }

  // 再试 GBK（Node 内置解码器支持 gbk）。
  //
  // 判据是**乱码率**，不是「中文字数够不够」—— 第一版写成 han > 500，
  // 短文本（几百字）永远过不了这道门槛，于是掉进兜底分支、按 utf8 读出乱码。
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    if (looksClean(gbk)) return gbk
  } catch { /* 解码器不支持 gbk */ }

  // 都不行：退回宽松 utf8（至少能读）
  return buf.toString('utf8')
}

/**
 * 这段文本像不像正常中文？
 *
 * 看**替换字符与罕见符号的比例**：乱码的典型特征是大量 U+FFFD 和
 * 拉丁扩展/符号区字符，而正常中文里汉字占绝大多数。
 */
export function looksClean(text) {
  const sample = String(text ?? '').slice(0, 40000)
  if (sample === '') return false
  const total = sample.length
  const bad = (sample.match(/[\ufffd\u0000-\u0008\u000e-\u001f]/g) ?? []).length
  const han = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length
  // 汉字占一成以上、且坏字符不到百分之一 —— 就算是正常中文
  return han / total > 0.1 && bad / total < 0.01
}

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
  // 提取去重按**文件名**，不按「来源目录+名字」 ——
  // 同一篇原文常常同时躺在 素材/ 拆文库/ 样本/ 里（我先把书放进素材，
  // 又复制了一份到样本），按目录判会被提取三次，得到三条同内容的条目。
  const existingNames = new Set(existing.items.map((x) => String(x.name)))

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
      if (existingNames.has(name)) continue
      if (found.some((f) => f.name === name)) continue
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
      text = await readTextSmart(f.path)
    } catch (e) { skipped.push({ name: f.name, reason: '读不了' }); continue }
    const body = String(text).trim()
    // 太短的当不了指令，跳过并说明
    if (body.length < 30) { skipped.push({ name: f.name, reason: `内容只有 ${body.length} 字，太短` }); continue }
    // 混淆内容不进库（同一套判据）
    const pua = [...body].filter((c) => c.codePointAt(0) >= 0xe000 && c.codePointAt(0) <= 0xf8ff).length
    if (pua > 0) { skipped.push({ name: f.name, reason: `含 ${pua} 个私有区字符（字体混淆）` }); continue }

    // 整本小说动辄几十万字，全塞进去没法用 —— 取前 20000 字（约前几章），
    // 在 summary 里写清「取了哪一段」，后续要更多可以再切
    const CAP = 20000
    const excerpt = body.length > CAP ? body.slice(0, CAP) : body
    const r = await put(workspace, {
      kind: f.kind,
      name: f.name.slice(0, 100),
      summary: `从 ${f.dir}/ 提取（原文 ${body.length} 字${body.length > CAP ? `，取前 ${CAP} 字` : ''}）—— 待整理成指令`,
      // 原文先原样存着，人再把它改成可执行的指令。
      //
      // **默认不参与合成**（enabled: false）：原文不是指令，三万字的原文拼进
      // 「写作指令」只会把提示词撑爆、把真正的约束淹掉。整理成可执行的句子后
      // 再启用 —— 提取是原料，加工是你（或拆文入库）的事。
      body: excerpt,
      source: f.dir,
      enabled: false,
      tags: ['待整理'],
    })
    if (r.ok === true) added.push({ id: r.item.id, name: r.item.name, kind: r.item.kind, dir: f.dir })
    else skipped.push({ name: f.name, reason: (r.errors ?? []).join('；') })
  }
  return { ok: added.length > 0, added: added.length, items: added, skipped, scanned: found.length }
}

/**
 * 把一本长书切成**可分批拆解**的段。
 *
 * 整本 54 万字塞不进一次提示词。按章节标题切，每段控制在
 * `chunkChars` 以内 —— 这样能一段一段喂给子智能，最后合成一张图。
 *
 * 找不到章节标题就按字数硬切（并说明）。
 */
export async function chunkBook(path, options = {}) {
  const text = await readTextSmart(path)
  const max = Number.isFinite(options.chunkChars) ? Math.max(2000, options.chunkChars) : 20000
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 50

  // 章节标题：第X章 / 第X回 / 序章 / 楔子 / 番外
  const re = /^\s*(第[0-9零一二三四五六七八九十百千万两]+[章回节集部篇]|序章|楔子|番外|尾声|后记)[^\n]{0,40}$/gm
  const marks = [...text.matchAll(re)].map((m) => ({ index: m.index, title: m[0].trim() }))

  const chunks = []
  if (marks.length >= 3) {
    // 按标题切，再把小段合并到 max 以内
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].index
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length
      const body = text.slice(start, end)
      const last = chunks[chunks.length - 1]
      if (last !== undefined && last.text.length + body.length <= max) {
        last.text += body
        last.chapters.push(marks[i].title)
        last.end = i + 1
      } else {
        chunks.push({ index: chunks.length, title: marks[i].title, text: body, chapters: [marks[i].title], start: i, end: i + 1 })
      }
    }
  } else {
    // 没有章节标题：按字数硬切
    for (let i = 0; i < text.length && chunks.length < limit; i += max) {
      chunks.push({ index: chunks.length, title: `第 ${chunks.length + 1} 段`, text: text.slice(i, i + max), chapters: [], start: i, end: i + 1 })
    }
  }

  const total = chunks.length
  return {
    ok: total > 0,
    path,
    totalChars: text.length,
    chapterMarks: marks.length,
    byChapter: marks.length >= 3,
    chunkChars: max,
    total,
    chunks: chunks.slice(0, limit).map((c) => ({
      index: c.index,
      title: c.title,
      chars: c.text.length,
      chapters: c.chapters.length,
      // 只回摘要，正文按需取（一次全发回去太大）
      preview: c.text.slice(0, 120).replace(/\s+/g, ' '),
    })),
    truncated: total > limit,
    hint: marks.length >= 3
      ? `按章节标题切了 ${total} 段，每段不超过 ${max} 字。用 chunkIndex 一段一段拆。`
      : `没找到章节标题，按字数硬切成 ${total} 段。`,
  }
}

/** 取某一分段的正文（给拆解用）。 */
export async function chunkText(path, index, options = {}) {
  const r = await chunkBook(path, { ...options, limit: 100000 })
  const i = Number(index)
  if (!Number.isFinite(i) || i < 0) return { ok: false, reason: `分段号不对：${index}` }
  // chunkBook 只回摘要，这里重新切一次取全文
  const text = await readTextSmart(path)
  const max = Number.isFinite(options.chunkChars) ? Math.max(2000, options.chunkChars) : 20000
  const re = /^\s*(第[0-9零一二三四五六七八九十百千万两]+[章回节集部篇]|序章|楔子|番外|尾声|后记)[^\n]{0,40}$/gm
  const marks = [...text.matchAll(re)].map((m) => ({ index: m.index, title: m[0].trim() }))
  if (marks.length < 3) {
    const start = i * max
    if (start >= text.length) return { ok: false, reason: `没有第 ${i + 1} 段（共 ${r.total} 段）` }
    return { ok: true, index: i, title: `第 ${i + 1} 段`, text: text.slice(start, start + max), chars: Math.min(max, text.length - start) }
  }
  const ranges = []
  for (let k = 0; k < marks.length; k += 1) {
    const start = marks[k].index
    const end = k + 1 < marks.length ? marks[k + 1].index : text.length
    const last = ranges[ranges.length - 1]
    if (last !== undefined && last.text.length + (end - start) <= max) {
      last.text += text.slice(start, end)
      last.chapters.push(marks[k].title)
    } else {
      ranges.push({ title: marks[k].title, text: text.slice(start, end), chapters: [marks[k].title] })
    }
  }
  const c = ranges[i]
  if (c === undefined) return { ok: false, reason: `没有第 ${i + 1} 段（共 ${ranges.length} 段）` }
  return { ok: true, index: i, title: c.title, text: c.text, chars: c.text.length, chapters: c.chapters.length, total: ranges.length }
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
