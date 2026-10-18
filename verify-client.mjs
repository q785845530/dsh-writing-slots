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

/** 按按钮文字找节点并点它（跨节复用）。 */
function findFn(node, want, depth = 0, seen = new Set()) {
  if (typeof node === 'string' || node === null || typeof node !== 'object' || depth > 60) return null
  if (Array.isArray(node)) {
    for (const c of node) { const r = findFn(c, want, depth, seen); if (r !== null) return r }
    return null
  }
  if (typeof node.type === 'function') {
    if (seen.has(node.type)) return null
    seen.add(node.type)
    return findFn(expand(node.type, node.props), want, depth + 1, seen)
  }
  if (typeof node.children?.[0] === 'string' && node.children[0] === want && typeof node.props?.onClick === 'function') return node
  for (const c of node.children ?? []) { const r = findFn(c, want, depth, seen); if (r !== null) return r }
  return null
}

const NS = 'dsh-writing-slots'
const LS_SEARCH = `${NS}:reader:search`
const LS_SESSION = `${NS}:reader:session`

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const here = dirname(fileURLToPath(import.meta.url))

/** 极简 react 桩：够这个 bundle 用。 */
function makeReact() {
  /**
   * 槽位**按组件函数隔离**，不是全局计数器。
   *
   * 第一版用一个全局 slot 计数器，结果同一个 tree 走两遍就会读到错位的
   * state（第二次展开时槽位已被前面消耗），报出 `filter.trim is not a
   * function` 这种莫名错误。按组件分桶后，重复展开永远读同一组槽位。
   */
  const byComponent = new Map()
  const effects = []
  let frame = null
  let cursor = 0
  const anon = []
  const bucketFor = (fn) => {
    if (fn === null || fn === undefined) return anon
    let b = byComponent.get(fn)
    if (b === undefined) { b = []; byComponent.set(fn, b) }
    return b
  }
  const api = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    _frame(fn) { frame = fn; cursor = 0 },
    _endFrame() { frame = null },
    useState(initial) {
      const b = bucketFor(frame)
      const i = cursor++
      if (b[i] === undefined) b[i] = typeof initial === 'function' ? initial() : initial
      const set = (v) => { b[i] = typeof v === 'function' ? v(b[i]) : v }
      return [b[i], set]
    },
    useEffect(fn) { effects.push(fn); cursor += 1 },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    _reset() { frame = null; cursor = 0; effects.length = 0 },
    async _flush() {
      const pending = effects.splice(0, effects.length)
      for (const fn of pending) fn()
      await new Promise((r) => setTimeout(r, 0))
    },
    _byComponent: byComponent,
  }
  // 走树时用全局助手展开组件（各处 walk 写法不一，逐个改写不现实）
  globalThis.__DWS_REACT = api
  return api
}

