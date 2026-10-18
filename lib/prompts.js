/**
 * dsh-writing-slots — 四个模块的提示词模板。
 *
 * 按要求的写法：**声明式块 + `{槽位}` 占位符**，不写成散文段落。
 * 每个模板配一份槽位声明（required / auto_injected / optional），
 * 渲染前由 `render.js` 的契约校验把关。
 *
 * 模板本身**不含任何具体内容** —— 填什么是活的，槽位是死的。
 *
 * @module dsh-writing-slots/prompts
 */

/** 模块 1：Style Anchor（系统层，常驻）。 */
export const STYLE_ANCHOR = {
  id: 'style_anchor',
  title: 'Style Anchor（文风锚点）',
  runsWhen: '项目初始化时，只跑一次',
  gate: '人审「这像不像我写的」',
  output: 'style-guide.md',
  contract: {
    required: ['sample_corpus'],
    // 这些都由系统统计好后注入 —— 模型不重算数字，只挑例句、写禁止项。
    auto_injected: [
      'measurements',
      'sentence_summary', 'paragraph_summary', 'sensory_summary', 'metaphor_summary',
      'forbidden_candidates',
    ],
    optional: ['genre_tags', 'project'],
  },
  template: `ROLE: style_analyst
MODE: read_only
TASK:
  分析所提供的 {sample_corpus}，输出一份 style-guide。
  下面已经给出**可复核的统计结果**（{measurements}）。你的任务不是重新估算
  这些数字，而是：为每一条挑出最有代表性的原文例句作为锚，并把
  「禁忌清单」写成写作时能直接执行的禁止项。

OUTPUT_FORMAT: markdown
REQUIRED_SECTIONS:
  - sentence_length_baseline: "{sentence_summary}"
  - paragraph_rhythm: "{paragraph_summary}"
  - sensory_bias: "{sensory_summary}"
  - metaphor_fingerprint: "{metaphor_summary}"
  - forbidden_list: "该样本中从未出现的句式或词汇类型（下面已列出）"

{#if genre_tags}
体裁标签：{genre_tags}
{/if}
{#if project}
项目：{project}
{/if}

CONSTRAINTS:
  - 不得评价样本"好不好"，只描述特征
  - 每一条判断必须附一个样本中的原文例句作为锚
  - 统计数字必须原样引用上面给出的值，不得重新估算或改写

下面是系统统计出来的禁忌候选（这些句式在样本中**一次都没有出现**）：
{forbidden_candidates}`,
}

/** 模块 2：Chapter Pack（任务层，每章调用）。 */
export const CHAPTER_PACK = {
  id: 'chapter_pack',
  title: 'Chapter Pack（单章包）',
  runsWhen: '每章动笔前',
  gate: '人审章尾钩子和情感落点',
  output: '初稿正文',
  contract: {
    required: ['chapter_no', 'chapter_task', 'word_range'],
    auto_injected: ['style_guide_digest', 'bible_slice', 'prev_recap'],
    optional: ['avoid_list', 'pov', 'tense', 'ending_type'],
  },
  template: `ROLE: chapter_drafter
CHAPTER: {chapter_no}
WORD_RANGE: {word_range}

CHAPTER_TASK:
  事件：{chapter_task.event}
  出场：
{chapter_task.cast}
  效果：{chapter_task.desired_effect}
  停在：{chapter_task.stop_at}

STYLE_GUIDE（固定前缀，来自 Style Anchor 的摘要）:
{style_guide_digest}

BIBLE_SLICE（只含本章涉及的部分）:
{bible_slice}

PREV_RECAP（上一章结尾）:
{prev_recap}

{#if avoid_list}
AVOID（本章禁止做的事）:
{avoid_list}
{/if}

OUTPUT_CONTRACT:
  format: prose
  pov: "{pov}"
  tense: "{tense}"
  ending_type: "{ending_type}"

CONSTRAINTS:
  - 不进入 {pov} 以外角色的内心
  - 不提前回收 avoid_list 中列出的伏笔
  - 章末停在 stop_at 指定的事件节点，不自行延伸
  - 字数落在 {word_range} 内
  - 只输出正文，不要标题、不要解释、不要小标题`,
}

