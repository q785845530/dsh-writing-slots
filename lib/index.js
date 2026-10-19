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
  runReaderSim, summarizeReaders, checkReaderOutput, runMiner,
  runDecompose, acceptMap, mapToLibrary, readMap,
} from './pipeline.js'
import * as logicmap from './logicmap.js'
import * as batch from './batch.js'
import * as lib from './library.js'
import { extractFromWorkspace, chunkBook, chunkText } from './library.js'
import { READERS } from './reader.js'
import { validatePressureConfig, pressureSlice, validateInfoGap, validateScenes, validateCurve, temperatureAt } from './story.js'
import { check as sanityCheck, format as formatSanity, ENGINEERING_TERMS } from './sanity.js'
import { makeContinueService } from './continue.js'
import { validateFindings, formatFindings, filterBySeverity, DIMENSIONS, SEVERITIES } from './review.js'
import { detect, POLISH_RULES } from './polish.js'
import { inspect, appendRecap, saveChapter, findChapter, padChapter } from './project.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  resolveWorkspace, locateProject, status as wsStatus, init as wsInit,
  saveConfig as wsSaveConfig, validate as wsValidate, displayPath, expandPath as expandWorkspace,
  loadGlobal as wsLoadGlobal, saveGlobal as wsSaveGlobal, checkRemembered as wsCheckRemembered,
  inventory as wsInventory,
  globalConfigPath, LAYOUT, CONFIG_NAME,
} from './workspace.js'
import {
  SITES, site as findSite, listCookies, setCookie, removeCookie,
  fetchRank, classifyContent, storeContent, privateUseCount,
} from './sites.js'
import * as reader from './reader/service.js'

/**
 * 取会话 cwd。
 *
 * `ctx.agent` 是要声明 `inject` 才能碰的服务，没声明时读它会直接抛
 * 「cannot get property "agent" without inject」。所以必须兜住 ——
 * 不兜的话，凡是没显式传 projectDir 的调用（最常见用法）全会崩。
 */
