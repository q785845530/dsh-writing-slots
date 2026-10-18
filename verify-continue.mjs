#!/usr/bin/env node
/**
 * dsh-writing-slots / 自动续跑 自测。
 *
 *   node verify-continue.mjs
 *
 * 这是 @weibaohui/dsh-continue 的移植版，所以测两类：
 *   一、**纯函数与原插件逐字节一致**（默认规则表、失败分类、codes 解析）；
 *   二、**路由决策在各类失败上正确**（限流退避、额度/鉴权止损、上下文压缩、
 *       自定义状态码、规则用尽回落、换模型、去抖、上限）。
 *
 * 外加移植时保留的几条硬约束（通知必带 id/role、停用清定时器、排除子代理）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  makeContinueService, readConfig, sanitizeRule, sanitizePatch,
  reasonKind, classifyFailure, parseCodes, matchesCodes, classToWhen,
  firstMatchingRule, computeBackoff, withinCooldown, isExcluded,
  newSessionState, decideTurnEnd, failureNoticeText,
  DEFAULT_RULES, DEFAULTS, RULE_WHENS, RULE_ACTIONS, WHEN_LABELS, QUOTA_WORDS,
} from './lib/continue.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const here = dirname(fileURLToPath(import.meta.url))
/** 装了原插件就做差分比对；没装就跳过（克隆出来的副本没有它）。 */
function originalInternals() {
  const p = '/home/wsn/.dsh/profiles/web/node_modules/@weibaohui/dsh-continue/src/index.js'
  try {
    const src = readFileSync(p, 'utf8')
    if (src === '') return null
    return null // ESM 动态导入在下面的差分节里单独做
  } catch { return null }
}

function fakeCtx(opts = {}) {
  const handlers = []
  const live = new Map()
  return {
    logger: { info() {}, warn() {} },
    on(type, fn) { handlers.push([type, fn]); return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'agents') return { get: (sid) => live.get(sid) ?? null }
      if (name === 'compaction') return opts.compaction
      if (name === 'llm') return opts.llm
      return undefined
    },
    _emit(session, event) { for (const [t, fn] of handlers) if (t === 'session/event') fn(session, event) },
    _request(payload, next) { for (const [t, fn] of handlers) if (t === 'agent/request') return fn(payload, next); return next() },
    _addLive(sid, sink) { live.set(sid, { followup: (m) => sink.push(m) }) },
  }
}

/** 造一个带 append 记录的会话。 */
function fakeSession(id, appends, header = {}) {
  return { id, header, append: (type, payload, o) => { appends.push({ type, payload, o }); return { unref() {} } } }
}

