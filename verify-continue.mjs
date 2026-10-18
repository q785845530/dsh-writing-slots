#!/usr/bin/env node
/**
 * dsh-writing-slots / 自动继跑 自测。
 *
 *   node verify-continue.mjs
 *
 * 这个模块是从 dsh-auto-continue 移植的，所以重点回归它踩过的坑：
 *   - 只在 turn/end reason=max-tokens 时触发；
 *   - 排除 subagent 来源的会话；
 *   - 投递延到分发窗口之外（setTimeout），且 source.kind 非空；
 *   - 通知必须带 role 与 id（旧版漏了会被宿主丢掉）；
 *   - 去抖与每会话上限都要真的拦住；
 *   - 停用时清掉挂起的定时器，不能关了还投递。
 */
import { makeContinueService, readConfig, DEFAULTS, SOURCE_KIND } from './lib/continue.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/** 造一个够用的假 ctx：记录事件订阅、提供可取的活跃 agent。 */
function fakeCtx() {
  const handlers = []
  const live = new Map()
  const appends = []
  return {
    logger: { info() {}, warn() {} },
    on(type, fn) { handlers.push([type, fn]); return () => {} },
    effect(fn) { return fn() },
    agents: { get: (sid) => live.get(sid) ?? null },
    _emit(session, event) { for (const [t, fn] of handlers) if (t === 'session/event') fn(session, event) },
    _addLive(sid, sink) { live.set(sid, { followup: (m) => sink.push(m) }) },
    _appends: appends,
  }
}

