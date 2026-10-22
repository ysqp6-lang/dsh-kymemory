import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'

function makeMemory({ index, route, evidence = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-doctor-'))
  mkdirSync(join(root, 'summaries'), { recursive: true })
  writeFileSync(join(root, 'memory_summary.md'), index, 'utf8')
  writeFileSync(join(root, 'MEMORY.md'), route, 'utf8')
  for (const [name, body] of Object.entries(evidence)) {
    writeFileSync(join(root, 'summaries', name), body, 'utf8')
  }
  return root
}

const CLEAN_INDEX = [
  '# 索引',
  '',
  "## What's in Memory",
  '',
  '- 环境 → `#env`',
  '- 坑 → `#pitfalls`',
  '',
].join('\n')

const CLEAN_ROUTE = [
  '# MEMORY',
  '',
  '## env',
  '',
  '- 2026-10-01 alpha 上线',
  '- 2026-10-02 beta 回滚',
  '',
  '## pitfalls',
  '',
  '- 2026-10-03 sqlite3 直接打不开，见 `summaries/sqlite.md`',
  '',
  '### Older Memory Topics',
  '',
  '（暂无）',
  '',
].join('\n')

const EVIDENCE = { 'sqlite.md': '# 证据\n\n- 复现：unable to open database file\n' }

function check(memory, config = {}) {
  const root = makeMemory(memory)
  try {
    return createStore({ root, ...config }).doctor()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function codes(report) {
  return report.issues.map((i) => i.code)
}

test('doctor：干净记忆零问题', () => {
  const r = check({ index: CLEAN_INDEX, route: CLEAN_ROUTE, evidence: EVIDENCE })
  assert.equal(r.ok, true)
  assert.equal(r.counts.error, 0)
  assert.equal(r.counts.warn, 0, JSON.stringify(r.issues))
  assert.deepEqual(r.checked, {
    groups: 2,
    entries: 3,
    evidence: 1,
    indexBytes: r.checked.indexBytes,
    indexLines: r.checked.indexLines,
  })
})

test('doctor：重复任务族报 error（memory_recall 只会读到第一块）', () => {
  const route = CLEAN_ROUTE.replace(
    '### Older Memory Topics',
    '## env\n\n- 2026-10-09 第二个同名块\n\n### Older Memory Topics',
  )
  const r = check({ index: CLEAN_INDEX, route, evidence: EVIDENCE })
  assert.equal(r.ok, false)
  const dup = r.issues.find((i) => i.code === 'duplicate-group')
  assert.ok(dup, '应报 duplicate-group')
  assert.equal(dup.level, 'error')
  assert.equal(dup.slug, 'env')
  assert.equal(dup.heads.length, 2)
})

test('doctor：索引超预算报 error，超行数报 warn', () => {
  const longIndex = ['# 索引', '', ...Array.from({ length: 120 }, (_, i) => `- 第 ${i} 行 → \`#env\``)].join('\n')
  const r = check({ index: longIndex, route: CLEAN_ROUTE, evidence: EVIDENCE }, { maxIndexBytes: 300 })
  const over = r.issues.find((i) => i.code === 'index-over-budget')
  assert.ok(over && over.level === 'error')
  assert.ok(codes(r).includes('index-too-long'))
})

test('doctor：缺日期前缀的条目报 warn', () => {
  const route = CLEAN_ROUTE.replace('- 2026-10-01 alpha 上线', '- alpha 上线（忘了写日期）')
  const r = check({ index: CLEAN_INDEX, route, evidence: EVIDENCE })
  const missing = r.issues.find((i) => i.code === 'missing-date')
  assert.ok(missing)
  assert.equal(missing.level, 'warn')
  assert.equal(missing.line, 5)
})

test('doctor：孤儿证据文件报 warn', () => {
  const r = check({
    index: CLEAN_INDEX,
    route: CLEAN_ROUTE, // 仍引用 sqlite.md，只有 orphan-note.md 是孤儿
    evidence: { ...EVIDENCE, 'orphan-note.md': '# 没人引用我\n' },
  })
  const orphans = r.issues.filter((i) => i.code === 'orphan-evidence')
  assert.equal(orphans.length, 1)
  assert.match(orphans[0].message, /orphan-note\.md/)
})

test('doctor：说明文字里的 #xxx 不算失效路由，真实失效路由照报', () => {
  // 索引顶部那句说明不应被误判
  const withNote = CLEAN_INDEX.replace(
    '# 索引',
    '# 索引\n\n> 路由中的 `#xxx` 均指 MEMORY.md 的对应任务族。',
  )
  const clean = check({ index: withNote, route: CLEAN_ROUTE, evidence: EVIDENCE })
  assert.equal(
    clean.issues.filter((i) => i.code === 'dead-route').length,
    0,
    '说明文字里的 #xxx 不应被当成路由',
  )

  // 真实指向不存在的族要报
  const badIndex = CLEAN_INDEX.replace('- 环境 → `#env`', '- 环境 → `#env`\n- 幽灵 → `#ghost`')
  const bad = check({ index: badIndex, route: CLEAN_ROUTE, evidence: EVIDENCE })
  const dead = bad.issues.find((i) => i.code === 'dead-route')
  assert.ok(dead)
  assert.equal(dead.slug, 'ghost')
})

test('doctor：完全重复的条目报 warn', () => {
  const route = CLEAN_ROUTE.replace('- 2026-10-02 beta 回滚', '- 2026-10-01 alpha 上线')
  const r = check({ index: CLEAN_INDEX, route, evidence: EVIDENCE })
  assert.ok(r.issues.some((i) => i.code === 'duplicate-entry'))
})

test('doctor：空任务族与超大任务族分别告警', () => {
  const emptyRoute = CLEAN_ROUTE.replace(
    '### Older Memory Topics',
    '## empty\n\n### Older Memory Topics',
  )
  const empty = check({ index: CLEAN_INDEX, route: emptyRoute, evidence: EVIDENCE })
  assert.ok(empty.issues.some((i) => i.code === 'empty-group' && i.slug === 'empty'))

  const many = Array.from({ length: 41 }, (_, i) => `- 2026-10-01 条目 ${i}`).join('\n')
  const bigRoute = CLEAN_ROUTE.replace('- 2026-10-01 alpha 上线\n- 2026-10-02 beta 回滚', many)
  const big = check({ index: CLEAN_INDEX, route: bigRoute, evidence: EVIDENCE })
  const large = big.issues.find((i) => i.code === 'large-group')
  assert.ok(large)
  assert.equal(large.count, 41)
})

test('doctor：记忆目录缺失时安全报错而不是抛异常', () => {
  const root = join(tmpdir(), 'dsh-mem-doctor-missing-' + process.pid)
  const r = createStore({ root }).doctor()
  // 没有路由层就没有任务族，但检查本身不应崩
  assert.equal(r.checked.groups, 0)
  assert.equal(r.checked.entries, 0)
  assert.ok(Array.isArray(r.issues))
})
