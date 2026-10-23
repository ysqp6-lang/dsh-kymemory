import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
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

/** Block the thread for `ms` (the only synchronous sleep available in Node). */
function sleepSync(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Split text into searchable tokens: latin words kept whole, CJK runs cut into
 * overlapping bigrams. Bigrams are what makes Chinese substring matching behave
 * like word matching without shipping a dictionary.
 */
export function tokenize(text) {
  const tokens = new Set()
  const lower = String(text ?? '').toLowerCase()
  if (!lower) return tokens
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.-]*/g)) {
    if (m[0].length > 1) tokens.add(m[0])
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

/**
 * Run `fn` while holding an exclusive `<target>.lock`.
 *
 * Two sessions saving memory at the same time would otherwise read-modify-write
 * the same file and silently drop one write. Stale locks (a crashed writer) are
 * reclaimed after 10s so a wrecked run cannot wedge the store forever.
 */
function withLock(target, fn, { retries = 12, waitMs = 20 } = {}) {
  const lockPath = `${target}.lock`
  mkdirSync(dirname(target), { recursive: true })
  let fd = null
  for (let attempt = 0; attempt <= retries && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath)
      } catch {
        /* 锁刚好被释放，下一轮直接抢 */
      }
      sleepSync(waitMs * Math.min(attempt + 1, 8))
    }
  }
  if (fd === null) {
    throw new Error(`无法获取写锁 ${lockPath}：另一个会话正在写入，稍后重试`)
  }
  try {
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 已关闭 */
    }
    try {
      unlinkSync(lockPath)
    } catch {
      /* 已被清理 */
    }
  }
}

/**
 * Locate one bullet inside a group: `match` is either a 1-based line number or a
 * substring of the bullet's text. Line numbers are validated to be inside the
 * group so a mis-aimed number can never delete someone else's memory.
 */
export function findEntryIndex(lines, group, match) {
  const bullets = []
  for (let i = group.head + 1; i < group.end; i++) {
    if (lines[i].startsWith('- ')) bullets.push(i)
  }
  if (typeof match === 'number' && Number.isFinite(match)) {
    const index = Math.trunc(match) - 1
    if (!bullets.includes(index)) {
      throw new Error(`第 ${match} 行不是任务族「${group.slug}」里的条目`)
    }
    return index
  }
  const needle = String(match ?? '').trim()
  if (!needle) throw new Error('需要提供条目内容片段或行号')
  const hit = bullets.find((i) => lines[i].includes(needle))
  if (hit === undefined) {
    throw new Error(`任务族「${group.slug}」里没有包含「${needle}」的条目`)
  }
  return hit
}

/**
 * Trim the index before injection: drop `>` boilerplate lines and collapse blank
 * runs. Same byte budget then carries more actual signal.
 */
export function compactIndex(text) {
  const out = []
  let blank = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed.startsWith('>')) continue
    if (trimmed === '') {
      if (blank) continue
      blank = true
      out.push('')
      continue
    }
    blank = false
    out.push(line)
  }
  return out.join('\n').trim()
}

/** Validate a task-group slug; shared by createGroup and save({ createGroup }). */
export function validateSlug(slug) {
  const clean = String(slug ?? '').trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(clean)) {
    throw new Error('slug 只能包含字母、数字、点、下划线和连字符')
  }
  return clean
}


/**
 * Per-file token cache keyed by (mtimeMs, size).
 *
 * Search tokenizes every line; on a 300-entry memory that costs ~3ms per call.
 * Caching the token sets per unchanged file makes repeat searches near-free
 * while still noticing edits (a save bumps mtime/size).
 */
const tokenCache = new Map()
const TOKEN_CACHE_MAX = 50

function tokenizedLines(path, text) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return text.split('\n').map((line) => ({ text: line.trim(), tokens: tokenize(line) }))
  }
  const hit = tokenCache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.lines
  const lines = text.split('\n').map((line) => ({ text: line.trim(), tokens: tokenize(line) }))
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value)
  tokenCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, lines })
  return lines
}


