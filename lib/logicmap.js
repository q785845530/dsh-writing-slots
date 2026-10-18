/**
 * dsh-writing-slots — 小说逻辑图（Novel Logic Map）。
 *
 * 这是「读一堆素材 → 子智能拆解 → 填进槽位 → **一张完整的图** → 存进指令库」
 * 里的那个「图」。
 *
 * ## 它是什么
 * 不是一张插画，是一份**结构化的、能驱动后续写作的知识图**：
 *
 * ```
 *   世界规则 ──┐
 *   人物 ──────┼──→ 压力下的选择 ──→ 章节骨架 ──→ 钩子与信息差
 *   桥段 ──────┤                          ↑
 *   文风 ──────┘                    情绪温度曲线
 * ```
 *
 * 每个节点都带**原文出处**（来自哪份素材、哪一章），这样后续写作时
 * 能回头查证，而不是凭空生成。
 *
 * ## 为什么单独一层
 * 槽位是「一次分析」，图是「所有分析的汇总」。没有这一层，每本书的结论
 * 各活各的，写正文时拿不到全貌。
 *
 * @module dsh-writing-slots/logicmap
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 图的落盘名。 */
export const MAP_NAME = '小说逻辑图.md'

/** 图的落盘目录（在工作目录下）。 */
export const MAP_DIR = '设定'

/** 节点类型 —— 对应写作槽位的功能点。 */
export const NODE_KINDS = [
  { id: 'world', label: '世界规则', slot: 'world_builder', desc: '力量体系、代价、限制、社会结构' },
  { id: 'character', label: '人物', slot: 'character_designer', desc: '压力反应、真实需求、致命缺陷' },
  { id: 'structure', label: '结构', slot: 'chapter_pack', desc: '章节骨架、信息差、钩子' },
  { id: 'style', label: '文风', slot: 'style_anchor', desc: '句长、节奏、感官、比喻' },
  { id: 'trope', label: '桥段', slot: 'chapter_pack', desc: '可复用的情节机关' },
  { id: 'rule', label: '硬规则', slot: 'review_pass', desc: '禁止事项、必须满足的约束' },
  { id: 'material', label: '素材', slot: 'chapter_pack', desc: '名词、设定、灵感碎片' },
]

/** 类型 → 中文。 */
export const NODE_LABEL = Object.fromEntries(NODE_KINDS.map((k) => [k.id, k.label]))

/** 类型 → 对应槽位。 */
export const NODE_SLOT = Object.fromEntries(NODE_KINDS.map((k) => [k.id, k.slot]))

/**
 * 图节点类型 → 指令库条目类型。
 *
 * 两边的分类粒度不同：图按「喂给哪个槽位」分（有 world），
 * 指令库按「指令的用途」分（没有 world，世界观的东西归到 material）。
 *
 * 不做这个映射的话，`world` 会被指令库当成非法类型**静默回退成 rule** ——
 * 世界规则就变成硬规则了，看着没错但语义全歪。
 */
export const NODE_TO_LIB_KIND = {
  world: 'material',
  character: 'character',
  structure: 'structure',
  style: 'style',
  trope: 'trope',
  rule: 'rule',
  material: 'material',
}

/**
 * 校验一份逻辑图。
 *
 * 判据：
 *   - 每个节点必须能追到**出处**（哪份素材）—— 追不到的就是模型编的；
 *   - 至少覆盖世界/人物/结构三类，否则驱动不了后续写作；
 *   - 节点不能全是空的。
 */
