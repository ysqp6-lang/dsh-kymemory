import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createStore, tokenize, compactIndex, validateSlug } from '../lib/store.js'

const execFileAsync = promisify(execFile)
const STORE_PATH = join(process.cwd(), 'lib', 'store.js')

/**
 * Fixture layout (line numbers matter for the forget-by-line tests):
 *  1 # MEMORY
 *  2
 *  3 ## env
 *  4
 *  5 - 2026-10-01 alpha
 *  6 - 2026-10-02 beta
 *  7
 *  8 ### Older Memory Topics
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-tools-'))
  mkdirSync(join(root, 'summaries'), { recursive: true })
  writeFileSync(join(root, 'memory_summary.md'), '# 索引\n\n- 环境 → `#env`\n', 'utf8')
  writeFileSync(
    join(root, 'MEMORY.md'),
    [
      '# MEMORY',
      '',
      '## env',
      '',
      '- 2026-10-01 alpha',
      '- 2026-10-02 beta',
      '',
      '### Older Memory Topics',
      '',
      '（暂无）',
      '',
    ].join('\n'),
    'utf8',
  )
  return root
}

function withStore(fn) {
  const root = fixture()
  try {
    return fn(createStore({ root }), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 纯函数 ────────────────────────────────────────────────────────────

test('tokenize：英文词整体保留，中文切成 bigram', () => {
  const tokens = tokenize('Tailscale 记忆系统 pnpm')
  assert.ok(tokens.has('tailscale'))
  assert.ok(tokens.has('pnpm'))
  assert.ok(tokens.has('记忆'))
  assert.ok(tokens.has('忆系'))
  assert.ok(tokens.has('系统'))
  assert.equal(tokenize('').size, 0)
})

test('compactIndex：去掉引用说明行并折叠连续空行', () => {
  const src = '# 标题\n\n> 这是一行说明\n\n\n- 条目一\n- 条目二\n'
  assert.equal(compactIndex(src), '# 标题\n\n- 条目一\n- 条目二')
})

test('validateSlug：允许点/下划线/连字符，拒绝空格与中文', () => {
  assert.equal(validateSlug('abc-123_x.y'), 'abc-123_x.y')
  assert.throws(() => validateSlug('bad slug'), /slug/)
  assert.throws(() => validateSlug('中文'), /slug/)
})

// ── save + createGroup ────────────────────────────────────────────────

test('save + createGroup：一步建组并写入，插在 Older 标记之前', () => {
  withStore((store, root) => {
    const result = store.save('brand-new', '第一条', '2026-10-23', {
      createGroup: true,
      title: '新组',
    })
    assert.equal(result.created, true)
    assert.equal(result.slug, 'brand-new')

    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.match(route, /## brand-new（新组）/)
    assert.match(route, /- 2026-10-23 第一条/)
    const atNew = route.indexOf('## brand-new')
    const atOlder = route.indexOf('### Older Memory Topics')
    assert.ok(atNew > 0 && atNew < atOlder, '新组应插在 Older 标记之前')

    // 再存一条同组，不应重复建组
    const again = store.save('brand-new', '第二条', '2026-10-23')
    assert.equal(again.created, false)
    const groups = store.groups().filter((g) => g.slug === 'brand-new')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].entries, 2)
  })
})

test('save：不传 createGroup 时仍然报错并列出可选族', () => {
  withStore((store) => {
    assert.throws(() => store.save('missing', 'x'), /没有名为「missing」/)
  })
})

test('save：createGroup 时非法 slug 被拒绝', () => {
  withStore((store) => {
    assert.throws(
      () => store.save('bad slug', 'x', undefined, { createGroup: true }),
      /slug/,
    )
  })
})

// ── forget ────────────────────────────────────────────────────────────

test('forget：按内容删除，其余条目保留', () => {
  withStore((store, root) => {
    const result = store.forget('env', 'alpha')
    assert.match(result.removed, /alpha/)
    assert.equal(result.line, 5)
    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.ok(!route.includes('alpha'))
    assert.ok(route.includes('beta'))
  })
})

test('forget：按行号删除', () => {
  withStore((store, root) => {
    const result = store.forget('env', 6)
    assert.match(result.removed, /beta/)
    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.ok(route.includes('alpha'))
    assert.ok(!route.includes('beta'))
  })
})

test('forget：越界行号与未命中内容都拒绝，且不改文件', () => {
  withStore((store, root) => {
    const before = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.throws(() => store.forget('env', 1), /不是任务族/)
    assert.throws(() => store.forget('env', 8), /不是任务族/)
    assert.throws(() => store.forget('env', '不存在的词'), /没有包含/)
    assert.equal(readFileSync(join(root, 'MEMORY.md'), 'utf8'), before)
  })
})

// ── archive ───────────────────────────────────────────────────────────

test('archive：从路由层移除并落盘到 archive/', () => {
  withStore((store, root) => {
    const result = store.archive('env', 'alpha')
    assert.ok(existsSync(result.file))
    assert.match(result.file, /archive\/\d{4}-\d{2}-\d{2}-archived\.md$/)
    const archived = readFileSync(result.file, 'utf8')
    assert.match(archived, /## env/)
    assert.match(archived, /alpha/)
    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.ok(!route.includes('alpha'))
    assert.ok(route.includes('beta'))
  })
})

test('archive：追加到同一个按日期归档文件而不是覆盖', () => {
  withStore((store, root) => {
    const first = store.archive('env', 'alpha')
    const second = store.archive('env', 'beta')
    assert.equal(first.file, second.file)
    const archived = readFileSync(first.file, 'utf8')
    assert.match(archived, /alpha/)
    assert.match(archived, /beta/)
  })
})

// ── pending / curate ──────────────────────────────────────────────────

test('pending / curate：读取、归档、清空', () => {
  withStore((store) => {
    assert.equal(store.pending().count, 0)
    store.enqueue({ id: 's1', title: '会话一' })
    store.enqueue({ id: 's2', title: '会话二' })
    const pending = store.pending()
    assert.equal(pending.count, 2)
    assert.equal(pending.rows[0].sessionId, 's1')

    const curated = store.curate()
    assert.equal(curated.moved, 2)
    assert.ok(existsSync(curated.file))
    assert.equal(store.pending().count, 0)

    const archived = readFileSync(curated.file, 'utf8').trim().split('\n')
    assert.equal(archived.length, 2)
    assert.equal(JSON.parse(archived[0]).sessionId, 's1')
    // 归档后还能继续入队新会话
    store.enqueue({ id: 's3' })
    assert.equal(store.pending().count, 1)
  })
})

test('curate：空队列安全返回', () => {
  withStore((store) => {
    const result = store.curate()
    assert.equal(result.moved, 0)
    assert.equal(result.file, null)
  })
})

// ── search 打分 ───────────────────────────────────────────────────────

test('search：完整命中的条目排在零散 token 命中之前', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-score-'))
  try {
    mkdirSync(join(root, 'summaries'), { recursive: true })
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n', 'utf8')
    writeFileSync(
      join(root, 'MEMORY.md'),
      [
        '# MEMORY',
        '',
        '## a',
        '',
        '- 2026-10-01 这里只提到 tailscale 一个词',
        '- 2026-10-02 tailscale 和记忆系统都在这行里',
        '',
      ].join('\n'),
      'utf8',
    )
    const store = createStore({ root })
    const result = store.search('tailscale 记忆系统')
    assert.ok(result.hits.length >= 2)
    assert.match(result.hits[0].text, /记忆系统/, '两个 token 都命中的行应排第一')
    assert.ok(
      result.hits[0].score > result.hits[1].score,
      `分数应递减：${result.hits.map((h) => h.score).join(' > ')}`,
    )
    for (let i = 1; i < result.hits.length; i++) {
      assert.ok(result.hits[i - 1].score >= result.hits[i].score)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search：中文两字词可命中 bigram', () => {
  withStore((store) => {
    const result = store.search('任务')
    // fixture 里没有“任务”，应无命中或分数很低
    assert.equal(result.total, 0)
    const hit = store.search('alpha')
    assert.ok(hit.total >= 1)
    assert.match(hit.hits[0].text, /alpha/)
  })
})

// ── 并发写保护 ────────────────────────────────────────────────────────

test('并发：两个进程同时 save，两条都不丢', async () => {
  const root = fixture()
  const writer = join(root, 'writer.mjs')
  writeFileSync(
    writer,
    `import { createStore } from ${JSON.stringify(STORE_PATH)}
const store = createStore({ root: ${JSON.stringify(root)} })
store.save('env', process.argv[2], '2026-10-23')
`,
    'utf8',
  )
  try {
    await Promise.all([
      execFileAsync(process.execPath, [writer, 'concurrent-A']),
      execFileAsync(process.execPath, [writer, 'concurrent-B']),
      execFileAsync(process.execPath, [writer, 'concurrent-C']),
    ])
    const route = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    for (const tag of ['concurrent-A', 'concurrent-B', 'concurrent-C']) {
      assert.ok(route.includes(tag), `并发写入丢了 ${tag}`)
    }
    // 锁文件必须清理干净
    assert.equal(existsSync(join(root, 'MEMORY.md.lock')), false, '锁文件未清理')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search：稀有词权重高于高频词（IDF）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-idf-'))
  try {
    mkdirSync(join(root, 'summaries'), { recursive: true })
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n', 'utf8')
    const lines = ['# MEMORY', '', '## a', '']
    // 20 行都含「记忆」，只有最后一行含「zstd」
    for (let i = 0; i < 20; i++) lines.push(`- 2026-10-01 记忆条目第 ${i} 条`)
    lines.push('- 2026-10-02 zstd 解压这件事只出现过一次')
    writeFileSync(join(root, 'MEMORY.md'), lines.join('\n'), 'utf8')

    const store = createStore({ root })
    const result = store.search('记忆 zstd')
    assert.ok(result.total >= 2)
    assert.match(result.hits[0].text, /zstd/, '含稀有词的条目应排第一')
    // 那一行只含 zstd、不含「记忆」，所以 matched=1；能排第一正说明稀有词权重够高
    assert.equal(result.hits[0].matched, 1, '该行只命中稀有词')
    assert.ok(
      result.hits[0].score > result.hits[1].score,
      `稀有词行应更高分：${result.hits.map((h) => h.score).join(' > ')}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search：子串命中仍能返回（sqlite 命中 sqlite3）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-substr-'))
  try {
    mkdirSync(join(root, 'summaries'), { recursive: true })
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n', 'utf8')
    writeFileSync(
      join(root, 'MEMORY.md'),
      '# MEMORY\n\n## a\n\n- 2026-10-01 sqlite3 直接打不开\n',
      'utf8',
    )
    const store = createStore({ root })
    const result = store.search('sqlite')
    assert.equal(result.total, 1, 'token 切碎后仍应通过子串命中')
    assert.match(result.hits[0].text, /sqlite3/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search：文件改动后缓存失效，能搜到新内容', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    mkdirSync(join(root, 'summaries'), { recursive: true })
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n', 'utf8')
    const route = join(root, 'MEMORY.md')
    writeFileSync(route, '# MEMORY\n\n## a\n\n- 2026-10-01 alpha\n', 'utf8')
    const store = createStore({ root })
    // 用不共享 bigram 的英文词，避免「内容」这类公共片段干扰断言
    assert.equal(store.search('alpha').total, 1)
    assert.equal(store.search('zulu').total, 0)

    // 改文件：mtime/size 变化应让缓存失效
    writeFileSync(route, '# MEMORY\n\n## a\n\n- 2026-10-02 zulu 来了\n', 'utf8')
    assert.equal(store.search('zulu').total, 1, '缓存必须失效才能搜到新内容')
    assert.equal(store.search('alpha').total, 0, '旧内容不应再命中')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inbox：精确文件名优先于模糊匹配', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inbox-name-'))
  try {
    const dir = join(root, 'inbox')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-10-01-aaa.md'), 'AAA', 'utf8')
    writeFileSync(join(dir, '2026-10-02-aaaa.md'), 'AAAA', 'utf8')
    const store = createStore({ root })
    // 精确名应命中第一个，而不是包含它的第二个
    assert.equal(store.readInbox('2026-10-01-aaa.md').text, 'AAA')
    // 模糊片段仍然可用
    assert.equal(store.readInbox('02-aaaa').text, 'AAAA')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('usage：recall 后计数与时间被记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
  try {
    mkdirSync(join(root, 'summaries'), { recursive: true })
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n', 'utf8')
    writeFileSync(
      join(root, 'MEMORY.md'),
      '# MEMORY\n\n## env\n\n- 2026-10-01 alpha\n\n## tools\n\n- 2026-10-02 beta\n',
      'utf8',
    )
    const store = createStore({ root })

    const before = store.usage()
    assert.equal(before.rows.length, 0)
    assert.deepEqual(before.neverUsed.sort(), ['env', 'tools'])

    store.recall('env')
    store.recall('env')
    const after = store.usage()
    const env = after.rows.find((r) => r.slug === 'env')
    assert.ok(env, 'env 应有用量记录')
    assert.equal(env.count, 2)
    assert.ok(env.lastUsed && Date.parse(env.lastUsed) > 0)
    assert.deepEqual(after.neverUsed, ['tools'], 'tools 仍未使用')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('usage：用量文件损坏时安全降级', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usage-bad-'))
  try {
    mkdirSync(join(root, 'summaries'), { recursive: true })
    writeFileSync(join(root, 'memory_summary.md'), '# 索引\n', 'utf8')
    writeFileSync(join(root, 'MEMORY.md'), '# MEMORY\n\n## env\n\n- 2026-10-01 alpha\n', 'utf8')
    writeFileSync(join(root, 'usage.json'), '{ 坏掉的 json', 'utf8')
    const store = createStore({ root })
    assert.doesNotThrow(() => store.recall('env'))
    const usage = store.usage()
    assert.equal(usage.totalGroups, 1)
    assert.equal(usage.rows.length, 1, '坏文件应被重建而不是崩溃')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
