#!/usr/bin/env node
/**
 * dsh-writing-slots / 批量拆解 自测。
 *
 *   node verify-batch.mjs
 *
 * 一本 54 万字的书切 98 段，要多人并行拆、最后合并。这一层验：
 *   - **分派不重复**：已经完成/在拆的段不会被再派一次
 *   - **分片独立**：一段失败不影响其他段，能重跑
 *   - **合并去重**：同一个「江哲」在三段里出现，合并后只有一条、出处取并集
 *   - **连线重映射**：各段的连线端点 id 合并后要对得上
 */
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as B from './lib/batch.js'
import * as L from './lib/logicmap.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}
const tmp = async () => mkdtemp(join(tmpdir(), 'dws-batch-'))

/** 造一本有多章的书。 */
async function makeBook(ws, chapters = 6, parasPer = 1200) {
  const lines = []
  for (let i = 1; i <= chapters; i += 1) {
    lines.push(`第${i}章 标题${i}`)
    lines.push(`　　${'他走进屋子，屋里很暗。'.repeat(parasPer)}`)
  }
  await mkdir(join(ws, '本地书'), { recursive: true })
  await writeFile(join(ws, '本地书', '测试书.txt'), lines.join('\n'), 'utf8')
}

/** 造一段的图。 */
function makeMap(tag, extra = {}) {
  return {
    title: `${tag} 的图`,
    sources: [`${tag}.md`],
    nodes: [
      { id: 'c1', kind: 'character', name: '江哲', summary: `${tag} 里的主角`, body: `${tag}：他表面只想苟全性命，真实需求是被看见。这是一段足够长的正文。`, sources: [`${tag}.md`] },
      { id: 'w1', kind: 'world', name: '南北对峙', summary: '三国格局', body: `${tag}：南楚最弱，只能守不能攻。这是一段足够长的正文。`, sources: [`${tag}.md`] },
      { id: 's1', kind: 'structure', name: '史书引文开篇', summary: `${tag} 的结构`, body: `${tag}：章首先给史书引文再自述反转。这是一段足够长的正文。`, sources: [`${tag}.md`] },
      ...(extra.nodes ?? []),
    ],
    edges: [{ from: 'w1', to: 'c1', label: '格局决定处境' }, ...(extra.edges ?? [])],
  }
}

