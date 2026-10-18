/**
 * dsh-writing-slots — 插件主体（host 半）。
 *
 * 四个模块各注册一个工具，**返回渲染好的提示词**，由调用方去执行。
 * 这样做的理由：这个插件的职责是「把带槽位的模板渲染成完整提示词」，
 * 而不是「自己去调模型」。判据（统计、规则、契约）全在这里算完，
 * 模型的活只剩写作与改写。
 *
 * 每道人工门禁都通过返回体里的 `gate` / `needsHumanReview` 标出来 ——
 * 插件不替人做决定。
 *
 * @module dsh-writing-slots
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'

import { MODULES, STYLE_ANCHOR, CHAPTER_PACK, REVIEW_PASS, DEAI_POLISH } from './prompts.js'
import {
  runStyleAnchor, runChapterPack, runReviewPass, runDeaiPolish, verifyPolish,
  moduleStatus, loadStyleGuide, STYLE_GUIDE_NAME,
  runWorldBuilder, checkWorld, runCharacterDesigner, checkCharacter, WORLD_BIBLE_NAME,
  runReaderSim, summarizeReaders, checkReaderOutput,
} from './pipeline.js'
import { READERS } from './reader.js'
import { validatePressureConfig, pressureSlice, validateInfoGap, validateScenes, validateCurve, temperatureAt } from './story.js'
import { check as sanityCheck, format as formatSanity, ENGINEERING_TERMS } from './sanity.js'
import { validateFindings, formatFindings, filterBySeverity, DIMENSIONS, SEVERITIES } from './review.js'
import { detect, POLISH_RULES } from './polish.js'
import { inspect, appendRecap, saveChapter, findChapter, padChapter } from './project.js'
import { writeFile } from 'node:fs/promises'

/**
 * 项目目录：显式给，否则用会话 cwd。
 *
 * `ctx.agent` 是要声明 `inject` 才能碰的服务，没声明时读它会直接抛
 * 「cannot get property "agent" without inject」。所以这里必须兜住 ——
 * 不兜的话，凡是没显式传 projectDir 的调用（也就是最常见的用法）全会崩。
 */
async function projectDirOf(ctx, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  try {
    const cwd = ctx?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch { /* 没注入 agent 服务：退回进程 cwd */ }
  return process.cwd()
}

/** 统一的输出契约：ok + message。 */
const OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      message: { type: 'string', required: true },
    },
  },
  render: (_a, v) => [{ type: 'text', text: v.message }],
}

