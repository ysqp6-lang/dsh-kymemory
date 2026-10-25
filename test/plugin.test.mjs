import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  mkdirSync(join(root, 'summaries'), { recursive: true })
  writeFileSync(join(root, 'memory_summary.md'), '# 索引\n\n- 环境 → `#env`\n', 'utf8')
  writeFileSync(
    join(root, 'MEMORY.md'),
    ['# MEMORY', '', '## env', '', '- 2026-10-01 alpha', ''].join('\n'),
    'utf8',
  )
  return root
}

/** Minimal cordis-shaped context that records what the plugin registers. */
function mockCtx({ withSystemPrompt = true } = {}) {
  const tools = []
  const sections = []
  const handlers = new Map() // event -> [fn, ...]
  const effects = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    get: (key, fallback) => {
      if (key === 'systemPrompt' && withSystemPrompt) {
        return { section: (section) => (sections.push(section), () => {}) }
      }
      return fallback
    },
    effect: (fn, label) => {
      effects.push(label)
      const disposer = fn()
      return () => disposer?.()
    },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
  }
  return { ctx, tools, sections, handlers, effects }
}

test('插件导出了 cordis 需要的元信息', () => {
  assert.equal(name, 'dsh-kymemory')
  assert.deepEqual(inject, ['tools', 'sessions'])
  assert.equal(typeof apply, 'function')
})

test('配置模块零外部依赖，任何 profile 都能加载', async () => {
  const mod = await import('../lib/config.js')
  assert.ok(mod.DEFAULT_CONFIG, 'DEFAULT_CONFIG 应导出')
  assert.equal(mod.DEFAULT_CONFIG.root, '~/.dsh/memory')
  assert.equal(typeof mod.normalizeConfig, 'function')
  // 默认值 + 浅合并
  const base = mod.normalizeConfig({})
  assert.equal(base.maxIndexBytes, 4096)
  assert.equal(base.injectIndex, true)
  const custom = mod.normalizeConfig({ root: '/tmp/x', order: 200, maxIndexBytes: 'abc' })
  assert.equal(custom.root, '/tmp/x')
  assert.equal(custom.order, 200)
  assert.equal(custom.maxIndexBytes, 4096, '非法数值应回落到默认值')
  // 布尔 false 必须被尊重，不能被默认值覆盖
  const off = mod.normalizeConfig({ injectIndex: false, enqueueOnDispose: false })
  assert.equal(off.injectIndex, false)
  assert.equal(off.enqueueOnDispose, false)
})

