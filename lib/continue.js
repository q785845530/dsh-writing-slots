/**
 * dsh-writing-slots — 自动继跑（从 dsh-auto-continue 移植）。
 *
 * 长输出任务（连载写小说、批量生成）里，模型一轮输出撞到字数上限就会被截断。
 * 这个模块在 `turn/end` 的原因是 `max-tokens` 时，自动往**同一个活跃会话**
 * 注入一条「继续写」并唤醒下一轮 —— 不用人手动敲「继续」。
 *
 * ## 为什么要自己写
 *   - 官方 `@deepseek-ai/dsh-goal-round-driver` 见到 `max-tokens` 会 **disarm**
 *     （把「输出被截断」当成需要人工判断的事）；
 *   - 社区 `@weibaohui/dsh-continue` 只处理 `error` / `interrupted`，
 *     对 `max-tokens` 明确 skip。
 *   所以「每章写到上限后接着写」这个场景没人覆盖。
 *
 * ## 移植时保留的几处硬约束（都是踩出来的）
 *   1. 注入消息的 `source.kind` 必须是非空字符串（会话准入会拒空 kind）。
 *      用自己的生产者 kind，不用已移除的 `plugin` 兜底。
 *   2. `agent.followup(...)` 必须在 **session/event 分发窗口之外**调用
 *      —— 宿主会拒「重入 append」。所以延到 `setTimeout(0)` 并 `unref()`。
 *   3. `minGapMs` 去抖：一轮里可能有多个 max-tokens 步，不去抖会连发。
 *   4. `maxFollowupsPerSession`（0 = 不限）防止无限撞顶把额度烧光。
 *   5. 通知要用 `surfaceOp: 'append'` 且带 `role` 与 `id` —— 少了会被宿主丢掉。
 *   6. 排除 `subagent` 来源的会话：子代理归父代理管，不擅自唤醒。
 *
 * ## 与原插件的差别
 * 原插件是独立插件、配置写死在 cordis.patch.yml 里。移植后多两样：
 *   - **运行时可开关**（客户端页签上的开关），不用改配置重启；
 *   - **可见的活动记录**（最近若干次续写、每会话计数），供界面显示。
 *
 * @module dsh-writing-slots/continue
 */

/** 注入消息的生产者 kind。 */
export const SOURCE_KIND = 'dsh-writing-slots'

/** 不自动继跑的会话来源。 */
const EXCLUDE_ORIGIN = 'subagent'

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  prompt: '继续写。不要停下来。直到达到你这边最大字数限制。',
  minGapMs: 2000,
  maxFollowupsPerSession: 0,
  notify: true,
}

/** 活动记录保留条数。 */
const ACTIVITY_LIMIT = 50

function boolFrom(config, key, def) {
  const v = config?.[key]
  return typeof v === 'boolean' ? v : def
}

function intFrom(config, key, def) {
  const v = Number(config?.[key])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def
}

/** 会话是不是子代理的（父代理拥有它，不该被背着唤醒）。 */
function isSubagent(session) {
  if (!session) return true
  return session.header?.origin === EXCLUDE_ORIGIN
}

