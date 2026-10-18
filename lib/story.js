/**
 * dsh-writing-slots — 故事引擎：人物压力、信息差、温度、场景代价。
 *
 * 四样东西，共同点是**都能做成可拦截的输入校验**，而不是写完再主观判断：
 *
 *   1. **压力反应表**（人物级，写一次）—— 四档压力下各会怎么做。
 *      没有它，模型只会用「温柔地笑了笑」这类万能描写糊弄。
 *   2. **信息差矩阵**（章级，每章必填）—— 谁不知道什么，以及本章结束时配比怎么变。
 *      章尾钩子的本质就是那一行「配比变化」。
 *   3. **情感温度曲线**（卷级，写一次）—— 连续三章不得同温。
 *   4. **欲望-障碍-代价**（场景级，必填）—— 没有代价的场景就是水场景。
 *
 * 要求里那条最有用：「把水场景从主观判断变成可拦截的输入错误」。
 * 所以这里做的不是提醒，是**拒绝**：代价填不出具体的东西，就返回错误。
 *
 * @module dsh-writing-slots/story
 */

/** 四档压力。档位 3 和 4 是人物立住的地方，所以单列出来强提醒。 */
export const PRESSURE_TIERS = [
  { id: 1, label: '轻微不顺' },
  { id: 2, label: '利益受损' },
  { id: 3, label: '被逼到墙角' },
  { id: 4, label: '失去最重要的人' },
]

/** 抽象代价：这些词说明作者没想清楚，而不是「损失很大」。 */
export const ABSTRACT_COST = [
  /^失去一切$/, /^付出代价$/, /^很惨$/, /^重大损失$/, /^无法承受/,
  /^名誉扫地$/, /^身败名裂$/, /^万劫不复$/, /^所有的一切$/,
]

/** 抽象欲望：要求里点名不接受「想变强」这类。 */
export const ABSTRACT_DESIRE = [
  /^想变强$/, /^想要力量$/, /^想活下去$/, /^想出人头地$/, /^想成功$/, /^想要自由$/,
]

/** 抽象障碍：要求里点名不接受「命运」。 */
export const ABSTRACT_OBSTACLE = [
  /^命运$/, /^宿命$/, /^天意$/, /^时代$/, /^社会$/, /^体制$/, /^这个世界$/,
]

const tooThin = (s) => String(s ?? '').trim().length < 2

