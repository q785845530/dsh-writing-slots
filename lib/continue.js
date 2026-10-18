/**
 * dsh-writing-slots — 自动续跑（完整移植 @weibaohui/dsh-continue）。
 *
 * agent 会话中断后自动续上，不用手敲「继续」。核心是**有序规则表**：
 * 不同失败类型走不同策略，从上到下先命中先用。
 *
 * ## 能处理的失败类型（`when`）
 * | when | 说明 | 默认动作 |
 * |---|---|---|
 * | `rate-limit` | 限流（429） | 退避重试，尊重服务商给的等待时间，最多 5 次 |
 * | `quota` | 额度耗尽 / 余额不足 | 立即止损并通知（白重试没意义） |
 * | `auth` | 鉴权失败（401/403） | 立即止损并通知 |
 * | `context` | 上下文超限 | **自动压缩会话上下文，压完继续**；没压缩后端就降级为止损通知 |
 * | `server` | 服务端错误（5xx） | 继续 |
 * | `transport` | 传输/网络错误 | 继续 |
 * | `interrupted` | 崩溃孤儿轮 | 继续 |
 * | `max-tokens` | 输出截断 | 继续（长回复/长代码不再停在半截） |
 * | `status` | 自定义状态码 | 用户填码，命中即按该规则走 |
 * | `any` | 任意失败 | 兜底 |
 *
 * ## 动作（`action`）
 * - `continue`：续跑
 * - `continue-with`：**换模型**续跑（规则里指定 provider + model）
 * - `compact`：先压缩上下文再续跑
 * - `stop`：止损并通知，交回人工
 *
 * ## 移植时保留的硬约束（每一条都是踩出来的）
 *   1. `source.kind` 必须非空且是生产者自有（v4 准入拒 `plugin` 兜底）；
 *   2. 通知必须带 `id` 与 `role: 'user'` —— 少了这两个字段，**写入时静默通过，
 *      但整个会话下次加载会拒载**（"lacks an identified message"）。最阴的一条；
 *   3. `append` 要带 `surfaceOp: 'append'`，否则宿主丢弃；
 *   4. `followup` 必须在分发窗口之外调用（宿主拒重入 append）；
 *   5. 压缩服务**懒解析**（`ctx.get`）而不是写进 `inject` —— 写进去会让本插件
 *      在没挂压缩后端的 profile 上永久 pending；
 *   6. 冷却窗口内到达的失败**推迟续跑**而不是丢弃（续跑轮自己的失败几乎必然
 *      落在冷却窗口里，丢弃会让会话只续一次就停摆）。
 *
 * @module dsh-writing-slots/continue
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 主目录：优先环境变量，其次 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/** 规则可匹配的失败类型。 */
export const RULE_WHENS = [
  'rate-limit', 'quota', 'auth', 'context', 'server',
  'transport', 'interrupted', 'max-tokens', 'status', 'any',
]

/** 规则可执行的动作。 */
export const RULE_ACTIONS = ['continue', 'continue-with', 'compact', 'stop']

/** 类型的显示名。 */
export const WHEN_LABELS = {
  'rate-limit': '限流（429）',
  quota: '额度耗尽',
  auth: '鉴权失败',
  context: '上下文超限',
  server: '服务端错误（5xx）',
  transport: '传输/网络错误',
  interrupted: '崩溃孤儿轮',
  'max-tokens': '输出截断（max-tokens）',
  status: '自定义状态码',
  any: '任意失败',
}

/** 动作的显示名。 */
export const ACTION_LABELS = {
  continue: '继续续跑',
  'continue-with': '换模型续跑',
  compact: '压缩上下文后续跑',
  stop: '止损通知',
}

