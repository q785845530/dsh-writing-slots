/**
 * dsh-writing-slots — Reader Simulation（读者通道）。
 *
 * 这是和 Review Pass **并列**的另一条通道，不是它的替代：
 *
 * ```
 * Chapter Pack 出初稿
 *       ├── Reader Simulation（三个读者，读反应）→ 第一人称体温
 *       └── Review Pass（冷面编辑，查一致性）   → JSON 问题清单
 * ```
 *
 * ## 为什么读者不是一个「评估维度」
 * 要求里反复强调：「读者插件不是替你判断好不好，是替你在你不在场的时候，
 * 当一次那个会跑掉的读者」。所以读者被拆成**三个具体的人**，各有生活场景、
 * 阅读习惯、忍耐阈值和会合上书的理由 —— 「目标读者画像」那种抽象说法没用，
 * 模型会把它演成一个礼貌的评审。
 *
 * ## 输出的铁律
 * 禁止文学批评术语（节奏、弧光、张力、信息密度…），禁止修改建议，
 * 只准第一人称说「我读到这儿怎么样了」。产出是**体温，不是指令**。
 *
 * ## 顺序
 * 读者通道要**先跑**：它模拟的是「第一次翻开这一章」的体验，必须读未经修改的
 * 初稿。编辑通道会改稿，改完的稿子已经不是读者第一眼看到的东西了。
 *
 * @module dsh-writing-slots/reader
 */

/** 输出锚点的取值。只有三个，不给「还行」这种中间态。 */
export const CONTINUE_VALUES = ['yes', 'no', 'maybe']

/** 禁止出现的文学批评术语。 */
export const BANNED_TERMS = [
  '节奏', '弧光', '张力', '信息密度', '人物塑造', '叙事', '结构',
  '铺垫', '伏笔', '主题', '象征', '隐喻', '文本', '读者体验',
  '刻画', '塑造', '笔法', '文笔',
]

/** 禁止出现的修改建议句式。 */
export const BANNED_ADVICE = [
  /建议(修改|删掉|删去|调整|重写)/, /应该(改成|写成|删掉|加一段)/,
  /可以(考虑)?(改为|改成|增加|删除)/, /最好(改|删|加)/,
  /需要(修改|删减|补充)/, /此处(应|建议)/,
]

/**
 * 三个读者人格。
 *
 * 每个都写**生活**，不写参数 —— 要求里那条很准：「不写『注意力持续时间：短』，
 * 写『一章超过五分钟没抓住他就切去刷短视频』」。模型对具体生活场景的模拟，
 * 远好于对抽象参数的执行。
 */
export const READERS = [
  {
    id: 'commuter',
    name: '小陈',
    title: '通勤读者',
    tests: '会不会继续读（留存）',
    persona: `名字：小陈，28 岁，每天地铁四十分钟，手机读小说，容易分心。
阅读习惯：一章超过五分钟没抓住他就切去刷短视频。
偏见：讨厌铺垫，但也不喜欢被硬塞钩子；对"解释型段落"零耐心。
忍耐阈值：连续两段没有"发生了什么"，他就开始走神。
他会放弃的信号：读到一段他能在脑子里快进过去的文字。`,
    questions: [
      '我读到哪一段开始走神？那段在讲什么（用我自己的话说）？',
      '读完最后一句，我想不想点下一章？为什么（说感受，不说理由分析）？',
      '这一章有没有一句话，我读完之后在脑子里停了一下？有就引出来，没有就说没有。',
    ],
  },
  {
    id: 'rereader',
    name: '阿岚',
    title: '回头读者',
    tests: '会不会记住（人物可信度与记忆点）',
    persona: `名字：阿岚，35 岁，读得慢，会在页边写批注，一本书读两遍。
阅读习惯：记得住细节，最恨前后矛盾，也最容易被"早有伏笔"击中。
偏见：对人物比对情节上心；人物做了一件她没料到但回头能理解的事，她会记很久。
她会失望的信号：人物做了某件事，她想不出"他为什么会这样"。`,
    questions: [
      '这一章里，有没有一个人做的某件事，让我愣了一下、然后觉得"是他会做的"？引用那个动作。',
      '有没有哪句话或哪个动作，让我觉得"这个人我认识"？如果有，描述那个瞬间。',
      '本章有没有让我觉得"人物不像他自己"的地方？如果有，指出是哪里让我出戏。',
    ],
  },
  {
    id: 'harsh',
    name: '老周',
    title: '苛刻读者',
    tests: '有没有被糊弄（去 AI 味与留白）',
    persona: `名字：老周，45 岁，读了三十年小说，最烦被当傻子。
阅读习惯：一眼看出万能描写，对"仿佛""似乎""一种……的感觉"极度敏感。
偏见：解释就是冒犯，总结就是侮辱；宁可作者少说，不要多说。
他会反感的信号：作者替他把情绪点了名，或者把场景意义总结了一遍。`,
    questions: [
      '有没有哪一处，我觉得作者在替我感受、替我想？引用那句，并说出我当时的第一反应（比如"我知道，不用你说"）。',
      '有没有哪一句是"放之四海而皆准"的句子——换个人物、换本书也能用？如果有，引出来。',
      '整体上，我有没有觉得被尊重？还是被喂？',
    ],
  },
]

