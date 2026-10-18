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
import { CHAPTER_PACK, REVIEW_PASS, DEAI_POLISH, STYLE_ANCHOR } from './prompts.js'
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
  return {
    project: state.root,
    layout: state.layout,
    pending: state.pending,
    modules: [
      { id: 'style_anchor', ready: guide !== null, note: guide === null ? '还没跑过：缺 style-guide.md' : `已有 ${STYLE_GUIDE_NAME}` },
      { id: 'chapter_pack', ready: guide !== null && state.layout.briefs > 0, note: guide === null ? '先跑 Style Anchor' : `有 ${state.layout.briefs} 份细纲可用` },
      { id: 'review_pass', ready: state.layout.chapters > 0, note: `有 ${state.layout.chapters} 章正文可审` },
      { id: 'deai_polish', ready: guide !== null, note: guide === null ? '先跑 Style Anchor' : '依据 style-guide 的禁忌清单' },
    ],
  }
}
