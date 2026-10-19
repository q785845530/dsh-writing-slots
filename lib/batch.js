/**
 * dsh-writing-slots — 批量拆解编排。
 *
 * 一本 54 万字的小说切成 98 段，一段一段手跑不现实。这一层负责：
 *
 *   1. **排班** —— 算出要拆哪些段、每段的状态（待拆/在拆/已完成/失败）
 *   2. **分片存档** —— 每段的图单独存，坏了只坏一段，不影响其他段
 *   3. **合并** —— 98 份分片图合成一张全书图（节点去重、连线保留）
 *   4. **协作** —— 多段可以同时交给不同子智能，互不干扰
 *
 * ## 为什么分片存
 * 一次性把 98 段的图攒在内存里，任何一段失败就全丢。分片存盘之后：
 * 中断能续、失败能重试、并行不互相覆盖。
 *
 * ## 合并策略
 * 不是简单拼接。同一类节点（比如「江哲」在三段里都出现）要合并成一条，
 * `sources` 取并集 —— 这样全书图里一个人物只有一个节点，但出处能追到
 * 所有提到他的段落。这才是「拼起来」而不是「堆起来」。
 *
 * @module dsh-writing-slots/batch
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { chunkBook, chunkText } from './library.js'
import * as logicmap from './logicmap.js'

/** 分片图的目录（在工作目录下）。 */
export const PARTS_DIR = '设定/逻辑图分片'

/** 一段的状态。 */
export const PART_STATE = {
  pending: '待拆',
  running: '在拆',
  done: '已完成',
  failed: '失败',
  skipped: '跳过',
}

/** 分片文件路径。 */
export function partPath(workspace, index) {
  return join(workspace, PARTS_DIR, `第${String(index).padStart(4, '0')}段.json`)
}

