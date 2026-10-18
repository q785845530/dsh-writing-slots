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

/** 模块 0a：World Builder（世界观，项目初始化，先于正文）。 */
export const WORLD_BUILDER = {
  id: 'world_builder',
  title: 'World Builder（世界观）',
  runsWhen: '项目初始化时，与 Style Anchor 并列；正文动笔前',
  gate: '人审「每个设定是否都有代价和限制」',
  output: 'world-bible.md',
  contract: {
    required: ['genre'],
    auto_injected: [],
    optional: ['existing_outline', 'constraints', 'avoid'],
  },
  template: `ROLE: world_architect
MODE: read_only
TASK:
  为 {genre} 搭建世界观框架。**不要一次"生成"，要"逼出代价"**：
  每一条设定都必须带上它的代价与限制。一个没有代价的力量体系，
  写起来必然悬浮 —— 这是本次任务的核心判据。

{#if existing_outline}
已有大纲（沿用其中已确立的设定，不要另起一套）：
{existing_outline}
{/if}
{#if constraints}
额外约束：
{constraints}
{/if}
{#if avoid}
避免：
{avoid}
{/if}

OUTPUT_FORMAT: markdown
REQUIRED_SECTIONS（每节 150—300 字，多写可感知的细节，不要宏大空泛）:
  ## 基础设定
  ## 力量体系
     必须写明**使用代价**与**限制**（哪两样缺一不可，写清楚）
  ## 社会结构
     核心矛盾是什么
  ## 近百年重大事件
     三次事件如何塑造当前格局
  ## 隐藏规则
     至少两条"多数人不知道但确实存在"的规则
  ## 普通人日常场景
     三个具体场景（要让读者能闻到味道）
  ## 自检
     这个世界观里有没有"我自己也解释不清楚"的部分？有就说出来

CONSTRAINTS:
  - 力量体系的代价与限制是硬要求，缺了会被打回
  - 每节 150—300 字，超了或不足都会被打回
  - 隐藏规则至少两条、日常场景三个，数量不足会被打回
  - 只输出 markdown，不要解释文字`,
}

