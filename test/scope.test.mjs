import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, parseGroups, scopeMatches } from '../lib/store.js'

/** 两个项目目录 + 一个全局族 + 两个项目族 */
function makeScoped() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-scope-'))
  const mem = join(base, 'mem')
  const projA = join(base, 'proj-a')
  const projB = join(base, 'proj-b')
  for (const dir of [mem, projA, projB, join(mem, 'summaries')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(mem, 'memory_summary.md'), '# 索引\n', 'utf8')
  writeFileSync(
    join(mem, 'MEMORY.md'),
    [
      '# MEMORY',
      '',
      '## infra',
      '',
      '- 2026-10-01 全局事实 alpha',
      '',
      `## homework @${projA}`,
      '',
      '- 2026-10-02 作业事实 beta',
      '',
      `## side @${projB}`,
      '',
      '- 2026-10-03 B 项目事实 gamma',
      '',
    ].join('\n'),
    'utf8',
  )
  return { base, mem, projA, projB }
}

test('parseGroups：解析 @scope 标记', () => {
  const lines = ['## infra', '', '## homework @/tmp/x', '', '## c（标题） @/tmp/y']
  const groups = parseGroups(lines)
  assert.equal(groups[0].scope, null)
  assert.equal(groups[1].scope, '/tmp/x')
  assert.equal(groups[1].title, 'homework', '标题不应包含作用域标记')
  assert.equal(groups[2].slug, 'c')
  assert.equal(groups[2].scope, '/tmp/y')
})

test('scopeMatches：全局放行、未知 cwd 放行、前缀匹配', () => {
  assert.equal(scopeMatches(null, '/any'), true, '全局族永远可见')
  assert.equal(scopeMatches('/tmp/x', undefined), true, '不传 cwd 不过滤')
  assert.equal(scopeMatches('/tmp/x', '/tmp/x'), true)
  assert.equal(scopeMatches('/tmp/x', '/tmp/x/sub/dir'), true, '子目录应命中')
  assert.equal(scopeMatches('/tmp/x', '/tmp/y'), false)
  assert.equal(scopeMatches('/tmp/x/', '/tmp/x'), true, '尾部斜杠不影响')
})

test('search：项目族只在对应目录出现，全局族永远出现', () => {
  const { mem, projA, projB, base } = makeScoped()
  try {
    const store = createStore({ root: mem })
    // 不传 cwd：全部可见（不误杀）
    assert.equal(store.search('事实').total, 3)

    // 在项目 A 里：全局 + A 的族
    const inA = store.search('事实', 20, { cwd: projA })
    assert.equal(inA.total, 2, JSON.stringify(inA.hits.map((h) => h.text)))
    assert.ok(inA.hits.some((h) => h.text.includes('alpha')), '全局族应可见')
    assert.ok(inA.hits.some((h) => h.text.includes('beta')), 'A 项目族应可见')
    assert.ok(!inA.hits.some((h) => h.text.includes('gamma')), 'B 项目族不该出现')

    // 在项目 B 里
    const inB = store.search('事实', 20, { cwd: projB })
    assert.ok(inB.hits.some((h) => h.text.includes('gamma')))
    assert.ok(!inB.hits.some((h) => h.text.includes('beta')))

    // 在无关目录：只剩全局
    const outs = store.search('事实', 20, { cwd: base })
    assert.equal(outs.total, 1)
    assert.match(outs.hits[0].text, /alpha/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('recall：跨作用域被拒绝，同作用域放行', () => {
  const { mem, projA, projB, base } = makeScoped()
  try {
    const store = createStore({ root: mem })
    assert.ok(store.recall('homework', { cwd: projA }).text.includes('beta'))
    assert.ok(store.recall('homework', { cwd: join(projA, 'deep') }).text, '子目录也算')
    assert.throws(
      () => store.recall('homework', { cwd: projB }),
      /绑定在项目/,
      '在 B 项目里读 A 项目的族应被拒绝',
    )
    assert.ok(store.recall('infra', { cwd: base }).text, '全局族在任何目录可读')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('groups：返回并展示 scope', () => {
  const { mem, projA, base } = makeScoped()
  try {
    const store = createStore({ root: mem })
    const groups = store.groups()
    const hw = groups.find((g) => g.slug === 'homework')
    assert.equal(hw.scope, projA)
    assert.equal(groups.find((g) => g.slug === 'infra').scope, null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('createGroup：带 scope 写入标题', () => {
  const { mem, projA, base } = makeScoped()
  try {
    const store = createStore({ root: mem })
    store.createGroup('newproj', '新项目', { scope: projA })
    const route = readFileSync(join(mem, 'MEMORY.md'), 'utf8')
    assert.match(route, new RegExp(`## newproj（新项目） @${projA.replace(/[/\\]/g, '\\$&')}`))
    assert.equal(store.groups().find((g) => g.slug === 'newproj').scope, projA)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('save + createGroup + scope：一步建好带作用域的族', () => {
  const { mem, projA, base } = makeScoped()
  try {
    const store = createStore({ root: mem })
    store.save('brand', '第一条', '2026-10-05', {
      createGroup: true,
      title: '新族',
      scope: projA,
    })
    assert.equal(store.groups().find((g) => g.slug === 'brand').scope, projA)
    // 在别的目录读不到
    assert.throws(() => store.recall('brand', { cwd: base }), /绑定在项目/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('doctor：作用域路径不存在时告警', () => {
  const { mem, base } = makeScoped()
  try {
    // 手动塞一个指向不存在目录的族
    const route = join(mem, 'MEMORY.md')
    writeFileSync(
      route,
      readFileSync(route, 'utf8') + '\n## ghost @/tmp/definitely-not-here-xyz\n\n- 2026-10-09 幽灵\n',
      'utf8',
    )
    const report = createStore({ root: mem }).doctor()
    const issue = report.issues.find((i) => i.code === 'missing-scope-path')
    assert.ok(issue, '应报 missing-scope-path')
    assert.equal(issue.level, 'warn')
    assert.equal(issue.slug, 'ghost')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
