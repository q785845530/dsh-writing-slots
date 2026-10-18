/**
 * dsh-writing-slots — 阅读器集成层。
 *
 * 把移植进来的 dsh-reader 宿主半（`lib/reader/` 下的 xpath/engine/bsdata/
 * downloads/localbooks）包成一组函数，接进本插件的路由，并**和写作流程打通**：
 *
 *   - 读到某一章 → 一键送进工作目录的「拆文库」
 *   - 整本 → 当 Style Anchor 的语料样本存进「样本」
 *   - 工作目录「章节/」里的稿子本身也能当本地书读
 *
 * ## 关于书源
 * 内置书源移植自 dsh-reader（其规则数据来自 binbyu/Reader 公开的 bs.json）。
 * 这些源大多指向第三方聚合站，**上游作者声明「注明出处、严禁非法与商业用途」**。
 * 本插件照原样保留以保功能完整，但：
 *   - 在界面与文档里明确标注来源与风险；
 *   - 不做任何反爬绕过（引擎就是普通的 node fetch + XPath）；
 *   - 书源随时可能失效，取不到时如实报错，不伪造内容。
 *
 * @module dsh-writing-slots/reader/service
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { DownloadManager } from './downloads.js'
import {
  searchBook, getChapters, getContent, BookSourceError, MAX_SEARCH_SOURCES, decodeBuffer,
} from './engine.js'
import { scanLocalBooks, readLocalBook, splitTxtChapters, localBooksDir } from './localbooks.js'
import { BUILTIN_SOURCES } from './bsdata.js'
import { classifyContent, privateUseCount } from '../sites.js'
import { defaultWorkspace } from '../workspace.js'

/** 书源的来源与风险说明。界面与工具都会带上。 */
export const SOURCE_NOTICE = {
  origin: '移植自 dsh-reader（Apache-2.0）；规则数据来自 binbyu/Reader 公开的 bs.json',
  upstream: 'https://github.com/Wodexinhaoleng-Kasssa/dsh-reader',
  warning: '内置书源多为第三方聚合站，上游作者声明「注明出处、严禁非法与商业用途」。'
    + '书源随时可能失效；下载内容仅限个人学习使用，请尊重各站版权。',
}

/** 单次搜索总超时。 */
const SEARCH_TIMEOUT_MS = 20000

/** 并发搜索多个书源（限制并发，避免触发限流）。 */
export async function searchAll(keyword, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, BUILTIN_SOURCES.length)) : MAX_SEARCH_SOURCES
  const only = Array.isArray(options.sources) && options.sources.length > 0 ? new Set(options.sources) : null
  const pool = BUILTIN_SOURCES.filter((s) => only === null || only.has(s.title)).slice(0, limit)
  const results = []
  const errors = []
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= pool.length) return
      const source = pool[index]
      try {
        const items = await searchBook(source, keyword)
        for (const item of items) {
          results.push({ source: source.title, title: item.title, url: item.url, author: item.author })
        }
      } catch (error) {
        errors.push({ source: source.title, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), SEARCH_TIMEOUT_MS) })
  await Promise.race([Promise.all([worker(), worker(), worker(), worker()]), timeout])
  if (timer !== null) clearTimeout(timer)
  return { results, errors, searched: pool.length, timedOut: results.length === 0 && errors.length < pool.length }
}

/** 书源清单（给界面用，附风险标注）。 */
export function listSources() {
  return BUILTIN_SOURCES.map((s) => {
    let host = s.host ?? ''
    if (host === '' && typeof s.query_url === 'string') {
      try { host = new URL(s.query_url).host } catch { host = '' }
    }
    return {
      title: s.title,
      host,
      query_url: s.query_url,
      charset: s.query_charset ?? 0,
      json: String(s.book_name_xpath ?? '').startsWith('/data'),
      // 域名能一眼看出是不是正规平台；界面据此提示
      official: /jjwxc\.net|qidian\.com|fanqienovel\.com|qimao\.com|zongheng\.com|17k\.com/.test(host),
    }
  })
}

/** 按标题找书源。 */
export function findSource(title) {
  return BUILTIN_SOURCES.find((s) => s.title === title) ?? null
}