const main = async () => {
  // ————— 一、纯函数 —————
  console.log('一、纯函数')
  {
    ok(RULE_WHENS.length === 10, `十种失败类型（实际 ${RULE_WHENS.length}）`)
    ok(RULE_ACTIONS.join(',') === 'continue,continue-with,compact,stop', '四种动作')
    ok(DEFAULT_RULES.length === 7, `默认规则 7 条（实际 ${DEFAULT_RULES.length}）`)
    ok(DEFAULT_RULES[0].id === 'r-rate-limit' && DEFAULT_RULES[0].maxAttempts === 5, '限流默认退避 5 次')
    ok(DEFAULT_RULES[1].when === 'quota' && DEFAULT_RULES[1].action === 'stop', '额度默认止损')
    ok(DEFAULT_RULES[3].when === 'context' && DEFAULT_RULES[3].action === 'compact', '上下文默认压缩后续跑')
    ok(DEFAULT_RULES[5].when === 'max-tokens' && DEFAULT_RULES[5].action === 'continue', '输出截断默认继续')
    ok(DEFAULT_RULES[6].when === 'any', '末尾有兜底规则')
    ok(WHEN_LABELS['rate-limit'].includes('429'), '类型有中文说明')

    ok(reasonKind({ kind: 'max-tokens' }) === 'max-tokens', 'reason 是对象')
    ok(reasonKind('max-tokens') === 'max-tokens', 'reason 是裸字符串')
    ok(reasonKind(null) === undefined, 'reason 为 null')
  }
  {
    // 失败分类
    const t = (f, want) => classifyFailure(f).cls === want
    ok(t({ code: 'CONTEXT_WINDOW_EXCEEDED' }, 'context'), '上下文超限码')
    ok(t({ code: 'QUOTA' }, 'quota'), '额度码')
    ok(t({ status: 402 }, 'quota'), '402 归额度')
    ok(t({ status: 429, message: 'insufficient balance' }, 'quota'), '429 + 余额文案归额度')
    ok(t({ status: 429, message: '额度已用尽' }, 'quota'), '中文额度文案也认')
    ok(t({ status: 429, message: 'rate limit' }, 'rate-limit'), '429 无额度文案归限流')
    ok(t({ code: 'RATE_LIMIT' }, 'rate-limit'), '限流码')
    ok(t({ code: 'INVALID_CREDENTIAL' }, 'auth'), '凭证码')
    ok(t({ status: 401 }, 'auth'), '401 归鉴权')
    ok(t({ status: 403 }, 'auth'), '403 归鉴权')
    ok(t({ status: 500 }, 'server'), '5xx 归服务端')
    ok(t({ status: 418 }, 'unknown'), '其他码归 unknown')
    ok(t({ code: 'SOMETHING' }, 'unknown'), '未知机器码归 unknown')
    ok(t(null, 'unknown') && t(undefined, 'unknown') && t('x', 'unknown'), '非对象归 unknown')
    ok(QUOTA_WORDS.includes('余额'), '额度文案表含中文')
  }
  {
    // codes
    const p = parseCodes('529, 520，UNKNOWN')
    ok(p.nums.join(',') === '529,520' && p.strs.join(',') === 'UNKNOWN', '混合解析')
    ok(parseCodes('429').nums[0] === 429, '单个数字')
    ok(parseCodes('999') === null, '超范围数字丢弃 → null')
    ok(parseCodes('99') === null, '越界小数字丢弃 → null')
    ok(parseCodes('abc').strs[0] === 'ABC', '文字码归大写')
    ok(parseCodes('') === null, '空串 → null')
    ok(parseCodes(undefined) === null && parseCodes(123) === null, '非字符串 → null')
    ok(matchesCodes('529', { status: 529 }) === true, '数字匹配 status')
    ok(matchesCodes('529', { status: 500 }) === false, '数字不匹配别的 status')
    ok(matchesCodes('UNKNOWN', { code: 'unknown' }) === true, '文字码大小写不敏感')
    ok(matchesCodes('ABC', { code: 'abc' }) === true, '文字码反向也敏感')
    ok(matchesCodes('529', null) === false, '没有失败对象时不匹配')
  }
  {
    // 规则匹配
    const cls = classifyFailure({ status: 429, message: 'rate limit' })
    ok(firstMatchingRule(DEFAULT_RULES, 'error', cls, {}, { status: 429 }).id === 'r-rate-limit', '限流命中第一条')
    ok(firstMatchingRule(DEFAULT_RULES, 'error', cls, { 'r-rate-limit': 5 }, { status: 429 }).id === 'r-any', '限流用尽后回落到 any')
    ok(firstMatchingRule(DEFAULT_RULES, 'max-tokens', { cls: undefined }, {}, null).id === 'r-max-tokens', 'max-tokens 命中专属规则')
    ok(firstMatchingRule(DEFAULT_RULES, 'interrupted', { cls: undefined }, {}, null).id === 'r-interrupted', '崩溃孤儿轮命中')
    ok(firstMatchingRule([], 'max-tokens', {}, {}, null) === null, '空表返回 null')
    ok(firstMatchingRule(DEFAULT_RULES, 'completed', {}, {}, null) === null, 'completed 不参与匹配')
  }
  {
    // 退避与冷却
    const eff = { backoffBaseMs: 1000, backoffMaxMs: 10000, cooldownMs: 5000 }
    const b0 = computeBackoff(0, eff)
    ok(b0 >= 1000 && b0 <= 1200, `第 0 次退避 1000—1200（实际 ${b0}）`)
    const b3 = computeBackoff(3, eff)
    ok(b3 >= 8000 && b3 <= 10000, `第 3 次退避被上限压到 ≤10000（实际 ${b3}）`)
    // 注意：抖动是**加在 clamp 之后**的（与原插件一致），所以结果上限是 max*1.2。
    // 第一版断言写成 ≤max 是错的 —— 那不是 bug，是抖动的固有语义。
    const huge = computeBackoff(99, eff)
    ok(huge >= 10000 && huge <= 12000, `极大次数被 clamp 到上限，抖动后 ≤1.2×（实际 ${huge}）`)
    // 但绝不会因为 2^99 溢出成 Infinity
    ok(Number.isFinite(huge), '2^99 不会溢出成 Infinity')
    ok(withinCooldown(100000, null, eff) === true, '没续过 → 通过')
    ok(withinCooldown(100000, 99000, eff) === false, '冷却窗口内 → 不通过')
    ok(withinCooldown(100000, 94000, eff) === true, '超出窗口 → 通过')
  }
  {
    ok(isExcluded(null) === true, '没有会话 → 排除')
    ok(isExcluded({ id: 'x', header: { origin: 'subagent' } }) === true, '子代理会话 → 排除')
    ok(isExcluded({ id: 'hermes-loop-review-1', header: {} }) === true, '宿主循环评审 → 排除')
    ok(isExcluded({ id: 's1', header: {} }) === false, '普通会话 → 不排除')
  }
  {
    // 决策表
    const st = (p = {}) => ({ ...newSessionState(), ...p })
    const D = DEFAULTS
    ok(decideTurnEnd(st(), 'completed', D, 0, null).type === 'reset', '正常结束 → 归零')
    ok(decideTurnEnd(st(), undefined, D, 0, null).type === 'noop', '认不出 → noop')
    ok(decideTurnEnd(st(), 'aborted', D, 0, null).type === 'skip', '用户中止 → 跳过（不背着用户继续）')
    ok(decideTurnEnd(st({ compacting: true }), 'error', D, 0, { status: 429 }).reason === 'compacting', '压缩中 → 跳过')
    ok(decideTurnEnd(st({ timer: {} }), 'error', D, 0, { status: 429 }).reason === 'pending', '有挂起 → 跳过')
    ok(decideTurnEnd(st({ attempts: 50 }), 'max-tokens', D, 0, null).type === 'cap', '达全局上限 → cap')
    const quota = decideTurnEnd(st(), 'error', D, 0, { status: 402 })
    ok(quota.type === 'abort-notify' && quota.rule.id === 'r-quota', '额度 → 止损通知')
    const auth = decideTurnEnd(st(), 'error', D, 0, { status: 401 })
    ok(auth.type === 'abort-notify' && auth.rule.id === 'r-auth', '鉴权 → 止损通知')
    const ctxOver = decideTurnEnd(st(), 'error', D, 0, { code: 'CONTEXT_WINDOW_EXCEEDED' })
    ok(ctxOver.type === 'schedule' && ctxOver.compact === true, '上下文超限 → 先压缩')
    const rl = decideTurnEnd(st(), 'error', D, 0, { status: 429, message: 'rate limit' })
    ok(rl.type === 'schedule' && rl.compact === false && rl.rule.id === 'r-rate-limit', '限流 → 直接续跑')

    // 限流尊重服务商给的等待时间
    const wait = decideTurnEnd(st(), 'error', D, 0, { status: 429, message: 'rate limit', providerRetryAfterMs: 60000 })
    ok(wait.delay >= 60000, `尊重 providerRetryAfterMs（实际 ${wait.delay}）`)

    // 冷却窗口内的失败要**推迟**而不是丢弃
    const now = 1000000
    const inCd = decideTurnEnd(st({ lastContinueAt: now - 1000 }), 'error', { ...D, cooldownMs: 5000 }, now, { status: 429, message: 'rate limit' })
    ok(inCd.type === 'schedule', '冷却窗口内仍然排定（不丢弃）')
    ok(inCd.delay >= 4000, `推迟到冷却结束（实际 ${inCd.delay}）`)

    // 自定义状态码规则优先
    const withStatus = [{ id: 'r-529', when: 'status', action: 'stop', codes: '529', maxAttempts: 0 }, ...DEFAULT_RULES]
    const custom = decideTurnEnd(st(), 'error', { ...D, rules: withStatus }, 0, { status: 529 })
    ok(custom.type === 'abort-notify' && custom.rule.id === 'r-529', '自定义状态码规则先命中')

    // 换模型
    const withModel = [{ id: 'r-rl', when: 'rate-limit', action: 'continue-with', provider: 'backup', model: 'm2', maxAttempts: 0 }, ...DEFAULT_RULES]
    const ovr = decideTurnEnd(st(), 'error', { ...D, rules: withModel }, 0, { status: 429, message: 'rate limit' })
    ok(ovr.override?.model === 'm2' && ovr.override?.provider === 'backup', '换模型规则带出 override')
    ok(ovr.override?.via === 'r-rl', 'override 记了来源规则')
  }
  {
    // 规则清洗
    ok(sanitizeRule({ when: 'rate-limit', action: 'continue' }, 0).id !== undefined, '合法规则通过')
    ok(sanitizeRule({ when: 'bogus', action: 'continue' }) === null, '非法 when 被拒')
    ok(sanitizeRule({ when: 'any', action: 'bogus' }) === null, '非法 action 被拒')
    ok(sanitizeRule({ when: 'status', action: 'continue', codes: '' }) === null, 'status 规则没给可解析的码 → 拒')
    ok(sanitizeRule({ when: 'status', action: 'continue', codes: '529' }) !== null, 'status 规则给了码 → 通过')
    ok(sanitizeRule({ when: 'any', action: 'continue-with', model: '' }) === null, '换模型但没给模型 → 拒')
    ok(sanitizeRule({ when: 'any', action: 'continue-with', model: 'm' }) !== null, '换模型给了模型 → 通过')
    const p = sanitizePatch({ prompt: 'x', maxAttempts: 0, cooldownMs: -1, backoffMaxMs: 500, rules: [], extra: 1 })
    ok(p.prompt === 'x', 'prompt 被接受')
    ok(p.maxAttempts === undefined, 'maxAttempts=0 被拒（要 ≥1）')
    ok(p.cooldownMs === undefined, '负冷却被拒')
    ok(p.backoffMaxMs === undefined, '退避上限 <1000 被拒')
    ok(p.rules === undefined, '空规则数组不覆盖现有表')
    ok(p.extra === undefined, '不认识的字段被丢掉')
  }
  {
    const c = readConfig(undefined)
    ok(c.prompt === DEFAULTS.prompt && c.maxAttempts === DEFAULTS.maxAttempts, '缺配置用默认')
    ok(c.rules.length === DEFAULT_RULES.length, '默认规则表')
    const c2 = readConfig({ rules: [{ when: 'any', action: 'continue' }, { when: 'bogus', action: 'x' }] })
    ok(c2.rules.length === 1, '非法规则被过滤掉')
    ok(readConfig({ rules: [] }).rules.length === DEFAULT_RULES.length, '空规则表回退默认')
  }

  // ————— 二、与原插件差分 —————
  console.log('\n二、与原插件差分比对')
  const ORIG = '/home/wsn/.dsh/profiles/web/node_modules/@weibaohui/dsh-continue/src/index.js'
  let orig = null
  try { orig = (await import(ORIG)).default?.__internals ?? null } catch { orig = null }
  if (orig === null) {
    console.log('  （环境里没有原插件，跳过差分；克隆出来的副本会走这一支）')
  } else {
    ok(JSON.stringify(DEFAULT_RULES) === JSON.stringify(orig.DEFAULT_RULES), '默认规则表逐字节一致')
    ok(JSON.stringify(DEFAULTS) === JSON.stringify(orig.DEFAULTS), '默认配置逐字节一致')
    let diff = 0
    for (const f of [{ status: 429, message: '额度不足' }, { status: 402 }, { code: 'QUOTA' }, { status: 500 }, { code: 'X' }, null, {}, 'x']) {
      if (JSON.stringify(classifyFailure(f)) !== JSON.stringify(orig.classifyFailure(f))) diff += 1
    }
    ok(diff === 0, '失败分类在 8 个样例上一致')
    let pdiff = 0
    for (const raw of ['529, 520，UNKNOWN', '429', '999', '', 'abc', undefined]) {
      if (JSON.stringify(parseCodes(raw)) !== JSON.stringify(orig.parseCodes(raw))) pdiff += 1
    }
    ok(pdiff === 0, 'codes 解析在 6 个样例上一致')

    // 决策差分
    const scenarios = [
      ['completed', {}], ['aborted', {}], ['max-tokens', {}], ['interrupted', {}],
      ['error', {}, { status: 429, message: 'rate limit' }],
      ['error', {}, { status: 402 }], ['error', {}, { status: 401 }],
      ['error', {}, { code: 'CONTEXT_WINDOW_EXCEEDED' }], ['error', {}, { status: 500 }],
      ['error', { ruleAttempts: { 'r-rate-limit': 5 } }, { status: 429, message: 'rate limit' }],
      ['max-tokens', { attempts: 50 }, null],
    ]
    let ddiff = 0
    for (const [kind, patch, failure] of scenarios) {
      const norm = (a) => { const c = { ...a }; delete c.delay; if (c.rule) c.rule = c.rule.id; if (c.cls) c.cls = { ...c.cls }; return JSON.stringify(c) }
      const a = norm(decideTurnEnd({ ...newSessionState(), ...patch }, kind, DEFAULTS, 1e6, failure))
      const b = norm(orig.decideTurnEnd({ ...orig.newSessionState(), ...patch }, kind, orig.DEFAULTS, 1e6, failure))
      if (a !== b) { ddiff += 1; console.log('    差异:', kind, JSON.stringify(failure), '\n      我:', a, '\n      原:', b) }
    }
    ok(ddiff === 0, `路由决策在 ${scenarios.length} 个场景上一致`)
  }

  // ————— 三、服务行为 —————
  console.log('\n三、服务行为')
  {
    const ctx = fakeCtx()
    const sent = []
    ctx._addLive('s1', sent)
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0, backoffBaseMs: 0, backoffMaxMs: 0 } })
    svc.install()

    ctx._emit({ id: 's1', header: {} }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 40))
    ok(sent.length === 1, 'max-tokens 触发一次续跑')
    ok(sent[0].source.kind === 'dsh-writing-slots', 'source.kind 是自有 kind')
    ok(sent[0].role === 'user' && typeof sent[0].id === 'string', '带 role 与 id')
    ok(sent[0].content[0].text === DEFAULTS.prompt, '注入默认文本')

    // 正常结束归零
    ctx._emit({ id: 's1', header: {} }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    ok(svc.status().sessions[0].attempts === 0, '正常结束把计数归零')
  }
  {
    // 额度失败 → 止损通知，不续跑
    const ctx = fakeCtx()
    const sent = []
    ctx._addLive('q1', sent)
    const appends = []
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0 } })
    svc.install()
    ctx._emit(fakeSession('q1', appends), { type: 'turn/end', data: { reason: { kind: 'error', error: { status: 402 } } } })
    await new Promise((r) => setTimeout(r, 40))
    ok(sent.length === 0, '额度失败不续跑（白重试没意义）')
    ok(appends.length === 1, '贴了一条止损通知')
    ok(appends[0].payload.content[0].text.includes('按规则停止'), '通知文案说明按规则停止')
    ok(appends[0].payload.id !== undefined && appends[0].payload.role === 'user', '**通知带 id 与 role**（少了会话会拒载）')
    ok(appends[0].o?.surfaceOp === 'append', '通知带 surfaceOp 标记')
  }
  {
    // 上下文超限 → 有压缩后端就压完续跑
    const compacted = []
    const ctx = fakeCtx({
      compaction: { compactIfNeeded: async () => { compacted.push(1); return { replaced: ['x'] } } },
    })
    const sent = []
    ctx._addLive('c1', sent)
    const appends = []
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0, backoffBaseMs: 0, backoffMaxMs: 0 } })
    svc.install()
    ctx._emit(fakeSession('c1', appends), { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } })
    await new Promise((r) => setTimeout(r, 60))
    ok(compacted.length === 1, '调了压缩服务')
    ok(sent.length === 1, '压缩完成后续跑')

    // 没有压缩后端 → 降级为通知
    const ctx2 = fakeCtx()
    const s2 = []
    ctx2._addLive('c2', s2)
    const a2 = []
    const svc2 = makeContinueService({ ctx: ctx2, config: { cooldownMs: 0 } })
    svc2.install()
    ctx2._emit(fakeSession('c2', a2), { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } })
    await new Promise((r) => setTimeout(r, 60))
    ok(s2.length === 0, '没有压缩服务时不续跑')
    ok(a2.length === 1 && a2[0].payload.content[0].text.includes('未挂载压缩服务'), '降级为止损通知')
  }
  {
    // 换模型：agent/request 瀑布改该轮模型
    const ctx = fakeCtx()
    const sent = []
    ctx._addLive('m1', sent)
    const appends = []
    const rules = [{ id: 'r-model', when: 'max-tokens', action: 'continue-with', provider: 'backup', model: 'm2', maxAttempts: 0 }]
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0, backoffBaseMs: 0, backoffMaxMs: 0, rules } })
    svc.install()
    const session = fakeSession('m1', appends)
    ctx._emit(session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 40))
    ok(sent.length === 1, '投了续跑')
    // 续跑发起的新轮次：turn/start 把该轮记入 overrideTurn
    ctx._emit(session, { type: 'turn/start', data: { turn: 7 } })
    const got = await ctx._request({ agent: { id: 'm1' }, turn: 7 }, () => Promise.resolve({ provider: 'main', model: 'm1' }))
    ok(got.model === 'm2' && got.provider === 'backup', '续跑轮被换成备用模型')
    // 别的轮次不受影响
    const other = await ctx._request({ agent: { id: 'm1' }, turn: 8 }, () => Promise.resolve({ provider: 'main', model: 'm1' }))
    ok(other.model === 'm1', '不是我们投的那一轮 → 不动')
  }
  {
    // 运行时开关 + 停用清定时器
    const ctx = fakeCtx()
    const sent = []
    ctx._addLive('t1', sent)
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0, backoffBaseMs: 500 } })
    svc.install()
    ok(svc.status().enabled === true, '默认启用')
    ctx._emit({ id: 't1', header: {} }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    svc.setEnabled(false)
    await new Promise((r) => setTimeout(r, 700))
    ok(sent.length === 0, '**停用会清掉挂起的投递**（关了不该还发一次）')
    svc.setEnabled(true)
    ok(svc.status().enabled === true, '能重新启用')
  }
  {
    // 计数与活动
    const ctx = fakeCtx()
    const sent = []
    ctx._addLive('k1', sent)
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0, backoffBaseMs: 0, backoffMaxMs: 0 } })
    svc.install()
    ctx._emit({ id: 'k1', header: {} }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 40))
    const st = svc.status()
    ok(st.totals.continues === 1, '累计续跑计数')
    ok(st.sessions[0].sessionId === 'k1', '列出会话')
    ok(st.sessions[0].ruleAttempts['r-max-tokens'] === 1, '记录了命中规则的执行次数')
    ok(st.activity.length > 0, '有活动日志')
    ok(st.whenLabels !== undefined && st.ruleWhens.length === 10, '状态里带界面要用的标签与枚举')
    ok(svc.reset('k1').cleared === 1, '按会话清零')
  }
  {
    // 配置更新走清洗
    const ctx = fakeCtx()
    const svc = makeContinueService({ ctx, config: {} })
    const r = svc.configure({ prompt: '接着写', maxAttempts: 10, rules: [{ when: 'rate-limit', action: 'stop' }] })
    ok(r.changed.includes('prompt') && r.config.prompt === '接着写', '改 prompt')
    ok(r.config.maxAttempts === 10, '改上限')
    ok(r.config.rules.length === 1 && r.config.rules[0].action === 'stop', '整表替换规则')
    ok(svc.configure({ cooldownMs: -1 }).config.cooldownMs === DEFAULTS.cooldownMs, '非法值回退默认')
  }
  {
    // 会话不在活跃列表
    const ctx = fakeCtx()
    const svc = makeContinueService({ ctx, config: { cooldownMs: 0, backoffBaseMs: 0, backoffMaxMs: 0 } })
    svc.install()
    let threw = null
    try {
      ctx._emit({ id: 'ghost', header: {} }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
      await new Promise((r) => setTimeout(r, 40))
    } catch (e) { threw = e }
    ok(threw === null, '会话不在活跃列表时不抛异常')
    ok(svc.status().activity.some((x) => x.kind === 'skip' && x.reason === 'not-live'), '如实记为 not-live')
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
