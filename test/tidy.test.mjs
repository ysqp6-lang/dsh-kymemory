import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'

function makeRoot({ withDup = false, withBadScope = false, withBlanks = false, withStale = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tidy-'))
  mkdirSync(join(root, 'summaries'), { recursive: true })
  mkdirSync(join(root, 'inbox'), { recursive: true })
  writeFileSync(join(root, 'memory_summary.md'), '# 索引\n\n- 环境 → `#env`\n', 'utf8')

  const lines = ['# MEMORY', '', '## env', '', '- 2026-10-01 alpha']
  if (withDup) lines.push('- 2026-10-01 alpha')
  if (withBadScope) lines.push('', '## ghost @/tmp/definitely-missing-xyz', '', '- 2026-10-02 ghost')
  if (withBlanks) lines.push('', '', '', '## tail', '', '- 2026-10-03 tail')
  writeFileSync(join(root, 'MEMORY.md'), lines.join('\n') + '\n', 'utf8')

  if (withStale) {
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10)
    writeFileSync(join(root, 'inbox', `${old}-session-old.md`), '旧候选', 'utf8')
  }
  return root
}

test('tidyPreview：识别完全重复条目', () => {
  const root = makeRoot({ withDup: true })
  try {
    const p = createStore({ root }).tidyPreview()
    const dup = p.items.find((i) => i.kind === 'duplicate-entry')
    assert.ok(dup, '应识别重复条目')
    assert.equal(dup.count, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyPreview：识别失效作用域与连续空行', () => {
  const root = makeRoot({ withBadScope: true, withBlanks: true })
  try {
    const p = createStore({ root }).tidyPreview()
    const kinds = p.items.map((i) => i.kind)
    assert.ok(kinds.includes('missing-scope-path'), kinds.join(','))
    assert.ok(kinds.includes('blank-lines'), kinds.join(','))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyApply：删除重复条目并先备份', () => {
  const root = makeRoot({ withDup: true })
  try {
    const store = createStore({ root })
    const before = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    const rec = store.tidyApply(['duplicate-entry'])
    assert.ok(existsSync(rec.backup), '必须先生成备份')
    const after = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.equal((after.match(/- 2026-10-01 alpha/g) || []).length, 1, '重复条目应只剩一条')
    assert.ok(after.length < before.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyApply：移除失效作用域标记', () => {
  const root = makeRoot({ withBadScope: true })
  try {
    const store = createStore({ root })
    store.tidyApply(['missing-scope-path'])
    const after = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.ok(!after.includes('@/tmp/definitely-missing-xyz'), '失效标记应被移除')
    assert.ok(after.includes('## ghost'), '族本身要保留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyApply：合并连续空行', () => {
  const root = makeRoot({ withBlanks: true })
  try {
    const store = createStore({ root })
    store.tidyApply(['blank-lines'])
    const after = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.ok(!after.includes('\n\n\n'), '不应再有连续三个换行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyApply：过期 inbox 归档', () => {
  const root = makeRoot({ withStale: true })
  try {
    const store = createStore({ root })
    store.tidyApply(['stale-inbox'])
    const live = readdirSync(join(root, 'inbox')).filter((f) => f.endsWith('.md'))
    const archived = readdirSync(join(root, 'inbox', 'archive')).filter((f) => f.endsWith('.md'))
    assert.equal(live.length, 0)
    assert.equal(archived.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyUndo：从备份恢复原内容', () => {
  const root = makeRoot({ withDup: true })
  try {
    const store = createStore({ root })
    const before = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    store.tidyApply(['duplicate-entry'])
    assert.notEqual(readFileSync(join(root, 'MEMORY.md'), 'utf8'), before)
    store.tidyUndo()
    assert.equal(readFileSync(join(root, 'MEMORY.md'), 'utf8'), before, '撤销后应逐字恢复')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tidyApply：没指定项目时报错且不产生备份', () => {
  const root = makeRoot()
  try {
    const store = createStore({ root })
    assert.throws(() => store.tidyApply([]), /没有指定/)
    assert.ok(!existsSync(join(root, 'archive', 'last-tidy.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
