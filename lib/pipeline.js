/**
 * dsh-writing-slots — 编排层。
 *
 * 把四个模块串成流水线，但**每道人工门禁都停住**：这个插件不替人做决定，
 * 它只把「该看什么」摆出来。
 *
 * ```
 * Style Anchor ──[人审：像不像我写的]──> style-guide.md
 *                                           │
 * Chapter Pack <── 自动注入 style digest ───┘
 *      │
 *      └──[人审：章尾钩与情感落点]──> 初稿
 *                                       │
 * Review Pass（独立上下文，看不到 style-guide）
 *      │
 *      └──[人决定改哪些]──> 修改稿
 *                              │
 *                        De-AI Polish
 *                              │
 *                              └──[人通读]──> 润色稿
 * ```
 *
 * @module dsh-writing-slots/pipeline
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { compose, digestOf, render, checkContract } from './render.js'
import { analyze, toMarkdown, parseMarkdown, countChars, plainText } from './style.js'
import { inspect, chapterTaskFrom, bibleSliceFrom, padChapter, findChapter } from './project.js'
import { CHAPTER_PACK, REVIEW_PASS, DEAI_POLISH, STYLE_ANCHOR, WORLD_BUILDER, CHARACTER_DESIGNER, READER_SIM, INSTRUCTION_MINER, SUBAGENT_DECOMPOSE } from './prompts.js'
import { list as libList, KINDS as LIB_KINDS, importItems as libImport, extractFromWorkspace } from './library.js'
import * as logicmap from './logicmap.js'
import { validateWorld, validateCharacter } from './bible.js'
import { READERS, reader as findReader, promptFor, validateReaderOutput, summarize } from './reader.js'
import { validatePressureConfig, pressureSlice, validateInfoGap, validateScenes, validateCurve, temperatureAt } from './story.js'
import { check as sanityCheck } from './sanity.js'
import { checkIsolation, REVIEW_CONTRACT } from './review.js'
import { detect, changeLog } from './polish.js'

/** 风格指南文件名。 */
export const STYLE_GUIDE_NAME = 'style-guide.md'

// ————————————————————————— 1. Style Anchor —————————————————————————

/**
 * 跑 Style Anchor。
 *
 * @param projectDir 项目目录。
 * @param samplePaths 样本文件路径数组（3—5 篇，总计 ≥5 万字）。
 * @param options `{ genreTags, shortMax, force }`。
 */
export async function runStyleAnchor(projectDir, samplePaths, options = {}) {
  const paths = (samplePaths ?? []).filter((p) => typeof p === 'string' && p !== '')
  if (paths.length === 0) {
    return { ok: false, reason: '没有给样本。需要 3—5 篇、总计 ≥5 万字的样本文件路径。' }
  }
  const samples = []
  const unreadable = []
  for (const p of paths) {
    try {
      samples.push({ name: p.split('/').pop(), text: await readFile(p, 'utf8') })
    } catch (e) {
      unreadable.push({ path: p, reason: e?.message ?? String(e) })
    }
  }
  if (unreadable.length > 0 && samples.length === 0) {
    return { ok: false, reason: `样本都读不到：${unreadable.map((u) => u.path).join('、')}`, unreadable }
  }

  const analysis = analyze(samples, {
    minSamples: options.minSamples ?? 3,
    minChars: options.minChars ?? 50000,
    shortMax: options.shortMax ?? 15,
  })
  if (analysis.ok !== true) {
    return {
      ok: false,
      reason: `样本不达标：${analysis.problems.join('；')}`,
      problems: analysis.problems,
      sampleCount: analysis.sampleCount,
      totalChars: analysis.totalChars,
      unreadable,
    }
  }

  const guidePath = join(projectDir, STYLE_GUIDE_NAME)
  const markdown = toMarkdown(analysis, { project: options.project })

  // 渲染给模型的那份提示词（数字已经由系统算好，模型只挑例句）
  const g = analysis.guide
  const composed = compose(STYLE_ANCHOR.template, STYLE_ANCHOR.contract, {
    sample_corpus: samples.map((s) => `【${s.name}】\n${s.text}`).join('\n\n'),
    measurements: [
      g.sentence_length_baseline.summary,
      g.paragraph_rhythm.summary,
      g.sensory_bias.summary,
      g.metaphor_fingerprint.summary,
    ].join('\n'),
    sentence_summary: g.sentence_length_baseline.summary,
    paragraph_summary: g.paragraph_rhythm.summary,
    sensory_summary: g.sensory_bias.summary,
    metaphor_summary: g.metaphor_fingerprint.summary,
    forbidden_candidates: g.forbidden_list.map((f, i) => `${i + 1}. ${f.rule}`).join('\n') || '（无）',
    genre_tags: options.genreTags ?? null,
    project: options.project ?? null,
  }, { maxSlotChars: 200000 })

  return {
    ok: true,
    guidePath,
    markdown,
    guide: g,
    prompt: composed.ok === true ? composed.prompt : null,
    promptErrors: composed.ok === true ? [] : composed.errors,
    sampleCount: analysis.sampleCount,
    totalChars: analysis.totalChars,
    // 人审门禁：这一步要人确认「像不像我写的」，所以先不写盘。
    gate: STYLE_ANCHOR.gate,
    needsHumanReview: true,
  }
}

