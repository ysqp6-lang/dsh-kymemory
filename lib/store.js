import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Expand a leading `~` to the user's home directory. */
export function expandHome(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return join(homedir(), '.dsh', 'memory')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/** Today as `YYYY-MM-DD` in local time. */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let out = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    out += char
  }
  return out
}

/** Byte length of a string in UTF-8. */
export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/**
 * Split the route file into task-group blocks.
 * Returns `[{ slug, title, head, end }]` where `head` is the `## slug` line index.
 */
export function parseGroups(lines) {
  const groups = []
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      if (current) {
        current.end = i
        groups.push(current)
      }
      const raw = line.slice(3).trim()
      const slug = raw.split('（')[0].split('(')[0].trim()
      current = { slug, title: raw, head: i }
    }
  }
  if (current) {
    current.end = lines.length
    groups.push(current)
  }
  return groups
}

function findGroup(lines, slug) {
  const needle = String(slug ?? '').trim().toLowerCase()
  return parseGroups(lines).find((g) => g.slug.toLowerCase() === needle) ?? null
}

/** Insert one dated bullet into a group, keeping the block's trailing layout stable. */
export function insertEntry(lines, group, entry) {
  let lastBullet = -1
  for (let i = group.head + 1; i < group.end; i++) {
    if (lines[i].startsWith('- ')) lastBullet = i
  }
  if (lastBullet >= 0) {
    let at = lastBullet + 1
    while (at < group.end && /^[ \t]/.test(lines[at])) at++
    lines.splice(at, 0, entry)
    return lines
  }
  let at = group.head + 1
  while (at < group.end && lines[at].trim() === '') at++
  lines.splice(at, 0, entry)
  return lines
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * Create a memory store bound to one root directory.
 *
 * All reads are lazy (nothing is cached), so an edit made by a text editor or by
 * another session shows up on the next tool call or prompt assembly.
 */
export function createStore(config = {}) {
  const root = expandHome(config.root)
  const summaryFile = config.summaryFile ?? 'memory_summary.md'
  const routeFile = config.routeFile ?? 'MEMORY.md'
  const evidenceDir = config.evidenceDir ?? 'summaries'
  const maxIndexBytes = Number(config.maxIndexBytes ?? 4096)
  const injectIndex = config.injectIndex !== false

  const summaryPath = () => join(root, summaryFile)
  const routePath = () => join(root, routeFile)
  const evidencePath = () => join(root, evidenceDir)
  const pendingPath = () => join(root, 'pending.jsonl')

  function readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }

  function evidenceFiles() {
    const dir = evidencePath()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => ({ label: `${evidenceDir}/${name}`, path: join(dir, name) }))
  }

  return {
    root,

    /** Raw index file contents (may be empty). */
    readIndex() {
      return readText(summaryPath())
    },

    /**
     * The text injected into the system prompt: a short usage header plus the
     * index body, truncated to `maxIndexBytes`.
     */
    renderIndex() {
      if (!injectIndex) return ''
      const body = readText(summaryPath())
      if (!body.trim()) return ''
      const header =
        '# 本地记忆索引（dsh-kymemory）\n\n' +
        '跨会话记忆的索引层。需要细节时用 memory_recall（取整族）或 memory_search（跨层检索），不要凭空猜。\n\n'
      const budget = maxIndexBytes - byteLength(header)
      if (budget <= 0) return truncateUtf8(header, maxIndexBytes)
      if (byteLength(body) <= budget) return header + body.trimEnd()
      const notice = '\n\n…（索引超出 maxIndexBytes，已截断；用 memory_search 检索完整内容）'
      const room = budget - byteLength(notice)
      if (room <= 0) return header + truncateUtf8(notice, budget)
      return header + truncateUtf8(body, room).trimEnd() + notice
    },

    /** All task groups with their entry counts. */
    groups() {
      const lines = readText(routePath()).split('\n')
      return parseGroups(lines).map((g) => ({
        slug: g.slug,
        title: g.title,
        entries: lines
          .slice(g.head + 1, g.end)
          .filter((line) => line.startsWith('- ')).length,
      }))
    },

    /** Full route-layer text of one task group. */
    recall(slug) {
      const lines = readText(routePath()).split('\n')
      const group = findGroup(lines, slug)
      if (!group) {
        const known = parseGroups(lines).map((g) => g.slug)
        throw new Error(
          `没有名为「${slug}」的任务族。现有：${known.join(', ') || '（无）'}`,
        )
      }
      return {
        slug: group.slug,
        title: group.title,
        text: lines.slice(group.head, group.end).join('\n').trim(),
      }
    },

    /** Keyword search across the route layer and the evidence layer. */
    search(query, limit = 20) {
      const needle = String(query ?? '').trim().toLowerCase()
      if (!needle) throw new Error('query 不能为空')
      const files = [{ label: routeFile, path: routePath() }, ...evidenceFiles()]
      const hits = []
      for (const file of files) {
        const text = readText(file.path)
        if (!text) continue
        text.split('\n').forEach((line, index) => {
          if (line.toLowerCase().includes(needle)) {
            hits.push({ file: file.label, line: index + 1, text: line.trim() })
          }
        })
      }
      const cap = Math.max(1, Number(limit) || 20)
      return {
        query: String(query),
        total: hits.length,
        returned: Math.min(hits.length, cap),
        hits: hits.slice(0, cap),
      }
    },

    /** Append one dated memorized fact to a task group. */
    save(slug, text, date) {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('text 不能为空')
      const stamp = date && DATE_RE.test(date) ? date : today()
      const path = routePath()
      if (!existsSync(path)) {
        throw new Error(
          `路由层文件不存在：${path}。请先创建目录结构，或把 root 指向已有记忆目录。`,
        )
      }
      const lines = readText(path).split('\n')
      const group = findGroup(lines, slug)
      if (!group) {
        const known = parseGroups(lines).map((g) => g.slug)
        throw new Error(
          `没有名为「${slug}」的任务族。现有：${known.join(', ') || '（无）'}。` +
            `先用 memory_save 的 createGroup 选项或手工新建。`,
        )
      }
      insertEntry(lines, group, `- ${stamp} ${body.replace(/\s*\n\s*/g, ' ')}`)
      atomicWrite(path, lines.join('\n'))
      return { slug: group.slug, entry: `- ${stamp} ${body}` }
    },

    /** Create a new task group before the `### Older Memory Topics` marker. */
    createGroup(slug, title) {
      const clean = String(slug ?? '').trim()
      if (!/^[a-zA-Z0-9._-]+$/.test(clean)) {
        throw new Error('slug 只能包含字母、数字、点、下划线和连字符')
      }
      const path = routePath()
      const lines = readText(path).split('\n')
      const existing = findGroup(lines, clean)
      if (existing) return { slug: existing.slug, created: false }
      let at = lines.length
      const marker = lines.findIndex((line) => line.startsWith('### Older Memory Topics'))
      if (marker >= 0) at = marker
      const header = title && title !== clean ? `## ${clean}（${title}）` : `## ${clean}`
      const block = at === lines.length ? ['', header, ''] : [header, '']
      lines.splice(at, 0, ...block)
      atomicWrite(path, lines.join('\n'))
      return { slug: clean, created: true }
    },

    /** Size report plus the same limits the CLI enforces. */
    stats() {
      const indexText = readText(summaryPath())
      const routeText = readText(routePath())
      const routeLines = routeText.split('\n')
      const groups = parseGroups(routeLines)
      return {
        root,
        index: { lines: indexText.split('\n').length, bytes: byteLength(indexText) },
        route: {
          lines: routeLines.length,
          bytes: byteLength(routeText),
          groups: groups.length,
          entries: routeLines.filter((line) => line.startsWith('- ')).length,
        },
        evidence: evidenceFiles().length,
        limits: { maxIndexBytes },
        indexWithinLimit: byteLength(indexText) <= maxIndexBytes,
      }
    },

    /**
     * Append a closed session id to `pending.jsonl` for the periodic curation
     * pass. Idempotent per session id, capped at 500 rows.
     */
    enqueue(session) {
      const sessionId =
        typeof session === 'string' ? session : String(session?.id ?? session?.sessionId ?? '')
      if (!sessionId) return { enqueued: false, reason: 'missing session id' }
      const path = pendingPath()
      let rows = []
      const existing = readText(path)
      if (existing.trim()) {
        rows = existing
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          })
          .filter(Boolean)
      }
      if (rows.some((row) => row.sessionId === sessionId)) {
        return { enqueued: false, reason: 'already queued' }
      }
      rows.push({
        at: new Date().toISOString(),
        sessionId,
        name: typeof session === 'object' ? String(session?.title ?? session?.name ?? '') : '',
        state: 'pending',
      })
      if (rows.length > 500) rows = rows.slice(rows.length - 500)
      atomicWrite(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
      return { enqueued: true, sessionId, queued: rows.length }
    },

    /**
     * Health check for the memory itself — the part every other plugin skips.
     *
     * Read-only: reports what to fix instead of mutating anything. Checks that
     * caught real breakage in practice: duplicate task groups (a second `## slug`
     * silently shadows the first for memory_recall), an over-budget index, entries
     * missing their date prefix, orphaned evidence files, dead routes in the index,
     * and verbatim duplicate bullets.
     */
    doctor() {
      const issues = []
      const routeText = readText(routePath())
      const lines = routeText.split('\n')
      const groups = parseGroups(lines)
      const indexText = readText(summaryPath())
      const push = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra })
      const MAX_LISTED = 10

      // 1. 重复任务族：同 slug 多个 `##` 块，memory_recall 只会读到第一块
      const bySlug = new Map()
      for (const g of groups) {
        const key = g.slug.toLowerCase()
        if (!bySlug.has(key)) bySlug.set(key, [])
        bySlug.get(key).push(g)
      }
      for (const [slug, list] of bySlug) {
        if (list.length > 1) {
          push(
            'error',
            'duplicate-group',
            `任务族「${slug}」有 ${list.length} 个同名块（第 ${list.map((g) => g.head + 1).join('、')} 行），memory_recall 只能读到第一个`,
            { slug, heads: list.map((g) => g.head + 1) },
          )
        }
      }

      // 2. 索引预算
      const indexBytes = byteLength(indexText)
      const indexLines = indexText.trim() ? indexText.split('\n').length : 0
      if (indexBytes > maxIndexBytes) {
        push('error', 'index-over-budget', `索引 ${indexBytes} 字节，超过上限 ${maxIndexBytes}；把细节下沉到 MEMORY.md`, {
          bytes: indexBytes,
          limit: maxIndexBytes,
        })
      }
      if (indexLines > 80) {
        push('warn', 'index-too-long', `索引 ${indexLines} 行，超过建议的 80 行`, { lines: indexLines })
      }

      // 3/4. 空族、过大族、缺日期
      let missingDate = 0
      for (const g of groups) {
        const bullets = lines.slice(g.head + 1, g.end).filter((l) => l.startsWith('- '))
        if (bullets.length === 0) {
          push('warn', 'empty-group', `任务族「${g.slug}」没有任何条目`, { slug: g.slug })
        } else if (bullets.length > 40) {
          push('warn', 'large-group', `任务族「${g.slug}」有 ${bullets.length} 条，建议把细节拆到 summaries/`, {
            slug: g.slug,
            count: bullets.length,
          })
        }
        for (let i = g.head + 1; i < g.end; i++) {
          const line = lines[i]
          if (!line.startsWith('- ')) continue
          if (!/^- \d{4}-\d{2}-\d{2}\s/.test(line)) {
            missingDate += 1
            if (missingDate <= MAX_LISTED) {
              push('warn', 'missing-date', `第 ${i + 1} 行缺少日期前缀：${line.slice(0, 48)}`, { line: i + 1 })
            }
          }
        }
      }
      if (missingDate > MAX_LISTED) {
        push('warn', 'missing-date-more', `另有 ${missingDate - MAX_LISTED} 行同样缺少日期前缀`)
      }

      // 5. 孤儿证据：summaries/ 里有文件，但 MEMORY.md 没引用
      const routeLower = routeText.toLowerCase()
      for (const file of evidenceFiles()) {
        if (!routeLower.includes(file.label.toLowerCase())) {
          push('warn', 'orphan-evidence', `证据文件 ${file.label} 没有被 MEMORY.md 引用`, { file: file.label })
        }
      }

      // 6. 失效路由：索引里 `#slug` 指向不存在的族
      // 只扫以 `- ` 开头的路由条目，否则索引顶部那句「路由中的 `#xxx` 均指…」
      // 这类说明文字会被误判成一条失效路由。
      const known = new Set(groups.map((g) => g.slug.toLowerCase()))
      const refs = new Set()
      for (const line of indexText.split('\n')) {
        if (!line.trim().startsWith('- ')) continue
        for (const m of line.matchAll(/`#([A-Za-z0-9._-]+)`/g)) refs.add(m[1].toLowerCase())
      }
      for (const ref of refs) {
        if (!known.has(ref)) push('warn', 'dead-route', `索引中的 \`#${ref}\` 指向不存在的任务族`, { slug: ref })
      }

      // 7. 完全重复的条目
      const seen = new Map()
      let dupes = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line.startsWith('- ')) continue
        if (seen.has(line)) {
          dupes += 1
          if (dupes <= MAX_LISTED) {
            push('warn', 'duplicate-entry', `第 ${i + 1} 行与第 ${seen.get(line) + 1} 行完全相同`, { line: i + 1 })
          }
        } else {
          seen.set(line, i)
        }
      }

      const error = issues.filter((i) => i.level === 'error').length
      const warn = issues.filter((i) => i.level === 'warn').length
      return {
        ok: error === 0,
        checked: {
          groups: groups.length,
          entries: lines.filter((l) => l.startsWith('- ')).length,
          evidence: evidenceFiles().length,
          indexBytes,
          indexLines,
        },
        counts: { error, warn },
        issues,
      }
    },

    /** Raw path accessors — handy for tests and for the README examples. */
    paths: { summary: summaryPath, route: routePath, evidence: evidencePath, pending: pendingPath },
  }
}