/**
 * 模块 3：Review Pass（独立审稿通道，强制新会话）。
 *
 * 注意 `contract.required` 里**没有**章节任务、没有风格指南 ——
 * 这正是隔离：审稿不该知道作者想写成什么样，否则会替作者找理由。
 */
export const REVIEW_PASS = {
  id: 'review_pass',
  title: 'Review Pass（审稿通道）',
  runsWhen: '初稿完成后，独立会话',
  gate: '人决定哪些改、哪些不改',
  output: '结构化问题清单（JSON）',
  contract: {
    required: ['draft'],
    auto_injected: ['bible_snapshot', 'prev_summary'],
    optional: [],
  },
  template: `ROLE: cold_editor
CONTEXT_ISOLATION: true
INPUTS:
  draft: 下面给出
  bible_snapshot: 下面给出（当前章节时点的人物状态/关系/物品状态）
  prev_summary: 下面给出（上一章摘要）

DRAFT:
{draft}

BIBLE_SNAPSHOT:
{bible_snapshot}

PREV_SUMMARY:
{prev_summary}

CHECK_DIMENSIONS:
  - character_consistency: 人物言行是否偏离已建立人设
  - factual_contradiction: 时间/地点/物品/关系矛盾，附原文定位
  - information_density: 本章能否被一句话概括而不丢失必要信息
  - hook_effectiveness: 章尾是否产生"必须翻页"的力

OUTPUT_FORMAT: json
  [{
    "dimension": "character_consistency | factual_contradiction | information_density | hook_effectiveness",
    "severity": "fatal | warning | pass",
    "location": "段落/句定位（fatal 与 warning 必填）",
    "finding": "具体问题，不评价文笔好坏",
    "action": "可操作修改方向（fatal 与 warning 必填）"
  }]

CONSTRAINTS:
  - 不输出整体评语
  - 不给出"建议重写整章"这类非原子指令
  - 四个维度都要给出结论（没问题就给 severity=pass 的条目）
  - 只输出 JSON 数组，不要任何解释文字`,
}

/** 模块 4：De-AI Polish（最后一道闸）。 */
export const DEAI_POLISH = {
  id: 'deai_polish',
  title: 'De-AI Polish（去味层）',
  runsWhen: '审稿修改后，最后一刀',
  gate: '人通读「有没有不像我的句子」',
  output: '润色稿 + change_log',
  contract: {
    required: ['text'],
    auto_injected: ['style_guide_forbidden', 'violations'],
    optional: ['short_ratio_floor'],
  },
  template: `ROLE: voice_guardian
TASK:
  只做一件事：删掉不像人写的部分。**不负责"写好"**，不要增删情节，
  不要调整结构，不要改变事实。

TEXT:
{text}

RULES（判断依据全部来自 Style Anchor 的 forbidden_list）:
  - 禁止段首连续以同一人称代词开头
  - 禁止 "仿佛/似乎/一种……的感觉" 句式
  - 禁止对话后除 "说道/问道" 外的描述性标签
  - 禁止在场景结束时替读者总结意义
  - 短句占比不得低于 {short_ratio_floor}

FORBIDDEN_LIST（该样本中从未出现，因此不要引入）:
{style_guide_forbidden}

系统已经扫描出的违规点（逐条改掉它们，不要顺手改别的）：
{violations}

OUTPUT:
  revised_text  —— 改完的正文
  change_log    —— **只列改动类型与计数**，不写解释

CONSTRAINTS:
  - 只改上面列出的违规点，其余一字不动
  - 改动不得让字数变化超过 ±3%
  - 不引入新的比喻、不新增形容词
  - 输出用 \`\`\`json 包一份 { "revised_text": "...", "change_log": [...] }`,
}

/** 四个模块的清单（给界面与工具用）。 */
export const MODULES = [STYLE_ANCHOR, CHAPTER_PACK, REVIEW_PASS, DEAI_POLISH]