/** 读过一次风格指南并解析成结构化对象。 */
export async function loadStyleGuide(projectDir) {
  const path = join(projectDir, STYLE_GUIDE_NAME)
  if (!existsSync(path)) return null
  const text = await readFile(path, 'utf8')
  return { path, text, parsed: parseMarkdown(text), digest: digestOf(parseMarkdown(text)) }
}

// ————————————————————————— 1b. World Builder —————————————————————————

/** 世界观文档名。 */
export const WORLD_BIBLE_NAME = 'world-bible.md'

/**
 * 组装 World Builder 提示词。
 *
 * @param genre 题材（必填）。
 * @param options `{ outline, constraints, avoid }`。
 */
export async function runWorldBuilder(projectDir, genre, options = {}) {
  if (typeof genre !== 'string' || genre.trim() === '') {
    return { ok: false, reason: '需要给题材 genre。' }
  }
  // 已有大纲就注入，避免模型另起一套与之冲突的设定
  let outline = options.outline ?? null
  if (outline === null) {
    const st = await inspect(projectDir, null)
    if (st.outline !== null) outline = st.outline
  }
  const composed = compose(WORLD_BUILDER.template, WORLD_BUILDER.contract, {
    genre: genre.trim(),
    existing_outline: outline,
    constraints: options.constraints ?? null,
    avoid: options.avoid ?? null,
  }, { maxSlotChars: 6000 })
  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    guidePath: join((await inspect(projectDir, null)).root, WORLD_BIBLE_NAME),
    gate: WORLD_BUILDER.gate,
    needsHumanReview: true,
  }
}

/** 校验世界观产出。 */
export function checkWorld(markdown) {
  return validateWorld(markdown)
}

// ————————————————————————— 1c. Character Designer —————————————————————————

/** 组装 Character Designer 提示词。 */
export async function runCharacterDesigner(projectDir, character, options = {}) {
  if (typeof character !== 'string' || character.trim() === '') {
    return { ok: false, reason: '需要给角色名 character。' }
  }
  const st = await inspect(projectDir, null)
  const composed = compose(CHARACTER_DESIGNER.template, CHARACTER_DESIGNER.contract, {
    character: character.trim(),
    role: options.role ?? null,
    genre: options.genre ?? null,
    existing: options.existing ?? null,
  }, { maxSlotChars: 4000 })
  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    project: st.root,
    gate: CHARACTER_DESIGNER.gate,
    needsHumanReview: true,
  }
}

/** 校验人物卡产出。 */
export function checkCharacter(markdown) {
  return validateCharacter(markdown)
}

// ————————————————————————— 2. Chapter Pack —————————————————————————

/**
 * 组装 Chapter Pack。
 *
 * 自动注入的三个槽位都从项目文件里来：风格摘要、本章涉及的设定、上一章提要。
 */
