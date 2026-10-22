import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { today } from './store.js'

/** zstd frame magic number, little-endian (0xFD2FB528). */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress the last `maxFrames` frames of a multi-frame zstd file.
 *
 * DSH writes one zstd frame per append, so a 5 MB transcript is thousands of
 * frames — and Node's `zstdDecompressSync` only decodes the first one. Walking
 * magic numbers backwards from the end gives us the recent conversation at a few
 * milliseconds of cost instead of decoding the entire history into memory.
 */
export function decompressTailFrames(buf, maxFrames = 300) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return Buffer.alloc(0)
  const starts = []
  let pos = buf.length - 4
  while (pos >= 0 && starts.length <= maxFrames) {
    const at = buf.lastIndexOf(MAGIC, pos)
    if (at < 0) break
    starts.unshift(at)
    pos = at - 4
  }
  if (starts.length === 0) {
    // 单帧文件（没有 magic 前缀的边角情况）：整体试一次
    try {
      return zstdDecompressSync(buf)
    } catch {
      return Buffer.alloc(0)
    }
  }
  const parts = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      /* 尾部可能有不完整的帧（正在写入），跳过 */
    }
  }
  return Buffer.concat(parts)
}


/**
 * Read the tail of a file without loading the whole thing.
 *
 * A transcript only grows by appending, and capture needs the recent frames —
 * so for anything past `maxBytes` we read the last chunk and cut to the first
 * frame boundary. Keeps memory flat even when a session file reaches tens of MB.
 */
export function readFileTail(path, maxBytes = 4 * 1024 * 1024) {
  const size = statSync(path).size
  if (size <= maxBytes) return readFileSync(path)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    readSync(fd, buf, 0, maxBytes, size - maxBytes)
    const firstMagic = buf.indexOf(MAGIC)
    return firstMagic > 0 ? buf.subarray(firstMagic) : buf
  } finally {
    closeSync(fd)
  }
}

/** Locate one session's archive under `<sessionsRoot>/<workspace>/<sessionDir>/`. */
export function findSessionArchive(sessionsRoot, sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!id || !existsSync(sessionsRoot)) return null
  const bare = id.replace(/^session-/, '')
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot)
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    const wsPath = join(sessionsRoot, workspace)
    try {
      if (!statSync(wsPath).isDirectory()) continue
    } catch {
      continue
    }
    let dirs = []
    try {
      dirs = readdirSync(wsPath)
    } catch {
      continue
    }
    // 精确匹配：includes 会让 "abc" 误中 "session-abcdef"
    const wanted = new Set([bare, `session-${bare}`])
    for (const dir of dirs) {
      if (!wanted.has(dir)) continue
      const candidate = join(wsPath, dir, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Pull the pieces worth remembering out of a session transcript.
 *
 * Only user messages and compaction summaries are kept: assistant chatter and
 * tool payloads are mostly noise, and the point of the inbox is to hand the
 * next session a short, honest brief rather than the whole log.
 */
export function extractTranscript(text, { maxChars = 4000 } = {}) {
  const messages = []
  const summaries = []
  let title = ''
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event?.data ?? {}
    if (event.type === 'session/title' && typeof data.title === 'string') {
      title = data.title
    } else if (event.type === 'user/message' && data.source?.kind === 'user') {
      const body = textOf(data.content)
      if (body) messages.push(body)
    } else if (event.type === 'compaction/summary') {
      const body = textOf(data.summary ?? data.content)
      if (body) summaries.push(body)
    }
  }

  // 只保留尾部内容：越靠后越接近会话结论
  let body = ''
  const chunks = []
  if (title) chunks.push(`标题：${title}`)
  if (summaries.length) chunks.push(`\n## 会话摘要\n${summaries.slice(-2).join('\n\n')}`)
  if (messages.length) {
    chunks.push(`\n## 用户原话\n${messages.map((m) => `- ${m}`).join('\n')}`)
  }
  body = chunks.join('\n').trim()
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n…（已截断）`

  return { title, messages, summaries, body, messageCount: messages.length }
}

/**
 * Read one closed session and turn it into an inbox capture object.
 * Returns `null` when there is nothing worth capturing.
 */
export function captureSession({
  sessionsRoot = join(homedir(), '.dsh', 'sessions'),
  sessionId,
  title = '',
  cwd = '',
  maxFrames = 300,
  maxChars = 4000,
  minMessages = 2,
} = {}) {
  const archive = findSessionArchive(sessionsRoot, sessionId)
  if (!archive) return { skipped: 'archive-not-found', sessionId }
  let raw
  try {
    raw = decompressTailFrames(readFileTail(archive), maxFrames).toString('utf8')
  } catch (error) {
    return { skipped: `decompress-failed: ${error.message}`, sessionId }
  }
  const extracted = extractTranscript(raw, { maxChars })
  if (extracted.messageCount < minMessages) {
    return { skipped: `too-short (${extracted.messageCount} msgs)`, sessionId }
  }
  return {
    sessionId: String(sessionId),
    title: title || extracted.title,
    cwd,
    capturedAt: new Date().toISOString(),
    messageCount: extracted.messageCount,
    summaryCount: extracted.summaries.length,
    body: extracted.body,
    archive,
  }
}

/** Render a capture as the Markdown body of an inbox file. */
export function renderInbox(capture) {
  return [
    '---',
    `session: ${capture.sessionId}`,
    `title: ${capture.title || '（无标题）'}`,
    `cwd: ${capture.cwd || ''}`,
    `captured: ${capture.capturedAt}`,
    `messages: ${capture.messageCount}`,
    `summaries: ${capture.summaryCount}`,
    'status: pending',
    '---',
    '',
    '# 候选记忆素材',
    '',
    '> 这是会话关闭时自动收集的素材，尚未进入 MEMORY.md。',
    '> 用 memory_save 提炼入库后，再用 memory_promote 归档本文件。',
    '',
    capture.body,
    '',
  ].join('\n')
}

/**
 * Write one capture into `<root>/inbox/`, then trim the queue to `keep` files
 * (oldest archived) so an unattended machine cannot accumulate thousands.
 */
export function writeInbox(root, capture, { keep = 50 } = {}) {
  const dir = join(root, 'inbox')
  mkdirSync(dir, { recursive: true })
  const safeId = String(capture.sessionId).replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = join(dir, `${today()}-${safeId}.md`)
  writeFileSync(file, renderInbox(capture), 'utf8')

  if (keep > 0) {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
    // 两种淘汰：超过 30 天没人处理，或数量超过上限（保留最新的 keep 个）
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    const doomed = new Set(files.filter((name) => name.slice(0, 10) < cutoff))
    const excess = files.length - keep
    if (excess > 0) for (const name of files.slice(0, excess)) doomed.add(name)

    if (doomed.size > 0) {
      const archiveDir = join(dir, 'archive')
      mkdirSync(archiveDir, { recursive: true })
      for (const name of doomed) {
        try {
          renameSync(join(dir, name), join(archiveDir, name))
        } catch {
          /* 已被其他进程归档 */
        }
      }
    }
  }
  return file
}