/** Jaccard similarity between two token sets (0..1). */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Words that flip the meaning of a memory. Two near-identical bullets where only
 * one carries a negation is the classic "pnpm vs 不用 pnpm" contradiction.
 */
export const NEGATION_RE = /(不用|不要|禁用|禁止|放弃|不再|不再用|取消|废弃|改为|改成|换成|停止|错误|不对|不是)/

/** Strip the leading `- YYYY-MM-DD ` so comparisons focus on content. */
export function stripDate(line) {
  return String(line ?? '').replace(/^-\s*\d{4}-\d{2}-\d{2}\s*/, '')
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
  const usagePath = () => join(root, 'usage.json')

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
      const body = compactIndex(readText(summaryPath()))
      if (!body) return ''
      const header =
        '# 本地记忆索引（dsh-kymemory）\n\n' +
        '跨会话记忆的索引层。需要细节时用 memory_recall（取整族）或 memory_search（跨层检索），不要凭空猜。\n\n'
      const budget = maxIndexBytes - byteLength(header)
      if (budget <= 0) return truncateUtf8(header, maxIndexBytes)
      const inboxCount = this.inbox().length
      const inboxNote =
        inboxCount > 0
          ? `\n\n> 📥 inbox 有 ${inboxCount} 个待整理候选。做与记忆相关的事之前，` +
            `先用 memory_inbox 读一条，把值得保留的 memory_save 入库，再 memory_promote 归档。`
          : ''
      if (byteLength(body) <= budget) return header + body.trimEnd() + inboxNote
      const notice = '\n\n…（索引超出 maxIndexBytes，已截断；用 memory_search 检索完整内容）'
      const room = budget - byteLength(notice)
      if (room <= 0) return header + truncateUtf8(notice, budget)
      return header + truncateUtf8(body, room).trimEnd() + notice + inboxNote
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
      this.recordRecall(group.slug)
      return {
        slug: group.slug,
        title: group.title,
        text: lines.slice(group.head, group.end).join('\n').trim(),
      }
    },

    /**
     * Search the route and evidence layers.
     *
     * Scoring: a verbatim substring hit is worth most, then each shared token
     * (latin words or CJK bigrams), plus a small bonus for heading lines. Hits
     * are sorted by score so the best match is not buried under a line that
     * merely contains the substring late in the file.
     */
    search(query, limit = 20) {
      const needle = String(query ?? '').trim().toLowerCase()
      if (!needle) throw new Error('query 不能为空')
      const queryTokens = tokenize(needle)
      const files = [{ label: routeFile, path: routePath() }, ...evidenceFiles()]

      // 第一遍：把语料摊平成 docs，并统计每个 token 覆盖了多少行
      const docs = []
      const docFreq = new Map()
      for (const file of files) {
        const text = readText(file.path)
        if (!text) continue
        tokenizedLines(file.path, text).forEach((entry, index) => {
          if (!entry.text || entry.tokens.size === 0) return
          docs.push({ file: file.label, line: index + 1, text: entry.text, tokens: entry.tokens })
          for (const token of entry.tokens) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
        })
      }
      const totalDocs = docs.length
      // 稀有词才有信息量：出现在几乎每一行的词（例如「记忆」）权重被自动压低
      const idf = (token) => Math.log(1 + totalDocs / Math.max(1, docFreq.get(token) ?? 0))

      // 第二遍：IDF 加权 + 覆盖度加成
      const hits = []
      for (const doc of docs) {
        let weight = 0
        let matched = 0
        for (const token of queryTokens) {
          if (!doc.tokens.has(token)) continue
          weight += idf(token)
          matched += 1
        }
        // token 化会把词切碎（sqlite ≠ sqlite3），所以子串命中仍算一条，只是分数较低
        const substringHit = doc.text.toLowerCase().includes(needle)
        if (matched === 0 && !substringHit) continue
        let score = weight + matched * 2
        // 整句子串命中对英文短语、精确标识符特别有效
        if (substringHit) score += 3
        if (doc.text.startsWith('#')) score += 1
        hits.push({
          file: doc.file,
          line: doc.line,
          text: doc.text,
          score: Math.round(score * 100) / 100,
          matched,
        })
      }
      hits.sort((a, b) => b.score - a.score || a.line - b.line)
      const cap = Math.max(1, Number(limit) || 20)
      return {
        query: String(query),
        total: hits.length,
        returned: Math.min(hits.length, cap),
        hits: hits.slice(0, cap),
      }
    },

    /**
     * Append one dated memorized fact to a task group.
     *
     * `options.createGroup` creates the group on the spot instead of failing —
     * the two-step "create then save" flow was the most common friction point.
     * The whole read-modify-write runs under a file lock so two sessions saving
     * at once cannot silently drop one of the writes.
     */
    save(slug, text, date, options = {}) {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('text 不能为空')
      const stamp = date && DATE_RE.test(date) ? date : today()
      const entry = `- ${stamp} ${body.replace(/\s*\n\s*/g, ' ')}`
      const path = routePath()
      const wantCreate = options.createGroup === true

      return withLock(path, () => {
        const lines = readText(path).split('\n')
        let group = findGroup(lines, slug)
        let created = false

        if (!group && wantCreate) {
          const clean = validateSlug(slug)
          let at = lines.length
          const marker = lines.findIndex((line) => line.startsWith('### Older Memory Topics'))
          if (marker >= 0) at = marker
          const title = options.title
          const header = title && title !== clean ? `## ${clean}（${title}）` : `## ${clean}`
          lines.splice(at, 0, header, '')
          group = findGroup(lines, clean)
          created = true
        }

        if (!group) {
          const known = parseGroups(lines).map((g) => g.slug)
          throw new Error(
            `没有名为「${slug}」的任务族。现有：${known.join(', ') || '（无）'}。` +
              `可加 createGroup: true 一步创建。`,
          )
        }

        insertEntry(lines, group, entry)
        atomicWrite(path, lines.join('\n'))
        return { slug: group.slug, entry, created }
      })
    },

    /** Delete one bullet from a group (by substring or 1-based line number). */
    forget(slug, match) {
      const path = routePath()
      return withLock(path, () => {
        const lines = readText(path).split('\n')
        const group = findGroup(lines, slug)
        if (!group) throw new Error(`没有名为「${slug}」的任务族`)
        const index = findEntryIndex(lines, group, match)
        const removed = lines[index]
        lines.splice(index, 1)
        atomicWrite(path, lines.join('\n'))
        return { slug: group.slug, removed, line: index + 1 }
      })
    },

    /**
     * Move one bullet out of the route layer into `archive/YYYY-MM-DD-archived.md`.
     * Archiving keeps history instead of deleting it, which is what the memory
     * protocol asks for when an entry goes stale.
     */
    archive(slug, match) {
      const path = routePath()
      return withLock(path, () => {
        const lines = readText(path).split('\n')
        const group = findGroup(lines, slug)
        if (!group) throw new Error(`没有名为「${slug}」的任务族`)
        const index = findEntryIndex(lines, group, match)
        const removed = lines[index]
        lines.splice(index, 1)
        atomicWrite(path, lines.join('\n'))
        const archiveDir = join(root, 'archive')
        mkdirSync(archiveDir, { recursive: true })
        const file = join(archiveDir, `${today()}-archived.md`)
        const preamble = existsSync(file) ? '' : `# 归档 ${today()}\n\n`
        appendFileSync(file, `${preamble}## ${group.slug}\n\n${removed}\n`, 'utf8')
        return { slug: group.slug, archived: removed, file }
      })
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

      // 8. 疑似矛盾：同族内高度相似、且否定词只在一边
      // 这是记忆最危险的失效方式——两条并存、彼此打脸，agent 无从判断哪条对。
      let conflicts = 0
      for (const g of groups) {
        const bullets = []
        for (let i = g.head + 1; i < g.end; i++) {
          if (!lines[i].startsWith('- ')) continue
          const text = stripDate(lines[i])
          bullets.push({ line: i + 1, text, tokens: tokenize(text) })
        }
        for (let i = 0; i < bullets.length; i++) {
          for (let j = i + 1; j < bullets.length; j++) {
            const a = bullets[i]
            const b = bullets[j]
            const sim = jaccard(a.tokens, b.tokens)
            if (sim < 0.55) continue
            const negA = NEGATION_RE.test(a.text)
            const negB = NEGATION_RE.test(b.text)
            if (negA === negB) continue
            conflicts += 1
            if (conflicts <= MAX_LISTED) {
              push(
                'warn',
                'suspected-conflict',
                `任务族「${g.slug}」第 ${a.line} 行与第 ${b.line} 行高度相似（${(sim * 100).toFixed(0)}%），但否定词只在一边，可能前后矛盾`,
                { slug: g.slug, lines: [a.line, b.line], similarity: Number(sim.toFixed(2)) },
              )
            }
          }
        }
      }
      if (conflicts > MAX_LISTED) {
        push('warn', 'suspected-conflict-more', `另有 ${conflicts - MAX_LISTED} 组疑似矛盾未列出`)
      }

      // 9. 用量视角：从未被 recall 的族、长期没碰的族
      try {
        const usage = this.usage()
        if (usage.neverUsed.length) {
          const shown = usage.neverUsed.slice(0, MAX_LISTED)
          const rest = usage.neverUsed.length - shown.length
          push(
            'info',
            'never-recalled',
            `${usage.neverUsed.length} 个任务族从未被 memory_recall 整族取过：${shown.join('、')}` +
              (rest > 0 ? ` 等 ${rest} 个` : '') +
              `（memory_search 命中同样会用到内容，这不等于没用；用量从本功能上线后开始统计）`,
            { groups: usage.neverUsed },
          )
        }
        if (usage.stale.length) {
          const shown = usage.stale.slice(0, MAX_LISTED)
          const rest = usage.stale.length - shown.length
          push(
            'info',
            'stale-group',
            `${usage.stale.length} 个族超过 90 天没被 recall 过：${shown.join('、')}` + (rest > 0 ? ' 等' : ''),
            { groups: usage.stale },
          )
        }
      } catch {
        /* 用量统计失败不影响体检 */
      }

      const error = issues.filter((i) => i.level === 'error').length
      const warn = issues.filter((i) => i.level === 'warn').length
      const info = issues.filter((i) => i.level === 'info').length
      return {
        ok: error === 0,
        checked: {
          groups: groups.length,
          entries: lines.filter((l) => l.startsWith('- ')).length,
          evidence: evidenceFiles().length,
          indexBytes,
          indexLines,
        },
        counts: { error, warn, info },
        issues,
      }
    },

    /** Sessions queued by session/disposed and not yet curated. */
    pending() {
      const rows = []
      for (const line of readText(pendingPath()).split('\n')) {
        if (!line.trim()) continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          /* 坏行忽略：宁可少报也不要整份失败 */
        }
      }
      return { count: rows.length, rows }
    },

    /**
     * Archive the whole pending queue to `pending.processed.YYYY-MM-DD.jsonl`
     * and clear it, so the next batch of closed sessions starts clean.
     */
    curate() {
      const path = pendingPath()
      if (!existsSync(path)) return { moved: 0, file: null }
      return withLock(path, () => {
        const rows = readText(path).split('\n').filter((line) => line.trim())
        if (rows.length === 0) {
          try {
            unlinkSync(path)
          } catch {
            /* 已不存在 */
          }
          return { moved: 0, file: null }
        }
        const file = join(root, `pending.processed.${today()}.jsonl`)
        appendFileSync(file, rows.join('\n') + '\n', 'utf8')
        try {
          unlinkSync(path)
        } catch {
          /* 已被其他会话清理 */
        }
        return { moved: rows.length, file }
      })
    },

    /** List inbox candidates produced by auto-capture, newest first. */
    inbox() {
      const dir = join(root, 'inbox')
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .reverse()
        .map((name) => {
          const text = readText(join(dir, name))
          const meta = {}
          const front = text.match(/^---\n([\s\S]*?)\n---/)
          if (front) {
            for (const line of front[1].split('\n')) {
              const m = line.match(/^([A-Za-z_]+):\s*(.*)$/)
              if (m) meta[m[1]] = m[2]
            }
          }
          return { name, meta, bytes: byteLength(text) }
        })
    },

    /** Read one inbox candidate; without a name, the newest one. */
    readInbox(name) {
      const dir = join(root, 'inbox')
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse() : []
      if (files.length === 0) throw new Error('inbox 为空：还没有待整理的候选素材')
      const target = name
        ? (files.find((f) => f === name) ?? files.find((f) => f.includes(name)))
        : files[0]
      if (!target) throw new Error(`inbox 里没有匹配「${name}」的文件`)
      return { name: target, text: readText(join(dir, target)) }
    },

    /** Archive a promoted candidate under inbox/archive/ so it is not re-read. */
    promoteInbox(name) {
      const dir = join(root, 'inbox')
      // 两个会话同时归档同一份候选时，rename 会互相踩；用锁串行化
      return withLock(join(root, '.inbox-promote'), () => {
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []
        if (files.length === 0) throw new Error('inbox 为空')
        const target = name
          ? (files.find((f) => f === name) ?? files.find((f) => f.includes(name)))
          : files.sort().reverse()[0]
        if (!target) throw new Error(`inbox 里没有匹配「${name}」的文件`)
        const archiveDir = join(dir, 'archive')
        mkdirSync(archiveDir, { recursive: true })
        renameSync(join(dir, target), join(archiveDir, target))
        return { name: target, remaining: files.length - 1 }
      })
    },

    /** Record that a task group was actually recalled (usage stats only). */
    recordRecall(slug) {
      const key = String(slug ?? '').trim().toLowerCase()
      if (!key) return
      try {
        withLock(usagePath(), () => {
          let data = { version: 1, groups: {} }
          const raw = readText(usagePath())
          if (raw.trim()) {
            try {
              const parsed = JSON.parse(raw)
              if (parsed && typeof parsed === 'object' && parsed.groups) data = parsed
            } catch {
              /* 坏文件重建 */
            }
          }
          const entry = data.groups[key] ?? { count: 0, lastUsed: null }
          entry.count += 1
          entry.lastUsed = new Date().toISOString()
          data.groups[key] = entry
          atomicWrite(usagePath(), JSON.stringify(data, null, 2) + '\n')
        })
      } catch {
        /* 用量统计是尽力而为，绝不能影响 recall 本身 */
      }
    },

    /** Per-group usage rollup plus the groups that were never recalled. */
    usage(days = 90) {
      let data = { version: 1, groups: {} }
      const raw = readText(usagePath())
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && parsed.groups) data = parsed
        } catch {
          /* 坏文件当空 */
        }
      }
      const groups = this.groups()
      const cutoff = Date.now() - days * 86_400_000
      const neverUsed = []
      const stale = []
      const rows = []
      for (const group of groups) {
        const entry = data.groups[group.slug.toLowerCase()]
        if (!entry) {
          neverUsed.push(group.slug)
          continue
        }
        const lastMs = entry.lastUsed ? Date.parse(entry.lastUsed) : 0
        rows.push({ slug: group.slug, count: entry.count, lastUsed: entry.lastUsed })
        if (lastMs < cutoff) stale.push(group.slug)
      }
      rows.sort((a, b) => b.count - a.count)
      return { days, rows, neverUsed, stale, totalGroups: groups.length }
    },

    /** Raw path accessors — handy for tests and for the README examples. */
    paths: {
      summary: summaryPath,
      route: routePath,
      evidence: evidencePath,
      pending: pendingPath,
      archive: () => join(root, 'archive'),
      inbox: () => join(root, 'inbox'),
    },
  }
}