export async function runChapterPack(projectDir, chapterNo, options = {}) {
  const state = await inspect(projectDir, chapterNo)
  const no = padChapter(chapterNo)
  if (no === null) return { ok: false, reason: `章号不合法：${chapterNo}` }

  const guide = await loadStyleGuide(state.root)
  if (guide === null) {
    return { ok: false, reason: `找不到 ${STYLE_GUIDE_NAME}。Chapter Pack 需要 Style Anchor 产出的摘要作为固定前缀。`, needsStyleAnchor: true }
  }

  const task = chapterTaskFrom(state.brief)
  if (task.ok !== true) {
    return {
      ok: false,
      reason: `本章细纲缺字段：${task.missing.join('、')}`,
      missing: task.missing,
      briefPath: state.briefPath,
    }
  }
  // cast 由调用方补（细纲里没有出场人物清单）
  task.task.cast = Array.isArray(options.cast) && options.cast.length > 0
    ? options.cast
    : ['（未指定，按细纲中出现的人物）']

  const wordRange = Array.isArray(options.wordRange) && options.wordRange.length === 2
    ? `${options.wordRange[0]}–${options.wordRange[1]} 字`
    : (typeof options.wordRange === 'string' ? options.wordRange : '1900–2200 字')

  // bible_slice：只给本章相关的部分
  let volumeText = null
  const volMatch = /卷\s*0*(\d+)/.exec(state.brief?.time ?? '')
  if (volMatch !== null) {
    const vp = join(state.root, '卷纲', `卷${String(volMatch[1]).padStart(2, '0')}.md`)
    if (existsSync(vp)) volumeText = await readFile(vp, 'utf8')
  }

  const slots = {
    chapter_no: no,
    chapter_task: task.task,
    word_range: wordRange,
    style_guide_digest: guide.digest,
    bible_slice: bibleSliceFrom(state, { volumeText }),
    prev_recap: state.prev === null
      ? '（没有上一章提要：这是第一章）'
      : `${state.prev.no}《${state.prev.title}》\n${state.prev.body}`,
    avoid_list: options.avoidList !== undefined
      ? options.avoidList
      : (state.brief?.forbidden === null || state.brief?.forbidden === undefined
        ? null
        : state.brief.forbidden.split(/[；;]\s*/).map((x) => x.trim()).filter((x) => x !== '')),
    pov: options.pov ?? '第三人称限知（吴常）',
    tense: options.tense ?? '过去时',
    ending_type: options.endingType ?? 'hook',
  }

  const composed = compose(CHAPTER_PACK.template, CHAPTER_PACK.contract, slots, { maxSlotChars: 6000 })
  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    warnings: composed.ok === true ? composed.warnings : [],
    slots,
    project: state.root,
    briefPath: state.briefPath,
    gate: CHAPTER_PACK.gate,
    needsHumanReview: true,
  }
}

// ————————————————————————— 2b. Reader Simulation —————————————————————————

/**
 * 跑读者通道。
 *
 * 可以只跑一个读者（要求里的最小可行：先请通勤读者小陈）。
 * 返回每个读者的完整提示词，由调用方分别执行 —— 三个读者是**独立的三次调用**，
 * 不是一次调用里让他们轮流说话（那样会互相影响，也就测不出各自的反应）。
 */
export async function runReaderSim(projectDir, chapterNo, options = {}) {
  const state = await inspect(projectDir, chapterNo)

  let draft = options.draft ?? null
  let source = 'explicit'
  if (draft === null) {
    const found = await findChapter(state.root, chapterNo)
    if (found === null) {
      return { ok: false, reason: `找不到第 ${padChapter(chapterNo)} 章的正文。读者通道要读初稿，请先落盘或给 draft。` }
    }
    draft = found.text
    source = found.path
  }

  const want = Array.isArray(options.readers) && options.readers.length > 0
    ? options.readers
    : READERS.map((r) => r.id)
  const personas = []
  const unknown = []
  for (const id of want) {
    const p = findReader(id)
    if (p === null) { unknown.push(id); continue }
    personas.push(p)
  }
  if (personas.length === 0) {
    return { ok: false, reason: `没有可用的读者人格。可用的：${READERS.map((r) => `${r.id}（${r.title}）`).join('、')}`, unknown }
  }

  const prompts = personas.map((p) => {
    const composed = compose(READER_SIM.template, READER_SIM.contract, {
      persona_prompt: promptFor(p, padChapter(chapterNo)),
      chapter_no: padChapter(chapterNo),
      draft,
      persona: p.id,
    }, { maxSlotChars: 40000 })
    return {
      id: p.id, name: p.name, title: p.title, tests: p.tests,
      ok: composed.ok === true,
      errors: composed.ok === true ? [] : composed.errors,
      prompt: composed.ok === true ? composed.prompt : null,
    }
  })

  return {
    ok: prompts.every((x) => x.ok),
    prompts,
    unknown,
    source,
    // 顺序说明：读者必须先于审稿，因为审稿会改稿
    orderNote: '读者通道要读**未修改的初稿**。若已经跑过 Review Pass 并改了稿，读者反应就不再是「第一次翻开」的体验了。',
    gate: READER_SIM.gate,
    needsHumanReview: true,
  }
}