/** 模块 0b：Character Designer（人物，项目初始化）。 */
export const CHARACTER_DESIGNER = {
  id: 'character_designer',
  title: 'Character Designer（人物）',
  runsWhen: '项目初始化时；新角色登场前',
  gate: '人审「三者的冲突是否真的成立」',
  output: '人物卡（追加到设定库）',
  contract: {
    required: ['character'],
    auto_injected: [],
    optional: ['role', 'genre', 'existing'],
  },
  template: `ROLE: character_designer
MODE: read_only
TASK:
  为「{character}」写一张人物卡。不要只给姓名年龄外貌 —— 要交出一个
  **有内在矛盾的人**。

CHARACTER: {character}
{#if role}
定位：{role}
{/if}
{#if genre}
题材：{genre}
{/if}
{#if existing}
已有设定（不要与之冲突）：
{existing}
{/if}

OUTPUT_FORMAT: markdown
REQUIRED_FIELDS:
  ## 表面欲望
     他以为自己想要什么
  ## 真实需求
     他真正需要、但自己没意识到的
  ## 致命缺陷
     会影响剧情走向的性格缺陷
  ## 内心独白
     约 100 字，展示上面三者的矛盾
  ## 过往创伤
     冷静笔触，不煽情
  ## 标志行为
     愤怒时会做什么／恐惧时会做什么／狂喜时会做什么（三档都要有）

CONSTRAINTS:
  - 表面欲望、真实需求、致命缺陷**三者之间必须存在冲突** —— 这是硬要求
  - 内心独白约 100 字
  - 过往创伤用冷静笔触，不要"痛不欲生""撕心裂肺"这类词
  - 三档情绪的标志行为缺一档都会被打回
  - 只输出 markdown，不要解释文字`,
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

/**
 * 模块 5：Reader Simulation（读者通道）。
 *
 * 和 Review Pass **并列**，不替代它。跑在初稿之后、审稿之前 ——
 * 要模拟的是「第一次翻开这一章」，所以必须读未修改的初稿。
 */
export const READER_SIM = {
  id: 'reader_sim',
  title: 'Reader Simulation（读者通道）',
  runsWhen: '初稿完成后，**在 Review Pass 之前**（读者要读未修改的稿）',
  gate: '读者反馈是信息不是命令 —— 改不改由作者定',
  output: '三个读者的第一人称反应 + 三个锚点（体温，不是指令）',
  contract: {
    required: ['draft', 'persona'],
    // 人格提示词由 lib/reader.js 按选中的读者生成后注入
    auto_injected: ['persona_prompt', 'chapter_no'],
    optional: [],
  },
  template: `{persona_prompt}

DRAFT（第 {chapter_no} 章初稿）:
{draft}`,
}

/**
 * 模块 8：Instruction Miner（拆文入库）。
 *
 * 「多次读小说 → 沉淀」的那一步。读一本书（或一本书的一段），抽出**可执行的
 * 指令片段**，产出 JSON 交给指令库。
 *
 * 关键判据写在模板里：抽出来的必须是**指令**（能被执行），不是**资料**
 * （给人读的感想）。「这本书节奏好」不是指令；「每章至少一次信息差变化，
 * 且必须落在那条被点亮的信息上」才是。
 */
export const INSTRUCTION_MINER = {
  id: 'instruction_miner',
  title: 'Instruction Miner（拆文入库）',
  runsWhen: '读一本书之后 —— 想把它沉淀成可复用的写作指令时',
  gate: '人审抽出来的条目：是不是「指令」而不是「感想」',
  output: '一批指令库条目（JSON），导入后进「指令库」页签',
  contract: {
    required: ['book_text'],
    auto_injected: ['book_name', 'focus_kinds'],
    optional: ['existing_items'],
  },
  template: `ROLE: instruction_miner
MODE: read_only
TASK:
  读下面这本书（或这一段），抽出**可复用的写作指令**，产出一个 JSON 数组。

  **判据（这条最重要）**：抽出来的必须是**指令**，不是**资料**。
    ✗ 资料（给人读的感想）：「这本书节奏很好」「人物塑造立体」
    ✓ 指令（能被执行）：「每章至少一次信息差变化，且必须落在那条被点亮的信息上」
    ✗ 资料：「打斗场面描写精彩」
    ✓ 指令：「打斗不写招式名，只写身体的反应（呼吸、手抖、脚下的碎响）」

  每条指令都要能**脱离这本书单独使用** —— 不要出现这本书的专名。

FOCUS（本次重点抽这几类）:
{focus_kinds}

SOURCE（书名/来源，写进条目的 source 字段）:
{book_name}

{existing_items}

OUTPUT_FORMAT: json（**只输出 JSON 数组，不要解释文字，不要包 markdown 代码块**）
[
  {{
    "kind": "rule | style | structure | character | trope | material",
    "name": "条目名（一句话，看得出是什么指令）",
    "summary": "一句话说明这条指令解决什么问题",
    "body": "指令正文 —— 会被直接拼进最终写作指令，所以要写成祈使句/约束",
    "tags": ["可选标签"]
  }}
]

KIND 的含义:
  rule      硬规则：禁止事项、必须满足的约束
  style     文风：句长、节奏、感官偏好、比喻落点
  structure 结构：信息差、钩子、张力曲线、章节骨架
  character 人物：压力反应、共情锚点、声音指纹
  trope     桥段：可复用的情节机关与转折设计
  material  素材：设定、名词、灵感碎片

CONSTRAINTS:
  - 每条 body 至少 30 字，要具体到能照着做
  - 不要抽「这本书讲了什么」—— 那是读后感，不是指令
  - 抽不出某一类就少给几条，不要为了凑数写空话
  - book 文本：

{book_text}`,
}

/** 四个模块的清单（给界面与工具用）。 */
export const MODULES = [
  STYLE_ANCHOR, WORLD_BUILDER, CHARACTER_DESIGNER,   // 上游（初始化）
  CHAPTER_PACK,                                      // 任务层
  READER_SIM, REVIEW_PASS,                           // 两条并行通道（读者先跑）
  DEAI_POLISH,                                       // 最后一刀
  INSTRUCTION_MINER,                                 // 沉淀进指令库
]

/** 初始化阶段的两个上游模块（正文动笔前跑）。 */
export const UPSTREAM_MODULES = [STYLE_ANCHOR, WORLD_BUILDER, CHARACTER_DESIGNER]