function sessionCwdOf(ctx) {
  try {
    const cwd = ctx?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch { /* 没注入 agent 服务 */ }
  return process.cwd()
}

/**
 * 项目目录：**工作目录是唯一来源**。
 *
 * 解析顺序：显式传入 → 插件配置的 workspace → 会话 cwd → 默认落点，
 * 然后在其中定位真正的项目根（兼容「工作目录本身就是项目」与
 * 「项目在 workspace/novel 下」两种布局）。
 *
 * 之所以要收口到这一个函数：以前每个入口各自 `projectDir ?? 会话 cwd`，
 * 换个会话就可能把同一本书写到别处去。
 */
async function projectDirOf(ctx, explicit, workspace) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const ws = workspace ?? resolveWorkspace({ sessionCwd: sessionCwdOf(ctx) }).dir
  return locateProject(ws)
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

  // 自动继跑（从 dsh-auto-continue 移植）。配置从本插件的 config.autoContinue 读，
  // 也可以在运行时由界面开关改。
  const autoContinue = makeContinueService({ ctx, config: config.autoContinue })
  autoContinue.install()

  // 工作目录：显式配置 > 环境变量 > 会话 cwd > 默认落点。
  // 运行时可在界面改（改的是工作目录下的配置文件，不是 profile）。
  let workspaceDir = null
  /** 这次用的是哪来的：remembered / explicit / config / session-cwd / …（界面会显示）。 */
  let workspaceSource = null
  /** 记住的工作目录是否已失效（被删或挪走）。 */
  let workspaceStale = null

  const setWorkspace = async (dir, source) => {
    workspaceDir = dir
    workspaceSource = source
    // 记忆到 DSH 主目录 —— 不能写进工作目录自己，那样下次启动找不到
    await wsSaveGlobal({ workspace: dir, source }).catch(() => {})
    return dir
  }

  /**
   * 取当前工作目录。
   *
   * **记住的目录暂时不可写时，不能永久放弃。**
   *
   * 第一版只在第一次调用时检查记住的路径，一旦那次失败（目录刚好在被移动、
   * 或写探针撞上瞬时错误），`workspaceDir` 就被定格成 session-cwd，
   * 之后即使目录恢复了也永远回不去 —— 界面上表现为「指令库一直是空的」，
   * 而且看不出原因。
   *
   * 现在：记住的路径每次都可重试，只要它恢复可用就切回去。
   */
  async function ensureWorkspace(explicit, options = {}) {
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      return setWorkspace(expandWorkspace(explicit), 'explicit')
    }

    // 记住的路径优先，且**每次都重试**（除非调用方明确要求不重试）
    const remembered = await wsLoadGlobal()
    if (remembered !== null && options.skipRemembered !== true) {
      const dir = expandWorkspace(remembered.workspace)
      const v = await wsValidate(dir)
      if (v.ok === true) {
        // 之前可能在 session-cwd 上，现在记住的恢复了 —— 切回去
        if (workspaceDir !== dir) {
          workspaceDir = dir
          workspaceSource = 'remembered'
          workspaceStale = null
          ctx.logger?.info?.(`dsh-writing-slots: 工作目录切回记住的路径 ${dir}`)
        }
        return dir
      }
      // 不可用：记下原因（含真实错误），但这**不阻止下次重试**
      workspaceStale = {
        workspace: dir,
        problems: v.problems,
        details: v.details ?? [],
        savedAt: remembered.updatedAt ?? null,
        checkedAt: new Date().toISOString(),
      }
    } else if (workspaceDir !== null) {
      // 没有记住的路径，或明确要求跳过 —— 沿用已定的
      return workspaceDir
    }

    const r = resolveWorkspace({ explicit: configuredDir, sessionCwd: sessionCwdOf(ctx) })
    workspaceDir = r.dir
    workspaceSource = r.source
    return workspaceDir
  }

  const dirFor = async (explicit) => {
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
    const ws = await ensureWorkspace()
    return locateProject(ws)
  }

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

  // —— 工具 4b：自动续跑 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'auto_continue',
        description:
          '自动续跑（原 @weibaohui/dsh-continue 的功能，已并入本插件）。'
          + 'agent 会话中断后自动续上：有序规则表按失败类型路由 —— '
          + '限流退避重试、额度/鉴权止损、上下文超限自动压缩后续跑、'
          + '崩溃孤儿轮与输出截断自动继续、可自定义状态码、失败后自动换模型。'
          + 'action=status 看状态与活动；enable/disable 开关；configure 改配置与规则表；'
          + 'rules 看当前规则表；models 列出可选 provider/模型；reset 清计数。',
        parameters: {
          action: {
            type: 'string', required: true,
            description: 'status | enable | disable | configure | rules | models | reset',
            enum: ['status', 'enable', 'disable', 'configure', 'rules', 'models', 'reset'],
          },
          prompt: { type: 'string', description: 'action=configure：注入的续跑文本' },
          maxAttempts: { type: 'number', description: 'action=configure：每会话上限' },
          cooldownMs: { type: 'number', description: 'action=configure：冷却毫秒' },
          backoffBaseMs: { type: 'number', description: 'action=configure：退避基数毫秒' },
          backoffMaxMs: { type: 'number', description: 'action=configure：退避上限毫秒' },
          notifyOnCap: { type: 'boolean', description: 'action=configure：达上限是否通知' },
          rulesJson: { type: 'string', description: 'action=configure：规则表 JSON（整表替换）' },
          session: { type: 'string', description: 'action=reset：只清这个会话' },
        },
        output: OUTPUT,
        async execute(args) {
          const a = args.action
          if (a === 'enable' || a === 'disable') {
            const r = autoContinue.setEnabled(a === 'enable')
            return { ok: true, message: `自动续跑已${r.enabled ? '启用' : '停用'}${r.changed ? '' : '（本来就是该状态）'}。\n${r.enabled ? '客户端会多出「自动续跑」页签。' : '客户端不再显示该页签。'}` }
          }
          if (a === 'models') {
            const m = await autoContinue.modelOptions()
            const lines = ['可用 provider / 模型（给规则的「换模型续跑」用）：']
            for (const p of m.providers) {
              lines.push(`- ${p.id}${p.label ? `（${p.label}）` : ''}：${(m.models[p.id] ?? []).slice(0, 12).join('、') || '（列不出）'}`)
            }
            if (m.providers.length === 0) lines.push('（宿主没提供 llm 服务，或列不出 provider）')
            if (m.default) lines.push('', `当前默认：${m.default.provider}/${m.default.model}`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'rules') {
            const st = autoContinue.status()
            const lines = ['有序规则表（从上到下匹配，先命中先用）：']
            st.config.rules.forEach((r, i) => {
              const act = st.actionLabels?.[r.action] ?? r.action
              const target = r.model ? ` → ${r.provider ? r.provider + '/' : ''}${r.model}` : ''
              const cap = r.maxAttempts > 0 ? `，最多 ${r.maxAttempts} 次` : '，不限次'
              const codes = r.codes ? ` 码=[${r.codes}]` : ''
              lines.push(`${i + 1}. ${st.whenLabels?.[r.when] ?? r.when} → ${act}${target}${cap}${codes}`)
            })
            lines.push('', '改规则用 action=configure、rulesJson=<整表 JSON>。')
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'configure') {
            const patch = {}
            for (const k of ['prompt', 'maxAttempts', 'cooldownMs', 'backoffBaseMs', 'backoffMaxMs', 'notifyOnCap']) {
              if (args[k] !== undefined) patch[k] = args[k]
            }
            if (typeof args.rulesJson === 'string' && args.rulesJson.trim() !== '') {
              try { patch.rules = JSON.parse(args.rulesJson) } catch { return { ok: false, message: 'rulesJson 不是合法 JSON。' } }
            }
            if (Object.keys(patch).length === 0) return { ok: false, message: '没有要改的字段。' }
            const r = autoContinue.configure(patch)
            return { ok: true, message: `已更新：${r.changed.join('、') || '（无变化）'}` }
          }
          if (a === 'reset') {
            const r = autoContinue.reset(args.session)
            return { ok: true, message: `已清 ${r.cleared} 个会话的计数（范围：${r.scope}）。` }
          }
          const st = autoContinue.status()
          const lines = [
            `自动续跑：${st.enabled ? '已启用' : '已停用'}`,
            `注入文本：${st.config.prompt}`,
            `上限 ${st.config.maxAttempts} 次/会话｜冷却 ${st.config.cooldownMs}ms｜退避 ${st.config.backoffBaseMs}→${st.config.backoffMaxMs}ms`,
            `规则 ${st.config.rules.length} 条｜压缩后端：${st.compactionArmed ? '已挂载' : '未挂载（context 规则的压缩动作会降级为通知）'}`,
            '',
            `累计：${st.totals.continues} 次续跑，涉及 ${st.totals.sessions} 个会话`,
          ]
          if (st.sessions.length > 0) {
            lines.push('', '各会话：')
            for (const x of st.sessions.slice(0, 10)) {
              lines.push(`- ${x.sessionId}：${x.attempts} 次${x.pending ? '（有挂起）' : ''}${x.compacting ? '（压缩中）' : ''}`)
            }
          }
          if (st.activity.length > 0) {
            lines.push('', '最近活动：')
            for (const x of st.activity.slice(0, 10)) {
              const t = new Date(x.at).toLocaleTimeString('zh-CN')
              lines.push(`- ${t} ${x.kind}${x.attempt ? ` #${x.attempt}` : ''}${x.sessionId ? `｜${x.sessionId}` : ''}${x.ruleId ? `｜${x.ruleId}` : ''}${x.delay ? `｜退避 ${x.delay}ms` : ''}${x.reason ? `｜${x.reason}` : ''}`)
            }
          }
          lines.push('', st.note)
          return { ok: true, message: lines.join('\n') }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 auto_continue')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: auto_continue 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 4c：工作目录 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'workspace',
        description:
          '写作工作目录。插件所有产出（风格锚点、世界观、人物卡、章节、拆文库、素材）'
          + '都落在**一个工作目录**里，而不是散在会话 cwd。'
          + 'action=status 看现状；set 切换/设置路径；init 建目录结构；'
          + 'validate 检查路径能不能用。'
          + '设置之后所有槽位默认都用这个目录，不用每次传 projectDir。',
        parameters: {
          action: { type: 'string', required: true, description: 'status | set | init | validate', enum: ['status', 'set', 'init', 'validate'] },
          path: { type: 'string', description: '工作目录路径（set / validate 用）' },
          only: { type: 'string', description: 'action=init：只建这几个子目录，逗号分隔' },
        },
        output: OUTPUT,
        async execute(args) {
          const a = args.action
          if (a === 'validate') {
            if (typeof args.path !== 'string' || args.path.trim() === '') return { ok: false, message: '请给 path。' }
            const v = await wsValidate(expandWorkspace(args.path))
            return { ok: v.ok, message: [v.ok ? '这个路径可以当工作目录。' : '这个路径不能当工作目录：', ...v.problems.map((x) => `- ${x}`), `路径：${v.dir}`].join('\n') }
          }
          if (a === 'set') {
            if (typeof args.path !== 'string' || args.path.trim() === '') return { ok: false, message: '请给 path。' }
            const dir = expandWorkspace(args.path)
            const v = await wsValidate(dir)
            if (v.ok !== true) {
              // 不存在就问要不要建；这里不擅自建，因为可能是打错字
              const created = await wsInit(dir)
              await wsSaveConfig(dir, { workspace: dir })
              workspaceDir = dir
              return { ok: true, message: `目录不存在，已建好并设为工作目录：${displayPath(created.dir)}\n子目录：${created.created.join('、') || '（都已在）'}` }
            }
            await wsSaveConfig(dir, { workspace: dir })
            workspaceDir = dir
            const st = await wsStatus(await locateProject(dir))
            return { ok: true, message: [`工作目录已设为：${displayPath(dir)}`, `项目根：${displayPath(await locateProject(dir))}`, `子目录就绪：${st.dirs.filter((d) => d.present).map((d) => d.name).join('、') || '（无，建议跑 action=init）'}`].join('\n') }
          }
          if (a === 'init') {
            const dir = await ensureWorkspace(args.path)
            const only = typeof args.only === 'string' && args.only !== '' ? args.only.split(/[,，\s]+/).filter((x) => x !== '') : undefined
            const r = await wsInit(dir, { only })
            return { ok: true, message: `已初始化：${displayPath(r.dir)}\n新建：${r.created.join('、') || '（都已在，没动）'}` }
          }
          const ws = await ensureWorkspace()
          const projectRoot = await locateProject(ws)
          const st = await wsStatus(projectRoot)
          const lines = [
            `工作目录：${displayPath(ws)}`,
            `项目根：${displayPath(projectRoot)}${projectRoot === ws ? '（就是工作目录本身）' : '（在工作目录下的子目录）'}`,
            `目录存在：${st.exists ? '是' : '否（跑 action=init 建结构）'}`,
            '',
            '分类目录：',
          ]
          for (const d of st.dirs) {
            lines.push(`- ${d.name}${d.samples ? '（Style Anchor 样本来源）' : ''}：${d.present ? `${d.files} 个文件、${(d.bytes / 1024).toFixed(1)}KB` : '未建'}　${d.desc}`)
          }
          lines.push('', '关键文件：')
          for (const f of st.keyFiles) lines.push(`- ${f.name}：${f.present ? '有' : '无'}`)
          lines.push('', `配置：${st.config ? '有（' + CONFIG_NAME + '）' : '无'}`)
          return { ok: true, message: lines.join('\n') }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 workspace')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: workspace 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 4d：小说网站 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'novel_site',
        description:
          '小说网站：用**你自己的 cookie**去站点取内容，像正常人一样（真实浏览器头、遵守频率）。'
          + 'action=sites 列站点；set-cookie 存 cookie（加密落盘，不回显）；'
          + 'cookies 看状态；fetch 取榜单；classify 把内容**按插件功能分类**（该喂给哪个槽位）；'
          + 'store 落进工作目录的分类目录。'
          + '⚠ 不做反爬绕过：遇到挑战页或字体混淆会如实报告，不把乱码当内容。',
        parameters: {
          action: { type: 'string', required: true, description: 'sites | set-cookie | remove-cookie | cookies | fetch | classify | store', enum: ['sites', 'set-cookie', 'remove-cookie', 'cookies', 'fetch', 'classify', 'store'] },
          site: { type: 'string', description: '站点 id（fanqie / qidian / jjwxc / qimao / zongheng / zhihu）' },
          cookie: { type: 'string', description: 'action=set-cookie：从浏览器复制的整段 cookie' },
          url: { type: 'string', description: 'action=fetch：自定义地址（缺省用该站榜单页）' },
          text: { type: 'string', description: 'action=classify / store：要分类或落盘的内容' },
          name: { type: 'string', description: 'action=store：文件名' },
          dir: { type: 'string', description: 'action=store：落到哪个分类目录（缺省按分类结果）' },
        },
        output: OUTPUT,
        async execute(args) {
          const a = args.action
          const ws = await ensureWorkspace()

          if (a === 'sites') {
            const lines = ['可用站点：']
            for (const x of SITES) lines.push(`- ${x.id}（${x.name}）${x.home}\n    认证：${x.auth}　${x.note}`)
            lines.push('', '取内容前先 set-cookie。cookie 从浏览器 DevTools 的 Network → 任一请求 → Request Headers → cookie 复制。')
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'set-cookie') {
            const r = await setCookie(ws, args.site, args.cookie)
            return r.ok
              ? { ok: true, message: `${findSite(args.site).name} 的 cookie 已加密保存（${r.hint}）。\n位置：${ws}/.auth/（权限 0600，不进日志、不回显）。` }
              : { ok: false, message: `没存成：${r.reason}` }
          }
          if (a === 'remove-cookie') {
            const r = await removeCookie(ws, args.site)
            return { ok: r.ok, message: r.ok ? `已删除 ${findSite(args.site).name} 的 cookie。` : r.reason }
          }
          if (a === 'cookies') {
            const l = await listCookies(ws)
            const lines = [`cookie 存储：${l.dir}（密钥${l.keyExists ? '已生成' : '未生成'}）`]
            for (const x of l.sites) {
              lines.push(`- ${x.name}（${x.id}）：${x.stored ? `已存 ${x.hint}${x.storedAt ? `，${x.storedAt}` : ''}` : '未存'}${x.broken ? ` ⚠ 解不开：${x.broken}` : ''}`)
            }
            if (l.reason) lines.push('', `⚠ ${l.reason}`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'fetch') {
            const r = await fetchRank(ws, args.site, { url: args.url })
            const lines = [`${r.site?.name ?? args.site}：${r.ok ? '取到了' : '没取到'}（HTTP ${r.status}，${r.bytes} 字节，编码 ${r.encoding}）`]
            if (r.ok) {
              lines.push(`用了 cookie：${r.usedCookie ? '是' : '否'}`, `解析出 ${r.items?.length ?? 0} 条：`)
              for (const it of (r.items ?? []).slice(0, 15)) lines.push(`- ${it.title}`)
              lines.push('', '要落盘就用 action=store；要分类就用 action=classify。')
            } else {
              lines.push(`原因（${r.kind}）：${r.reason}`)
              if (r.checks?.length) lines.push('', '判定依据：', ...r.checks.map((c) => `- ${c}`))
              if (r.suggestions?.length) lines.push('', '可以走的路：', ...r.suggestions.map((c) => `- ${c}`))
            }
            return { ok: r.ok === true, message: lines.join('\n') }
          }
          if (a === 'classify') {
            const c = classifyContent(args.text, { kind: args.dir })
            const lines = [
              `内容：${c.stats.chars} 字（中文 ${c.stats.han}）、${c.stats.paragraphs} 段、${c.stats.sentences} 句${c.stats.hasDialogue ? '、含对话' : ''}`,
              '',
              c.targets.length > 0 ? '可以喂给这些槽位：' : '够不上任何槽位：',
            ]
            for (const t of c.targets) lines.push(`- ${t.module}${t.slot ? ` → ${t.slot}` : ''}${t.dir ? ` → ${t.dir}/` : ''}：${t.why}`)
            for (const x of c.reasons) lines.push(`- ${x}`)
            return { ok: c.ok, message: lines.join('\n') }
          }
          if (a === 'store') {
            const c = classifyContent(args.text, { kind: args.dir })
            const dir = args.dir ?? c.targets.find((t) => t.dir)?.dir ?? '素材'
            const name = args.name ?? `导入-${new Date().toISOString().slice(0, 10)}`
            const r = await storeContent(ws, dir, name, args.text)
            if (!r.ok) return { ok: false, message: `没落盘：${r.reason}\n${(r.checks ?? []).map((x) => `- ${x}`).join('\n')}` }
            return { ok: true, message: `已落盘：${r.path}${r.existed ? '（覆盖了同名文件）' : ''}　${(r.bytes / 1024).toFixed(1)}KB\n分类：${dir}/` }
          }
          return { ok: false, message: `不认识的 action：${a}` }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 novel_site')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: novel_site 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 4e：阅读器 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'reader',
        description:
          '在线小说阅读器（移植自 dsh-reader）。内置 41 个书源，支持在线搜书、'
          + '逐章抓取、整本 TXT 下载，也能读工作目录里的本地书。'
          + 'action=sources 列书源；search 多源并发搜书；chapters 取目录；'
          + 'content 取正文；download 整本下载；local 扫本地书；read 读本地书；'
          + 'send 把内容送进工作目录（拆文库 / 样本 / 素材）—— 这是和写作流程打通的入口。'
          + '⚠ 内置书源多为第三方聚合站，随时可能失效；下载内容仅限个人学习使用。',
        parameters: {
          action: { type: 'string', required: true, description: 'sources | search | chapters | content | download | local | read | send | notice', enum: ['sources', 'search', 'chapters', 'content', 'download', 'local', 'read', 'send', 'notice'] },
          keyword: { type: 'string', description: 'action=search：书名关键词' },
          source: { type: 'string', description: '书源标题' },
          url: { type: 'string', description: '书页或章节地址' },
          title: { type: 'string', description: '书名（下载与落盘用）' },
          path: { type: 'string', description: 'action=read：本地文件路径' },
          kind: { type: 'string', description: 'action=send：deconstruct（拆文库）/ sample（样本）/ material（素材）' },
          text: { type: 'string', description: 'action=send：要送进去的正文' },
          chapterIndex: { type: 'number', description: 'action=send：章号（落盘文件名会带上）' },
        },
        output: OUTPUT,
        async execute(args) {
          const a = args.action
          const ws = await ensureWorkspace()

          if (a === 'notice') {
            return { ok: true, message: [`书源来源：${reader.SOURCE_NOTICE.origin}`, `上游：${reader.SOURCE_NOTICE.upstream}`, '', `⚠ ${reader.SOURCE_NOTICE.warning}`].join('\n') }
          }
          if (a === 'sources') {
            const list = reader.listSources()
            const lines = [`内置书源 ${list.length} 个（另有名：${list.filter((x) => x.official).length} 个正规平台）：`]
            for (const x of list) lines.push(`- ${x.title}${x.official ? ' ✅正规平台' : ''}　${x.host}${x.json ? '　(JSON 规则)' : ''}`)
            lines.push('', `⚠ ${reader.SOURCE_NOTICE.warning}`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'search') {
            if (typeof args.keyword !== 'string' || args.keyword.trim() === '') return { ok: false, message: '请给 keyword。' }
            const r = await reader.searchAll(args.keyword.trim())
            const lines = [`搜「${args.keyword}」：查了 ${r.searched} 个源，命中 ${r.results.length} 条${r.timedOut ? '（部分源超时）' : ''}`]
            for (const x of r.results.slice(0, 30)) lines.push(`- ${x.title}${x.author ? `／${x.author}` : ''}　[${x.source}]`)
            if (r.errors.length > 0) {
              lines.push('', `有 ${r.errors.length} 个源没成：`)
              for (const e of r.errors.slice(0, 8)) lines.push(`- ${e.source}：${e.error.slice(0, 60)}`)
            }
            if (r.results.length > 0) lines.push('', '拿到某本的 url 后用 action=chapters 取目录。')
            return { ok: r.results.length > 0, message: lines.join('\n') }
          }
          if (a === 'chapters') {
            if (typeof args.source !== 'string' || typeof args.url !== 'string') return { ok: false, message: '需要 source 与 url。' }
            const cs = await reader.chapters(args.source, args.url)
            const lines = [`《${args.title ?? '未命名'}》共 ${cs.length} 章：`]
            for (const c of cs.slice(0, 25)) lines.push(`- ${c.title}`)
            if (cs.length > 25) lines.push(`… 还有 ${cs.length - 25} 章`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'content') {
            if (typeof args.source !== 'string' || typeof args.url !== 'string') return { ok: false, message: '需要 source 与 url。' }
            const text = await reader.content(args.source, args.url)
            const c = classifyContent(text)
            return {
              ok: true,
              message: [`取了 ${text.length} 字（中文 ${(text.match(/[\u4e00-\u9fff]/g) ?? []).length}）。`, '可以喂给：', ...c.targets.map((x) => `- ${x.module}${x.slot ? ' → ' + x.slot : ''}：${x.why}`), '', '前 300 字：', text.slice(0, 300)].join('\n'),
            }
          }
          if (a === 'download') {
            if (typeof args.source !== 'string' || typeof args.url !== 'string') return { ok: false, message: '需要 source 与 url。' }
            const id = reader.downloads.start({ source: reader.findSource(args.source), bookUrl: args.url, title: args.title ?? '未命名', dir: join(ws, '导出') })
            return { ok: true, message: `下载任务已建：${id}\n落点：${join(ws, '导出')}\n用 action=download 查询进度（界面里也能看）。` }
          }
          if (a === 'local') {
            const r = await reader.scanBooks(ws)
            const lines = [`本地书：${r.dir}（${r.counts.local} 本）`, `工作目录「章节/」：${r.counts.workspace} 个文件（你自己的稿子）`]
            for (const b of r.books.slice(0, 30)) lines.push(`- [${b.origin === 'workspace' ? '我的稿子' : '本地'}] ${b.name}　${(b.size / 1024).toFixed(1)}KB`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'read') {
            if (typeof args.path !== 'string' || args.path === '') return { ok: false, message: '需要 path。' }
            const r = await reader.readBook(args.path)
            return { ok: true, message: [`${args.path}：${(r.size / 1024).toFixed(1)}KB，拆出 ${r.chapterCount} 章。`, '', '前 10 章：', ...r.chapters.slice(0, 10).map((c, i) => `${i + 1}. ${c.title}（${c.text.length} 字）`)].join('\n') }
          }
          if (a === 'send') {
            const r = await reader.sendToWorkspace(ws, { kind: args.kind ?? 'deconstruct', name: args.title ?? '阅读器导入', text: args.text, chapterIndex: args.chapterIndex })
            if (!r.ok) return { ok: false, message: `没送进去：${r.reason}` }
            const lines = [`已落盘：${r.path}${r.existed ? '（覆盖同名）' : ''}`, `去向：${r.dir}/ —— ${r.why}`, `字数：${r.chars}（中文 ${r.han}）`]
            if (r.alsoUseful?.length) lines.push('', '这段内容还能喂给：', ...r.alsoUseful.map((x) => `- ${x}`))
            return { ok: true, message: lines.join('\n') }
          }
          return { ok: false, message: `不认识的 action：${a}` }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 reader')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: reader 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 4f：指令库 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'instruction_library',
        description:
          '指令库 —— 「多次读小说 → 沉淀成指令 → 勾选组合 → 最终写作指令」的落点。'
          + 'action=list 看清单（含统计）；extract 从工作目录**提取素材**成条目（素材/拆文库/样本/设定）；'
          + 'for-slot 看某个槽位能用哪些条目（compose=true 直接合成该槽位的指令）；'
          + 'mine 生成「拆文入库」提示词（读一本书抽出可执行指令）；'
          + 'import 把模型产出的 JSON 导入成条目；add 手写一条；patch/remove/enable/reorder 管理；'
          + 'compose 把勾选的条目合成**最终写作指令**。'
          + '条目的判据是「指令」不是「资料」：「节奏很好」是资料，'
          + '「每章至少一次信息差变化」才是指令。',
        parameters: {
          action: { type: 'string', required: true, description: 'list | extract | for-slot | mine | import | add | patch | remove | enable | reorder | compose | dedupe | kinds', enum: ['list', 'extract', 'for-slot', 'mine', 'import', 'add', 'patch', 'remove', 'enable', 'reorder', 'compose', 'dedupe', 'kinds'] },
          dryRun: { type: 'boolean', description: 'action=dedupe：只报告会清掉多少，不动文件' },
          slot: { type: 'string', description: 'action=for-slot：槽位 id（chapter_pack 等）' },
          composeForSlot: { type: 'boolean', description: 'action=for-slot：true 时直接合成该槽位的指令' },
          dryRun: { type: 'boolean', description: 'action=extract：只报告会提到什么，不写盘' },
          id: { type: 'string', description: '条目 id（patch / remove）' },
          ids: { type: 'string', description: '多个 id，逗号分隔（compose / enable / reorder）' },
          text: { type: 'string', description: 'action=mine：要拆的正文；action=import：模型产出的 JSON' },
          bookName: { type: 'string', description: 'action=mine：书名/来源' },
          kinds: { type: 'string', description: 'action=mine：只抽这几类，逗号分隔' },
          name: { type: 'string', description: 'action=add/patch：条目名' },
          kind: { type: 'string', description: 'action=add/patch：类型' },
          body: { type: 'string', description: 'action=add/patch：指令正文' },
          summary: { type: 'string', description: 'action=add/patch：一句话说明' },
          source: { type: 'string', description: 'action=add/patch：来源' },
          enabled: { type: 'boolean', description: 'action=enable：启用还是停用' },
          title: { type: 'string', description: 'action=compose：合成后的标题' },
          groupByKind: { type: 'boolean', description: 'action=compose：按类型分组' },
          includeSource: { type: 'boolean', description: 'action=compose：是否标注来源' },
        },
        output: OUTPUT,
        async execute(args) {
          const a = args.action
          const ws = await ensureWorkspace()
          const ids = typeof args.ids === 'string' && args.ids.trim() !== ''
            ? args.ids.split(/[,，\s]+/).filter((x) => x !== '')
            : undefined

          if (a === 'dedupe') {
            const r = await lib.dedupe(ws, { dryRun: args.dryRun === true })
            const lines = [r.message, `清理前 ${r.before} 条${r.dryRun ? '' : `，清理后 ${r.after} 条`}`]
            if (r.groups.length > 0) {
              lines.push('', r.dryRun ? '会合并这些（每组保留一条）：' : '已合并这些（每组保留一条）：')
              for (const g of r.groups.slice(0, 20)) lines.push(`- 「${g.name.slice(0, 40)}」×${g.removed + 1} → 1`)
              if (r.groups.length > 20) lines.push(`… 还有 ${r.groups.length - 20} 组`)
            }
            if (r.dryRun) lines.push('', '去掉 dryRun 就真的清。')
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'kinds') {
            return { ok: true, message: ['条目类型：', ...lib.KINDS.map((k) => `- ${k.id}（${k.label}）：${k.desc}`)].join('\n') }
          }
          if (a === 'extract') {
            const r = await lib.extractFromWorkspace(ws, { dryRun: args.dryRun === true })
            if (r.dryRun === true) {
              const lines = [`扫描到 ${r.count} 个可提取的文件：`]
              for (const x of r.found.slice(0, 40)) lines.push(`- [${x.kind}] ${x.name}　（${x.dir}/）`)
              if (r.count > 40) lines.push(`… 还有 ${r.count - 40} 个`)
              lines.push('', '去掉 dryRun 就真的写进指令库。')
              return { ok: true, message: lines.join('\\n') }
            }
            const lines = [`提取完成：新增 ${r.added} 条（扫描 ${r.scanned} 个文件）。`]
            for (const x of (r.items ?? []).slice(0, 30)) lines.push(`- [${x.kind}] ${x.name}　（${x.dir}/）`)
            if ((r.skipped ?? []).length > 0) {
              lines.push('', `${r.skipped.length} 个跳过：`)
              for (const x of r.skipped.slice(0, 8)) lines.push(`- ${x.name}：${x.reason}`)
            }
            lines.push('', '提取进来的都标了「待整理」—— 原文不是指令，得改成可执行的句子才算数。')
            return { ok: r.ok, message: lines.join('\\n') }
          }
          if (a === 'for-slot') {
            if (typeof args.slot !== 'string') return { ok: false, message: '需要 slot。' }
            if (args.composeForSlot === true) {
              const r = await lib.composeForSlot(ws, args.slot, ids, { title: `${args.slot} 指令` })
              if (r.ok !== true) return { ok: false, message: r.reason }
              return { ok: true, message: [`「${args.slot}」指令已合成：${r.used.length}/${r.poolSize} 条，${r.chars} 字。`, '', r.text].join('\\n') }
            }
            const r = await lib.forSlot(ws, args.slot)
            const lines = [`「${args.slot}」用得到的类型：${r.kinds.join('、') || '（无）'}`, `共 ${r.items.length} 条（启用 ${r.enabled}），${r.totalChars} 字`, '']
            for (const x of r.items.slice(0, 40)) lines.push(`${x.enabled === false ? '☐' : '☑'} [${lib.KIND_LABEL[x.kind] ?? x.kind}] ${x.name}`)
            if (r.items.length === 0) lines.push('（这个槽位还没有可用条目 —— 先去 action=extract 从工作目录提取，或 action=mine 拆一本书）')
            return { ok: true, message: lines.join('\\n') }
          }
          if (a === 'mine') {
            const kinds = typeof args.kinds === 'string' && args.kinds.trim() !== ''
              ? args.kinds.split(/[,，\s]+/).filter((x) => x !== '')
              : undefined
            const r = await runMiner(ws, { text: args.text, bookName: args.bookName, kinds })
            if (r.ok !== true) return { ok: false, message: `没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
            return {
              ok: true,
              message: [
                `拆文提示词已组装（正文 ${r.chars} 字，抽 ${r.focus.join('/')} 这几类）。`,
                `⚠ 人工门禁：${r.gate}`,
                '',
                r.importHint,
                '',
                '--- 提示词开始 ---',
                r.prompt,
                '--- 提示词结束 ---',
              ].join('\n'),
            }
          }
          if (a === 'import') {
            const parsed = lib.parseItems(args.text)
            if (parsed.ok !== true) return { ok: false, message: `解析失败：${parsed.reason}` }
            const r = await lib.importItems(ws, parsed.items, { source: args.bookName ?? args.source })
            const lines = [`导入 ${r.added} 条（解析出 ${parsed.count} 条）。`]
            for (const x of r.items ?? []) lines.push(`- [${x.kind}] ${x.name}`)
            if ((r.skipped ?? []).length > 0) {
              lines.push('', `${r.skipped.length} 条被跳过：`)
              for (const x of r.skipped.slice(0, 8)) lines.push(`- ${x.name}：${x.errors.join('；')}`)
            }
            lines.push('', '到「指令库」页签就能看到它们。')
            return { ok: r.ok, message: lines.join('\n') }
          }
          if (a === 'add') {
            const r = await lib.put(ws, { name: args.name, kind: args.kind, body: args.body, summary: args.summary, source: args.source })
            if (r.ok !== true) return { ok: false, message: `没加进去：${r.errors.join('；')}` }
            return { ok: true, message: `已加：[${r.item.kind}] ${r.item.name}` }
          }
          if (a === 'patch') {
            if (typeof args.id !== 'string') return { ok: false, message: '需要 id。' }
            const changes = {}
            for (const k of ['name', 'kind', 'body', 'summary', 'source']) if (args[k] !== undefined) changes[k] = args[k]
            const r = await lib.patch(ws, args.id, changes)
            return r.ok === true ? { ok: true, message: `已改：${r.item.name}` } : { ok: false, message: r.reason ?? (r.errors ?? []).join('；') }
          }
          if (a === 'remove') {
            if (typeof args.id !== 'string') return { ok: false, message: '需要 id。' }
            const r = await lib.remove(ws, args.id)
            return r.ok === true ? { ok: true, message: `已删：${r.id}` } : { ok: false, message: r.reason }
          }
          if (a === 'enable') {
            if (ids === undefined) return { ok: false, message: '需要 ids。' }
            const r = await lib.setEnabled(ws, ids, args.enabled !== false)
            return { ok: true, message: `已${args.enabled === false ? '停用' : '启用'} ${r.changed} 条。` }
          }
          if (a === 'reorder') {
            if (ids === undefined) return { ok: false, message: '需要 ids（按想要的顺序）。' }
            const r = await lib.reorder(ws, ids)
            return { ok: true, message: `已重排 ${r.changed} 条。` }
          }
          if (a === 'compose') {
            const r = await lib.compose(ws, ids, { title: args.title, groupByKind: args.groupByKind, includeSource: args.includeSource })
            if (r.ok !== true) return { ok: false, message: r.reason }
            return {
              ok: true,
              message: [
                `最终指令已合成：${r.used.length} 条，${r.chars} 字。`,
                `构成：${Object.entries(r.byKind).map(([k, n]) => `${lib.KIND_LABEL[k] ?? k}×${n}`).join('　')}`,
                '',
                '--- 最终指令开始 ---',
                r.text,
                '--- 最终指令结束 ---',
              ].join('\n'),
            }
          }
          const s2 = await lib.summary(ws)
          const lines = [`指令库：${s2.dir}`, `共 ${s2.items.length} 条（启用 ${s2.enabled}），${s2.totalChars} 字`, '']
          for (const k of s2.kinds) lines.push(`- ${k.label}：${k.count} 条`)
          if (s2.sources.length > 0) lines.push('', `素材来源 ${s2.sources.length} 个：${s2.sources.slice(0, 8).join('、')}`)
          if (s2.items.length > 0) {
            lines.push('', '清单：')
            for (const x of s2.items.slice(0, 40)) lines.push(`${x.enabled === false ? '☐' : '☑'} [${lib.KIND_LABEL[x.kind] ?? x.kind}] ${x.name}${x.source ? `（${x.source}）` : ''}`)
            if (s2.items.length > 40) lines.push(`… 还有 ${s2.items.length - 40} 条`)
          }
          if ((s2.broken ?? []).length > 0) lines.push('', `⚠ ${s2.broken.length} 个文件读不了`)
          return { ok: true, message: lines.join('\n') }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 instruction_library')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: instruction_library 注册失败：${e?.message ?? String(e)}`)
    }
  })

  // —— 工具 4g：素材拆解与逻辑图 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'novel_logic_map',
        description:
          '小说逻辑图 —— 「写作槽位提取本地素材 → 子智能拆分阅读 → 结果填进槽位对应功能点 → '
          + '一键生成完整逻辑图 → 存进指令库当真实素材库」这条链的中段。'
          + 'action=extract 从工作目录提取素材；decompose 组装子智能拆解提示词；'
          + 'accept 收下子智能产出并存成图（设定/小说逻辑图.md + .json）；'
          + 'read 看当前图；to-library 把图拆成指令库条目。',
        parameters: {
          action: { type: 'string', required: true, description: 'extract | chunks | chunk | decompose | accept | read | to-library | plan | claim-batch | accept-part | merge | reset-parts | part-to-library | parts-in-library', enum: ['extract', 'chunks', 'chunk', 'decompose', 'accept', 'read', 'to-library', 'plan', 'claim-batch', 'accept-part', 'merge', 'reset-parts', 'part-to-library', 'parts-in-library'] },
          size: { type: 'number', description: 'action=claim-batch：一次取几段（默认 4，最多 20）' },
          index: { type: 'number', description: 'action=accept-part：第几段（从 0 起）' },
          retake: { type: 'boolean', description: 'action=claim-batch：连「在拆」的段也重新派发' },
          path: { type: 'string', description: 'action=chunks/chunk：书文件路径（缺省用 本地书/ 里第一本）' },
          chunkIndex: { type: 'number', description: 'action=chunk：第几段（从 0 起）' },
          chunkChars: { type: 'number', description: 'action=chunks：每段字数上限（默认 20000）' },
          dirs: { type: 'string', description: 'action=extract：只扫这几个目录，逗号分隔（素材/拆文库/样本/设定）' },
          material: { type: 'string', description: 'action=decompose：要拆的素材正文' },
          materialList: { type: 'string', description: 'action=decompose：素材清单（每行一个）' },
          kinds: { type: 'string', description: 'action=decompose：只抽这几类节点' },
          text: { type: 'string', description: 'action=accept：子智能产出的 JSON' },
          onDuplicate: { type: 'string', description: '重复条目怎么办：update（默认，更新已有）/ skip（跳过）/ new（复制一份）' },
        },
        output: OUTPUT,
        async execute(args) {
          const a = args.action
          const ws = await ensureWorkspace()

          if (a === 'extract') {
            const dirs = typeof args.dirs === 'string' && args.dirs.trim() !== ''
              ? args.dirs.split(/[,，\s]+/).filter((x) => x !== '')
              : undefined
            const r = await extractFromWorkspace(ws, { dirs })
            const lines = [`从工作目录提取：新增 ${r.added} 条（扫描 ${r.scanned} 个文件）。`]
            for (const x of (r.items ?? []).slice(0, 30)) lines.push(`- [${x.kind}] ${x.name}　（${x.dir}/）`)
            if ((r.skipped ?? []).length > 0) {
              lines.push('', `${r.skipped.length} 个跳过：`)
              for (const x of r.skipped.slice(0, 8)) lines.push(`- ${x.name}：${x.reason}`)
            }
            lines.push('', '提取的是**原料**（默认不参与合成）。下一步：action=decompose 让子智能拆它。')
            return { ok: r.ok, message: lines.join('\n') }
          }
          if (a === 'plan') {
            // 看板：98 段里哪几段完成、还差几段
            const r = await batch.plan(ws, { path: args.path, chunkChars: args.chunkChars })
            if (r.ok !== true) return { ok: false, message: r.reason }
            const lines = [
              `${r.bookName}：${r.totalChars} 字${r.byChapter ? `，${r.chapterMarks} 个章节标题` : ''}`,
              `进度：${r.done}/${r.total} 段完成${r.running ? `，${r.running} 段在拆` : ''}${r.failed ? `，${r.failed} 段失败` : ''}` + `，累计 ${r.nodesSoFar} 个节点`,
              '',
            ]
            for (const x of r.rows.slice(0, 40)) {
              const mark = x.state === 'done' ? '☑' : x.state === 'running' ? '▶' : x.state === 'failed' ? '✗' : '☐'
              lines.push(`${mark} ${x.index + 1}. ${x.title.slice(0, 26)}　${x.chapters} 章　${x.chars} 字${x.state === 'done' ? `　→ ${x.nodes} 节点` : ''}${x.state === 'running' ? '　在拆…' : ''}${x.failed ? `　失败：${x.failed}` : ''}`)
            }
            if (r.rows.length > 40) lines.push(`… 还有 ${r.rows.length - 40} 段`)
            lines.push('', r.done === r.total ? '全部完成 —— 用 action=merge 合并全书图。' : `还剩 ${r.pending} 段。用 action=claim-batch 取一批去拆。`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'claim-batch') {
            const r = await batch.claimBatch(ws, { path: args.path, size: args.size, chunkChars: args.chunkChars, retake: args.retake })
            if (r.ok !== true) return { ok: false, message: r.reason }
            const brief = batch.collaborationBrief(r.total, r.claimed)
            const lines = [
              `领到 ${r.claimed} 段（共 ${r.total} 段，已存 ${r.total - r.remaining} 段）。`,
              '',
              '**每个子智能只拆一段，互不干扰** —— 一个子智能读多段会串味，判断标准会漂移。',
              '',
            ]
            for (const t of r.tasks) {
              lines.push(`--- 第 ${t.index + 1} 段 ｜ ${t.title} ｜ ${t.chapters} 章 ｜ ${t.chars} 字 ---`)
              lines.push(`（正文 ${t.chars} 字，用 action=chunk、index=${t.index} 取，或直接把它拼进拆解提示词）`)
              lines.push('')
            }
            lines.push('流程：')
            for (const st of brief.steps) lines.push(`  ${st}`)
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'accept-part') {
            if (!Number.isFinite(args.index)) return { ok: false, message: '需要 index（第几段，从 0 起）' }
            const r = await batch.acceptPart(ws, Number(args.index), args.text ?? '')
            if (r.ok !== true && r.saved !== true) return { ok: false, message: `第 ${args.index + 1} 段没收下：${r.reason}` }
            const lines = [
              `第 ${args.index + 1} 段：${r.ok ? '收下' : '存了但校验没过'}`,
              `节点 ${r.stats?.nodes ?? 0}、连线 ${r.stats?.edges ?? 0}，有出处 ${r.stats?.sourced ?? 0}/${r.stats?.nodes ?? 0}`,
            ]
            if ((r.errors ?? []).length > 0) lines.push('', '错误：', ...r.errors.map((x) => `- ${x}`))
            if ((r.warnings ?? []).length > 0) lines.push('', '提醒：', ...r.warnings.map((x) => `- ${x}`))
            return { ok: r.ok === true, message: lines.join('\n') }
          }
          if (a === 'merge') {
            const r = await batch.merge(ws, { path: args.path, chunkChars: args.chunkChars })
            if (r.ok !== true) return { ok: false, message: r.reason }
            const saved = await batch.saveMerged(ws, r.map)
            const lines = [
              `全书图已合并：${r.parts}/${r.total} 段`,
              `节点 ${r.stats.nodes} 个（去重后）、连线 ${r.stats.edges} 条，${r.stats.chars} 字`,
              `构成：${Object.entries(r.stats.byKind ?? {}).map(([k, n]) => `${logicmap.NODE_LABEL[k] ?? k}×${n}`).join('　')}`,
              `有出处：${r.stats.sourced}/${r.stats.nodes}`,
              '',
              r.note,
              `存到：${saved.path}`,
            ]
            if ((r.errors ?? []).length > 0) lines.push('', '⛔ 合并后校验不过：', ...r.errors.slice(0, 10).map((x) => `- ${x}`))
            if ((r.warnings ?? []).length > 0) lines.push('', `⚠ ${r.warnings.length} 处提醒`, ...r.warnings.slice(0, 8).map((x) => `- ${x}`))
            lines.push('', '接着用 action=to-library 把全书图拆成指令库条目。')
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'part-to-library') {
            if (!Number.isFinite(args.index)) return { ok: false, message: '需要 index（第几段，从 0 起）' }
            const r = await batch.partToLibrary(ws, Number(args.index), { onDuplicate: args.onDuplicate })
            if (r.ok !== true) return { ok: false, message: r.reason ?? '没拆成' }
            const lines = [`第 ${args.index + 1} 段：${r.added} 个节点已进指令库。`]
            for (const x of (r.items ?? []).slice(0, 20)) lines.push(`- [${x.kind}] ${x.name}`)
            lines.push('', r.note, '', '这些条目带「段:' + (args.index + 1) + '」标签，指令库里能按段筛。')
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'parts-in-library') {
            const r = await batch.partsInLibrary(ws)
            const segs = Object.entries(r.segments)
            const lines = [`指令库里已有 ${r.count} 段的内容（共 ${r.total} 条条目）。`, '']
            if (segs.length === 0) lines.push('（还没有任何分段的条目 —— 拆完一段后用 action=part-to-library 送进来）')
            else for (const [seg, n] of segs) lines.push(`- 第 ${seg} 段：${n} 条`)
            lines.push('', '界面上这些分段会标绿。')
            return { ok: true, message: lines.join('\n') }
          }
          if (a === 'reset-parts') {
            const r = await batch.resetParts(ws)
            return { ok: true, message: `清掉 ${r.cleared} 个分片。` }
          }
          if (a === 'chunks') {
            // 整本小说几十万字，塞不进一次提示词 —— 先切段
            let path = args.path
            if (typeof path !== 'string' || path === '') {
              const { readdir } = await import('node:fs/promises')
              let names = []
              try { names = (await readdir(join(ws, '本地书'))).filter((n) => /\.txt$/i.test(n)) } catch { names = [] }
              if (names.length === 0) return { ok: false, message: '本地书/ 里没有 txt。把书放进去，或直接给 path。' }
              path = join(ws, '本地书', names[0])
            }
            const r = await chunkBook(path, { chunkChars: args.chunkChars })
            const lines = [
              `${path.split('/').pop()}：${r.totalChars} 字`,
              r.byChapter ? `找到 ${r.chapterMarks} 个章节标题，按章节切了 ${r.total} 段` : `没找到章节标题，按字数切了 ${r.total} 段`,
              r.truncated ? `（只列前 ${r.chunks.length} 段）` : '',
              '',
            ]
            for (const c of r.chunks.slice(0, 30)) lines.push(`${c.index}. ${c.title.slice(0, 30)}　${c.chapters} 章　${c.chars} 字`)
            if (r.total > 30) lines.push(`… 还有 ${r.total - 30} 段`)
            lines.push('', '用 action=chunk、chunkIndex=N 取某段正文去拆解。')
            return { ok: r.ok, message: lines.filter((x) => x !== '').join('\n') }
          }
          if (a === 'chunk') {
            let path = args.path
            if (typeof path !== 'string' || path === '') {
              const { readdir } = await import('node:fs/promises')
              let names = []
              try { names = (await readdir(join(ws, '本地书'))).filter((n) => /\.txt$/i.test(n)) } catch { names = [] }
              if (names.length === 0) return { ok: false, message: '本地书/ 里没有 txt。' }
              path = join(ws, '本地书', names[0])
            }
            const c = await chunkText(path, args.chunkIndex ?? 0, { chunkChars: args.chunkChars })
            if (c.ok !== true) return { ok: false, message: c.reason }
            return { ok: true, message: [`第 ${c.index + 1} 段：${c.title}　${c.chars} 字${c.chapters ? `（${c.chapters} 章）` : ''}`, '', c.text.slice(0, 600), '', '…（完整正文用 action=decompose 时作为 material 传入）'].join('\n') }
          }
          if (a === 'decompose') {
            const kinds = typeof args.kinds === 'string' && args.kinds.trim() !== ''
              ? args.kinds.split(/[,，\s]+/).filter((x) => x !== '')
              : undefined
            const list = typeof args.materialList === 'string' && args.materialList.trim() !== ''
              ? args.materialList.split('\n').map((x) => x.trim()).filter((x) => x !== '')
              : undefined
            const cur = await readMap(ws)
            const r = await runDecompose(ws, {
              material: args.material, materialList: list, kinds,
              existingMap: cur.ok === true ? cur.text : null,
            })
            if (r.ok !== true) return { ok: false, message: `没组装成：${r.reason ?? (r.promptErrors ?? []).join('；')}` }
            return {
              ok: true,
              message: [
                `子智能拆解提示词已组装（素材 ${r.chars} 字，抽 ${r.focus.join('/')}）。`,
                cur.ok === true ? '（已带上现有逻辑图 —— 这次是在它基础上补充）' : '（还没有逻辑图，这是第一张）',
                `⚠ 人工门禁：${r.gate}`,
                '',
                '把提示词交给子智能跑，产出 JSON 后用 action=accept 收下。',
                '',
                '--- 提示词开始 ---',
                r.prompt,
                '--- 提示词结束 ---',
              ].join('\n'),
            }
          }
          if (a === 'accept') {
            const r = await acceptMap(ws, args.text)
            if (r.ok !== true && r.reason !== undefined) return { ok: false, message: r.reason }
            const v = r.validation
            const lines = [
              `逻辑图已存：${r.path}`,
              `节点 ${r.stats?.nodes ?? 0} 个、连线 ${r.stats?.edges ?? 0} 条，${r.stats?.chars ?? 0} 字`,
              `构成：${Object.entries(r.stats?.byKind ?? {}).map(([k, n]) => `${logicmap.NODE_LABEL[k] ?? k}×${n}`).join('　')}`,
              `有出处的节点：${r.stats?.sourced ?? 0}/${r.stats?.nodes ?? 0}`,
            ]
            if (v.errors.length > 0) lines.push('', `⛔ ${v.errors.length} 处不合契约：`, ...v.errors.map((x) => `- ${x}`))
            if (v.warnings.length > 0) lines.push('', `⚠ ${v.warnings.length} 处提醒：`, ...v.warnings.map((x) => `- ${x}`))
            lines.push('', r.next)
            return { ok: r.ok, message: lines.join('\n') }
          }
          if (a === 'read') {
            const r = await readMap(ws)
            return r.ok === true ? { ok: true, message: r.text } : { ok: false, message: r.reason }
          }
          if (a === 'to-library') {
            const r = await mapToLibrary(ws, { onDuplicate: args.onDuplicate })
            if (r.ok !== true) return { ok: false, message: r.reason ?? '没拆成' }
            const lines = [`逻辑图已拆成 ${r.added} 条指令库条目。`]
            for (const x of (r.items ?? []).slice(0, 30)) lines.push(`- [${x.kind}] ${x.name}`)
            lines.push('', r.note)
            return { ok: true, message: lines.join('\n') }
          }
          return { ok: false, message: `不认识的 action：${a}` }
        },
      }))
      ctx.logger?.info?.('dsh-writing-slots: 已注册 novel_logic_map')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-writing-slots: novel_logic_map 注册失败：${e?.message ?? String(e)}`)
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
    const handler = makeApiHandler({
      dirFor, ctx, autoContinue,
      workspace: {
        ensure: ensureWorkspace,
        // source / stale 是 apply() 的局部变量，顶层函数够不到 —— 必须显式暴露。
        // （第一版我直接在路由里用了 workspaceSource，运行时才报 not defined）
        source: () => workspaceSource,
        stale: () => workspaceStale,
        clearStale: () => { workspaceStale = null },
        forget: async () => {
          workspaceDir = null
          workspaceSource = null
          workspaceStale = null
          await wsSaveGlobal({ workspace: null }).catch(() => {})
          // 回退结果也在这里算 —— ctx 是 apply() 的局部变量，
          // 顶层 makeApiHandler 够不到它（这正是前面那个 bug 的来源）
          const r = resolveWorkspace({ sessionCwd: sessionCwdOf(ctx) })
          workspaceDir = r.dir
          workspaceSource = r.source
          return { dir: r.dir, source: r.source }
        },
        set: async (p) => {
          const dir = expandWorkspace(p)
          workspaceStale = null
          await setWorkspace(dir, 'set')
          // 工作目录自己也留一份（记的是这个目录的元信息，不是「它是哪个目录」）
          await wsSaveConfig(dir, { workspace: dir }).catch(() => {})
          return { ok: true, dir: workspaceDir, source: workspaceSource }
        },
        get: () => workspaceDir,
      },
    })
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

function makeApiHandler({ dirFor, ctx, autoContinue, workspace }) {
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

      // —— 阅读器 ——
      if (path.startsWith('/reader')) {
        const ws = await workspace.ensure()
        const json = (body, status = 200) => sendJson(res, status, body)
        try {
          if (req.method === 'GET' && path === '/reader/sources') {
            const list = reader.listSources()
            json({ ok: true, sources: list, count: list.length, notice: reader.SOURCE_NOTICE })
            return
          }
          if (req.method === 'POST' && path === '/reader/search') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const kw = typeof body.keyword === 'string' ? body.keyword.trim() : ''
            if (kw === '') { json({ ok: false, error: '需要 keyword' }, 400); return }
            json({ ok: true, ...(await reader.searchAll(kw, { limit: body.limit, sources: body.sources })) })
            return
          }
          if (req.method === 'POST' && path === '/reader/chapters') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const cs = await reader.chapters(body.source, body.url)
            json({ ok: true, chapters: cs, count: cs.length })
            return
          }
          if (req.method === 'POST' && path === '/reader/content') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const text = await reader.content(body.source, body.url)
            json({ ok: true, text, chars: text.length, classified: classifyContent(text) })
            return
          }
          if (path === '/reader/download') {
            if (req.method === 'GET') {
              const id = url.searchParams.get('id') ?? ''
              const list = reader.downloads.list?.() ?? null
              const task = id === '' ? null : reader.downloads.get(id)
              json(task === undefined || task === null ? { ok: false, tasks: list, error: '没有这个任务' } : { ok: true, task })
              return
            }
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const src = reader.findSource(body.source)
            if (src === null) { json({ ok: false, error: `没有这个书源：${body.source}` }, 400); return }
            const id = reader.downloads.start({ source: src, bookUrl: body.url, title: body.title ?? '未命名', dir: join(ws, '导出') })
            json({ ok: true, taskId: id, dir: join(ws, '导出') }, 202)
            return
          }
          if (req.method === 'POST' && path === '/reader/download/cancel') {
            const body = await readBody(req)
            json({ ok: true, cancelled: reader.downloads.cancel(body?.id) })
            return
          }
          if (req.method === 'GET' && path === '/reader/local') {
            json({ ok: true, ...(await reader.scanBooks(ws, url.searchParams.get('dir') ?? undefined)) })
            return
          }
          if (req.method === 'POST' && path === '/reader/local/read') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await reader.readBook(body.path)
            // 正文可能很大，列表接口不带全文
            json({ ok: true, size: r.size, chapterCount: r.chapterCount, chapters: r.chapters.map((c, i) => ({ index: i, title: c.title, chars: c.text.length })) })
            return
          }
          if (req.method === 'POST' && path === '/reader/local/chapter') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await reader.readBook(body.path)
            const c = r.chapters[Number(body.index) || 0]
            json(c === undefined ? { ok: false, error: '没有这一章' } : { ok: true, title: c.title, text: c.text, index: Number(body.index) || 0, total: r.chapterCount })
            return
          }
          if (req.method === 'POST' && path === '/reader/send') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await reader.sendToWorkspace(ws, { kind: body.kind, name: body.name, text: body.text, chapterIndex: body.chapterIndex }))
            return
          }
          json({ ok: false, error: `未知阅读器接口：${req.method} ${path}` }, 404)
        } catch (e) {
          const known = e instanceof reader.BookSourceError || e?.name === 'BookSourceError'
          json({ ok: false, error: e?.message ?? String(e), kind: known ? 'book-source' : 'reader' }, 502)
        }
        return
      }

      // —— 逻辑图 ——
      if (path.startsWith('/logicmap')) {
        const ws = await workspace.ensure()
        const json = (b, st = 200) => sendJson(res, st, b)
        try {
          if (req.method === 'GET' && path === '/logicmap') {
            const r = await readMap(ws)
            json({ ok: r.ok, path: r.path ?? null, text: r.text ?? null, reason: r.reason ?? null, kinds: logicmap.NODE_KINDS })
            return
          }
          if (req.method === 'POST' && path === '/logicmap/extract') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json({ ok: true, ...(await extractFromWorkspace(ws, { dirs: body.dirs })) })
            return
          }
          if (req.method === 'POST' && path === '/logicmap/plan') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await batch.plan(ws, { path: body.path, chunkChars: body.chunkChars })
            json(r, r.ok === true ? 200 : 400)
            return
          }
          if (req.method === 'POST' && path === '/logicmap/claim-batch') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await batch.claimBatch(ws, { path: body.path, size: body.size, chunkChars: body.chunkChars, retake: body.retake })
            json(r, r.ok === true ? 200 : 400)
            return
          }
          if (req.method === 'POST' && path === '/logicmap/accept-part') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await batch.acceptPart(ws, Number(body.index) || 0, body.text ?? ''))
            return
          }
          if (req.method === 'POST' && path === '/logicmap/merge') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await batch.merge(ws, { path: body.path, chunkChars: body.chunkChars })
            if (r.ok !== true) { json({ ok: false, reason: r.reason }, 400); return }
            const saved = await batch.saveMerged(ws, r.map)
            json({ ok: true, path: saved.path, ...r, saved: { path: saved.path, stats: saved.stats } })
            return
          }
          if (req.method === 'POST' && path === '/logicmap/part-to-library') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await batch.partToLibrary(ws, Number(body.index) || 0, { onDuplicate: body.onDuplicate }))
            return
          }
          if (req.method === 'GET' && path === '/logicmap/parts-in-library') {
            json(await batch.partsInLibrary(ws))
            return
          }
          if (req.method === 'POST' && path === '/logicmap/reset-parts') {
            json({ ok: true, ...(await batch.resetParts(ws)) })
            return
          }
          if (req.method === 'POST' && path === '/logicmap/chunks') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            let p = body.path
            if (typeof p !== 'string' || p === '') {
              const { readdir } = await import('node:fs/promises')
              let names = []
              let why = null
              const dirPath = join(ws, '本地书')
              try { names = (await readdir(dirPath)).filter((n) => /\.txt$/i.test(n)) } catch (e) { why = `${dirPath}：${e?.code ?? e?.message ?? e}`; names = [] }
              if (names.length === 0) { json({ ok: false, reason: why ?? `${dirPath} 里没有 txt（目录存在但为空？）`, dir: dirPath }, 400); return }
              p = join(ws, '本地书', names[0])
            }
            json({ ok: true, ...(await chunkBook(p, { chunkChars: body.chunkChars })) })
            return
          }
          if (req.method === 'POST' && path === '/logicmap/chunk') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            let p = body.path
            if (typeof p !== 'string' || p === '') {
              const { readdir } = await import('node:fs/promises')
              let names = []
              let why = null
              const dirPath = join(ws, '本地书')
              try { names = (await readdir(dirPath)).filter((n) => /\.txt$/i.test(n)) } catch (e) { why = `${dirPath}：${e?.code ?? e?.message ?? e}`; names = [] }
              if (names.length === 0) { json({ ok: false, reason: why ?? `${dirPath} 里没有 txt（目录存在但为空？）`, dir: dirPath }, 400); return }
              p = join(ws, '本地书', names[0])
            }
            json(await chunkText(p, body.chunkIndex ?? 0, { chunkChars: body.chunkChars }))
            return
          }
          if (req.method === 'POST' && path === '/logicmap/decompose') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const cur = await readMap(ws)
            const r = await runDecompose(ws, {
              material: body.material, materialList: body.materialList, kinds: body.kinds,
              existingMap: cur.ok === true ? cur.text : null,
            })
            json(r.ok === true ? { ok: true, ...r } : { ok: false, reason: r.reason ?? (r.promptErrors ?? []).join('；') }, r.ok === true ? 200 : 400)
            return
          }
          if (req.method === 'POST' && path === '/logicmap/accept') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await acceptMap(ws, body.text))
            return
          }
          if (req.method === 'POST' && path === '/logicmap/to-library') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await mapToLibrary(ws, { onDuplicate: body.onDuplicate }))
            return
          }
          json({ ok: false, error: `未知逻辑图接口：${req.method} ${path}` }, 404)
        } catch (e) {
          json({ ok: false, error: e?.message ?? String(e) }, 500)
        }
        return
      }

      // —— 指令库 ——
      if (path.startsWith('/library')) {
        const ws = await workspace.ensure()
        const json = (b, st = 200) => sendJson(res, st, b)
        try {
          if (req.method === 'GET' && path === '/library') {
            // 注意别用 kinds: lib.KINDS 覆盖 —— summary() 返回的 kinds 是
            // **带计数**的（{...类型定义, count}），直接盖会把计数弄丢
            json({ ok: true, ...(await lib.summary(ws)), kindDefs: lib.KINDS })
            return
          }
          if (req.method === 'POST' && path === '/library/add') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await lib.put(ws, body)
            json(r.ok === true ? { ok: true, item: r.item } : { ok: false, errors: r.errors }, r.ok === true ? 200 : 400)
            return
          }
          if (req.method === 'POST' && path === '/library/import') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const parsed = lib.parseItems(body.text)
            if (parsed.ok !== true) { json({ ok: false, reason: parsed.reason }, 400); return }
            json({ ok: true, parsed: parsed.count, ...(await lib.importItems(ws, parsed.items, { source: body.source, onDuplicate: body.onDuplicate })) })
            return
          }
          if (req.method === 'POST' && path === '/library/patch') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await lib.patch(ws, body.id, body.changes ?? body)
            json(r.ok === true ? { ok: true, item: r.item } : { ok: false, reason: r.reason ?? (r.errors ?? []).join('；') }, r.ok === true ? 200 : 400)
            return
          }
          if (req.method === 'POST' && path === '/library/remove') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await lib.remove(ws, body.id))
            return
          }
          if (req.method === 'POST' && path === '/library/enable') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await lib.setEnabled(ws, body.ids, body.enabled !== false))
            return
          }
          if (req.method === 'POST' && path === '/library/reorder') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json(await lib.reorder(ws, body.ids))
            return
          }
          if (req.method === 'POST' && path === '/library/dedupe') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            json({ ok: true, ...(await lib.dedupe(ws, { dryRun: body.dryRun === true })) })
            return
          }
          if (req.method === 'POST' && path === '/library/compose') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await lib.compose(ws, body.ids, { title: body.title, groupByKind: body.groupByKind, includeSource: body.includeSource })
            json(r.ok === true ? { ok: true, ...r } : { ok: false, reason: r.reason }, r.ok === true ? 200 : 400)
            return
          }
          if (req.method === 'POST' && path === '/library/extract') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await lib.extractFromWorkspace(ws, { dryRun: body.dryRun === true, dirs: body.dirs, maxPerDir: body.maxPerDir })
            json({ ok: r.ok !== false, ...r })
            return
          }
          if (req.method === 'POST' && path === '/library/for-slot') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            if (body.compose === true) {
              json(await lib.composeForSlot(ws, body.slot, body.ids, { title: body.title, groupByKind: body.groupByKind }))
              return
            }
            json(await lib.forSlot(ws, body.slot))
            return
          }
          if (req.method === 'POST' && path === '/library/mine') {
            const body = await readBody(req)
            if (body === null) { json({ error: '请求体不是合法 JSON' }, 400); return }
            const r = await runMiner(ws, { text: body.text, bookName: body.bookName, kinds: body.kinds })
            json(r.ok === true ? { ok: true, ...r } : { ok: false, reason: r.reason }, r.ok === true ? 200 : 400)
            return
          }
          json({ ok: false, error: `未知指令库接口：${req.method} ${path}` }, 404)
        } catch (e) {
          json({ ok: false, error: e?.message ?? String(e) }, 500)
        }
        return
      }

      // —— 槽位盘点：工作区里有什么、每个槽位能不能跑 ——
      if (req.method === 'GET' && path === '/slots/inventory') {
        const ws = await workspace.ensure()
        const root = await locateProject(ws)
        sendJson(res, 200, { ok: true, workspace: ws, projectRoot: root, ...(await wsInventory(root)) })
        return
      }

      // —— 工作目录 ——
      if (path.startsWith('/workspace')) {
        if (req.method === 'GET' && path === '/workspace') {
          const ws = await workspace.ensure()
          const root = await locateProject(ws)
          const st = await wsStatus(root)
          sendJson(res, 200, {
            ok: true,
            workspace: ws, workspaceDisplay: displayPath(ws),
            workspaceSource: workspace.source(), workspaceStale: workspace.stale(),
            workspaceRemembered: (await wsLoadGlobal())?.workspace ?? null,
            globalConfigPath: globalConfigPath(),
            projectRoot: root, projectRootDisplay: displayPath(root),
            sameAsWorkspace: root === ws,
            exists: st.exists, dirs: st.dirs, keyFiles: st.keyFiles, config: st.config,
            layout: LAYOUT, configName: CONFIG_NAME,
          })
          return
        }
        if (req.method === 'POST' && path === '/workspace/set') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          if (typeof body.path !== 'string' || body.path.trim() === '') { sendJson(res, 400, { error: '需要 path' }); return }
          const dir = expandWorkspace(body.path)
          const v = await wsValidate(dir)
          let created = null
          if (!v.exists && body.create === true) created = await wsInit(dir)
          if (!v.exists && body.create !== true) {
            sendJson(res, 200, { ok: false, exists: false, reason: '目录不存在。要建的话带 create: true。', dir, display: displayPath(dir) })
            return
          }
          await workspace.set(dir)
          workspace.clearStale()
          const st = await wsStatus(await locateProject(dir))
          sendJson(res, 200, { ok: true, dir, display: displayPath(dir), source: workspace.source(), created: created?.created ?? [], status: st })
          return
        }
        if (req.method === 'POST' && path === '/workspace/init') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          const dir = await workspace.ensure(body.path)
          const r = await wsInit(dir, { only: Array.isArray(body.only) ? body.only : undefined })
          sendJson(res, 200, { ok: true, ...r, display: displayPath(r.dir) })
          return
        }
        if (req.method === 'POST' && path === '/workspace/retry') {
          // 重新检查记住的路径 —— 目录恢复可用就切回去（不用重启）
          workspaceDir = null
          workspaceSource = null
          workspaceStale = null
          const dir = await workspace.ensure()
          const remembered = await wsLoadGlobal()
          sendJson(res, 200, {
            ok: true,
            workspace: dir,
            display: displayPath(dir),
            source: workspace.source(),
            stale: workspace.stale(),
            remembered: remembered?.workspace ?? null,
            message: workspace.stale() === null
              ? `已切到 ${displayPath(dir)}`
              : `记住的路径仍不可用：${(workspace.stale()?.problems ?? []).join('；')}`,
          })
          return
        }
        if (req.method === 'POST' && path === '/workspace/forget') {
          const f = await workspace.forget()
          sendJson(res, 200, { ok: true, message: '已忘掉记住的工作目录，回退到会话 cwd', workspace: f.dir, source: f.source })
          return
        }
        if (req.method === 'POST' && path === '/workspace/validate') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          sendJson(res, 200, { ok: true, ...(await wsValidate(expandWorkspace(body.path))) })
          return
        }
        sendJson(res, 404, { error: `未知工作目录接口：${req.method} ${path}` })
        return
      }

      // —— 小说网站 ——
      if (path.startsWith('/sites')) {
        const ws = await workspace.ensure()
        if (req.method === 'GET' && path === '/sites') {
          const l = await listCookies(ws)
          sendJson(res, 200, {
            ok: true,
            sites: SITES.map((x) => {
              const st = l.sites.find((y) => y.id === x.id) ?? {}
              return { id: x.id, name: x.name, home: x.home, auth: x.auth, note: x.note, rankUrl: x.rankUrl, stored: st.stored === true, hint: st.hint ?? null, storedAt: st.storedAt ?? null, broken: st.broken ?? null }
            }),
            authDir: l.dir, keyExists: l.keyExists, reason: l.reason,
          })
          return
        }
        if (req.method === 'POST' && path === '/sites/cookie') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          if (body.remove === true) { sendJson(res, 200, await removeCookie(ws, body.site)); return }
          sendJson(res, 200, await setCookie(ws, body.site, body.cookie))
          return
        }
        if (req.method === 'POST' && path === '/sites/fetch') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          const r = await fetchRank(ws, body.site, { url: body.url })
          sendJson(res, 200, r)
          return
        }
        if (req.method === 'POST' && path === '/sites/classify') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          sendJson(res, 200, { ok: true, ...classifyContent(body.text, { kind: body.kind }) })
          return
        }
        if (req.method === 'POST' && path === '/sites/store') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          const c = classifyContent(body.text, { kind: body.kind })
          const dirName = body.dir ?? c.targets.find((t) => t.dir)?.dir ?? '素材'
          const name = body.name ?? `导入-${new Date().toISOString().slice(0, 10)}`
          const r = await storeContent(ws, dirName, name, body.text, { force: body.force === true })
          sendJson(res, 200, { ok: r.ok, ...r, classified: c, dirName })
          return
        }
        sendJson(res, 404, { error: `未知站点接口：${req.method} ${path}` })
        return
      }

      // —— 自动继跑 ——
      if (path.startsWith('/auto-continue')) {
        if (autoContinue === undefined) { sendJson(res, 503, { ok: false, reason: '自动继跑服务不可用' }); return }
        if (req.method === 'GET' && path === '/auto-continue') {
          sendJson(res, 200, { ok: true, ...autoContinue.status() })
          return
        }
        if (req.method === 'POST' && path === '/auto-continue/toggle') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          if (typeof body.enabled !== 'boolean') { sendJson(res, 400, { error: '需要 enabled 布尔值' }); return }
          sendJson(res, 200, { ok: true, ...autoContinue.setEnabled(body.enabled) })
          return
        }
        if (req.method === 'POST' && path === '/auto-continue/config') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          sendJson(res, 200, { ok: true, ...autoContinue.configure(body) })
          return
        }
        if (req.method === 'GET' && path === '/auto-continue/rules') {
          const st = autoContinue.status()
          sendJson(res, 200, {
            ok: true,
            rules: st.config.rules,
            whenLabels: st.whenLabels, actionLabels: st.actionLabels,
            ruleWhens: st.ruleWhens, ruleActions: st.ruleActions,
            defaults: st.defaults.rules,
          })
          return
        }
        if (req.method === 'GET' && path === '/auto-continue/models') {
          sendJson(res, 200, { ok: true, ...(await autoContinue.modelOptions()) })
          return
        }
        if (req.method === 'POST' && path === '/auto-continue/reset') {
          const body = await readBody(req)
          if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          sendJson(res, 200, { ok: true, ...autoContinue.reset(body.session) })
          return
        }
        sendJson(res, 404, { error: `未知自动继跑接口：${req.method} ${path}` })
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