/** 汇总三个读者的产出（传 `{id, verdict}` 数组）。 */
export function summarizeReaders(results) {
  return summarize(results)
}

/** 校验单个读者的产出（越权扫描 + 锚点契约）。 */
export function checkReaderOutput(payload) {
  return validateReaderOutput(payload)
}

// ————————————————————————— 2c. Instruction Miner —————————————————————————

/**
 * 组装「拆文入库」提示词。
 *
 * 这是「多次读小说 → 沉淀成指令」的那一步：读一本书，抽出可执行的指令片段。
 */
export async function runMiner(projectDir, options = {}) {
  const text = String(options.text ?? '').trim()
  if (text === '') return { ok: false, reason: '需要 book_text（要拆的正文）' }

  const focus = Array.isArray(options.kinds) && options.kinds.length > 0
    ? options.kinds.filter((k) => LIB_KINDS.some((x) => x.id === k))
    : LIB_KINDS.map((k) => k.id)
  const focusText = LIB_KINDS.filter((k) => focus.includes(k.id)).map((k) => `  - ${k.id}（${k.label}）：${k.desc}`).join('\n')

  // 已有条目也给它看：避免重复抽同一条，也让它知道哪些角度已经覆盖了
  let existing = null
  if (options.avoidDuplicates !== false) {
    const l = await libList(projectDir)
    if (l.items.length > 0) {
      const names = l.items.slice(0, 60).map((x) => `- [${x.kind}] ${x.name}`).join('\n')
      existing = `EXISTING（指令库里已有的条目，**不要重复抽这些角度**）:\n${names}\n`
    }
  }

  const composed = compose(INSTRUCTION_MINER.template, INSTRUCTION_MINER.contract, {
    book_text: text,
    book_name: options.bookName ?? '（未命名）',
    focus_kinds: focusText,
    existing_items: existing,
  }, { maxSlotChars: 120000 })

  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    chars: text.length,
    focus,
    gate: INSTRUCTION_MINER.gate,
    needsHumanReview: true,
    // 产出怎么进来：解析后导入指令库
    importHint: '把模型产出的 JSON 用 library(action=import) 导入，条目就会出现在「指令库」页签。',
  }
}

// ————————————————————————— 2d. 子智能拆解 → 逻辑图 —————————————————————————

/**
 * 组装「子智能拆解」提示词。
 *
 * 流程的中间那一步：写作槽位提取了素材 → 交给子智能读 → 产出逻辑图 JSON。
 *
 * @param options `{ material, materialList, kinds, existingMap }`
 */
export async function runDecompose(projectDir, options = {}) {
  const text = String(options.material ?? '').trim()
  if (text === '') return { ok: false, reason: '需要 material（要拆的素材正文）' }

  const focus = Array.isArray(options.kinds) && options.kinds.length > 0
    ? options.kinds.filter((k) => logicmap.NODE_KINDS.some((x) => x.id === k))
    : logicmap.NODE_KINDS.map((k) => k.id)
  const focusText = logicmap.NODE_KINDS
    .filter((k) => focus.includes(k.id))
    .map((k) => `  - ${k.id}（${k.label}）→ 喂给 ${k.slot}：${k.desc}`)
    .join('\n')

  const listText = Array.isArray(options.materialList) && options.materialList.length > 0
    ? options.materialList.map((x) => `- ${x}`).join('\n')
    : '（未提供清单）'

  // 已有图给它看：这样是「续着长」而不是每次推倒重来
  let existing = null
  if (typeof options.existingMap === 'string' && options.existingMap !== '') {
    existing = `EXISTING_MAP（已有的逻辑图，**在它基础上补充，不要丢掉已有的节点**）:\n${options.existingMap.slice(0, 6000)}\n`
  }

  const composed = compose(SUBAGENT_DECOMPOSE.template, SUBAGENT_DECOMPOSE.contract, {
    material: text,
    material_list: listText,
    focus_nodes: focusText,
    existing_map: existing,
  }, { maxSlotChars: 150000 })

  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    chars: text.length,
    focus,
    gate: SUBAGENT_DECOMPOSE.gate,
    needsHumanReview: true,
  }
}

/**
 * 收下子智能的产出 → 校验 → 存成逻辑图。
 *
 * @param raw 模型产出的 JSON 文本。
 */
