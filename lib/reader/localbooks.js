/**
 * 本文件移植自 dsh-reader（Apache-2.0）。
 *   来源：https://github.com/Wodexinhaoleng-Kasssa/dsh-reader
 *   文件：lib/localbooks.js
 *   上游说明：书源规则数据来自 binbyu/Reader 公开的 bs.json / .bs_bak.json；
 *             原作者声明「注明出处、严禁非法与商业用途」。
 * 本插件仅将其作为阅读功能的一部分移植，未改动规则语义。
 */
import { readdir, readFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

/** 默认本地书库目录。 */
/**
 * 本地书库目录。
 *
 * 移植时改了一处：默认落点从 `~/dsh-reader-books` 换成写作工作目录下的
 * `本地书/`，这样「后续内容都在工作内容区完成」对阅读器也成立。
 * 传 customDir 仍然优先。
 */
export function localBooksDir(customDir) {
  if (customDir !== undefined && String(customDir).trim() !== '') return String(customDir).trim()
  return join(homedir(), 'dsh-writing', '本地书')
}

/** 扫描目录下的 .txt 文件（支持子目录，返回 {name, path, size, mtime}）。 */
export async function scanLocalBooks(customDir) {
  const dir = localBooksDir(customDir)
  await mkdir(dir, { recursive: true })
  const out = []
  const walk = async (current, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile() && /\.(txt|text)$/i.test(entry.name)) {
        try {
          const info = await stat(full)
          out.push({ name: basename(full), path: full, size: info.size, mtime: info.mtimeMs })
        } catch { /* 忽略 */ }
      }
    }
  }
  await walk(dir, 0)
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { dir, books: out }
}

/** 读取本地 TXT，返回解码后的文本（编码自动识别，复用 engine.decodeBuffer）。 */
export async function readLocalBook(filePath, decodeBuffer) {
  const buf = await readFile(filePath)
  const text = decodeBuffer(buf, 0)
  return { text, size: buf.length }
}

/** 把纯文本按章节标题拆分成 chapters：[{title, text}]。 */
export function splitTxtChapters(text) {
  const lines = text.split(/\r?\n/)
  const chapters = []
  let currentTitle = '正文'
  let currentLines = []
  const chapterRe = /^\s*(?:第[0-9零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億]+[章卷回节集部篇]|序章|楔子|番外|尾声|后记|Chapter\s*\d+)\s*[:：.、\s]*(.*)$/
  for (const line of lines) {
    const trimmed = line.trim()
    if (chapterRe.test(trimmed)) {
      if (currentLines.length > 0 || chapters.length > 0) {
        chapters.push({ title: currentTitle, text: currentLines.join('\n') })
      }
      currentTitle = trimmed
      currentLines = []
    } else {
      if (trimmed !== '' || currentLines.length > 0) currentLines.push(line)
    }
  }
  if (currentLines.length > 0 || chapters.length === 0) {
    chapters.push({ title: currentTitle, text: currentLines.join('\n') })
  }
  // 空章节过滤
  return chapters.filter((c) => c.text.trim() !== '' || chapters.length === 1)
}