/** 读一段的分片（没有返回 null）。 */
export async function loadPart(workspace, index) {
  try {
    const parsed = JSON.parse(await readFile(partPath(workspace, index), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** 存一段的分片（原子写）。 */
export async function savePart(workspace, index, payload) {
  const dir = join(workspace, PARTS_DIR)
  await mkdir(dir, { recursive: true })
  const p = partPath(workspace, index)
  const tmp = `${p}.tmp-${process.pid}`
  const body = { index, savedAt: new Date().toISOString(), ...payload }
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await rename(tmp, p)
  return { ok: true, path: p, index }
}

/** 删一段的分片。 */
export async function removePart(workspace, index) {
  const p = partPath(workspace, index)
  if (!existsSync(p)) return { ok: false, reason: `没有第 ${index + 1} 段的分片` }
  await unlink(p)
  return { ok: true, index }
}

/**
 * 列出全部段与它们的进度。
 *
 * 这是「看板」：98 段里哪几段完成了、哪几段要重跑。
 */
export async function plan(workspace, options = {}) {
  const path = await resolveBook(workspace, options.path)
  if (path.ok !== true) return path

  const book = await chunkBook(path.path, { chunkChars: options.chunkChars, limit: 100000 })
  const rows = []
  // 注意 chunkBook 的 chunks 默认只回前 50 段（预览用途）。这里要的是**全部**，
  // 否则 plan 只看到 50 段、永远拆不完第 51 段之后 —— 所以显式要 limit 拉满。
  for (const c of book.chunks) {
    const part = await loadPart(workspace, c.index)
    const done = part !== null && part.map !== undefined
    // 状态三态：done / running（在拆，带开始时间，界面据此倒计时）/ pending
    let state = 'pending'
    if (done) state = 'done'
    else if (part?.state === 'running') state = 'running'
    else if (part?.state === 'failed') state = 'failed'
    rows.push({
      index: c.index,
      title: c.title,
      chapters: c.chapters,
      chars: c.chars,
      state,
      nodes: done ? (part.map.nodes?.length ?? 0) : 0,
      savedAt: part?.savedAt ?? null,
      // running 时给开始时间与预期耗时，界面据此倒计时
      startedAt: part?.startedAt ?? null,
      etaMs: part?.etaMs ?? null,
      // 从 Model 产出但校验没过的那次，标出来
      failed: part?.error ?? null,
    })
  }
  const done = rows.filter((x) => x.state === 'done')
  const running = rows.filter((x) => x.state === 'running')
  const failed = rows.filter((x) => x.state === 'failed')
  return {
    ok: true,
    book: path.path,
    bookName: path.path.split('/').pop(),
    totalChars: book.totalChars,
    chapterMarks: book.chapterMarks,
    byChapter: book.byChapter,
    total: rows.length,
    done: done.length,
    running: running.length,
    failed: failed.length,
    pending: rows.length - done.length - running.length - failed.length,
    nodesSoFar: done.reduce((a, x) => a + x.nodes, 0),
    rows,
    // 合并所需的最少信息：全部完成了吗
    allDone: done.length === rows.length,
  }
}

/** 找要拆的书：显式给 → 工作目录 本地书/ 里第一本 txt。 */
async function resolveBook(workspace, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return existsSync(explicit) ? { ok: true, path: explicit } : { ok: false, reason: `文件不存在：${explicit}` }
  }
  const dir = join(workspace, '本地书')
  let names = []
  try { names = (await readdir(dir)).filter((n) => /\.txt$/i.test(n)) } catch { names = [] }
  if (names.length === 0) return { ok: false, reason: `本地书/ 里没有 txt（${dir}）` }
  return { ok: true, path: join(dir, names[0]) }
}

/**
 * 取一段的**拆解任务**：正文 + 提示词素材。
 *
 * 多段可以并发取，互不影响 —— 这是「几个子智能同时拆」的基础。
 */
export async function nextTask(workspace, options = {}) {
  const path = await resolveBook(workspace, options.path)
  if (path.ok !== true) return path

  const book = await chunkBook(path.path, { chunkChars: options.chunkChars, limit: 100000 })
  const total = book.total

  // 指定了序号就直接取那一段
  if (Number.isFinite(options.index)) {
    const c = await chunkText(path.path, Number(options.index), { chunkChars: options.chunkChars })
    if (c.ok !== true) return c
    return {
      ok: true, index: c.index, title: c.title, chapters: c.chapters, chars: c.chars, total,
      text: c.text, bookName: path.path.split('/').pop(), bookPath: path.path,
    }
  }

  // 没指定：取**第一段还没完成的**
  for (let i = 0; i < total; i += 1) {
    if (await loadPart(workspace, i) !== null) continue
    const c = await chunkText(path.path, i, { chunkChars: options.chunkChars })
    if (c.ok !== true) continue
    return {
      ok: true, index: c.index, title: c.title, chapters: c.chapters, chars: c.chars, total,
      text: c.text, bookName: path.path.split('/').pop(), bookPath: path.path,
    }
  }
  return { ok: false, reason: `全部 ${total} 段都已完成`, total, allDone: true }
}

/**
 * 取**一批**待拆任务（给并发拆解用）。
 *
 * 一次取 N 段，每段都是自包含的（正文 + 序号），可以同时交给不同子智能。
 * 已经完成或标了 running 的段不会被重复派发。
 */
export async function claimBatch(workspace, options = {}) {
  const path = await resolveBook(workspace, options.path)
  if (path.ok !== true) return path

  const size = Number.isFinite(options.size) ? Math.max(1, Math.min(options.size, 20)) : 4
  const book = await chunkBook(path.path, { chunkChars: options.chunkChars, limit: 100000 })
  const tasks = []

  for (let i = 0; i < book.total && tasks.length < size; i += 1) {
    const part = await loadPart(workspace, i)
    if (part !== null && part.map !== undefined) continue     // 已完成
    if (part !== null && part.state === 'running' && options.retake !== true) continue  // 别人在拆
    const c = await chunkText(path.path, i, { chunkChars: options.chunkChars })
    if (c.ok !== true) continue
    // 标记在拆（防重复派发）
    // 记 startedAt 与 etaMs：界面据这两个字段显示倒计时。
    // 每 5000 字按 60 秒估（放慢一点，估短了倒计时到点却没好更难受）。
    const etaMs = Math.round((c.chars / 5000) * 60000)
    await savePart(workspace, i, {
      state: 'running',
      startedAt: new Date().toISOString(),
      etaMs,
      title: c.title,
      chars: c.chars,
    })
    tasks.push({
      index: i, title: c.title, chapters: c.chapters, chars: c.chars,
      total: book.total, text: c.text,
      bookName: path.path.split('/').pop(),
    })
  }

  return {
    ok: tasks.length > 0,
    reason: tasks.length === 0 ? '没有待拆的段了（全部完成，或在拆）' : null,
    book: path.path,
    total: book.total,
    claimed: tasks.length,
    remaining: book.total - (await countDone(workspace, book.total)),
    tasks,
  }
}

async function countDone(workspace, total) {
  let n = 0
  for (let i = 0; i < total; i += 1) {
    const p = await loadPart(workspace, i)
    if (p !== null && p.map !== undefined) n += 1
  }
  return n
}

/**
 * 收下某一段的拆解结果。
 *
 * @param index 段号。
 * @param raw 模型产出的 JSON 文本（或已解析的对象）。
 */
export async function acceptPart(workspace, index, raw) {
  const parsed = typeof raw === 'string' ? logicmap.parseMap(raw) : { ok: true, map: raw }
  if (parsed.ok !== true) {
    // 失败也存档：这样 plan 能看出「这段失败了」，重试时知道该重跑哪段
    await savePart(workspace, index, { state: 'failed', error: parsed.reason ?? '解析失败', failedAt: new Date().toISOString() })
    return { ok: false, reason: parsed.reason ?? '解析失败', index }
  }
  const v = logicmap.validate(parsed.map)
  // 节点一个都没有 = 这段没拆出东西，算失败
  if ((parsed.map.nodes?.length ?? 0) === 0) {
    await savePart(workspace, index, { state: 'failed', error: '模型没给出任何节点', failedAt: new Date().toISOString() })
    return { ok: false, reason: '模型没给出任何节点', index }
  }
  await savePart(workspace, index, { state: 'done', savedAt: new Date().toISOString(), map: parsed.map, validation: v })
  return {
    ok: v.ok === true,
    index,
    stats: v.stats,
    errors: v.errors,
    warnings: v.warnings,
    // 校验不过也存了 —— 后面合并时会跳过有错的，但人能查到问题在哪
    saved: true,
  }
}

/**
 * 合并所有分片成一张全书逻辑图。
 *
 * 策略：
 *   - 节点按 `kind + 归一化后的名字` 去重；重复的把 `sources` 取并集
 *   - 连线按 `from + to + label` 去重
 *   - 出处统一加上「第 N 段」前缀，这样全书图里能追溯到段落
 */
export async function merge(workspace, options = {}) {
  const path = await resolveBook(workspace, options.path)
  if (path.ok !== true) return path
  const book = await chunkBook(path.path, { chunkChars: options.chunkChars, limit: 100000 })

  const parts = []
  const missing = []
  for (let i = 0; i < book.total; i += 1) {
    const p = await loadPart(workspace, i)
    if (p === null || p.map === undefined) { missing.push(i); continue }
    parts.push({ index: i, map: p.map, validation: p.validation })
  }

  if (parts.length === 0) return { ok: false, reason: '还没有任何一段的分片图' }

  // 节点去重
  const byKey = new Map()
  const idRemap = new Map()   // 原 id → 合并后的 id（按段区分，避免撞车）
  let seq = 0

  for (const part of parts) {
    for (const n of part.map.nodes ?? []) {
      const key = `${n.kind}|${normalizeName(n.name)}`
      // 出处统一加段号前缀。
      //
      // 判断「是否已经加过」不能用 startsWith('第') —— 素材名本身常以「第」开头
      // （「第一章.md」「第一段.md」），那样会误判成已加过、把段号漏掉。
      // 用更具体的标记：段号前缀的格式是「第N段·」。
      const hasPrefix = (s) => /^第\d+段·/.test(s)
      const src = (n.sources ?? []).map((s) => (hasPrefix(s) ? s : `第${part.index + 1}段·${s}`))
      if (byKey.has(key)) {
        const existing = byKey.get(key)
        existing.sources = [...new Set([...existing.sources, ...src])]
        // 正文取更长的那个（信息更全）
        if ((n.body?.length ?? 0) > (existing.body?.length ?? 0)) existing.body = n.body
        if ((n.summary?.length ?? 0) > (existing.summary?.length ?? 0)) existing.summary = n.summary
        idRemap.set(`${part.index}:${n.id}`, existing.id)
      } else {
        seq += 1
        const merged = {
          id: `${n.kind[0]}${seq}`,
          kind: n.kind,
          name: n.name,
          summary: n.summary ?? '',
          body: n.body ?? '',
          sources: src,
        }
        byKey.set(key, merged)
        idRemap.set(`${part.index}:${n.id}`, merged.id)
      }
    }
  }

  // 连线去重
  const edgeKeys = new Set()
  const edges = []
  for (const part of parts) {
    for (const e of part.map.edges ?? []) {
      const from = idRemap.get(`${part.index}:${e.from}`)
      const to = idRemap.get(`${part.index}:${e.to}`)
      if (from === undefined || to === undefined) continue
      const key = `${from}>${to}|${e.label ?? ''}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ from, to, label: e.label ?? '' })
    }
  }

  const map = {
    title: `${path.path.split('/').pop().replace(/\.txt$/i, '')} 全书逻辑图`,
    sources: [`${path.path.split('/').pop()}（${book.totalChars} 字，${parts.length}/${book.total} 段已拆）`],
    nodes: [...byKey.values()],
    edges,
    generatedAt: new Date().toISOString(),
  }

  const v = logicmap.validate(map)
  return {
    ok: true,
    map,
    stats: v.stats,
    errors: v.errors,
    warnings: v.warnings,
    parts: parts.length,
    total: book.total,
    missing,
    // 只说人话：还差多少段
    note: missing.length === 0
      ? `全部 ${book.total} 段已合并。`
      : `已合并 ${parts.length}/${book.total} 段，还有 ${missing.length} 段没拆（第 ${missing.slice(0, 10).map((x) => x + 1).join('、')}${missing.length > 10 ? '…' : ''} 段）。`,
  }
}

/** 名字归一化：去空白、去标点，用于去重。 */
function normalizeName(name) {
  return String(name ?? '').replace(/[\s：:（）()【】\[\]、，,。.]/g, '').toLowerCase()
}

/**
 * 把**某一段**的分片图拆成指令库条目。
 *
 * 这是「拆解完就出现在指令库里」的落点：每收下一段，顺手就能把它的节点
 * 变成指令库条目 —— 不用等全书合并完。条目带上 `段: N` 标签，这样
 * 指令库能显示「这条来自第几段」，也能按段筛。
 */
export async function partToLibrary(workspace, index, options = {}) {
  const part = await loadPart(workspace, index)
  if (part === null || part.map === undefined) {
    return { ok: false, reason: `第 ${index + 1} 段还没拆完（没有分片图）` }
  }
  const { importItems } = await import('./library.js')
  const items = logicmap.toItems(part.map).map((x) => ({
    ...x,
    // 段落标记：段号写进 tags，界面据此显示与筛选
    tags: [...new Set([...(x.tags ?? []), `段:${index + 1}`])],
    source: x.source === '逻辑图' ? `第${index + 1}段` : x.source,
  }))
  if (items.length === 0) return { ok: false, reason: '这段的图没有节点' }
  // 明确用 update：同内容的已有条目就更新它，不要每次重导都复制一份。
  // **不传 options.source** —— 传了会覆盖条目自带的 source，
  // 同一节点来自不同段时出处就拼不起来（并集失效）。
  const r = await importItems(workspace, items, { onDuplicate: options.onDuplicate ?? 'update' })
  const parts = []
  if (r.added > 0) parts.push(`新增 ${r.added}`)
  if (r.updated > 0) parts.push(`更新 ${r.updated}`)
  if ((r.skipped ?? []).length > 0) parts.push(`跳过 ${r.skipped.length}`)
  return {
    ok: r.ok === true,
    index,
    added: r.added,
    updated: r.updated ?? 0,
    skipped: r.skipped,
    items: r.items,
    note: `第 ${index + 1} 段的节点已进指令库（${parts.join('、') || '无变化'}），带「段:${index + 1}」标签。`,
  }
}

/**
 * 指令库里**哪些段已经有条目**。
 *
 * 界面用这个把「已拆解」的分段标绿。
 */
export async function partsInLibrary(workspace) {
  const { list } = await import('./library.js')
  const l = await list(workspace)
  const segs = new Map()   // 段号 → 条目数
  for (const it of l.items) {
    for (const tag of it.tags ?? []) {
      const m = /^段:(\d+)$/.exec(String(tag))
      if (m === null) continue
      const n = Number(m[1])
      segs.set(n, (segs.get(n) ?? 0) + 1)
    }
  }
  return {
    ok: true,
    // 段号（1 起）→ 条目数
    segments: Object.fromEntries([...segs.entries()].sort((a, b) => a[0] - b[0])),
    count: segs.size,
    total: l.items.length,
  }
}

/**
 * 保存合并后的全书图（同时写 md + json）。
 */
export async function saveMerged(workspace, map) {
  return logicmap.save(workspace, map)
}

/** 清掉所有分片（重来一遍时用）。 */
export async function resetParts(workspace) {
  const dir = join(workspace, PARTS_DIR)
  let n = 0
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue
      await unlink(join(dir, name))
      n += 1
    }
  } catch { /* 目录不存在就算了 */ }
  return { ok: true, cleared: n }
}

/**
 * 给子智能的分工说明。
 *
 * 并发拆解时，每个子智能只负责自己那几段，互不干扰。
 */
export function collaborationBrief(total, size) {
  const batches = Math.ceil(total / size)
  return {
    total,
    size,
    batches,
    note: `全书 ${total} 段，每次并发 ${size} 段，共 ${batches} 批。`
      + '每个子智能只拆自己领到的那几段，产出的 JSON 单独贴回来 —— '
      + '不要一个子智能读多段（上下文会串味，不同段的判断标准会漂移）。',
    steps: [
      '取一批：action=claim-batch（size=并发数）→ 拿到 N 段的正文',
      '分派：把每段的正文和拆解提示词交给一个子智能，N 个子智能并行',
      '收：每段产出的 JSON 用 action=accept-part、index=N 收下',
      '看：action=plan 看还剩几段',
      '重复直到全完成',
      '合并：action=merge → 全书逻辑图',
    ],
  }
}

/**
 * 按**指定段号**派发（给多选用的）。
 *
 * 和 claimBatch 的区别：claimBatch 自动挑「还没拆的」；这个按用户勾选的那几段派。
 * 派发时把段标记成 running，并生成给子智能体的任务说明。
 */
export async function dispatchSelected(workspace, indexes, options = {}) {
  const path = await resolveBook(workspace, options.path)
  if (path.ok !== true) return path
  const list = Array.isArray(indexes) ? indexes.map(Number).filter((x) => Number.isFinite(x)) : []
  if (list.length === 0) return { ok: false, reason: '没有选中任何分段' }

  const book = await chunkBook(path.path, { chunkChars: options.chunkChars, limit: 100000 })
  const tasks = []
  const skipped = []
  for (const i of list) {
    if (i < 0 || i >= book.total) { skipped.push({ index: i, reason: '段号越界' }); continue }
    const part = await loadPart(workspace, i)
    if (part !== null && options.force !== true) {
      // 已拆完 → 跳过；正在拆 → 也跳过（避免两个子智能体重复拆同一段）
      if (part.map !== undefined) {
        skipped.push({ index: i, reason: '已拆完（要重拆请带 force）' })
        continue
      }
      if (part.state === 'running') {
        skipped.push({ index: i, reason: '已在拆（要重派请带 force）' })
        continue
      }
    }
    const c = await chunkText(path.path, i, { chunkChars: options.chunkChars })
    if (c.ok !== true) { skipped.push({ index: i, reason: c.reason ?? '取不到正文' }); continue }
    const etaMs = Math.round((c.chars / 5000) * 60000)
    await savePart(workspace, i, {
      state: 'running', startedAt: new Date().toISOString(), etaMs,
      title: c.title, chars: c.chars,
    })
    tasks.push({ index: i, title: c.title, chapters: c.chapters, chars: c.chars, text: c.text })
  }

  // 生成给子智能体的派发说明
  const bookName = path.path.split('/').pop()
  const lines = [
    `# 拆解任务：${bookName}`,
    '',
    `共派发 **${tasks.length}** 段。每段交给一个「拆文子智能体」独立拆，互不干扰。`,
    '',
    '> **一个子智能体只拆一段。** 让它一次读多段，抽出来的判断标准会漂，',
    '> 合并时互相矛盾，而且那种矛盾在合并后的图里根本看不出来。',
    '',
  ]
  for (const t of tasks) {
    lines.push(`## 第 ${t.index + 1} 段 ｜ ${t.title}`)
    lines.push('')
    lines.push(`- 正文 ${t.chars} 字，${t.chapters} 章`)
    lines.push(`- 取正文：`+'`novel_logic_map(action=chunk, chunkIndex=' + t.index + ')`')
    lines.push(`- 收回产出：`+'`novel_logic_map(action=accept-part, index=' + t.index + ', text=<子智能体产出的 JSON>)`')
    lines.push('')
    lines.push('派给子智能体时，把正文 + 它的人格提示（拆文子智能体 preset 已内置）一起给它。')
    lines.push('')
  }
  if (skipped.length > 0) {
    lines.push('## 跳过')
    lines.push('')
    for (const x of skipped) lines.push(`- 第 ${x.index + 1} 段：${x.reason}`)
    lines.push('')
  }
  lines.push('全部收回后：' + '`novel_logic_map(action=merge)`' + ' 合并成全书的图。')

  return {
    ok: tasks.length > 0,
    reason: tasks.length === 0 ? '选中的段都没法派发（已拆完或越界）' : null,
    claimed: tasks.length,
    total: book.total,
    skipped,
    tasks: tasks.map((t) => ({ index: t.index, title: t.title, chars: t.chars })),
    brief: lines.join('\n'),
    // 给工具层直接用的：每段的正文
    payloads: tasks.map((t) => ({ index: t.index, title: t.title, text: t.text })),
  }
}