export async function acceptMap(projectDir, raw) {
  const parsed = logicmap.parseMap(raw)
  if (parsed.ok !== true) return { ok: false, reason: parsed.reason }
  const saved = await logicmap.save(projectDir, parsed.map)
  return {
    ok: saved.validation.ok === true,
    path: saved.path,
    validation: saved.validation,
    stats: saved.stats,
    map: parsed.map,
    // 存了图之后，下一步是把它拆成指令库条目
    next: '用 action=to-library 把图拆成指令库条目（当后续写作的真实素材库）',
  }
}

/**
 * 把已存的逻辑图拆成指令库条目。
 *
 * 「把结果传送并存在指令库，相当后续写作的真实素材库」—— 就是这一步。
 */
export async function mapToLibrary(projectDir, options = {}) {
  const loaded = await logicmap.load(projectDir)
  if (loaded === null) return { ok: false, reason: `还没有逻辑图（${logicmap.MAP_DIR}/${logicmap.MAP_NAME}）` }

  // 图是 markdown，条目要从原始 JSON 来 —— 所以这里读旁边的 .json 备份
  const jsonPath = loaded.path.replace(/\.md$/, '.json')
  let map = null
  try {
    map = JSON.parse(await (await import('node:fs/promises')).readFile(jsonPath, 'utf8'))
  } catch {
    return { ok: false, reason: '找不到逻辑图的 JSON 备份，没法拆成条目（先重新 action=accept-map 一次）' }
  }

  const items = logicmap.toItems(map)
  if (items.length === 0) return { ok: false, reason: '图里没有节点' }
  const r = await libImport(projectDir, items, { source: options.source ?? '逻辑图', overwrite: options.overwrite === true })
  return {
    ok: r.ok === true,
    added: r.added,
    skipped: r.skipped,
    items: r.items,
    mapPath: loaded.path,
    note: '这些条目默认启用 —— 图里的节点已经是加工过的结论，不是原料。',
  }
}

/** 读当前逻辑图（给界面显示）。 */
export async function readMap(projectDir) {
  const loaded = await logicmap.load(projectDir)
  if (loaded === null) return { ok: false, reason: '还没有逻辑图' }
  return { ok: true, path: loaded.path, text: loaded.text }
}

// ————————————————————————— 3. Review Pass —————————————————————————

/**
 * 组装 Review Pass。
 *
 * **隔离是强制的**：只接受 draft / bibleSnapshot / prevSummary 三个入参，
 * 调用方多给的一律拒绝。这样审稿看不到 style-guide、看不到章节任务 ——
 * 它不知道作者「本来想写成什么样」，也就没法替作者找理由。
 */
export async function runReviewPass(projectDir, chapterNo, options = {}) {
  const state = await inspect(projectDir, chapterNo)

  let draft = options.draft ?? null
  let source = 'explicit'
  if (draft === null) {
    const found = await findChapter(state.root, chapterNo)
    if (found === null) {
      return { ok: false, reason: `找不到第 ${padChapter(chapterNo)} 章的正文。请给 draft，或先把初稿落盘。` }
    }
    draft = found.text
    source = found.path
  }

  const slots = {
    draft,
    bible_snapshot: options.bibleSnapshot ?? (state.brief === null
      ? '（无设定快照）'
      : [`本章时间：${state.brief.time ?? '未知'}`, `本章伏笔：${state.brief.foreshadow ?? '无'}`].join('\n')),
    prev_summary: options.prevSummary ?? (state.prev === null
      ? '（没有上一章）'
      : `${state.prev.no}《${state.prev.title}》：${state.prev.body}`),
  }

  // 隔离检查：调用方若塞了别的槽位，直接拒绝而不是忽略。
  const iso = checkIsolation(slots)
  const isoArgs = checkIsolation(options.extraSlots ?? {})
  if (isoArgs.ok !== true) {
    return {
      ok: false,
      reason: `破坏了上下文隔离：不允许把 ${isoArgs.offending.join('、')} 交给审稿模块。审稿只该看到 ${REVIEW_CONTRACT.required.concat(REVIEW_CONTRACT.auto_injected).join(' / ')}。`,
      offending: isoArgs.offending,
    }
  }

  const composed = compose(REVIEW_PASS.template, REVIEW_PASS.contract, slots, { maxSlotChars: 40000 })
  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    source,
    isolation: { enforced: true, allowed: iso.allowed, seeStyleGuide: false },
    gate: REVIEW_PASS.gate,
    needsHumanReview: true,
  }
}

// ————————————————————————— 4. De-AI Polish —————————————————————————

/**
 * 组装 De-AI Polish。
 *
 * 系统先跑一遍检测，把**逐条违规证据**放进提示词 —— 模型改的是这些点，
 * 不是「帮我润色一下」。
 */
