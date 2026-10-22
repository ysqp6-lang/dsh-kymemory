import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createStore,
  expandHome,
  truncateUtf8,
  byteLength,
  parseGroups,
  insertEntry,
  today,
} from '../lib/store.js'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  mkdirSync(join(root, 'summaries'), { recursive: true })
  writeFileSync(
    join(root, 'memory_summary.md'),
    [
      '# 索引',
      '',
      '## What\'s in Memory',
      '',
      '- 环境 → `#env`',
      '- 坑 → `#pitfalls`',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(root, 'MEMORY.md'),
    [
      '# MEMORY',
      '',
      '## env',
      '',
      '- 2026-10-01 第一台机器叫 alpha',
      '- 2026-10-02 端口 8790 是面板',
      '',
      '## pitfalls',
      '',
      '- 2026-10-03 直接 sqlite3 打不开，要先 cp',
      '',
      '### Older Memory Topics',
      '',
      '（暂无）',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(root, 'summaries', '2026-10-03-sqlite.md'),
    '# sqlite 证据\n\n- 复现：sqlite3 直接开会报 unable to open database file\n',
    'utf8',
  )
  return root
}

function withFixture(fn) {
  const root = makeFixture()
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('expandHome 展开 ~ 与默认值', () => {
  assert.ok(expandHome('~').length > 1)
  assert.ok(expandHome('~/x').endsWith('/x'))
  assert.equal(expandHome(''), join(process.env.HOME ?? '', '.dsh', 'memory'))
  assert.equal(expandHome('/abs/path'), '/abs/path')
})

test('today 返回 YYYY-MM-DD', () => {
  assert.match(today(new Date(2026, 0, 5)), /^2026-01-05$/)
})

test('truncateUtf8 不切断多字节字符', () => {
  const text = '记忆系统'
  assert.equal(truncateUtf8(text, 100), text)
  const cut = truncateUtf8(text, 7) // 每个汉字 3 字节 → 只能放 2 个
  assert.equal(cut, '记忆')
  assert.ok(byteLength(cut) <= 7)
  assert.equal(truncateUtf8(text, 0), '')
})

test('parseGroups 识别任务族并忽略三级标题', () => {
  const lines = ['# M', '## a', '- x', '## b（标题）', '- y', '### Older Memory Topics', '']
  const groups = parseGroups(lines)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].slug, 'a')
  assert.equal(groups[1].slug, 'b')
  assert.equal(groups[1].title, 'b（标题）')
})

test('insertEntry 追加到组内最后一条之后', () => {
  const lines = ['## a', '', '- one', '', '## b', '']
  const group = { head: 0, end: 4 }
  insertEntry(lines, group, '- two')
  assert.deepEqual(lines.slice(0, 5), ['## a', '', '- one', '- two', ''])
})

test('insertEntry 空组插在标题后的空行之后', () => {
  const lines = ['## a', '', '## b', '']
  const group = { head: 0, end: 2 }
  insertEntry(lines, group, '- first')
  assert.equal(lines[2], '- first')
})