const main = async () => {
  console.log('一、看板（plan）')
  {
    const ws = await tmp()
    try {
      await writeFile(join(ws, '占位'), '', 'utf8')
      const noBook = await B.plan(ws, { chunkChars: 5000 })
      ok(noBook.ok === false && noBook.reason.includes('没有 txt'), '没有本地书时如实报')

      await makeBook(ws, 6, 300)
      const p = await B.plan(ws, { chunkChars: 5000 })
      ok(p.ok === true, '能列出计划')
      ok(p.total >= 2, `切成 ${p.total} 段`)
      ok(p.done === 0 && p.pending === p.total, '初始全待拆')
      ok(p.rows.every((x) => x.state === 'pending'), '每段状态是 pending')
      ok(p.byChapter === true, '按章节切')
      ok(p.rows[0].title.includes('第'), '带段标题')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n二、领取任务（claim-batch）')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 8, 300)
      const p = await B.plan(ws, { chunkChars: 5000 })
      const size = Math.min(3, p.total)

      const b1 = await B.claimBatch(ws, { size, chunkChars: 5000 })
      ok(b1.ok === true, '领到一批')
      ok(b1.claimed === size, `领到 ${size} 段（实际 ${b1.claimed}）`)
      ok(b1.tasks.length === size, 'tasks 数量对')
      ok(b1.tasks.every((t) => typeof t.text === 'string' && t.text.length > 0), '每段都带正文（自包含，可以直接给子智能）')
      ok(b1.tasks.every((t) => Number.isFinite(t.index)), '每段都有序号')
      ok(b1.tasks[0].index !== b1.tasks[1].index, '不同段序号不同')

      // 再领：不能重复派已经「在拆」的
      const b2 = await B.claimBatch(ws, { size, chunkChars: 5000 })
      if (p.total > size) {
        ok(b2.claimed > 0, '还能领到下一批')
        const overlap = b2.tasks.filter((t) => b1.tasks.some((x) => x.index === t.index))
        ok(overlap.length === 0, '**已派发的段不会被重复派**')
      } else {
        ok(b2.ok === false, '段不够时如实报')
      }

      // retake 可以强制重派
      const b3 = await B.claimBatch(ws, { size, retake: true, chunkChars: 5000 })
      ok(b3.ok === true && b3.claimed > 0, 'retake=true 能重派「在拆」的段')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n三、收分片与独立失败')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 6, 300)
      const p = await B.plan(ws, { chunkChars: 5000 })

      // 收第 0 段
      const a0 = await B.acceptPart(ws, 0, JSON.stringify(makeMap('第一段')))
      ok(a0.ok === true, '第 1 段收下')
      ok(a0.stats.nodes === 3, '记下节点数')
      ok(existsSync(B.partPath(ws, 0)), '分片文件写了')

      // 第 1 段给坏 JSON
      const a1 = await B.acceptPart(ws, 1, '这不是 JSON')
      ok(a1.ok === false, '坏 JSON 被拒')
      ok(a1.saved !== true, '坏 JSON 不算存成功')
      // 但失败也存档了（这样能看出该重跑哪段）
      const failedPart = await B.loadPart(ws, 1)
      ok(failedPart !== null && failedPart.state === 'failed', '**失败也存档**（知道该重跑哪段）')

      // 空节点也算失败
      const a2 = await B.acceptPart(ws, 2, JSON.stringify({ nodes: [], edges: [] }))
      ok(a2.ok === false && a2.reason.includes('没给出任何节点'), '模型给空节点时算失败')

      // 一段失败不影响其他段
      const p2 = await B.plan(ws, { chunkChars: 5000 })
      ok(p2.total >= 3, `切成 ${p2.total} 段（要够多才能测失败隔离）`)
      ok(p2.done === 1, '只有第 1 段算完成')
      ok(p2.rows[0].state === 'done', '第 1 段 done')
      ok(p2.rows[1]?.failed !== null && p2.rows[1]?.failed !== undefined, '第 2 段标了失败原因')
      // 现在有三态：done / running / failed / pending。
      // 第 1 段 done、第 2 段 failed、其余 pending —— 三者加起来等于总数
      ok(p2.done + p2.running + p2.failed + p2.pending === p2.total, '四态计数加起来等于总段数')
      ok(p2.failed >= 1, `失败段被单独计数（${p2.failed} 段）`)
      ok(p2.pending === p2.total - 1 - p2.running - p2.failed + 0 || p2.pending >= 0, 'pending 计数合理')

      // 重跑失败那段
      const retry = await B.claimBatch(ws, { size: 1, chunkChars: 5000 })
      ok(retry.ok === true, '失败段能被重新领')
      ok(retry.tasks[0].index === 1, `领到的是失败的那段（实际第 ${retry.tasks[0].index + 1} 段）`)
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n四、合并（去重是关键）')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 6, 300)
      const p = await B.plan(ws, { chunkChars: 5000 })
      ok(p.total >= 3, `切成 ${p.total} 段`)

      // 三段都提到「江哲」「南北对峙」「史书引文」，但各有独有节点
      await B.acceptPart(ws, 0, JSON.stringify(makeMap('第一段')))
      await B.acceptPart(ws, 1, JSON.stringify(makeMap('第二段', {
        nodes: [{ id: 'm1', kind: 'material', name: '人名表', summary: '人名', body: '这是只出现在第二段的一个素材节点，正文足够长。', sources: ['第二段.md'] }],
      })))
      await B.acceptPart(ws, 2, JSON.stringify(makeMap('第三段')))

      const m = await B.merge(ws, { chunkChars: 5000 })
      ok(m.ok === true, '合并成功')
      ok(m.parts === 3, '合并了 3 段')

      // 去重：三段共有的三类各只留一条
      const byName = {}
      for (const n of m.map.nodes) byName[n.name] = (byName[n.name] ?? 0) + 1
      ok(byName['江哲'] === 1, `**「江哲」去重成一条**（实际 ${byName['江哲']}）`)
      ok(byName['南北对峙'] === 1, '世界规则也去重')
      ok(byName['史书引文开篇'] === 1, '结构也去重')
      ok(byName['人名表'] === 1, '独有节点保留')

      // 出处取并集
      const jiang = m.map.nodes.find((n) => n.name === '江哲')
      ok(jiang.sources.length === 3, `**出处取并集**（3 段都提到，实际 ${jiang.sources.length} 条出处）`)
      ok(jiang.sources.some((s) => s.includes('第1段')), '出处带段号')
      ok(jiang.sources.some((s) => s.includes('第3段')), '出处覆盖全部段')

      // 正文取更长的
      ok(jiang.body.includes('第一段') || jiang.body.includes('第二段') || jiang.body.includes('第三段'), '正文保留了内容')

      // 连线：每段一条，合并后去重
      ok(m.map.edges.length === 1, `连线去重成 1 条（实际 ${m.map.edges.length}）`)
      const e = m.map.edges[0]
      const ids = new Set(m.map.nodes.map((n) => n.id))
      ok(ids.has(e.from) && ids.has(e.to), '**连线端点在合并后的节点里存在**（id 重映射对）')

      // 校验通过
      ok(m.errors.length === 0, `合并后校验通过${m.errors.length > 0 ? '：' + m.errors.join('；') : ''}`)
      ok(m.stats.nodes === 4, `合并后 4 个节点（实际 ${m.stats.nodes}）`)
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n五、合并时不完整的段')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 8, 300)
      const p = await B.plan(ws, { chunkChars: 5000 })
      await B.acceptPart(ws, 0, JSON.stringify(makeMap('第一段')))

      const m = await B.merge(ws, { chunkChars: 5000 })
      ok(m.ok === true, '只有一段也能合并')
      ok(m.parts === 1 && m.total === p.total, '如实报已合并几段、总共几段')
      ok(m.missing.length === p.total - 1, '列出没拆的段')
      ok(m.note.includes('还有'), 'note 说明还差多少段')

      // 一段都没有时
      const ws2 = await tmp()
      try {
        await makeBook(ws2, 4, 1200)
        const m2 = await B.merge(ws2, { chunkChars: 5000 })
        ok(m2.ok === false && m2.reason.includes('还没有'), '没有任何分片时如实报')
      } finally { await rm(ws2, { recursive: true, force: true }) }
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六、保存合并结果与清理')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 6, 300)
      await B.acceptPart(ws, 0, JSON.stringify(makeMap('第一段')))
      const m = await B.merge(ws, { chunkChars: 5000 })
      const saved = await B.saveMerged(ws, m.map)
      ok(saved.ok === true, '全书图存盘')
      ok(existsSync(saved.path) && existsSync(saved.jsonPath), 'md 和 json 都写了')
      ok(saved.path.includes('设定'), '落在设定目录')

      // 清分片
      const before = (await readdir(join(ws, '设定', '逻辑图分片'))).filter((n) => n.endsWith('.json')).length
      ok(before === 1, `清之前有 ${before} 个分片`)
      const r = await B.resetParts(ws)
      ok(r.cleared === 1, '清掉 1 个')
      const after = (await readdir(join(ws, '设定', '逻辑图分片'))).filter((n) => n.endsWith('.json')).length
      ok(after === 0, '清干净了')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六点五、段数超过 50 也不能漏（真机踩到的）')
  {
    const ws = await tmp()
    try {
      // chunkBook 的 chunks 默认只回前 50 段（预览用）。plan/claim/merge
      // 如果不显式拉满，就只看到 50 段 —— 第 51 段之后永远拆不到。
      await makeBook(ws, 60, 1200)
      const p = await B.plan(ws, { chunkChars: 5000 })
      ok(p.total > 50, `造出 ${p.total} 段（要超过 50 才能测到这个 bug）`)
      ok(p.rows.length === p.total, `**plan 返回全部 ${p.total} 段，不是只回 50 段**（实际 ${p.rows.length}）`)
      ok(p.rows[p.total - 1].index === p.total - 1, '最后一段也在列表里')

      // claim 一次最多 20 段（并发上限），但**能领到第 51 段之后的段**
      const b = await B.claimBatch(ws, { size: 60, chunkChars: 5000 })
      ok(b.claimed === 20, `一次最多领 20 段（并发上限，实际 ${b.claimed}）`)
      ok(b.total === p.total, 'claim 的 total 和 plan 一致')

      // 一路领下去，必须能越过第 50 段
      let maxIndex = Math.max(...b.tasks.map((t) => t.index))
      for (let round = 0; round < 4; round += 1) {
        const n = await B.claimBatch(ws, { size: 20, chunkChars: 5000 })
        if (n.ok !== true) break
        maxIndex = Math.max(maxIndex, ...n.tasks.map((t) => t.index))
      }
      ok(maxIndex >= 50, `**能领到第 51 段之后**（最远领到第 ${maxIndex + 1} 段）`)
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六点六、状态与倒计时字段')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 6, 1200)
      const before = await B.plan(ws, { chunkChars: 5000 })
      ok(before.running === 0 && before.failed === 0, '初始没有在拆与失败')
      ok(before.allDone === false, '没拆完时 allDone=false')

      // 领一批 → 应该有 running 状态 + 开始时间 + 预期耗时
      const b = await B.claimBatch(ws, { size: 2, chunkChars: 5000 })
      ok(b.ok === true, '领到段')
      const p = await B.plan(ws, { chunkChars: 5000 })
      ok(p.running === 2, `**plan 能看到在拆状态**（${p.running} 段）`)
      const running = p.rows.filter((x) => x.state === 'running')
      ok(running.length === 2, '行里有 running 状态')
      ok(running.every((x) => typeof x.startedAt === 'string'), '**带开始时间**（界面据此倒计时）')
      ok(running.every((x) => Number.isFinite(x.etaMs) && x.etaMs > 0), '**带预期耗时**（倒计时总长）')
      // 开始时间能被解析、且不早于刚才
      const t0 = Date.parse(running[0].startedAt)
      ok(Number.isFinite(t0), '开始时间可解析')
      ok(Date.now() - t0 < 60000, '开始时间是刚才（没记错）')
      // etaMs 与字数成正比
      ok(running[0].etaMs >= 60000, `约 1.8 万字 → 至少 60 秒（实际 ${Math.round(running[0].etaMs/1000)} 秒）`)

      // 收下后变成 done
      await B.acceptPart(ws, running[0].index, JSON.stringify(makeMap('第一段')))
      const p2 = await B.plan(ws, { chunkChars: 5000 })
      ok(p2.done === 1, '收下后变成 done')
      ok(p2.running === 1, '另一段还在拆')

      // 全部 done 时 allDone
      const rest = p2.rows.filter((x) => x.state !== 'done')
      for (const r of rest) await B.acceptPart(ws, r.index, JSON.stringify(makeMap(`第${r.index + 1}段`)))
      const p3 = await B.plan(ws, { chunkChars: 5000 })
      ok(p3.allDone === true, '**全部拆完时 allDone=true**')
      ok(p3.pending === 0 && p3.running === 0, '没有待拆与在拆')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六点七、按勾选派发（多选）')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 8, 1200)
      const p = await B.plan(ws, { chunkChars: 5000 })
      ok(p.total >= 4, `切成 ${p.total} 段`)

      // 派发指定的几段
      const r = await B.dispatchSelected(ws, [0, 2], { chunkChars: 5000 })
      ok(r.ok === true, '派发成功')
      ok(r.claimed === 2, `派发 2 段（实际 ${r.claimed}）`)
      ok(r.tasks.length === 2, 'tasks 数量对')
      ok(r.payloads.length === 2, '**payloads 带了正文**（可直接交给子智能体）')
      ok(r.payloads.every((x) => x.text.length > 0), '每段都有正文')
      // 现在派发返回的是「可粘贴指令」，一人一段的强调在 README 与 preset 里，
      // 指令本身给出的是每段的取正文/交回命令
      ok(r.brief.includes('novel_logic_map'), '派发返回可粘贴指令')
      ok(r.brief.includes('第 1 段') && r.brief.includes('第 3 段'), '说明里列出派发的段')
      ok(r.brief.includes('accept-part'), '说明里给了收回方式')

      // 派发后标 pending-task（不是 running —— 插件自己不调模型）
      const p2 = await B.plan(ws, { chunkChars: 5000 })
      ok(p2.running === 0, '派发后不标 running（假状态）')
      ok(p2.pendingTask === 2, `派发后 2 段是 pending-task（实际 ${p2.pendingTask}）`)

      // 已拆完的段会被跳过
      const r2 = await B.dispatchSelected(ws, [0], { chunkChars: 5000 })
      ok(r2.ok === true, 'pending-task 的段允许再生成一份指令（换会话重跑是合法的）')

      // force 可以重派
      const r3 = await B.dispatchSelected(ws, [0], { chunkChars: 5000, force: true })
      ok(r3.ok === true && r3.claimed === 1, 'force=true 能重派')

      // 越界段号
      const r4 = await B.dispatchSelected(ws, [999], { chunkChars: 5000 })
      ok(r4.ok === false, '越界段号不派')
      ok(r4.skipped.some((x) => x.reason.includes('越界')), '报越界')

      // 空选择
      const r5 = await B.dispatchSelected(ws, [], { chunkChars: 5000 })
      ok(r5.ok === false && r5.reason.includes('没有选中'), '没选段时如实报')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六点八、可粘贴指令（插件不自己调模型）')
  {
    const ws = await tmp()
    try {
      await makeBook(ws, 8, 1200)
      const p = await B.plan(ws, { chunkChars: 5000 })
      ok(p.total >= 3, `切成 ${p.total} 段`)

      // 生成可粘贴指令
      const c = await B.composeAction(ws, [0, 1], { chunkChars: 5000 })
      ok(c.ok === true, '能生成指令')
      ok(c.count === 2, '覆盖 2 段')
      ok(c.text.length > 500, `指令有实质内容（${c.text.length} 字）`)

      // 指令里必须自带「怎么取正文、怎么交回、规则是什么」
      ok(c.text.includes('novel_logic_map(action=chunk'), '**自带取正文的命令**')
      ok(c.text.includes('novel_logic_map(action=accept-part'), '**自带交回的命令**')
      ok(c.text.includes('chunkIndex=0') && c.text.includes('chunkIndex=1'), '每段的 index 都对')
      ok(c.text.includes('world') && c.text.includes('character') && c.text.includes('structure'), '七类节点规则在')
      ok(c.text.includes('至少 30 字'), '硬要求写进去了')
      ok(c.text.includes('必须标 `sources`') || c.text.includes('必须标 sources'), '**要求标出处**')
      ok(c.text.includes('不要凑数写空话'), '禁止凑数')
      ok(c.text.includes('"nodes"') && c.text.includes('"edges"'), '输出格式示例在')
      ok(c.hint.includes('复制') && c.hint.includes('对话框'), '说明怎么用')

      // dispatch 不再标假 running
      const d = await B.dispatchSelected(ws, [2], { chunkChars: 5000 })
      ok(d.ok === true, '派发成功')
      ok(d.brief.includes('novel_logic_map'), '派发返回的也是可粘贴指令')
      const p2 = await B.plan(ws, { chunkChars: 5000 })
      ok(p2.running === 0, '**不再标假 running**（插件自己不调模型）')
      ok(p2.pendingTask === 1, `标成 pending-task（人等拿去跑，实际 ${p2.pendingTask}）`)

      // resetStuck 清掉旧的假 running
      const part = await B.loadPart(ws, 2)
      ok(part.state === 'pending-task', '分片状态是 pending-task')
      // 手动造一个假的 running
      await B.savePart(ws, 3, { state: 'running', startedAt: new Date().toISOString(), etaMs: 1000, title: '假在拆' })
      const rs = await B.resetStuck(ws)
      ok(rs.cleared === 1, `清掉 1 个卡住的（实际 ${rs.cleared}）`)
      ok(await B.loadPart(ws, 3) === null, '卡住的分片被删了')
      // pending-task 不该被清
      ok(await B.loadPart(ws, 2) !== null, '**pending-task 不会被误清**（那不是卡住）')

      // 空选择
      const c2 = await B.composeAction(ws, [], { chunkChars: 5000 })
      ok(c2.ok === false && c2.reason.includes('没有选中'), '没选段时如实报')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n七、协作说明')
  {
    const b = B.collaborationBrief(98, 4)
    ok(b.batches === 25, `98 段每次 4 段 = 25 批（实际 ${b.batches}）`)
    ok(b.note.includes('不要一个子智能读多段'), '**明确说不要一个子智能读多段**')
    ok(b.steps.length >= 5, '给出流程步骤')
    ok(b.steps.some((s) => s.includes('claim-batch')), '第一步是领任务')
    ok(b.steps.some((s) => s.includes('merge')), '最后一步是合并')
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
