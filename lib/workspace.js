/**
 * dsh-writing-slots — 工作目录。
 *
 * 插件所有产出（风格锚点、世界观、人物卡、章节、拆文库、素材）都落在
 * **一个工作目录**里，而不是散在会话 cwd。这一层负责：
 *   1. 解析出当前工作目录（显式设置 → 配置文件 → 会话 cwd → 进程 cwd）
 *   2. 校验/初始化目录结构
 *   3. 给界面提供现状（有哪些子目录、各有多少文件、体积）
 *
 * ## 为什么要有这一层
 * 之前每个入口都各自拿 `projectDir ?? 会话 cwd`，结果同一台机器上换个会话
 * 就可能写到别的地方去。「后续内容都在工作内容区完成」要成立，得有一个
 * **唯一来源**，而不是每处各判断一次。
 *
 * @module dsh-writing-slots/workspace
 */
import { mkdir, readdir, rename, stat, unlink, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 工作目录默认落点（没配也没会话 cwd 时）。 */
export function defaultWorkspace() {
  const env = process.env.DSH_WRITING_WORKSPACE
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), 'dsh-writing')
}

/** 插件自己的工作目录配置文件名。 */
export const CONFIG_NAME = '.dsh-writing-slots.json'

/**
 * 标准目录结构。
 *
 * `kind` 说明这个目录装什么，界面据此显示；`samples: true` 的目录会被
 * Style Anchor 建议为样本来源。
 */
export const LAYOUT = [
  { name: '细纲', desc: '每章细纲（第NNNN章.md）' },
  { name: '章节', desc: '正文（先落 章节/草稿，润色后发布）' },
  { name: '卷纲', desc: '卷级大纲（卷NN.md）' },
  { name: '设定', desc: '世界观、人物卡、style-guide.md' },
  { name: '素材', desc: '榜单、灵感、参考资料' },
  { name: '拆文库', desc: '从站点或本地导入后拆解出的内容' },
  { name: '样本', samples: true, desc: 'Style Anchor 用的语料样本' },
  { name: '导出', desc: '交付产物' },
]

/** 展开 `~`，并转成绝对路径。 */
export function expandPath(p) {
  const s = String(p ?? '').trim()
  if (s === '') return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return isAbsolute(s) ? s : resolve(s)
}

/** 把绝对路径缩成 `~` 形式（给人看）。 */
export function displayPath(p) {
  const home = homedir()
  const s = String(p ?? '')
  if (s === home) return '~'
  return s.startsWith(`${home}/`) ? `~${s.slice(home.length)}` : s
}

