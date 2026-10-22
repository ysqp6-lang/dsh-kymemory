#!/usr/bin/env node
/**
 * 一键自检：把「能不能安全交付」这件事自动化。
 *
 *   node scripts/selftest.mjs          跑全部检查
 *   node scripts/selftest.mjs --quick  跳过真实的会话捕获（更快）
 *
 * 退出码 0 表示全部通过，1 表示有失败项。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE = process.execPath
const QUICK = process.argv.includes('--quick')

const results = []
function check(name, fn) {
  const started = Date.now()
  try {
    const detail = fn()
    results.push({ name, ok: true, detail, ms: Date.now() - started })
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error), ms: Date.now() - started })
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const libFiles = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))

// ── 1. 语法 ────────────────────────────────────────────────────────────
check('语法检查', () => {
  for (const file of libFiles) {
    execFileSync(NODE, ['--check', join(ROOT, 'lib', file)], { stdio: 'pipe' })
  }
  return `${libFiles.length} 个源文件通过`
})

// ── 2. 单元与集成测试 ──────────────────────────────────────────────────
check('测试套件', () => {
  const testFiles = readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => join(ROOT, 'test', f))
  const out = execFileSync(NODE, ['--test', ...testFiles], { stdio: 'pipe', encoding: 'utf8' })
  const pass = Number(out.match(/^ℹ pass (\d+)$/m)?.[1] ?? -1)
  const fail = Number(out.match(/^ℹ fail (\d+)$/m)?.[1] ?? -1)
  if (fail !== 0 || pass <= 0) throw new Error(`pass=${pass} fail=${fail}`)
  return `${pass} 个测试通过`
})

// ── 3. 零外部依赖 ──────────────────────────────────────────────────────
check('零外部依赖', () => {
  const externals = new Set()
  for (const file of libFiles) {
    const text = readFileSync(join(ROOT, 'lib', file), 'utf8')
    for (const m of text.matchAll(/from '([^']+)'/g)) {
      const spec = m[1]
      if (spec.startsWith('./') || spec.startsWith('node:')) continue
      externals.add(spec)
    }
  }
  if (externals.size > 0) throw new Error(`发现外部依赖：${[...externals].join(', ')}`)
  return '仅使用 node: 内置模块与相对路径'
})

// ── 4. 发布内容 ────────────────────────────────────────────────────────
check('发布内容完整', () => {
  const required = ['package.json', 'LICENSE', 'README.md', ...(pkg.files ?? [])]
  const missing = []
  for (const item of required) {
    if (item === 'lib') continue // 目录，单独检查
    if (!existsSync(join(ROOT, item))) missing.push(item)
  }
  if (!existsSync(join(ROOT, 'lib'))) missing.push('lib/')
  if (missing.length) throw new Error(`缺失：${missing.join(', ')}`)
  return `${pkg.name}@${pkg.version} 打包所需文件齐全`
})

// ── 6. 捕获链路（真实会话）─────────────────────────────────────────────
let captureDetail = '（跳过）'
if (!QUICK) {
  check('捕获链路', () => {
    const sessionsRoot = join(homedir(), '.dsh', 'sessions')
    if (!existsSync(sessionsRoot)) return '没有会话存档，跳过'
    const candidates = []
    for (const ws of readdirSync(sessionsRoot)) {
      const wsPath = join(sessionsRoot, ws)
      try {
        if (!statSync(wsPath).isDirectory()) continue
      } catch {
        continue
      }
      for (const dir of readdirSync(wsPath)) {
        if (!dir.startsWith('session-')) continue
        const file = join(wsPath, dir, 'session.v4.jsonl.zstd')
        try {
          const size = statSync(file).size
          if (size > 200_000) candidates.push([file, size, dir])
        } catch {
          /* 跳过 */
        }
      }
    }
    if (candidates.length === 0) return '没有足够大的会话可测，跳过'
    candidates.sort((a, b) => b[1] - a[1])
    const [, size, dir] = candidates[0]
    const started = process.hrtime.bigint()
    const script = `
      import { captureSession } from ${JSON.stringify(join(ROOT, 'lib', 'capture.js'))}
      const r = captureSession({ sessionId: ${JSON.stringify(dir)}, minMessages: 1, sessionsRoot: ${JSON.stringify(sessionsRoot)} })
      console.log(JSON.stringify(r.skipped ? { skipped: r.skipped } : { messages: r.messageCount, bytes: r.body.length }))
    `
    const out = execFileSync(NODE, ['--input-type=module', '-e', script], { stdio: 'pipe', encoding: 'utf8' })
    const parsed = JSON.parse(out.trim().split('\n').at(-1))
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    if (parsed.skipped) return `最大会话 ${(size / 1024).toFixed(0)} KB → 跳过（${parsed.skipped}）`
    captureDetail = `${(size / 1024).toFixed(0)} KB 会话 → ${parsed.messages} 条消息 / ${parsed.bytes} 字，${ms.toFixed(0)} ms`
    return captureDetail
  })
}

// ── 7. 索引渲染性能 ────────────────────────────────────────────────────
let perfDetail = '（跳过）'
check('注入性能', () => {
  const script = `
    import { createStore } from ${JSON.stringify(join(ROOT, 'lib', 'store.js'))}
    const store = createStore({})
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 200; i++) store.renderIndex()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const stats = store.stats()
    console.log(JSON.stringify({ per: ms / 200, entries: stats.route.entries, groups: stats.route.groups }))
  `
  const out = execFileSync(NODE, ['--input-type=module', '-e', script], { stdio: 'pipe', encoding: 'utf8' })
  const { per, entries, groups } = JSON.parse(out.trim().split('\n').at(-1))
  perfDetail = `单次 ${per.toFixed(3)} ms | 路由 ${entries} 条 / ${groups} 组`
  if (per > 5) throw new Error(`单次渲染 ${per.toFixed(2)} ms 过慢`)
  return perfDetail
})

// ── 输出 ───────────────────────────────────────────────────────────────
console.log(`\n  ${pkg.name}@${pkg.version} 自检\n`)
let failed = 0
for (const item of results) {
  const mark = item.ok ? '✔' : '✖'
  if (!item.ok) failed += 1
  console.log(`  ${mark} ${item.name.padEnd(12, '　')} ${item.detail}  \x1b[2m(${item.ms} ms)\x1b[0m`)
}

console.log('')
if (failed > 0) {
  console.log(`  ${failed} 项失败\n`)
  process.exit(1)
}
console.log('  全部通过\n')
