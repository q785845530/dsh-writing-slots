#!/usr/bin/env node
/**
 * 跑全部套件。
 *
 *   node verify-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  ['verify.mjs', '宿主半（槽位契约、统计、审稿隔离、去味、故事引擎、读者、确定性检查）'],
  ['verify-continue.mjs', '自动续跑（规则表、退避、换模型、压缩、去抖、上限）'],
  ['verify-sites.mjs', '工作目录与小说网站（cookie 加密、反爬识别、内容分类）'],
  ['verify-library.mjs', '指令库（条目判据、落盘、导入解析、勾选组合、顺序）'],
  ['verify-reader.mjs', '阅读器（书源数据、XPath/JSON 规则、编码、拆章、送进工作目录）'],
  ['verify-client.mjs', '浏览器半（渲染、七个槽位、页签随开关显隐）'],
]

let failed = 0
for (const [file, label] of SUITES) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' })
  const ms = Date.now() - started
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const line = (out.match(/(?:结果：)?(\d+) passed(?:,| \/)? ?(\d+)? failed/) ?? [])[0]
    ?? (out.match(/(\d+) passed, (\d+) failed/) ?? [])[0]
    ?? '(未取到结果)'
  if (r.status !== 0) failed += 1
  console.log(`${r.status === 0 ? '✓' : '✗'} ${file.padEnd(20)} ${label}`)
  console.log(`  ${line.trim()}  (${ms}ms)`)
}

console.log(failed === 0 ? '\n✅ 全部套件通过' : `\n❌ ${failed} 个套件失败`)
process.exit(failed === 0 ? 0 : 1)