/** 读工作目录配置文件；没有或坏掉都返回 null（不抛）。 */
async function readConfigFile(dir) {
  try {
    const text = await readFile(join(dir, CONFIG_NAME), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/**
 * 解析工作目录。
 *
 * 优先级：显式传入 → 环境变量 → 会话 cwd → 默认落点。
 *
 * @param options `{ explicit, sessionCwd }`。
 * @returns `{ dir, source }`，`source` 说明这个路径是哪来的（界面会显示）。
 */
export function resolveWorkspace(options = {}) {
  const explicit = expandPath(options.explicit)
  if (explicit !== '') return { dir: explicit, source: 'explicit' }

  const env = expandPath(process.env.DSH_WRITING_WORKSPACE)
  if (env !== '') return { dir: env, source: 'env' }

  const cwd = expandPath(options.sessionCwd)
  if (cwd !== '') return { dir: cwd, source: 'session-cwd' }

  return { dir: defaultWorkspace(), source: 'default' }
}

/**
 * 定位目录：如果给的是工作区根（里面还有 `novel/`），往下走一层。
 *
 * 兼容两类布局：
 *   - 工作目录本身就是项目根（有 细纲/ 或 章节/）
 *   - 工作目录是工作区，项目在 `novel/` 子目录
 */
export async function locateProject(dir) {
  const marks = ['细纲', '章节', 'chapters', '前情提要.md', '全书大纲.md']
  const has = (d) => marks.some((m) => existsSync(join(d, m)))
  if (has(dir)) return dir
  const novel = join(dir, 'novel')
  if (existsSync(novel) && has(novel)) return novel
  return dir
}

/** 现状：目录存在与否、各子目录的文件数与体积。 */
export async function status(dir) {
  const exists = existsSync(dir)
  const dirs = []
  for (const item of LAYOUT) {
    const p = join(dir, item.name)
    let files = 0
    let bytes = 0
    let present = false
    try {
      const st = await stat(p)
      present = st.isDirectory()
      if (present) {
        for (const n of await readdir(p)) {
          try {
            const s2 = await stat(join(p, n))
            if (s2.isFile()) { files += 1; bytes += s2.size }
          } catch { /* 跳过读不到的 */ }
        }
      }
    } catch { present = false }
    dirs.push({ name: item.name, desc: item.desc, samples: item.samples === true, present, files, bytes })
  }

  // 顶层关键文件
  const keyFiles = []
  for (const f of ['前情提要.md', '全书大纲.md', 'style-guide.md', 'world-bible.md', 'chapters']) {
    keyFiles.push({ name: f, present: existsSync(join(dir, f)) })
  }

  const config = await readConfigFile(dir)
  return { dir, display: displayPath(dir), exists, dirs, keyFiles, config }
}

/** 初始化目录结构（幂等；已存在的目录不动）。 */
export async function init(dir, options = {}) {
  const created = []
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o755 })
    created.push(dir)
  }
  const names = Array.isArray(options.only) && options.only.length > 0
    ? LAYOUT.filter((l) => options.only.includes(l.name))
    : LAYOUT
  for (const item of names) {
    const p = join(dir, item.name)
    if (!existsSync(p)) {
      await mkdir(p, { recursive: true, mode: 0o755 })
      created.push(item.name)
    }
  }
  // 章节下再分一个草稿目录：正文先落草稿，润色后再发布
  const draft = join(dir, '章节', '草稿')
  if (!existsSync(draft)) {
    await mkdir(draft, { recursive: true, mode: 0o755 })
    created.push('章节/草稿')
  }
  return { ok: true, dir, display: displayPath(dir), created }
}