export function validate(map) {
  const errors = []
  const warnings = []
  const m = map ?? {}
  const nodes = Array.isArray(m.nodes) ? m.nodes : []

  if (nodes.length === 0) {
    errors.push('图里一个节点都没有')
    return { ok: false, errors, warnings, stats: {} }
  }

  const kinds = new Set()
  for (const n of nodes) {
    const id = typeof n.id === 'string' && n.id !== '' ? n.id : '(无名)'
    if (!NODE_KINDS.some((k) => k.id === n.kind)) errors.push(`${id}：类型不认识（${n.kind}）`)
    else kinds.add(n.kind)
    if (typeof n.name !== 'string' || n.name.trim() === '') errors.push(`${id}：缺名称`)
    if (typeof n.body !== 'string' || n.body.trim().length < 10) errors.push(`${id}：内容太短，驱动不了写作`)
    // 出处是「没编造」的证据
    const src = Array.isArray(n.sources) ? n.sources.filter((x) => typeof x === 'string' && x !== '') : []
    if (src.length === 0) warnings.push(`${id}：没标出处 —— 无法确认是原文里的还是模型编的`)
  }

  for (const must of ['world', 'character', 'structure']) {
    if (!kinds.has(must)) warnings.push(`缺「${NODE_LABEL[must]}」这一类 —— 后续写作会缺一块`)
  }

  // 边的两端必须都存在
  const ids = new Set(nodes.map((n) => n.id))
  const edges = Array.isArray(m.edges) ? m.edges : []
  for (const e of edges) {
    if (!ids.has(e.from)) errors.push(`连线起点不存在：${e.from}`)
    if (!ids.has(e.to)) errors.push(`连线终点不存在：${e.to}`)
  }

  const byKind = {}
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      byKind,
      sourced: nodes.filter((n) => Array.isArray(n.sources) && n.sources.length > 0).length,
      chars: nodes.reduce((a, n) => a + (typeof n.body === 'string' ? n.body.length : 0), 0),
    },
  }
}