test('注册十二个记忆工具，且名字与参数契约完整', () => {
  const root = fixture()
  try {
    const { ctx, tools } = mockCtx()
    apply(ctx, { root })
    const names = tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'memory_archive',
      'memory_curate',
      'memory_doctor',
      'memory_forget',
      'memory_groups',
      'memory_inbox',
      'memory_pending',
      'memory_promote',
      'memory_recall',
      'memory_rules',
      'memory_save',
      'memory_search',
      'memory_stats',
    ])
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 10, `${tool.name} 缺少描述`)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(tool.parameters.type, 'object')
    }
    const search = tools.find((tool) => tool.name === 'memory_search')
    assert.deepEqual(search.parameters.required, ['query'])
    const save = tools.find((tool) => tool.name === 'memory_save')
    assert.deepEqual(save.parameters.required, ['slug', 'text'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工具 end-to-end：保存 → 召回 → 检索 → 统计', async () => {
  const root = fixture()
  try {
    const { ctx, tools } = mockCtx()
    apply(ctx, { root })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    const saved = await byName.get('memory_save').execute({ slug: 'env', text: 'gamma 上线' })
    assert.equal(saved.slug, 'env')

    const recalled = await byName.get('memory_recall').execute({ slug: 'env' })
    assert.match(recalled.text, /gamma 上线/)

    const found = await byName.get('memory_search').execute({ query: 'gamma' })
    assert.equal(found.total, 1)
    const rendered = byName.get('memory_search').output.render({}, found)
    assert.match(rendered[0].text, /MEMORY\.md/)
    assert.equal(rendered[0].type, 'text')

    const stats = await byName.get('memory_stats').execute({})
    assert.ok(stats.route.entries >= 2)
    assert.equal(stats.indexWithinLimit, true)

    const groups = await byName.get('memory_groups').execute({})
    assert.ok(groups.groups.some((g) => g.slug === 'env'))

    // DSH 按 output.schema 校验工具返回值：必须是对象。数组/原始值会被
    // 判为 "returned invalid output"，真机 headless 跑出来的教训。
    const health = await byName.get('memory_doctor').execute({})
    assert.equal(health.ok, true, JSON.stringify(health.issues))
    assert.ok(health.checked.groups >= 1)

    for (const [toolName, toolArgs] of [
      ['memory_groups', {}],
      ['memory_stats', {}],
      ['memory_doctor', {}],
      ['memory_search', { query: 'gamma' }],
      ['memory_recall', { slug: 'env' }],
    ]) {
      const value = await byName.get(toolName).execute(toolArgs)
      assert.equal(typeof value, 'object', `${toolName} 必须返回对象`)
      assert.ok(value !== null && !Array.isArray(value), `${toolName} 不能返回 null 或数组`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('注入索引：section 名/order 正确且关闭插值', () => {
  const root = fixture()
  try {
    const { ctx, sections, effects } = mockCtx()
    apply(ctx, { root, order: 150 })
    assert.equal(sections.length, 1)
    const section = sections[0]
    assert.equal(section.name, 'plugin:dsh-kymemory')
    assert.equal(section.order, 150)
    assert.equal(section.interpolate, false, '必须关闭插值，否则记忆里的 {{...}} 会炸')
    assert.equal(typeof section.text, 'function', 'text 应为函数以支持动态刷新')
    assert.match(section.text({}), /#env/)
    assert.ok(effects.some((label) => String(label).includes('memory index')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('关闭注入或没有 systemPrompt 服务时不注册 section', () => {
  const root = fixture()
  try {
    const off = mockCtx()
    apply(off.ctx, { root, injectIndex: false })
    assert.equal(off.sections.length, 0)

    const noService = mockCtx({ withSystemPrompt: false })
    apply(noService.ctx, { root })
    assert.equal(noService.sections.length, 0)
    // 工具仍然要注册（注入是可选能力，工具不是）
    assert.equal(noService.tools.length, 13)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话关闭事件写入 pending 队列', () => {
  const root = fixture()
  try {
    const { ctx, handlers } = mockCtx()
    apply(ctx, { root })
    const listeners = handlers.get('session/disposed')
    assert.ok(Array.isArray(listeners) && listeners.length >= 1)
    const handler = listeners[0] // 第一个是 enqueue
    handler({ id: 'session-xyz', title: '测试会话' })
    const rows = readFileSync(join(root, 'pending.jsonl'), 'utf8').trim().split('\n')
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0]).sessionId, 'session-xyz')
    // 重复关闭不应重复登记
    handler({ id: 'session-xyz' })
    assert.equal(readFileSync(join(root, 'pending.jsonl'), 'utf8').trim().split('\n').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('事件处理器抛错不会冒泡（不能让会话拆除失败）', () => {
  const root = fixture()
  try {
    const { ctx, handlers } = mockCtx()
    apply(ctx, { root })
    const listeners = handlers.get('session/disposed')
    const broken = mockCtx()
    apply(broken.ctx, { root: '/dev/null/not-a-dir', autoCapture: 'off' })
    const brokenListeners = broken.handlers.get('session/disposed') ?? []
    for (const fn of brokenListeners) assert.doesNotThrow(() => fn({ id: 'x' }))
    for (const fn of listeners) assert.doesNotThrow(() => fn({}))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('enqueueOnDispose 关闭时不监听事件', () => {
  const root = fixture()
  try {
    const { ctx, handlers } = mockCtx()
    apply(ctx, { root, enqueueOnDispose: false, autoCapture: 'off' })
    assert.equal(handlers.has('session/disposed'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
