import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/** 造一个插件上下文：工具收集 + 可选 webServer */
function makeCtx({ withWebServer }) {
  const routes = new Map()
  // cordis 把 inject 声明的服务挂在 ctx 上（ctx.webServer），不是通过 ctx.get 取
  const webServer = withWebServer
    ? {
        register: (route) => {
          routes.set(route.path, route)
        },
      }
    : undefined
  const ctx = {
    tools: { register: () => {} },
    sections: [],
    handlers: new Map(),
    webServer,
    get: () => false,
    effect: (fn) => fn(),
    on: () => {},
  }
  return { ctx, routes }
}

/** 调一个路由 handler，返回解析后的 JSON 与状态码 */
function callRoute(route, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      writeHead(code) {
        this.statusCode = code
      },
      end(body) {
        resolve({ status: this.statusCode, json: JSON.parse(body) })
      },
    }
    route.handler({ url }, res)
  })
}

function makeMemory() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-'))
  mkdirSync(join(root, 'summaries'), { recursive: true })
  writeFileSync(join(root, 'memory_summary.md'), '# 索引\n\n- 环境 → `#env`\n', 'utf8')
  writeFileSync(
    join(root, 'MEMORY.md'),
    '# MEMORY\n\n## env\n\n- 2026-10-01 alpha 事实\n- 2026-10-02 beta 事实\n\n## infra\n\n- 2026-10-03 gamma\n',
    'utf8',
  )
  return root
}

test('面板 API：注册三条只读路由', () => {
  const root = makeMemory()
  try {
    const { ctx, routes } = makeCtx({ withWebServer: true })
    apply(ctx, { root, autoCapture: 'off' })
    assert.deepEqual(
      [...routes.keys()].sort(),
      [
        '/dsh-kymemory/api/group',
        '/dsh-kymemory/api/overview',
        '/dsh-kymemory/api/search',
        '/dsh-kymemory/panel',
      ],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('面板 API：overview 给出规模、族与体检', async () => {
  const root = makeMemory()
  try {
    const { ctx, routes } = makeCtx({ withWebServer: true })
    apply(ctx, { root, autoCapture: 'off' })
    const { status, json } = await callRoute(routes.get('/dsh-kymemory/api/overview'), '/dsh-kymemory/api/overview')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.route.groups, 2)
    assert.equal(json.route.entries, 3)
    assert.ok(Array.isArray(json.groups))
    assert.equal(json.groups.length, 2)
    assert.ok(json.doctor && typeof json.doctor.ok === 'boolean')
    assert.ok(json.usage && typeof json.usage.total === 'number')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('面板 API：group 返回条目，未知族 404', async () => {
  const root = makeMemory()
  try {
    const { ctx, routes } = makeCtx({ withWebServer: true })
    apply(ctx, { root, autoCapture: 'off' })
    const route = routes.get('/dsh-kymemory/api/group')

    const ok = await callRoute(route, '/dsh-kymemory/api/group?slug=env')
    assert.equal(ok.status, 200)
    assert.match(ok.json.text, /alpha 事实/)

    const missing = await callRoute(route, '/dsh-kymemory/api/group?slug=nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('面板 API：search 命中并限制条数', async () => {
  const root = makeMemory()
  try {
    const { ctx, routes } = makeCtx({ withWebServer: true })
    apply(ctx, { root, autoCapture: 'off' })
    const route = routes.get('/dsh-kymemory/api/search')

    const hit = await callRoute(route, '/dsh-kymemory/api/search?q=alpha')
    assert.equal(hit.json.ok, true)
    assert.ok(hit.json.total >= 1)

    const miss = await callRoute(route, '/dsh-kymemory/api/search?q=zzz-不存在')
    assert.equal(miss.json.total, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('面板 API：没有 webServer 时不注册路由也不崩', () => {
  const root = makeMemory()
  try {
    const { ctx } = makeCtx({ withWebServer: false })
    assert.doesNotThrow(() => apply(ctx, { root, autoCapture: 'off' }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