/** 按 id 取读者人格。 */
export function reader(id) {
  return READERS.find((r) => r.id === id) ?? null
}

/**
 * 生成一个读者人格的提示词。
 *
 * HARD_RULE 写在最前面：那三条是这条通道的立身之本，写松了它就退化成
 * 又一个「帮你点评一下」的评审。
 */
export function promptFor(persona, chapterNo) {
  const q = persona.questions.map((x, i) => `  ${i + 1}. ${x}`).join('\n')
  return `ROLE: reader_simulation
PERSONA: ${persona.title}（${persona.name}）

HARD_RULE:
  你是一个正在读这本小说的人，不是编辑，不是评论者。
  禁止使用任何文学批评术语（${BANNED_TERMS.slice(0, 8).join('、')}……）。
  禁止给出修改建议。
  只准用第一人称描述：你读到哪里、身体和情绪发生了什么、想不想往下翻。
  如果你发现自己在分析，停下来，重新做回读者。
  如果你在某处想提修改建议，把它改写成"我读到这里希望发生什么／不希望发生什么"，
  不准说"应该怎么改"。
  如果本章没有任何一句话让你停了一下，直接说"没有"，不要为了交差编一句出来 ——
  空的 memorable_line 是有效信号，编出来的才是污染。

你是谁：
${persona.persona}

TASK:
  读完第 ${chapterNo} 章。用第一人称回答下面三件事，每件不超过两句话：
${q}

OUTPUT:
  first_person_reaction: 上面三个问题的回答（自由叙述）
  anchors:
    continue_reading: yes | no | maybe
    memorable_line: "引原文" 或 null
    skip_urge_location: "读到第几段想跳过" 或 null

CONSTRAINT:
  三个锚点必须和你上面的叙述一致。若叙述里说"还行"但 continue_reading=no，
  以锚点为准，并在叙述里说清为什么。`
}

/**
 * 校验一个读者的产出。
 *
 * 这条通道的校验和别处不同：它查的是**有没有越权**（用了批评术语、
 * 给了修改建议），而不是「说得对不对」。读者没有对错，只有反应。
 */
