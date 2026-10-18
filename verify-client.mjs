#!/usr/bin/env node
/**
 * dsh-writing-slots / 浏览器半 自测。
 *
 *   node verify-client.mjs
 *
 * 不依赖真实浏览器：用一个极简的 react 桩把 bundle 渲染一遍。
 * 重点断言：
 *   - bundle 能被 ModuleLoader 捕获，apply 能注册设置页 section；
 *   - 渲染不抛异常（这是最容易坏的地方）；
 *   - 六个模块的卡片都出来；
 *   - 表单/校验区按模块出现；
 *   - 输出渲染函数对「校验结果」与「复验结果」都能成型。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const here = dirname(fileURLToPath(import.meta.url))

/** 极简 react 桩：够这个 bundle 用。 */
function makeReact() {
  const stateSlots = []
  const effects = []
  let slot = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(initial) {
      const i = slot++
      if (stateSlots[i] === undefined) stateSlots[i] = typeof initial === 'function' ? initial() : initial
      const set = (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v }
      return [stateSlots[i], set]
    },
    useEffect(fn) { effects.push(fn); slot += 1 },
    useCallback(fn) { slot += 0; return fn },
    useMemo(fn) { slot += 0; return fn() },
    _reset() { slot = 0; effects.length = 0 },
    async _flush() {
      const pending = effects.splice(0, effects.length)
      for (const fn of pending) fn()
      await new Promise((r) => setTimeout(r, 0))
    },
    _slots: stateSlots,
  }
}

