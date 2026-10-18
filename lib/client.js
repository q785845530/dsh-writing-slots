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

    /**
     * localStorage 读写（带容量保护）。
     *
     * 阅读器要记住搜索结果的阅读进度，这些可能不小 —— 配额满了要**静默降级**，
     * 不能因为存不进就把界面搞崩。
     */
    function lsGetJSON(key, fallback = null) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null || raw === '') return fallback
        const parsed = JSON.parse(raw)
        return parsed ?? fallback
      } catch { return fallback }
    }
    function lsSetJSON(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
        return true
      } catch (e) {
        // 多半是超配额：把这条键清掉，避免它一直占着位置
        try { window.localStorage.removeItem(key) } catch { /* 忽略 */ }
        return false
      }
    }
    function lsDel(key) { try { window.localStorage.removeItem(key) } catch { /* 忽略 */ } }

    /** 类型 → 中文（槽位面板里也要用，不依赖指令库接口有没有加载）。 */
    const LIB_KIND_LABEL = { rule: '硬规则', style: '文风', structure: '结构', character: '人物', trope: '桥段', material: '素材' }
    const libKindLabel = (k) => LIB_KIND_LABEL[k] ?? k

    const LS_READER_SEARCH = `${NS}:reader:search`
    const LS_READER_SESSION = `${NS}:reader:session`
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
.dws_liblist { display:flex; flex-direction:column; gap:4px; max-height:42vh; overflow:auto; }
.dws_libitem {
  display:flex; gap:9px; align-items:flex-start; padding:6px 9px; border-radius:6px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.22));
  background:var(--dsh-surface, rgba(128,128,128,.04));
}
.dws_libitem.on { border-color:var(--dsh-accent, #4a7dff); background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 8%, transparent); }
.dws_libmain { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.dws_libname { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:13px; }
.dws_libsum { font-size:11px; opacity:.72; }
.dws_libmeta { display:flex; gap:9px; font-size:10px; opacity:.55; flex-wrap:wrap; }
.dws_libacts { display:flex; gap:3px; flex:0 0 auto; }
.dws_lm {
  border:1px solid var(--dsh-border, rgba(128,128,128,.3)); border-radius:8px;
  padding:9px 11px; display:flex; flex-direction:column; gap:7px;
  background:var(--dsh-surface, rgba(128,128,128,.05));
}
.dws_area_sm { min-height:52px; }
.dws_chunks { display:flex; gap:4px; flex-wrap:wrap; max-height:14vh; overflow:auto; padding:4px 0; }
.dws_chip.on { border-color:var(--dsh-accent, #4a7dff); background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 18%, transparent); font-weight:600; }
.dws_slotlib {
  border:1px solid var(--dsh-border, rgba(128,128,128,.25)); border-radius:7px;
  padding:8px 10px; display:flex; flex-direction:column; gap:6px;
  background:var(--dsh-surface, rgba(128,128,128,.04));
}
.dws_edit {
  border:1px solid var(--dsh-accent, #4a7dff); border-radius:7px; padding:9px;
  display:flex; flex-direction:column; gap:6px;
  background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 5%, transparent);
}
.dws_inv {
  border:1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius:8px;
  padding:8px 11px; display:flex; flex-direction:column; gap:6px;
  background:var(--dsh-surface, rgba(128,128,128,.05));
}
.dws_invHead { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dws_invPath { font-size:11px; opacity:.75; font-family:ui-monospace,monospace; word-break:break-all; }
.dws_invRow { display:flex; gap:6px; flex-wrap:wrap; }
.dws_next {
  display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px;
  border-left:3px solid var(--dsh-accent, #4a7dff); padding:5px 9px;
  background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 8%, transparent);
  border-radius:5px;
}
.dws_tochint { display:flex; gap:4px; flex-wrap:wrap; max-height:13vh; overflow:auto; }
.dws_chip {
  font-size:11px; padding:2px 7px; border-radius:10px; cursor:pointer;
  border:1px solid var(--dsh-border, rgba(128,128,128,.3));
  background:var(--dsh-surface, rgba(128,128,128,.07));
}
.dws_chip:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.18)); }
.dws_reader { display:flex; gap:10px; align-items:flex-start; margin-top:8px; }
.dws_nav { padding:6px 0; }
.dws_results { display:flex; flex-direction:column; gap:3px; max-height:46vh; overflow:auto; margin-top:6px; }
.dws_result {
  border:1px solid var(--dsh-border, rgba(128,128,128,.22)); border-radius:6px;
  padding:5px 9px; cursor:pointer; display:flex; flex-direction:column; gap:2px;
  background:var(--dsh-surface, rgba(128,128,128,.04));
}
.dws_result:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.16)); }
.dws_resultTitle { font-size:13px; font-weight:600; }
.dws_resultMeta { display:flex; gap:6px; align-items:center; font-size:11px; opacity:.7; }
.dws_chat {
  flex:1 1 auto; min-width:0; max-height:52vh; overflow:auto;
  display:flex; flex-direction:column; gap:8px; padding:4px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.2)); border-radius:8px;
}
.dws_msg { max-width:88%; padding:7px 11px; border-radius:9px; font-size:13px; line-height:1.75; }
.dws_msg.me { align-self:flex-end; background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 16%, transparent); }
.dws_msg.ai { align-self:flex-start; background:var(--dsh-surface, rgba(128,128,128,.09)); }
.dws_msgtext { white-space:pre-wrap; word-break:break-word; }
.dws_msgbar { display:flex; gap:5px; align-items:center; margin-bottom:5px; flex-wrap:wrap; }
.dws_cmdbar { display:flex; gap:6px; margin-top:8px; }
.dws_toc { flex:0 0 210px; max-height:52vh; overflow:auto; border-left:1px solid var(--dsh-border, rgba(128,128,128,.2)); padding-left:9px; }
.dws_toclist { display:flex; flex-direction:column; gap:2px; max-height:44vh; overflow:auto; }
.dws_tocitem { padding:3px 7px; border-radius:5px; cursor:pointer; font-size:12px; display:flex; gap:6px; align-items:center; }
.dws_tocitem:hover { background:var(--dsh-surface-hover, rgba(128,128,128,.14)); }
.dws_tocitem[data-on="1"] { background:color-mix(in srgb, var(--dsh-accent, #4a7dff) 16%, transparent); font-weight:600; }
@media (max-width: 760px) { .dws_reader { flex-direction:column; } .dws_toc { flex:1 1 auto; width:100%; border-left:none; } }
.dws_grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; }
.dws_rule {
  border:1px solid var(--dsh-border, rgba(128,128,128,.25)); border-radius:6px;
  padding:7px 9px; display:flex; flex-direction:column; gap:6px;
  background:var(--dsh-surface, rgba(128,128,128,.04));
}
.dws_rulehead { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.dws_rulehead select, .dws_rulehead input { flex:0 1 auto; width:auto; min-width:96px; }
.dws_rulehead .dws_num { width:70px; min-width:70px; }
.dws_arrow { opacity:.5; }
.dws_btnicon { padding:2px 7px; line-height:1.2; }
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
     * 顶层页签。自动续跑停用时**不出现** —— 这是刻意的：
     * 一个不工作的功能不该占着导航。
     */
    function Shell() {
      const [tab, setTab] = useState('slots')
      const [ac, setAc] = useState(null)

      const loadAc = useCallback(async () => {
        try { setAc(await api('/auto-continue')) } catch { setAc(null) }
      }, [])
      useEffect(() => { loadAc() }, [loadAc])

      const tabs = [['slots', '写作槽位'], ['library', '指令库'], ['reader', '阅读器'], ['workspace', '工作目录'], ['sites', '小说网站']]
      if (ac?.enabled === true) tabs.push(['auto-continue', '自动续跑'])

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
        tab === 'auto-continue' ? h(AutoContinuePanel, { status: ac, onReload: loadAc })
          : tab === 'workspace' ? h(WorkspacePanel, {})
            : tab === 'sites' ? h(SitesPanel, {})
              : tab === 'library' ? h(LibraryPanel, {})
                : tab === 'reader' ? h(ReaderPanel, {})
                : h(SlotsPanel, {}),
      )
    }

    /**
     * 自动续跑页签：开关 + 基础配置 + **有序规则表编辑** + 实时计数 + 活动日志。
     *
     * 规则表是这块的核心：不同失败类型走不同策略，从上到下先命中先用。
     * 编辑方式刻意做成「一行一条 + 上移下移」，因为**顺序即优先级** ——
     * 顺序错了策略就错了，这点必须让人看得见。
     */
    function AutoContinuePanel({ status, onReload }) {
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [form, setForm] = useState(null)
      const [rules, setRules] = useState(null)
      const [models, setModels] = useState(null)
      const say = useCallback((text, okk = true) => setToast({ text, ok: okk }), [])

      useEffect(() => {
        if (status !== null && form === null) {
          setForm({
            prompt: status.config.prompt,
            maxAttempts: status.config.maxAttempts,
            cooldownMs: status.config.cooldownMs,
            backoffBaseMs: status.config.backoffBaseMs,
            backoffMaxMs: status.config.backoffMaxMs,
            notifyOnCap: status.config.notifyOnCap,
          })
        }
        if (status !== null && rules === null) setRules(status.config.rules.map((r) => ({ ...r })))
      }, [status, form, rules])

      const loadModels = useCallback(async () => {
        if (models !== null) return
        try { setModels(await api('/auto-continue/models')) } catch { setModels({ providers: [], models: {} }) }
      }, [models])

      const call = useCallback(async (path, body, okText, method) => {
        setBusy(path)
        try {
          const r = method === 'GET' ? await api(path) : await api(path, body)
          await onReload()
          setErr('')
          if (okText !== undefined) say(okText, true)
          return r
        } catch (e) { setErr(e.message); say(e.message, false); return null }
        finally { setBusy('') }
      }, [onReload, say])

      if (status === null) return h('div', { className: 'dws_root' }, h('div', { className: 'dws_note' }, '读取中…'))

      const t = status.totals ?? {}
      const WL = status.whenLabels ?? {}
      const AL = status.actionLabels ?? {}
      const list = rules ?? []

      const patchRule = (i, patch) => setRules(list.map((r, k) => (k === i ? { ...r, ...patch } : r)))
      const move = (i, d) => {
        const j = i + d
        if (j < 0 || j >= list.length) return
        const next = list.slice()
        const tmp = next[i]; next[i] = next[j]; next[j] = tmp
        setRules(next)
      }
      const addRule = () => setRules([...list, { id: `r-${Date.now().toString(36)}`, when: 'status', action: 'continue', provider: '', model: '', maxAttempts: 0, codes: '' }])
      const delRule = (i) => setRules(list.filter((_, k) => k !== i))

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
          '会话中断后自动续上，不用手敲「继续」。按失败类型路由：限流退避重试、额度/鉴权止损、'
          + '上下文超限自动压缩后续跑、崩溃孤儿轮与输出截断自动继续、可自定义状态码、失败后自动换模型。'),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        h('div', { className: 'dws_cards' },
          h(Card, { n: t.continues ?? 0, k: '累计续跑' }),
          h(Card, { n: t.sessions ?? 0, k: '涉及会话' }),
          h(Card, { n: (status.config?.rules ?? []).length, k: '规则条数' }),
          h(Card, { n: status.compactionArmed ? '是' : '否', k: '压缩后端已挂载' }),
        ),

        // —— 基础配置 ——
        h('div', { className: 'dws_colhead' }, '基础配置'),
        h('div', { className: 'dws_grid' },
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '注入的续跑文本'),
            h('input', { className: 'dws_input', value: form?.prompt ?? '', onChange: (e) => setForm({ ...form, prompt: e.target.value }) })),
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '每会话上限（次）'),
            h('input', { className: 'dws_input', type: 'number', value: form?.maxAttempts ?? 50, onChange: (e) => setForm({ ...form, maxAttempts: Number(e.target.value) }) })),
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '冷却（毫秒）'),
            h('input', { className: 'dws_input', type: 'number', value: form?.cooldownMs ?? 5000, onChange: (e) => setForm({ ...form, cooldownMs: Number(e.target.value) }) })),
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '退避基数（毫秒）'),
            h('input', { className: 'dws_input', type: 'number', value: form?.backoffBaseMs ?? 2000, onChange: (e) => setForm({ ...form, backoffBaseMs: Number(e.target.value) }) })),
          h('div', { className: 'dws_field' },
            h('div', { className: 'dws_label' }, '退避上限（毫秒）'),
            h('input', { className: 'dws_input', type: 'number', value: form?.backoffMaxMs ?? 30000, onChange: (e) => setForm({ ...form, backoffMaxMs: Number(e.target.value) }) })),
        ),
        h('label', { className: 'dws_label' },
          h('input', { type: 'checkbox', checked: form?.notifyOnCap === true, onChange: (e) => setForm({ ...form, notifyOnCap: e.target.checked }) }),
          ' 达上限时在会话里通知'),
        h('div', { className: 'dws_bar' },
          h('button', {
            className: 'dws_btn dws_btn_primary', disabled: busy !== '' || form === null,
            onClick: () => call('/auto-continue/config', { ...form, ...(rules !== null ? { rules } : {}) }, '配置与规则表已保存'),
          }, busy === '/auto-continue/config' ? '保存中…' : '保存配置与规则'),
          h('button', {
            className: 'dws_btn', disabled: busy !== '',
            onClick: () => { setRules((status.defaults?.rules ?? []).map((r) => ({ ...r }))); say('已恢复默认规则表（还需点保存）', true) },
          }, '规则恢复默认'),
        ),

        // —— 有序规则表 ——
        h('div', { className: 'dws_colhead' }, `续跑规则（从上到下匹配，先命中先用）`),
        h('div', { className: 'dws_note' },
          '顺序即优先级：把「自定义状态码」放在「服务端错误」上方，特定码就会先走专属策略。每行的次数为 0 表示不限。'),
        ...list.map((r, i) => h('div', { key: r.id ?? i, className: 'dws_rule' },
          h('div', { className: 'dws_rulehead' },
            h('span', { className: 'dws_badge' }, `${i + 1}`),
            h('select', {
              className: 'dws_input', value: r.when,
              onChange: (e) => patchRule(i, { when: e.target.value }),
            }, (status.ruleWhens ?? []).map((w) => h('option', { key: w, value: w }, WL[w] ?? w))),
            h('span', { className: 'dws_arrow' }, '→'),
            h('select', {
              className: 'dws_input', value: r.action,
              onChange: (e) => patchRule(i, { action: e.target.value }),
            }, (status.ruleActions ?? []).map((a) => h('option', { key: a, value: a }, AL[a] ?? a))),
            h('input', {
              className: 'dws_input dws_num', type: 'number', title: '本规则最多执行几次（0=不限）',
              value: r.maxAttempts ?? 0, onChange: (e) => patchRule(i, { maxAttempts: Number(e.target.value) }),
            }),
            h('button', { className: 'dws_btn dws_btnicon', title: '上移', disabled: i === 0, onClick: () => move(i, -1) }, '↑'),
            h('button', { className: 'dws_btn dws_btnicon', title: '下移', disabled: i === list.length - 1, onClick: () => move(i, 1) }, '↓'),
            h('button', { className: 'dws_btn dws_btnicon dws_btn_danger', title: '删除', onClick: () => delRule(i) }, '×'),
          ),
          r.when === 'status'
            ? h('div', { className: 'dws_field' },
              h('div', { className: 'dws_label' }, '自定义状态码（逗号分隔；数字匹配 HTTP 状态码，文字匹配机器码，大小写不敏感）'),
              h('input', {
                className: 'dws_input', placeholder: '529, 520, UNKNOWN',
                value: r.codes ?? '', onChange: (e) => patchRule(i, { codes: e.target.value }),
              }))
            : null,
          r.action === 'continue-with'
            ? h('div', { className: 'dws_field' },
              h('div', { className: 'dws_label' }, '换到哪个模型（点开时加载可选列表）'),
              h('div', { className: 'dws_bar' },
                h('input', {
                  className: 'dws_input', placeholder: 'provider（可留空）',
                  value: r.provider ?? '', onFocus: loadModels,
                  onChange: (e) => patchRule(i, { provider: e.target.value }),
                }),
                h('input', {
                  className: 'dws_input', placeholder: '模型 id', list: `dws-models-${i}`,
                  value: r.model ?? '', onFocus: loadModels,
                  onChange: (e) => patchRule(i, { model: e.target.value }),
                }),
                // 模型是对象 {provider, id, name}，不是字符串 ——
                // 直接塞进 value 会渲染成 [object Object]
                h('datalist', { id: `dws-models-${i}` },
                  Object.values(models?.models ?? {}).flat().map((m, k) =>
                    h('option', { key: k, value: typeof m === 'string' ? m : m.id, label: typeof m === 'string' ? '' : (m.name ?? '') }))),
              ))
            : null,
        )),
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', onClick: addRule }, '＋ 加一条规则'),
        ),

        // —— 各会话与活动 ——
        (status.sessions ?? []).length > 0
          ? h('div', null,
            h('div', { className: 'dws_colhead' }, '各会话'),
            h('div', { className: 'dws_pre' },
              (status.sessions ?? []).slice(0, 20).map((x) =>
                `${x.sessionId}　${x.attempts} 次${x.pending ? '　⏳ 挂起' : ''}${x.compacting ? '　🗜 压缩中' : ''}${x.lastContinueAt ? `　${new Date(x.lastContinueAt).toLocaleTimeString('zh-CN')}` : ''}`).join('\n')))
          : null,

        (status.activity ?? []).length > 0
          ? h('div', null,
            h('div', { className: 'dws_colhead' }, '活动日志'),
            h('div', { className: 'dws_pre' },
              (status.activity ?? []).map((x) => {
                const kind = {
                  armed: '已就绪', detect: '检测到失败', scheduled: '已排定续跑', 'continue-sent': '已续跑',
                  'continue-failed': '续跑失败', skip: '跳过', cap: '达上限', stop: '按规则停止',
                  'model-overridden': '已换模型', 'compact-done': '压缩完成', 'compact-noop': '无需压缩',
                  'compact-failed': '压缩失败', 'compact-unavailable': '压缩服务不可用',
                }[x.kind] ?? x.kind
                const bits = [
                  new Date(x.at).toLocaleTimeString('zh-CN'), kind,
                  x.attempt ? `#${x.attempt}` : null, x.sessionId, x.ruleId,
                  x.delay ? `退避 ${x.delay}ms` : null, x.reason, x.message,
                  x.via ? `换模型 ${x.via}` : null, x.to ? `→ ${x.to}` : null,
                ].filter(Boolean)
                return bits.join('　')
              }).join('\n')))
          : h('div', { className: 'dws_note' }, '还没有活动记录。'),

        h('div', { className: 'dws_note' }, status.note ?? ''),

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    /** 惰性取值：只在首次渲染时算一次（等价于 useState 的惰性初值）。 */
    function useMemoSafe(fn, fallback) {
      const [v] = useState(() => {
        try { return fn() ?? fallback } catch { return fallback }
      })
      return v
    }

    /**
     * 阅读器页签（移植自 dsh-reader）。
     *
     * 在线搜书 → 逐章读 → 整本下载；也能读工作目录里的本地书。
     * 与写作流程打通：读到哪一章，一键送进「拆文库 / 样本 / 素材」。
     *
     * 界面沿用原插件的思路：**章节以对话消息呈现**，输入框支持指令
     * （下一章 / 上一章 / 目录 / 第N章 / 下载 / 书架 / 清屏）。
     */
    function ReaderPanel() {
      // 子页签也记住：回来时还在你离开的那一页
      const [tab, setTab] = useState(() => lsGetJSON(`${NS}:reader:tab`, 'read'))
      useEffect(() => { lsSetJSON(`${NS}:reader:tab`, tab) }, [tab])
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const say = useCallback((t, o = true) => setToast({ text: t, ok: o }), [])

      // 当前这本书
      // 初值从上次的记录恢复 —— 切页签、刷新、重启 DSH 都还在
      const savedSearch = useMemoSafe(() => lsGetJSON(LS_READER_SEARCH), null)
      const savedSession = useMemoSafe(() => lsGetJSON(LS_READER_SESSION), null)

      const [book, setBook] = useState(savedSession?.book ?? null)   // {source,title,url,author}
      const [chapters, setChapters] = useState(savedSession?.chapters ?? [])
      const [at, setAt] = useState(savedSession?.at ?? 0)
      const [msg, setMsg] = useState(savedSession?.msg ?? [])       // 对话流
      const [cmd, setCmd] = useState('')
      const [kw, setKw] = useState(savedSearch?.keyword ?? '')
      const [results, setResults] = useState(savedSearch?.results ?? null)
      const [filter, setFilter] = useState('')
      const [showToc, setShowToc] = useState(false)
      const [notice, setNotice] = useState(null)
      const [sources, setSources] = useState(null)
      const [locals, setLocals] = useState(null)
      const [dl, setDl] = useState(null)

      const push = useCallback((role, text, extra) => {
        setMsg((m) => [...m, { role, text, ...(extra ?? {}), id: `${Date.now()}-${Math.random()}` }])
      }, [])

      const call = useCallback(async (p, body, okText) => {
        setBusy(p)
        try {
          const r = await api(p, body)
          setErr('')
          if (okText !== undefined) say(okText, true)
          return r
        } catch (e) { setErr(e.message); return null }
        finally { setBusy('') }
      }, [say])

      const loadNotice = useCallback(async () => {
        try {
          const r = await api('/reader/sources')
          setNotice(r.notice); setSources(r.sources)
        } catch { /* 忽略 */ }
      }, [])
      useEffect(() => { loadNotice() }, [loadNotice])

      // —— 搜索 ——
      const doSearch = useCallback(async () => {
        const k = kw.trim()
        if (k === '') return
        push('user', k)
        // 新搜索**清掉旧结果**再写新的（不是追加）
        setResults(null)
        lsDel(LS_READER_SEARCH)
        const r = await call('/reader/search', { keyword: k })
        if (r === null) { push('assistant', '搜索失败了。'); return }
        setResults(r)
        lsSetJSON(LS_READER_SEARCH, { keyword: k, results: r, at: Date.now() })
        push('assistant', `查了 ${r.searched} 个书源，命中 ${r.results.length} 条${r.timedOut ? '（部分源超时）' : ''}。点书名开读。`)
      }, [kw, call, push])

      // —— 开书 ——
      const openBook = useCallback(async (hit) => {
        push('user', `开《${hit.title}》`)
        setBook(hit)
        const r = await call('/reader/chapters', { source: hit.source, url: hit.url })
        if (r === null || r.ok !== true) { push('assistant', `取目录失败：${err}`); return }
        setChapters(r.chapters)
        setAt(0)
        push('assistant', `《${hit.title}》共 ${r.chapters.length} 章。正在取第 1 章…`)
        await readChapter(hit, r.chapters, 0)
      }, [call, push, err])

      // —— 读某章 ——
      const readChapter = useCallback(async (bk, cs, i) => {
        const b = bk ?? book
        const list = cs ?? chapters
        if (b === null || list.length === 0) return
        const idx = Math.max(0, Math.min(i, list.length - 1))
        setAt(idx)
        const ch = list[idx]
        const r = await call('/reader/content', { source: b.source, url: ch.url })
        if (r === null || r.ok !== true) { push('assistant', `第 ${idx + 1} 章取不到。`); return }
        push('assistant', r.text, { chapter: idx, chapterTitle: ch.title, chapterUrl: ch.url })
      }, [book, chapters, call, push])

      // —— 指令 ——
      const runCmd = useCallback(async () => {
        const raw = cmd.trim()
        if (raw === '') return
        setCmd('')
        push('user', raw)
        const t = raw.replace(/^[/／]/, '')

        if (/^(下一章|next|n)$/i.test(t)) {
          if (at + 1 >= chapters.length) { push('assistant', '已经是最后一章了。'); return }
          await readChapter(null, null, at + 1); return
        }
        if (/^(上一章|prev|p)$/i.test(t)) {
          if (at <= 0) { push('assistant', '已经是第一章了。'); return }
          await readChapter(null, null, at - 1); return
        }
        if (/^(目录|toc)$/i.test(t)) { setShowToc(true); push('assistant', `共 ${chapters.length} 章，右边是目录。`); return }
        const nth = t.match(/^第\s*(\d+)\s*章$/)
        if (nth !== null) {
          const n = Number(nth[1]) - 1
          if (n < 0 || n >= chapters.length) { push('assistant', `没有第 ${nth[1]} 章。`); return }
          await readChapter(null, null, n); return
        }
        if (/^(清屏|clear)$/i.test(t)) { setMsg([]); return }
        if (/^(书架|shelf)$/i.test(t)) { setTab('shelf'); return }
        if (/^(搜索|search)$/i.test(t)) { setTab('search'); return }
        if (/^(下载|download)/.test(t)) { await doDownload(); return }
        const send = t.match(/^(送拆文|拆文|送样本|样本|送素材|素材)$/)
        if (send !== null) {
          const last = [...msg].reverse().find((m) => m.chapter !== undefined)
          if (last === undefined) { push('assistant', '还没有读到的章节可以送。'); return }
          const kind = send[1].includes('样本') ? 'sample' : send[1].includes('素材') ? 'material' : 'deconstruct'
          const r = await call('/reader/send', { kind, name: `${book?.title ?? '读本'}-${last.chapterTitle ?? ''}`, text: last.text, chapterIndex: last.chapter })
          push('assistant', r?.ok ? `已送进「${r.dir}/」：${r.path}` : `没送成：${r?.reason ?? ''}`)
          return
        }
        // 否则当搜索词
        setKw(raw); setTab('search')
        const r = await call('/reader/search', { keyword: raw })
        if (r !== null) {
          setResults(r)
          lsSetJSON(LS_READER_SEARCH, { keyword: raw, results: r, at: Date.now() })
          push('assistant', `当作搜索词查了 ${r.searched} 个源，命中 ${r.results.length} 条。`)
        }
      }, [cmd, at, chapters, book, msg, call, push, readChapter])

      // —— 下载 ——
      const doDownload = useCallback(async () => {
        if (book === null) { say('先开一本书', false); return }
        const r = await call('/reader/download', { source: book.source, url: book.url, title: book.title })
        if (r === null || r.ok !== true) { say(r?.error ?? '建任务失败', false); return }
        push('assistant', `下载任务已建，落点 ${r.dir}`)
        setDl(r.taskId)
        // 轮询进度
        const timer = setInterval(async () => {
          const p = await api(`/reader/download?id=${encodeURIComponent(r.taskId)}`).catch(() => null)
          if (p?.task !== undefined && p.task !== null) {
            setDl(p.task)
            if (p.task.status === 'done' || p.task.status === 'error' || p.task.status === 'cancelled') {
              clearInterval(timer)
              push('assistant', p.task.status === 'done' ? `下载完成：${p.task.path ?? ''}` : `下载${p.task.status}：${p.task.error ?? ''}`)
            }
          }
        }, 1500)
      }, [book, call, push, say])

      // —— 本地书 ——
      const loadLocal = useCallback(async () => {
        const r = await call('/reader/local')
        if (r !== null) setLocals(r)
      }, [call])
      useEffect(() => { if (tab === 'local' && locals === null) loadLocal() }, [tab, locals, loadLocal])
      // 切回搜书页时若内存里没了，就从上次记录捞回来 ——
      // 这样「读完一本再挑一本」不用重搜
      useEffect(() => {
        if (tab !== 'search' || results !== null) return
        const saved = lsGetJSON(LS_READER_SEARCH, null)
        if (saved?.results !== undefined && saved.results !== null) {
          setResults(saved.results)
          if (typeof saved.keyword === 'string' && kw === '') setKw(saved.keyword)
        }
      }, [tab, results, kw])

      const openLocal = useCallback(async (b) => {
        const r = await call('/reader/local/read', { path: b.path })
        if (r === null || r.ok !== true) { say('读不了这个文件', false); return }
        setBook({ source: null, title: b.name, url: b.path, local: true })
        setChapters(r.chapters.map((c) => ({ title: c.title, url: null, index: c.index })))
        setTab('read'); setMsg([])
        push('assistant', `《${b.name}》共 ${r.chapterCount} 章。`)
        const first = await call('/reader/local/chapter', { path: b.path, index: 0 })
        if (first?.ok) push('assistant', first.text, { chapter: 0, chapterTitle: first.title, localPath: b.path })
      }, [call, push, say])

      const loadLocalChapter = useCallback(async (i) => {
        if (book?.local !== true) { await readChapter(null, null, i); return }
        const r = await call('/reader/local/chapter', { path: book.url, index: i })
        if (r?.ok !== true) { push('assistant', '取不到这一章。'); return }
        setAt(i)
        push('assistant', r.text, { chapter: i, chapterTitle: r.title, localPath: book.url })
      }, [book, call, push, readChapter])

      // —— 送进工作目录 ——
      const sendTo = useCallback(async (m, kind) => {
        const r = await call('/reader/send', { kind, name: `${book?.title ?? '读本'}-${m.chapterTitle ?? ''}`, text: m.text, chapterIndex: m.chapter })
        say(r?.ok ? `已送进「${r.dir}/」` : `没送成：${r?.reason ?? ''}`, r?.ok === true)
      }, [book, call, say])

      // 阅读进度落盘：只留最近 20 条消息（章节正文可能很大）
      useEffect(() => {
        if (book === null) { lsDel(LS_READER_SESSION); return }
        lsSetJSON(LS_READER_SESSION, {
          book, chapters, at,
          msg: msg.slice(-20),
          at2: Date.now(),
        })
      }, [book, chapters, at, msg])

      // 结果筛选（书名/作者/来源任一命中）
      const shown = (() => {
        const list = results?.results ?? []
        const f = filter.trim().toLowerCase()
        if (f === '') return list
        return list.filter((x) => `${x.title} ${x.author ?? ''} ${x.source}`.toLowerCase().includes(f))
      })()
      const officialSet = new Set((sources ?? []).filter((x) => x.official).map((x) => x.title))

      const hasChapter = msg.some((m) => m.chapter !== undefined)

      return h('div', { className: 'dws_root' },
        h('div', { className: 'dws_tabs' },
          [['read', '阅读'], ['search', '搜书'], ['shelf', '书架'], ['local', '本地书']].map(([id, label]) =>
            h('button', { key: id, className: 'dws_tab', 'data-on': tab === id ? '1' : '0', onClick: () => setTab(id) }, label)),
          book !== null ? h('span', { className: 'dws_note' }, `　正在读：${book.title}　第 ${at + 1}/${chapters.length || '?'} 章`) : null,
          dl !== null ? h('span', { className: 'dws_badge' }, `下载 ${dl.progress ?? 0}%`) : null,
        ),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        // ———— 阅读 ————
        tab === 'read' ? h('div', null,
          h('div', { className: 'dws_bar dws_nav' },
            h('button', {
              className: 'dws_btn', disabled: busy !== '' || book === null || at <= 0,
              onClick: () => loadLocalChapter(at - 1),
            }, '← 上一章'),
            h('button', {
              className: 'dws_btn dws_btn_primary', disabled: busy !== '' || book === null || at + 1 >= chapters.length,
              onClick: () => loadLocalChapter(at + 1),
            }, '下一章 →'),
            h('button', { className: 'dws_btn', disabled: book === null, onClick: () => setShowToc((v) => !v) },
              showToc ? '收起目录' : '目录'),
            h('button', {
              className: 'dws_btn', disabled: msg.length === 0,
              title: '清空对话（不影响已保存的搜索与进度记录）',
              onClick: () => setMsg([]),
            }, '清屏'),
            chapters.length > 0
              ? h('input', {
                className: 'dws_input dws_num', type: 'number', min: 1, max: chapters.length,
                value: at + 1, title: `跳到第几章（共 ${chapters.length} 章）`,
                onChange: (e) => {
                  const n = Number(e.target.value) - 1
                  if (Number.isFinite(n) && n >= 0 && n < chapters.length && n !== at) loadLocalChapter(n)
                },
              })
              : null,
            chapters.length > 0 ? h('span', { className: 'dws_note' }, `/ ${chapters.length} 章`) : null,
            book !== null && chapters.length === 0
              ? h('button', {
                className: 'dws_btn', disabled: busy !== '',
                onClick: async () => {
                  const r = await call('/reader/chapters', { source: book.source, url: book.url })
                  if (r?.ok === true) { setChapters(r.chapters); say(`取到 ${r.chapters.length} 章`, true) }
                },
              }, '重新取目录')
              : null,
          ),
          h('div', { className: 'dws_reader' },
          h('div', { className: 'dws_chat' },
            msg.length === 0
              ? h('div', { className: 'dws_note' }, book === null
                ? '还没有内容。去「搜书」找一本，或到「本地书」打开工作目录里的稿子。'
                : `《${book.title}》还在，对话被清空了。点「下一章」继续，或到「目录」挑一章。`)
              : msg.map((m) => h('div', { key: m.id, className: `dws_msg ${m.role === 'user' ? 'me' : 'ai'}` },
                m.role === 'assistant' && m.chapter !== undefined
                  ? h('div', { className: 'dws_msgbar' },
                    h('span', { className: 'dws_badge' }, m.chapterTitle ?? `第 ${m.chapter + 1} 章`),
                    h('button', { className: 'dws_btn dws_btnicon', title: '送进拆文库', onClick: () => sendTo(m, 'deconstruct') }, '拆'),
                    h('button', { className: 'dws_btn dws_btnicon', title: '送进样本（Style Anchor 语料）', onClick: () => sendTo(m, 'sample') }, '样'),
                    h('button', { className: 'dws_btn dws_btnicon', title: '送进素材', onClick: () => sendTo(m, 'material') }, '材'),
                  )
                  : null,
                h('div', { className: 'dws_msgtext' }, m.text),
              )),
          ),
          showToc ? h('div', { className: 'dws_toc' },
            h('div', { className: 'dws_bar' },
              h('div', { className: 'dws_colhead' }, `目录（${chapters.length}）`),
              h('button', { className: 'dws_btn', onClick: () => setShowToc(false) }, '收起')),
            h('div', { className: 'dws_toclist' },
              chapters.map((c, i) => h('div', {
                key: i, className: 'dws_tocitem', 'data-on': i === at ? '1' : '0',
                onClick: () => { loadLocalChapter(i); setShowToc(false) },
              }, `${i + 1}. ${c.title}`)))) : null,
          h('div', { className: 'dws_cmdbar' },
            h('input', {
              className: 'dws_input', value: cmd, placeholder: '下一章 / 上一章 / 第N章 / 目录 / 下载 / 拆文 / 样本 / 或直接输入书名搜索',
              onChange: (e) => setCmd(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runCmd() },
            }),
            h('button', { className: 'dws_btn dws_btn_primary', onClick: runCmd, disabled: busy !== '' }, '发送'),
            hasChapter ? h('button', {
              className: 'dws_btn', title: '把当前这一章送进拆文库',
              onClick: () => { const last = [...msg].reverse().find((m) => m.chapter !== undefined); if (last) sendTo(last, 'deconstruct') },
            }, '本章送拆文') : null,
          ),
        )) : null,

        // ———— 搜书 ————
        tab === 'search' ? h('div', null,
          h('div', { className: 'dws_bar' },
            h('input', { className: 'dws_input', value: kw, placeholder: '书名', onChange: (e) => setKw(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doSearch() } }),
            h('button', { className: 'dws_btn dws_btn_primary', onClick: doSearch, disabled: busy !== '' }, busy === '/reader/search' ? '搜索中…' : '搜索'),
          ),
          notice !== null ? h('div', { className: 'dws_note' }, `书源：${notice.origin}`) : null,
          notice !== null ? h('div', { className: 'dws_note' }, `⚠ ${notice.warning}`) : null,
          results !== null
            ? h('div', null,
              h('div', { className: 'dws_bar' },
                h('div', { className: 'dws_colhead' }, `命中 ${results.results.length} 条`),
                savedSearch !== null && savedSearch.keyword === kw
                  ? h('span', { className: 'dws_badge' }, `上次搜的「${savedSearch.keyword}」`)
                  : null,
                h('button', {
                  className: 'dws_btn', onClick: () => { setResults(null); lsDel(LS_READER_SEARCH) },
                }, '清掉结果'),
              ),
              h('div', { className: 'dws_bar' },
                h('input', {
                  className: 'dws_input', value: filter, placeholder: '在结果里筛（书名 / 作者 / 来源）',
                  onChange: (e) => setFilter(e.target.value),
                }),
                h('span', { className: 'dws_note' }, `${shown.length} / ${results.results.length}`),
              ),
              h('div', { className: 'dws_results' },
                shown.length === 0
                  ? h('div', { className: 'dws_note' }, filter === '' ? '没有结果。' : '没有匹配的。')
                  : shown.map((x, i) => h('div', {
                    key: `${x.source}-${x.title}-${i}`, className: 'dws_result',
                    // 不清 results：读完一本想再挑一本时，结果还得在
                    onClick: () => { setTab('read'); openBook(x) },
                  },
                  h('div', { className: 'dws_resultTitle' }, `《${x.title}》`),
                  h('div', { className: 'dws_resultMeta' },
                    x.author ? h('span', null, x.author) : null,
                    h('span', { className: 'dws_badge' }, x.source),
                    officialSet.has(x.source) ? h('span', { className: 'dws_badge ok' }, '正规') : null),
                  ))),
              results.errors?.length > 0
                ? h('div', { className: 'dws_note' }, `${results.errors.length} 个源没成：${results.errors.slice(0, 5).map((e) => e.source).join('、')}…`)
                : null)
            : null,
          sources !== null
            ? h('details', null,
              h('summary', { className: 'dws_label' }, `内置书源 ${sources.length} 个（${sources.filter((x) => x.official).length} 个正规平台）`),
              h('div', { className: 'dws_pre' }, sources.map((x) => `${x.title}${x.official ? ' ✅' : ''}　${x.host}`).join('\n')))
            : null,
        ) : null,

        // ———— 书架 ————
        tab === 'shelf' ? h('div', null,
          h('div', { className: 'dws_note' }, '这里列的是本次会话读过的书。要长期保存，用「本章送拆文/样本」落到工作目录 —— 那样重启也在。'),
          msg.filter((m) => m.chapter !== undefined).length === 0
            ? h('div', { className: 'dws_note' }, '还没读过任何章节。')
            : h('div', { className: 'dws_toclist' },
              msg.filter((m) => m.chapter !== undefined).map((m, i) => h('div', { key: i, className: 'dws_tocitem' },
                h('span', null, `${book?.title ?? ''}　${m.chapterTitle ?? ''}　${m.text.length} 字`),
                h('button', { className: 'dws_btn dws_btnicon', onClick: () => sendTo(m, 'deconstruct') }, '拆'),
                h('button', { className: 'dws_btn dws_btnicon', onClick: () => sendTo(m, 'sample') }, '样'),
              ))),
        ) : null,

        // ———— 本地书 ————
        tab === 'local' ? h('div', null,
          h('div', { className: 'dws_bar' },
            h('button', { className: 'dws_btn', onClick: loadLocal, disabled: busy !== '' }, '刷新'),
            locals !== null ? h('span', { className: 'dws_note' }, `本地书目录：${locals.dir}`) : null,
          ),
          h('div', { className: 'dws_note' }, '本地书 = 工作目录「本地书/」里的 TXT，加上「章节/」里你自己写的稿子。'),
          locals === null
            ? h('div', { className: 'dws_note' }, '读取中…')
            : h('div', { className: 'dws_toclist' },
              locals.books.map((b, i) => h('div', { key: i, className: 'dws_tocitem', onClick: () => openLocal(b) },
                h('span', { className: 'dws_badge' }, b.origin === 'workspace' ? '我的稿子' : '本地'),
                `　${b.name}　${(b.size / 1024).toFixed(1)}KB`))),
        ) : null,

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    /**
     * 逻辑图面板 —— 「提取素材 → 子智能拆解 → 填进槽位 → 一键出图 → 存进指令库」。
     *
     * 放在写作槽位页签里，因为整条链的起点是「写作槽位从工作目录提取素材」。
     */
    function LogicMapPanel({ onImported }) {
      const [map, setMap] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [out, setOut] = useState(null)
      const [raw, setRaw] = useState('')
      const [list, setList] = useState('')
      const [book, setBook] = useState(null)
      const [chunkAt, setChunkAt] = useState(null)
      const say = useCallback((t, o = true) => setToast({ text: t, ok: o }), [])

      const load = useCallback(async () => {
        try { setMap(await api('/logicmap')) } catch { setMap(null) }
      }, [])
      useEffect(() => { load() }, [load])

      const call = useCallback(async (p, body, okText) => {
        setBusy(p)
        try {
          const r = await api(p, body)
          setErr(''); if (okText !== undefined) say(okText, true)
          return r
        } catch (e) { setErr(e.message); say(e.message, false); return null }
        finally { setBusy('') }
      }, [say])

      return h('div', { className: 'dws_lm' },
        h('div', { className: 'dws_bar' },
          h('strong', null, '小说逻辑图'),
          map?.ok === true ? h('span', { className: 'dws_badge ok' }, '已有图') : h('span', { className: 'dws_badge no' }, '还没有图'),
          h('button', { className: 'dws_btn', onClick: load, disabled: busy !== '' }, '刷新'),
        ),
        h('div', { className: 'dws_note' },
          '流程：从工作目录提取素材 → 子智能拆分阅读 → 结果填进槽位对应功能点 → 一键生成逻辑图 → 存进指令库当真实素材库。'),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        // 1. 提取
        h('div', { className: 'dws_bar' },
          h('span', { className: 'dws_badge' }, '1'),
          h('button', {
            className: 'dws_btn', disabled: busy !== '',
            onClick: async () => {
              const r = await call('/logicmap/extract', {}, undefined)
              if (r !== null) {
                say(`提取 ${r.added} 条${(r.skipped ?? []).length ? `，跳过 ${r.skipped.length}` : ''}`, r.ok === true)
                setOut({ text: `提取 ${r.added} 条（扫描 ${r.scanned} 个文件）\n\n` + (r.items ?? []).map((x) => `+ [${x.kind}] ${x.name}`).join('\n') + ((r.skipped ?? []).length ? '\n\n跳过：\n' + r.skipped.map((x) => `- ${x.name}：${x.reason}`).join('\n') : '') })
                setList((r.items ?? []).map((x) => `${x.dir}/${x.name}`).join('\n'))
                if (onImported !== undefined) onImported()
              }
            },
          }, busy === '/logicmap/extract' ? '提取中…' : '从工作目录提取素材'),
        ),

        // 2. 拆解
        h('div', { className: 'dws_bar' },
          h('span', { className: 'dws_badge' }, '2'),
          h('button', {
            className: 'dws_btn dws_btn_primary', disabled: busy !== '' || raw.trim() === '',
            onClick: async () => {
              const r = await call('/logicmap/decompose', { material: raw, materialList: list.split('\n').map((x) => x.trim()).filter((x) => x !== '') })
              if (r !== null && r.ok === true) { setOut({ text: r.prompt, isPrompt: true }); say('拆解提示词已生成', true) }
            },
          }, '生成子智能拆解提示词'),
        ),
        // —— 整本书：分段拆解 ——
        h('div', { className: 'dws_bar' },
          h('span', { className: 'dws_badge' }, '分段'),
          h('button', {
            className: 'dws_btn', disabled: busy !== '',
            onClick: async () => {
              const r = await call('/logicmap/chunks', {}, undefined)
              if (r !== null && r.ok === true) {
                setBook(r)
                say(`${r.total} 段（${r.byChapter ? '按章节切' : '按字数切'}）`, true)
              } else if (r !== null) say(r.reason ?? '切不了', false)
            },
          }, busy === '/logicmap/chunks' ? '切分中…' : '把本地书切段'),
          book !== null ? h('span', { className: 'dws_note' }, `${book.totalChars} 字　${book.chapterMarks} 个章节标题　${book.total} 段`) : null,
        ),
        book !== null
          ? h('div', { className: 'dws_chunks' },
            (book.chunks ?? []).slice(0, 200).map((c) => h('span', {
              key: c.index,
              className: `dws_chip${chunkAt === c.index ? ' on' : ''}`,
              title: `${c.chars} 字${c.chapters ? `，${c.chapters} 章` : ''}`,
              onClick: async () => {
                setChunkAt(c.index)
                const r = await call('/logicmap/chunk', { chunkIndex: c.index }, undefined)
                if (r !== null && r.ok === true) setRaw(r.text)
              },
            }, `${c.index + 1}`)))
          : null,
        book !== null && chunkAt !== null
          ? h('div', { className: 'dws_note' }, `已载入第 ${chunkAt + 1} 段（${(book.chunks?.[chunkAt]?.chars ?? 0)} 字）到下面的素材框 —— 点「生成子智能拆解提示词」拆它。`)
          : null,

        h('textarea', { className: 'dws_area', value: raw, placeholder: '要拆的素材正文（第 1 步提取的原文，或你直接贴进来的一段）', onChange: (e) => setRaw(e.target.value) }),
        h('textarea', { className: 'dws_area dws_area_sm', value: list, placeholder: '素材清单（每行一个，可选 —— 会写进提示词让它标出处）', onChange: (e) => setList(e.target.value) }),

        // 3. 收图
        h('div', { className: 'dws_bar' },
          h('span', { className: 'dws_badge' }, '3'),
          h('button', {
            className: 'dws_btn', disabled: busy !== '' || raw.trim() === '',
            onClick: async () => {
              const r = await call('/logicmap/accept', { text: raw }, undefined)
              if (r !== null) {
                if (r.reason !== undefined && r.ok !== true) { say(r.reason, false); return }
                say(`图已存：${r.stats?.nodes ?? 0} 节点、${r.stats?.edges ?? 0} 连线`, r.ok === true)
                setOut({ text: `节点 ${r.stats?.nodes ?? 0} 个、连线 ${r.stats?.edges ?? 0} 条，${r.stats?.chars ?? 0} 字\n有出处：${r.stats?.sourced ?? 0}/${r.stats?.nodes ?? 0}\n\n` + [...(r.validation?.errors ?? []).map((x) => `⛔ ${x}`), ...(r.validation?.warnings ?? []).map((x) => `⚠ ${x}`)].join('\n') })
                await load()
              }
            },
          }, '把 JSON 收成逻辑图'),
        ),

        // 4. 存库
        h('div', { className: 'dws_bar' },
          h('span', { className: 'dws_badge' }, '4'),
          h('button', {
            className: 'dws_btn dws_btn_primary', disabled: busy !== '' || map?.ok !== true,
            onClick: async () => {
              const r = await call('/logicmap/to-library', {}, undefined)
              if (r !== null && r.ok === true) {
                say(`已拆成 ${r.added} 条指令库条目`, true)
                setOut({ text: `已拆成 ${r.added} 条：\n` + (r.items ?? []).map((x) => `+ [${x.kind}] ${x.name}`).join('\n') + `\n\n${r.note ?? ''}` })
                if (onImported !== undefined) onImported()
              } else if (r !== null) say(r.reason ?? '没拆成', false)
            },
          }, '图 → 指令库条目（真实素材库）'),
          map?.ok === true ? h('button', {
            className: 'dws_btn', disabled: busy !== '',
            onClick: async () => { const r = await call('/logicmap', null, undefined); if (r?.text) setOut({ text: r.text }) },
          }, '看图') : null,
        ),

        out !== null ? h('pre', { className: 'dws_pre' }, out.text) : null,
        map?.ok === true ? h('div', { className: 'dws_note' }, `图在：${map.path}`) : null,

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }
    /**
     * 指令库页签 —— 「最终写作指令」的落点。
     *
     * 闭环：多次读小说 → `拆文入库` 抽出**可执行指令** → 落成条目 →
     * 清单里勾选 → 合成最终写作指令 → 拿去写。
     */
    function LibraryPanel() {
      const [lib, setLib] = useState(null)
      const [sel, setSel] = useState(() => new Set())
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [out, setOut] = useState(null)
      const [importText, setImportText] = useState('')
      const [srcName, setSrcName] = useState('')
      const [filter, setFilter] = useState('')
      const [editing, setEditing] = useState(null)
      const [scan, setScan] = useState(null)
      const say = useCallback((t, o = true) => setToast({ text: t, ok: o }), [])

      const load = useCallback(async () => {
        setBusy('load')
        try {
          const r = await api('/library')
          setLib(r)
          setSel((prev) => (prev.size > 0 ? prev : new Set((r.items ?? []).filter((x) => x.enabled !== false).map((x) => x.id))))
          setErr('')
        } catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [])
      useEffect(() => { load() }, [load])

      const call = useCallback(async (p, body, okText) => {
        setBusy(p)
        try {
          const r = await api(p, body)
          setErr(''); if (okText !== undefined) say(okText, true)
          return r
        } catch (e) { setErr(e.message); say(e.message, false); return null }
        finally { setBusy('') }
      }, [say])

      if (lib === null) return h('div', { className: 'dws_root' }, h('div', { className: 'dws_note' }, busy === 'load' ? '读取中…' : (err || '读取中…')))

      const items = lib.items ?? []
      const f = filter.trim().toLowerCase()
      const shown = f === '' ? items : items.filter((x) => `${x.name} ${x.summary ?? ''} ${x.source ?? ''} ${(x.tags ?? []).join(' ')}`.toLowerCase().includes(f))
      const toggle = (id) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
      const kindLabel = (k) => (lib.kinds ?? []).find((x) => x.id === k)?.label ?? k

      const doCompose = useCallback(async () => {
        const ids = [...sel]
        if (ids.length === 0) { say('一条都没勾', false); return }
        const r = await call('/library/compose', { ids, title: '写作指令', groupByKind: true })
        if (r !== null && r.ok === true) setOut(r)
      }, [sel, call, say])

      return h('div', { className: 'dws_root' },
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', onClick: load, disabled: busy !== '' }, '刷新'),
          h('span', { className: 'dws_badge ok' }, `${items.length} 条`),
          h('span', { className: 'dws_badge' }, `勾选 ${sel.size}`),
          h('span', { className: 'dws_note' }, `${lib.totalChars ?? 0} 字　${(lib.sources ?? []).length} 个来源`),
        ),
        h('div', { className: 'dws_note' },
          '读小说 → 「拆文入库」抽出可执行指令 → 落成条目 → 勾选组合 → 合成最终写作指令。'
          + '判据是「指令」不是「资料」：「这本书节奏好」是资料，「每章至少一次信息差变化」才是指令。'),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        // —— 从工作目录提取素材：这是「训练越多，清单越长」的入口 ——
        h('div', { className: 'dws_bar' },
          h('button', {
            className: 'dws_btn', disabled: busy !== '',
            onClick: async () => {
              const r = await call('/library/extract', { dryRun: true })
              if (r !== null) { setOut({ text: `会提取 ${r.count} 个文件：\n` + (r.found ?? []).map((x) => `[${x.kind}] ${x.name}　（${x.dir}/）`).join('\n'), chars: 0, used: [], byKind: {}, isPrompt: true }); setScan(r) }
            },
          }, '先看看能提取什么'),
          h('button', {
            className: 'dws_btn dws_btn_primary', disabled: busy !== '',
            onClick: async () => {
              const r = await call('/library/extract', {}, undefined)
              if (r !== null) {
                say(`提取 ${r.added} 条${(r.skipped ?? []).length > 0 ? `，跳过 ${r.skipped.length} 个` : ''}`, r.ok === true)
                setOut({ text: `提取 ${r.added} 条，跳过 ${(r.skipped ?? []).length} 个\n\n` + (r.items ?? []).map((x) => `+ [${x.kind}] ${x.name}`).join('\n') + ((r.skipped ?? []).length > 0 ? '\n\n跳过：\n' + r.skipped.map((x) => `- ${x.name}：${x.reason}`).join('\n') : ''), chars: 0, used: [], byKind: {}, isPrompt: true })
                setSel(new Set()); await load()
              }
            },
          }, '从工作目录提取素材'),
          scan !== null ? h('span', { className: 'dws_note' }, `（扫描到 ${scan.count} 个文件）`) : null,
        ),

        h('div', { className: 'dws_cards' },
          (lib.kinds ?? []).map((k) => h(Card, { key: k.id, n: k.count ?? 0, k: k.label }))),

        h('div', { className: 'dws_bar' },
          h('div', { className: 'dws_colhead' }, '清单（勾选要参与合成的条目）'),
          h('input', { className: 'dws_input', value: filter, placeholder: '筛（名/说明/来源/标签）', onChange: (e) => setFilter(e.target.value) }),
          h('button', { className: 'dws_btn', onClick: () => setSel(new Set(shown.map((x) => x.id))) }, '全选'),
          h('button', { className: 'dws_btn', onClick: () => setSel(new Set()) }, '全不选'),
        ),
        items.length === 0
          ? h('div', { className: 'dws_note' }, '库还是空的。到下面「拆文入库」读一本书抽条目，或在最下面手写一条。')
          : h('div', { className: 'dws_liblist' },
            shown.length === 0
              ? h('div', { className: 'dws_note' }, '没有匹配的。')
              : shown.map((x) => h('div', { key: x.id, className: `dws_libitem${sel.has(x.id) ? ' on' : ''}` },
                h('input', { type: 'checkbox', checked: sel.has(x.id), onChange: () => toggle(x.id) }),
                h('div', { className: 'dws_libmain' },
                  h('div', { className: 'dws_libname' },
                    h('span', { className: 'dws_badge' }, kindLabel(x.kind)),
                    x.enabled === false ? h('span', { className: 'dws_badge no' }, '已停用') : null,
                    h('strong', null, x.name)),
                  x.summary ? h('div', { className: 'dws_libsum' }, x.summary) : null,
                  h('div', { className: 'dws_libmeta' },
                    x.source ? h('span', null, `来源：${x.source}`) : null,
                    h('span', null, `${(x.body ?? '').length} 字`),
                    (x.tags ?? []).length > 0 ? h('span', null, (x.tags ?? []).map((t) => `#${t}`).join(' ')) : null),
                ),
                h('div', { className: 'dws_libacts' },
                  h('button', { className: 'dws_btn dws_btnicon', title: '编辑', onClick: () => setEditing({ ...x }) }, '✎'),
                  h('button', { className: 'dws_btn dws_btnicon', title: x.enabled === false ? '启用' : '停用',
                    onClick: async () => { await call('/library/patch', { id: x.id, changes: { enabled: x.enabled === false } }); await load() } },
                  x.enabled === false ? '○' : '●'),
                  h('button', { className: 'dws_btn dws_btnicon dws_btn_danger', title: '删除', onClick: async () => {
                    await call('/library/remove', { id: x.id }, '已删')
                    setSel((prev) => { const n = new Set(prev); n.delete(x.id); return n })
                    await load()
                  } }, '×'),
                ),
              ))),

        editing !== null
          ? h('div', { className: 'dws_edit' },
            h('div', { className: 'dws_colhead' }, `编辑：${editing.name}`),
            h('div', { className: 'dws_bar' },
              h('input', { className: 'dws_input', value: editing.name, placeholder: '条目名', onChange: (e) => setEditing({ ...editing, name: e.target.value }) }),
              h('select', { className: 'dws_input', value: editing.kind, onChange: (e) => setEditing({ ...editing, kind: e.target.value }) },
                (lib.kinds ?? []).map((k) => h('option', { key: k.id, value: k.id }, k.label))),
            ),
            h('input', { className: 'dws_input', value: editing.summary ?? '', placeholder: '一句话说明', onChange: (e) => setEditing({ ...editing, summary: e.target.value }) }),
            h('textarea', { className: 'dws_area', value: editing.body ?? '', placeholder: '指令正文（会被直接拼进最终指令）', onChange: (e) => setEditing({ ...editing, body: e.target.value }) }),
            h('div', { className: 'dws_bar' },
              h('button', { className: 'dws_btn dws_btn_primary', onClick: async () => {
                const r = await call('/library/patch', { id: editing.id, changes: { name: editing.name, kind: editing.kind, summary: editing.summary, body: editing.body } }, '已保存')
                if (r !== null && r.ok === true) { setEditing(null); await load() }
              } }, '保存'),
              h('button', { className: 'dws_btn', onClick: () => setEditing(null) }, '取消'),
            ))
          : null,

        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn dws_btn_primary', disabled: busy !== '' || sel.size === 0, onClick: doCompose },
            busy === '/library/compose' ? '合成中…' : `合成最终指令（勾选 ${sel.size} 条）`),
          out !== null ? h('button', { className: 'dws_btn', onClick: () => {
            try { navigator.clipboard?.writeText(out.text); say('已复制', true) } catch { say('复制不了，请手动选中', false) }
          } }, '复制') : null,
        ),
        out !== null
          ? h('div', null,
            h('div', { className: 'dws_ok' }, out.isPrompt === true
              ? `拆文提示词：${out.chars} 字 —— 拿去让模型读原文抽条目，产出 JSON 后贴回下面导入`
              : `最终指令：${out.used?.length ?? 0} 条，${out.chars} 字　${Object.entries(out.byKind ?? {}).map(([k, n]) => `${kindLabel(k)}×${n}`).join('　')}`),
            h('pre', { className: 'dws_pre' }, out.text))
          : null,

        h('div', { className: 'dws_colhead' }, '拆文入库（读一本，抽出可执行指令）'),
        h('div', { className: 'dws_note' }, '把小说正文贴进来 → 生成提示词 → 模型产出 JSON → 贴回下面导入。抽出来的必须是**指令**，不是读后感。'),
        h('input', { className: 'dws_input', value: srcName, placeholder: '书名 / 来源（写进条目的 source）', onChange: (e) => setSrcName(e.target.value) }),
        h('textarea', { className: 'dws_area', value: importText, placeholder: '小说正文（要拆的原文）或模型产出的 JSON', onChange: (e) => setImportText(e.target.value) }),
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', disabled: busy !== '' || importText.trim() === '', onClick: async () => {
            const r = await call('/library/mine', { text: importText, bookName: srcName })
            if (r !== null && r.ok === true) setOut({ text: r.prompt, chars: r.prompt.length, isPrompt: true })
          } }, '生成拆文提示词'),
          h('button', { className: 'dws_btn dws_btn_primary', disabled: busy !== '' || importText.trim() === '', onClick: async () => {
            const r = await call('/library/import', { text: importText, source: srcName })
            if (r !== null && r.ok === true) { say(`导入 ${r.added} 条`, true); setImportText(''); setSel(new Set()); await load() }
          } }, '把 JSON 导入成条目'),
        ),

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }
    /**
     *
     * 「后续内容都在工作内容区完成」的落点：设一次，所有槽位默认都用它。
     */
    function WorkspacePanel() {
      const [ws, setWs] = useState(null)
      const [path, setPath] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const say = useCallback((t, o = true) => setToast({ text: t, ok: o }), [])

      const load = useCallback(async () => {
        setBusy('load')
        try { const r = await api('/workspace'); setWs(r); setPath(r.workspace); setErr('') }
        catch (e) { setErr(e.message) }
        finally { setBusy('') }
      }, [])
      useEffect(() => { load() }, [load])

      const call = useCallback(async (p, body, okText) => {
        setBusy(p)
        try {
          const r = await api(p, body)
          await load()
          setErr(''); if (okText !== undefined) say(okText, r.ok !== false)
          return r
        } catch (e) { setErr(e.message); say(e.message, false); return null }
        finally { setBusy('') }
      }, [load, say])

      if (ws === null) return h('div', { className: 'dws_root' }, h('div', { className: 'dws_note' }, busy === 'load' ? '读取中…' : (err || '')))

      return h('div', { className: 'dws_root' },
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', onClick: load, disabled: busy !== '' }, '刷新'),
          h('span', { className: 'dws_badge ok' }, ws.exists ? '已就绪' : '未建'),
        ),
        h('div', { className: 'dws_note' },
          '插件所有产出都落在这一个目录里，不再散在会话 cwd。设一次，之后所有槽位默认都用它。'),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        h('div', { className: 'dws_field' },
          h('div', { className: 'dws_label' }, '工作目录路径'),
          h('div', { className: 'dws_bar' },
            h('input', { className: 'dws_input', value: path, onChange: (e) => setPath(e.target.value), placeholder: '/path/to/workspace' }),
            h('button', {
              className: 'dws_btn dws_btn_primary', disabled: busy !== '' || path.trim() === '',
              onClick: () => call('/workspace/set', { path, create: true }, '工作目录已设置'),
            }, busy === '/workspace/set' ? '设置中…' : '设为工作目录'),
            h('button', {
              className: 'dws_btn', disabled: busy !== '',
              onClick: () => call('/workspace/validate', { path }).then((r) => { if (r) say(r.ok ? '这个路径可以用' : r.problems.join('；'), r.ok) }),
            }, '检查'),
          )),
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', disabled: busy !== '', onClick: () => call('/workspace/init', {}, '已建目录结构') }, '建立目录结构'),
        ),

        h('div', { className: 'dws_ctract' },
          h('div', null, '项目根：', h('code', null, ws.projectRootDisplay)),
          ws.sameAsWorkspace ? null : h('div', { className: 'dws_note' }, '（项目根在工作目录的子目录里，已自动定位）'),
          h('div', null, '配置文件：', h('code', null, ws.configName), ws.config ? '（有）' : '（无）'),
        ),

        h('div', { className: 'dws_colhead' }, '分类目录'),
        h('div', { className: 'dws_grid' },
          (ws.dirs ?? []).map((d) => h('div', { key: d.name, className: 'dws_cardstat' },
            h('div', { className: 'n' }, d.present ? String(d.files) : '—'),
            h('div', { className: 'k' }, `${d.name}${d.samples ? '（样本来源）' : ''}`),
            h('div', { className: 'k' }, d.present ? `${(d.bytes / 1024).toFixed(1)}KB` : '未建'),
          ))),

        h('div', { className: 'dws_colhead' }, '关键文件'),
        h('div', { className: 'dws_ctract' },
          (ws.keyFiles ?? []).map((f) => h('div', { key: f.name },
            f.present ? '✓ ' : '· ', h('code', null, f.name)))),

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    /**
     * 小说网站页签：cookie 管理 + 取内容 + 按插件功能分类填充。
     */
    function SitesPanel() {
      const [data, setData] = useState(null)
      const [sel, setSel] = useState('fanqie')
      const [cookie, setCookie] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [result, setResult] = useState(null)
      const [paste, setPaste] = useState('')
      const [cls, setCls] = useState(null)
      const say = useCallback((t, o = true) => setToast({ text: t, ok: o }), [])

      const load = useCallback(async () => {
        setBusy('load')
        try { setData(await api('/sites')); setErr('') } catch (e) { setErr(e.message) } finally { setBusy('') }
      }, [])
      useEffect(() => { load() }, [load])

      const call = useCallback(async (p, body, okText) => {
        setBusy(p)
        try {
          const r = await api(p, body)
          setErr(''); if (okText !== undefined) say(okText, r.ok !== false)
          return r
        } catch (e) { setErr(e.message); say(e.message, false); return null }
        finally { setBusy('') }
      }, [say])

      if (data === null) return h('div', { className: 'dws_root' }, h('div', { className: 'dws_note' }, '读取中…'))

      const cur = data.sites.find((x) => x.id === sel) ?? data.sites[0]

      return h('div', { className: 'dws_root' },
        h('div', { className: 'dws_bar' },
          h('button', { className: 'dws_btn', onClick: load, disabled: busy !== '' }, '刷新'),
          h('span', { className: 'dws_note' }, `凭据目录：${data.authDir}　密钥${data.keyExists ? '已生成' : '未生成'}`),
        ),
        h('div', { className: 'dws_note' },
          '用**你自己的 cookie**去站点取内容，像正常人一样：真实浏览器头、每个站点之间自动节流。'
          + 'cookie 加密后落盘（0600），不进日志、不回显。'
          + '⚠ 遇到反爬（挑战页 / 字体混淆）会如实报告，**不绕过** —— 把乱码当内容存进语料库才是最坏的，'
          + 'Style Anchor 会拿它统计「文风」，得出的基线全是错的而且看不出来。'),

        err !== '' ? h('div', { className: 'dws_err' }, err) : null,

        h('div', { className: 'dws_colhead' }, '站点与 cookie'),
        ...data.sites.map((x) => h('div', { key: x.id, className: 'dws_rule' },
          h('div', { className: 'dws_rulehead' },
            h('input', { type: 'radio', checked: sel === x.id, onChange: () => { setSel(x.id); setCookie(''); setResult(null) } }),
            h('strong', null, x.name),
            h('span', { className: 'dws_badge' }, x.auth),
            x.stored ? h('span', { className: 'dws_badge ok' }, '已存 cookie') : h('span', { className: 'dws_badge no' }, '未存'),
            h('button', {
              className: 'dws_btn', disabled: busy !== '',
              onClick: () => call('/sites/fetch', { site: x.id }).then((r) => { if (r) setResult(r) }),
            }, '取榜单'),
            x.stored ? h('button', {
              className: 'dws_btn dws_btn_danger', disabled: busy !== '',
              onClick: async () => { await call('/sites/cookie', { site: x.id, remove: true }, '已删除'); await load() },
            }, '删 cookie') : null,
          ),
          h('div', { className: 'dws_note' }, x.note),
          x.stored && x.hint !== null ? h('div', { className: 'dws_note' }, `已存：${x.hint}`) : null,
          x.broken ? h('div', { className: 'dws_err' }, `解不开：${x.broken}`) : null,
        )),

        h('div', { className: 'dws_field' },
          h('div', { className: 'dws_label' }, `给「${cur?.name ?? ''}」加 cookie（从浏览器 DevTools → Network → 任一请求 → Request Headers → cookie 整段复制）`),
          h('div', { className: 'dws_bar' },
            h('input', {
              className: 'dws_input', type: 'password', value: cookie, placeholder: 'sessionid=...; ttwid=...',
              onChange: (e) => setCookie(e.target.value),
            }),
            h('button', {
              className: 'dws_btn dws_btn_primary', disabled: busy !== '' || cookie.trim() === '',
              onClick: async () => { const r = await call('/sites/cookie', { site: sel, cookie }, 'cookie 已加密保存'); if (r?.ok) { setCookie(''); await load() } },
            }, '保存 cookie'),
          )),

        result !== null
          ? h('div', null,
            h('div', { className: 'dws_colhead' }, `取内容结果：${result.site?.name ?? ''}`),
            h('div', { className: result.ok ? 'dws_ok' : 'dws_err' },
              result.ok
                ? `取到了：HTTP ${result.status}，${result.bytes} 字节，编码 ${result.encoding}，${(result.items ?? []).length} 条`
                : `没取到（${result.kind}）：${result.reason}`),
            result.checks?.length ? h('div', { className: 'dws_note' }, '判定依据：' + result.checks.join('；')) : null,
            result.suggestions?.length
              ? h('div', null, h('div', { className: 'dws_label' }, '可以走的路：'),
                h('div', { className: 'dws_pre' }, result.suggestions.join('\n')))
              : null,
            (result.items ?? []).length > 0
              ? h('div', { className: 'dws_pre' }, (result.items ?? []).slice(0, 25).map((i) => i.title).join('\n'))
              : null,
            (result.items ?? []).length > 0 && result.items.confidence !== 'high'
              ? h('div', { className: 'dws_note' }, `⚠ 解析置信度 ${result.items.confidence} —— 站点结构不是内嵌数据，抽出来的可能是导航或不全，建议人工看一眼`)
              : null,
          )
          : null,

        h('div', { className: 'dws_colhead' }, '按插件功能分类填充'),
        h('div', { className: 'dws_note' }, '在浏览器里打开目标页，把正文复制到这里。判断它该喂给哪个槽位，然后落进工作目录对应的分类目录。'),
        h('textarea', {
          className: 'dws_area', placeholder: '把正文粘进来…', value: paste,
          onChange: (e) => setPaste(e.target.value),
        }),
        h('div', { className: 'dws_bar' },
          h('button', {
            className: 'dws_btn', disabled: busy !== '' || paste.trim() === '',
            onClick: () => call('/sites/classify', { text: paste }).then((r) => { if (r) setCls(r) }),
          }, '看该归到哪'),
          h('button', {
            className: 'dws_btn dws_btn_primary', disabled: busy !== '' || paste.trim() === '',
            onClick: async () => {
              const r = await call('/sites/store', { text: paste, name: `导入-${new Date().toISOString().slice(0, 10)}-${sel}` })
              if (r?.ok) { setCls(r.classified); setPaste(''); say(`已落盘：${r.path}`, true) }
              else if (r) say(`没落盘：${r.reason ?? ''}`, false)
            },
          }, '落进工作目录'),
        ),
        cls !== null
          ? h('div', null,
            h('div', { className: 'dws_note' }, `${cls.stats.chars} 字（中文 ${cls.stats.han}）、${cls.stats.paragraphs} 段、${cls.stats.sentences} 句${cls.stats.hasDialogue ? '、含对话' : ''}`),
            h('div', { className: 'dws_pre' },
              [...(cls.targets ?? []).map((t) => `→ ${t.module}${t.slot ? ' / ' + t.slot : ''}${t.dir ? ' / ' + t.dir + '/' : ''}：${t.why}`), ...(cls.reasons ?? []).map((x) => `· ${x}`)].join('\n')))
          : null,

        h(Toast, { toast, onDone: () => setToast(null) }),
      )
    }

    function SlotsPanel() {
      const [inv, setInv] = useState(null)
      const loadInv = useCallback(async () => {
        try {
          const r = await api('/slots/inventory')
          // 结构不完整就当没加载 —— 少一块数据不该把整个面板打崩
          setInv(r !== null && r.material !== undefined && Array.isArray(r.slots) ? r : null)
        } catch { setInv(null) }
      }, [])
      useEffect(() => { loadInv() }, [loadInv])
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
      const [slotLib, setSlotLib] = useState(null)
      const [slotSel, setSlotSel] = useState(() => new Set())
      const say = useCallback((text, okk = true) => setToast({ text, ok: okk }), [])

      useEffect(() => { try { window.localStorage.setItem(LS_MODULE, sel) } catch { /* ignore */ } }, [sel])

      // 换槽位就重新拉「这个槽位用得上的库条目」
      useEffect(() => {
        let alive = true
        api('/library/for-slot', { slot: sel })
          .then((r) => { if (!alive) return; setSlotLib(r); setSlotSel(new Set((r.items ?? []).filter((x) => x.enabled !== false).map((x) => x.id))) })
          .catch(() => { if (alive) setSlotLib(null) })
        return () => { alive = false }
      }, [sel])

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

      /** 把工作区里的文件路径批量填进某个字段。 */
      const fillPaths = useCallback((key, files) => {
        const dir = inv?.dir ?? ''
        const paths = (files ?? []).map((f) => (dir === '' ? f : `${dir}/${f}`))
        setValues((prev) => ({ ...prev, [key]: paths.join('\n') }))
        say(`已填入 ${paths.length} 个文件路径`, true)
      }, [inv, say])

      /** 从细纲里挑一章，填进 chapterNo。 */
      const fillBriefNo = useCallback((file) => {
        const m = /(\d{3,4})/.exec(String(file))
        if (m === null) { say('这个文件名里没看出章号', false); return }
        setSel('chapter_pack')
        setValues((prev) => ({ ...prev, chapterNo: String(Number(m[1])) }))
        say(`已填第 ${Number(m[1])} 章`, true)
      }, [say])

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
        // —— 工作区现状：这是「怎么执行」的入口 ——
        inv !== null
          ? h('div', { className: 'dws_inv' },
            h('div', { className: 'dws_invHead' },
              h('strong', null, '工作区'),
              h('code', { className: 'dws_invPath' }, inv.projectRoot ?? inv.dir),
              h('button', { className: 'dws_btn', onClick: loadInv }, '刷新'),
            ),
            // 下一步：按现有素材推一条最该做的
            // 注意是 != null（同时挡 undefined 和 null）——
            // 只判 !== undefined 的话，服务端给 null 就会读 .text 崩掉
            inv.next != null
              ? h('div', { className: 'dws_next' },
                h('span', { className: 'dws_badge ok' }, '下一步'),
                h('span', null, inv.next.text),
                inv.next.action === 'use-samples'
                  ? h('button', { className: 'dws_btn dws_btn_primary', onClick: () => { setSel('style_anchor'); fillPaths('samples', inv.material?.samples?.files ?? []) } }, '用样本目录跑 Style Anchor')
                  : null,
                inv.next.action === 'use-briefs'
                  ? h('button', { className: 'dws_btn dws_btn_primary', onClick: () => setSel('chapter_pack') }, '去 Chapter Pack')
                  : null,
              )
              : null,
            // 手上有什么
            h('div', { className: 'dws_invRow' },
              h('span', { className: 'dws_badge' }, `样本 ${inv.material?.samples?.count ?? 0}`),
              h('span', { className: 'dws_badge' }, `细纲 ${inv.material?.briefs?.count ?? 0}`),
              h('span', { className: 'dws_badge' }, `正文 ${inv.material?.chapters?.count ?? 0}`),
              h('span', { className: 'dws_badge' }, `拆文库 ${inv.material?.deconstruct?.count ?? 0}`),
              h('span', { className: 'dws_badge' }, `素材 ${inv.material?.material?.count ?? 0}`),
              inv.material?.settings?.hasStyle ? h('span', { className: 'dws_badge ok' }, 'style-guide ✓') : null,
              inv.material?.settings?.hasWorld ? h('span', { className: 'dws_badge ok' }, 'world-bible ✓') : null,
            ),
          )
          : null,

        h(LogicMapPanel, { onImported: () => { loadInv(); load() } }),

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
              // 手里有什么 —— 槽位得知道自己能用工作区里的哪些东西
              (() => {
                const iv = inv?.slots?.find((x) => x.id === m.id)
                if (iv === undefined) return null
                return h('div', { className: 'm' },
                  h('span', { className: `dws_badge${iv.ready ? ' ok' : ' no'}` }, iv.haveLabel))
              })(),
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

            // —— 这个槽位能用哪些指令库条目（勾选即参与该槽位的指令）——
            slotLib !== null && slotLib.items.length > 0
              ? h('div', { className: 'dws_slotlib' },
                h('div', { className: 'dws_bar' },
                  h('div', { className: 'dws_colhead' }, `指令库里有 ${slotLib.items.length} 条用得上（勾选即参与）`),
                  h('button', { className: 'dws_btn', onClick: () => setSlotSel(new Set(slotLib.items.filter((x) => x.enabled !== false).map((x) => x.id))) }, '全选'),
                  h('button', { className: 'dws_btn', onClick: () => setSlotSel(new Set()) }, '全不选'),
                ),
                h('div', { className: 'dws_liblist' },
                  slotLib.items.map((x) => h('div', { key: x.id, className: `dws_libitem${slotSel.has(x.id) ? ' on' : ''}` },
                    h('input', { type: 'checkbox', checked: slotSel.has(x.id), onChange: () => setSlotSel((prev) => { const n = new Set(prev); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n }) }),
                    h('div', { className: 'dws_libmain' },
                      h('div', { className: 'dws_libname' },
                        h('span', { className: 'dws_badge' }, libKindLabel(x.kind)),
                        x.enabled === false ? h('span', { className: 'dws_badge no' }, '已停用') : null,
                        h('strong', null, x.name)),
                      x.summary ? h('div', { className: 'dws_libsum' }, x.summary) : null),
                  ))),
                h('div', { className: 'dws_bar' },
                  h('button', {
                    className: 'dws_btn', disabled: slotSel.size === 0 || busy !== '',
                    onClick: async () => {
                      const r = await call('/library/for-slot', { slot: sel, ids: [...slotSel], compose: true })
                      if (r !== null && r.ok === true) { setOut({ kind: 'slotlib', r }); say(`该槽位指令：${r.used.length} 条，${r.chars} 字`, true) }
                    },
                  }, `合成该槽位指令（${slotSel.size} 条）`),
                ),
              )
              : null,
            slotLib !== null && slotLib.items.length === 0
              ? h('div', { className: 'dws_note' }, `指令库里还没有「${sel}」用得上的条目 —— 到「指令库」页签点「从工作目录提取素材」，或拆一本书。`)
              : null,

            out?.kind === 'slotlib'
              ? h('div', null,
                h('div', { className: 'dws_ok' }, `「${sel}」指令：${out.r.used?.length ?? 0} 条，${out.r.chars} 字`),
                h('pre', { className: 'dws_pre' }, out.r.text))
              : null,

            // —— 从工作区一键取素材 ——
            sel === 'style_anchor' && (inv?.material.samples.count ?? 0) > 0
              ? h('div', { className: 'dws_bar' },
                h('button', {
                  className: 'dws_btn dws_btn_primary',
                  onClick: () => fillPaths('samples', inv.material.samples.files),
                }, `用「样本/」里的 ${inv.material.samples.count} 个文件`),
                h('span', { className: 'dws_note' }, '（会填进下面的样本路径）'))
              : null,
            sel === 'chapter_pack' && (inv?.material.briefs.count ?? 0) > 0
              ? h('div', null,
                h('div', { className: 'dws_label' }, `细纲里有 ${inv.material.briefs.count} 章，点一个填章号`),
                h('div', { className: 'dws_tochint' },
                  inv.material.briefs.files.slice(0, 30).map((f, i) =>
                    h('span', { key: i, className: 'dws_chip', onClick: () => fillBriefNo(f) }, f.replace(/\.md$/i, '')))))
              : null,
            sel === 'chapter_pack' && (inv?.material.briefs.count ?? 0) === 0
              ? h('div', { className: 'dws_note' }, '细纲目录是空的 —— 到「阅读器」或「小说网站」弄素材，或把细纲放进工作区的 细纲/ 目录。')
              : null,

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
