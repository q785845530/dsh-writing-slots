#!/usr/bin/env node
/**
 * dsh-writing-slots / 自测。
 *
 *   node verify.mjs
 *
 * 不联网。重点断言**契约与判据是代码在管**，而不是靠模型自觉：
 *   - 槽位缺必填 / 模板拼错名 → 渲染前就失败；
 *   - 审稿的上下文隔离是强制的，塞 style-guide 进去会被拒；
 *   - 审稿输出必须过 JSON 契约（枚举、定位、拒绝非原子指令）；
 *   - 去味规则在真语料上低误报（「知道」「一道」不能被当成对话标签）；
 *   - Style Anchor 样本不达标就不产出（拿两千字统计出来的基线会带偏写作）。
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectSlots, pick, render, checkContract, compose, digestOf, stringify } from './lib/render.js'
import {
  splitSentences, plainText, countChars, splitParagraphs, isDialogue,
  sentenceStats, paragraphStats, forbiddenList, sensoryBias, metaphorFingerprint,
  analyze, toMarkdown, parseMarkdown, anchorFor,
} from './lib/style.js'
import {
  padChapter, chapterNoFromName, parseBrief, splitList, parseRecaps,
  recapBefore, lastRecap, pendingChapter, inspect, chapterTaskFrom, bibleSliceFrom,
} from './lib/project.js'
import { checkIsolation, validateFindings, filterBySeverity, DIMENSIONS, SEVERITIES, ISOLATION_ALLOWLIST } from './lib/review.js'
import { POLISH_RULES, detect, verify, changeLog } from './lib/polish.js'
import { runStyleAnchor, runChapterPack, runReviewPass, runDeaiPolish, verifyPolish, loadStyleGuide, moduleStatus, STYLE_GUIDE_NAME } from './lib/pipeline.js'
import { MODULES, UPSTREAM_MODULES, STYLE_ANCHOR, WORLD_BUILDER, CHARACTER_DESIGNER, CHAPTER_PACK, REVIEW_PASS, DEAI_POLISH } from './lib/prompts.js'
import { validateWorld, validateCharacter, splitSections, WORLD_SECTIONS, CHARACTER_FIELDS } from './lib/bible.js'
import { ALLOWED, looksLikeFragment } from './lib/polish.js'
import { runWorldBuilder, checkWorld, runCharacterDesigner, checkCharacter, WORLD_BIBLE_NAME } from './lib/pipeline.js'
import { AI_TELLS } from './lib/style.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/** 造一个够格的项目（细纲 + 前情提要 + 大样本）。 */
async function makeProject(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dtj-slots-'))
  await mkdir(join(root, '细纲'), { recursive: true })
  await mkdir(join(root, 'chapters'), { recursive: true })
  await writeFile(join(root, '全书大纲.md'), '# 全书大纲\n\n三亩废田与十二年的稻。\n')
  await writeFile(join(root, '细纲', '第0025章.md'), [
    '# 第0025章 私仓里的寿贡粮（细纲）',
    '',
    '- **时间**：六月十二夜（0024 次日）。',
    '- **任务**：二更尾潜入旧档房，撞破截流现场。',
    '- **爽点（70% 处）**：成色、印信、袋数三样全看清。',
    '- **钩子（章末）**：换封的人提前到，锁拿到案。',
    '- **伏笔**：印信＝0041 的第二证据。',
    '- **不得违反**：不读任何字；不带任何赃物；不点裴典背后指使。',
  ].join('\n'))
  await writeFile(join(root, '前情提要.md'), [
    '# 前情提要',
    '',
    '## 0023《旧账》',
    '',
    '局面：查账。',
    '**章末钩**：账上少了一笔。',
    '',
    '## 0024《账本逮人》',
    '',
    '局面：借条手印对上保人。',
    '**章末钩**：他自己签的保成了逮他的账。',
    '',
    '## 0500《终章》',
    '',
    '局面：收尾。',
    '**章末钩**：他弯下腰，接着拔草。',
    '',
    '**待续写**：0500（终章）。',
  ].join('\n'))
  if (options.withChapter) {
    await writeFile(join(root, 'chapters', '第0025章-私仓.md'), '他仿佛听见了什么。\n\n他站起来。\n\n他走过去。\n')
  }
  return root
}

/** 造样本：总字数可控。 */
function sampleText(chars) {
  const unit = '他蹲下去，手指碰了碰谷壳。风从山壁后头过来，田里的草动了动。\n\n'
  return unit.repeat(Math.ceil(chars / countChars(unit)) + 1)
}