const main = async () => {
  console.log('一、配置')
  {
    const c = readConfig(undefined)
    ok(c.enabled === DEFAULTS.enabled, '缺配置时用默认值')
    ok(c.prompt === DEFAULTS.prompt, '默认注入文本')
    ok(c.minGapMs === 2000, '默认去抖 2000ms')
    ok(c.maxFollowupsPerSession === 0, '默认不限次数')
    const c2 = readConfig({ enabled: false, prompt: '', minGapMs: -5, maxFollowupsPerSession: 'x', notify: false })
    ok(c2.enabled === false, '读到 enabled=false')
    ok(c2.prompt === DEFAULTS.prompt, '空 prompt 回退默认')
    ok(c2.minGapMs === 2000, '负数回退默认')
    ok(c2.maxFollowupsPerSession === 0, '非法值回退默认')
    ok(c2.notify === false, '读到 notify=false')
  }

  console.log('\n二、触发条件')
  {
    const ctx = fakeCtx()
    const sent = []
    ctx._addLive('s1', sent)
    const svc = makeContinueService({ ctx, config: {} })
    svc.install()

    // 非 turn/end
    ctx._emit({ id: 's1' }, { type: 'turn/start' })
    ok(sent.length === 0, '非 turn/end 不触发')

    // reason 不是 max-tokens
    ctx._emit({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    ok(sent.length === 0, 'reason=stop 不触发')
    ctx._emit({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    ok(sent.length === 0, 'reason=error 不触发（那是 continue 插件的活）')

    // max-tokens → 触发
    ctx._emit({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ok(sent.length === 1, `max-tokens 触发一次续写（实际 ${sent.length}）`)
    ok(sent[0].role === 'user', '注入的是 user 消息')
    ok(sent[0].source?.kind === SOURCE_KIND, `source.kind 是生产者自有 kind（${sent[0].source?.kind}）`)
    ok(typeof sent[0].source.kind === 'string' && sent[0].source.kind !== '', 'kind 非空（空会被会话准入拒）')
    ok(typeof sent[0].id === 'string' && sent[0].id !== '', '带 id')
    ok(Array.isArray(sent[0].content) && sent[0].content[0].type === 'text', 'content 是文本数组')
    ok(sent[0].content[0].text === DEFAULTS.prompt, '注入的是配置的文本')

    // reason 直接给字符串也要认
    const ctx2 = fakeCtx(); const s2 = []
    ctx2._addLive('s2', s2)
    const svc2 = makeContinueService({ ctx: ctx2, config: { minGapMs: 0 } })
    svc2.install()
    ctx2._emit({ id: 's2' }, { type: 'turn/end', data: { reason: 'max-tokens' } })
    await new Promise((r) => setTimeout(r, 30))
    ok(s2.length === 1, 'reason 是裸字符串也认')
  }

  console.log('\n三、子代理会话排除')
  {
    const ctx = fakeCtx(); const sent = []
    ctx._addLive('sub', sent)
    const svc = makeContinueService({ ctx, config: {} })
    svc.install()
    ctx._emit({ id: 'sub', header: { origin: 'subagent' } }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ok(sent.length === 0, 'subagent 来源的会话不唤醒（父代理拥有它）')
  }

  console.log('\n四、去抖与上限')
  {
    const ctx = fakeCtx(); const sent = []
    ctx._addLive('d1', sent)
    const svc = makeContinueService({ ctx, config: { minGapMs: 10000 } })
    svc.install()
    ctx._emit({ id: 'd1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ctx._emit({ id: 'd1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ok(sent.length === 1, '去抖窗口内第二次不投递')
    ok(svc.status().lastSkip?.reason.includes('去抖'), '记下跳过原因')

    const ctx3 = fakeCtx(); const s3 = []
    ctx3._addLive('c1', s3)
    const svc3 = makeContinueService({ ctx: ctx3, config: { minGapMs: 0, maxFollowupsPerSession: 2, notify: false } })
    svc3.install()
    for (let i = 0; i < 5; i += 1) {
      ctx3._emit({ id: 'c1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
      await new Promise((r) => setTimeout(r, 20))
    }
    ok(s3.length === 2, `上限 2 时只投递 2 次（实际 ${s3.length}）`)
    ok(svc3.status().totals.skipped >= 1, '达上限后记跳过')
  }

  console.log('\n五、通知')
  {
    const ctx = fakeCtx()
    ctx._addLive('n1', [])
    const appends = []
    const session = {
      id: 'n1',
      header: {},
      append(type, payload, opts) { appends.push({ type, payload, opts }); return { unref() {} } },
    }
    const svc = makeContinueService({ ctx, config: { minGapMs: 0, notify: true } })
    svc.install()
    ctx._emit(session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ok(appends.length === 1, '贴了一条通知')
    const a = appends[0]
    ok(a.type === 'user/message', '类型是 user/message')
    ok(a.payload.role === 'user', '**带 role**（旧版漏了会被宿主丢掉）')
    ok(typeof a.payload.id === 'string' && a.payload.id !== '', '**带 id**')
    ok(a.payload.source?.kind === SOURCE_KIND, '通知来源 kind 正确')
    ok(a.opts?.surfaceOp === 'append', '带 surfaceOp=append（否则宿主丢弃）')
    ok(a.payload.content[0].text.includes('自动续写'), '通知文案')
  }

  console.log('\n六、运行时开关')
  {
    const ctx = fakeCtx(); const sent = []
    ctx._addLive('t1', sent)
    const svc = makeContinueService({ ctx, config: {} })
    svc.install()
    ok(svc.status().enabled === true, '默认启用')
    svc.setEnabled(false)
    ok(svc.status().enabled === false, '能停用')
    ctx._emit({ id: 't1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ok(sent.length === 0, '停用后不投递')
    svc.setEnabled(true)
    ctx._emit({ id: 't1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    ok(sent.length === 1, '重新启用后恢复投递')

    // 停用要清掉挂起的定时器
    const ctx4 = fakeCtx(); const s4 = []
    ctx4._addLive('p1', s4)
    const svc4 = makeContinueService({ ctx: ctx4, config: { minGapMs: 0 } })
    svc4.install()
    ctx4._emit({ id: 'p1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    svc4.setEnabled(false)   // 在 setTimeout(0) 落地前停用
    await new Promise((r) => setTimeout(r, 30))
    ok(s4.length === 0, '**停用会清掉挂起的投递**（关了不该还发一次）')
  }

  console.log('\n七、配置与计数')
  {
    const ctx = fakeCtx()
    ctx._addLive('k1', [])
    const svc = makeContinueService({ ctx, config: { minGapMs: 0 } })
    svc.install()
    const r = svc.configure({ prompt: '接着写', maxFollowupsPerSession: 3 })
    ok(r.ok === true && r.changed.includes('prompt'), '改配置生效')
    ok(r.config.prompt === '接着写' && r.config.maxFollowupsPerSession === 3, '新值已应用')
    ok(svc.configure({ minGapMs: -1 }).config.minGapMs === DEFAULTS.minGapMs, '非法值回退默认')

    ctx._emit({ id: 'k1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    await new Promise((r) => setTimeout(r, 30))
    const st = svc.status()
    ok(st.totals.followups === 1, '计数 +1')
    ok(st.sessions.length === 1, '列出会话')
    ok(st.sessions[0].session === 'k1', '会话 id 正确')
    ok(st.activity.length >= 1, '有活动记录')
    ok(st.note.includes('不落盘'), '说明计数不落盘')

    ok(svc.reset('k1').cleared === 1, '按会话清零')
    ok(svc.status().totals.sessions === 0, '清零后没有会话')
    svc.reset()
    ok(svc.status().activity.length === 0, '整批清零也清活动记录')
  }

  console.log('\n八、会话不在活跃列表时不崩')
  {
    const ctx = fakeCtx()   // 故意不加 live
    const svc = makeContinueService({ ctx, config: { minGapMs: 0 } })
    svc.install()
    let threw = null
    try {
      ctx._emit({ id: 'ghost' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
      await new Promise((r) => setTimeout(r, 30))
    } catch (e) { threw = e }
    ok(threw === null, '会话已不在活跃列表时不抛异常')
    ok(svc.status().activity.some((x) => x.kind === 'lost'), '如实记为「会话不在了」')
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