/** 写工作目录配置（把「用哪个目录」记下来，下次不用再设）。 */
export async function saveConfig(dir, patch = {}) {
  const before = (await readConfigFile(dir)) ?? {}
  const next = { ...before, ...patch, updatedAt: new Date().toISOString() }
  await mkdir(dir, { recursive: true, mode: 0o755 })
  await writeFile(join(dir, CONFIG_NAME), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { ok: true, dir, config: next }
}

// ————————————————————————— 全局配置（记住用哪个工作目录） —————————————————————————

/**
 * 全局配置文件：**记在 DSH 主目录**，不在工作目录里。
 *
 * 这是关键：把「用哪个工作目录」写进工作目录自己，等于把钥匙锁在屋里 ——
 * 下次启动时你正是不知道屋在哪，才需要这份配置。
 */
export function globalConfigPath() {
  return join(dshHome(), 'dsh-writing-slots', 'workspace.json')
}

function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/** 读全局配置；没有或坏掉返回 null（不抛）。 */
export async function loadGlobal() {
  try {
    const parsed = JSON.parse(await readFile(globalConfigPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.workspace !== 'string' || parsed.workspace.trim() === '') return null
    return parsed
  } catch { return null }
}

/** 写全局配置（记忆用哪个工作目录）。 */
export async function saveGlobal(patch) {
  const dir = join(dshHome(), 'dsh-writing-slots')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let before = {}
  try { before = JSON.parse(await readFile(globalConfigPath(), 'utf8')) ?? {} } catch { before = {} }
  const next = { ...before, ...patch, updatedAt: new Date().toISOString() }
  const path = globalConfigPath()
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
  return { ok: true, path, config: next }
}

/** 校验已记住的工作目录还在不在（可能被删或挪走）。 */
export async function checkRemembered() {
  const cfg = await loadGlobal()
  if (cfg === null) return { ok: false, reason: '还没有记住过工作目录', workspace: null }
  const dir = expandPath(cfg.workspace)
  const v = await validate(dir)
  return { ok: v.ok, workspace: dir, savedAt: cfg.updatedAt ?? null, problems: v.problems }
}

/**
 * 盘点工作区里的素材，算出**每个槽位现在能不能跑**。
 *
 * 这是「产出怎么进到写作槽位」的接口：光把文件落进分类目录没用，
 * 槽位得知道自己手里有什么。
 */
export async function inventory(dir) {
  const readNames = async (d) => {
    try {
      const names = await readdir(join(dir, d))
      return names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b, 'zh'))
    } catch { return [] }
  }
  const samples = await readNames('样本')
  const briefsRaw = await readNames('细纲')
  const briefs = briefsRaw.filter((n) => /\.md$/i.test(n))
  const chapters = await readNames('章节')
  const drafts = await readNames(join('章节', '草稿')).catch(() => [])
  const decon = await readNames('拆文库')
  const material = await readNames('素材')
  const settings = await readNames('设定')

  const hasStyle = settings.includes('style-guide.md') || (await existsSync(join(dir, 'style-guide.md')))
  const hasWorld = settings.includes('world-bible.md') || (await existsSync(join(dir, 'world-bible.md')))
  const recap = existsSync(join(dir, '前情提要.md'))

  const firstNumber = (names) => {
    for (const n of names) {
      const m = /第?(\d{3,4})/.exec(n)
      if (m !== null) return Number(m[1])
    }
    return null
  }
  const lastNumber = (names) => {
    let best = null
    for (const n of names) {
      const m = /第?(\d{3,4})/.exec(n)
      if (m !== null) { const v = Number(m[1]); if (best === null || v > best) best = v }
    }
    return best
  }

  return {
    dir,
    // —— 每个槽位：手里有什么、缺什么、能不能跑 ——
    slots: [
      {
        id: 'style_anchor',
        have: samples.length,
        haveLabel: samples.length > 0 ? `样本目录里有 ${samples.length} 篇` : '样本目录是空的',
        ready: samples.length >= 1,
        need: '3—5 篇、合计 ≥5 万字',
        action: samples.length > 0 ? 'use-samples' : null,
        actionLabel: '用样本目录里的文件',
        files: samples,
        hint: hasStyle ? '已经跑过（设定/style-guide.md 在）' : null,
      },
      {
        id: 'world_builder',
        have: hasWorld ? 1 : 0,
        haveLabel: hasWorld ? 'world-bible.md 在' : '还没跑过',
        ready: true,
        need: '给个题材就行',
        hint: null,
      },
      {
        id: 'character_designer',
        have: 0,
        haveLabel: '按需生成',
        ready: true,
        need: '角色名',
        hint: hasWorld ? null : '建议先跑 World Builder',
      },
      {
        id: 'chapter_pack',
        have: briefs.length,
        haveLabel: briefs.length > 0 ? `细纲里有 ${briefs.length} 章` : '细纲目录是空的',
        ready: briefs.length > 0,
        need: '细纲要含「任务」与「钩子」',
        action: briefs.length > 0 ? 'use-briefs' : null,
        actionLabel: '从细纲挑一章',
        files: briefs,
        hint: recap ? null : '缺 前情提要.md（上一章摘要会取不到）',
      },
      {
        id: 'review_pass',
        have: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length,
        haveLabel: `${chapters.filter((n) => /\.(md|txt)$/i.test(n)).length} 章正文`,
        ready: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length > 0,
        need: '要有一章正文',
        hint: null,
      },
      {
        id: 'deai_polish',
        have: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length,
        haveLabel: `${chapters.filter((n) => /\.(md|txt)$/i.test(n)).length} 章正文`,
        ready: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length > 0,
        need: '要有一章正文',
        hint: null,
      },
      {
        id: 'reader_sim',
        have: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length,
        haveLabel: `${chapters.filter((n) => /\.(md|txt)$/i.test(n)).length} 章正文`,
        ready: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length > 0,
        need: '要读未修改的初稿',
        hint: null,
      },
    ],
    // —— 攒下来的素材（从阅读器/站点送进来的） ——
    material: {
      samples: { count: samples.length, files: samples.slice(0, 50) },
      deconstruct: { count: decon.length, files: decon.slice(0, 50) },
      material: { count: material.length, files: material.slice(0, 50) },
      briefs: { count: briefs.length, files: briefs.slice(0, 200), first: firstNumber(briefs), last: lastNumber(briefs) },
      chapters: { count: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length, files: chapters.slice(0, 50), first: firstNumber(chapters), last: lastNumber(chapters) },
      drafts: { count: drafts.length },
      settings: { count: settings.length, files: settings, hasStyle, hasWorld, recap },
    },
    // —— 「下一步做什么」：按现有素材推一条最该做的 ——
    next: nextStep({ samples: samples.length, briefs: briefs.length, chapters: chapters.filter((n) => /\.(md|txt)$/i.test(n)).length, hasStyle, hasWorld, decon: decon.length }),
  }
}

