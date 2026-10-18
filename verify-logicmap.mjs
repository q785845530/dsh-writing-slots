#!/usr/bin/env node
/**
 * dsh-writing-slots / 小说逻辑图 自测。
 *
 *   node verify-logicmap.mjs
 *
 * 这条链：提取素材 → 子智能拆解 → 逻辑图 → 存进指令库。
 * 重点验：
 *   - 图必须**能追到出处**（追不到就是模型编的）
 *   - 至少覆盖 world/character/structure
 *   - 连线两端必须存在
 *   - 图 → 条目时类型映射对不对（world→world_builder 那套）
 *   - 解析模型产出要宽容（套代码块、加说明）
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as L from './lib/logicmap.js'
import * as lib from './lib/library.js'
import { runDecompose, acceptMap, mapToLibrary, readMap } from './lib/pipeline.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}
const tmp = async () => mkdtemp(join(tmpdir(), 'dws-lm-'))

const goodMap = () => ({
  title: '测试书的逻辑图',
  sources: ['某本-第0001章.md', '某本-第0002章.md'],
  nodes: [
    { id: 'w1', kind: 'world', name: '田息', summary: '修炼资源', body: '修炼要消耗田息，每引一次折三日寿。上限三段，过段必反噬。', sources: ['某本-第0001章.md'] },
    { id: 'c1', kind: 'character', name: '吴常', summary: '主角', body: '表面欲望是守住三亩田；真实需求是有人告诉他活着就够；致命缺陷是认死理不求人。', sources: ['某本-第0001章.md'] },
    { id: 's1', kind: 'structure', name: '章尾必变信息差', summary: '钩子依据', body: '每章结尾改变读者知情状态：回收一条旧悬念，或埋一条新的，两者必居其一。', sources: ['某本-第0002章.md'] },
    { id: 'y1', kind: 'style', name: '短句', summary: '句长', body: '句子平均不超过十二字，短句占八成以上。少用连接词，一句一个意思。', sources: ['某本-第0002章.md'] },
  ],
  edges: [
    { from: 'w1', to: 'c1', label: '田息决定他的处境' },
    { from: 'c1', to: 's1', label: '他的选择推动每章的信息差' },
  ],
})

const main = async () => {
  console.log('一、类型与槽位映射')
  {
    ok(L.NODE_KINDS.length === 7, `七类节点（实际 ${L.NODE_KINDS.length}）`)
    ok(L.NODE_SLOT.world === 'world_builder', 'world 喂给 world_builder')
    ok(L.NODE_SLOT.character === 'character_designer', 'character 喂给 character_designer')
    ok(L.NODE_SLOT.style === 'style_anchor', 'style 喂给 style_anchor')
    ok(L.NODE_SLOT.rule === 'review_pass', 'rule 喂给 review_pass')
    ok(L.NODE_LABEL.structure === '结构', '有中文名')
  }

  console.log('\n二、校验（出处是硬判据）')
  {
    const v = L.validate(goodMap())
    ok(v.ok === true, `合规图通过${v.ok ? '' : '：' + v.errors.join('；')}`)
    ok(v.stats.nodes === 4 && v.stats.edges === 2, '统计节点与连线')
    ok(v.stats.sourced === 4, '四个节点都有出处')

    // 没出处 → 提醒（不能确认是原文还是编的）
    const noSrc = goodMap()
    delete noSrc.nodes[0].sources
    const v2 = L.validate(noSrc)
    ok(v2.warnings.some((x) => x.includes('没标出处')), '没出处时提醒')

    // 缺三类之一 → 提醒
    const noWorld = goodMap()
    noWorld.nodes = noWorld.nodes.filter((n) => n.kind !== 'world')
    noWorld.edges = []
    ok(L.validate(noWorld).warnings.some((x) => x.includes('世界规则')), '缺世界规则时提醒')

    // 连线端点不存在 → 报错
    const badEdge = goodMap()
    badEdge.edges.push({ from: 'w1', to: '不存在' })
    const v3 = L.validate(badEdge)
    ok(v3.ok === false && v3.errors.some((x) => x.includes('不存在')), '连线终点不存在时报错')

    // 空内容
    ok(L.validate({ nodes: [] }).ok === false, '没有节点时报错')
    ok(L.validate({}).ok === false, '空图报错')
    const shortBody = goodMap()
    shortBody.nodes[0].body = '短'
    ok(L.validate(shortBody).ok === false, '节点内容太短时报错')
    const badKind = goodMap()
    badKind.nodes[0].kind = '瞎写'
    ok(L.validate(badKind).ok === false, '类型不认识时报错')
  }

  console.log('\n三、渲染')
  {
    const r = L.render(goodMap())
    ok(r.text.includes('# 测试书的逻辑图'), '有标题')
    ok(r.text.includes('## 世界规则'), '按类型分组')
    ok(r.text.includes('→ world_builder'), '标出对应槽位')
    ok(r.text.includes('> 出处：某本-第0001章.md'), '标出处')
    ok(r.text.includes('```mermaid'), '带结构图')
    ok(r.text.includes('graph TD'), 'mermaid 图类型')
    ok(r.text.includes('n_w1 -->'), '连线渲染')
    ok(r.mermaid === true, 'mermaid 标记')

    // 没有连线也能渲染
    const noEdge = goodMap(); noEdge.edges = []
    ok(L.render(noEdge).text.includes('graph TD'), '没有连线时仍出图')
    // 空图不崩
    ok(typeof L.render({ nodes: [] }).text === 'string', '空图渲染不崩')
    // 名字里有引号/换行也不能把 mermaid 搞坏
    const weird = goodMap()
    weird.nodes[0].name = '带"引号"和\n换行'
    const w = L.render(weird).text
    ok(!w.includes('带"引号"和\n换行["'), '特殊字符被清掉')
  }

  console.log('\n四、解析模型产出（要宽容）')
  {
    const clean = JSON.stringify(goodMap())
    ok(L.parseMap(clean).ok === true, '纯 JSON 能解析')
    ok(L.parseMap('```json\n' + clean + '\n```').ok === true, '套代码块能解析')
    ok(L.parseMap('好的：\n' + clean + '\n完。').ok === true, '前后有说明能解析')
    ok(L.parseMap('{"map":' + clean + '}').ok === true, '包成 {map:{...}} 能解析')
    ok(L.parseMap('不是 JSON').ok === false, '不是 JSON 如实报')
    ok(L.parseMap('').ok === false, '空内容如实报')

    // 缺字段的节点要被补齐，不能崩
    const loose = L.parseMap(JSON.stringify({ nodes: [{ name: '只有名字', body: '这是一段足够长的正文内容用来测试补齐逻辑。' }] }))
    ok(loose.ok === true, '缺 id/kind 时也能收')
    ok(typeof loose.map.nodes[0].id === 'string', '补了 id')
    ok(loose.map.nodes[0].kind === 'material', '不认识的 kind 回退 material')
    ok(Array.isArray(loose.map.nodes[0].sources), '补了 sources 数组')
    // 坏连线被过滤
    const badEdge = L.parseMap(JSON.stringify({ nodes: [{ id: 'a', kind: 'rule', name: 'x', body: '足够长的正文内容用于测试连线过滤逻辑。' }], edges: [{ from: 'a' }, { from: 'a', to: 'b' }] }))
    ok(badEdge.map.edges.length === 1, '缺 to 的连线被丢掉')
  }

  console.log('\n五、落盘与图 → 条目')
  {
    const ws = await tmp()
    try {
      ok(await L.load(ws) === null, '还没有图时 load 返回 null')

      const saved = await L.save(ws, goodMap())
      ok(saved.ok === true, '存图成功')
      ok(existsSync(saved.path), 'markdown 写了')
      ok(saved.path.includes('设定'), `落在设定/（${saved.path.split('/').slice(-2).join('/')}）`)
      ok(existsSync(saved.jsonPath), '**JSON 备份也写了**（条目要从结构化数据来）')

      const back = await L.load(ws)
      ok(back !== null && back.text.includes('田息'), '读得回来')

      // 图 → 条目
      const items = L.toItems(goodMap())
      ok(items.length === 4, '四个节点拆成四条')
      ok(items.every((x) => x.enabled === true), '**图来的条目默认启用**（已是加工过的结论）')
      ok(items.every((x) => (x.tags ?? []).includes('逻辑图')), '标了「逻辑图」标签')
      // 图的类型体系和指令库不同，必须显式映射 ——
      // 不映射的话 world 会被当成非法类型静默回退成 rule（语义全歪）
      ok(L.NODE_TO_LIB_KIND.world === 'material', 'world 映射到 material')
      ok(items.find((x) => x.name === '田息').kind === 'material', '世界规则那条映射成 material')
      ok(items.find((x) => x.name === '吴常').kind === 'character', '人物那条保持 character')
      ok(items.find((x) => x.name === '田息').source.includes('第0001章'), '出处写进 source')
      ok(items.find((x) => x.kind === 'character').body.includes('致命缺陷'), '正文完整带过来')

      // 真存进指令库
      const r = await lib.importItems(ws, items, { source: '逻辑图' })
      ok(r.added === 4, '导入指令库成功')
      const l = await lib.list(ws)
      ok(l.items.length === 4, '库里 4 条')
      ok(l.items.filter((x) => x.name === '田息').length === 1, '世界规则那条也在（映射成 material）')
      ok(!l.items.some((x) => x.kind === 'world'), '指令库里不该出现 world 这种非法类型')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n六、整条链（拆解提示词 → 收图 → 存库）')
  {
    const ws = await tmp()
    try {
      // 1. 组装拆解提示词
      const d = await runDecompose(ws, {
        material: '他走进屋子，屋里很暗。'.repeat(50),
        materialList: ['某本-第0001章.md'],
      })
      ok(d.ok === true, '拆解提示词能组装')
      ok(d.prompt.includes('sources'), '提示词要求标出处')
      ok(d.prompt.includes('至少 30 字'), '提示词要求具体')
      ok(d.focus.includes('world'), '默认抽全部类型')
      ok((await runDecompose(ws, {})).ok === false, '没给素材时拒绝')

      // 2. 收图
      const a = await acceptMap(ws, JSON.stringify(goodMap()))
      ok(a.ok === true, `收图成功${a.ok ? '' : '：' + (a.validation?.errors ?? []).join('；')}`)
      ok(a.stats.nodes === 4, '收下 4 个节点')
      ok(a.next.includes('to-library'), '提示下一步是拆成条目')

      // 3. 读图
      const rd = await readMap(ws)
      ok(rd.ok === true && rd.text.includes('mermaid'), '读图带结构图')

      // 4. 图 → 指令库
      const tl = await mapToLibrary(ws)
      ok(tl.ok === true, `图拆成条目${tl.ok ? '' : '：' + (tl.reason ?? '')}`)
      ok(tl.added === 4, '四条进库')
      ok(tl.note.includes('默认启用'), '说明为什么默认启用')

      // 库里能查到
      const l = await lib.list(ws)
      ok(l.items.length === 4, '库里确实有 4 条')
      ok(l.enabled === 4, '四条都启用')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log('\n七、整本书：编码与分段')
  {
    const ws = await tmp()
    try {
      // —— 编码：GBK 的 txt 不能被读成乱码 ——
      const iconv = (await import('iconv-lite')).default
      const gbkText = '第一章 开端\r\n　　他走进屋子，屋里很暗。\r\n第二章 转折\r\n　　灯没亮。\r\n第三章 结尾\r\n　　他坐下了。\r\n'
      await writeFile(join(ws, 'gbk.txt'), iconv.encode(gbkText, 'gbk'))
      const got = await lib.readTextSmart(join(ws, 'gbk.txt'))
      ok(got.includes('他走进屋子'), '**GBK 的 txt 能正确解码**')
      ok(!got.includes('\ufffd'), '没有替换字符（不是乱码）')

      await writeFile(join(ws, 'utf8.txt'), gbkText, 'utf8')
      ok((await lib.readTextSmart(join(ws, 'utf8.txt'))).includes('他走进屋子'), 'UTF-8 也认')
      await writeFile(join(ws, 'bom.txt'), '\ufeff' + gbkText, 'utf8')
      ok(!(await lib.readTextSmart(join(ws, 'bom.txt'))).startsWith('\ufeff'), '去掉 BOM')

      // —— 分段：按章节标题切 ——
      const long = []
      for (let i = 1; i <= 12; i += 1) {
        long.push(`第${i}章 标题${i}`)
        long.push('　　正文。'.repeat(400))
      }
      await writeFile(join(ws, 'book.txt'), long.join('\n'), 'utf8')
      const r = await lib.chunkBook(join(ws, 'book.txt'), { chunkChars: 5000 })
      ok(r.ok === true, '切段成功')
      ok(r.byChapter === true, '**按章节标题切**（不是硬切）')
      ok(r.chapterMarks === 12, `认出 12 个章节标题（实际 ${r.chapterMarks}）`)
      ok(r.total >= 2, `切成 ${r.total} 段`)
      ok(r.chunks.every((c) => c.chars <= 5000), '每段都不超上限')
      ok(r.chunks.reduce((a, c) => a + c.chars, 0) > 10000, '总字数对得上量级')

      // 取某段正文
      const c0 = await lib.chunkText(join(ws, 'book.txt'), 0, { chunkChars: 5000 })
      ok(c0.ok === true && c0.text.includes('第一章') || c0.text.includes('第1章'), '取第 1 段拿到开头')
      ok(c0.chars > 0 && c0.chars <= 5000, '第 1 段不超上限')
      const cLast = await lib.chunkText(join(ws, 'book.txt'), r.total - 1, { chunkChars: 5000 })
      ok(cLast.ok === true, '取最后一段也行')
      ok((await lib.chunkText(join(ws, 'book.txt'), 999, { chunkChars: 5000 })).ok === false, '取不存在的段如实报')

      // 没有章节标题 → 硬切
      await writeFile(join(ws, 'flat.txt'), '一段没有任何章节标题的长文本。'.repeat(2000), 'utf8')
      const f = await lib.chunkBook(join(ws, 'flat.txt'), { chunkChars: 5000 })
      ok(f.byChapter === false, '没有章节标题时标出来')
      ok(f.total >= 2, '硬切成多段')
      ok(f.hint.includes('没找到章节标题'), '提示说明了')

      // —— 提取本地书 ——
      await mkdir(join(ws, '本地书'), { recursive: true })
      await writeFile(join(ws, '本地书', '某本.txt'), '第1章 开头\n' + '正文内容。'.repeat(6000), 'utf8')
      const ex = await lib.extractFromWorkspace(ws)
      ok(ex.added >= 1, '**本地书/ 里的 txt 能被提取**')
      const l = await lib.list(ws)
      const fromBook = l.items.find((x) => x.source === '本地书')
      ok(fromBook !== undefined, '来源标成「本地书」')
      ok(fromBook.kind === 'structure', '本地书归到结构')
      ok(fromBook.enabled === false, '提取的默认不参与合成（是原料）')
      ok(fromBook.body.length <= 20000, '整本小说被截到 2 万字以内（不然塞不进提示词）')
      ok(fromBook.summary.includes('原文'), 'summary 写清原文多长')
    } finally { await rm(ws, { recursive: true, force: true }) }
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
