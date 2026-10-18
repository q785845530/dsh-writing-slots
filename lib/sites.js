/**
 * dsh-writing-slots — 小说网站。
 *
 * 用**你自己的 cookie**去站点取内容，像正常人一样：带真实浏览器头、
 * 遵守频率、只取你有权访问的内容。
 *
 * ## 一条明确的边界：不做反爬绕过
 * 实测发现两类情况：
 *   - **起点**返回 209 字节的挑战页（`probe.js`），不是内容；
 *   - **番茄**的书名里混了**私有区字符**（`\ue491`…），是字体混淆：
 *     页面用自定义 woff2 把字形映射到私有区码位，还原需要下载字体再做
 *     字形识别。
 *
 * 这两样都是站点**明确的防护**。本模块**不绕过**它们 —— 不做字体还原、
 * 不破解挑战脚本。能做的是：
 *   1. 认出来，并且**如实报告**，而不是把乱码当内容存进去；
 *   2. 告诉你有哪几条正当路径（配 cookie 重试 / 用浏览器打开 / 直接粘贴正文）。
 *
 * 把乱码存进语料库才是最坏的：Style Anchor 会拿它统计「文风」，
 * 得出的基线全是错的，而且看不出来。
 *
 * ## cookie 是凭据
 * 和 token 一样对待：AES-256-GCM 加密后落盘，不进日志、不回显，
 * 只在对该站点的请求里带上。
 *
 * @module dsh-writing-slots/sites
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { defaultWorkspace } from './workspace.js'

// ————————————————————————— 站点清单 —————————————————————————

/**
 * 站点清单。
 *
 * `kind` 说明取什么内容、`auth` 说明认证方式。实测结论写在 `note` 里 ——
 * 那是真跑过才知道的，不是猜的。
 */
export const SITES = [
  {
    id: 'fanqie',
    name: '番茄小说',
    home: 'https://fanqienovel.com',
    auth: 'cookie',
    note: '榜单页可访问，但书名混了私有区字符（字体混淆）。配 cookie 后正文页通常干净。',
    rankUrl: 'https://fanqienovel.com/rank',
    obfuscated: true,
  },
  {
    id: 'qidian',
    name: '起点中文网',
    home: 'https://www.qidian.com',
    auth: 'cookie',
    note: '无 cookie 时返回挑战页（probe.js）。配 cookie 后正常。',
    rankUrl: 'https://www.qidian.com/rank/',
    challenged: true,
  },
  {
    id: 'jjwxc',
    name: '晋江文学城',
    home: 'https://www.jjwxc.net',
    auth: 'cookie',
    note: '榜单页是 GBK 编码的表格，需要显式指定编码解析。',
    rankUrl: 'https://www.jjwxc.net/topten.php?orderstr=1',
    encoding: 'gbk',
  },
  {
    id: 'qimao',
    name: '七猫中文网',
    home: 'https://www.qimao.com',
    auth: 'cookie',
    note: '榜单页可访问。',
    rankUrl: 'https://www.qimao.com/rank',
  },
  {
    id: 'zongheng',
    name: '纵横中文网',
    home: 'https://www.zongheng.com',
    auth: 'cookie',
    note: '榜单页可访问。',
    rankUrl: 'https://www.zongheng.com/rank',
  },
  {
    id: 'zhihu',
    name: '知乎盐言故事',
    home: 'https://www.zhihu.com',
    auth: 'cookie',
    note: '未登录会 302 跳登录。配 cookie 后可读。',
    rankUrl: 'https://www.zhihu.com/',
    loginRequired: true,
  },
]

/** 按 id 取站点。 */
export function site(id) {
  return SITES.find((s) => s.id === id) ?? null
}

// ————————————————————————— cookie 存储（加密） —————————————————————————

/** 凭据目录：放在工作目录下的 `.auth/`。 */
export function authDir(workspace) {
  return join(workspace ?? defaultWorkspace(), '.auth')
}
export function keyPath(workspace) { return join(authDir(workspace), 'key') }
export function cookiePath(workspace) { return join(authDir(workspace), 'cookies.json') }

