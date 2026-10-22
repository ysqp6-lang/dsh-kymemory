import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  decompressTailFrames,
  findSessionArchive,
  extractTranscript,
  captureSession,
  renderInbox,
  writeInbox,
} from '../lib/capture.js'
import { createStore } from '../lib/store.js'

/** Pack each line as its own zstd frame — the way DSH appends a transcript. */
function multiFrame(lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

function sampleEvents() {
  return [
    { type: 'session', version: 4, id: 'session-abc', createdAt: 1, cwd: '/tmp' },
    { type: 'session/title', data: { title: '测试会话标题' } },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '第一个用户问题' }], source: { kind: 'user' } },
    },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '第二个用户问题' }], source: { kind: 'user' } },
    },
    {
      type: 'compaction/summary',
      data: { summary: [{ type: 'text', text: '这是会话的压缩摘要' }] },
    },
  ]
}

function makeSessionsRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  const ws = join(root, '--Users-thy-Agent-DSH--')
  const dir = join(ws, 'session-abc')
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(archive, multiFrame(sampleEvents().map((e) => JSON.stringify(e))))
  return { root, archive }
}

// ── 多帧解压 ──────────────────────────────────────────────────────────

test('decompressTailFrames：解开全部帧', () => {
  const buf = multiFrame(['第一行', '第二行', '第三行'])
  const text = decompressTailFrames(buf).toString('utf8')
  assert.match(text, /第一行/)
  assert.match(text, /第二行/)
  assert.match(text, /第三行/)
})

test('decompressTailFrames：只取尾部 N 帧', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
  const buf = multiFrame(lines)
  const text = decompressTailFrames(buf, 5).toString('utf8')
  assert.match(text, /line-49/)
  assert.ok(!text.includes('line-0\n'), '不应解出最早的帧')
})

test('decompressTailFrames：空输入与坏数据都安全返回', () => {
  assert.equal(decompressTailFrames(Buffer.alloc(0)).length, 0)
  assert.doesNotThrow(() => decompressTailFrames(Buffer.from('not a zstd frame')))
})

// ── 存档定位 ──────────────────────────────────────────────────────────