/** 校验一个人物的压力反应表（对应 Codex 里的人物条目字段组）。 */
export function validatePressureConfig(config) {
  const errors = []
  const warnings = []
  const c = config ?? {}

  for (const t of PRESSURE_TIERS) {
    const v = c[`pressure_tier_${t.id}`]
    if (tooThin(v)) errors.push(`缺压力档位 ${t.id}（${t.label}）`)
  }
  if (tooThin(c.hidden_motive)) errors.push('缺隐藏动机（人物自己不知道但驱动他的东西）')
  if (tooThin(c.empathy_anchor)) errors.push('缺共情锚点（一个能被认领的日常脆弱）')
  if (!Array.isArray(c.voice_samples) || c.voice_samples.length < 10) {
    warnings.push(`对话样本 ${Array.isArray(c.voice_samples) ? c.voice_samples.length : 0} 句，声音指纹校验需要 10—20 句`)
  }

  // 档位 3/4 是人物立住的瞬间，写得和 1/2 一样含糊就提醒
  for (const id of [3, 4]) {
    const v = String(c[`pressure_tier_${id}`] ?? '')
    if (v !== '' && v.length < 6) warnings.push(`档位 ${id} 写得太短，这一档是人物立住的地方，值得写具体`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    // 档案层不进正文注入，只给审稿用 —— 这里显式说明，免得被一起塞进提示词
    injectionNote: '注入正文时只给当前压力档位那一行 + 隐藏动机 + 共情锚点；档案层（外貌/背景/关系）只给审稿用。',
  }
}

/**
 * 按压力档位裁剪出要注入正文的那一份。
 *
 * 要求里的关键设计：**只注入当前档位那一行**，不是把四档全塞进去 ——
 * 模型拿到太多「人物资料」就会写出一段人物小传式的叙述。
 */
export function pressureSlice(config, level) {
  const c = config ?? {}
  const lvl = Number(level)
  if (!Number.isFinite(lvl) || lvl < 1 || lvl > 4) {
    return { ok: false, reason: `压力档位必须是 1—4（给了 ${JSON.stringify(level)}）` }
  }
  const tier = c[`pressure_tier_${lvl}`]
  if (tooThin(tier)) return { ok: false, reason: `没有档位 ${lvl} 的内容，先补压力反应表` }
  return {
    ok: true,
    level: lvl,
    tierLabel: PRESSURE_TIERS.find((t) => t.id === lvl)?.label ?? '',
    slice: {
      pressure_level: lvl,
      pressure_reaction: tier,
      hidden_motive: c.hidden_motive ?? null,
      empathy_anchor: c.empathy_anchor ?? null,
      // 明确不带 appearance / background / relationships
    },
  }
}

/**
 * 校验信息差矩阵（每章必填）。
 *
 * `intended_shift` 是重点：章尾钩子的本质就是「配比变化」，
 * 一条都没变说明这一章读完读者什么都不知道得更多。
 */
export function validateInfoGap(brief) {
  const errors = []
  const warnings = []
  const b = brief ?? {}

  const groups = ['reader_knows_character_doesnt', 'character_knows_reader_doesnt', 'neither_knows']
  const anyEntry = groups.some((k) => Array.isArray(b[k]) && b[k].length > 0)
  if (!anyEntry) errors.push('三类信息差至少要有一类有内容（否则这一章没有「想知道」的张力）')

  const shift = b.intended_shift
  if (shift === undefined || shift === null || typeof shift !== 'object') {
    errors.push('缺 intended_shift：本章结束时配比怎么变，这是章尾钩子的依据')
    return { ok: false, errors, warnings }
  }
  const parts = ['revealed_to_character', 'newly_planted', 'neither_knows_lit']
  const changed = parts.filter((k) => Array.isArray(shift[k]) && shift[k].length > 0)
  if (changed.length === 0) {
    errors.push('intended_shift 三条全空 —— 本章结束时读者知情状态没有变化，这一章可以被跳过')
  }
  // 只埋不收 vs 只收不埋：连续这样会失衡，给个提醒
  if (changed.length === 1 && changed[0] === 'newly_planted') {
    warnings.push('本章只埋新信息、没有回收 —— 注意别让悬念积压太久')
  }
  if (changed.length === 1 && changed[0] === 'revealed_to_character') {
    warnings.push('本章只回收、没有新埋 —— 读者手里没有新的「想知道」')
  }

  return { ok: errors.length === 0, errors, warnings, changed }
}

/**
 * 校验场景的「欲望—障碍—代价」。
 *
 * @param scene `{ desire, obstacle, cost_if_fail, outcome, cost_paid }`。
 * @param index 场景序号（报错时用）。
 */
export function validateScene(scene, index = 0) {
  const s = scene ?? {}
  const at = `场景 ${index + 1}`

  const desire = String(s.desire ?? '').trim()
  const obstacle = String(s.obstacle ?? '').trim()
  const cost = String(s.cost_if_fail ?? '').trim()
  const outcome = String(s.outcome ?? '').trim()
  const paid = String(s.cost_paid ?? '').trim()

  // 要求里点名：代价不具体就**拒绝生成该场景**，不是提醒
  if (cost === '' || ABSTRACT_COST.some((re) => re.test(cost))) {
    return { ok: false, error: 'cost_not_concrete', sceneIndex: index, reason: `${at}：失败代价不具体（「${cost || '空'}」）。填不出具体损失就不生成这个场景。` }
  }
  if (desire === '' || ABSTRACT_DESIRE.some((re) => re.test(desire))) {
    return { ok: false, error: 'desire_not_concrete', sceneIndex: index, reason: `${at}：欲望不具体（「${desire || '空'}」）。不接受「想变强」这类抽象表述。` }
  }
  if (obstacle === '' || ABSTRACT_OBSTACLE.some((re) => re.test(obstacle))) {
    return { ok: false, error: 'obstacle_not_concrete', sceneIndex: index, reason: `${at}：障碍不具体（「${obstacle || '空'}」）。要具体的人／规则／时间，不接受「命运」。` }
  }
  // 得到了却没付出代价 = 无代价场景
  if (outcome === '得到' && paid === '') {
    return { ok: false, error: 'cost_free_scene', sceneIndex: index, reason: `${at}：结果「得到」但没写付出的代价 —— 无代价场景，计入审稿警告。` }
  }
  const validOutcome = ['得到', '部分得到', '失去']
  if (!validOutcome.includes(outcome)) {
    return { ok: false, error: 'bad_outcome', sceneIndex: index, reason: `${at}：outcome 必须是 ${validOutcome.join(' / ')}（给了「${outcome}」）` }
  }

  return { ok: true, sceneIndex: index, costPaid: paid }
}

/** 批量校验一章的场景表。 */
export function validateScenes(scenes) {
  const list = Array.isArray(scenes) ? scenes : []
  if (list.length === 0) return { ok: false, errors: ['没有场景表'], scenes: [] }
  const results = list.map((s, i) => validateScene(s, i))
  const bad = results.filter((r) => r.ok !== true)
  return {
    ok: bad.length === 0,
    errors: bad.map((r) => r.reason),
    results,
    // 有没有「人物做了选择并因此付出可感知代价」的时刻
    hasCostMoment: results.some((r) => r.ok === true && r.costPaid !== ''),
  }
}

/**
 * 校验卷级情感温度曲线。
 *
 * 要求里那条约束很具体：**连续三章不得为同一 target** —— 连续同温是
 * 读者流失的高发区。
 */
export function validateCurve(curve) {
  const c = curve ?? {}
  const entries = Object.entries(c.curve ?? {})
    .map(([k, v]) => ({ no: Number(k), target: typeof v === 'string' ? v : v?.target, range: typeof v === 'object' ? v?.range : null }))
    .filter((x) => Number.isFinite(x.no))
    .sort((a, b) => a.no - b.no)

  if (entries.length === 0) return { ok: false, errors: ['曲线是空的'], entries: [] }

  const errors = []
  const warnings = []
  // 连续三章同温
  for (let i = 0; i + 2 < entries.length; i += 1) {
    const three = entries.slice(i, i + 3)
    if (three.every((x) => x.target === three[0].target)) {
      warnings.push(`第 ${three[0].no}–${three[2].no} 章连续三章都是「${three[0].target}」—— 连续同温是读者流失的高发区`)
    }
  }
  const missing = entries.filter((x) => x.target === undefined || x.target === null || x.target === '')
  if (missing.length > 0) errors.push(`有 ${missing.length} 章没给 target`)

  return { ok: errors.length === 0, errors, warnings, entries }
}

/** 取某一章的目标温度（给 Chapter Pack 注入）。 */
export function temperatureAt(curve, chapterNo) {
  const c = curve?.curve ?? {}
  const v = c[String(Number(chapterNo))] ?? c[chapterNo]
  if (v === undefined) return { ok: false, reason: `温度曲线里没有第 ${chapterNo} 章` }
  return {
    ok: true,
    target: typeof v === 'string' ? v : v?.target,
    range: typeof v === 'object' && Array.isArray(v?.range) ? v.range : null,
  }
}
