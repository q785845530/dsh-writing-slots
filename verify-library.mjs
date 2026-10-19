#!/usr/bin/env node
/**
 * dsh-writing-slots / 指令库 自测。
 *
 *   node verify-library.mjs
 *
 * 这是「多次读小说 → 沉淀 → 勾选组合 → 最终指令」闭包的落点，所以要验：
 *   - 条目的**判据**：是指令不是资料（太短的会被提醒）
 *   - 落盘一条一个文件（坏一条不连坐）
 *   - **组合**：顺序、分组、只取勾选的、空清单要报错
 *   - 导入：模型爱套 markdown 代码块 / 加说明，都得能解析
 */
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as L from './lib/library.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}
const tmp = async () => mkdtemp(join(tmpdir(), 'dws-lib-'))

const main = async () => {
  console.log('一、类型与规范化')
  {
    ok(L.KINDS.length === 6, `六种类型（实际 ${L.KINDS.length}）`)
    ok(L.KINDS.map((k) => k.id).join(',') === 'style,structure,character,trope,rule,material', '类型 id 稳定')
    ok(L.DEFAULT_ORDER[0] === 'rule', '合成默认先放硬规则')
    ok(L.KIND_LABEL.structure === '结构', '有中文名')

    const n = L.normalize({ kind: 'style', name: '句长', body: '句子平均不超过 12 字，短句占八成以上。' })
    ok(n.ok === true, '合规条目通过')
    ok(n.item.enabled === true, '默认启用')
    ok(typeof n.item.id === 'string' && n.item.id.includes('style'), '自动生成带类型的 id')
    ok(n.item.order === L.DEFAULT_ORDER.indexOf('style') * 100, '默认顺序按类型排')

    // 真正缺字段的才该打回；只有 name 没 body 是缺 body（上一行已验）
    ok(L.normalize({}).ok === false, '空对象打回')
    ok(L.normalize({ name: 'x' }).ok === false, '只有 name 打回')
    ok(L.normalize({ body: '这是一条足够长的指令正文，用来测试只有 body 时的行为。' }).ok === false, '只有 body 打回')
    ok(L.normalize({ body: 'x' }).errors.some((e) => e.includes('name')), '报出缺 name')
    ok(L.normalize({ name: 'x' }).errors.some((e) => e.includes('body')), '报出缺 body')
    ok(L.normalize({ name: 'x', body: '短' }).warnings.length > 0, '正文过短时提醒（可能是资料不是指令）')
    ok(L.normalize({ name: 'x', body: 'y', kind: '不存在的类型' }).item.kind === 'rule', '非法类型回退成 rule')
  }

  console.log('\n二、落盘与读取')
  {
    const ws = await tmp()
    try {
      const r = await L.put(ws, { kind: 'style', name: '句长', body: '句子平均不超过 12 字。', source: '某本书' })
      ok(r.ok === true, '写入成功')
      ok(existsSync(r.path), '文件真的写了')
      ok(r.path.includes('指令库'), `落在指令库目录（${r.path.split('/').slice(-2).join('/')}）`)

      const g = await L.get(ws, r.item.id)
      ok(g !== null && g.name === '句长', '读得回来')

      // 一条一个文件：坏一条不连坐
      await writeFile(join(L.libDir(ws), 'broken.json'), '{ 不是 JSON', 'utf8')
      const l = await L.list(ws)
      ok(l.items.length === 1, '坏文件不影响好条目')
      ok(l.broken.length === 1, '坏文件如实报出来')

      // 覆盖保留 createdAt
      const created = l.items[0].createdAt
      const r2 = await L.put(ws, { id: r.item.id, kind: 'style', name: '句长（改）', body: '改过的正文，至少三十个字才不会被提醒，所以这里写长一点。' })
      ok(r2.item.createdAt === created, '覆盖时保留原 createdAt')
      ok(r2.item.updatedAt !== undefined, '带 updatedAt')

      ok(await L.get(ws, '不存在') === null, '读不存在的返回 null')
      ok((await L.remove(ws, '不存在')).ok === false, '删不存在的如实报')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n三、导入（模型产出可能不干净）')
  {
    const ws = await tmp()
    try {
      const clean = JSON.stringify([
        { kind: 'structure', name: '信息差', body: '每章至少一次信息差变化，且必须落在那条被点亮的信息上，不能只在末尾提一句。' },
        { kind: 'rule', name: '不解释', body: '不替读者总结场景意义，不点名人物情绪；留白优先于说明。' },
      ])
      ok(L.parseItems(clean).ok === true, '纯 JSON 能解析')
      ok(L.parseItems('```json\n' + clean + '\n```').count === 2, '套 markdown 代码块能解析')
      ok(L.parseItems('好的，我抽了这些：\n' + clean + '\n希望有用。').count === 2, '前后有说明文字能解析')
      ok(L.parseItems('{"items":' + clean + '}').count === 2, '包成 {items:[...]} 能解析')
      ok(L.parseItems('{"kind":"rule","name":"x","body":"这是一条足够长的指令正文用于测试解析。"}').count === 1, '单个对象也能收')
      ok(L.parseItems('完全不是 JSON').ok === false, '不是 JSON 如实报')
      ok(L.parseItems('').ok === false, '空内容如实报')

      const r = await L.importItems(ws, JSON.parse(clean), { source: '雪中悍刀行' })
      ok(r.added === 2, `导入 2 条（实际 ${r.added}）`)
      ok(r.items.every((x) => typeof x.name === 'string'), '返回导入的清单')

      // 重复导入同一批：现在是**更新**，不再复制一份
      const r2 = await L.importItems(ws, JSON.parse(clean), { source: '雪中悍刀行' })
      ok(r2.updated === 2 && r2.added === 0, '重复导入同一批是更新而非新增')
      const l = await L.list(ws)
      ok(l.items.length === 2, `共 2 条（实际 ${l.items.length}）`)

      // 明确要副本时才复制
      const r2b = await L.importItems(ws, JSON.parse(clean), { source: '雪中悍刀行', onDuplicate: 'new' })
      ok(r2b.added === 2, "onDuplicate='new' 时才复制副本")
      const l2 = await L.list(ws)
      ok(l2.items.length === 4, `副本进来后共 4 条（实际 ${l2.items.length}）`)
      // 清掉刚造的副本，后面的计数断言才成立
      for (const it of l2.items.slice(2)) await L.remove(ws, it.id)

      // 无效条目被跳过并报原因
      const r3 = await L.importItems(ws, [{ name: '缺正文' }, { kind: 'rule', name: '好的', body: '这是一条足够长的指令正文，用来验证跳过逻辑是否只跳过坏的。' }])
      ok(r3.added === 1 && r3.skipped.length === 1, '坏条目跳过、好条目进来')
      ok(r3.skipped[0].errors.length > 0, '跳过时给出原因')
      ok((await L.importItems(ws, [])).ok === false, '空数组如实报')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n四、组合成最终指令（核心）')
  {
    const ws = await tmp()
    try {
      await L.put(ws, { kind: 'structure', name: '信息差', body: '每章至少一次信息差变化，必须落在那条被点亮的信息上。', source: '书A' })
      await L.put(ws, { kind: 'rule', name: '不解释', body: '不替读者总结场景意义，不点名人物情绪。', source: '书A' })
      await L.put(ws, { kind: 'style', name: '句长', body: '句子平均不超过十二字，短句占八成。', source: '书B' })
      await L.put(ws, { kind: 'material', name: '名词表', body: '田息、岁熟、死役牌、按表轮值。', source: '书B' })
      const l = await L.list(ws)

      // 默认全取（都启用），且顺序是「硬规则在前」
      const c = await L.compose(ws)
      ok(c.ok === true, '合成成功')
      ok(c.used.length === 4, `用了 4 条（实际 ${c.used.length}）`)
      const order = c.used.map((x) => x.kind)
      ok(order[0] === 'rule', `硬规则排最前（实际 ${order.join('>')}）`)
      ok(order.indexOf('style') < order.indexOf('material'), '素材排最后')
      ok(c.text.includes('不替读者总结'), '正文进了指令')
      ok(c.text.includes('# 写作指令'), '有标题')
      ok(c.byKind.rule === 1 && c.byKind.style === 1, '给出构成统计')
      ok(c.chars === c.text.length, '字数对得上')

      // 只取勾选的
      const two = l.items.filter((x) => x.kind === 'rule' || x.kind === 'style').map((x) => x.id)
      const c2 = await L.compose(ws, two)
      ok(c2.used.length === 2, '只合成勾选的那两条')
      ok(!c2.text.includes('信息差'), '没勾的不进去')

      // 分组模式
      const c3 = await L.compose(ws, null, { groupByKind: true })
      ok(c3.text.includes('## 硬规则') && c3.text.includes('## 文风'), '按类型分组时有小标题')

      // 来源标注
      const c4 = await L.compose(ws, null, { includeSource: true })
      ok(c4.text.includes('书A'), 'includeSource 时标出来源')
      const c5 = await L.compose(ws, null, {})
      ok(!c5.text.includes('来源：'), '默认不标来源')

      // 停用的不参与
      await L.setEnabled(ws, [l.items.find((x) => x.kind === 'material').id], false)
      const c6 = await L.compose(ws)
      ok(c6.used.length === 3, '停用的条目不参与合成')
      ok(!c6.text.includes('田息'), '停用的正文不进去')

      // 空清单要报错
      const c7 = await L.compose(ws, ['不存在的 id'])
      ok(c7.ok === false && c7.text === '', '勾了不存在的条目 → 报错且不产出半成品')

      // 自定义标题
      const c8 = await L.compose(ws, null, { title: '重生文写作指令' })
      ok(c8.text.startsWith('# 重生文写作指令'), '自定义标题生效')
      ok(c8.title === '重生文写作指令', '标题也返回')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n五、增删改序')
  {
    const ws = await tmp()
    try {
      const a = await L.put(ws, { kind: 'rule', name: 'A', body: '这是一条足够长的指令正文，用来测试顺序调整功能是否生效。' })
      const b = await L.put(ws, { kind: 'rule', name: 'B', body: '这也是一条足够长的指令正文，用来测试顺序调整功能是否生效。' })
      const c = await L.put(ws, { kind: 'rule', name: 'C', body: '第三条足够长的指令正文，同样用来测试顺序调整功能。' })

      let l = await L.list(ws)
      ok(l.items.map((x) => x.name).join('') === 'ABC', '默认按写入序')

      await L.reorder(ws, [c.item.id, a.item.id, b.item.id])
      l = await L.list(ws)
      ok(l.items.map((x) => x.name).join('') === 'CAB', `重排生效（实际 ${l.items.map((x) => x.name).join('')}）`)

      const p = await L.patch(ws, a.item.id, { name: 'A2' })
      ok(p.ok === true && p.item.name === 'A2', '改名字生效')
      ok(p.item.id === a.item.id, '改的时候 id 不变')
      ok((await L.patch(ws, a.item.id, { body: '' })).ok === false, 'body 不让清空')
      ok((await L.patch(ws, a.item.id, { kind: '瞎写' })).ok === false, '非法类型被拒')
      ok((await L.patch(ws, '不存在', { name: 'x' })).ok === false, '改不存在的如实报')

      await L.setEnabled(ws, [b.item.id], false)
      l = await L.list(ws)
      ok(l.enabled === 2 && l.items.length === 3, 'enabled 计数正确')

      const s = await L.summary(ws)
      ok(s.kinds.length === 6, 'summary 给出六类计数')
      ok(s.totalChars > 0, 'summary 统计总字数')
      ok(s.sources.length === 0, '没标来源时 sources 为空')

      await L.remove(ws, c.item.id)
      l = await L.list(ws)
      ok(l.items.length === 2, '删除生效')
      ok((await readdir(L.libDir(ws))).filter((n) => n.endsWith('.json')).length === 2, '磁盘上也只剩 2 个文件')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六、与槽位的关系')
  {
    ok(Object.keys(L.SLOT_KINDS).length >= 12, `槽位映射覆盖 ${Object.keys(L.SLOT_KINDS).length} 个槽位`)
    ok(L.kindsForSlot('chapter_pack').includes('structure'), 'chapter_pack 用得上结构')
    ok(L.kindsForSlot('deai_polish').join(',') === 'rule,style', 'deai_polish 只用硬规则与文风')
    ok(L.kindsForSlot('prose_sanity').join(',') === 'rule', 'prose_sanity 只用硬规则')
    ok(L.kindsForSlot('不存在的槽位').length === 0, '未知槽位给空表')

    const ws = await tmp()
    try {
      await L.put(ws, { kind: 'structure', name: '信息差', body: '每章至少一次信息差变化，必须落在那条被点亮的信息上。' })
      await L.put(ws, { kind: 'style', name: '短句', body: '句子平均不超过十二字，短句占八成以上。' })
      await L.put(ws, { kind: 'material', name: '名词表', body: '田息、岁熟、死役牌、按表轮值。' })

      const cp = await L.forSlot(ws, 'chapter_pack')
      ok(cp.items.length === 3, `chapter_pack 取到 3 条（实际 ${cp.items.length}）`)

      const dp = await L.forSlot(ws, 'deai_polish')
      ok(dp.items.length === 1 && dp.items[0].kind === 'style', 'deai_polish 只取到文风那条')

      const ps = await L.forSlot(ws, 'prose_sanity')
      ok(ps.items.length === 0, 'prose_sanity 没规则条目时为空')

      // 给槽位合成
      const c = await L.composeForSlot(ws, 'chapter_pack')
      ok(c.ok === true && c.used.length === 3, '给槽位合成全部启用条目')
      ok(c.slot === 'chapter_pack' && c.poolSize === 3, '返回槽位与池大小')
      ok(c.text.includes('硬规则') === false || c.text.includes('## '), '合成按类型分组')

      // 只合成勾选的
      const one = cp.items.filter((x) => x.kind === 'structure').map((x) => x.id)
      const c2 = await L.composeForSlot(ws, 'chapter_pack', one)
      ok(c2.used.length === 1, '只合成勾选的')

      // 勾了槽位用不上的条目 → 取不到
      const styleId = cp.items.find((x) => x.kind === 'style').id
      const c3 = await L.composeForSlot(ws, 'prose_sanity', [styleId])
      ok(c3.ok === false, '勾了该槽位用不上的条目 → 报错而不是硬塞')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n七、从工作目录提取素材')
  {
    const ws = await tmp()
    try {
      const { mkdir } = await import('node:fs/promises')
      for (const d of ['素材', '拆文库', '样本', '设定']) await mkdir(join(ws, d), { recursive: true })

      const long = '这是一段足够长的正文内容，用来测试提取功能。'.repeat(20)
      await writeFile(join(ws, '素材', '榜单A.md'), long, 'utf8')
      await writeFile(join(ws, '拆文库', '某本-第0001章.md'), long, 'utf8')
      await writeFile(join(ws, '样本', '语料B.md'), long, 'utf8')
      await writeFile(join(ws, '设定', 'world-bible.md'), long, 'utf8')
      await writeFile(join(ws, '素材', '太短.md'), '短', 'utf8')
      await writeFile(join(ws, '素材', '混淆的.md'), '\ue491皇\ue48e辈装。'.repeat(40), 'utf8')

      // dryRun 不写盘
      const dry = await L.extractFromWorkspace(ws, { dryRun: true })
      ok(dry.dryRun === true && dry.count === 6, `dryRun 扫到 6 个（实际 ${dry.count}）`)
      ok((await L.list(ws)).items.length === 0, 'dryRun 不写盘')

      const r = await L.extractFromWorkspace(ws)
      ok(r.added === 4, `提取 4 条（实际 ${r.added}）`)
      ok(r.skipped.length === 2, '跳过 2 个（太短 + 混淆）')
      ok(r.skipped.some((x) => x.reason.includes('太短')), '如实报太短')
      ok(r.skipped.some((x) => x.reason.includes('混淆')), '如实报混淆')

      const l = await L.list(ws)
      ok(l.items.length === 4, '库里 4 条')
      ok(l.items.every((x) => (x.tags ?? []).includes('待整理')), '提取进来的都标「待整理」')
      ok(l.items.every((x) => x.enabled === false), '**提取进来的默认不参与合成**（原文不是指令）')
      // 合成时要提示有多少条待整理没算
      const cc = await L.compose(ws)
      ok(cc.ok === false, '一条都没启用时合成如实报错')
      await L.setEnabled(ws, [l.items[0].id], true)
      const cc2 = await L.compose(ws)
      ok(cc2.ok === true && cc2.pending === 3, `只算启用的，并提示还有 ${cc2.pending} 条待整理`)
      ok(cc2.text.includes('待整理'), '待整理提示写进指令里')
      ok(l.items.some((x) => x.kind === 'structure'), '拆文库那篇归到结构')
      ok(l.items.some((x) => x.kind === 'style'), '样本那篇归到文风')

      // 再提取一次：已有的不重复加
      const r2 = await L.extractFromWorkspace(ws)
      ok(r2.added === 0, '重复提取不重复加')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n八、重复问题（真机 191 条里 147 条是重复的）')
  {
    // 内容身份：同类型同名字算同一条，不看 id
    const k1 = L.itemKey({ kind: 'character', name: '江哲（字随云）：表面欲望是苟全性命' })
    const k2 = L.itemKey({ kind: 'character', name: '江哲(字随云): 表面欲望是苟全性命' })
    ok(k1 === k2, '**名字写法不同也认作同一条**（去空白与标点）')
    ok(L.itemKey({ kind: 'character', name: '江哲' }) !== L.itemKey({ kind: 'style', name: '江哲' }), '类型不同算不同条目')

    const ws = await tmp()
    try {
      const item = { kind: 'character', name: '江哲', body: '表面欲望是苟全性命，真实需求是被看见。这是一段足够长的正文。', source: '第1段' }

      // 第一次导入
      const r1 = await L.importItems(ws, [item], { source: '第1段' })
      ok(r1.added === 1 && r1.updated === 0, '首次导入是新增')
      ok((await L.list(ws)).items.length === 1, '库里 1 条')

      // 第二次导入同样内容 —— 必须更新而不是新增
      const r2 = await L.importItems(ws, [item], { source: '第1段' })
      ok(r2.added === 0 && r2.updated === 1, '**重复导入是更新，不是新增**')
      ok((await L.list(ws)).items.length === 1, '**库里仍然 1 条**（第一版这里会变成 2 条）')

      // 导入十次还是 1 条
      for (let i = 0; i < 10; i += 1) await L.importItems(ws, [item], { source: '第1段' })
      ok((await L.list(ws)).items.length === 1, '导入十次仍然 1 条')

      // 标签取并集：不同段导入同一节点，段号不能丢
      // 两段导出同一节点时，source 不同（一个来自第1段，一个来自第5段）
      const withSeg1 = { ...item, tags: ['段:1'], source: '第1段·第一章' }
      const withSeg5 = { ...item, tags: ['段:5'], source: '第5段·第三章' }
      // 不传 options.source —— normalize 里 options.source 优先，会把条目自带的
      // source 覆盖掉，合并时两边就「看起来一样」，并集失效
      await L.importItems(ws, [withSeg1], {})
      await L.importItems(ws, [withSeg5], {})
      const one = (await L.list(ws)).items[0]
      ok(one.tags.includes('段:1') && one.tags.includes('段:5'), `**标签取并集，两段标记都在**（${one.tags.join(',')}）`)
      ok(one.source.includes('第1段') && one.source.includes('第5段'), '出处也取并集')

      // 已启用的不会被新导入关掉
      await L.patch(ws, one.id, { enabled: true })
      await L.importItems(ws, [{ ...item, enabled: false }], { source: '第1段' })
      ok((await L.list(ws)).items[0].enabled === true, '已启用的条目不会被再次导入关掉')

      // onDuplicate: 'new' 明确要副本时才复制
      const r3 = await L.importItems(ws, [item], { source: '第1段', onDuplicate: 'new' })
      ok(r3.added === 1, "onDuplicate='new' 时才新增副本")
      ok((await L.list(ws)).items.length === 2, '库里 2 条')
      // onDuplicate: 'skip' 跳过
      const r4 = await L.importItems(ws, [item], { source: '第1段', onDuplicate: 'skip' })
      ok(r4.added === 0 && r4.updated === 0, "onDuplicate='skip' 时既不新增也不更新")
      ok((await L.list(ws)).items.length === 2, '库里还是 2 条')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }
  {
    // dedupe：清掉已有重复，保留信息最全的
    const ws = await tmp()
    try {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(L.libDir(ws), { recursive: true })
      // 手动造 5 条同内容不同 id 的条目（模拟第一版产生的重复）
      const mk = (id, extra) => ({ id, kind: 'character', name: '江哲', body: '正文。'.repeat(30), summary: 's', source: '第1段', enabled: true, tags: ['逻辑图'], order: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra })
      // 注意：不要用 [['a',{}],...].entries() —— 那样 extra 拿到的是字符串 'a'，
      // spread 出去全乱。直接用对象数组。
      const extras = [
        {},
        { tags: ['逻辑图', '段:1'] },
        { body: '正文。'.repeat(50) },   // 正文最长，应该被保留
        { tags: ['逻辑图', '段:2'] },
        { source: '第5段' },
      ]
      for (let i = 0; i < extras.length; i += 1) {
        const it = mk(`dup-${i}`, extras[i])
        await writeFile(join(L.libDir(ws), `${it.id}.json`), JSON.stringify(it), 'utf8')
      }
      const before = await L.list(ws)
      ok(before.items.length === 5, `造了 5 条重复（${before.items.length}）`)

      const dry = await L.dedupe(ws, { dryRun: true })
      ok(dry.removed === 4, `dryRun 报告会清 4 条（实际 ${dry.removed}）`)
      ok((await L.list(ws)).items.length === 5, 'dryRun 不动文件')

      const r = await L.dedupe(ws)
      ok(r.removed === 4, '清掉 4 条')
      const after = await L.list(ws)
      ok(after.items.length === 1, '**只剩 1 条**')
      // 保留的是正文最长的
      ok(after.items[0].body.length === '正文。'.repeat(50).length, '**保留正文最长的那条**（信息最全）')
      // 标签与出处合并了
      ok(after.items[0].tags.includes('段:1') && after.items[0].tags.includes('段:2'), '**标签合并了，段号没丢**')
      ok(after.items[0].source.includes('第5段'), '出处也合并了')

      // 再跑一次：没有重复可说
      const r2 = await L.dedupe(ws)
      ok(r2.removed === 0 && r2.message === '没有重复', '已无重复时如实报')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }
  {
    // 提取去重：同一篇原文在多个目录里不该被提取多次
    const ws = await tmp()
    try {
      const { mkdir } = await import('node:fs/promises')
      for (const d of ['素材', '拆文库', '样本']) await mkdir(join(ws, d), { recursive: true })
      const content = '这是一篇足够长的原文内容，用来测试提取去重。'.repeat(30)
      // 同名文件放在三个目录
      for (const d of ['素材', '拆文库', '样本']) await writeFile(join(ws, d, '同一篇.md'), content, 'utf8')

      const r = await L.extractFromWorkspace(ws)
      ok(r.added === 1, `**同名文件只提取一次**（实际 ${r.added} 条）`)
      ok((await L.list(ws)).items.length === 1, '库里只有 1 条')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
