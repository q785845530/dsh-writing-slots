/**
 * dsh-writing-slots — browser half（手写 ModuleLoader bundle，无构建步骤）。
 *
 * 在设置页左侧导航加一项「写作槽位」，右侧是六个槽位的操作面板：
 *   - 左栏：六个模块的卡片（就绪状态 + 触发时机 + 人工门禁）
 *   - 右栏：选中模块的**契约**（必填/自动注入/可选）与操作表单
 *   - 底部：渲染出来的提示词，可复制
 *
 * 数据走同源 `/api/dsh-writing-slots/*`（由 host 半提供），只用 shell 已经
 * 提供的 `react`，不依赖任何构建产物。颜色全部取自主题变量，明暗主题都不会坏。
 *
 * 一个刻意的取舍：这个面板**不代跑模型**。它渲染提示词、跑统计与校验，
 * 把结果摆出来。写正文、改写句子那些事由调用方（人或 agent）拿提示词去做。
 */
window.__ModuleLoader__.load({
  id: 'dsh-writing-slots',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'dsh-writing-slots'
    const LS_MODULE = `${NS}:last-module`

    // ————————————————————————— 样式 —————————————————————————

    const STYLES = `
.dws_root { display:flex; flex-direction:column; gap:12px; font-size:13px; }
.dws_tabs { display:flex; gap:6px; border-bottom:1px solid var(--dsh-border, rgba(128,128,128,.25)); padding-bottom:6px; margin-bottom:10px; }
.dws_tab {
  border:1px solid transparent; background:transparent; color:inherit; cursor:pointer;
  border-radius:6px; padding:4px 10px; font-size:12px; opacity:.7;
}
.dws_tab:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.14)); }
.dws_tab[data-on="1"] {
  opacity:1; border-color:var(--dsh-accent, #4a7dff);
  background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 14%, transparent);
}
.dws_cards { display:flex; gap:8px; flex-wrap:wrap; }
.dws_cardstat {
  border:1px solid var(--dsh-border, rgba(128,128,128,.25)); border-radius:6px;
  padding:6px 12px; min-width:78px; background:var(--dsh-surface, rgba(128,128,128,.05));
}
.dws_cardstat .n { font-size:17px; font-weight:600; }
.dws_cardstat .k { font-size:11px; opacity:.65; }
.dws_bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dws_btn {
  border:1px solid var(--dsh-border, rgba(128,128,128,.35));
  background:var(--dsh-surface, rgba(128,128,128,.08)); color:inherit;
  border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer;
}
.dws_btn:hover:not(:disabled) { background:var(--dsh-surface-hover, rgba(128,128,128,.16)); }
.dws_btn:disabled { opacity:.45; cursor:not-allowed; }
.dws_btn_primary { border-color:var(--dsh-accent, #4a7dff); }
.dws_btn_danger { border-color:#e05a5a; }
.dws_two { display:flex; gap:12px; align-items:flex-start; }
.dws_col { min-width:0; display:flex; flex-direction:column; gap:6px; }
.dws_col_left { flex:0 0 240px; max-height:62vh; overflow:auto; }
.dws_col_right { flex:1 1 auto; }
.dws_colhead {
  font-size:12px; font-weight:600; opacity:.75; padding:2px 0 4px;
  border-bottom:1px solid var(--dsh-border, rgba(128,128,128,.22));
}
.dws_card {
  display:flex; flex-direction:column; gap:3px; padding:8px 10px; border-radius:6px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.28));
  background:var(--dsh-surface, rgba(128,128,128,.05)); cursor:pointer;
}
.dws_card:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.14)); }
.dws_card[data-on="1"] { border-color:var(--dsh-accent, #4a7dff); }
.dws_card .t { font-size:13px; font-weight:600; }
.dws_card .m { font-size:11px; opacity:.62; }
.dws_badge { font-size:10px; padding:0 5px; border-radius:3px; background:rgba(128,128,128,.22); }
.dws_badge.ok { background:rgba(63,164,106,.25); }
.dws_badge.no { background:rgba(224,144,42,.22); }
.dws_field { display:flex; flex-direction:column; gap:3px; }
.dws_label { font-size:11px; opacity:.7; }
.dws_input, .dws_area {
  border:1px solid var(--dsh-border, rgba(128,128,128,.35));
  background:var(--dsh-surface, rgba(128,128,128,.08)); color:inherit;
  border-radius:6px; padding:5px 9px; font-size:12px; width:100%; box-sizing:border-box;
  font-family:inherit;
}
.dws_area { font-family:ui-monospace,monospace; min-height:70px; resize:vertical; }
.dws_pre {
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:11px; line-height:1.55; white-space:pre-wrap; word-break:break-word;
  background:var(--dsh-surface, rgba(128,128,128,.07)); border-radius:6px;
  padding:9px 11px; max-height:44vh; overflow:auto; margin:0;
  border:1px solid var(--dsh-border, rgba(128,128,128,.2));
}
.dws_note { font-size:11px; opacity:.65; line-height:1.6; }
.dws_err { color:#e05a5a; font-size:12px; }
.dws_ok { color:#3fa46a; font-size:12px; }
.dws_ctract { display:flex; flex-direction:column; gap:2px; font-size:11px; }
.dws_ctract code {
  font-family:ui-monospace,monospace; background:rgba(128,128,128,.12);
  padding:0 4px; border-radius:3px;
}
.dws_toast {
  position:fixed; right:20px; bottom:20px; z-index:9999; max-width:420px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.35)); border-radius:8px;
  background:var(--dsh-surface, #2a2a2e); color:inherit; padding:11px 14px;
  font-size:13px; line-height:1.5; box-shadow:0 6px 24px rgba(0,0,0,.28); white-space:pre-wrap;
}
.dws_toast.ok { border-left:3px solid #3fa46a; }
.dws_toast.err { border-left:3px solid #e05a5a; }
@media (max-width: 760px) {
  .dws_two { flex-direction:column; }
  .dws_col_left, .dws_col_right { width:100%; flex:1 1 auto; }
  .dws_col_left { max-height:34vh; }
}
`

    // ————————————————————————— 小工具 —————————————————————————

    async function api(path, payload) {
      const init = payload === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      let res
      try {
        res = await fetch(`/api/dsh-writing-slots${path}`, init)
      } catch (err) {
        throw new Error(`无法连接 DSH 主机：${err?.message ?? String(err)}`)
      }
      let data = null
      try { data = await res.json() } catch { /* 非 JSON */ }
      if (data === null) throw new Error(`请求失败（HTTP ${res.status}）`)
      // 后端有时用 { error } 有时用 { reason }，两个都认
      if (data.error) throw new Error(data.error)
      if (data.ok === false && data.reason) throw new Error(data.reason)
      return data
    }

    function Card({ n, k }) {
      return h('div', { className: 'dws_cardstat' },
        h('div', { className: 'n' }, String(n ?? '—')),
        h('div', { className: 'k' }, k))
    }

    function Toast({ toast, onDone }) {
      useEffect(() => {
        if (toast === null) return undefined
        const t = setTimeout(() => onDone(), 6000)
        return () => clearTimeout(t)
      }, [toast, onDone])
      if (toast === null) return null
      return h('div', { className: `dws_toast ${toast.ok ? 'ok' : 'err'}` }, toast.text)
    }

    // ————————————————————————— 六个模块的面板 —————————————————————————

    /**
     * 每个模块的「要填什么」与「怎么调」。
     *
     * 写成数据而不是六段 if：加一个模块只要加一条，界面自动出来。
     */
    const PANELS = {
      style_anchor: {
        hint: '项目初始化时跑一次。样本要在 3—5 篇、总计 5 万字以上，否则会被拒绝产出。',
        fields: [
          { key: 'samples', label: '样本文件路径（每行一个）', type: 'area', placeholder: '/path/to/sample1.md\n/path/to/sample2.md' },
          { key: 'genreTags', label: '体裁标签（可选）', type: 'input', placeholder: '古代种田 / 修仙底层' },
        ],
        run: async (v) => {
          const samples = String(v.samples ?? '').split('\n').map((x) => x.trim()).filter((x) => x !== '')
          return api('/style-anchor', { samples, genreTags: v.genreTags || undefined })
        },
        render: (r) => `${r.sampleCount} 篇样本，共 ${r.totalChars} 字\n\n${r.markdown ?? ''}`,
        // 有落盘动作的模块单独给按钮
        save: { label: '写盘成 style-guide.md', build: (r) => ({ markdown: r.markdown, confirm: true }), path: '/style-anchor/save' },
      },
      world_builder: {
        hint: '正文动笔前跑。力量体系必须写明使用代价与限制，缺一会被打回。',
        fields: [{ key: 'genre', label: '题材', type: 'input', placeholder: '古代种田 / 修仙底层' }],
        run: async (v) => api('/world-builder', { genre: v.genre }),
        render: (r) => r.prompt ?? '',
        validate: { label: '校验产出（把 markdown 贴进来）', path: '/world-builder', wrap: (text) => ({ validate: text }) },
      },
      character_designer: {
        hint: '表面欲望 / 真实需求 / 致命缺陷三者必须冲突 —— 这条机器判不了，要人读。',
        fields: [
          { key: 'character', label: '角色名', type: 'input', placeholder: '吴常' },
          { key: 'role', label: '定位（可选）', type: 'input', placeholder: '主角 / 反派 / 配角' },
        ],
        run: async (v) => api('/character-designer', { character: v.character, role: v.role || undefined }),
        render: (r) => r.prompt ?? '',
        validate: { label: '校验产出（把人物卡贴进来）', path: '/character-designer', wrap: (text) => ({ validate: text }) },
      },
      reader_sim: {
        hint: '初稿完成后、**Review Pass 之前**跑（审稿会改稿，改完就不是「第一次翻开」了）。'
          + '三个读者各自单独跑一次，不要在同一个会话里让他们轮流说 —— 那样会互相影响。',
        fields: [
          { key: 'chapterNo', label: '章号', type: 'input', placeholder: '25' },
          { key: 'readers', label: '只跑某几个读者（逗号分隔，留空全跑）', type: 'input', placeholder: 'commuter / rereader / harsh' },
        ],
        run: async (v) => api(`/reader-sim?chapterNo=${encodeURIComponent(v.chapterNo)}&readers=${encodeURIComponent(v.readers ?? '')}`),
        render: (r) => (r.prompts ?? []).map((p) => `===== ${p.title}（${p.name}）｜测：${p.tests} =====\n${p.prompt ?? ''}`).join('\n\n'),
        validate: { label: '校验一个读者的产出（贴进来）', path: '/reader-sim/validate', wrap: (t) => ({ payload: t }) },
      },
      chapter_pack: {
        hint: '每章动笔前。细纲里缺「任务」或「钩子」会直接报缺，不拿别的字段顶替。',
        fields: [
          { key: 'chapterNo', label: '章号', type: 'input', placeholder: '25' },
          { key: 'cast', label: '出场人物（顿号分隔，可选）', type: 'input', placeholder: '吴常、孟大、宋平' },
        ],
        run: async (v) => api(`/chapter-pack?chapterNo=${encodeURIComponent(v.chapterNo)}&cast=${encodeURIComponent(v.cast ?? '')}`),
        render: (r) => r.prompt ?? '',
      },
      sanity: {
        hint: '不需要模型判断的硬检查：截断（结尾没收尾、引号没关）、工程词泄漏（「本章」「伏笔」这类给作者看的词跑进正文）、占位符没替换。critical 一律阻断。',
        fields: [{ key: 'chapterNo', label: '章号', type: 'input', placeholder: '25' }],
        run: async (v) => api('/sanity', { chapterNo: Number(v.chapterNo) }),
        render: (r) => r.formatted ?? '',
      },
      review_pass: {
        hint: '在独立上下文里跑。提示词里**只有**初稿、设定快照、上一章摘要 —— 没有风格指南，也没有章节任务。',
        fields: [{ key: 'chapterNo', label: '章号', type: 'input', placeholder: '25' }],
        run: async (v) => api(`/review-pass?chapterNo=${encodeURIComponent(v.chapterNo)}`),
        render: (r) => r.prompt ?? '',
        validate: { label: '校验审稿结果（把 JSON 贴进来）', path: '/review-pass/validate', wrap: (text) => ({ payload: text }) },
      },
      deai_polish: {
        hint: '最后一刀。系统先扫描出逐条违规证据，再渲染成「只改这些点」的提示词。',
        fields: [{ key: 'chapterNo', label: '章号', type: 'input', placeholder: '25' }],
        run: async (v) => api(`/deai-polish?chapterNo=${encodeURIComponent(v.chapterNo)}`),
        render: (r) => {
          if (r.prompt === undefined || r.prompt === null) return ''
          const head = `系统扫描命中 ${r.scan?.totalHits ?? 0} 处`
          return `${head}\n\n${r.prompt}`
        },
        verify: { label: '复验（贴改前/改后，用 --- 分隔）', path: '/deai-polish/verify' },
      },
    }

    // ————————————————————————— 主面板 —————————————————————————

    /**
     * 顶层页签。自动继跑停用时**不出现** —— 这是刻意的：
     * 一个不工作的功能不该占着导航。
     */
    function Shell() {
      const [tab, setTab] = useState('slots')
      const [ac, setAc] = useState(null)

      const loadAc = useCallback(async () => {
        try { setAc(await api('/auto-continue')) } catch { setAc(null) }
      }, [])
      useEffect(() => { loadAc() }, [loadAc])

      const tabs = [['slots', '写作槽位']]
      if (ac?.enabled === true) tabs.push(['auto-continue', '自动继跑'])

      // 停用后如果正停在该页签，回到写作槽位
      useEffect(() => {
        if (tab === 'auto-continue' && ac !== null && ac.enabled !== true) setTab('slots')
      }, [tab, ac])

      return h('div', null,
        h('div', { className: 'dws_tabs' },
          tabs.map(([id, label]) => h('button', {
            key: id, className: 'dws_tab', 'data-on': tab === id ? '1' : '0',
            onClick: () => setTab(id),
          }, label))),
        tab === 'auto-continue'
          ? h(AutoContinuePanel, { status: ac, onReload: loadAc })
          : h(SlotsPanel, {}),
      )
    }

    /** 自动继跑页签：开关 + 配置 + 实时计数 + 活动记录。 */
    function AutoContinuePanel({ status, onReload }) {
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [form, setForm] = useState(null)
      const say = useCallback((text, okk = true) => setToast({ text, ok: okk }), [])

      useEffect(() => {
        if (status !== null && form === null) setForm({ ...status.config })
      }, [status, form])

      const call = useCallback(async (path, body, okText) => {
        setBusy(path)
        try {
          const r = await api(path, body)
          await onReload()
          setErr('')
          if (okText !== undefined) say(okText, true)
          return r
        } catch (e) { setErr(e.message); say(e.message, false); return null }
        finally { setBusy('') }
      }, [onReload, say])

      if (status === null) return h('div', { className: 'dws_root' }, h('div', { className: 'dws_note' }, '读取中…'))

      const t = status.totals ?? {}
      const cfg = form ?? status.config

      return h('div', { className: 'dws_root' },
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', onClick: onReload, disabled: busy !== '' }, '刷新'),
          h('span', { className: `dws_badge ${status.enabled ? 'ok' : 'no'}` }, status.enabled ? '运行中' : '已停用'),
          h('button', {
            className: status.enabled ? 'dws_btn dws_btn_danger' : 'dws_btn dws_btn_primary',
            disabled: busy !== '',
            onClick: async () => {
              const r = await call('/auto-continue/toggle', { enabled: !status.enabled },
                status.enabled ? '已停用（页签将消失）' : '已启用')
              if (r !== null) setForm(null)
            },
          }, status.enabled ? '停用' : '启用'),
          h('button', { className: 'dws_btn', onClick: () => call('/auto-continue/reset', {}, '已清零'), disabled: busy !== '' }, '清零计数'),
        ),

        h('div', { className: 'dws_note' },
          '模型一轮输出撞到字数上限（max-tokens）被截断时，自动往同一会话注入「继续写」并唤醒下一轮 —— 不用手动敲「继续」。'
          + '官方 goal-round-driver 见到 max-tokens 会停手，社区 continue 插件对该原因明确 skip，所以这个场景得自己补。'),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        h('div', { className: 'dws_cards' },
          h(Card, { n: t.followups ?? 0, k: '累计续写' }),
          h(Card, { n: t.sessions ?? 0, k: '涉及会话' }),
          h(Card, { n: t.skipped ?? 0, k: '跳过（去抖/达上限）' }),
        ),

        h('div', { className: 'dws_colhead' }, '配置'),
        h('div', { className: 'dws_ctract' },
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '注入的续写文本'),
            h('input', {
              className: 'dws_input', value: cfg.prompt ?? '',
              onChange: (e) => setForm({ ...cfg, prompt: e.target.value }),
            })),
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, `去抖最小间隔（毫秒，默认 ${status.defaults?.minGapMs ?? 2000}）`),
            h('input', {
              className: 'dws_input', type: 'number', value: cfg.minGapMs ?? 2000,
              onChange: (e) => setForm({ ...cfg, minGapMs: Number(e.target.value) }),
            })),
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '每会话上限（0 = 不限）'),
            h('input', {
              className: 'dws_input', type: 'number', value: cfg.maxFollowupsPerSession ?? 0,
              onChange: (e) => setForm({ ...cfg, maxFollowupsPerSession: Number(e.target.value) }),
            })),
          h('div', { className: 'dws_field' },
            h('label', { className: 'dws_label' },
              h('input', {
                type: 'checkbox', checked: cfg.notify === true,
                onChange: (e) => setForm({ ...cfg, notify: e.target.checked }),
              }),
              ' 在会话里贴续写通知')),
        ),
        h('div', { className: 'dws_bar' },
          h('button', {
            className: 'dws_btn dws_btn_primary', disabled: busy !== '',
            onClick: () => call('/auto-continue/config', cfg, '配置已更新'),
          }, busy === '/auto-continue/config' ? '保存中…' : '保存配置'),
          h('button', { className: 'dws_btn', onClick: () => setForm({ ...status.defaults }), disabled: busy !== '' }, '恢复默认'),
        ),

        (status.sessions ?? []).length > 0
          ? h('div', null,
            h('div', { className: 'dws_colhead' }, '各会话计数'),
            h('div', { className: 'dws_pre' },
              (status.sessions ?? []).slice(0, 20).map((x) =>
                `${x.session}　${x.followups} 次${x.skipped ? `（跳过 ${x.skipped}）` : ''}${x.pending ? '　⏳ 有挂起投递' : ''}${x.lastAt ? `　${new Date(x.lastAt).toLocaleTimeString('zh-CN')}` : ''}`).join('\n')))
          : null,

        (status.activity ?? []).length > 0
          ? h('div', null,
            h('div', { className: 'dws_colhead' }, '最近活动'),
            h('div', { className: 'dws_pre' },
              (status.activity ?? []).map((x) => {
                const kind = { followup: '续写', capped: '达上限', failed: '失败', lost: '会话不在了' }[x.kind] ?? x.kind
                return `${new Date(x.at).toLocaleTimeString('zh-CN')}　${kind}${x.count ? ` #${x.count}` : ''}${x.session ? `　${x.session}` : ''}${x.detail ? `　${x.detail}` : ''}`
              }).join('\n')))
          : h('div', { className: 'dws_note' }, '还没有活动记录。'),

        status.lastSkip !== null && status.lastSkip !== undefined
          ? h('div', { className: 'dws_note' }, `上次跳过：${status.lastSkip.reason}（${new Date(status.lastSkip.at).toLocaleTimeString('zh-CN')}）`)
          : null,

        h('div', { className: 'dws_note' },
          `${status.note ?? ''}　生产者 kind：${status.sourceKind ?? ''}`),

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    function SlotsPanel() {
      const [status, setStatus] = useState(null)
      const [modules, setModules] = useState([])
      const [sel, setSel] = useState(() => {
        try { return window.localStorage.getItem(LS_MODULE) ?? 'style_anchor' } catch { return 'style_anchor' }
      })
      const [values, setValues] = useState({})
      const [out, setOut] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [validateText, setValidateText] = useState('')
      const say = useCallback((text, okk = true) => setToast({ text, ok: okk }), [])

      useEffect(() => { try { window.localStorage.setItem(LS_MODULE, sel) } catch { /* ignore */ } }, [sel])

      const load = useCallback(async () => {
        setBusy('load')
        try {
          const [st, md] = await Promise.all([api('/status'), api('/modules')])
          setStatus(st)
          setModules(md.modules ?? [])
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [])

      useEffect(() => { load() }, [load])

      const panel = PANELS[sel]
      const mod = modules.find((m) => m.id === sel)
      const stateOf = status?.modules?.find((m) => m.id === sel)

      const setValue = (k, v) => setValues((prev) => ({ ...prev, [k]: v }))

      const run = useCallback(async () => {
        if (panel === undefined) return
        setBusy('run')
        try {
          const r = await panel.run(values)
          setOut({ kind: 'run', r })
          setErr('')
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [panel, values, say])

      const doSave = useCallback(async () => {
        if (panel?.save === undefined || out?.kind !== 'run') return
        if (!window.confirm('写到项目里？')) return
        setBusy('save')
        try {
          const r = await api(panel.save.path, panel.save.build(out.r))
          say(`已写入：${r.path}`, true)
          await load()
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [panel, out, load, say])

      const doValidate = useCallback(async () => {
        if (panel?.validate === undefined) return
        if (validateText.trim() === '') { say('先把内容贴进来', false); return }
        setBusy('validate')
        try {
          const r = await api(panel.validate.path, panel.validate.wrap(validateText))
          setOut({ kind: 'validate', r })
          setErr('')
          say(r.ok === true ? '校验通过' : `校验有 ${(r.errors ?? []).length} 处问题`, r.ok === true)
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [panel, validateText, say])

      const doVerify = useCallback(async () => {
        const idx = validateText.indexOf('---')
        if (idx < 0) { say('用 --- 把改前和改后分开', false); return }
        const before = validateText.slice(0, idx).trim()
        const after = validateText.slice(idx + 3).trim()
        setBusy('verify')
        try {
          const r = await api('/deai-polish/verify', { before, after })
          setOut({ kind: 'verify', r })
          setErr('')
          say(r.accepted === true ? '复验通过' : '复验未通过', r.accepted === true)
        } catch (e) { setErr(e.message); say(e.message, false) }
        finally { setBusy('') }
      }, [validateText, say])

      const copy = useCallback(async (text) => {
        try {
          if (navigator.clipboard?.writeText !== undefined) {
            await navigator.clipboard.writeText(text); say('已复制', true); return
          }
          throw new Error('no clipboard')
        } catch {
          say(`复制不了，请手动选中：\n${text.slice(0, 120)}…`, false)
        }
      }, [say])

      /** 把后端返回的东西渲染成给人看的文本。 */
      const outText = () => {
        if (out === null) return ''
        const r = out.r
        if (out.kind === 'run') return panel?.render !== undefined ? panel.render(r) : JSON.stringify(r, null, 2)
        if (out.kind === 'verify') {
          return [
            r.accepted === true ? '复验通过：命中清零、节奏达标。' : '复验**未通过**。',
            `命中条目：${r.before?.hits} → ${r.after?.hits}`,
            `短句占比：${r.before?.shortRatio} → ${r.after?.shortRatio}`,
            `字数变化：${r.charDelta > 0 ? '+' : ''}${r.charDelta}`,
            r.improved === false ? '⚠ 改动引入了新毛病（命中变多）—— 建议回退。' : null,
            r.rhythm === null ? null : `⚠ 节奏仍不达标：${r.rhythm}`,
            ...(r.remaining ?? []).map((x) => `- [${x.id}] ${x.rule} ×${x.count}`),
          ].filter((x) => x !== null).join('\n')
        }
        // validate
        const lines = [r.ok === true ? '校验通过。' : `有 ${(r.errors ?? []).length} 处不合契约：`]
        for (const e of r.errors ?? []) lines.push(`- ${e}`)
        for (const w of r.warnings ?? []) lines.push(`⚠ ${w}`)
        if (r.needsHumanCheck !== undefined) lines.push('', `⚠ ${r.needsHumanCheck}`)
        if (r.verdict !== undefined) lines.push(`门禁结论：${r.verdict}`)
        if (r.uncovered?.length > 0) lines.push(`⚠ 未覆盖的维度：${r.uncovered.join('、')}`)
        for (const f of r.findings ?? []) {
          lines.push(`${f.severity === 'fatal' ? '⛔' : f.severity === 'warning' ? '⚠' : '✓'} [${f.severity}] ${f.dimension}｜${f.location ?? ''}\n    ${f.finding}${f.action ? `\n    改法：${f.action}` : ''}`)
        }
        return lines.join('\n')
      }

      const text = outText()

      return h('div', { className: 'dws_root' },
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', onClick: load, disabled: busy !== '' },
            busy === 'load' ? '读取中…' : '刷新'),
          status !== null ? h('span', { className: 'dws_note' }, `项目：${status.project}`) : null,
          status?.pending !== undefined && status.pending !== null
            ? h('span', { className: 'dws_note' }, `待续写：${status.pending}`)
            : null,
        ),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        h('div', { className: 'dws_two' },
          // —— 左栏：六个模块 ——
          h('div', { className: 'dws_col dws_col_left' },
            h('div', { className: 'dws_colhead' }, `槽位（${status?.modules?.length ?? 0}）`),
            (status?.modules ?? []).map((m) => {
              const meta = modules.find((x) => x.id === m.id)
              return h('div', {
                key: m.id, className: 'dws_card', 'data-on': sel === m.id ? '1' : '0',
                onClick: () => { setSel(m.id); setOut(null); setValidateText('') },
              },
              h('div', { className: 't' }, meta?.title ?? m.id),
              h('div', { className: 'm' },
                h('span', { className: `dws_badge${m.ready ? ' ok' : ' no'}` }, m.ready ? '就绪' : '未就绪')),
              h('div', { className: 'm' }, m.note),
              )
            })),

          // —— 右栏：选中模块 ——
          h('div', { className: 'dws_col dws_col_right' },
            h('div', { className: 'dws_colhead' }, mod?.title ?? sel),
            mod !== undefined
              ? h('div', { className: 'dws_ctract' },
                h('div', null, `触发：${mod.runsWhen}`),
                h('div', null, `产物：${mod.output}`),
                h('div', null, `门禁：${mod.gate}`),
                h('div', null, '必填：', ...(mod.contract.required ?? []).map((x) => h('code', { key: x }, x))),
                h('div', null, '自动注入：', ...(mod.contract.auto_injected ?? []).map((x) => h('code', { key: x }, x))),
                (mod.contract.optional ?? []).length > 0
                  ? h('div', null, '可选：', ...mod.contract.optional.map((x) => h('code', { key: x }, x)))
                  : null,
              )
              : null,

            panel !== undefined ? h('div', { className: 'dws_note' }, panel.hint) : null,

            // 表单
            ...(panel?.fields ?? []).map((f) => h('div', { key: f.key, className: 'dws_field' },
              h('div', { className: 'dws_label' }, f.label),
              f.type === 'area'
                ? h('textarea', {
                  className: 'dws_area', placeholder: f.placeholder ?? '',
                  value: values[f.key] ?? '',
                  onChange: (e) => setValue(f.key, e.target.value),
                })
                : h('input', {
                  className: 'dws_input', placeholder: f.placeholder ?? '',
                  value: values[f.key] ?? '',
                  onChange: (e) => setValue(f.key, e.target.value),
                }))),

            h('div', { className: 'dws_bar' },
              h('button', { className: 'dws_btn dws_btn_primary', onClick: run, disabled: busy !== '' },
                busy === 'run' ? '生成中…' : '生成提示词'),
              stateOf?.ready !== true
                ? h('span', { className: 'dws_note' }, '（该槽位未就绪，可能仍会报缺）')
                : null,
              out?.kind === 'run' && panel?.save !== undefined
                ? h('button', { className: 'dws_btn', onClick: doSave, disabled: busy !== '' },
                  busy === 'save' ? '写入中…' : panel.save.label)
                : null,
            ),

            // 校验 / 复验
            panel?.validate !== undefined || panel?.verify !== undefined
              ? h('div', null,
                h('div', { className: 'dws_label' },
                  panel.validate?.label ?? panel.verify?.label ?? ''),
                h('textarea', {
                  className: 'dws_area',
                  placeholder: panel.verify !== undefined ? '改前正文\n---\n改后正文' : '把产出贴进来',
                  value: validateText,
                  onChange: (e) => setValidateText(e.target.value),
                }),
                h('div', { className: 'dws_bar' },
                  panel.validate !== undefined
                    ? h('button', { className: 'dws_btn', onClick: doValidate, disabled: busy !== '' },
                      busy === 'validate' ? '校验中…' : '校验')
                    : null,
                  panel.verify !== undefined
                    ? h('button', { className: 'dws_btn', onClick: doVerify, disabled: busy !== '' },
                      busy === 'verify' ? '复验中…' : '复验')
                    : null))
              : null,

            // 输出
            text !== ''
              ? h('div', null,
                h('div', { className: 'dws_bar' },
                  h('div', { className: 'dws_label' }, out?.kind === 'run' ? '渲染结果' : '校验结果'),
                  h('button', { className: 'dws_btn', onClick: () => copy(text) }, '复制')),
                h('pre', { className: 'dws_pre' }, text))
              : h('div', { className: 'dws_note' }, '填好上面的字段，点「生成提示词」。'),
          ),
        ),

        h('div', { className: 'dws_note' },
          '这个面板不代跑模型：它渲染提示词、跑统计与结构校验，把结果摆出来。'
          + '写正文、改写句子那一步由调用方拿着提示词去做。'
          + '所有槽位契约在渲染前校验 —— 缺必填或模板拼错名会直接失败，不会渲染出半成品。'),

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    // ————————————————————————— 插件入口 —————————————————————————

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', NS)
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => { if (tag.parentNode !== null) tag.parentNode.removeChild(tag) }
      }, `${NS}: styles`)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'writing-slots',
        order: 21,
        label: () => '写作槽位',
      }, Shell))
    }

    module.exports = { name: NS, inject: ['slots'], apply }
    return module.exports
  },
})
