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
import { mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises'
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

/** 检查一个路径能不能当工作目录（存在、是目录、可写）。 */
export async function validate(dir) {
  const problems = []
  let writable = false
  try {
    const st = await stat(dir)
    if (!st.isDirectory()) problems.push('这个路径不是目录')
    else {
      // 试写一个临时文件来判断可写，比看 mode 位可靠（ACL、只读挂载都算得出）
      const probe = join(dir, `.dsh-write-probe-${process.pid}`)
      try { await writeFile(probe, '', { flag: 'w' }); writable = true; await (await import('node:fs/promises')).unlink(probe) }
      catch { problems.push('这个目录不可写') }
    }
  } catch {
    problems.push('这个路径不存在')
  }
  return { ok: problems.length === 0, dir, exists: existsSync(dir), writable, problems }
}