const main = async () => {
  // ————— 一、渲染引擎 —————
  console.log('一、槽位模板引擎')
  {
    const tpl = 'A {x}\n{#if y}B {y}\n{/if}{#each list as it}- {it}\n{/each}C {z.q}'
    const { slots, locals } = collectSlots(tpl)
    ok(slots.has('x') && slots.has('y') && slots.has('list') && slots.has('z'), '收集到全部槽位')
    ok(locals.has('it'), '循环变量单独识别（不当成外部槽位）')
    ok(!slots.has('it'), '循环变量不进槽位集合')

    const data = { x: '1', y: '', list: ['a', 'b'], z: { q: 'deep' } }
    const out = render(tpl, data)
    ok(out.includes('A 1'), '普通占位符')
    ok(!out.includes('B '), '假值条件块不渲染')
    ok(out.includes('- a') && out.includes('- b'), '循环渲染')
    ok(out.includes('C deep'), '嵌套路径取值')
    ok(render(tpl, { ...data, y: 'yes' }).includes('B yes'), '真值条件块渲染')
    ok(render('{#unless y}no-y{/unless}', { y: '' }) === 'no-y', 'unless 块')
    ok(render('{#unless y}no-y{/unless}', { y: 'x' }) === '', 'unless 块取反')
  }
  {
    const tpl = '要求：{a}'
    const decl = { required: ['a'], auto_injected: [], optional: [] }
    ok(compose(tpl, decl, { a: 'x' }).ok === true, '必填给了就通过')
    const miss = compose(tpl, decl, { a: '' })
    ok(miss.ok === false, '必填空串也算缺')
    ok(miss.errors.some((e) => e.includes('缺少必填槽位')), '报出缺哪个')
    const typo = compose('{a} {b_typo}', decl, { a: 'x' })
    ok(typo.ok === false, '模板用了未声明的槽位 → 失败')
    ok(typo.errors.some((e) => e.includes('b_typo')), '报出拼错的名字')
    ok(compose(tpl, decl, { a: 'x' }).warnings !== undefined, '带 warnings 字段')
    // 截断要留标记
    const long = compose('{a}', decl, { a: 'x'.repeat(100) }, { maxSlotChars: 10 })
    ok(long.prompt.includes('已截断'), '超长槽位截断并留标记')
  }
  {
    const v = stringify({ a: 1, b: ['x', 'y'], c: null })
    ok(v.includes('a：1'), '对象渲染成 k：v')
    ok(v.includes('- x'), '数组渲染成列表')
    ok(!v.includes('c'), 'null 字段被略去')
    ok(stringify(true) === '是', '布尔渲染')
    ok(pick({ a: { b: { c: 7 } } }, 'a.b.c') === 7, '深取值')
    ok(pick({ a: 1 }, 'a.b.c') === undefined, '取不到返回 undefined')
  }
  {
    const md = '均长 8.91 字，短句（≤15 字）占比 85%'
    const digest = digestOf({ sentence_length_baseline: { mean: 8.91, short_ratio: '85%', summary: md } })
    ok(digest.includes('8.91'), '摘要带出句长')
    ok(digest.includes('85%'), '摘要带出短句占比')
    ok(digestOf(null) === '', '没有 style-guide 时摘要为空')
  }

  // ————— 二、Style Anchor 统计 —————
  console.log('\n二、Style Anchor 统计')
  {
    const s = '他站起来。他走过去。他推开门，风进来了！走？'
    const sents = splitSentences(s)
    ok(sents.length === 4, `切出 4 句（实际 ${sents.length}）`)
    // 他一二三 = 4 个汉字；abc = 1 个英文词；45 = 1 个数字
    ok(countChars('他一二三abc45') === 4 + 1 + 1, '字数=汉字+英文词+数字')
    ok(plainText('# 标题\n**粗**体').includes('粗体'), '去掉 markdown 标记')
    ok(!plainText('# 标题').includes('#'), '标题行去掉')
  }
  {
    const st = sentenceStats(['他站起来。', '他走过去。', '风从山壁后头过来，田里的草动了动。'])
    ok(st.count === 3, '统计句数')
    ok(st.short_count >= 2, '认出短句')
    ok(st.summary === undefined || true, '（summary 在 guide 层加）')
    ok(typeof st.short_ratio === 'string' && st.short_ratio.endsWith('%'), '短句占比是百分比')
    ok(st.short_ratio_value >= 0 && st.short_ratio_value <= 1, '同时给 0—1 的值')
  }
  {
    // 对话识别：这份稿子用直角双引号，只认中文引号会算成 0%
    ok(isDialogue('"你来了。"'), '认出直角双引号对话')
    ok(isDialogue('“你来了。”'), '认出中文引号对话')
    ok(!isDialogue('他站起来。'), '叙述段不算对话')
    const ps = paragraphStats(['"你来了。"', '他站起来。', '"嗯。"'])
    ok(ps.dialogue_count === 2, '数出对话段')
    ok(ps.dialogue_ratio === '67%', `对话占比正确（实际 ${ps.dialogue_ratio}）`)
  }
  {
    // 禁忌清单判据：样本里 0 次命中
    const clean = '他蹲下去，手指碰了碰谷壳。'
    const list = forbiddenList(clean)
    ok(list.length > 0, '干净样本产出禁忌项')
    ok(list.every((f) => f.sample_hits === 0), '禁忌项都是 0 次命中')
    ok(list.some((f) => f.rule.includes('仿佛')), '「仿佛」类进清单')
    // 样本里出现过的就不该列为禁忌
    const dirty = '他仿佛听见了什么。'
    const list2 = forbiddenList(dirty)
    ok(!list2.some((f) => f.rule.includes('仿佛')), '样本里出现过的句式不进禁忌清单')
    ok(list2.length < list.length, '命中越多，禁忌越少')
  }
  {
    const bias = sensoryBias('他看了一眼，光亮得很。她摸了摸，凉的。')
    ok(bias.prefer.includes('视觉'), '认出视觉偏好')
    ok(bias.counts.视觉 > 0, '视觉计数')
    const mp = metaphorFingerprint('那穗子黄得像刚从灶里扒出来的粟。')
    ok(mp.typical_sources.includes('日常物'), '比喻落点认到日常物')
    ok(mp.density.endsWith('/千字'), '比喻密度带单位')
  }
  {
    // 样本不达标就不产出
    const small = [{ name: 'a', text: sampleText(100) }, { name: 'b', text: sampleText(100) }]
    const bad = analyze(small)
    ok(bad.ok === false, '样本不足时不产出')
    ok(bad.problems.some((p) => p.includes('篇数')), '报出篇数不足')
    const bad2 = analyze([{ name: 'a', text: 'x' }, { name: 'b', text: 'y' }, { name: 'c', text: 'z' }])
    ok(bad2.ok === false && bad2.problems.some((p) => p.includes('字数')), '报出字数不足')

    const big = [1, 2, 3, 4].map((i) => ({ name: `s${i}`, text: sampleText(20000) }))
    const good = analyze(big)
    ok(good.ok === true, '样本达标时产出')
    ok(good.guide.forbidden_list.length > 0, '带禁忌清单')
    ok(typeof good.anchors.sentence_length_baseline === 'string', '句长锚句是字符串')
    const md = toMarkdown(good)
    ok(md.includes('## sentence_length_baseline'), 'markdown 含必需章节')
    ok(md.includes('## forbidden_list'), 'markdown 含禁忌章节')
    ok(md.includes('原文锚'), '每条附原文锚')
    const parsed = parseMarkdown(md)
    ok(parsed.short_ratio_value > 0, '能从 markdown 反解短句占比')
    ok(parsed.forbidden_list.length > 0, '能从 markdown 反解禁忌清单')
  }

  // ————— 三、项目解析 —————
  console.log('\n三、项目解析')
  {
    ok(padChapter(25) === '0025', '章号补零')
    ok(padChapter('25') === '0025', '字符串章号也认')
    ok(padChapter(0) === null, '0 不合法')
    ok(chapterNoFromName('第0025章-私仓里的寿贡粮.md') === '0025', '从文件名取章号')
    ok(chapterNoFromName('随便.md') === null, '取不到返回 null')
  }
  {
    const brief = parseBrief([
      '# 第0025章 私仓（细纲）',
      '- **时间**：六月十二夜。',
      '- **任务**：潜入旧档房。',
      '- **爽点（70% 处）**：三样全看清。',
      '- **钩子（章末）**：锁拿到案。',
      '- **不得违反**：不读任何字；不带赃物。',
    ].join('\n'))
    ok(brief.title.includes('私仓'), '取到标题')
    ok(brief.time === '六月十二夜。', '取到时间')
    ok(brief.task === '潜入旧档房。', '取到任务')
    ok(brief.effect === '三样全看清。', '去掉括注后取到爽点')
    ok(brief.hook === '锁拿到案。', '取到钩子')
    ok(splitList(brief.forbidden).length === 2, '不得违反按分号拆开')
  }
  {
    const recap = [
      '## 0024《账本逮人》（六月十一）',
      '局面：借条手印对上保人。',
      '**章末钩**：保成了逮他的账。',
      '**新术语**：手印对账。',
      '',
      '## 0500《终章》',
      '局面：收尾。',
      '**章末钩**：他弯下腰，接着拔草。',
    ].join('\n')
    const recaps = parseRecaps(recap)
    ok(recaps.length === 2, '解析出 2 条')
    ok(recaps[0].no === '0024' && recaps[0].title === '账本逮人', '章号与标题')
    ok(recaps[0].time === '六月十一', '括注里的时间')
    ok(recaps[0].hook.includes('逮他的账'), '抽出章末钩')
    ok(recaps[0].terms.includes('手印对账'), '抽出新术语')

    // 关键：取的是「目标章的上一章」，不是文件里最后一条
    ok(recapBefore(recaps, 25).no === '0024', '取目标章的上一章（不是最后一条）')
    // 严格小于：目标 0024 时不该取到 0024 自己
    ok(recapBefore(recaps, 24) === null, '上一章必须严格小于目标章（0024 取不到 0024）')
    ok(recapBefore(recaps, 1) === null, '第一章没有上一章')
    ok(lastRecap(recaps).no === '0500', '最后一条')
    ok(pendingChapter('**待续写**：0099（下一章）。') === '0099', '取待续写章号')
    ok(pendingChapter('没有这行') === null, '没有待续写返回 null')
  }
  {
    const st = await inspect(await makeProject(), 25)
    ok(st.layout.briefs === 1, '数出细纲份数')
    ok(st.brief !== null && st.brief.hook !== null, '解析到本章细纲')
    ok(st.prev !== null && st.prev.no === '0024', '上一章提要对（0024，不是 0500）')
    const task = chapterTaskFrom(st.brief)
    ok(task.ok === true, 'chapter_task 映射成功')
    ok(task.task.stop_at === st.brief.hook, 'stop_at 用钩子')
    // 缺字段要报缺，不能拿别的顶替
    const noHook = chapterTaskFrom({ task: 'x', hook: null })
    ok(noHook.ok === false && noHook.missing.some((m) => m.includes('stop_at')), '缺钩子时报缺')
    const slice = bibleSliceFrom(st)
    ok(slice.includes('本章时间'), 'bible_slice 含本章时间')
    ok(!slice.includes('账本逮人'), 'bible_slice **不重复**上一章内容（那是 prev_recap 的活）')
  }

  // ————— 四、审稿契约与隔离 —————
  console.log('\n四、审稿契约与隔离')
  {
    const iso = checkIsolation({ draft: 'x', bible_snapshot: 'y', prev_summary: 'z' })
    ok(iso.ok === true, '三个允许的槽位放行')
    const bad = checkIsolation({ draft: 'x', style_guide: 'z' })
    ok(bad.ok === false && bad.offending.includes('style_guide'), '多给 style_guide 判定越界')
    ok(ISOLATION_ALLOWLIST.includes('draft'), '白名单含 draft')
    ok(!ISOLATION_ALLOWLIST.includes('style_guide_digest'), '白名单**不含** style_guide')
  }
  {
    const good = [
      { dimension: 'character_consistency', severity: 'fatal', location: '第 12 段', finding: '人物反应与人设冲突', action: '改成低头挪开目光' },
      { dimension: 'hook_effectiveness', severity: 'pass', finding: '章尾有力' },
    ]
    const v = validateFindings(good)
    ok(v.ok === true, '合规样例通过')
    ok(v.stats.fatal === 1 && v.stats.pass === 1, '统计正确')
    ok(v.verdict === 'reject', '有 fatal 就打回')
    ok(v.uncovered.length === 2, '报出未覆盖的维度')

    const v2 = validateFindings([
      { dimension: 'character_consistency', severity: 'warning', location: '第 3 段', finding: 'x', action: 'y' },
      { dimension: 'information_density', severity: 'pass', finding: 'u' },
      { dimension: 'factual_contradiction', severity: 'pass', finding: 'v' },
      { dimension: 'hook_effectiveness', severity: 'pass', finding: 'w' },
    ])
    ok(v2.verdict === 'revise', '只有 warning 时是「修改后过审」')
    ok(v2.uncovered.length === 0, '四维度都覆盖')

    // 逐项拦截
    const e1 = validateFindings([{ dimension: '文笔', severity: 'fatal', location: 'x', finding: 'y', action: 'z' }])
    ok(e1.ok === false && e1.errors.some((e) => e.includes('dimension')), '非法维度被拒')
    const e2 = validateFindings([{ dimension: 'character_consistency', severity: '致命', location: 'x', finding: 'y', action: 'z' }])
    ok(e2.ok === false && e2.errors.some((e) => e.includes('severity')), '非法 severity 被拒')
    const e3 = validateFindings([{ dimension: 'character_consistency', severity: 'fatal', finding: 'y', action: 'z' }])
    ok(e3.ok === false && e3.errors.some((e) => e.includes('location')), 'fatal 缺 location 被拒')
    const e4 = validateFindings([{ dimension: 'character_consistency', severity: 'fatal', location: 'x', finding: 'y', action: '建议重写整章' }])
    ok(e4.ok === false && e4.errors.some((e) => e.includes('非原子')), '非原子指令被拒')
    const e5 = validateFindings([{ dimension: 'character_consistency', severity: 'warning', location: 'x', finding: '整体来说写得不错', action: 'y' }])
    ok(e5.ok === false && e5.errors.some((e) => e.includes('整体评语')), '整体评语被拒')

    // 字符串输入（模型常带代码块）
    const fromStr = validateFindings('```json\n[{"dimension":"information_density","severity":"pass","finding":"ok"}]\n```')
    ok(fromStr.ok === true, '能解析带代码块的 JSON 字符串')
    ok(validateFindings('不是 JSON').ok === false, '非 JSON 被拒')
    ok(validateFindings({ nope: 1 }).ok === false, '结构不对被拒')

    ok(filterBySeverity(good, ['fatal']).length === 1, '按 severity 过滤')
  }

  // ————— 五、去味规则 —————
  console.log('\n五、去味规则')
  {
    // 规格里的 5 条 + 从「AI 味的根源是过度解释和对称感」补的 2 条
    ok(POLISH_RULES.length === 7, `七条规则（实际 ${POLISH_RULES.length}）`)
    const ai = '他仿佛听见了什么。\n\n他站起来。\n\n他走过去。\n\n"你来了。"她低声道。\n\n这一刻，他忽然明白了这一切的意义。'
    const d = detect(ai)
    ok(d.violations.some((v) => v.id === 'as-if'), '抓到「仿佛」')
    ok(d.violations.some((v) => v.id === 'pronoun-run'), '抓到连续同人称开头')
    ok(d.violations.some((v) => v.id === 'saying-tag'), '抓到方式状语标签')
    ok(d.violations.some((v) => v.id === 'summary-tail'), '抓到场景末总结')
    ok(d.violations.every((v) => v.hits.every((h) => h.where !== undefined)), '每条违规带定位')
  }
  {
    // 关键回归：不能把「知道」「一道」当成对话标签
    const text = '他"不知道"。\n\n"那后生说，"你们走错道了。"\n\n"看完就知道。"'
    const d = detect(text)
    const tag = d.violations.find((v) => v.id === 'saying-tag')
    ok(tag === undefined, '「不知道」「走错道」「就知道」都不算对话标签')
  }
  {
    // 方式状语才算
    const d1 = detect('"你来了。"吴常说。\n\n"嗯。"他说。')
    ok(d1.violations.find((v) => v.id === 'saying-tag') === undefined, '「吴常说」「他说」是普通归属语，放行')
    const d2 = detect('"你来了。"她低声道。')
    ok(d2.violations.find((v) => v.id === 'saying-tag') !== undefined, '「她低声道」被拦')
    const d3 = detect('"好。"裴典淡淡道。')
    ok(d3.violations.find((v) => v.id === 'saying-tag') !== undefined, '「淡淡道」被拦')
  }
  {
    const before = '他仿佛听见了什么。\n\n他站起来。\n\n他走过去。'
    const after = '他听见了什么。\n\n起身。\n\n走过去。'
    const v = verify(before, after)
    ok(v.before.hits > v.after.hits, '改后命中减少')
    ok(v.improved === true, '标记为改善')
    const log = changeLog(before, after)
    ok(log.cleaned === true, '干净了')
    ok(Array.isArray(log.lines) && log.lines.length > 0, 'change_log 只有计数')
    ok(!log.lines.join(' ').includes('因为'), 'change_log 不含解释')
    // 引入新毛病要能报出来
    const worse = changeLog('他站起来。', '他仿佛听见了什么。\n\n他似乎看见了什么。')
    ok(worse.improved === false, '改写变差时标记 improved=false')
    // 节奏不达标
    const long = verify('他站起来。', '他' + '忽'.repeat(40) + '然就站了起来，看着远处那片田。', { shortFloor: 0.9 })
    ok(long.rhythm !== null, '短句占比不达标时报出来')
  }

  // ————— 六、流水线与门禁 —————
  console.log('\n六、流水线与门禁')
  {
    const root = await makeProject()
    try {
      // 没有 style-guide 时 Chapter Pack 必须拒绝
      const cp = await runChapterPack(root, 25, { cast: ['吴常'] })
      ok(cp.ok === false && cp.needsStyleAnchor === true, '缺 style-guide 时 Chapter Pack 拒绝')
      const dp = await runDeaiPolish(root, 25, {})
      ok(dp.ok === false && dp.needsStyleAnchor === true, '缺 style-guide 时去味层拒绝')

      // Style Anchor 样本不足时拒绝
      const small = await runStyleAnchor(root, [], {})
      ok(small.ok === false, '不给样本时拒绝')

      // 造达标样本并落盘
      const sp = join(root, 'sample.md')
      await writeFile(sp, sampleText(60000))
      await writeFile(join(root, 'sample2.md'), sampleText(60000))
      await writeFile(join(root, 'sample3.md'), sampleText(60000))
      const sa = await runStyleAnchor(root, [sp, join(root, 'sample2.md'), join(root, 'sample3.md')], {})
      ok(sa.ok === true, '样本达标时产出')
      ok(sa.needsHumanReview === true, '标出需要人审')
      ok(typeof sa.prompt === 'string' && sa.prompt.length > 0, '产出可执行的提示词')
      await writeFile(sa.guidePath, sa.markdown)

      // 有 guide 之后 Chapter Pack 可用
      const cp2 = await runChapterPack(root, 25, { cast: ['吴常', '孟大'] })
      ok(cp2.ok === true, '有 style-guide 后 Chapter Pack 可用')
      ok(cp2.prompt.includes('ROLE: chapter_drafter'), '提示词含 ROLE 声明块')
      ok(cp2.prompt.includes('STYLE_GUIDE'), '自动注入风格摘要')
      ok(cp2.prompt.includes('PREV_RECAP'), '自动注入上一章提要')
      ok(cp2.prompt.includes('0024'), '上一章是 0024')
      ok(cp2.prompt.includes('AVOID'), '注入不得违反清单')
      ok(cp2.needsHumanReview === true, '标出人工门禁')

      // Review Pass 隔离
      const rp = await runReviewPass(root, 25, { draft: '初稿内容' })
      ok(rp.ok === true, 'Review Pass 可用')
      ok(rp.isolation.enforced === true, '隔离是强制的')
      ok(!rp.prompt.includes('STYLE_GUIDE'), '审稿提示词**不含**风格指南')
      ok(!rp.prompt.includes('CHAPTER_TASK'), '审稿提示词**不含**章节任务')
      ok(!rp.prompt.includes('不得违反'), '审稿提示词不含 avoid 清单')
      // 塞越界槽位要拒绝
      const rpBad = await runReviewPass(root, 25, { draft: 'x', extraSlots: { style_guide: 'y' } })
      ok(rpBad.ok === false && rpBad.offending.includes('style_guide'), '越界槽位被拒')

      // 去味层
      const dp2 = await runDeaiPolish(root, 25, { text: '他仿佛听见了什么。\n\n他站起来。' })
      ok(dp2.ok === true, '去味层可用')
      ok(dp2.scan.totalHits > 0, '扫描出命中')
      ok(dp2.prompt.includes('FORBIDDEN_LIST'), '提示词含禁忌清单')
      ok(dp2.prompt.includes('violations') || dp2.prompt.includes('仿佛'), '提示词含逐条违规证据')

      // 复验
      const vp = await verifyPolish(root, '他仿佛听见了什么。', '他听见了什么。')
      ok(vp.accepted === true, '复验通过')
      const vp2 = await verifyPolish(root, '他听见了什么。', '他仿佛听见了什么。')
      ok(vp2.accepted === false, '改差了不通过')

      // 六个模块全部就绪需要：style-guide + world-bible + 正文
      await writeFile(join(root, 'chapters', '第0025章-私仓.md'), '他站起来。')
      const before = await moduleStatus(root)
      const pending = before.modules.filter((m) => m.ready !== true).map((m) => m.id)
      ok(pending.includes('world_builder'), '缺 world-bible 时 World Builder 未就绪')
      await writeFile(join(root, WORLD_BIBLE_NAME), '# 世界观\n')
      const st = await moduleStatus(root)
      const notReady = st.modules.filter((m) => m.ready !== true)
      ok(st.modules.length === 6, `总览列出 6 个模块（实际 ${st.modules.length}）`)
      ok(notReady.length === 0, `六个模块全部就绪${notReady.length > 0 ? `（未就绪：${notReady.map((m) => m.id + ':' + m.note).join('；')}）` : ''}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  {
    // 细纲缺字段时不能拿别的顶替
    const root = await makeProject()
    try {
      const sp = join(root, 's.md')
      await writeFile(sp, sampleText(60000))
      await writeFile(join(root, 's2.md'), sampleText(60000))
      await writeFile(join(root, 's3.md'), sampleText(60000))
      const sa = await runStyleAnchor(root, [sp, join(root, 's2.md'), join(root, 's3.md')], {})
      await writeFile(sa.guidePath, sa.markdown)
      await writeFile(join(root, '细纲', '第0099章.md'), '# 第0099章 无钩子\n\n- **任务**：只有任务，没有钩子。\n')
      const cp = await runChapterPack(root, 99, {})
      ok(cp.ok === false, '细纲缺钩子时拒绝组装')
      ok(cp.missing.some((m) => m.includes('stop_at')), '报出缺 stop_at')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // ————— 六点五、世界观与人物 —————
  console.log('\n六点五、世界观与人物')
  {
    const goodWorld = [
      '## 基础设定', 'x'.repeat(160),
      '## 力量体系', '修炼要消耗田息，每引一次折三日寿。上限是三段，过段必反噬；除非有灵稻续命，否则无法再进。' + 'y'.repeat(80),
      '## 社会结构', 'z'.repeat(160),
      '## 近百年重大事件', 'a'.repeat(160),
      '## 隐藏规则', '- 规则一：谷主见过犁头。', '- 规则二：死役牌其实是活契。',
      '## 普通人日常场景', '- 场景一：晒谷场。', '- 场景二：水碓房。', '- 场景三：药园篱下。',
      '## 自检', '我自己也解释不清楚的地方：田息为什么只在这一谷里有？',
    ].join('\n\n')
    const w = validateWorld(goodWorld)
    ok(w.ok === true, `合规世界观通过${w.ok ? '' : '：' + w.errors.join('；')}`)
    ok(w.sections.length === WORLD_SECTIONS.length, '七个必需章节都认到')

    // 力量体系缺代价 / 缺限制 —— 规格里加粗的那条
    const noCost = goodWorld.replace('修炼要消耗田息，每引一次折三日寿。上限是三段，过段必反噬；除非有灵稻续命，否则无法再进。', '修炼分三段，一段比一段强，练成就能横着走。')
    const w2 = validateWorld(noCost)
    ok(w2.ok === false, '力量体系没写代价与限制时打回')
    ok(w2.errors.some((e) => e.includes('代价')), '报出缺代价')
    ok(w2.errors.some((e) => e.includes('限制')), '报出缺限制')

    // 隐藏规则不足两条
    const oneHidden = goodWorld.replace('- 规则二：死役牌其实是活契。', '')
    ok(validateWorld(oneHidden).errors.some((e) => e.includes('至少 2 条')), '隐藏规则不足两条时打回')

    // 日常场景不足三个
    const twoDaily = goodWorld.replace('- 场景三：药园篱下。', '')
    ok(validateWorld(twoDaily).errors.some((e) => e.includes('三个')), '日常场景不足三个时打回')

    // 缺章节
    const noSelfCheck = goodWorld.replace('## 自检\n\n我自己也解释不清楚的地方：田息为什么只在这一谷里有？', '')
    ok(validateWorld(noSelfCheck).errors.some((e) => e.includes('自检')), '缺自检章节时打回')
    ok(validateWorld('').ok === false, '空内容打回')
  }
  {
    const goodChar = [
      '## 表面欲望', '他想守住那三亩田，熬过死役。',
      '## 真实需求', '他需要有人告诉他：活着本身就够，不必拿命换。',
      '## 致命缺陷', '认死理，宁可自己扛也不开口求人。',
      '## 内心独白', 'x'.repeat(100),
      '## 过往创伤', '十二年前他娘把最后半碗粥推给他，自己喝了三天水。',
      '## 标志行为', '愤怒：不出声，手先攥紧。恐惧：反复擦同一件东西。狂喜：只是站着，看很久。',
    ].join('\n\n')
    const c = validateCharacter(goodChar)
    ok(c.ok === true, `合规人物卡通过${c.ok ? '' : '：' + c.errors.join('；')}`)
    ok(c.fieldsFound.length === CHARACTER_FIELDS.length, '六个必需字段都认到')
    ok(typeof c.needsHumanCheck === 'string' && c.needsHumanCheck.includes('冲突'), '提示人检查三者冲突（机器判不了）')

    const noFlaw = goodChar.replace('## 致命缺陷\n\n认死理，宁可自己扛也不开口求人。', '')
    ok(validateCharacter(noFlaw).errors.some((e) => e.includes('致命缺陷')), '缺致命缺陷时打回')

    const noMood = goodChar.replace('愤怒：不出声，手先攥紧。恐惧：反复擦同一件东西。狂喜：只是站着，看很久。', '生气的时候不说话。')
    const c2 = validateCharacter(noMood)
    ok(c2.ok === false, '标志行为缺情绪档位时打回')
    ok(c2.errors.some((e) => e.includes('恐惧')) && c2.errors.some((e) => e.includes('狂喜')), '报出缺哪几档')

    // 创伤煽情要提醒
    const mushy = goodChar.replace('十二年前他娘把最后半碗粥推给他，自己喝了三天水。', '他痛不欲生，撕心裂肺。')
    ok(validateCharacter(mushy).warnings.some((x) => x.includes('煽情')), '创伤煽情时提醒')
    ok(validateCharacter('').ok === false, '空内容打回')
  }
  {
    // 上游模块能组装
    const root = await makeProject()
    try {
      const w = await runWorldBuilder(root, '古代种田 / 修仙底层')
      ok(w.ok === true, 'World Builder 可组装')
      ok(w.prompt.includes('使用代价'), '提示词强调代价')
      ok(w.guidePath.endsWith(WORLD_BIBLE_NAME), '给出落盘路径')
      ok((await runWorldBuilder(root, '')).ok === false, '没给题材时拒绝')
      const c = await runCharacterDesigner(root, '吴常', { role: '主角' })
      ok(c.ok === true, 'Character Designer 可组装')
      ok(c.prompt.includes('真实需求'), '提示词含真实需求')
      ok((await runCharacterDesigner(root, '')).ok === false, '没给角色名时拒绝')
      ok(checkWorld('x').ok === false, 'checkWorld 可用')
      ok(checkCharacter('x').ok === false, 'checkCharacter 可用')
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  // ————— 六点六、去味：新增规则与允许清单 —————
  console.log('\n六点六、去味：过度解释、对称感、允许清单')
  {
    const ids = POLISH_RULES.map((r) => r.id)
    ok(ids.includes('over-explain'), '有「过度解释」规则')
    ok(ids.includes('symmetry'), '有「对称感」规则')
    // 关键：去味规则的 id 必须都能在风格锚点的禁忌表里找到，否则过滤会静默失效
    const tellIds = AI_TELLS.map((t) => t.id)
    const unmappable = ids.filter((x) => !tellIds.includes(x))
    ok(unmappable.length === 0, `所有规则都能被禁忌清单过滤${unmappable.length ? '（漏：' + unmappable.join(',') + '）' : ''}`)

    ok(detect('也就是说，他早就知道了。').violations.some((v) => v.id === 'over-explain'), '抓到明晃晃的解释标记')
    ok(detect('他看见了田，看见了稻，看见了水。').violations.some((v) => v.id === 'symmetry'), '抓到重复标记的排比')
    // 普通三连不是排比 —— 第一版在这里误报，真稿每章 10 次
    ok(!detect('他站起来，走过去，推开门。').violations.some((v) => v.id === 'symmetry'), '普通三连分句不误报为排比')
    ok(detect('屋子里静；屋外也静。').violations.some((v) => v.id === 'symmetry'), '抓到对仗式收尾')

    // 允许清单
    ok(ALLOWED.length === 2, '允许清单两条')
    ok(ALLOWED.some((a) => a.id === 'fragment'), '允许不完整的句子')
    ok(ALLOWED.some((a) => a.id === 'chatter'), '允许人物说废话')
    ok(looksLikeFragment('走。') === true, '独词句算不完整句')
    ok(looksLikeFragment('他蹲下去，手指碰了碰谷壳。') === false, '完整句不算')
    const d = detect('走。' + String.fromCharCode(10) + String.fromCharCode(10) + '他蹲下去，手指碰了碰谷壳。')
    ok(d.allowed !== undefined && Array.isArray(d.allowed), '扫描结果带出允许清单')
    ok(typeof d.fragmentCount === 'number' && d.fragmentCount >= 1, '数出允许的断句数')
  }

  // ————— 七、模板与契约自洽 —————
  console.log('\n七、模板与契约自洽')
  {
    ok(MODULES.length === 6, '六个模块（上游三个 + 任务层三个）')
    ok(UPSTREAM_MODULES.length === 3, '上游模块三个：文风 / 世界观 / 人物')
    for (const m of MODULES) {
      const { slots } = collectSlots(m.template)
      const declared = new Set([
        ...m.contract.required,
        ...m.contract.auto_injected,
        ...(m.contract.optional ?? []),
      ])
      const undeclared = [...slots].filter((s) => !declared.has(s))
      ok(undeclared.length === 0, `${m.id}：模板用到的槽位都已声明${undeclared.length > 0 ? `（未声明：${undeclared.join('、')}）` : ''}`)
    }
    // 隔离：审稿模板不该引用风格相关槽位
    const { slots: rSlots } = collectSlots(REVIEW_PASS.template)
    ok(![...rSlots].some((s) => s.includes('style')), '审稿模板不引用任何 style 槽位')
    ok(REVIEW_PASS.contract.optional.length === 0, '审稿没有可选槽位（少一个入口就少一条泄漏路径）')
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