test('findSessionArchive：按 session id 片段定位', () => {
  const { root, archive } = makeSessionsRoot()
  try {
    assert.equal(findSessionArchive(root, 'session-abc'), archive)
    assert.equal(findSessionArchive(root, 'abc'), archive, '裸 id 也应命中')
    assert.equal(findSessionArchive(root, 'no-such-id'), null)
    assert.equal(findSessionArchive(join(root, 'missing'), 'abc'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 抽取 ──────────────────────────────────────────────────────────────

test('extractTranscript：抽标题、用户原话与摘要，忽略噪音', () => {
  const jsonl = sampleEvents().map((e) => JSON.stringify(e)).join('\n')
  const result = extractTranscript(jsonl)
  assert.equal(result.title, '测试会话标题')
  assert.equal(result.messageCount, 2)
  assert.equal(result.summaries.length, 1)
  assert.match(result.body, /第一个用户问题/)
  assert.match(result.body, /压缩摘要/)
})

test('extractTranscript：坏行与非用户消息被跳过', () => {
  const lines = [
    '{broken json',
    JSON.stringify({ type: 'assistant/message', data: { message: { content: [] } } }),
    JSON.stringify({
      type: 'user/message',
      data: { content: [{ type: 'text', text: '系统注入' }], source: { kind: 'plugin' } },
    }),
  ]
  const result = extractTranscript(lines.join('\n'))
  assert.equal(result.messageCount, 0, '非 user 来源的消息不应计入')
})

test('extractTranscript：超长正文被截断', () => {
  const long = 'x'.repeat(500)
  const lines = [
    JSON.stringify({ type: 'session/title', data: { title: long } }),
    ...Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        type: 'user/message',
        data: { content: [{ type: 'text', text: `${i}-${long}` }], source: { kind: 'user' } },
      }),
    ),
  ]
  const result = extractTranscript(lines.join('\n'), { maxChars: 120 })
  assert.ok(result.body.length <= 200, `正文应被截断，实际 ${result.body.length}`)
  assert.match(result.body, /已截断/)
})

// ── 端到端捕获 ────────────────────────────────────────────────────────

test('captureSession：端到端产出候选素材', () => {
  const { root } = makeSessionsRoot()
  try {
    const capture = captureSession({
      sessionsRoot: root,
      sessionId: 'session-abc',
      title: '',
      cwd: '/tmp/project',
      minMessages: 2,
    })
    assert.equal(capture.skipped, undefined, capture.skipped)
    assert.equal(capture.sessionId, 'session-abc')
    assert.equal(capture.title, '测试会话标题', '应回落到存档里的标题')
    assert.equal(capture.messageCount, 2)
    assert.match(capture.body, /第一个用户问题/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captureSession：太短的会话被跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-short-'))
  try {
    const dir = join(root, 'ws', 'session-tiny')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session.v4.jsonl.zstd'),
      multiFrame([
        JSON.stringify({
          type: 'user/message',
          data: { content: [{ type: 'text', text: '只问了一句' }], source: { kind: 'user' } },
        }),
      ]),
    )
    const capture = captureSession({ sessionsRoot: root, sessionId: 'session-tiny', minMessages: 2 })
    assert.match(capture.skipped, /too-short/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captureSession：找不到存档时返回 skipped 而不是抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-none-'))
  try {
    const capture = captureSession({ sessionsRoot: root, sessionId: 'ghost' })
    assert.equal(capture.skipped, 'archive-not-found')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── inbox 文件 ────────────────────────────────────────────────────────

test('renderInbox / writeInbox：写出带 front-matter 的候选文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inbox-'))
  try {
    const capture = {
      sessionId: 'session-xyz',
      title: '标题',
      cwd: '/tmp/p',
      capturedAt: '2026-10-23T00:00:00.000Z',
      messageCount: 3,
      summaryCount: 1,
      body: '## 用户原话\n- 甲',
    }
    const rendered = renderInbox(capture)
    assert.match(rendered, /^---\n/)
    assert.match(rendered, /session: session-xyz/)
    assert.match(rendered, /status: pending/)

    const file = writeInbox(root, capture)
    assert.ok(existsSync(file))
    assert.match(readFileSync(file, 'utf8'), /候选记忆素材/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store：inbox 列出、读取、归档', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inbox-store-'))
  try {
    const store = createStore({ root })
    assert.deepEqual(store.inbox(), [])
    assert.throws(() => store.readInbox(), /inbox 为空/)

    writeInbox(root, {
      sessionId: 'session-1',
      title: '甲',
      cwd: '',
      capturedAt: new Date().toISOString(),
      messageCount: 2,
      summaryCount: 0,
      body: '第一批素材',
    })
    writeInbox(root, {
      sessionId: 'session-2',
      title: '乙',
      cwd: '',
      capturedAt: new Date().toISOString(),
      messageCount: 2,
      summaryCount: 0,
      body: '第二批素材',
    })

    const list = store.inbox()
    assert.equal(list.length, 2)
    assert.ok(list[0].meta.session)

    const newest = store.readInbox()
    assert.match(newest.text, /素材/)

    const promoted = store.promoteInbox()
    assert.equal(promoted.remaining, 1)
    assert.equal(store.inbox().length, 1)
    assert.ok(existsSync(join(root, 'inbox', 'archive')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('renderIndex：inbox 非空时在注入文本里提示', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inbox-hint-'))
  try {
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n\n- 环境 → `#env`\n')
    writeFileSync(join(root, 'MEMORY.md'), '# MEMORY\n\n## env\n\n- 2026-10-01 a\n')
    const store = createStore({ root })
    assert.ok(!store.renderIndex().includes('inbox'))

    writeInbox(root, {
      sessionId: 'session-1',
      title: '',
      cwd: '',
      capturedAt: new Date().toISOString(),
      messageCount: 2,
      summaryCount: 0,
      body: '素材',
    })
    assert.match(store.renderIndex(), /inbox 有 1 个待整理候选/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