/** 默认规则表：覆盖常见失败场景，开箱可用。 */
export const DEFAULT_RULES = [
  { id: 'r-rate-limit', when: 'rate-limit', action: 'continue', provider: '', model: '', maxAttempts: 5 },
  { id: 'r-quota', when: 'quota', action: 'stop', provider: '', model: '', maxAttempts: 0 },
  { id: 'r-auth', when: 'auth', action: 'stop', provider: '', model: '', maxAttempts: 0 },
  { id: 'r-context', when: 'context', action: 'compact', provider: '', model: '', maxAttempts: 2 },
  { id: 'r-interrupted', when: 'interrupted', action: 'continue', provider: '', model: '', maxAttempts: 0 },
  { id: 'r-max-tokens', when: 'max-tokens', action: 'continue', provider: '', model: '', maxAttempts: 0 },
  { id: 'r-any', when: 'any', action: 'continue', provider: '', model: '', maxAttempts: 0 },
]

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  prompt: '继续',
  maxAttempts: 50,      // 每会话、每个失败簇的续跑上限；一轮正常结束就归零
  cooldownMs: 5000,     // 同会话两次续跑之间的最小间隔
  backoffBaseMs: 2000,  // base * 2^attempt
  backoffMaxMs: 30000,  // 上限
  rules: DEFAULT_RULES,
  notifyOnCap: true,
}

/**
 * 额度类文案兜底。
 *
 * 宿主适配器把「余额/额度/欠费」类文案归为 QUOTA，其余 429 归 RATE_LIMIT；
 * 插件再对 429 做一次文案判定，因为有的服务商把额度错误也报成 429。
 */
export const QUOTA_WORDS = [
  'quota', 'insufficient', 'balance', 'credit', 'billing', 'arrears',
  'exhausted', 'arrearage', '额度', '余额', '欠费', '充值',
]

/** 永不续跑的会话 id 前缀（宿主自己的循环评审会话）。 */
export const EXCLUDE_ID_PREFIXES = ['hermes-loop-review-']

// ————————————————————————— 纯函数（可单测） —————————————————————————

/** `turn/end` 的 reason 可能是 `{kind:'completed'}`，也可能直接是字符串。 */
export function reasonKind(reason) {
  if (reason === null || reason === undefined) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/**
 * 把一个结构化失败归类，用于路由。
 *
 * @returns `{ cls, status, code }`，`cls ∈ quota|auth|context|rate-limit|server|unknown`。
 */
export function classifyFailure(failure) {
  if (!failure || typeof failure !== 'object') return { cls: 'unknown', status: undefined, code: undefined }
  const code = typeof failure.code === 'string' ? failure.code : undefined
  const status = Number.isFinite(failure.status) ? failure.status : undefined
  const msg = typeof failure.message === 'string' ? failure.message.toLowerCase() : ''
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return { cls: 'context', status, code }
  if (code === 'QUOTA' || status === 402 || (status === 429 && QUOTA_WORDS.some((w) => msg.includes(w)))) {
    return { cls: 'quota', status, code }
  }
  if (code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL' || status === 401 || status === 403) {
    return { cls: 'auth', status, code }
  }
  if (code === 'RATE_LIMIT' || status === 429) return { cls: 'rate-limit', status, code }
  if (status !== undefined && status >= 500) return { cls: 'server', status, code }
  return { cls: 'unknown', status, code }
}

/**
 * 解析规则里的 `codes` 字符串。
 *
 * 用户填 `'529, 520，UNKNOWN'`：纯数字且在 100..599 当 HTTP 状态码，
 * 含非数字字符的当机器码（归一成大写做不敏感比较）。上限 20 个 token。
 */
export function parseCodes(raw) {
  if (typeof raw !== 'string') return null
  const nums = []
  const strs = []
  for (const token of raw.split(/[,，;；\s]+/)) {
    if (!token || token.length > 64) continue
    if (/^\d{1,3}$/.test(token)) {
      const n = Number(token)
      if (n >= 100 && n <= 599) nums.push(n)
      continue
    }
    strs.push(token.toUpperCase())
    if (nums.length + strs.length >= 20) break
  }
  return nums.length > 0 || strs.length > 0 ? { nums, strs } : null
}

/** 一个结构化失败是否命中规则的 `codes`。 */
export function matchesCodes(raw, failure) {
  if (!failure || typeof failure !== 'object') return false
  const parsed = parseCodes(raw)
  if (!parsed) return false
  if (parsed.nums.length > 0 && Number.isFinite(failure.status) && parsed.nums.includes(failure.status)) return true
  if (parsed.strs.length > 0 && typeof failure.code === 'string' && parsed.strs.includes(failure.code.toUpperCase())) return true
  return false
}

/** 把失败类型（或轮次结束原因）映射到规则的 `when`。 */
export function classToWhen(kind, cls) {
  if (kind === 'interrupted') return 'interrupted'
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'error') {
    if (cls && cls.cls === 'unknown') return 'transport'
    if (cls && cls.cls) return cls.cls
  }
  return undefined
}

