#!/usr/bin/env node
/**
 * dsh-writing-slots / 阅读器 自测。
 *
 *   node verify-reader.mjs
 *
 * 分两部分：
 *   一、**离线**（默认跑）：书源数据完整性、XPath/JSON 规则引擎、
 *       编码识别、广告过滤、TXT 拆章、送进工作目录的检查。
 *   二、**在线**（加 --net 才跑）：真的去搜一本书，验证链路。
 *       默认不跑 —— 书源是第三方站点，不该在每次自测里打扰它们。
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseHtml, xpathTexts, xpathText, xpathAttrs, jsonPath, getText, parseXPath, splitXPath, evalXPath } from './lib/reader/xpath.js'
import { combineUrl, decodeBuffer, filterContent, chapterToTxt, MAX_SEARCH_SOURCES } from './lib/reader/engine.js'
import { BUILTIN_SOURCES } from './lib/reader/bsdata.js'
import { splitTxtChapters, localBooksDir } from './lib/reader/localbooks.js'
import * as R from './lib/reader/service.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}
const tmp = async () => mkdtemp(join(tmpdir(), 'dws-rd-'))
const NET = process.argv.includes('--net')

const main = async () => {
  console.log('一、书源数据')
  {
    ok(BUILTIN_SOURCES.length === 41, `内置书源 41 个（实际 ${BUILTIN_SOURCES.length}）`)
    ok(BUILTIN_SOURCES.every((s) => typeof s.title === 'string' && s.title !== ''), '每个源都有标题')
    ok(BUILTIN_SOURCES.every((s) => typeof s.query_url === 'string' && s.query_url.startsWith('http')), '每个源都有查询地址')
    ok(BUILTIN_SOURCES.every((s) => typeof s.book_name_xpath === 'string'), '每个源都有书名规则')
    // 字段名是 chapter_title_xpath / chapter_url_xpath（我第一版写成 chapter_list_xpath 了）
    ok(BUILTIN_SOURCES.every((s) => typeof s.chapter_title_xpath === 'string'), '每个源都有章节标题规则')
    ok(BUILTIN_SOURCES.every((s) => typeof s.chapter_url_xpath === 'string'), '每个源都有章节链接规则')
    ok(BUILTIN_SOURCES.every((s) => typeof s.content_xpath === 'string'), '每个源都有正文规则')
    const jsonRules = BUILTIN_SOURCES.filter((s) => String(s.book_name_xpath).startsWith('/data')).length
    ok(jsonRules > 0, `有 ${jsonRules} 个源用 JSON 规则`)
    ok(MAX_SEARCH_SOURCES === 10, '单次搜索默认查 10 个源（限并发）')

    const list = R.listSources()
    ok(list.length === 41, 'listSources 返回 41 个')
    ok(list.every((x) => typeof x.host === 'string'), '每个源都解析出 host')
    const official = list.filter((x) => x.official)
    ok(official.length >= 1, `标出 ${official.length} 个正规平台（晋江等）`)
    ok(official.some((x) => x.host.includes('jjwxc')), '晋江被标为正规平台')
    // 风险提示必须带上
    ok(R.SOURCE_NOTICE.warning.includes('严禁非法与商业用途'), '风险提示保留上游原话')
    ok(R.SOURCE_NOTICE.origin.includes('dsh-reader'), '标注了来源')
    ok(R.SOURCE_NOTICE.upstream.includes('github'), '给出上游地址')
    ok(R.findSource(BUILTIN_SOURCES[0].title) !== null, '按标题找得到')
    ok(R.findSource('不存在的源') === null, '找不到返回 null')
  }

  console.log('\n二、XPath 规则引擎')
  {
    const html = `
      <div id="list">
        <a href="/book/1">第一本</a>
        <a href="/book/2">第二本</a>
        <a href="/book/3" class="last">第三本</a>
      </div>
      <div id="info"><span class="author">作者甲</span></div>`
    const doc = parseHtml(html)
    ok(xpathTexts(doc, '//div[@id="list"]/a').length === 3, '取到 3 个 a')
    ok(xpathTexts(doc, '//div[@id="list"]/a')[0] === '第一本', '第一个文本正确')
    ok(xpathAttrs(doc, '//div[@id="list"]/a/@href').length === 3, '取到 3 个 href')
    ok(xpathAttrs(doc, '//div[@id="list"]/a/@href')[0] === '/book/1', 'href 正确')
    ok(xpathText(doc, '//span[@class="author"]') === '作者甲', '按 class 取到作者')
    ok(xpathTexts(doc, '//div[@id="nope"]/a').length === 0, '取不到时返回空数组，不抛')
    // getText 收的是**元素节点**。
    // 注意 children[0] 是前导空白**文本节点**（htmlparser2 保留空白），
    // 直接传它会得到一串空格 —— 所以我第一版断言失败不是代码的问题。
    // 正确的取法是用 XPath 选元素。
    const listEl = evalXPath([doc], parseXPath('//div[@id="list"]'))[0]
    ok(getText(listEl).includes('第一本'), 'getText（XPath 选中的元素）能拿到文本')
    ok(typeof doc.children[0].type === 'string', 'children[0] 是节点对象（可能是文本节点）')
    ok(getText(doc) === '', 'getText 传 Document 节点返回空 —— 原实现如此')
    // position 过滤
    const after = xpathTexts(doc, '//div[@id="list"]/a[position()>1]')
    ok(after.length === 2, `position()>1 取到 2 个（实际 ${after.length}）`)
    // 联合
    ok(splitXPath('//a/@href').length >= 1, 'splitXPath 可切分')
    ok(Array.isArray(parseXPath('//div/a')), 'parseXPath 返回步骤数组')
  }
  {
    const json = { data: { books: [{ name: '书一', url: '/b/1' }, { name: '书二', url: '/b/2' }] } }
    const doc = parseHtml('x') // 占位
    const j = (await import('./lib/reader/xpath.js')).parseJson(JSON.stringify(json))
    // 注意：jsonPath 会把数组**摊平**，所以路径里不写索引 ——
    // /data/books/name 返回全部书名。写索引反而取不到（我第一版就是这么错的）。
    ok(jsonPath(j, '/data/books/name').join(',') === '书一,书二', 'JSON 路径摊平数组取全部')
    ok(jsonPath(j, '/data/books/url').join(',') === '/b/1,/b/2', 'JSON 路径取全部 url')
    ok(jsonPath(j, '/data/books/0/name').length === 0, '写显式索引取不到（实现会摊平）')
    ok(jsonPath(j, '/data/nope').length === 0, '取不到返回空数组')
    ok(jsonPath(j, '').length === 0, '空路径返回空数组')
  }

  console.log('\n三、编码与清洗')
  {
    // GBK 解码：用 iconv-lite 编出 GBK 字节再解回来
    const iconv = (await import('iconv-lite')).default
    const gbk = iconv.encode('他走进屋子，屋里很暗。', 'gbk')
    const back = decodeBuffer(gbk, 0)
    ok(back.includes('他走进屋子'), 'GBK 自动识别并解码')
    const utf8 = Buffer.from('他走进屋子。', 'utf8')
    ok(decodeBuffer(utf8, 0).includes('他走进屋子'), 'UTF-8 正常')
    const forced = decodeBuffer(gbk, 1)  // 1 = 强制 utc? 用默认兜底
    ok(typeof forced === 'string', '指定编码时也返回字符串')
  }
  {
    ok(combineUrl('https://a.com/x/y', '../z') === 'https://a.com/z', '相对路径 ../')
    ok(combineUrl('https://a.com/x/y', '/z') === 'https://a.com/z', '绝对路径 /')
    ok(combineUrl('https://a.com/x/y', 'https://b.com/z') === 'https://b.com/z', '完整 URL 直接用')
    ok(combineUrl('https://a.com/x/y', 'z') === 'https://a.com/x/z', '同级相对路径')
  }
  {
    // filterContent 按**每源配置**的关键词过滤（content_filter_type:
    // 1=纯文本替换, 2=正则），不做启发式广告识别 —— 这是原实现的语义。
    const dirty = '正文第一段。\n\n本站域名 www.example.com 请记住\n\n正文第二段。'
    // 没配过滤时原样返回（只清控制字符与多余空行）
    const raw = filterContent(dirty, { title: '测试' })
    ok(raw.includes('www.example.com'), '没配过滤时不动内容（不做启发式广告识别）')
    // type=1：纯文本移除
    const t1 = filterContent(dirty, { content_filter_type: 1, content_filter_keyword: '本站域名' })
    ok(!t1.includes('本站域名'), 'type=1 按关键词移除')
    ok(t1.includes('正文第一段'), '正文保留')
    // type=2：正则移除
    const t2 = filterContent(dirty, { content_filter_type: 2, content_filter_keyword: 'www\\.[a-z.]+' })
    ok(!t2.includes('www.example.com'), 'type=2 按正则移除')
    // 无效正则不能炸
    const t3 = filterContent(dirty, { content_filter_type: 2, content_filter_keyword: '([' })
    ok(t3.includes('正文第一段'), '无效正则时不炸，原样返回')
    // 控制字符与多余空行总会被清
    const t4 = filterContent('甲\u0000乙\n\n\n\n丙', {})
    ok(!t4.includes('\u0000') && !t4.includes('\n\n\n'), '清掉控制字符与多余空行')
    const t = chapterToTxt('第一章', '正文。')
    ok(t.includes('第一章') && t.includes('正文。'), '章转 TXT 带标题')
  }

  console.log('\n四、本地书与拆章')
  {
    ok(localBooksDir().includes('本地书'), '默认落点在工作目录下的「本地书」')
    ok(localBooksDir('/x/y') === '/x/y', '传 customDir 时优先')
    const txt = [
      '第一卷 风起',
      '第一章 开端',
      '正文一。',
      '第二章 转折',
      '正文二。',
      '番外 后来',
      '正文三。',
    ].join('\n')
    const cs = splitTxtChapters(txt)
    ok(cs.length >= 3, `拆出 ${cs.length} 章`)
    ok(cs.some((c) => c.title.includes('第一章')), '认出「第一章」')
    ok(cs.some((c) => c.title.includes('番外')), '认出「番外」')
    ok(splitTxtChapters('没有章节标题的一段话。').length >= 1, '没有标题时也给一章')
  }
  {
    const root = await tmp()
    try {
      // 造一个工作目录 + 本地书
      await mkdir(join(root, '本地书'), { recursive: true })
      await mkdir(join(root, '章节'), { recursive: true })
      await writeFile(join(root, '本地书', '某本.txt'), '第一章 开始\n正文。\n第二章 继续\n正文二。', 'utf8')
      await writeFile(join(root, '章节', '第0001章-开篇.md'), '他走进屋子。', 'utf8')
      await writeFile(join(root, '本地书', '忽略.md'), '不是 txt', 'utf8')

      const scan = await R.scanBooks(root)
      ok(scan.counts.local === 1, `本地书扫到 1 个 txt（实际 ${scan.counts.local}）`)
      ok(scan.counts.workspace === 1, `工作目录章节扫到 1 个（实际 ${scan.counts.workspace}）`)
      ok(scan.books.some((b) => b.origin === 'workspace'), '标出「我的稿子」来源')

      const read = await R.readBook(join(root, '本地书', '某本.txt'))
      ok(read.chapterCount >= 2, `读本地书拆出 ${read.chapterCount} 章`)
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  console.log('\n五、送进工作目录（和写作流程打通）')
  {
    const root = await tmp()
    try {
      const novel = `他走进屋子，屋里很暗。\n\n${'他慢慢往前走，手指贴着墙。'.repeat(40)}`

      const d = await R.sendToWorkspace(root, { kind: 'deconstruct', name: '某本', text: novel, chapterIndex: 4 })
      ok(d.ok === true, '送拆文库成功')
      ok(d.dir === '拆文库', '落到拆文库')
      ok(d.path.includes('-第0005章'), `文件名带章号（${d.path.split('/').pop()}）`)
      ok(existsSync(d.path), '文件真的写了')

      const s = await R.sendToWorkspace(root, { kind: 'sample', name: '语料', text: novel })
      ok(s.ok === true && s.dir === '样本', '送样本成功')
      ok(Array.isArray(s.alsoUseful), '顺带提示还能喂给哪些槽位')

      const m = await R.sendToWorkspace(root, { kind: 'material', name: '榜单', text: novel })
      ok(m.ok === true && m.dir === '素材', '送素材成功')

      ok((await R.sendToWorkspace(root, { kind: 'bogus', text: novel })).ok === false, '不认识的去向被拒')
      ok((await R.sendToWorkspace(root, { kind: 'sample', text: '   ' })).ok === false, '空内容被拒')

      // 混淆内容不许进语料库
      const obf = `${'\ue491'}皇${'\ue48e'}辈装。`.repeat(60)
      const bad = await R.sendToWorkspace(root, { kind: 'sample', name: '混淆', text: obf })
      ok(bad.ok === false && bad.kind === 'obfuscated', '**混淆内容进不了语料库**')
      ok(!existsSync(join(root, '样本', '混淆.md')), '确认没写进去')

      // 太短也不给进
      const short = await R.sendToWorkspace(root, { kind: 'sample', name: '太短', text: '太短了。' })
      ok(short.ok === false && short.kind === 'too-short', '太短的内容被拒（会污染统计）')

      // 文件名里的非法字符
      const weird = await R.sendToWorkspace(root, { kind: 'material', name: 'a/b:c*d', text: novel })
      ok(weird.ok === true && !weird.path.includes('/a/'), '文件名非法字符被清掉')
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  console.log('\n六、下载管理')
  {
    ok(typeof R.downloads.start === 'function', '有 start')
    ok(typeof R.downloads.cancel === 'function', '有 cancel')
    ok(R.downloads.get('不存在的任务') === undefined, '查不存在的任务返回 undefined')
    ok(R.downloads.cancel('不存在的任务') === false, '取消不存在的任务返回 false')
  }

  if (NET) {
    console.log('\n七、在线链路（--net）')
    const { results, errors, searched } = await R.searchAll('雪中悍刀行', { limit: 4 })
    ok(searched === 4, `查了 ${searched} 个源`)
    console.log(`    命中 ${results.length} 条，${errors.length} 个源报错`)
    for (const x of results.slice(0, 3)) console.log(`    · ${x.title}／${x.author ?? ''} [${x.source}]`)
    ok(results.length > 0 || errors.length > 0, '在线搜索有结果或如实报错')
    if (results.length > 0) {
      const first = results[0]
      const cs = await R.chapters(first.source, first.url)
      ok(cs.length > 0, `《${first.title}》取到 ${cs.length} 章`)
      if (cs.length > 0) {
        const text = await R.content(first.source, cs[0].url)
        ok(text.length > 50, `第 1 章取到 ${text.length} 字`)
        ok(text.includes('。'), '正文看起来是中文句子')
      }
    }
  } else {
    console.log('\n七、在线链路 —— 跳过（要跑加 --net；默认不打扰第三方站点）')
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
