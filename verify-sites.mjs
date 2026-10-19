#!/usr/bin/env node
/**
 * dsh-writing-slots / 工作目录 + 小说网站 自测。
 *
 *   node verify-sites.mjs
 *
 * 重点：
 *   - 工作目录解析优先级、定位项目根、初始化幂等、可写性校验；
 *   - cookie 是**凭据**：加密落盘、不回显、坏了不覆盖；
 *   - **反爬识别**：挑战页 / 字体混淆 / JS 空页 都要被认出来，
 *     而且**不能把乱码当内容**（这比取不到更坏）。
 */
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveWorkspace, locateProject, status, init, saveConfig, validate,
  displayPath, expandPath, defaultWorkspace, LAYOUT, CONFIG_NAME,
} from './lib/workspace.js'
import {
  SITES, site, encrypt, decrypt, maskCookie, normalizeCookie, setCookie,
  listCookies, removeCookie, resolveCookie, browserHeaders, privateUseCount,
  sniffEncoding, classifyResponse, classifyContent, storeContent, parseRank,
  authDir, keyPath, cookiePath, NAV_WORDS,
} from './lib/sites.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}
const tmp = async () => mkdtemp(join(tmpdir(), 'dws-ws-'))

const main = async () => {
  console.log('一、工作目录解析')
  {
    const r1 = resolveWorkspace({ explicit: '/tmp/a' })
    ok(r1.dir === '/tmp/a' && r1.source === 'explicit', '显式传入优先')
    const r2 = resolveWorkspace({ sessionCwd: '/tmp/b' })
    ok(r2.dir === '/tmp/b' && r2.source === 'session-cwd', '其次会话 cwd')
    // 环境变量优先于会话 cwd
    const old = process.env.DSH_WRITING_WORKSPACE
    process.env.DSH_WRITING_WORKSPACE = '/tmp/env-ws'
    const r3 = resolveWorkspace({ sessionCwd: '/tmp/b' })
    ok(r3.dir === '/tmp/env-ws' && r3.source === 'env', '环境变量优先于会话 cwd')
    if (old === undefined) delete process.env.DSH_WRITING_WORKSPACE
    else process.env.DSH_WRITING_WORKSPACE = old
    const r4 = resolveWorkspace({})
    ok(r4.dir === defaultWorkspace() && r4.source === 'default', '都没有时用默认落点')
    ok(resolveWorkspace({ explicit: '~/x' }).dir.startsWith('/'), '展开 ~')
    ok(displayPath('/home/x') === '/home/x' || displayPath('/home/x').startsWith('~'), 'displayPath 可用')
  }
  {
    ok(LAYOUT.length >= 8, `${LAYOUT.length} 个标准目录`)
    ok(LAYOUT.some((l) => l.name === '样本' && l.samples === true), '有「样本」目录且标为样本来源')
    ok(LAYOUT.some((l) => l.name === '拆文库'), '有「拆文库」目录')
    ok(LAYOUT.some((l) => l.name === '素材'), '有「素材」目录')
  }
  {
    const root = await tmp()
    try {
      // 空目录：定位应返回自身
      ok(await locateProject(root) === root, '空目录定位为自身')
      // 有 novel 子目录且里面有 章节
      await mkdir(join(root, 'novel', '章节'), { recursive: true })
      ok(await locateProject(root) === join(root, 'novel'), '有 novel/ 时往下走一层')
      // 目录自己就是项目
      const root2 = await tmp()
      await mkdir(join(root2, '细纲'), { recursive: true })
      ok(await locateProject(root2) === root2, '本身就是项目时不动')
      await rm(root2, { recursive: true, force: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  {
    const root = await tmp()
    try {
      const r1 = await init(root)
      ok(r1.ok === true && r1.created.length > 0, '首次初始化有新建')
      ok(existsSync(join(root, '章节', '草稿')), '建了 章节/草稿')
      for (const l of LAYOUT) ok(existsSync(join(root, l.name)), `建了 ${l.name}/`)
      const r2 = await init(root)
      ok(r2.created.length === 0, '再初始化是幂等的（不重复建）')
      const only = await init(root, { only: ['素材'] })
      ok(only.created.length === 0, 'only 参数也幂等')

      const v = await validate(root)
      ok(v.ok === true && v.writable === true, '校验可写')
      const v2 = await validate(join(root, 'nope'))
      ok(v2.ok === false && v2.problems.some((p) => p.includes('不存在')), '不存在的路径被拒')

      await saveConfig(root, { workspace: root, theme: 'x' })
      const st = await status(root)
      ok(st.config !== null && st.config.workspace === root, '配置写进去了')
      ok(st.config.updatedAt !== undefined, '配置带时间戳')
      await saveConfig(root, { theme: 'y' })
      const st2 = await status(root)
      ok(st2.config.workspace === root && st2.config.theme === 'y', '再写配置是合并不是覆盖')

      await writeFile(join(root, '素材', 'a.md'), 'hello')
      const st3 = await status(root)
      const mats = st3.dirs.find((d) => d.name === '素材')
      ok(mats.files === 1 && mats.bytes === 5, 'status 数出文件与体积')
      ok(st3.keyFiles.some((f) => f.name === '前情提要.md' && f.present === false), 'keyFiles 报告缺失')
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  console.log('\n一·二、记住用哪个工作目录')
  {
    const root = await tmp()
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    // 模块已加载，dshHome 每次调用都读环境变量，所以改了即时生效
    const {
      globalConfigPath, loadGlobal, saveGlobal, checkRemembered,
    } = await import('./lib/workspace.js')
    try {
      ok(globalConfigPath().startsWith(root), '全局配置记在 DSH 主目录下，不在工作目录里')
      ok(globalConfigPath().includes('workspace.json'), '文件名 workspace.json')

      ok(await loadGlobal() === null, '没存过时返回 null')

      const ws = join(root, 'my-book')
      await saveGlobal({ workspace: ws, source: 'set' })
      const back = await loadGlobal()
      ok(back !== null && back.workspace === ws, '存了能读回来')
      ok(typeof back.updatedAt === 'string', '带时间戳')
      // 注意优先级：`a & 0o777 === 0o600` 会先算 ===（得到 false），等于 a & 0。
      // 必须加括号 —— 我第一版就是这么写错的。
      const gperm = (await stat(globalConfigPath())).mode & 0o777
      ok(gperm === 0o600, `配置权限 0600（实际 ${gperm.toString(8)}）`)

      // 合并写，不互相覆盖
      await saveGlobal({ source: 'other' })
      const back2 = await loadGlobal()
      ok(back2.workspace === ws && back2.source === 'other', '再写是合并不是覆盖')

      // 记住的目录被删了要能发现
      ok((await checkRemembered()).ok === false, '记住的目录不存在时如实报')
      await mkdir(ws, { recursive: true })
      ok((await checkRemembered()).ok === true, '目录建好后校验通过')

      // 忘掉它
      await saveGlobal({ workspace: null })
      ok(await loadGlobal() === null, 'workspace=null 等于忘掉')

      // 坏掉的配置不能抛
      await writeFile(globalConfigPath(), '{ 不是 JSON', 'utf8')
      ok(await loadGlobal() === null, '配置坏掉时返回 null，不抛')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(root, { recursive: true, force: true })
    }
  }

  console.log('\n一·三、工作区盘点（产出怎么进到槽位）')
  {
    const root = await tmp()
    const { inventory } = await import('./lib/workspace.js')
    try {
      await init(root)
      // 空工作区：该指出「还没东西」
      let inv = await inventory(root)
      ok(inv.slots.length === 7, `盘点 7 个槽位（实际 ${inv.slots.length}）`)
      ok(inv.material.samples.count === 0, '空工作区样本 0')
      ok(inv.slots.find((x) => x.id === 'style_anchor').ready === false, '没样本时 Style Anchor 未就绪')
      ok(inv.next != null && inv.next.slot === 'world_builder', '空工作区先推 World Builder')

      // 放两篇样本 → Style Anchor 应该就绪，并推「先跑 Style Anchor」
      await writeFile(join(root, '样本', 'a.md'), '正文。'.repeat(200), 'utf8')
      await writeFile(join(root, '样本', 'b.md'), '正文。'.repeat(200), 'utf8')
      inv = await inventory(root)
      const sa = inv.slots.find((x) => x.id === 'style_anchor')
      ok(sa.ready === true && sa.have === 2, '有样本后 Style Anchor 就绪')
      ok(sa.action === 'use-samples', '给出一键动作 use-samples')
      ok(sa.files.length === 2, '带出文件名清单')
      ok(inv.next.slot === 'style_anchor' && inv.next.text.includes('样本目录'), '下一步推 Style Anchor')

      // 模拟「Style Anchor 已经跑过」—— 否则下一步会一直推它（那是对的，
      // 初始化就该先做文风基线）
      await writeFile(join(root, '设定', 'style-guide.md'), '# 文风', 'utf8')
      await writeFile(join(root, '设定', 'world-bible.md'), '# 世界观', 'utf8')

      // 细纲 → Chapter Pack
      await writeFile(join(root, '细纲', '第0025章.md'), '- **任务**：x\n- **钩子**：y', 'utf8')
      await writeFile(join(root, '细纲', '第0026章.md'), '- **任务**：x\n- **钩子**：y', 'utf8')
      inv = await inventory(root)
      const cp = inv.slots.find((x) => x.id === 'chapter_pack')
      ok(cp.ready === true && cp.have === 2, '有细纲后 Chapter Pack 就绪')
      ok(inv.material.briefs.first === 25 && inv.material.briefs.last === 26, '识别出细纲章号范围')
      ok(inv.material.settings.hasStyle === true, '认出已跑过 Style Anchor')
      ok(inv.next.slot === 'chapter_pack', '有细纲没正文 → 推 Chapter Pack')

      // 正文 → 审稿/去味/读者
      await writeFile(join(root, '章节', '第0025章-x.md'), '他走进屋子。'.repeat(50), 'utf8')
      inv = await inventory(root)
      ok(inv.slots.find((x) => x.id === 'review_pass').ready === true, '有正文后 Review Pass 就绪')
      ok(inv.slots.find((x) => x.id === 'deai_polish').ready === true, '有正文后 De-AI Polish 就绪')
      ok(inv.slots.find((x) => x.id === 'reader_sim').ready === true, '有正文后读者通道就绪')
      ok(inv.next.slot === 'deai_polish', '写完正文 → 推审稿/去味')
      ok(inv.material.chapters.count === 1, '正文计数正确')

      // 没跑过的槽位要有提示
      ok(inv.slots.find((x) => x.id === 'chapter_pack').hint !== null, '缺前情提要时给提示')

      // 非 md 的细纲不计入
      await writeFile(join(root, '细纲', 'note.txt'), 'x', 'utf8')
      inv = await inventory(root)
      ok(inv.material.briefs.count === 2, '细纲只数 .md')
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  console.log('\n一·四、工作目录失效不能永久回退（真机踩到的）')
  {
    const root = await tmp()
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const W = await import('./lib/workspace.js')
      const ws = join(root, 'my-book')
      await mkdir(ws, { recursive: true })
      await W.saveGlobal({ workspace: ws })

      // 1. 可写时校验通过
      let v = await W.validate(ws)
      ok(v.ok === true && v.writable === true, '可写目录校验通过')
      ok(v.details.length === 0, '没问题时不带细节')

      // 2. 不可写时要**带出真实原因**，不能只说「不可写」
      const ro = join(root, 'readonly')
      await mkdir(ro, { recursive: true })
      const { chmod } = await import('node:fs/promises')
      await chmod(ro, 0o500)   // 只读
      if (process.getuid?.() === 0) {
        // root 无视权限位，这条在容器里跳过
        console.log('    （以 root 运行，跳过只读测试）')
      } else {
        v = await W.validate(ro)
        ok(v.ok === false, '只读目录校验失败')
        ok(v.problems.some((x) => x.includes('不可写')), '报出不可写')
        ok((v.details ?? []).length > 0, '**带出细节**（第一版只说「不可写」，查不出原因）')
        ok(JSON.stringify(v.details).includes('EACCES') || JSON.stringify(v.details).includes('code'), '细节里有错误码')
      }
      await chmod(ro, 0o700).catch(() => {})

      // 3. cleanup 失败不能被当成「不可写」
      //    （旧实现把 writeFile 与 unlink 放同一个 try，unlink 抛错就误报）
      v = await W.validate(ws)
      ok(v.ok === true, '写探针清理失败不影响「可写」判断')

      // 4. 不存在的路径
      v = await W.validate(join(root, 'nope'))
      ok(v.ok === false && v.problems.some((x) => x.includes('不存在')), '不存在的路径如实报')
      ok((v.details ?? []).length > 0, '不存在也带细节')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(root, { recursive: true, force: true })
    }
  }

  console.log('\n二、cookie 是凭据')
  {
    const key = Buffer.alloc(32, 7)
    const payload = encrypt('sessionid=abc; uid=42', key)
    ok(payload.data !== 'sessionid=abc; uid=42', '密文不等于明文')
    ok(!JSON.stringify(payload).includes('sessionid'), '密文里看不到明文')
    ok(decrypt(payload, key) === 'sessionid=abc; uid=42', '能解回来')
    // 篡改能被发现（GCM 认证）
    const tampered = { ...payload, data: Buffer.from('evil').toString('base64') }
    let threw = null
    try { decrypt(tampered, key) } catch (e) { threw = e }
    ok(threw !== null, '被改过的密文解不开（GCM 认证）')
    // 换密钥也解不开
    let threw2 = null
    try { decrypt(payload, Buffer.alloc(32, 8)) } catch (e) { threw2 = e }
    ok(threw2 !== null, '换密钥解不开')
  }
  {
    ok(maskCookie('short') === '••••••', '短值全打码')
    const m = maskCookie('sessionid=abcdefghijklmnop')
    ok(m.includes('•') && !m.includes('efghij'), '长值只留首尾')
    ok(normalizeCookie(' Cookie: a=1; b=2 ') === 'a=1; b=2', '去掉 Cookie: 前缀')
    ok(normalizeCookie('"a=1; b=2"') === 'a=1; b=2', '去掉引号')
    ok(normalizeCookie('a=1;\nb=2\n') === 'a=1; b=2', '换行归一成分号')
    ok(normalizeCookie('  a=1 ;; b=2  ') === 'a=1; b=2', '空段丢掉')
  }
  {
    const root = await tmp()
    try {
      const ws = root
      // 没存时
      const l0 = await listCookies(ws)
      ok(l0.sites.every((x) => x.stored === false), '初始都没存')
      ok(l0.sites.length === SITES.length, '列出全部站点')

      // 存
      const r = await setCookie(ws, 'fanqie', 'sessionid=verysecretvalue123456; uid=42')
      ok(r.ok === true, '存 cookie 成功')
      ok(r.hint.includes('•') && !r.hint.includes('secretvalue'), '返回的是打码值')

      // 落盘是加密的
      const raw = await readFile(cookiePath(ws), 'utf8')
      ok(!raw.includes('verysecretvalue'), '**文件里没有明文 cookie**')
      ok(raw.includes('aes-256-gcm'), '标了算法')
      const perm = (await stat(keyPath(ws))).mode & 0o777
      ok(perm === 0o600, `密钥权限 0600（实际 ${perm.toString(8)}）`)
      const cperm = (await stat(cookiePath(ws))).mode & 0o777
      ok(cperm === 0o600, `cookie 文件权限 0600（实际 ${cperm.toString(8)}）`)

      // 能解回来给请求用
      const plain = await resolveCookie(ws, 'fanqie')
      ok(plain.includes('verysecretvalue'), '能解出明文给请求用')

      // 列表不回显
      const l1 = await listCookies(ws)
      const fq = l1.sites.find((x) => x.id === 'fanqie')
      ok(fq.stored === true && fq.hint.includes('•'), '列表打码')
      ok(!JSON.stringify(l1).includes('verysecretvalue'), '**列表接口不泄漏明文**')

      // 校验
      ok((await setCookie(ws, 'nope', 'a=1')).ok === false, '不认识的站点被拒')
      ok((await setCookie(ws, 'fanqie', '')).ok === false, '空 cookie 被拒')
      ok((await setCookie(ws, 'fanqie', 'garbage')).ok === false, '没有 k=v 的被拒（多半没复制全）')

      // 删
      ok((await removeCookie(ws, 'fanqie')).ok === true, '删除成功')
      ok((await removeCookie(ws, 'fanqie')).ok === false, '重复删如实报')
      ok((await resolveCookie(ws, 'fanqie')) === null, '删后解不出')
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  console.log('\n三、反爬识别（最要紧的一节）')
  {
    // 挑战页
    const challenge = '<!DOCTYPE html><html><head><script>var buid = "ffff"</script><script src="/C2WF946J0/probe.js?v=x"></script></head><body></body></html>'
    const c1 = classifyResponse({ status: 200, text: challenge, bytes: challenge.length, site: site('qidian') })
    ok(c1.ok === false && c1.kind === 'challenge', '认出挑战页')
    ok(c1.reason.includes('挑战页'), '说明是挑战页')

    // 字体混淆
    const obf = `这本书叫${'\ue491'}皇${'\ue48e'}辈装，讲的是修炼。`.repeat(20)
    const c2 = classifyResponse({ status: 200, text: obf, bytes: obf.length * 3, site: site('fanqie') })
    ok(c2.ok === false && c2.kind === 'obfuscated', '认出字体混淆')
    ok(c2.pua >= 40, `数出私有区字符（${c2.pua}）`)
    ok(c2.reason.includes('不做这种绕过'), '**明确声明不绕过**')

    // JS 空页
    const empty = '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>'
    const c3 = classifyResponse({ status: 200, text: empty, bytes: empty.length, site: site('qidian') })
    ok(c3.ok === false && c3.kind === 'empty', '认出 JS 空页')

    // 权限
    ok(classifyResponse({ status: 403, text: 'x' }).kind === 'forbidden', '403 报无权限')
    ok(classifyResponse({ status: 302, text: '' }).kind === 'redirect', '302 报重定向')

    // 正常内容
    const good = `他走进屋子。屋里很暗，只有灶膛里一点余光。\n\n${'他把手贴在墙上，慢慢往前走。'.repeat(30)}`
    const c4 = classifyResponse({ status: 200, text: good, bytes: good.length * 3 })
    ok(c4.ok === true && c4.kind === 'content', '正常内容通过')
    ok(c4.han > 100, `数出中文字符（${c4.han}）`)

    ok(privateUseCount('abc') === 0, '没有私有区字符时为 0')
    ok(privateUseCount('\ue000\ue001') === 2, '数得准')
  }
  {
    // 编码嗅探
    ok(sniffEncoding(new Uint8Array([65]), 'text/html; charset=gbk') === 'gbk', '声明 GBK')
    ok(sniffEncoding(new Uint8Array([65]), 'text/html; charset=gb2312') === 'gbk', '声明 GB2312')
    ok(sniffEncoding(new Uint8Array([65, 66]), 'text/html; charset=utf-8') === 'utf-8', '声明 UTF-8')
    const gbkBytes = new Uint8Array(500)
    for (let i = 0; i < 500; i += 1) gbkBytes[i] = 0xb0 + (i % 40)
    ok(sniffEncoding(gbkBytes, '') === 'gbk', '没声明时按字节嗅探出 GBK')
  }
  {
    // 浏览器头
    const h = browserHeaders()
    ok(h['user-agent'].includes('Mozilla'), '带 UA')
    ok(h['accept-language'].includes('zh-CN'), '带中文语言')
    ok(h.accept.includes('text/html'), '带 Accept')
    const h2 = browserHeaders({ cookie: 'a=1' })
    ok(h2.cookie === 'a=1', '能附加 cookie')
  }
  {
    // 解析榜单
    const html = '<a href="/b/1">书名一</a><a href="/b/2">书名二</a><a href="/b/1">书名一</a>'
    const items = parseRank(site('qidian'), html)
    ok(items.length === 2, `解析出 ${items.length} 条并去重`)
    ok(items[0].title === '书名一', '标题正确')
    const embedded = '{"bookName":"某本书"}{"bookName":"另一本"}'
    ok(parseRank(site('fanqie'), embedded).length === 2, '认内嵌 JSON 的书名')
    ok(parseRank(site('qidian'), '没有链接').length === 0, '解析不出就返回空，不硬凑')
    // 导航文案不是书名 —— 第一版把「关闭」「完结作品」当书抽出来了
    const navHtml = '<a href="/x">关闭</a><a href="/y">完结作品</a><a href="/b">某本真书</a>'
    const nav = parseRank(site('jjwxc'), navHtml)
    ok(nav.length === 1 && nav[0].title === '某本真书', '导航文案被过滤')
    ok(NAV_WORDS.has('完结作品'), '导航词表含常见按钮')
    // 置信度如实报
    ok(parseRank(site('jjwxc'), navHtml).confidence === 'none', '少而可疑的锚点标 none')
    ok(parseRank(site('fanqie'), '{"bookName":"某本书"}').confidence === 'high', '内嵌 JSON 标 high')
    const many = Array.from({ length: 8 }, (_, i) => `<a href="/b${i}">书名第${i}号</a>`).join('')
    ok(parseRank(site('jjwxc'), many).confidence === 'low', '锚点抽到多条但标 low（要人看一眼）')
  }

  console.log('\n四、按插件功能分类')
  {
    const novel = `${'他走进屋子，屋里很暗。'.repeat(40)}\n\n${'“你来了。”他说。'.repeat(30)}\n\n${'她点点头，没有出声。'.repeat(30)}`
    const c = classifyContent(novel)
    ok(c.stats.han > 500, `统计中文字数（${c.stats.han}）`)
    ok(c.targets.some((t) => t.module === 'style_anchor' && t.slot === 'sample_corpus'), '识别为可当风格样本')
    ok(c.targets.some((t) => t.dir === '样本'), '建议落到「样本」目录')
    ok(c.targets.some((t) => t.module === 'deai_polish'), '建议过去味')
    ok(c.targets.some((t) => t.module === 'prose_sanity'), '建议先跑确定性检查')

    const short = '太短了。'
    ok(classifyContent(short).ok === false, '太短的内容够不上任何槽位')
    ok(classifyContent(short).reasons.length > 0, '给出原因')

    const rank = '起点月票榜 排行 完结 连载 ' + '书名'.repeat(200)
    ok(classifyContent(rank, { kind: 'rank' }).targets.some((t) => t.dir === '素材'), '榜单内容建议落「素材」')

    const long = '正文内容。'.repeat(2000)
    ok(classifyContent(long).targets.some((t) => t.dir === '拆文库'), '长文建议进「拆文库」')
  }
  {
    // 落盘要先过检查
    const root = await tmp()
    try {
      const obf = `${'\ue491'}皇${'\ue48e'}辈装。`.repeat(50)
      const bad = await storeContent(root, '样本', '混淆的', obf)
      ok(bad.ok === false && bad.kind === 'obfuscated', '**混淆内容不许落盘**')
      ok(!existsSync(join(root, '样本', '混淆的.md')), '确认没写进去')

      const good = `他走进屋子。屋里很暗。\n\n${'他慢慢往前走。'.repeat(40)}`
      const r = await storeContent(root, '样本', '好的', good)
      ok(r.ok === true && existsSync(r.path), '正常内容落盘成功')
      const again = await storeContent(root, '样本', '好的', good)
      ok(again.existed === true, '同名文件如实报「覆盖了」')

      // 文件名里的非法字符要被清掉
      const weird = await storeContent(root, '素材', 'a/b:c*d?e"f<g>h|i', good)
      ok(weird.ok === true && !weird.path.includes('/a/'), '文件名非法字符被清掉')

      // force 可以强写（给人留后路）
      const forced = await storeContent(root, '样本', '强写', obf, { force: true })
      ok(forced.ok === true, 'force=true 时允许强写')
    } finally { await rm(root, { recursive: true, force: true }) }
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('\n自测自身异常：', e); process.exit(1) })