/**
 * 找第一条匹配且**未用尽**的规则（数组顺序即优先级，先命中先用）。
 *
 * `when:'status'` 的规则带用户填的 `codes`，且只在 `kind='error'` 时参与匹配
 * —— 崩溃孤儿轮和 max-tokens 轮没有结构化失败可比。
 */
export function firstMatchingRule(rules, kind, cls, ruleAttempts, failure) {
  const when = classToWhen(kind, cls)
  if (!when) return null
  for (const rule of rules ?? []) {
    if (!rule) continue
    if (rule.when === 'status') {
      if (kind !== 'error' || !matchesCodes(rule.codes, failure)) continue
    } else if (rule.when !== when && rule.when !== 'any') continue
    const cap = Number(rule.maxAttempts) || 0
    if (cap > 0 && ((ruleAttempts && ruleAttempts[rule.id]) || 0) >= cap) continue
    return rule
  }
  return null
}

/**
 * 指数退避 + 抖动。
 *
 * 抖动是为了让并发的重试错开，不然多个会话会在同一秒一起打过来。
 */
export function computeBackoff(attempt, eff) {
  const base = Math.max(0, Number(eff?.backoffBaseMs) || 0)
  const max = Math.max(0, Number(eff?.backoffMaxMs) || 0)
  const exp = base * Math.pow(2, Math.max(0, attempt))
  const clamped = Math.min(exp, max)
  const jitter = clamped * 0.2 * Math.random()
  return Math.round(clamped + jitter)
}

/** 冷却闸门：没续过，或距上次续跑已超过冷却窗口。 */
export function withinCooldown(now, lastAt, eff) {
  if (lastAt === null || lastAt === undefined) return true
  const cd = Math.max(0, Number(eff?.cooldownMs) || 0)
  return (now - lastAt) >= cd
}

/** 这个会话要不要跳过（子代理的、宿主循环评审的）。 */
export function isExcluded(session) {
  if (!session) return true
  const id = typeof session.id === 'string' ? session.id : ''
  if (EXCLUDE_ID_PREFIXES.some((p) => id.startsWith(p))) return true
  return session.header?.origin === 'subagent'
}

/** 新的会话状态。 */
export function newSessionState() {
  return {
    attempts: 0,
    lastContinueAt: null,
    lastTurn: null,
    toolCalls: 0,
    toolResults: 0,
    timer: null,
    pendingContinue: false,
    overrideTurn: undefined,
    ruleAttempts: {},        // ruleId → 本失败簇内该规则已续跑次数
    continueOverride: null,  // 本次续跑轮应用的 {provider, model, via}
    compacting: false,
  }
}

/** 止损通知文案。 */
export function failureNoticeText(cls, whenLabel) {
  const tag = [cls?.code, cls?.status !== undefined ? `HTTP ${cls.status}` : null].filter(Boolean).join('/')
  const head = whenLabel ? `自动续跑按规则停止（${whenLabel}` : '自动续跑按规则停止'
  return `${head}${tag ? `：${tag}）` : '）'}——请人工介入后手动继续`
}