function loadBundle(store, fetchImpl) {
  const src = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
  let captured = null
  const React = makeReact()
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => { captured = spec } },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
      },
    },
    document: {
      createElement: () => ({ setAttribute() {}, set textContent(v) { this._t = v }, get textContent() { return this._t }, parentNode: null }),
      head: { appendChild() {} },
    },
    navigator: {},
    fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    setTimeout, clearTimeout, console,
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require：${name}`)
  }
  const fn = new Function('window', 'document', 'require', 'fetch', 'navigator', 'setTimeout', 'clearTimeout', 'console', src)
  fn(sandbox.window, sandbox.document, require, sandbox.fetch, sandbox.navigator, setTimeout, clearTimeout, console)
  if (captured === null) throw new Error('bundle 没有调用 __ModuleLoader__.load')
  return { mod: captured.factory(require), React, sandbox, store }
}

/** 假数据：与 host 半的返回结构一致。 */
const MODULES = [
  { id: 'style_anchor', title: 'Style Anchor（文风锚点）', runsWhen: '项目初始化时，只跑一次', gate: '人审「这像不像我写的」', output: 'style-guide.md', contract: { required: ['sample_corpus'], auto_injected: ['measurements'], optional: ['genre_tags'] } },
  { id: 'world_builder', title: 'World Builder（世界观）', runsWhen: '项目初始化时', gate: '人审「每个设定是否都有代价和限制」', output: 'world-bible.md', contract: { required: ['genre'], auto_injected: [], optional: [] } },
  { id: 'character_designer', title: 'Character Designer（人物）', runsWhen: '项目初始化时', gate: '人审「三者的冲突是否真的成立」', output: '人物卡', contract: { required: ['character'], auto_injected: [], optional: ['role'] } },
  { id: 'chapter_pack', title: 'Chapter Pack（单章包）', runsWhen: '每章动笔前', gate: '人审章尾钩子和情感落点', output: '初稿正文', contract: { required: ['chapter_no'], auto_injected: ['style_guide_digest'], optional: [] } },
  { id: 'review_pass', title: 'Review Pass（审稿通道）', runsWhen: '初稿完成后，独立会话', gate: '人决定哪些改、哪些不改', output: 'JSON 问题清单', contract: { required: ['draft'], auto_injected: ['bible_snapshot', 'prev_summary'], optional: [] } },
  { id: 'reader_sim', title: 'Reader Simulation（读者通道）', runsWhen: '初稿后，审稿前', gate: '反馈是信息不是命令', output: '三个读者的体温', contract: { required: ['draft'], auto_injected: ['persona_prompt'], optional: [] } },
  { id: 'deai_polish', title: 'De-AI Polish（去味层）', runsWhen: '最后一刀', gate: '人通读', output: '润色稿', contract: { required: ['text'], auto_injected: ['style_guide_forbidden'], optional: [] } },
]
const STATUS = {
  ok: true, project: '/tmp/proj', pending: '0500', layout: { briefs: 197, chapters: 500 },
  modules: MODULES.map((m, i) => ({ id: m.id, ready: i < 3, note: i < 3 ? '就绪了' : '先跑 Style Anchor' })),
}

const main = async () => {
  console.log('一、bundle 与注册')
  let loaded
  try {
    loaded = loadBundle(new Map(), async (url) => {
      const u = String(url)
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    })
  } catch (e) {
    ok(false, `bundle 加载失败：${e.message}`)
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(1)
  }
  const { mod, React } = loaded
  ok(mod.name === 'dsh-writing-slots', `模块名正确（${mod.name}）`)
  ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), '声明注入 slots')
  ok(typeof mod.apply === 'function', '导出 apply')

  let section = null
  const slots = {
    register: (spec, Comp) => { section = { spec, Comp } },
    inject: (name, cb) => cb(),
  }
  let applyErr = null
  try { mod.apply({ effect: (f) => f(), slots }) } catch (e) { applyErr = e }
  ok(applyErr === null, 'apply 不抛异常')
  ok(section !== null, '注册了 settings.section')
  ok(section?.spec?.id === 'writing-slots', 'section id 正确')
  ok(typeof section?.spec?.label === 'function' && section.spec.label() === '写作槽位', 'label 是「写作槽位」')
  ok(section?.spec?.order === 21, 'order 21（排在任务日志之后）')
  ok(typeof section?.Comp === 'function', 'section 有组件')

  console.log('\n二、渲染')
  let tree = null
  let renderErr = null
  try { tree = section.Comp({}) } catch (e) { renderErr = e }
  ok(renderErr === null, '首次渲染不抛异常' + (renderErr === null ? '' : `：${renderErr.message}`))

  const collect = { cards: [], buttons: [], inputs: [], areas: [], cols: 0, texts: [] }
  const seen = new Set()
  const walk = (node, depth = 0) => {
    // 文本要在「不是对象就返回」之前收 —— 否则界面上的说明文字全丢了
    if (typeof node === 'string') { collect.texts.push(node); return }
    if (typeof node === 'number') { collect.texts.push(String(node)); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 45) return
    if (Array.isArray(node)) { for (const c of node) walk(c, depth); return }
    if (typeof node.type === 'function') {
      if (seen.has(node.type)) return
      seen.add(node.type)
      walk(node.type(node.props), depth + 1)
      return
    }
    const cls = node.props?.className
    if (typeof cls === 'string') {
      if (cls.includes('dws_card')) collect.cards.push(node)
      if (cls.includes('dws_col ')) collect.cols += 1
    }
    if (node.type === 'button' && typeof node.children?.[0] === 'string') collect.buttons.push(node.children[0])
    if (node.type === 'input') collect.inputs.push(node.props ?? {})
    if (node.type === 'textarea') collect.areas.push(node.props ?? {})
    for (const c of node.children ?? []) walk(c, depth)
  }
  walk(tree)
  ok(collect.cols >= 2, `渲染出左右两栏（${collect.cols} 个栏容器）`)
  ok(collect.buttons.some((b) => b.includes('刷新')), '有刷新按钮')
  ok(collect.buttons.some((b) => b.includes('生成提示词')), '有「生成提示词」按钮')

  // 跑一遍挂载后的自动加载，再重渲染看数据分支
  await React._flush()
  seen.clear()
  collect.cards.length = 0; collect.buttons.length = 0; collect.inputs.length = 0
  collect.areas.length = 0; collect.cols = 0; collect.texts.length = 0
  React._reset()
  try { tree = section.Comp({}) } catch (e) { renderErr = e }
  ok(renderErr === null, '加载数据后重渲染不抛异常' + (renderErr === null ? '' : `：${renderErr.message}`))
  walk(tree)

  console.log('\n三、六个槽位都出来')
  ok(collect.cards.length === 7, `渲染出 7 张模块卡（实际 ${collect.cards.length}）`)
  const titles = collect.cards.map((c) => JSON.stringify(c)).join(' ')
  for (const m of MODULES) {
    ok(titles.includes(m.id) || titles.includes(m.title), `卡片含 ${m.id}`)
  }
  ok(collect.buttons.some((b) => b.includes('刷新')), '顶部有刷新')

  console.log('\n四、契约与表单')
  // 默认选中 style_anchor：应显示样本路径文本域与体裁输入
  ok(collect.areas.length >= 1, '有文本域（样本路径/校验区）')
  const all = collect.texts.join(' ')
  ok(all.includes('样本') || collect.areas.length > 0, 'Style Anchor 有样本输入')
  ok(all.includes('门禁'), '显示人工门禁')
  ok(all.includes('必填'), '显示必填槽位')
  ok(all.includes('自动注入'), '显示自动注入槽位')
  ok(all.includes('不代跑模型'), '说明这个面板不代跑模型')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