export function apply(ctx, config = {}) {
  const configuredDir = typeof config.projectDir === 'string' && config.projectDir.trim() !== ''
    ? config.projectDir.trim()
    : null

  const dirFor = (explicit) => projectDirOf(ctx, explicit ?? configuredDir)

  // —— 工具 1：Style Anchor ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'style_anchor',
        description:
          '【写作槽位 1/4】Style Anchor（文风锚点）。项目初始化时跑一次：'
          + '分析 3—5 篇样本（总计 ≥5 万字），产出 style-guide.md。'
          + '句长/段落节奏/感官倾向/比喻指纹都是**系统统计出来的**，可复核，不是模型凭感觉写的。'
          + '禁忌清单的判据是「该句式在样本中一次都没出现」。'
          + '返回渲染好的提示词（供你按它继续分析）+ 一份可直接落盘的 style-guide.md。'
          + '人工门禁：人审「这像不像我写的」后才写盘。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          samples: { type: 'string', required: true, description: '样本文件路径，多个用换行或逗号分隔' },
          genreTags: { type: 'string', description: '体裁标签，如「古代种田 / 修仙底层」' },
        },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)
          const paths = String(args.samples ?? '').split(/[\n,，]/).map((x) => x.trim()).filter((x) => x !== '')
          if (paths.length === 0) return { ok: false, message: '请给样本文件路径（3—5 篇，总计 ≥5 万字）。' }
          const missing = paths.filter((p) => !existsSync(p))
          if (missing.length > 0) return { ok: false, message: `这些样本文件不存在：\n${missing.map((m) => `- ${m}`).join('\n')}` }

          const r = await runStyleAnchor(dir, paths, { genreTags: args.genreTags })
          if (r.ok !== true) {
            return { ok: false, message: `Style Anchor 没跑成：${r.reason}${r.problems ? `\n${r.problems.map((p) => `- ${p}`).join('\n')}` : ''}` }
          }
          return {
            ok: true,
            message: [
              `Style Anchor 完成：${r.sampleCount} 篇样本，共 ${r.totalChars} 字。`,
              '',
              '统计结果（可复核）：',
              r.markdown.split('\n').filter((l) => l.startsWith('- **')).join('\n'),
              '',
              `⚠ 人工门禁：${r.gate}`,
              `确认后把下面这份内容写到 ${r.guidePath}`,
              '',
              '--- style-guide.md 开始 ---',
              r.markdown,
              '--- style-guide.md 结束 ---',
            ].join('\n'),
          }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 style_anchor')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: style_anchor 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 1b：World Builder ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'world_builder',
        description:
          '【写作槽位 0b】World Builder（世界观）。项目初始化时跑：'
          + '返回一段搭建世界观的提示词，核心要求是「不要一次生成，要逼出代价」——'
          + '力量体系必须写明使用代价与限制，否则会被打回。'
          + '配套 `validate` 参数可校验产出：章节齐全、力量体系有代价有限制、'
          + '隐藏规则≥2 条、日常场景三个、每节 150—300 字。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          genre: { type: 'string', required: true, description: '题材，如「古代种田 / 修仙底层」' },
          constraints: { type: 'string', description: '额外约束' },
          avoid: { type: 'string', description: '要避免的东西' },
          validate: { type: 'string', description: '可选：把模型产出的世界观 markdown 贴进来校验' },
        },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)

          if (typeof args.validate === 'string' && args.validate.trim() !== '') {
            const v = checkWorld(args.validate)
            const lines = [v.ok === true ? '世界观符合契约。' : `世界观有 ${v.errors.length} 处不合契约：`]
            for (const e of v.errors) lines.push(`- ${e}`)
            for (const w of v.warnings) lines.push(`⚠ ${w}`)
            if (Object.keys(v.stats).length > 0) {
              lines.push('', '各节字数：' + Object.entries(v.stats).map(([k, n]) => `${k} ${n}`).join('｜'))
            }
            return { ok: v.ok === true, message: lines.join('\n') }
          }

          const r = await runWorldBuilder(dir, args.genre, { constraints: args.constraints, avoid: args.avoid })
          if (r.ok !== true) return { ok: false, message: `World Builder 没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
          return {
            ok: true,
            message: [
              `World Builder 已组装（提示词 ${r.prompt.length} 字）。`,
              `产出建议落到：${r.guidePath}`,
              '',
              `⚠ 人工门禁：${r.gate}`,
              '',
              '--- 提示词开始 ---',
              r.prompt,
              '--- 提示词结束 ---',
              '',
              '产出后用 validate 参数回贴内容，可校验代价/限制/条数/字数是否达标。',
            ].join('\n'),
          }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 world_builder')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: world_builder 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 1c：Character Designer ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'character_designer',
        description:
          '【写作槽位 0c】Character Designer（人物）。'
          + '返回一张人物卡的提示词：表面欲望 / 真实需求 / 致命缺陷**必须互相冲突**，'
          + '另含约 100 字内心独白、冷静笔触的过往创伤、愤怒/恐惧/狂喜三档标志行为。'
          + '配套 `validate` 可校验产出（三档情绪缺一打回；三者是否真的冲突机器判不了，会提示人读一遍）。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          character: { type: 'string', required: true, description: '角色名' },
          role: { type: 'string', description: '定位，如「主角」「反派」「配角」' },
          genre: { type: 'string', description: '题材' },
          existing: { type: 'string', description: '已有设定（不要与之冲突）' },
          validate: { type: 'string', description: '可选：把模型产出的人物卡贴进来校验' },
        },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)

          if (typeof args.validate === 'string' && args.validate.trim() !== '') {
            const v = checkCharacter(args.validate)
            const lines = [v.ok === true ? '人物卡符合契约。' : `人物卡有 ${v.errors.length} 处不合契约：`]
            for (const e of v.errors) lines.push(`- ${e}`)
            for (const w of v.warnings) lines.push(`⚠ ${w}`)
            lines.push('', `⚠ ${v.needsHumanCheck}`)
            return { ok: v.ok === true, message: lines.join('\n') }
          }

          const r = await runCharacterDesigner(dir, args.character, { role: args.role, genre: args.genre, existing: args.existing })
          if (r.ok !== true) return { ok: false, message: `Character Designer 没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
          return {
            ok: true,
            message: [
              `Character Designer 已组装（提示词 ${r.prompt.length} 字）。`,
              '',
              `⚠ 人工门禁：${r.gate}`,
              '',
              '--- 提示词开始 ---',
              r.prompt,
              '--- 提示词结束 ---',
            ].join('\n'),
          }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 character_designer')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: character_designer 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 2：Chapter Pack ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'chapter_pack',
        description:
          '【写作槽位 2/4】Chapter Pack（单章包）。每章动笔前调用，返回一段**渲染好的写作用提示词**。'
          + '必填槽位：章号 + 本章任务（事件/出场/效果/停在）+ 字数区间；'
          + '自动注入：风格摘要（来自 Style Anchor）、本章涉及的设定、上一章提要、细纲里的「不得违反」；'
          + '可选：视角 / 时态 / 结尾类型。'
          + '细纲里缺「任务」或「钩子」时会直接报缺，不拿别的字段顶替。'
          + '人工门禁：人审章尾钩子和情感落点。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          chapterNo: { type: 'number', required: true, description: '章号，如 25' },
          cast: { type: 'string', description: '出场人物，用顿号或逗号分隔（细纲里没有这项，由你补）' },
          wordMin: { type: 'number', description: '字数下限，默认 1900' },
          wordMax: { type: 'number', description: '字数上限，默认 2200' },
          pov: { type: 'string', description: '视角，默认第三人称限知' },
          endingType: { type: 'string', description: 'hook | quiet | turn，默认 hook' },
          save: { type: 'boolean', description: '为 true 时把返回的提示词落盘到 细纲/第NNNN章.prompt.md，便于复用' },
        },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)
          const cast = typeof args.cast === 'string'
            ? args.cast.split(/[、,，\n]/).map((x) => x.trim()).filter((x) => x !== '')
            : []
          const r = await runChapterPack(dir, args.chapterNo, {
            cast,
            wordRange: [args.wordMin ?? 1900, args.wordMax ?? 2200],
            pov: args.pov,
            endingType: args.endType,
          })
          if (r.ok !== true) {
            return { ok: false, message: `Chapter Pack 没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
          }
          let saved = null
          if (args.save === true) {
            const p = `${r.project}/细纲/第${padChapter(args.chapterNo)}章.prompt.md`
            try { await writeFile(p, r.prompt, 'utf8'); saved = p } catch { saved = null }
          }
          return {
            ok: true,
            message: [
              `Chapter Pack 已组装（第 ${r.slots.chapter_no} 章，提示词 ${r.prompt.length} 字）。`,
              r.warnings.length > 0 ? `提醒：${r.warnings.join('；')}` : null,
              saved === null ? null : `提示词已落盘：${saved}`,
              '',
              `⚠ 人工门禁：${r.gate}`,
              '',
              '--- 提示词开始 ---',
              r.prompt,
              '--- 提示词结束 ---',
            ].filter((x) => x !== null).join('\n'),
          }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 chapter_pack')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: chapter_pack 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 2b：Reader Simulation ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'reader_sim',
        description:
          '【写作槽位 2b】Reader Simulation（读者通道）。初稿完成后、**Review Pass 之前**跑：'
          + '把稿子交给三个具体读者（通勤读者小陈／回头读者阿岚／苛刻读者老周），'
          + '他们用第一人称说反应，输出三个锚点：愿不愿意继续读、记住了哪句话、哪里想跳过。'
          + '这是**体温，不是指令** —— 禁止文学批评术语、禁止修改建议。'
          + '三个阶段各有用途：小陈测留存、阿岚测人物可信度、老周测有没有被糊弄。'
          + '也可用 `validate` 传一个读者的产出来校验（越权扫描 + 锚点契约），'
          + '或用 `summarize` 传三个读者的锚点做汇总判断。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          chapterNo: { type: 'number', description: '章号（渲染提示词时必填）' },
          readers: { type: 'string', description: '只跑某几个读者，逗号分隔：commuter / rereader / harsh（缺省全跑）' },
          draft: { type: 'string', description: '初稿正文；不给则从项目里找' },
          validate: { type: 'string', description: '校验模式：把一个读者的产出贴进来' },
          summarize: { type: 'string', description: '汇总模式：传 JSON 数组 [{id, verdict:{anchors}}]' },
        },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)

          if (typeof args.validate === 'string' && args.validate.trim() !== '') {
            const v = checkReaderOutput(args.validate)
            const lines = [v.ok === true ? '这个读者的产出合规。' : `有 ${v.errors.length} 处越权或不合契约：`]
            for (const e of v.errors) lines.push(`- ${e}`)
            for (const w of v.warnings) lines.push(`⚠ ${w}`)
            if (v.anchors !== null) {
              lines.push('', `继续读：${v.anchors.continue_reading}`)
              lines.push(`记住的句子：${v.anchors.memorable_line ?? '（没有 —— 这是有效信号，不是缺陷）'}`)
              lines.push(`想跳过：${v.anchors.skip_urge_location ?? '（没有）'}`)
            }
            return { ok: v.ok === true, message: lines.join('\n') }
          }

          if (typeof args.summarize === 'string' && args.summarize.trim() !== '') {
            let arr = null
            try { arr = JSON.parse(args.summarize) } catch { return { ok: false, message: 'summarize 需要 JSON 数组' } }
            const s2 = summarizeReaders(arr)
            const lines = ['三个读者的体温表：']
            for (const x of s2.list) {
              lines.push(`- ${x.name}：${x.anchors?.continue_reading ?? '?'}${x.anchors?.memorable_line ? `｜记住「${x.anchors.memorable_line}」` : '｜没记住句子'}${x.anchors?.skip_urge_location ? `｜想跳过：${x.anchors.skip_urge_location}` : ''}`)
            }
            lines.push('', s2.reading, '', s2.verdictText)
            return { ok: true, message: lines.join('\n') }
          }

          const readers = typeof args.readers === 'string' && args.readers !== ''
            ? args.readers.split(/[,，\s]+/).filter((x) => x !== '')
            : undefined
          const r = await runReaderSim(dir, args.chapterNo, { readers, draft: args.draft })
          if (r.ok !== true) return { ok: false, message: `读者通道没组装成：${r.reason ?? ''}` }
          return {
            ok: true,
            message: [
              `读者通道已组装（第 ${padChapter(args.chapterNo)} 章，${r.prompts.length} 位读者）。`,
              '',
              '每位读者都要**单独跑一次**，不要在同一个会话里让他们轮流说 ——',
              '那样会互相影响，也就测不出各自的真实反应。',
              '',
              `⚠ 顺序：${r.orderNote}`,
              `⚠ 人工门禁：${r.gate}`,
              '',
              ...r.prompts.flatMap((p) => [
                `===== ${p.title}（${p.name}）｜测：${p.tests} =====`,
                p.prompt ?? `（组装失败：${(p.errors ?? []).join('；')}）`,
                '',
              ]),
              '跑完用 validate 校验各自产出，再用 summarize 汇总。',
            ].join('\n'),
          }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 reader_sim')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: reader_sim 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 2c：确定性检查 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'prose_sanity',
        description:
          '写作槽位的确定性检查（不需要模型判断）：截断（结尾没收尾、引号没关）、'
          + '工程词泄漏（「本章」「伏笔」「爽点」这类给作者看的词跑进正文）、'
          + '占位符没替换。critical 一律阻断。可传 text 直接查，或给 chapterNo 从项目里取。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          chapterNo: { type: 'number', description: '章号（不给 text 时用）' },
          text: { type: 'string', description: '直接给正文' },
          allowedTerms: { type: 'string', description: '项目本来就在用的词，逗号分隔（放行，避免误伤）' },
        },
        output: OUTPUT,
        async execute(args) {
          let text = args.text
          if (typeof text !== 'string' || text === '') {
            const dir = await dirFor(args.projectDir)
            const found = await findChapter(dir, args.chapterNo)
            if (found === null) return { ok: false, message: `找不到第 ${padChapter(args.chapterNo)} 章的正文` }
            text = found.text
          }
          const allowed = typeof args.allowedTerms === 'string' && args.allowedTerms !== ''
            ? args.allowedTerms.split(/[,，\s]+/).filter((x) => x !== '')
            : []
          const r = sanityCheck(text, { allowedTerms: allowed })
          return { ok: r.pass === true, message: formatSanity(r) }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 prose_sanity')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: prose_sanity 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 3：Review Pass ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'review_pass',
        description:
          '【写作槽位 3/4】Review Pass（审稿通道）。初稿完成后在**独立上下文**里跑：'
          + '返回一段审稿提示词，它**只包含**初稿、设定快照、上一章摘要 —— 看不到风格指南、看不到章节任务。'
          + '这是刻意的隔离：审稿不知道作者想写成什么样，就没法替作者找理由。'
          + '另外可用 `validate` 传一段审稿结果来校验（强制 JSON、四维度、三色灯、拒绝非原子指令）。'
          + '人工门禁：人决定哪些改、哪些不改。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          chapterNo: { type: 'number', required: true, description: '章号' },
          draft: { type: 'string', description: '初稿正文；不给则从项目里找' },
          validate: { type: 'string', description: '可选：把审稿产出的 JSON 贴进来校验' },
        },
        output: OUTPUT,
        async execute(args) {
          // 只校验模式：把审稿结果过一遍契约
          if (typeof args.validate === 'string' && args.validate.trim() !== '') {
            const v = validateFindings(args.validate)
            const lines = [
              v.ok === true ? '审稿结果符合契约。' : `审稿结果有 ${v.errors.length} 处不合契约：`,
              ...v.errors.map((e) => `- ${e}`),
            ]
            if (v.stats !== null) {
              lines.push('', `统计：共 ${v.stats.total} 条｜致命 ${v.stats.fatal}｜警告 ${v.stats.warning}｜通过 ${v.stats.pass}`)
              lines.push(`门禁结论：${v.verdict === 'reject' ? '打回（有致命问题）' : v.verdict === 'revise' ? '修改后过审' : '放行'}`)
              if (v.uncovered.length > 0) lines.push(`⚠ 未覆盖的维度：${v.uncovered.join('、')}`)
              lines.push('', formatFindings(v.findings))
            }
            return { ok: v.ok === true, message: lines.join('\n') }
          }

          const dir = await dirFor(args.projectDir)
          const r = await runReviewPass(dir, args.chapterNo, { draft: args.draft })
          if (r.ok !== true) return { ok: false, message: `Review Pass 没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
          return {
            ok: true,
            message: [
              `Review Pass 已组装（第 ${padChapter(args.chapterNo)} 章，提示词 ${r.prompt.length} 字）。`,
              `上下文隔离：已强制（只放行 ${r.isolation.allowed.join(' / ')}；不含风格指南）`,
              r.source === 'explicit' ? null : `正文来源：${r.source}`,
              '',
              `⚠ 人工门禁：${r.gate}`,
              '',
              '--- 提示词开始 ---',
              r.prompt,
              '--- 提示词结束 ---',
            ].filter((x) => x !== null).join('\n'),
          }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 review_pass')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: review_pass 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 4：De-AI Polish ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'deai_polish',
        description:
          '【写作槽位 4/4】De-AI Polish（去味层）。最后一道闸：'
          + '系统先按五条规则 + Style Anchor 的禁止事项扫描正文，把**逐条违规证据**列出来，'
          + '再渲染成一段「只改这些点」的提示词。'
          + '可用 `verifyBefore`/`verifyAfter` 复验改写结果 —— 模型说「已润色」不算数，'
          + '要按同一套规则重扫，给出改前改后的计数。',
        parameters: {
          projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' },
          chapterNo: { type: 'number', required: true, description: '章号' },
          text: { type: 'string', description: '待去味正文；不给则从项目里找' },
          verifyBefore: { type: 'string', description: '复验模式：改前文本' },
          verifyAfter: { type: 'string', description: '复验模式：改后文本' },
        },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)

          // 复验模式
          if (typeof args.verifyBefore === 'string' && typeof args.verifyAfter === 'string') {
            const v = await verifyPolish(dir, args.verifyBefore, args.verifyAfter)
            const lines = [
              v.accepted === true ? '去味复验通过：命中清零，节奏达标。' : '去味复验**未通过**。',
              `命中条目：${v.before.hits} → ${v.after.hits}`,
              `短句占比：${v.before.shortRatio} → ${v.after.shortRatio}`,
              `字数变化：${v.charDelta > 0 ? '+' : ''}${v.charDelta}`,
              v.improved === false ? '⚠ 改动**引入了新毛病**（命中变多）—— 建议回退这次改写。' : null,
              v.rhythm === null ? null : `⚠ 节奏仍不达标：${v.rhythm}`,
              v.remaining.length > 0 ? `\n还剩：\n${v.remaining.map((x) => `- [${x.id}] ${x.rule} ×${x.count}`).join('\n')}` : null,
            ].filter((x) => x !== null)
            return { ok: v.accepted === true, message: lines.join('\n') }
          }

          const r = await runDeaiPolish(dir, args.chapterNo, { text: args.text })
          if (r.ok !== true) return { ok: false, message: `De-AI Polish 没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
          const lines = [
            `De-AI Polish 已组装（第 ${padChapter(args.chapterNo)} 章）。`,
            `系统扫描命中 ${r.scan.totalHits} 处，涉及 ${r.scan.violations.length} 条规则。`,
            r.scan.rhythm === null ? null : `⚠ ${r.scan.rhythm}`,
            '',
            `⚠ 人工门禁：${r.gate}`,
            '',
            '--- 提示词开始 ---',
            r.prompt,
            '--- 提示词结束 ---',
          ].filter((x) => x !== null)
          return { ok: true, message: lines.join('\n') }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 deai_polish')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: deai_polish 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 5：状态总览 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'slots_status',
        description: '查看六个写作槽位的就绪状态、项目布局，以及每个模块该在什么时候用、人工门禁是什么。',
        parameters: { projectDir: { type: 'string', description: '项目目录（缺省用会话工作目录）' } },
        output: OUTPUT,
        async execute(args) {
          const dir = await dirFor(args.projectDir)
          const st = await moduleStatus(dir)
          const lines = [
            `项目：${st.project}`,
            `布局：前情提要 ${st.layout.recap ? '有' : '无'}｜全书大纲 ${st.layout.outline ? '有' : '无'}｜细纲 ${st.layout.briefs} 份｜正文 ${st.layout.chapters} 章`,
            st.pending === null ? null : `待续写：${st.pending}`,
            '',
            '四个槽位：',
          ].filter((x) => x !== null)
          for (const m of MODULES) {
            const s = st.modules.find((x) => x.id === m.id)
            lines.push(`\n${s?.ready ? '✓' : '✗'} ${m.title}`)
            lines.push(`   触发：${m.runsWhen}`)
            lines.push(`   产物：${m.output}`)
            lines.push(`   门禁：${m.gate}`)
            lines.push(`   状态：${s?.note ?? '未知'}`)
          }
          return { ok: true, message: lines.join('\n') }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 slots_status')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: slots_status 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— HTTP 接口（给浏览器半用） ——
  ctx.inject(['webServer'], (hostCtx) => {
    const handler = makeApiHandler({ dirFor, ctx })
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: '/api/dsh-writing-slots', handler }),
      'dsh-writing-slots: api routes',
    )
  })
}

/** 极简 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** 读请求体。 */
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function makeApiHandler({ dirFor }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/^\/api\/dsh-writing-slots/, '') || '/'
      const dir = await dirFor(url.searchParams.get('projectDir'))

      if (req.method === 'GET' && path === '/status') {
        sendJson(res, 200, { ok: true, ...(await moduleStatus(dir)) })
        return
      }

      if (req.method === 'GET' && path === '/modules') {
        sendJson(res, 200, {
          ok: true,
          modules: MODULES.map((m) => ({
            id: m.id, title: m.title, runsWhen: m.runsWhen, gate: m.gate, output: m.output,
            contract: m.contract, template: m.template,
          })),
        })
        return
      }

      if (req.method === 'POST' && path === '/style-anchor') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const paths = Array.isArray(body.samples)
          ? body.samples
          : String(body.samples ?? '').split(/[\n,，]/).map((x) => x.trim()).filter((x) => x !== '')
        const r = await runStyleAnchor(dir, paths, { genreTags: body.genreTags })
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'POST' && path === '/world-builder') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        if (body.validate !== undefined) {
          sendJson(res, 200, { ok: true, ...checkWorld(body.validate) })
          return
        }
        const r = await runWorldBuilder(dir, body.genre, { constraints: body.constraints, avoid: body.avoid })
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'POST' && path === '/character-designer') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        if (body.validate !== undefined) {
          sendJson(res, 200, { ok: true, ...checkCharacter(body.validate) })
          return
        }
        const r = await runCharacterDesigner(dir, body.character, { role: body.role, genre: body.genre, existing: body.existing })
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'POST' && path === '/style-anchor/save') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        if (typeof body.markdown !== 'string' || body.markdown.trim() === '') {
          sendJson(res, 400, { error: '没有要写的内容 markdown' }); return
        }
        if (body.confirm !== true) { sendJson(res, 400, { error: '写盘需要 confirm: true' }); return }
        const p = `${dir}/${STYLE_GUIDE_NAME}`
        await writeFile(p, body.markdown, 'utf8')
        sendJson(res, 200, { ok: true, path: p, bytes: body.markdown.length })
        return
      }

      if (req.method === 'GET' && path === '/style-guide') {
        const g = await loadStyleGuide(dir)
        if (g === null) { sendJson(res, 404, { ok: false, reason: `还没有 ${STYLE_GUIDE_NAME}` }); return }
        sendJson(res, 200, { ok: true, ...g })
        return
      }

      if (req.method === 'GET' && path === '/chapter-pack') {
        const no = Number(url.searchParams.get('chapterNo'))
        if (!Number.isFinite(no)) { sendJson(res, 400, { error: '请给 chapterNo' }); return }
        const cast = (url.searchParams.get('cast') ?? '').split(/[、,，]/).map((x) => x.trim()).filter((x) => x !== '')
        const r = await runChapterPack(dir, no, { cast })
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'GET' && path === '/review-pass') {
        const no = Number(url.searchParams.get('chapterNo'))
        if (!Number.isFinite(no)) { sendJson(res, 400, { error: '请给 chapterNo' }); return }
        const r = await runReviewPass(dir, no, {})
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'GET' && path === '/deai-polish') {
        const no = Number(url.searchParams.get('chapterNo'))
        if (!Number.isFinite(no)) { sendJson(res, 400, { error: '请给 chapterNo' }); return }
        const r = await runDeaiPolish(dir, no, {})
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'GET' && path === '/readers') {
        sendJson(res, 200, { ok: true, readers: READERS.map((r) => ({ id: r.id, name: r.name, title: r.title, tests: r.tests, persona: r.persona, questions: r.questions })) })
        return
      }

      if (req.method === 'GET' && path === '/reader-sim') {
        const no = Number(url.searchParams.get('chapterNo'))
        if (!Number.isFinite(no)) { sendJson(res, 400, { error: '请给 chapterNo' }); return }
        const readers = (url.searchParams.get('readers') ?? '').split(/[,，\s]+/).filter((x) => x !== '')
        const r = await runReaderSim(dir, no, { readers: readers.length > 0 ? readers : undefined })
        sendJson(res, r.ok === true ? 200 : 400, r)
        return
      }

      if (req.method === 'POST' && path === '/reader-sim/validate') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...checkReaderOutput(body.payload ?? body) })
        return
      }

      if (req.method === 'POST' && path === '/reader-sim/summarize') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...summarizeReaders(body.results ?? body) })
        return
      }

      if (req.method === 'POST' && path === '/sanity') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        let text = body.text
        if (typeof text !== 'string' || text === '') {
          const found = await findChapter(dir, body.chapterNo)
          if (found === null) { sendJson(res, 404, { ok: false, reason: '找不到正文' }); return }
          text = found.text
        }
        const r = sanityCheck(text, { allowedTerms: body.allowedTerms ?? [] })
        sendJson(res, 200, { ok: true, ...r, formatted: formatSanity(r), engineeringTerms: ENGINEERING_TERMS })
        return
      }

      if (req.method === 'POST' && path === '/pressure-config/validate') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...validatePressureConfig(body.config ?? body) })
        return
      }

      if (req.method === 'POST' && path === '/pressure-slice') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...pressureSlice(body.config ?? {}, body.level) })
        return
      }

      if (req.method === 'POST' && path === '/info-gap/validate') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...validateInfoGap(body.brief ?? body) })
        return
      }

      if (req.method === 'POST' && path === '/scenes/validate') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...validateScenes(body.scenes ?? body) })
        return
      }

      if (req.method === 'POST' && path === '/curve/validate') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        sendJson(res, 200, { ok: true, ...validateCurve(body.curve ?? body) })
        return
      }

      if (req.method === 'POST' && path === '/review-pass/validate') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const v = validateFindings(body.payload ?? body)
        sendJson(res, 200, { ok: true, dimensions: DIMENSIONS, severities: SEVERITIES, ...v })
        return
      }

      if (req.method === 'POST' && path === '/deai-polish/verify') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        if (typeof body.before !== 'string' || typeof body.after !== 'string') {
          sendJson(res, 400, { error: '需要 before 与 after 两段文本' }); return
        }
        const v = await verifyPolish(dir, body.before, body.after)
        sendJson(res, 200, { ok: true, ...v })
        return
      }

      if (req.method === 'POST' && path === '/deai-polish/scan') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const guide = await loadStyleGuide(dir)
        const floor = guide?.parsed?.short_ratio_value ?? null
        const text = typeof body.text === 'string' ? body.text : ''
        const scan = detect(text, { shortFloor: floor })
        sendJson(res, 200, { ok: true, rules: POLISH_RULES.map((r) => ({ id: r.id, rule: r.rule })), ...scan })
        return
      }

      if (req.method === 'GET' && path === '/project') {
        const st = await inspect(dir, null)
        // 不把全文丢给界面，只给结构
        sendJson(res, 200, {
          ok: true,
          root: st.root,
          layout: st.layout,
          pending: st.pending,
          recapCount: st.recaps.length,
        })
        return
      }

      sendJson(res, 404, { error: `未知接口：${req.method} ${path}` })
    } catch (e) {
      sendJson(res, 500, { error: e?.message ?? String(e) })
    }
  }
}

export const name = 'dsh-writing-slots'
export const inject = []