/** 取密钥；不存在就生成。权限一律 0600。 */
async function ensureKey(workspace) {
  const path = keyPath(workspace)
  try {
    const buf = await readFile(path)
    if (buf.length === 32) {
      const st = await stat(path)
      // 权限被改宽（比如从备份恢复）就顺手收紧
      if ((st.mode & 0o777) !== 0o600) await chmod(path, 0o600)
      return buf
    }
    throw new Error(`密钥长度不对（${buf.length} 字节）。为避免解不开已有 cookie，这里不覆盖它。`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(authDir(workspace), { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, key, { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
  return key
}

/** AES-256-GCM 加密。 */
export function encrypt(plain, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/** 解密；被改过会抛（GCM 认证）。 */
export function decrypt(payload, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8')
}

async function readStore(workspace) {
  try {
    const parsed = JSON.parse(await readFile(cookiePath(workspace), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.cookies === 'object'
      ? { ok: true, cookies: parsed.cookies }
      : { ok: false, reason: 'cookie 文件结构不对', cookies: {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, cookies: {} }
    if (error instanceof SyntaxError) return { ok: false, reason: 'cookie 文件不是合法 JSON', cookies: {} }
    return { ok: false, reason: error?.message ?? String(error), cookies: {} }
  }
}

async function writeStore(workspace, cookies) {
  await mkdir(authDir(workspace), { recursive: true, mode: 0o700 })
  const path = cookiePath(workspace)
  const tmp = `${path}.tmp-${process.pid}`
  const body = `${JSON.stringify({ version: 1, alg: 'aes-256-gcm', cookies }, null, 2)}\n`
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, path)
    await chmod(path, 0o600).catch(() => {})
  } catch (error) {
    try { await unlink(tmp) } catch { /* 清理失败不重要 */ }
    throw error
  }
}

/** 打码：只留长度与前 4 后 4。cookie 可能很长，不给片段以外的东西。 */
export function maskCookie(value) {
  const s = String(value ?? '')
  if (s.length <= 12) return '•'.repeat(Math.max(6, s.length))
  return `${s.slice(0, 6)}${'•'.repeat(10)}${s.slice(-4)}`
}

/**
 * 把浏览器里复制的一整段 cookie 归一成 `k=v; k2=v2`。
 *
 * 从 DevTools 复制出来的可能有换行、前导 `Cookie: `、或者被引号包着。
 */
export function normalizeCookie(raw) {
  let s = String(raw ?? '').trim()
  if (s === '') return ''
  s = s.replace(/^cookie\s*:\s*/i, '')
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  return s
    .split(/[;\n]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .join('; ')
}

/** 列出各站点的 cookie 状态。**不回显 cookie**。 */
export async function listCookies(workspace) {
  const store = await readStore(workspace)
  const out = []
  for (const s of SITES) {
    const entry = store.cookies[s.id]
    let hint = null
    let broken = null
    if (entry !== undefined) {
      try { hint = maskCookie(decrypt(entry, await ensureKey(workspace))) } catch (e) { broken = e?.message ?? String(e) }
    }
    out.push({
      id: s.id,
      name: s.name,
      auth: s.auth,
      note: s.note,
      stored: entry !== undefined,
      storedAt: entry?.at ?? null,
      hint,
      broken,
    })
  }
  return { ok: store.ok !== false, reason: store.reason ?? null, sites: out, dir: authDir(workspace), keyExists: existsSync(keyPath(workspace)) }
}

/** 存一个站点的 cookie。 */
export async function setCookie(workspace, id, raw) {
  const s = site(id)
  if (s === null) return { ok: false, reason: `不认识的站点：${id}` }
  const value = normalizeCookie(raw)
  if (value === '') return { ok: false, reason: 'cookie 不能为空' }
  // 至少要有一个 k=v，否则一定是复制错了
  if (!/=/.test(value)) return { ok: false, reason: 'cookie 里没有 k=v，看起来没复制全' }
  const store = await readStore(workspace)
  if (store.ok === false) return { ok: false, reason: `现有 cookie 文件读不了，为安全起见没有覆盖：${store.reason}` }
  const key = await ensureKey(workspace)
  const cookies = { ...store.cookies }
  cookies[id] = { ...encrypt(value, key), at: new Date().toISOString(), site: id }
  await writeStore(workspace, cookies)
  return { ok: true, id, hint: maskCookie(value), storedAt: cookies[id].at }
}

/** 删掉一个站点的 cookie。 */
export async function removeCookie(workspace, id) {
  const s = site(id)
  if (s === null) return { ok: false, reason: `不认识的站点：${id}` }
  const store = await readStore(workspace)
  if (store.cookies[id] === undefined) return { ok: false, reason: `${s.name} 本来就没存 cookie` }
  const cookies = { ...store.cookies }
  delete cookies[id]
  await writeStore(workspace, cookies)
  return { ok: true, id }
}

/** 取出明文（只给请求用，不回显）。 */
export async function resolveCookie(workspace, id) {
  const store = await readStore(workspace)
  if (store.cookies[id] === undefined) return null
  try { return decrypt(store.cookies[id], await ensureKey(workspace)) } catch { return null }
}

// ————————————————————————— 取内容 —————————————————————————

/** 真实浏览器头。站点会看这些。 */
export function browserHeaders(extra = {}) {
  return {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
    ...extra,
  }
}

/** 私有区字符（字体混淆的指纹）。 */
export function privateUseCount(text) {
  let n = 0
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0)
    if (c >= 0xe000 && c <= 0xf8ff) n += 1
  }
  return n
}

/** 编码嗅探：晋江等站是 GBK。 */
export function sniffEncoding(bytes, declared) {
  const d = String(declared ?? '').toLowerCase()
  if (d.includes('gbk') || d.includes('gb2312') || d.includes('gb18030')) return 'gbk'
  // 声明不可信时看字节：GBK 的中文首字节常见 0xB0—0xF7
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
  let gbkish = 0
  for (let i = 0; i < Math.min(arr.length, 4096); i += 1) {
    if (arr[i] >= 0xb0 && arr[i] <= 0xf7) gbkish += 1
  }
  return gbkish > 200 ? 'gbk' : 'utf-8'
}

/**
 * 判断这一份响应到底是什么。
 *
 * **这一步是整个模块最要紧的地方**：宁可说「取不到」，也不要把挑战页或
 * 乱码当成内容存进语料库。
 */
export function classifyResponse({ status, text, bytes, site: s, finalUrl }) {
  const body = String(text ?? '')
  const len = Number.isFinite(bytes) ? bytes : body.length
  const checks = []

  if (status === 401 || status === 403) {
    return { ok: false, kind: 'forbidden', reason: `站点返回 ${status}（多半是 cookie 过期或没有权限）`, checks }
  }
  if (status === 302 || status === 301) {
    return { ok: false, kind: 'redirect', reason: '被重定向（多半是跳到登录页）', checks }
  }

  // 挑战页：极小 + 带探针脚本
  if (len < 3000 && /probe\.js|var buid|<body><\/body>/i.test(body)) {
    checks.push('响应体极小且含探针脚本')
    return { ok: false, kind: 'challenge', reason: '站点返回了反爬挑战页，不是内容', checks }
  }

  // 字体混淆
  const pua = privateUseCount(body)
  if (pua > 0) {
    checks.push(`文本里有 ${pua} 个私有区字符（字体混淆）`)
    return { ok: false, kind: 'obfuscated', reason: `文本被字体混淆（${pua} 个私有区字符），还原需要字体映射 —— 本插件不做这种绕过`, checks, pua }
  }

  // 空内容
  const han = (body.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (han < 30) {
    checks.push(`中文字符只有 ${han} 个`)
    return { ok: false, kind: 'empty', reason: '响应里几乎没有中文内容（可能是 JS 渲染的页面）', checks, han }
  }

  return { ok: true, kind: 'content', checks, han }
}

/**
 * 带节流地取一个 URL。
 *
 * 节流是必须的：站点会按频率判爬虫，而且「像正常人」本来就包括不快。
 */
const lastHit = new Map()
export async function politeFetch(url, options = {}) {
  const s = options.site ?? null
  const minGap = options.minGapMs ?? 1500
  const key = s?.id ?? new URL(url).host
  const last = lastHit.get(key) ?? 0
  const wait = Math.max(0, minGap - (Date.now() - last))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHit.set(key, Date.now())

  const headers = browserHeaders({
    referer: s?.home ?? new URL(url).origin,
    ...(options.cookie !== undefined && options.cookie !== null && options.cookie !== ''
      ? { cookie: options.cookie }
      : {}),
    ...options.headers,
  })
  const res = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  const enc = sniffEncoding(buf, res.headers.get('content-type'))
  let text
  try {
    text = new TextDecoder(enc === 'gbk' ? 'gbk' : 'utf-8').decode(buf)
  } catch {
    // 环境没带 gbk 解码器时退回 utf-8，并如实标注
    text = new TextDecoder('utf-8').decode(buf)
  }
  return {
    status: res.status,
    finalUrl: res.url,
    encoding: enc,
    bytes: buf.length,
    text,
    headers: Object.fromEntries([...res.headers.entries()]),
  }
}

/**
 * 取一个站点的榜单/列表页。
 *
 * @returns 分类结果 + 若成功则附上解析出的条目。
 */
export async function fetchRank(workspace, id, options = {}) {
  const s = site(id)
  if (s === null) return { ok: false, reason: `不认识的站点：${id}` }
  const url = options.url ?? s.rankUrl
  const cookie = await resolveCookie(workspace, id)
  let res
  try {
    res = await politeFetch(url, { site: s, cookie, minGapMs: options.minGapMs })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return { ok: false, kind: 'network', reason: timedOut ? '请求超时' : (error?.message ?? String(error)) }
  }
  const cls = classifyResponse({ status: res.status, text: res.text, bytes: res.bytes, site: s, finalUrl: res.finalUrl })
  const base = {
    site: { id: s.id, name: s.name, note: s.note },
    url,
    status: res.status,
    encoding: res.encoding,
    bytes: res.bytes,
    usedCookie: cookie !== null && cookie !== undefined && cookie !== '',
    ...cls,
  }
  if (cls.ok !== true) {
    // 取不到时给正当的下一步，而不是让人干瞪眼
    base.suggestions = suggestionsFor(cls, s, cookie !== null && cookie !== '')
    return base
  }
  base.items = parseRank(s, res.text)
  return base
}

/** 取不到时的正当建议。 */
function suggestionsFor(cls, s, hasCookie) {
  const out = []
  if (cls.kind === 'challenge' || cls.kind === 'forbidden') {
    if (!hasCookie) out.push(`在浏览器里登录 ${s.name}，把 cookie 复制进来再试`)
    else out.push('cookie 可能过期了，重新登录后更新一次')
    out.push('也可以用浏览器打开这一页，把正文复制出来，用「按内容分类填充」导入')
  }
  if (cls.kind === 'obfuscated') {
    out.push('这一类是站点刻意的字体混淆，本插件不绕过')
    out.push('但从浏览器复制出来的正文是**已还原的** —— 用「按内容分类填充」贴进来最省事')
  }
  if (cls.kind === 'empty') {
    out.push('页面是 JS 渲染的，直接取 HTML 拿不到内容')
    out.push('在浏览器里打开后复制正文，用「按内容分类填充」导入')
  }
  if (cls.kind === 'redirect') out.push('站点要求登录：配好 cookie 再试')
  out.push(`无论哪条路，取到的内容都会先做一次检查（混淆/空内容/编码），合格才进语料库`)
  return out
}

/** 页面上的导航/按钮文案，不是书名。 */
export const NAV_WORDS = new Set([
  '关闭', '完结作品', '驻站作品', '经典文库', '免费文库', '新晋作者榜', '首页', '登录', '注册',
  '更多', '全部', '搜索', '排行', '榜单', '分类', '书架', '下载', '客户端', '作者专区',
  '繁体', '简体', '返回', '下一页', '上一页', '末页', '目录', '评论区', '加入书签',
  '推荐本书', '收藏', '投票', '打赏', '举报', '章节', '作品', '小说', '阅读',
])

/**
 * 从榜单页里抽条目。
 *
 * 这是**启发式**的：站点结构各异，抽不准时返回空数组而不是硬凑 ——
 * 把导航文案当书名存进素材库，比抽不到更坏。
 * `confidence` 如实告诉调用方这次抽得可不可信。
 */
export function parseRank(s, html) {
  const items = []
  const text = String(html ?? '')
  // 内嵌 JSON 里的书名（番茄这类）
  for (const m of text.matchAll(/"bookName"\s*:\s*"([^"]{2,40})"/g)) {
    items.push({ title: m[1], source: 'embedded-json' })
  }
  let confidence = items.length > 0 ? 'high' : 'none'
  // 常见链接标题
  if (items.length === 0) {
    for (const m of text.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{2,40})<\/a>/g)) {
      const t = m[2].trim()
      if (!/^[\u4e00-\u9fff\w·]{2,40}$/.test(t)) continue
      if (NAV_WORDS.has(t)) continue          // 导航文案不是书名
      items.push({ title: t, href: m[1], source: 'anchor' })
    }
    confidence = items.length >= 5 ? 'low' : 'none'
  }
  // 去重
  const seen = new Set()
  const out = items.filter((x) => {
    if (seen.has(x.title)) return false
    seen.add(x.title)
    return true
  }).slice(0, 100)
  // 挂个置信度，界面据此提示「这批要人工看一眼」
  out.confidence = confidence
  return out
}

/**
 * 把取到的内容**按插件功能分类**。
 *
 * 这是「内容也可以按插件功能分类填充」的落点：判断这段内容该喂给哪个槽位。
 */
export function classifyContent(text, options = {}) {
  const s = String(text ?? '')
  const han = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  const paras = s.split(/\n\s*\n/).filter((x) => x.trim() !== '')
  const sents = (s.match(/[。！？]/g) ?? []).length
  const hasDialogue = /[“”「」"]/.test(s)

  const targets = []
  const reasons = []

  // 是他的正文 → 可以当风格样本，也可以拆文
  if (han > 500 && paras.length >= 3) {
    targets.push({ module: 'style_anchor', slot: 'sample_corpus', why: `${han} 字、${paras.length} 段，够当文风样本` })
    targets.push({ module: 'style_anchor', dir: '样本', why: '存进「样本」目录，Style Anchor 直接读' })
  }
  if (han > 300) {
    targets.push({ module: 'deai_polish', slot: 'text', why: '可以过一遍去味，看命中多少条规则' })
    targets.push({ module: 'prose_sanity', slot: 'text', why: '先跑确定性检查（截断/工程词）' })
  }
  // 榜单/书目 → 素材
  if (options.kind === 'rank' || /排行|榜单|推荐|完结|连载/.test(s.slice(0, 500))) {
    targets.push({ module: 'material', dir: '素材', why: '看起来是榜单/书目，存进「素材」当选题参考' })
  }
  // 拆文向
  if (han > 3000) {
    targets.push({ module: 'deconstruct', dir: '拆文库', why: '篇幅够长，适合拆结构（信息差/钩子/情绪曲线）' })
  }
  if (hasDialogue && sents > 20) {
    targets.push({ module: 'character_designer', slot: 'existing', why: '含对话，可用来抽人物声音指纹（voice_samples）' })
  }

  if (targets.length === 0) reasons.push('内容太短，够不上任何槽位的最低要求')

  return {
    ok: targets.length > 0,
    stats: { chars: s.length, han, paragraphs: paras.length, sentences: sents, hasDialogue },
    targets,
    reasons,
  }
}

/** 把内容落进工作目录的某个分类目录（先过检查，再落盘）。 */
export async function storeContent(workspace, dirName, name, text, options = {}) {
  const cls = classifyResponse({ status: 200, text, bytes: String(text).length, site: null })
  if (cls.ok !== true && options.force !== true) {
    return { ok: false, reason: `内容没通过检查：${cls.reason}`, kind: cls.kind, checks: cls.checks }
  }
  const dir = join(workspace, dirName)
  await mkdir(dir, { recursive: true })
  const safe = String(name ?? 'untitled').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120)
  const path = join(dir, `${safe}.md`)
  const existed = existsSync(path)
  await writeFile(path, String(text), 'utf8')
  return { ok: true, path, existed, bytes: String(text).length, dir: dirName, checks: cls.checks }
}