/** 按现有素材推一条最该做的下一步。 */
function nextStep(x) {
  if (x.samples > 0 && !x.hasStyle) {
    return { slot: 'style_anchor', text: `样本目录里有 ${x.samples} 篇 —— 先跑 Style Anchor，把文风基线定下来。`, action: 'use-samples' }
  }
  if (!x.hasWorld) return { slot: 'world_builder', text: '还没跑过世界观。跑一次 World Builder，力量体系记得写清代价与限制。' }
  if (x.samples === 0 && x.decon === 0) {
    return { slot: 'reader_sim', text: '工作区还是空的。到「阅读器」或「小说网站」弄点素材进来，或把已有的稿子放进 样本/。', action: null }
  }
  if (x.briefs > 0 && x.chapters === 0) {
    return { slot: 'chapter_pack', text: `细纲里有 ${x.briefs} 章，正文还没有 —— 从 Chapter Pack 开始写第一章。`, action: 'use-briefs' }
  }
  if (x.chapters > 0) {
    return { slot: 'deai_polish', text: `已经有 ${x.chapters} 章正文 —— 可以过 Review Pass 审稿，再走 De-AI Polish 去味。`, action: null }
  }
  return { slot: 'style_anchor', text: '先把样本放进 样本/ 目录，然后跑 Style Anchor。', action: null }
}

/** 检查一个路径能不能当工作目录（存在、是目录、可写）。 */
export async function validate(dir) {
  const problems = []
  const details = []
  let writable = false
  try {
    const st = await stat(dir)
    if (!st.isDirectory()) {
      problems.push('这个路径不是目录')
      details.push(`stat 说它不是目录：mode=${(st.mode & 0o777).toString(8)}`)
    } else {
      // 试写一个临时文件来判断可写，比看 mode 位可靠（ACL、只读挂载都算得出）
      const probe = join(dir, `.dsh-write-probe-${process.pid}`)
      try {
        await writeFile(probe, '', { flag: 'w' })
        writable = true
        await unlink(probe).catch(() => {})
      } catch (e) {
        // **把真实错误带出来** —— 第一版只写「不可写」，把 code 与路径全丢了，
        // 结果界面上看到「不可写」却不知道为什么（同用户同权限在 shell 里是可写的）。
        problems.push(`这个目录不可写：${e?.code ?? ''} ${e?.message ?? e}`.trim())
        details.push(`尝试写 ${probe} 失败，code=${e?.code ?? '(无)'}`)
        // 补一个「目录本身能不能读」的信息，帮助区分是权限还是挂载
        try {
          const names = await readdir(dir)
          details.push(`目录可读，有 ${names.length} 个条目`)
        } catch (e2) {
          details.push(`目录也读不了：${e2?.code ?? ''} ${e2?.message ?? e2}`)
        }
      }
    }
  } catch (e) {
    problems.push(`这个路径不存在或不可访问：${e?.code ?? ''} ${e?.message ?? e}`.trim())
    details.push(`stat 失败，code=${e?.code ?? '(无)'}`)
  }
  return { ok: problems.length === 0, dir, exists: existsSync(dir), writable, problems, details }
}