/**
 * `turn/end` 的**纯决策**：按有序规则表算出该做什么。
 *
 * 拆成纯函数是为了能单测 —— 这套路由分支多，混着副作用没法验。
 *
 * @returns
 *  - `{type:'reset'}` 正常结束 → 计数归零
 *  - `{type:'schedule', delay, attempt, cls, rule, override?, compact?}` 排一次续跑
 *  - `{type:'cap'}` 全局上限或规则全用尽 → 停
 *  - `{type:'abort-notify', cls, rule}` 规则说停 → 贴一行通知
 *  - `{type:'skip', reason}` 不该续
 *  - `{type:'noop'}` 认不出的结束原因
 */
export function decideTurnEnd(st, kind, eff, now, failure) {
  if (kind === 'completed') return { type: 'reset' }
  if (kind === undefined) return { type: 'noop' }
  // 只有 error / interrupted / max-tokens 参与规则匹配；
  // aborted（用户主动中止）等一律不续 —— 用户按了停，插件不该背着他继续。
  if (kind !== 'error' && kind !== 'interrupted' && kind !== 'max-tokens') {
    return { type: 'skip', reason: 'reason-not-retryable', kind }
  }
  if (st.compacting) return { type: 'skip', reason: 'compacting' }

  const cls = kind === 'error' ? classifyFailure(failure) : { cls: undefined, status: undefined, code: undefined }
  const rule = firstMatchingRule(eff.rules, kind, cls, st.ruleAttempts, failure)
  if (!rule) return { type: 'cap' }   // 没有可用规则（用尽或表为空）→ 视作达上限
  if (rule.action === 'stop') return { type: 'abort-notify', cls, rule }
  if (st.timer !== null) return { type: 'skip', reason: 'pending' }
  if (st.attempts >= eff.maxAttempts) return { type: 'cap' }

  const attempt = st.attempts + 1
  let delay = computeBackoff(st.attempts, eff)
  // 限流时尊重服务商给的等待时间
  if (cls.cls === 'rate-limit' && failure && Number.isFinite(failure.providerRetryAfterMs)) {
    delay = Math.max(delay, failure.providerRetryAfterMs)
  }
  // 冷却窗口内到达的失败**推迟**而不是丢弃 ——
  // 续跑轮自己的失败几乎必然落在冷却窗口里，丢弃会让会话只续一次就停摆。
  if (!withinCooldown(now, st.lastContinueAt, eff)) {
    const remaining = (Number(eff.cooldownMs) || 0) - (now - st.lastContinueAt)
    if (remaining > delay) delay = remaining
  }
  const override = rule.action === 'continue-with' && rule.model
    ? { provider: rule.provider || '', model: rule.model, via: rule.id }
    : null
  return { type: 'schedule', delay, attempt, cls, rule, override, compact: rule.action === 'compact' }
}

/** 校验并清洗一条规则；不可用返回 null。 */
export function sanitizeRule(entry, i = 0) {
  if (!entry || typeof entry !== 'object') return null
  const when = RULE_WHENS.includes(entry.when) ? entry.when : null
  const action = RULE_ACTIONS.includes(entry.action) ? entry.action : null
  if (!when || !action) return null
  const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id.slice(0, 64) : `r-${i}-${Date.now().toString(36)}`
  const codes = typeof entry.codes === 'string' ? entry.codes.trim().slice(0, 512) : ''
  // 自定义状态码规则必须至少给出一个能解析的码，否则这条规则永远不会命中
  if (when === 'status' && !parseCodes(codes)) return null
  const rule = {
    id, when, action,
    provider: typeof entry.provider === 'string' ? entry.provider.trim() : '',
    model: typeof entry.model === 'string' ? entry.model.trim() : '',
    maxAttempts: Number.isFinite(entry.maxAttempts) && entry.maxAttempts > 0 ? Math.floor(entry.maxAttempts) : 0,
    codes,
  }
  // 换模型必须有目标模型
  if (rule.action === 'continue-with' && !rule.model) return null
  return rule
}