/** 取章节列表。 */
export async function chapters(sourceTitle, url) {
  const source = findSource(sourceTitle)
  if (source === null) throw new BookSourceError(`没有这个书源：${sourceTitle}`)
  return getChapters(source, url)
}

/** 取单章正文。 */
export async function content(sourceTitle, url) {
  const source = findSource(sourceTitle)
  if (source === null) throw new BookSourceError(`没有这个书源：${sourceTitle}`)
  return getContent(source, url)
}

/** 下载任务管理器。 */
export const downloads = new DownloadManager()

/**
 * 扫描本地书。
 *
 * 两个来源合在一起：
 *   - 工作目录的「本地书/」（默认落点，符合「内容都在工作区」）
 *   - 工作目录的「章节/」—— 你自己写的稿子也能当书读
 */
export async function scanBooks(workspace, customDir) {
  const dir = localBooksDir(customDir ?? join(workspace ?? defaultWorkspace(), '本地书'))
  const scan = await scanLocalBooks(dir)
  const books = scan.books.map((b) => ({ ...b, origin: 'local' }))

  // 自己写的章节也列出来（只列元信息，正文按需读）
  const mine = []
  const chaptersDir = join(workspace ?? defaultWorkspace(), '章节')
  if (existsSync(chaptersDir)) {
    try {
      const { readdir, stat } = await import('node:fs/promises')
      for (const name of await readdir(chaptersDir)) {
        if (!/\.(md|txt)$/i.test(name)) continue
        const full = join(chaptersDir, name)
        const st = await stat(full)
        if (st.isFile()) mine.push({ name, path: full, size: st.size, mtime: st.mtimeMs, origin: 'workspace' })
      }
    } catch { /* 读不到就不列 */ }
  }
  mine.sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  return { dir: scan.dir, books: [...books, ...mine], counts: { local: books.length, workspace: mine.length } }
}

/** 读一本本地书并拆章。 */
export async function readBook(filePath) {
  const { text, size } = await readLocalBook(filePath, decodeBuffer)
  const chapters = splitTxtChapters(text)
  return { size, chapterCount: chapters.length, chapters, text }
}

/**
 * 把内容送进工作目录。
 *
 * 这是「和写作流程打通」的落点：读到的东西直接变成写作素材。
 *
 * @param kind `deconstruct`（拆文库）| `sample`（样本）| `material`（素材）。
 */
export async function sendToWorkspace(workspace, { kind, name, text, chapterIndex }) {
  const targets = {
    deconstruct: { dir: '拆文库', why: '送进拆文库，用来拆结构（信息差/钩子/情绪曲线）' },
    sample: { dir: '样本', why: '送进样本目录，Style Anchor 会读它来统计文风' },
    material: { dir: '素材', why: '送进素材目录，当选题或灵感参考' },
  }
  const t = targets[kind]
  if (t === undefined) return { ok: false, reason: `不认识的去向：${kind}（可选 ${Object.keys(targets).join(' / ')}）` }

  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, reason: '内容为空' }

  // 落进语料库前先过检查 —— 混淆/空内容会把统计搞坏，而且看不出来
  const pua = privateUseCount(body)
  if (pua > 0) {
    return { ok: false, kind: 'obfuscated', reason: `内容里有 ${pua} 个私有区字符（字体混淆），不适合进语料库` }
  }
  const han = (body.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (han < 50) return { ok: false, kind: 'too-short', reason: `中文只有 ${han} 字，太少，进语料库会污染统计` }

  const base = String(name ?? '导入').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 100)
  const suffix = Number.isFinite(chapterIndex) ? `-第${String(chapterIndex + 1).padStart(4, '0')}章` : ''
  const dir = join(workspace ?? defaultWorkspace(), t.dir)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${base}${suffix}.md`)
  const existed = existsSync(path)
  await writeFile(path, body, 'utf8')

  const cls = classifyContent(body)
  return {
    ok: true, path, dir: t.dir, why: t.why, existed,
    chars: body.length, han,
    // 顺手告诉调用方这段内容还能喂给哪些槽位
    alsoUseful: cls.targets.filter((x) => x.dir !== t.dir).map((x) => `${x.module}${x.slot ? ' → ' + x.slot : ''}：${x.why}`),
  }
}

export { basename }