export async function runDeaiPolish(projectDir, chapterNo, options = {}) {
  const state = await inspect(projectDir, chapterNo)
  const guide = await loadStyleGuide(state.root)
  if (guide === null) {
    return { ok: false, reason: `找不到 ${STYLE_GUIDE_NAME}。去味层的判断依据来自它。`, needsStyleAnchor: true }
  }

  let text = options.text ?? null
  let source = 'explicit'
  if (text === null) {
    const found = await findChapter(state.root, chapterNo)
    if (found === null) return { ok: false, reason: `找不到第 ${padChapter(chapterNo)} 章的正文。` }
    text = found.text
    source = found.path
  }

  const floor = options.shortFloor ?? guide.parsed.short_ratio_value ?? null
  const scan = detect(text, { shortFloor: floor })

  const violationText = scan.violations.length === 0 && scan.rhythm === null
    ? '（系统扫描未发现违规点。此时**不要改动正文**，原样返回。）'
    : [
      ...scan.violations.map((v) => `[${v.id}] ${v.rule}\n${v.hits.map((h) => `  - ${h.where}：${h.evidence}`).join('\n')}`),
      scan.rhythm === null ? null : `[rhythm] ${scan.rhythm}`,
    ].filter((x) => x !== null).join('\n')

  const slots = {
    text,
    style_guide_forbidden: guide.parsed.forbidden_list.length === 0
      ? '（样本中所有被检查的句式都出现过，无禁忌项）'
      : guide.parsed.forbidden_list.map((f, i) => `${i + 1}. ${f}`).join('\n'),
    violations: violationText,
    short_ratio_floor: floor === null ? '（无基线）' : `${Math.round(floor * 100)}%`,
  }

  const composed = compose(DEAI_POLISH.template, DEAI_POLISH.contract, slots, { maxSlotChars: 40000 })
  return {
    ok: composed.ok === true,
    promptErrors: composed.ok === true ? [] : composed.errors,
    prompt: composed.ok === true ? composed.prompt : null,
    scan: { violations: scan.violations, totalHits: scan.totalHits, rhythm: scan.rhythm, stats: scan.stats },
    source,
    gate: DEAI_POLISH.gate,
    needsHumanReview: true,
  }
}

/**
 * 复验去味结果。
 *
 * 模型说「已润色」不算数 —— 这里用同一套规则再跑一遍，给出改前改后的计数。
 * 若改写引入了新毛病（命中变多），要明确报出来。
 */
export async function verifyPolish(projectDir, beforeText, afterText) {
  const guide = await loadStyleGuide(projectDir)
  const floor = guide?.parsed?.short_ratio_value ?? null
  const log = changeLog(beforeText, afterText, { shortFloor: floor })
  return {
    ok: true,
    ...log,
    // 只有真的干净了才算过
    accepted: log.cleaned === true,
    floor,
  }
}

/** 四个模块的状态总览（给界面用）。 */
export async function moduleStatus(projectDir) {
  const state = await inspect(projectDir, null)
  const guide = await loadStyleGuide(state.root)
  const worldPath = join(state.root, WORLD_BIBLE_NAME)
  const hasWorld = existsSync(worldPath)
  return {
    project: state.root,
    layout: state.layout,
    pending: state.pending,
    modules: [
      { id: 'style_anchor', ready: guide !== null, note: guide === null ? '还没跑过：缺 style-guide.md' : `已有 ${STYLE_GUIDE_NAME}` },
      { id: 'world_builder', ready: hasWorld, note: hasWorld ? `已有 ${WORLD_BIBLE_NAME}` : '还没跑过：缺 world-bible.md' },
      { id: 'character_designer', ready: hasWorld, note: hasWorld ? '可基于世界观设计人物' : '先跑 World Builder' },
      { id: 'chapter_pack', ready: guide !== null && state.layout.briefs > 0, note: guide === null ? '先跑 Style Anchor' : `有 ${state.layout.briefs} 份细纲可用` },
      { id: 'reader_sim', ready: state.layout.chapters > 0, note: `有 ${state.layout.chapters} 章正文可读（要读未修改的初稿）` },
      { id: 'review_pass', ready: state.layout.chapters > 0, note: `有 ${state.layout.chapters} 章正文可审` },
      { id: 'deai_polish', ready: guide !== null, note: guide === null ? '先跑 Style Anchor' : '依据 style-guide 的禁忌清单' },
    ],
  }
}