/** 从原始 patch 里清洗出可用的配置更新。 */
export function sanitizePatch(body) {
  const patch = {}
  if (body === null || typeof body !== 'object') return patch
  if (typeof body.prompt === 'string' && body.prompt !== '') patch.prompt = body.prompt
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.maxAttempts === 'number' && body.maxAttempts >= 1) patch.maxAttempts = body.maxAttempts
  if (typeof body.cooldownMs === 'number' && body.cooldownMs >= 0) patch.cooldownMs = body.cooldownMs
  if (typeof body.backoffBaseMs === 'number' && body.backoffBaseMs >= 0) patch.backoffBaseMs = body.backoffBaseMs
  if (typeof body.backoffMaxMs === 'number' && body.backoffMaxMs >= 1000) patch.backoffMaxMs = body.backoffMaxMs
  if (Array.isArray(body.rules)) {
    const rules = body.rules.slice(0, 20).map((r, i) => sanitizeRule(r, i)).filter(Boolean)
    if (rules.length > 0) patch.rules = rules
  }
  if (typeof body.notifyOnCap === 'boolean') patch.notifyOnCap = body.notifyOnCap
  return patch
}

/** 读配置，缺项用默认值。 */
export function readConfig(config) {
  const c = config ?? {}
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULTS.enabled,
    prompt: typeof c.prompt === 'string' && c.prompt !== '' ? c.prompt : DEFAULTS.prompt,
    maxAttempts: Number.isFinite(c.maxAttempts) && c.maxAttempts >= 1 ? Math.floor(c.maxAttempts) : DEFAULTS.maxAttempts,
    cooldownMs: Number.isFinite(c.cooldownMs) && c.cooldownMs >= 0 ? c.cooldownMs : DEFAULTS.cooldownMs,
    backoffBaseMs: Number.isFinite(c.backoffBaseMs) && c.backoffBaseMs >= 0 ? c.backoffBaseMs : DEFAULTS.backoffBaseMs,
    backoffMaxMs: Number.isFinite(c.backoffMaxMs) && c.backoffMaxMs >= 1000 ? c.backoffMaxMs : DEFAULTS.backoffMaxMs,
    rules: Array.isArray(c.rules) && c.rules.length > 0
      ? c.rules.map((r, i) => sanitizeRule(r, i)).filter(Boolean)
      : DEFAULTS.rules,
    notifyOnCap: typeof c.notifyOnCap === 'boolean' ? c.notifyOnCap : DEFAULTS.notifyOnCap,
  }
}

// ————————————————————————— 服务 —————————————————————————

/**
 * 建续跑服务。
 *
 * @param deps `{ ctx, config, logger }`。
 */
