/**
 * dsh-writing-slots — 项目状态。
 *
 * 把项目里已有的文件解析成**槽位数据**，这样 Author 不用手打八个字段：
 *   - `细纲/第NNNN章.md`  → chapter_task（事件/爽点/钩子/不得违反）
 *   - `前情提要.md`        → prev_recap（上一章那条，约 200 字）
 *   - `全书大纲.md` + `卷纲/卷NN.md` → bible_slice 的骨架
 *
 * 解析策略是**尽力而为 + 认不出就说认不出**：这些文件是人写的 markdown，
 * 格式会漂。所以每一项都返回 `null` 而不是猜一个空字符串 —— 猜出来的
 * 槽位会被当成真值填进提示词，比缺一个槽位更糟。
 *
 * @module dsh-writing-slots/project
 */
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

/** 章号 → 四位数（`25` → `0025`）。 */
export function padChapter(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return null
  return String(Math.floor(num)).padStart(4, '0')
}

/** 从文件名里取章号：`第0025章-私仓.md` → `0025`。 */
export function chapterNoFromName(name) {
  const m = /第(\d{1,6})章/.exec(String(name ?? ''))
  return m === null ? null : m[1].padStart(4, '0')
}

// ————————————————————————— 细纲 —————————————————————————

/**
 * 解析细纲。
 *
 * 认这种行：`- **时间**：...`、`- **爽点（70% 处）**：...`
 * 括注会被剥掉，`**` 也会剥掉。
 */