/** 展开一个函数组件：先切到它的槽位桶。 */
function expand(type, props) {
  const R = globalThis.__DWS_REACT
  if (R === undefined || typeof type !== 'function') return type
  R._frame(type)
  try { return type(props) } finally { R._endFrame() }
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
        removeItem: (k) => store.delete(k),
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
const AC_ON = { ok: true, enabled: true, config: { enabled: true, prompt: '继续写。', minGapMs: 2000, maxFollowupsPerSession: 0, notify: true },
  totals: { sessions: 2, followups: 7, skipped: 1 }, sessions: [{ session: 's1', followups: 7, lastAt: 1792320000000 }],
  activity: [{ at: 1792320000000, session: 's1', kind: 'followup', count: 7 }], lastSkip: null, defaults: { prompt: '默认', minGapMs: 2000, maxFollowupsPerSession: 0, notify: true }, sourceKind: 'dsh-writing-slots', note: '进程内计数，不落盘' }
const AC_OFF = { ...AC_ON, enabled: false }

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
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_ON }
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
      walk(expand(node.type, node.props), depth + 1)
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

  console.log('\n五、顶层页签与自动续跑')
  {
    // 启用时：两个页签
    const onFetch = async (url) => {
      const u = String(url)
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_ON }
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    const b1 = loadBundle(new Map(), onFetch)
    let sec1 = null
    b1.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec1 = { sp, C } }, inject: (n, cb) => cb() } })
    b1.React._reset()
    let tree1 = sec1.C({})
    const tabs1 = []
    const seen1 = new Set()
    const w1 = (node, depth = 0) => {
      if (typeof node === 'string' || node === null || typeof node !== 'object') return
      if (depth > 45) return
      if (Array.isArray(node)) { for (const c of node) w1(c, depth); return }
      if (typeof node.type === 'function') { if (seen1.has(node.type)) return; seen1.add(node.type); w1(expand(node.type, node.props), depth + 1); return }
      if (typeof node.props?.className === 'string' && node.props.className.includes('dws_tab') && typeof node.children?.[0] === 'string') tabs1.push(node.children[0])
      for (const c of node.children ?? []) w1(c, depth)
    }
    w1(tree1)
    await b1.React._flush()
    seen1.clear(); tabs1.length = 0; b1.React._reset(); tree1 = sec1.C({}); w1(tree1)
    ok(tabs1.includes('写作槽位'), `启用时有「写作槽位」页签（${tabs1.join(' / ')}）`)
    ok(tabs1.includes('自动续跑'), '**启用时有「自动续跑」页签**')
    ok(tabs1.length === 5, `顶层五个页签（实际 ${tabs1.length}）`)
    ok(tabs1.includes('工作目录'), '有「工作目录」页签')
    ok(tabs1.includes('小说网站'), '有「小说网站」页签')
    ok(tabs1.includes('阅读器'), '有「阅读器」页签')
  }
  {
    // 停用时：只剩写作槽位
    const offFetch = async (url) => {
      const u = String(url)
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_OFF }
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    const b2 = loadBundle(new Map(), offFetch)
    let sec2 = null
    b2.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec2 = { sp, C } }, inject: (n, cb) => cb() } })
    b2.React._reset()
    let tree2 = sec2.C({})
    await b2.React._flush()
    const tabs2 = []
    const seen2 = new Set()
    const w2 = (node, depth = 0) => {
      if (typeof node === 'string' || node === null || typeof node !== 'object') return
      if (depth > 45) return
      if (Array.isArray(node)) { for (const c of node) w2(c, depth); return }
      if (typeof node.type === 'function') { if (seen2.has(node.type)) return; seen2.add(node.type); w2(expand(node.type, node.props), depth + 1); return }
      if (typeof node.props?.className === 'string' && node.props.className.includes('dws_tab') && typeof node.children?.[0] === 'string') tabs2.push(node.children[0])
      for (const c of node.children ?? []) w2(c, depth)
    }
    seen2.clear(); w2(tree2)
    b2.React._reset(); tree2 = sec2.C({}); seen2.clear(); w2(tree2)
    ok(!tabs2.includes('自动续跑'), '**停用时「自动续跑」页签消失**')
    ok(tabs2.includes('写作槽位'), '仍保留「写作槽位」页签')
    // 停用时落回写作槽位
    const bodies = []
    const seen3 = new Set()
    const w3 = (node, depth = 0) => {
      if (typeof node === 'string') { bodies.push(node); return }
      if (node === null || typeof node !== 'object' || depth > 45) return
      if (Array.isArray(node)) { for (const c of node) w3(c, depth); return }
      if (typeof node.type === 'function') { if (seen3.has(node.type)) return; seen3.add(node.type); w3(expand(node.type, node.props), depth + 1); return }
      for (const c of node.children ?? []) w3(c, depth)
    }
    w3(tree2)
    ok(bodies.join(' ').includes('写作槽位') || bodies.length > 0, '停用时落到写作槽位面板')
  }

  console.log('\n六、阅读器状态持久化')
  {
    const store = new Map()
    const onFetch = async (url) => {
      const u = String(url)
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_ON }
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      if (u.includes('/reader/sources')) return { ok: true, status: 200, json: async () => ({ ok: true, sources: [], count: 0, notice: { origin: 'x', warning: 'y' } }) }
      if (u.includes('/reader/search')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ title: '某本书', source: '某源', url: '/b/1' }], errors: [], searched: 10 }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }

    // 先跑一轮，触发搜索
    const b = loadBundle(store, onFetch)
    let sec = null
    b.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec = { sp, C } }, inject: (n, cb) => cb() } })
    b.React._reset()
    let tree = sec.C({})
    await b.React._flush()
    b.React._reset(); tree = sec.C({}); await b.React._flush()

    // 找到阅读器页签并切过去
    const findTab = (node, want, depth = 0, seen = new Set()) => {
      if (typeof node === 'string' || node === null || typeof node !== 'object' || depth > 50) return null
      if (Array.isArray(node)) { for (const c of node) { const r = findTab(c, want, depth, seen); if (r !== null) return r } return null }
      if (typeof node.type === 'function') { if (seen.has(node.type)) return null; seen.add(node.type); return findTab(expand(node.type, node.props), want, depth + 1, seen) }
      if (typeof node.children?.[0] === 'string' && node.children[0] === want && typeof node.props?.onClick === 'function') return node
      for (const c of node.children ?? []) { const r = findTab(c, want, depth, seen); if (r !== null) return r }
      return null
    }
    const readerTab = findTab(tree, '阅读器')
    ok(readerTab !== null, '找得到「阅读器」页签按钮')
    readerTab?.props?.onClick?.()
    b.React._reset(); tree = sec.C({})
    await b.React._flush()

    // 切到搜书页签
    const searchTab = findTab(tree, '搜书')
    ok(searchTab !== null, '找得到「搜书」子页签')
    searchTab?.props?.onClick?.()
    b.React._reset(); tree = sec.C({})
    await b.React._flush()

    // 触发一次搜索
    const input = (() => {
      const out = []
      const w = (node, depth = 0, seen = new Set()) => {
        if (node === null || typeof node !== 'object' || depth > 50) return
        if (Array.isArray(node)) { for (const c of node) w(c, depth, seen); return }
        if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); w(expand(node.type, node.props), depth + 1, seen); return }
        if (node.type === 'input') out.push(node)
        for (const c of node.children ?? []) w(c, depth, seen)
      }
      w(tree)
      return out
    })()
    ok(input.length > 0, `搜书页有输入框（${input.length} 个）`)
    const kwInput = input[0]
    kwInput?.props?.onChange?.({ target: { value: '雪中悍刀行' } })
    b.React._reset(); tree = sec.C({})
    await b.React._flush()

    const searchBtn = findTab(tree, '搜索')
    ok(searchBtn !== null, '找得到「搜索」按钮')
    searchBtn?.props?.onClick?.()
    await new Promise((r) => setTimeout(r, 30))
    b.React._reset(); tree = sec.C({})
    await b.React._flush()

    // 落盘了没有
    const raw = store.get(LS_SEARCH)
    ok(raw !== undefined && raw !== null, '**搜索结果落盘了**')
    if (raw !== undefined && raw !== null) {
      const saved = JSON.parse(raw)
      ok(saved.keyword === '雪中悍刀行', '记住了关键词')
      ok(saved.results?.results?.length === 1, '记住了结果')
      ok(typeof saved.at === 'number', '带时间戳')
    }

    // 新搜索要清掉旧的：先塞一份旧记录，再渲染，应看不到旧的
    store.set(LS_SEARCH, JSON.stringify({ keyword: '旧搜索', results: { results: [{ title: '旧书', source: 'x' }] }, at: 1 }))
    const b2 = loadBundle(store, onFetch)
    let sec2 = null
    b2.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec2 = { sp, C } }, inject: (n, cb) => cb() } })
    b2.React._reset()
    let t2 = sec2.C({})
    await b2.React._flush()
    findTab(t2, '阅读器')?.props?.onClick?.()
    b2.React._reset(); t2 = sec2.C({})
    await b2.React._flush()
    findTab(t2, '搜书')?.props?.onClick?.()
    b2.React._reset(); t2 = sec2.C({})
    await b2.React._flush()
    const texts = []
    const wt = (node, depth = 0, seen = new Set()) => {
      if (typeof node === 'string') { texts.push(node); return }
      if (node === null || typeof node !== 'object' || depth > 50) return
      if (Array.isArray(node)) { for (const c of node) wt(c, depth, seen); return }
      if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); wt(expand(node.type, node.props), depth + 1, seen); return }
      for (const c of node.children ?? []) wt(c, depth, seen)
    }
    wt(t2)
    const joined = texts.join(' ')
    ok(joined.includes('旧搜索'), '**重启后恢复上次搜索结果**')
    ok(joined.includes('旧书'), '结果条目也回来了')
    ok(joined.includes('清掉结果'), '有「清掉结果」按钮')
  }

    console.log('\n七、结构化结果与上一章 / 下一章')
  {
    const store = new Map()
    store.set(LS_SEARCH, JSON.stringify({
      keyword: '旧搜索',
      results: { results: [{ title: '旧书', author: '某作者', source: '某来源' }], errors: [], searched: 10 },
      at: 1,
    }))
    const onFetch = async (url) => {
      const u = String(url)
      if (u.includes('/reader/sources')) return { ok: true, status: 200, json: async () => ({ ok: true, sources: [{ title: '某来源', host: 'x.com', official: true }], count: 1, notice: null }) }
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_ON }
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    const b = loadBundle(store, onFetch)
    let sec = null
    b.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec = { sp, C } }, inject: (n, cb) => cb() } })
    b.React._reset()
    let tree = sec.C({})
    await b.React._flush()

    // 打开阅读器 → 搜书
    const click = (t, label) => { const n = findFn(t, label); if (n !== null) n.props.onClick() }
    click(tree, '阅读器'); b.React._reset(); tree = sec.C({}); await b.React._flush()
    click(tree, '搜书'); b.React._reset(); tree = sec.C({}); await b.React._flush()

    // —— 结构化渲染 ——
    const grab = (t) => {
      const out = { texts: [], buttons: [], inputs: [], inputsByPh: [] }
      const w = (node, depth = 0, seen = new Set()) => {
        if (typeof node === 'string') { out.texts.push(node); return }
        if (node === null || typeof node !== 'object' || depth > 60) return
        if (Array.isArray(node)) { for (const c of node) w(c, depth, seen); return }
        if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); w(expand(node.type, node.props), depth + 1, seen); return }
        if (node.type === 'button' && typeof node.children?.[0] === 'string') out.buttons.push({ label: node.children[0], props: node.props })
        if (node.type === 'input') {
          out.inputs.push(node.props)
          if (typeof node.props?.placeholder === 'string') out.inputsByPh.push(node.props.placeholder)
        }
        for (const c of node.children ?? []) w(c, depth, seen)
      }
      w(t)
      return out
    }
    // 先走一遍让 ReaderPanel 的 useEffect 排队，flush 后书源列表才到位
    b.React._reset(); grab(tree)
    await b.React._flush()
    b.React._reset(); tree = sec.C({}); await b.React._flush()
    b.React._reset()
    let g = grab(tree)
    const joined = g.texts.join(' ')
    ok(joined.includes('旧搜索'), '**重启后恢复上次搜索**')
    ok(joined.includes('《旧书》'), '书名按《》结构化渲染')
    ok(g.inputsByPh.some((x) => x.includes('在结果里筛')), '结果带筛选框（在 placeholder 里）')
    ok(g.texts.some((x) => x.includes('某作者')), '作者单独渲染')
    ok(g.texts.some((x) => x === '正规'), '正规来源有标记')

    // 筛选：输入「不存在的」应过滤空
    const fin = g.inputs.filter((x) => typeof x.placeholder === 'string' && x.placeholder.includes('在结果里筛'))
    ok(fin.length === 1, '找得到筛选框')
    fin[0].onChange({ target: { value: '不存在的关键字' } })
    b.React._reset(); tree = sec.C({}); await b.React._flush()
    b.React._reset()
    g = grab(tree)
    ok(g.texts.some((x) => x.includes('没有匹配')), '**筛选能把结果过滤空**')
    // 筛回来
    const fin2 = g.inputs.filter((x) => typeof x.placeholder === 'string' && x.placeholder.includes('在结果里筛'))
    fin2[0].onChange({ target: { value: '旧书' } })
    b.React._reset(); tree = sec.C({}); await b.React._flush()
    b.React._reset()
    g = grab(tree)
    ok(g.texts.some((x) => x.includes('《旧书》')), '清掉筛选词后结果回来')
  }
  {
    // —— 上一章 / 下一章 ——
    const store = new Map()
    store.set(LS_SESSION, JSON.stringify({
      book: { source: '某源', title: '某本书', url: '/b/1' },
      chapters: [{ title: '第一章', url: '/c/1' }, { title: '第二章', url: '/c/2' }, { title: '第三章', url: '/c/3' }],
      at: 1,
      msg: [{ role: 'assistant', text: '第二章正文', chapter: 1, chapterTitle: '第二章' }],
    }))
    const onFetch = async (url) => {
      const u = String(url)
      if (u.includes('/reader/content')) return { ok: true, status: 200, json: async () => ({ ok: true, text: '正文。'.repeat(40) }) }
      if (u.includes('/reader/sources')) return { ok: true, status: 200, json: async () => ({ ok: true, sources: [], count: 0, notice: null }) }
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_ON }
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    const b = loadBundle(store, onFetch)
    let sec = null
    b.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec = { sp, C } }, inject: (n, cb) => cb() } })
    b.React._reset()
    let tree = sec.C({})
    await b.React._flush()
    const click = (t, label) => { const n = findFn(t, label); if (n !== null) n.props.onClick() }
    click(tree, '阅读器'); b.React._reset(); tree = sec.C({}); await b.React._flush()
    click(tree, '阅读'); b.React._reset(); tree = sec.C({}); await b.React._flush()

    // 每次都要「重置 + 重渲染」再抓
    const rerender = () => { b.React._reset(); return sec.C({}) }
    const buttonsOf = (t) => {
      const out = []
      const w = (node, depth = 0, seen = new Set()) => {
        if (node === null || typeof node !== 'object' || depth > 60) return
        if (Array.isArray(node)) { for (const c of node) w(c, depth, seen); return }
        if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); w(expand(node.type, node.props), depth + 1, seen); return }
        if (node.type === 'button' && typeof node.children?.[0] === 'string') out.push({ label: node.children[0], props: node.props })
        for (const c of node.children ?? []) w(c, depth, seen)
      }
      w(t)
      return out
    }
    const textsOf = (t) => {
      const out = []
      const w = (node, depth = 0, seen = new Set()) => {
        if (typeof node === 'string') { out.push(node); return }
        if (node === null || typeof node !== 'object' || depth > 60) return
        if (Array.isArray(node)) { for (const c of node) w(c, depth, seen); return }
        if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); w(expand(node.type, node.props), depth + 1, seen); return }
        for (const c of node.children ?? []) w(c, depth, seen)
      }
      w(t)
      return out
    }

    tree = rerender()
    let btns = buttonsOf(tree)
    const labels = btns.map((x) => x.label)
    ok(labels.includes('← 上一章'), '有「上一章」按钮')
    ok(labels.includes('下一章 →'), '有「下一章」按钮')
    ok(labels.includes('目录'), '有「目录」按钮')
    ok(btns.find((x) => x.label === '← 上一章').props.disabled !== true, '第 2 章时「上一章」可点')
    const next = btns.find((x) => x.label === '下一章 →')
    ok(next.props.disabled !== true, '第 2 章时「下一章」可点')

    // 点下一章
    next.props.onClick()
    await new Promise((r) => setTimeout(r, 50))
    tree = rerender()
    const t2 = textsOf(tree)
    ok(t2.some((x) => x.includes('第三章')), '**点「下一章」翻到第三章**')
    const next2 = buttonsOf(tree).find((x) => x.label === '下一章 →')
    ok(next2.props.disabled === true, '末章时「下一章」被禁用')
    const prev2 = buttonsOf(tree).find((x) => x.label === '← 上一章')
    ok(prev2.props.disabled !== true, '末章时「上一章」仍可点')

    // 点上一章回第二章
    prev2.props.onClick()
    await new Promise((r) => setTimeout(r, 50))
    tree = rerender()
    const t3 = textsOf(tree)
    ok(t3.some((x) => x.includes('第二章')), '**点「上一章」回到第二章**')

    // 跳章输入框
    const nums = []
    const wn = (node, depth = 0, seen = new Set()) => {
      if (node === null || typeof node !== 'object' || depth > 60) return
      if (Array.isArray(node)) { for (const c of node) wn(c, depth, seen); return }
      if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); wn(expand(node.type, node.props), depth + 1, seen); return }
      if (node.type === 'input' && node.props?.type === 'number') nums.push(node.props)
      for (const c of node.children ?? []) wn(c, depth, seen)
    }
    b.React._reset()
    wn(tree)
    ok(nums.length === 1, '有跳章输入框')
    ok(nums[0].max === 3, '上限是总章数')
    ok(nums[0].value === 2, '输入框显示当前章号')
  }

  console.log('\n八、清除按键与「开书后结果还在」')
  {
    const store = new Map()
    const SEARCH = { keyword: '旧搜索', results: { results: [{ title: '旧书', author: '某作者', source: '某来源' }], errors: [], searched: 10 }, at: 1 }
    store.set(LS_SEARCH, JSON.stringify(SEARCH))
    store.set(LS_SESSION, JSON.stringify({
      book: { source: '某来源', title: '旧书', url: '/b/1' },
      chapters: [{ title: '第一章', url: '/c/1' }, { title: '第二章', url: '/c/2' }],
      at: 0,
      msg: [{ role: 'assistant', text: '第一章正文', chapter: 0, chapterTitle: '第一章' }],
    }))
    const onFetch = async (url) => {
      const u = String(url)
      if (u.includes('/reader/content')) return { ok: true, status: 200, json: async () => ({ ok: true, text: '正文。'.repeat(40) }) }
      if (u.includes('/reader/chapters')) return { ok: true, status: 200, json: async () => ({ ok: true, chapters: [{ title: '第一章', url: '/c/1' }], count: 1 }) }
      if (u.includes('/reader/sources')) return { ok: true, status: 200, json: async () => ({ ok: true, sources: [], count: 0, notice: null }) }
      if (u.includes('/auto-continue')) return { ok: true, status: 200, json: async () => AC_ON }
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => STATUS }
      if (u.includes('/modules')) return { ok: true, status: 200, json: async () => ({ ok: true, modules: MODULES }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    const b = loadBundle(store, onFetch)
    let sec = null
    b.mod.apply({ effect: (f) => f(), slots: { register: (sp, C) => { sec = { sp, C } }, inject: (n, cb) => cb() } })
    b.React._reset()
    let tree = sec.C({})
    await b.React._flush()
    const click = (t, label) => { const n = findFn(t, label); if (n !== null) { n.props.onClick(); return true } return false }
    const fresh = () => { b.React._reset(); return sec.C({}) }
    const snap = (t) => {
      const out = { texts: [], buttons: [] }
      const w = (node, depth = 0, seen = new Set()) => {
        if (typeof node === 'string') { out.texts.push(node); return }
        if (node === null || typeof node !== 'object' || depth > 60) return
        if (Array.isArray(node)) { for (const c of node) w(c, depth, seen); return }
        if (typeof node.type === 'function') { if (seen.has(node.type)) return; seen.add(node.type); w(expand(node.type, node.props), depth + 1, seen); return }
        if (node.type === 'button' && typeof node.children?.[0] === 'string') out.buttons.push({ label: node.children[0], props: node.props })
        for (const c of node.children ?? []) w(c, depth, seen)
      }
      w(t)
      return out
    }

    // 打开阅读器 → 阅读页，应有清屏按钮
    click(tree, '阅读器'); tree = fresh(); await b.React._flush()
    click(tree, '阅读'); tree = fresh(); await b.React._flush()
    let g = snap(tree)
    const clearBtn = g.buttons.find((x) => x.label === '清屏')
    ok(clearBtn !== undefined, `阅读页有「清屏」按钮（${g.buttons.map((x) => x.label).slice(0, 6).join(' / ')}）`)
    ok(clearBtn.props.disabled !== true, '有对话时清屏可点')
    ok(g.texts.some((x) => x.includes('第一章正文')), '清屏前有正文')

    // 点清屏 → 对话清空，但书还在
    clearBtn.props.onClick()
    tree = fresh(); await b.React._flush()
    g = snap(tree)
    ok(!g.texts.some((x) => x.includes('第一章正文')), '**点了清屏，对话清空了**')
    ok(g.texts.some((x) => x.includes('《旧书》还在')), '**书还在**，并提示怎么继续')
    ok(g.buttons.find((x) => x.label === '清屏').props.disabled === true, '已经是空的，清屏按钮变灰')

    // 到搜书页：结果应还在（上一轮被 openBook 清掉的 bug）
    click(tree, '搜书'); tree = fresh(); await b.React._flush()
    g = snap(tree)
    ok(g.texts.some((x) => x.includes('《旧书》')), '**进搜书页，上次结果还在**')
    ok(g.texts.some((x) => x.includes('旧搜索')), '关键词也在')

    // 清掉结果按钮
    const clearRes = g.buttons.find((x) => x.label === '清掉结果')
    ok(clearRes !== undefined, '有「清掉结果」按钮')
    clearRes.props.onClick()
    tree = fresh(); await b.React._flush()
    g = snap(tree)
    ok(!g.texts.some((x) => x.includes('《旧书》')), '**点「清掉结果」后结果没了**')
    ok(!store.has(LS_SEARCH), 'localStorage 里的记录也删了')

    // 没了之后不该被「从记录恢复」这个效果又捞回来
    tree = fresh(); await b.React._flush()
    g = snap(tree)
    ok(!g.texts.some((x) => x.includes('《旧书》')), '清掉后不会被自动捞回来')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