export function makeContinueService(deps = {}) {
  const ctx = deps.ctx
  const logger = deps.logger ?? ctx?.logger

  let config = readConfig(deps.config)
  const states = new Map()
  const activity = []
  const requestHandlers = []
  const ACTIVITY_LIMIT = 200

  /**
   * 安全取服务。
   *
   * `ctx.get` 取不到返回 undefined，而 `ctx.x` 在没 inject 时会**抛**
   * （"cannot get property X without inject"）。压缩、llm 这些是可选组合，
   * 不能写进 inject，所以必须走这条读法。
   */
  const service = (name) => {
    try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
  }
  const agentsOf = () => service('agents')

  function trace(kind, data) {
    const row = { at: Date.now(), kind, ...data }
    activity.unshift(row)
    if (activity.length > ACTIVITY_LIMIT) activity.length = ACTIVITY_LIMIT
    const dir = join(dshHome(), 'dsh-writing-slots')
    mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => appendFile(join(dir, 'activity.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }))
      .catch(() => { /* 写不进去不影响续跑本身 */ })
  }

  const stateFor = (sid) => {
    let st = states.get(sid)
    if (!st) { st = newSessionState(); states.set(sid, st) }
    return st
  }

  const cancelTimer = (st) => {
    if (st.timer !== null) { try { clearTimeout(st.timer) } catch { /* ignore */ } st.timer = null }
  }

  /**
   * 往会话里贴一条通知。
   *
   * 三个字段缺一不可，且各有各的坑：
   *   - `source.kind` 非空且自有（v4 准入拒 `plugin` 兜底）
   *   - `surfaceOp: 'append'`（不加宿主丢弃）
   *   - `id` + `role: 'user'` —— **少了这两个，写入时静默通过，
   *     但整个会话下次加载会拒载**。这是最阴的一条。
   */
  function notifySession(session, text) {
    if (!session || typeof session.append !== 'function') return
    setTimeout(() => {
      try {
        session.append('user/message', {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-writing-slots', form: 'notice', summary: text },
        }, { surfaceOp: 'append' })
      } catch (e) {
        logger?.warn?.(`自动续跑：通知失败：${e?.message ?? String(e)}`)
      }
    }, 0).unref?.()
  }

  function notifyStop(session, cls, rule) {
    notifySession(session, failureNoticeText(cls, rule ? WHEN_LABELS[rule.when] : undefined))
  }

  /** 投递一次续跑。 */
  function scheduleContinue(session, st, kind, action) {
    const sid = session?.id
    const delay = action.delay ?? computeBackoff(st.attempts, config)
    const attempt = action.attempt ?? (st.attempts + 1)
    st.timer = setTimeout(() => {
      st.timer = null
      const agents = agentsOf()
      const agent = agents && typeof agents.get === 'function' ? agents.get(sid) : undefined
      if (!agent || typeof agent.followup !== 'function') {
        trace('skip', { sessionId: sid, reason: 'not-live', attempt })
        return
      }
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(config.prompt) }],
        // 同样的自有 kind 约束：用 `plugin` 会让续跑消息在准入时被拒，
        // 表现为「本轮运行失败 · UNKNOWN」，看起来像模型的问题。
        source: { kind: 'dsh-writing-slots' },
      }
      try {
        agent.followup(message)
        st.attempts = attempt
        st.lastContinueAt = Date.now()
        if (action.rule) st.ruleAttempts[action.rule.id] = (st.ruleAttempts[action.rule.id] || 0) + 1
        // 标记待归属：下一个 turn/start 视为本次续跑发起的轮次
        st.pendingContinue = true
        if (action.override) st.continueOverride = { ...action.override }
        trace('continue-sent', {
          sessionId: sid, attempt, trigger: kind,
          ruleId: action.rule?.id, via: action.override?.via,
        })
      } catch (e) {
        trace('continue-failed', { sessionId: sid, attempt, message: String(e?.message ?? e) })
      }
    }, delay)
    if (typeof st.timer.unref === 'function') st.timer.unref()
    trace('scheduled', { sessionId: sid, attempt, delay, trigger: kind, ruleId: action.rule?.id })
  }

  /**
   * 先压缩上下文，压成功再续跑。
   *
   * 压缩服务**懒解析**：宿主平面挂不挂是「组合」而不是本插件的依赖。
   * 写进 inject 会让本插件在没挂压缩后端的 profile 上永久 pending；
   * 直接读 `ctx.compaction` 又会抛。`ctx.get` 是安全的读法。
   */
  function runCompactThenContinue(session, st, kind, action) {
    const sid = session?.id
    void (async () => {
      try {
        const agents = agentsOf()
        const agent = agents && typeof agents.get === 'function' ? agents.get(sid) : undefined
        const compaction = service('compaction')
        if (!agent || !compaction || typeof compaction.compactIfNeeded !== 'function') {
          trace('compact-unavailable', { sessionId: sid, ruleId: action.rule?.id })
          notifySession(session, '上下文超限：宿主未挂载压缩服务，自动续跑停止——请手动压缩或新开会话')
          return
        }
        st.compacting = true
        const result = await compaction.compactIfNeeded(agent, 'context-overflow', new AbortController().signal)
        st.compacting = false
        if (result) {
          trace('compact-done', { sessionId: sid, ruleId: action.rule?.id })
          scheduleContinue(session, st, kind, action)
        } else {
          trace('compact-noop', { sessionId: sid, ruleId: action.rule?.id })
          notifySession(session, '上下文超限：没有可安全压缩的区间，自动续跑停止——请手动压缩或新开会话')
        }
      } catch (e) {
        st.compacting = false
        trace('compact-failed', { sessionId: sid, ruleId: action.rule?.id, message: String(e?.message ?? e) })
        notifyStop(session, action.cls, action.rule)
      }
    })()
  }

  /** 会话事件入口。 */
  function onSessionEvent(session, event) {
    try {
      if (!config.enabled) return
      if (!agentsOf()) return
      if (isExcluded(session)) return
      const sid = session?.id
      if (typeof sid !== 'string') return
      const st = stateFor(sid)

      if (event.type === 'turn/start') {
        // 用户或 agent 已经自己起了新一轮：取消挂起的续跑，避免双发
        cancelTimer(st)
        st.toolCalls = 0
        st.toolResults = 0
        if (st.pendingContinue) {
          st.pendingContinue = false
          st.overrideTurn = event.data?.turn
        }
        return
      }
      if (event.type === 'tool/call') { st.toolCalls += 1; return }
      if (event.type === 'tool/result') { st.toolResults += 1; return }
      if (event.type !== 'turn/end') return

      const reason = event.data?.reason
      const kind = reasonKind(reason)
      st.lastTurn = event.data?.turn
      st.overrideTurn = undefined
      st.continueOverride = null
      const failure = kind === 'error' && reason && typeof reason === 'object'
        ? (reason.error ?? reason.failure)
        : undefined

      const action = decideTurnEnd(st, kind, config, Date.now(), failure)

      if (action.type === 'reset') {
        cancelTimer(st)
        st.attempts = 0
        st.toolCalls = 0
        st.toolResults = 0
        st.ruleAttempts = {}   // 失败簇结束，各规则计数归零
        return
      }
      if (action.type === 'schedule') {
        trace('detect', {
          sessionId: sid, kind, attempts: st.attempts,
          ruleId: action.rule?.id, ruleAction: action.rule?.action,
          failureClass: action.cls?.cls, code: action.cls?.code, status: action.cls?.status,
        })
        if (action.compact) runCompactThenContinue(session, st, kind, action)
        else scheduleContinue(session, st, kind, action)
        return
      }
      if (action.type === 'abort-notify') {
        trace('stop', { sessionId: sid, kind, ruleId: action.rule?.id, cls: action.cls?.cls })
        notifyStop(session, action.cls, action.rule)
        return
      }
      if (action.type === 'cap') {
        trace('cap', { sessionId: sid, kind, attempts: st.attempts })
        if (config.notifyOnCap) notifySession(session, `自动续跑已达上限（${config.maxAttempts} 次），请人工介入`)
        return
      }
    } catch (e) {
      logger?.warn?.(`自动续跑：事件处理异常：${e?.message ?? String(e)}`)
    }
  }

  /** 续跑轮的模型覆盖瀑布。 */
  function modelOverrideHandler(payload, next) {
    let st = null
    let ov = null
    try { st = payload?.agent?.id ? states.get(payload.agent.id) : null } catch { return next() }
    if (!st || st.overrideTurn !== payload.turn) return next()
    ov = st.continueOverride
    if (!ov || !ov.model) return next()
    return next().then((cfg) => {
      try {
        if (!cfg || typeof cfg !== 'object') return cfg
        const patched = { ...cfg, model: ov.model }
        if (ov.provider) patched.provider = ov.provider
        if (patched.provider === cfg.provider && patched.model === cfg.model) return cfg
        trace('model-overridden', {
          sessionId: payload.agent.id, turn: payload.turn, via: ov.via,
          from: `${cfg.provider}/${cfg.model}`, to: `${patched.provider}/${patched.model}`,
        })
        return patched
      } catch { return cfg }
    })
  }

  return {
    /** 挂监听（会话事件 + 模型覆盖）。幂等。 */
    install() {
      ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-writing-slots: 自动续跑')
      // 命中 continue-with 规则的续跑轮：用 agent/request 瀑布把该轮模型换掉。
      // 归属靠 turn 号：只有我们投递的那一轮会被覆盖，用户手敲消息起的轮次不会。
      ctx.effect(() => {
        const dispose = ctx.on('agent/request', modelOverrideHandler)
        return () => { try { dispose() } catch { /* ignore */ } }
      }, 'dsh-writing-slots: 续跑轮模型覆盖')
    },

    /** 状态（给界面与工具看）。 */
    status() {
      const sessions = [...states.entries()].map(([sessionId, st]) => ({
        sessionId,
        attempts: st.attempts,
        lastContinueAt: st.lastContinueAt,
        lastTurn: st.lastTurn,
        pending: st.timer !== null,
        compacting: st.compacting,
        toolCalls: st.toolCalls,
        toolResults: st.toolResults,
        ruleAttempts: st.ruleAttempts,
      })).sort((a, b) => (b.lastContinueAt ?? 0) - (a.lastContinueAt ?? 0))

      return {
        enabled: config.enabled,
        config: { ...config },
        totals: {
          sessions: sessions.length,
          continues: sessions.reduce((a, s) => a + s.attempts, 0),
        },
        sessions,
        activity: activity.slice(0, 40),
        defaults: DEFAULTS,
        whenLabels: WHEN_LABELS,
        actionLabels: ACTION_LABELS,
        ruleWhens: RULE_WHENS,
        ruleActions: RULE_ACTIONS,
        compactionArmed: typeof service('compaction')?.compactIfNeeded === 'function',
        note: '计数是进程内实时状态；活动日志另存 ~/.dsh/dsh-writing-slots/activity.jsonl。',
      }
    },

    setEnabled(on) {
      const next = on === true
      const changed = config.enabled !== next
      config = { ...config, enabled: next }
      // 停用时清掉挂起的投递 —— 关了不该还发一次
      if (!next) for (const st of states.values()) cancelTimer(st)
      logger?.info?.(`自动续跑${next ? '已启用' : '已停用'}`)
      return { ok: true, changed, enabled: config.enabled }
    },

    configure(body) {
      const patch = sanitizePatch(body)
      const before = config
      config = readConfig({ ...config, ...patch })
      const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(config[k]))
      return { ok: true, changed, config: { ...config } }
    },

    reset(sessionId) {
      if (typeof sessionId === 'string' && sessionId !== '') {
        const st = states.get(sessionId)
        if (st) cancelTimer(st)
        const had = states.delete(sessionId)
        return { ok: true, cleared: had ? 1 : 0, scope: sessionId }
      }
      for (const st of states.values()) cancelTimer(st)
      const n = states.size
      states.clear()
      activity.length = 0
      return { ok: true, cleared: n, scope: 'all' }
    },

    /** 可用的 provider / 模型（给规则里的「换模型」下拉用，取不到就空数组）。 */
    async modelOptions() {
      const llm = service('llm')
      const out = { providers: [], models: {}, default: null }
      try {
        if (llm && typeof llm.listProviders === 'function') out.providers = llm.listProviders() ?? []
      } catch { out.providers = [] }
      for (const p of out.providers) {
        try {
          out.models[p.id] = (llm && typeof llm.listModels === 'function') ? await llm.listModels(p.id) : []
        } catch { out.models[p.id] = [] }
      }
      try {
        const dm = service('agentDefaultModel')
        if (dm && typeof dm.currentSelection === 'function') out.default = dm.currentSelection()
      } catch { out.default = null }
      return out
    },

    /** 校验一条规则（界面用）。 */
    validateRule(entry, i) { return sanitizeRule(entry, i) },

    /** 仅供测试。 */
    _handle: onSessionEvent,
    _request: modelOverrideHandler,
    _config: () => ({ ...config }),
    _state: (sid) => states.get(sid),
  }
}