export function parseBrief(text) {
  const s = String(text ?? '')
  const title = (/^#\s*(.+)$/m.exec(s) ?? [null, null])[1]
  const fields = {}
  const re = /^[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*([\s\S]*?)(?=\n[-*]\s*\*\*|\n#{1,6}\s|\s*$)/gm
  let m
  while ((m = re.exec(s)) !== null) {
    // 去掉括注：`爽点（70% 处）` → `爽点`
    const key = m[1].replace(/[（(][^）)]*[）)]/g, '').trim()
    fields[key] = m[2].trim().replace(/\s*\n\s*/g, ' ')
  }
  return {
    title: title === null ? null : title.trim(),
    time: fields['时间'] ?? null,
    task: fields['任务'] ?? null,
    effect: fields['爽点'] ?? null,
    hook: fields['钩子'] ?? null,
    foreshadow: fields['伏笔'] ?? null,
    forbidden: fields['不得违反'] ?? null,
    raw_fields: Object.keys(fields),
  }
}

/** 列表化：把「；」或「。」分隔的一条条拆开（不得违反常用 `；`）。 */
export function splitList(text) {
  if (text === null || text === undefined || String(text).trim() === '') return []
  return String(text)
    .split(/[；;]\s*/)
    .map((x) => x.trim().replace(/^[、，,]\s*/, ''))
    .filter((x) => x !== '')
}

// ————————————————————————— 前情提要 —————————————————————————

/**
 * 解析前情提要的全部条目。
 *
 * 认这种标题：`## 0025《章名》（时间）`。
 * 条目正文到下一个 `## ` 或文件末尾为止。
 */
export function parseRecaps(text) {
  const s = String(text ?? '')
  const out = []
  const re = /^##\s*(\d{1,6})\s*[《<]?(.*?)[》>]?\s*(?:[（(]([^）)]*)[）)]\s*)?$/gm
  const marks = []
  let m
  while ((m = re.exec(s)) !== null) {
    marks.push({ no: m[1].padStart(4, '0'), title: (m[2] ?? '').trim(), time: m[3] ?? null, at: m.index })
  }
  for (let i = 0; i < marks.length; i += 1) {
    const cur = marks[i]
    const end = i + 1 < marks.length ? marks[i + 1].at : s.length
    const body = s.slice(cur.at, end).replace(/^##.*$/m, '').trim()
    const hook = (/\*\*章末钩\*\*\s*[:：]\s*([\s\S]*?)(?=\n\*\*|\s*$)/.exec(body) ?? [null, null])[1]
    const terms = (/\*\*新术语\*\*\s*[:：]\s*([\s\S]*?)(?=\n\*\*|\s*$)/.exec(body) ?? [null, null])[1]
    out.push({
      no: cur.no,
      title: cur.title,
      time: cur.time,
      body,
      // 章末钩单独取出来：它是 Chapter Pack 的 stop_at 依据。
      hook: hook === null ? null : hook.trim(),
      terms: terms === null ? null : terms.trim(),
    })
  }
  return out
}

/**
 * 取「目标章号的上一章」那条提要。
 *
 * 不是取文件里最后一条 —— 补齐旧章或跳章写的时候，最后一条并不对应
 * 目标章的前一章。按章号找才对。
 */
export function recapBefore(recaps, chapterNo) {
  const target = padChapter(chapterNo)
  if (target === null) return null
  let best = null
  for (const r of recaps ?? []) {
    if (r.no < target && (best === null || r.no > best.no)) best = r
  }
  return best
}

/** 文件里最后一条提要。 */
export function lastRecap(recaps) {
  const list = recaps ?? []
  return list.length === 0 ? null : list[list.length - 1]
}

/** 最后一条「待续写」指向的章号。 */
export function pendingChapter(text) {
  const all = [...String(text ?? '').matchAll(/\*\*待续写\*\*\s*[:：]\s*(\d{1,6})/g)]
  return all.length === 0 ? null : all[all.length - 1][1].padStart(4, '0')
}

// ————————————————————————— 项目 —————————————————————————

/**
 * 定位项目目录。
 *
 * 优先找含 `细纲/` 或 `前情提要.md` 的目录；找不到就返回给的路径本身
 * （让人自己指定，而不是猜一个不存在的结构）。
 */
export async function resolveProject(dir) {
  const candidates = [
    dir,
    join(dir, 'novel'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, '前情提要.md')) || existsSync(join(c, '细纲'))) {
      return c
    }
  }
  return dir
}

/** 读一个文件；读不到返回 null（不抛）。 */
async function readOrNull(path) {
  try { return await readFile(path, 'utf8') } catch { return null }
}

/**
 * 汇总项目状态。
 *
 * @param dir 项目目录（或工作区目录，会自动往下找 novel/）。
 * @param chapterNo 目标章号（可选）。
 */
export async function inspect(dir, chapterNo = null) {
  const root = await resolveProject(dir)
  const recapText = await readOrNull(join(root, '前情提要.md'))
  const recaps = recapText === null ? [] : parseRecaps(recapText)

  const outline = await readOrNull(join(root, '全书大纲.md'))
  const briefsDir = join(root, '细纲')
  let briefNames = []
  try { briefNames = (await readdir(briefsDir)).filter((n) => n.endsWith('.md')) } catch { briefNames = [] }

  let chaptersDir = join(root, 'chapters')
  let chapterNames = []
  try { chapterNames = (await readdir(chaptersDir)).filter((n) => n.endsWith('.md')) } catch {
    chaptersDir = join(root, '章节')
    try { chapterNames = (await readdir(chaptersDir)).filter((n) => n.endsWith('.md')) } catch { chapterNames = [] }
  }

  const target = chapterNo === null ? null : padChapter(chapterNo)
  let brief = null
  let briefPath = null
  if (target !== null) {
    for (const n of briefNames) {
      if (chapterNoFromName(n) === target) { briefPath = join(briefsDir, n); break }
    }
    // 文件名对不上时退回按内容找（细纲标题里也写着章号）
    if (briefPath === null) {
      for (const n of briefNames.slice(0, 400)) {
        const t = await readOrNull(join(briefsDir, n))
        if (t !== null && new RegExp(`第\\s*0*${Number(target)}\\s*章`).test(t.slice(0, 200))) {
          briefPath = join(briefsDir, n); break
        }
      }
    }
    if (briefPath !== null) brief = parseBrief(await readOrNull(briefPath) ?? '')
  }

  const prev = target === null ? lastRecap(recaps) : recapBefore(recaps, target)

  return {
    root,
    // 结构是否像这个项目的布局
    layout: {
      recap: recapText !== null,
      outline: outline !== null,
      briefs: briefNames.length,
      chapters: chapterNames.length,
      chaptersDir,
    },
    recapText,
    recaps,
    pending: recapText === null ? null : pendingChapter(recapText),
    outline,
    target,
    brief,
    briefPath,
    prev,
  }
}

/**
 * 组装 Chapter Pack 的 chapter_task 槽位。
 *
 * 从细纲的四个字段映射到契约里的四个字段。**缺哪个就报哪个**，
 * 不拿别的字段顶替 —— `不得违反` 不是 `stop_at`。
 */
export function chapterTaskFrom(brief) {
  if (brief === null) return { ok: false, missing: ['细纲（未找到本章细纲文件）'] }
  const missing = []
  if (brief.task === null) missing.push('任务（event）')
  if (brief.hook === null) missing.push('钩子（stop_at）')
  return {
    ok: missing.length === 0,
    missing,
    task: {
      event: brief.task ?? null,
      cast: [],                       // 细纲里没有出场人物清单，由 Author 填
      desired_effect: brief.effect ?? null,
      stop_at: brief.hook ?? null,
    },
  }
}

/**
 * 组装 bible_slice：只注入**本章要用到的**那部分。
 *
 * 要求写的是「只注入本章涉及的角色当前状态 + 世界观规则」。所以这里
 * 不做全量注入 —— 给出的是上一章提要 + 本卷纲 + 细纲里的时间与伏笔。
 * 全量注入会把上下文撑爆，而且会稀释真正相关的信息。
 */
export function bibleSliceFrom(state, options = {}) {
  const parts = []
  if (state.brief?.time !== null && state.brief?.time !== undefined) {
    parts.push(`本章时间：${state.brief.time}`)
  }
  if (state.brief?.foreshadow !== null && state.brief?.foreshadow !== undefined) {
    parts.push(`本章伏笔：${state.brief.foreshadow}`)
  }
  // 这里**不放上一章提要** —— 那是 prev_recap 槽位的职责。
  // 放两份会把同一段上下文算两遍，既浪费窗口，又让模型以为读到了两份材料。
  if (options.characters !== undefined && options.characters !== null && String(options.characters).trim() !== '') {
    parts.push(`相关角色当前状态：\n${String(options.characters).slice(0, options.characterChars ?? 600)}`)
  }
  if (options.volumeText !== undefined && options.volumeText !== null) {
    parts.push(`本卷纲：\n${String(options.volumeText).slice(0, options.volumeChars ?? 800)}`)
  }
  return parts.length === 0 ? '（本章没有额外的设定需要注入）' : parts.join('\n\n')
}

/**
 * 追加一条前情提要。
 *
 * 发布后才写；先备份原文件 —— 这份文件是「续写只读最后一条」的唯一依据，
 * 写坏了后面全乱。
 */
export async function appendRecap(dir, entry) {
  const root = await resolveProject(dir)
  const path = join(root, '前情提要.md')
  const before = await readOrNull(path)
  if (before === null) return { ok: false, reason: `找不到 ${path}` }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${path}.bak-${stamp}`
  await copyFile(path, backupPath)
  const block = `\n${entry}\n`
  await writeFile(path, before.replace(/\s*$/, '') + block, 'utf8')
  return { ok: true, path, backup: backupPath, added: block.trim().length }
}

/**
 * 落一章正文。
 *
 * 先落草稿再落正式稿：要求里写「先落草稿，润色后发布」。所以这一步
 * 默认写 `chapters/草稿/第NNNN章.draft.md`，`publish: true` 才写正式文件。
 */
export async function saveChapter(dir, chapterNo, title, text, options = {}) {
  const root = await resolveProject(dir)
  const no = padChapter(chapterNo)
  if (no === null) return { ok: false, reason: '章号不合法' }
  const safeTitle = String(title ?? '').replace(/[\/\\:*?"<>|]/g, '').trim()
  const name = safeTitle === '' ? `第${no}章.md` : `第${no}章-${safeTitle}.md`
  const targetDir = options.publish === true
    ? join(root, 'chapters')
    : join(root, 'chapters', '草稿')
  await mkdir(targetDir, { recursive: true })
  const path = join(targetDir, name)
  const existed = existsSync(path)
  // 覆盖前备份：正文是唯一不能重来的东西。
  let backup = null
  if (existed) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(path, backup)
  }
  await writeFile(path, String(text ?? ''), 'utf8')
  return { ok: true, path, published: options.publish === true, existed, backup, name }
}

/** 找一章正文（草稿与正式稿都找）。 */
export async function findChapter(dir, chapterNo) {
  const root = await resolveProject(dir)
  const no = padChapter(chapterNo)
  if (no === null) return null
  for (const sub of ['chapters', 'chapters/草稿', '章节', '草稿']) {
    const d = join(root, sub)
    if (!existsSync(d)) continue
    let names = []
    try { names = await readdir(d) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.md')) continue
      if (chapterNoFromName(n) !== no) continue
      const path = join(d, n)
      const text = await readOrNull(path)
      if (text !== null) return { path, name: n, text, draft: sub.includes('草稿') }
    }
  }
  return null
}