test('renderIndex 含使用引导，且任何预算下都不超限', () => {
  withFixture((root) => {
    const store = createStore({ root, maxIndexBytes: 4096 })
    const text = store.renderIndex()
    assert.match(text, /memory_recall/)
    assert.match(text, /#env/)

    const full = byteLength(text)
    for (const limit of [40, 80, 150, 220, 300, full - 10, full, 4096]) {
      const out = createStore({ root, maxIndexBytes: limit }).renderIndex()
      assert.ok(
        byteLength(out) <= limit,
        `limit=${limit} 时输出了 ${byteLength(out)} 字节（完整索引 ${full} 字节）`,
      )
    }
    // 预算刚好卡在 body 里时，应给出截断提示而不是静默丢弃
    const tight = createStore({ root, maxIndexBytes: full - 10 }).renderIndex()
    assert.match(tight, /截断|索引超出/)
  })
})

test('renderIndex 在文件缺失或关闭注入时返回空', () => {
  withFixture((root) => {
    const empty = createStore({ root: join(root, 'nope') })
    assert.equal(empty.renderIndex(), '')
    const off = createStore({ root, injectIndex: false })
    assert.equal(off.renderIndex(), '')
  })
})

test('search 跨路由层与证据层', () => {
  withFixture((root) => {
    const store = createStore({ root })
    const result = store.search('sqlite')
    assert.equal(result.total, 3)
    assert.ok(result.hits.some((h) => h.file === 'MEMORY.md'))
    assert.ok(result.hits.some((h) => h.file.startsWith('summaries/')))
    assert.equal(store.search('完全不存在的东西').total, 0)
    assert.throws(() => store.search('  '), /不能为空/)
  })
})

test('save 写入带日期条目并保持组结构', () => {
  withFixture((root) => {
    const store = createStore({ root })
    const saved = store.save('env', '第三台机器叫 gamma', '2026-10-23')
    assert.equal(saved.slug, 'env')
    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.match(route, /- 2026-10-23 第三台机器叫 gamma/)
    // 仍然在 env 组内，且在 pitfalls 之前
    const envIndex = route.indexOf('## env')
    const newIndex = route.indexOf('第三台机器叫 gamma')
    const pitIndex = route.indexOf('## pitfalls')
    assert.ok(envIndex < newIndex && newIndex < pitIndex)
    // 追加后组内条目数 +1
    const env = store.groups().find((g) => g.slug === 'env')
    assert.equal(env.entries, 3)
  })
})

test('save 默认用今天且拒绝未知任务族', () => {
  withFixture((root) => {
    const store = createStore({ root })
    store.save('env', '默认日期条目')
    assert.match(readFileSync(join(root, 'MEMORY.md'), 'utf8'), new RegExp(`- ${today()} 默认日期条目`))
    assert.throws(() => store.save('nope', 'x'), /没有名为「nope」的任务族/)
    assert.throws(() => store.save('env', '   '), /不能为空/)
  })
})

test('recall 返回整组文本，缺失时报错', () => {
  withFixture((root) => {
    const store = createStore({ root })
    const group = store.recall('pitfalls')
    assert.match(group.text, /sqlite/)
    assert.match(group.text, /^## pitfalls/)
    assert.throws(() => store.recall('missing'), /没有名为「missing」/)
  })
})

test('createGroup 幂等且插在 Older 标记之前', () => {
  withFixture((root) => {
    const store = createStore({ root })
    assert.equal(store.createGroup('tools', '外部工具').created, true)
    assert.equal(store.createGroup('tools').created, false)
    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    const newIndex = route.indexOf('## tools')
    const olderIndex = route.indexOf('### Older Memory Topics')
    assert.ok(newIndex > 0 && newIndex < olderIndex)
    assert.throws(() => store.createGroup('bad slug'), /slug/)
  })
})

test('stats 报告规模与上限判定', () => {
  withFixture((root) => {
    const store = createStore({ root })
    const stats = store.stats()
    assert.equal(stats.route.groups, 2)
    assert.equal(stats.evidence, 1)
    assert.equal(stats.indexWithinLimit, true)
    const tiny = createStore({ root, maxIndexBytes: 10 })
    assert.equal(tiny.stats().indexWithinLimit, false)
  })
})

test('enqueue 去重、缺 id 时安全返回', () => {
  withFixture((root) => {
    const store = createStore({ root })
    assert.equal(store.enqueue({ id: 's1', title: '会话一' }).enqueued, true)
    assert.equal(store.enqueue({ id: 's1' }).enqueued, false)
    assert.equal(store.enqueue({}).enqueued, false)
    const rows = readFileSync(join(root, 'pending.jsonl'), 'utf8').trim().split('\n')
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0]).sessionId, 's1')
  })
})

test('enqueue 限制队列长度上限', () => {
  withFixture((root) => {
    const store = createStore({ root })
    for (let i = 0; i < 505; i++) store.enqueue(`s-${i}`)
    const rows = readFileSync(join(root, 'pending.jsonl'), 'utf8').trim().split('\n')
    assert.equal(rows.length, 500)
    // 保留最新的一批
    assert.equal(JSON.parse(rows.at(-1)).sessionId, 's-504')
  })
})