/** 把图渲染成 markdown（人读）与 mermaid（看结构）。 */
export function render(map) {
  const m = map ?? {}
  const nodes = Array.isArray(m.nodes) ? m.nodes : []
  const edges = Array.isArray(m.edges) ? m.edges : []
  const title = String(m.title ?? '小说逻辑图')
  const stats = validate(m).stats

  const lines = [`# ${title}`, '', `生成于 ${m.generatedAt ?? new Date().toISOString().slice(0, 16).replace('T', ' ')}　｜　${nodes.length} 个节点、${edges.length} 条连线`, '']

  if (Array.isArray(m.sources) && m.sources.length > 0) {
    lines.push('## 素材来源', '')
    for (const s of m.sources) lines.push(`- ${s}`)
    lines.push('')
  }

  // 按类型分组，每组对应一个写作槽位的功能点
  for (const k of NODE_KINDS) {
    const group = nodes.filter((n) => n.kind === k.id)
    if (group.length === 0) continue
    lines.push(`## ${k.label}（→ ${k.slot}）`, '')
    for (const n of group) {
      lines.push(`### ${n.name}`, '')
      if (Array.isArray(n.sources) && n.sources.length > 0) lines.push(`> 出处：${n.sources.join('、')}`)
      if (typeof n.summary === 'string' && n.summary !== '') lines.push(`> ${n.summary}`)
      lines.push('', String(n.body ?? '').trim(), '')
    }
  }

  // 结构图：用 mermaid，能直接贴进任何支持它的地方
  if (nodes.length > 0) {
    lines.push('## 结构图', '', '```mermaid', 'graph TD')
    for (const n of nodes) {
      const label = `${NODE_LABEL[n.kind] ?? n.kind}：${n.name}`.replace(/["\n]/g, ' ')
      lines.push(`  ${safeMermaidId(n.id)}["${label}"]`)
    }
    for (const e of edges) {
      const label = typeof e.label === 'string' && e.label !== '' ? `|${e.label.replace(/[|\n]/g, ' ')}|` : ''
      lines.push(`  ${safeMermaidId(e.from)} -->${label} ${safeMermaidId(e.to)}`)
    }
    lines.push('```', '')
  }

  lines.push('---', '', `节点构成：${Object.entries(stats.byKind ?? {}).map(([k, v]) => `${NODE_LABEL[k] ?? k}×${v}`).join('　')}`, '')

  return { text: `${lines.join('\n').trimEnd()}\n`, mermaid: nodes.length > 0, stats }
}

/** mermaid 的 id 只能含字母数字下划线。 */
function safeMermaidId(id) {
  return `n_${String(id ?? '').replace(/[^A-Za-z0-9_]/g, '_')}`
}

/**
 * 图的落盘路径。
 *
 * 存在工作目录的 `设定/` 下 —— 和 style-guide / world-bible 放一起，
 * 因为它们都是「写正文前该看的东西」。
 */
export function mapPath(workspace) {
  return join(workspace, MAP_DIR, MAP_NAME)
}

/** 读回已存的图（没有返回 null）。 */
export async function load(workspace) {
  const p = mapPath(workspace)
  if (!existsSync(p)) return null
  try {
    return { ok: true, path: p, text: await readFile(p, 'utf8') }
  } catch { return null }
}

/** 存图（原子写）。 */
export async function save(workspace, map) {
  const v = validate(map)
  const r = render(map)
  const dir = join(workspace, MAP_DIR)
  await mkdir(dir, { recursive: true })
  const p = mapPath(workspace)
  const tmp = `${p}.tmp-${process.pid}`
  await writeFile(tmp, r.text, 'utf8')
  await rename(tmp, p)
  // 同时存一份 JSON 备份：markdown 是给人读的，条目要从结构化数据来
  const jp = p.replace(/\.md$/, '.json')
  const jtmp = `${jp}.tmp-${process.pid}`
  await writeFile(jtmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  await rename(jtmp, jp)
  return { ok: true, path: p, jsonPath: jp, validation: v, text: r.text, stats: r.stats }
}

/**
 * 把图拆成指令库条目。
 *
 * 这是「把结果传送并存在指令库，相当后续写作的真实素材库」那一步：
 * 每个节点变成一条条目，类型沿用节点类型，出处写进 source。
 */
export function toItems(map) {
  const nodes = Array.isArray(map?.nodes) ? map.nodes : []
  return nodes.map((n) => ({
    // 显式映射：图的类型体系和指令库的不一样，不映射会被静默回退
    kind: NODE_TO_LIB_KIND[n.kind] ?? 'material',
    name: String(n.name ?? '').slice(0, 120),
    summary: typeof n.summary === 'string' && n.summary !== '' ? n.summary : `逻辑图节点（→ ${NODE_SLOT[n.kind] ?? '?'}）`,
    body: String(n.body ?? '').trim(),
    source: Array.isArray(n.sources) && n.sources.length > 0 ? n.sources.join('、').slice(0, 200) : '逻辑图',
    tags: ['逻辑图'],
    // 从图来的条目**默认启用**：它已经是加工过的结论，不是原料
    enabled: true,
  }))
}

/**
 * 从模型产出里解析逻辑图。
 *
 * 模型爱套代码块或加说明，所以宽容一点。
 */
export function parseMap(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: '内容是空的' }
  const cleaned = raw.replace(/^\s*```(?:json|yaml|yml)?\s*/i, '').replace(/\s*```\s*$/, '').trim()

  const tryParse = (s) => {
    try {
      const v = JSON.parse(s)
      if (v === null || typeof v !== 'object') return null
      if (Array.isArray(v.nodes)) return v
      if (v.map !== null && typeof v.map === 'object' && Array.isArray(v.map.nodes)) return v.map
      return null
    } catch { return null }
  }

  let m = tryParse(cleaned)
  if (m === null) {
    const a = cleaned.indexOf('{')
    const b = cleaned.lastIndexOf('}')
    if (a >= 0 && b > a) m = tryParse(cleaned.slice(a, b + 1))
  }
  if (m === null) return { ok: false, reason: '解析不出逻辑图（要含 nodes 数组的 JSON）' }

  // 补齐默认值，别让后续步骤因为缺字段崩
  return {
    ok: true,
    map: {
      title: typeof m.title === 'string' ? m.title : '小说逻辑图',
      sources: Array.isArray(m.sources) ? m.sources.map(String) : [],
      nodes: m.nodes.map((n, i) => ({
        id: typeof n.id === 'string' && n.id !== '' ? n.id : `n${i + 1}`,
        kind: NODE_KINDS.some((k) => k.id === n.kind) ? n.kind : 'material',
        name: String(n.name ?? `节点 ${i + 1}`),
        summary: typeof n.summary === 'string' ? n.summary : '',
        body: String(n.body ?? ''),
        sources: Array.isArray(n.sources) ? n.sources.map(String) : (typeof n.source === 'string' ? [n.source] : []),
      })),
      edges: Array.isArray(m.edges)
        ? m.edges.filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string').map((e) => ({ from: e.from, to: e.to, label: typeof e.label === 'string' ? e.label : '' }))
        : [],
      generatedAt: new Date().toISOString(),
    },
  }
}