/** `turn/end` 的 reason 可能是 `{kind:'max-tokens'}`，也可能直接是字符串。 */
function reasonKind(reason) {
  if (reason === null || reason === undefined) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/** 读配置，缺项用默认值。 */
export function readConfig(config) {
  return {
    enabled: boolFrom(config, 'enabled', DEFAULTS.enabled),
    prompt: typeof config?.prompt === 'string' && config.prompt !== '' ? config.prompt : DEFAULTS.prompt,
    minGapMs: intFrom(config, 'minGapMs', DEFAULTS.minGapMs),
    maxFollowupsPerSession: intFrom(config, 'maxFollowupsPerSession', DEFAULTS.maxFollowupsPerSession),
    notify: boolFrom(config, 'notify', DEFAULTS.notify),
  }
}

/**
 * 建继跑服务。
 *
 * @param deps `{ ctx, config, logger, now }`。
 * @returns 服务对象：`install()` 挂监听，`status()` 给界面看，
 *          `enable()/disable()/configure()` 运行时改。
 */
export function makeContinueService(deps = {}) {
  const ctx = deps.ctx
  const logger = deps.logger ?? ctx?.logger
  const now = deps.now ?? (() => Date.now())

  let config = readConfig(deps.config)
  /** 每次会话的计数。key 是 session id。 */
  const states = new Map()
  /** 最近的活动，新的在前。 */
  const activity = []
  /** 最近一次碰到上限但没续写（被去抖/达上限/未启用挡下）。 */
  let lastSkip = null
  let installed = false

  const stateFor = (sid) => {
    let st = states.get(sid)
    if (st === undefined) {
      st = { followups: 0, lastAt: null, timer: null, skipped: 0 }
      states.set(sid, st)
    }
    return st
  }

  const record = (entry) => {
    activity.unshift({ at: now(), ...entry })
    if (activity.length > ACTIVITY_LIMIT) activity.length = ACTIVITY_LIMIT
  }

  /**
   * 投递一次续写。
   *
   * 延到 `setTimeout(0)`：宿主会拒「分发窗口内的重入 append」。
   */
  function scheduleFollowup(sid, st, text) {
    if (st.timer !== null) return false
    st.timer = setTimeout(() => {
      st.timer = null
      const live = ctx?.agents?.get?.(sid)
      if (!live || typeof live.followup !== 'function') {
        record({ session: sid, kind: 'lost', detail: '会话已不在活跃列表里' })
        return
      }
      const message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(text) }],
        // 生产者的自有 kind。空 kind 会被会话准入拒掉。
        source: { kind: SOURCE_KIND },
      }
      try {
        live.followup(message)
        st.followups += 1
        st.lastAt = now()
        logger?.info?.(`${SOURCE_KIND}: 已续写第 ${st.followups} 次（会话 ${sid}）`)
        record({ session: sid, kind: 'followup', count: st.followups, prompt: String(text).slice(0, 60) })
      } catch (e) {
        logger?.warn?.(`${SOURCE_KIND}: 续写失败（会话 ${sid}）：${e?.message ?? String(e)}`)
        record({ session: sid, kind: 'failed', detail: e?.message ?? String(e) })
      }
    }, 0)
    if (typeof st.timer.unref === 'function') st.timer.unref()
    return true
  }

  /**
   * 往会话里贴一条通知。
   *
   * 必须带 `role` 与 `id`，并且用 `surfaceOp: 'append'` —— 少一样宿主就丢掉。
   */
  function notifySession(session, text) {
    if (!session || typeof session.append !== 'function') return
    setTimeout(() => {
      try {
        session.append('user/message', {
          content: [{ type: 'text', text }],
          source: { kind: SOURCE_KIND, form: 'notice', summary: text },
          role: 'user',
          id: crypto.randomUUID(),
        }, { surfaceOp: 'append' })
      } catch (e) {
        logger?.warn?.(`${SOURCE_KIND}: 通知失败：${e?.message ?? String(e)}`)
      }
    }, 0).unref?.()
  }

  /** 会话事件入口。 */
  function onSessionEvent(session, event) {
    if (!config.enabled) return
    if (!session || event?.type !== 'turn/end') return
    if (isSubagent(session)) return
    if (reasonKind(event.data?.reason) !== 'max-tokens') return

    const sid = session.id
    const st = stateFor(sid)

    // 去抖：一轮里可能有多个 max-tokens 步，不去抖会连发
    if (st.lastAt !== null && now() - st.lastAt < config.minGapMs) {
      st.skipped += 1
      lastSkip = { session: sid, reason: 'minGapMs 去抖', at: now() }
      return
    }
    // 每会话上限：到了就通知一次并交回人工
    if (config.maxFollowupsPerSession > 0 && st.followups >= config.maxFollowupsPerSession) {
      st.skipped += 1
      lastSkip = { session: sid, reason: `已达上限 ${config.maxFollowupsPerSession} 次`, at: now() }
      if (config.notify) notifySession(session, `${SOURCE_KIND} 已达上限（${config.maxFollowupsPerSession} 次续写），请人工介入`)
      record({ session: sid, kind: 'capped', limit: config.maxFollowupsPerSession })
      return
    }

    if (scheduleFollowup(sid, st, config.prompt) && config.notify) {
      notifySession(session, `输出达字数上限，自动续写（第 ${st.followups + 1} 次）`)
    }
  }

  return {
    /** 挂上 session/event 监听。幂等。 */
    install() {
      if (installed) return
      installed = true
      ctx.effect(() => ctx.on('session/event', onSessionEvent), `${SOURCE_KIND}: auto-continue`)
    },

    /** 当前配置与状态（给界面看）。 */
    status() {
      const sessions = [...states.entries()].map(([sid, st]) => ({
        session: sid,
        followups: st.followups,
        skipped: st.skipped,
        lastAt: st.lastAt,
        pending: st.timer !== null,
      })).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

      return {
        enabled: config.enabled,
        config: { ...config },
        // 总计
        totals: {
          sessions: states.size,
          followups: sessions.reduce((a, s) => a + s.followups, 0),
          skipped: sessions.reduce((a, s) => a + s.skipped, 0),
        },
        sessions,
        activity: activity.slice(0, 20),
        lastSkip,
        defaults: DEFAULTS,
        sourceKind: SOURCE_KIND,
        // 数据从哪来的，说清楚，免得界面以为在读磁盘
        note: '这些是进程内的实时计数，不落盘；重启 DSH 后清零。',
      }
    },

    /** 运行时开关。 */
    setEnabled(on) {
      const next = on === true
      const changed = config.enabled !== next
      config = { ...config, enabled: next }
      logger?.info?.(`${SOURCE_KIND}: 自动继跑${next ? '已启用' : '已停用'}`)
      if (!next) {
        // 停用时把挂着的定时器清掉，免得开关关了还投递一次
        for (const st of states.values()) {
          if (st.timer !== null) { clearTimeout(st.timer); st.timer = null }
        }
      }
      return { ok: true, changed, enabled: config.enabled }
    },

    /** 改配置（部分字段）。 */
    configure(patch) {
      const before = { ...config }
      config = readConfig({ ...config, ...(patch ?? {}) })
      const changed = Object.keys(before).filter((k) => before[k] !== config[k])
      return { ok: true, changed, config: { ...config } }
    },

    /** 清掉计数（分批或整批）。 */
    reset(sessionId) {
      if (typeof sessionId === 'string' && sessionId !== '') {
        const had = states.delete(sessionId)
        return { ok: true, cleared: had ? 1 : 0, scope: sessionId }
      }
      const n = states.size
      states.clear()
      activity.length = 0
      lastSkip = null
      return { ok: true, cleared: n, scope: 'all' }
    },

    /** 仅供测试：直接喂一个会话事件。 */
    _handle: onSessionEvent,
    /** 仅供测试：看内部配置。 */
    _config: () => ({ ...config }),
  }
}