export function validateReaderOutput(payload) {
  const errors = []
  const warnings = []

  let obj = payload
  if (typeof payload === 'string') {
    const cleaned = payload.replace(/^\s*```(?:json|yaml|yml)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    try { obj = JSON.parse(cleaned) } catch {
      // 不是 JSON 也可能是纯第一人称叙述 —— 那就只做术语扫描
      obj = { first_person_reaction: cleaned }
      warnings.push('输出不是 JSON，只做了越权扫描；锚点缺失')
    }
  }
  if (obj === null || typeof obj !== 'object') {
    return { ok: false, errors: ['输出为空或不是对象'], warnings, anchors: null }
  }

  const reaction = String(obj.first_person_reaction ?? obj.reaction ?? '')
  const anchors = obj.anchors ?? obj

  // 越权扫描：批评术语
  const hitTerms = BANNED_TERMS.filter((t) => reaction.includes(t))
  if (hitTerms.length > 0) {
    errors.push(`用了文学批评术语：${hitTerms.join('、')} —— 读者不该这么说话`)
  }
  // 越权扫描：修改建议
  for (const re of BANNED_ADVICE) {
    const m = re.exec(reaction)
    if (m !== null) { errors.push(`给了修改建议（「${m[0]}」）—— 读者只说反应，不说该怎么改`); break }
  }
  // 非第一人称
  if (reaction !== '' && !/[我]/.test(reaction)) {
    warnings.push('通篇没有出现「我」—— 这条通道要求第一人称')
  }

  // 锚点
  const cont = anchors?.continue_reading
  const okCont = CONTINUE_VALUES.includes(cont)
  if (!okCont) errors.push(`continue_reading 必须是 ${CONTINUE_VALUES.join(' / ')}（给了 ${JSON.stringify(cont)}）`)

  const memorable = anchors?.memorable_line ?? null
  const skip = anchors?.skip_urge_location ?? null
  // null 是有效信号，但要显式给出来 —— 缺字段和「没有」不是一回事
  if (!('memorable_line' in (anchors ?? {}))) warnings.push('没给 memorable_line 字段（没有也要显式写 null）')
  if (!('skip_urge_location' in (anchors ?? {}))) warnings.push('没给 skip_urge_location 字段')

  // 「没感觉」必须被允许 —— 编出来的 memorable_line 才是污染
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    anchors: {
      continue_reading: okCont ? cont : null,
      memorable_line: typeof memorable === 'string' && memorable.trim() !== '' ? memorable.trim() : null,
      skip_urge_location: typeof skip === 'string' && skip.trim() !== '' ? skip.trim() : null,
    },
    // 明确标出来：这个读者没记住任何句子
    noMemorable: memorable === null || memorable === undefined || String(memorable).trim() === '',
  }
}

/**
 * 把三个读者的产出汇总成一张「体温表」。
 *
 * 要求里那条判断很实用：三个都说 no → 大概率是结构问题；
 * 只有通勤读者说 no → 可能这章本来就偏静，由作者决定要不要为留存牺牲质地。
 */
export function summarize(results) {
  const list = (results ?? []).map((r) => ({ id: r.id, name: r.name, ...r.verdict }))
  const nos = list.filter((x) => x.anchors?.continue_reading === 'no')
  const memorables = list.filter((x) => x.anchors?.memorable_line !== null && x.anchors?.memorable_line !== undefined)
  const skips = list.filter((x) => x.anchors?.skip_urge_location !== null && x.anchors?.skip_urge_location !== undefined)

  let reading = '三个读者的反应不一致，看具体条目自行判断。'
  if (list.length > 0) {
    if (nos.length === list.length) {
      reading = '三个读者都不想往下读 —— 大概率是结构问题，值得重看这一章。'
    } else if (nos.length === 1 && nos[0].id === 'commuter' && memorables.length > 0) {
      reading = '只有通勤读者想放下，另两位有记忆点 —— 可能这章本来就偏静，要不要为留存牺牲质地，由你定。'
    } else if (nos.length === 0 && memorables.length === 0) {
      reading = '没人想放下，但也没人记住任何句子 —— 读得下去，但留不下东西。'
    } else if (nos.length === 0) {
      reading = '三个读者都愿意继续读，且有记忆点。'
    }
  }

  return {
    list,
    // 三样都是「信息」，不是「命令」
    nos: nos.map((x) => x.name),
    memorables: memorables.map((x) => ({ name: x.name, line: x.anchors.memorable_line })),
    skipUrges: skips.map((x) => ({ name: x.name, at: x.anchors.skip_urge_location })),
    reading,
    // 要求里明写：插件永远不说「这章不行」
    verdictText: '读者反馈是信息，不是命令。改不改是作者对读者的承诺问题。',
  }
}
