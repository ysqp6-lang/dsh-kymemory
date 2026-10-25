import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { decompressTailFrames, readFileTail } from './capture.js'

/**
 * 纠正信号：主人在会话里明确表示「你做得不对 / 以后要这样」的措辞。
 * 这些是程序性记忆的原料——比事实更值得沉淀成规则。
 */
export const CORRECTION_RE =
  /(不对|错了|错的|不是这样|应该是|应该用|应该放|不要用|别用|别把|以后都|以后要|改成|漏了|怎么又|还是有问题|还是有|没生效|不生效|重来|你又|说了多少遍|乱了|反了|反的|歪了|没变化|没有变化|消失了|不对齐|有问题|报错|失败|太简|太长|看不懂|重复|冗余|不行|白做|卡住)/

/** 把一条消息的内容块拼成纯文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** 截断到可读长度，保留首尾（首给出场景，尾常是真正的指令）。 */
function clip(text, max = 220) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return `${s.slice(0, max - 40)} … ${s.slice(-35)}`
}

/**
 * 从一段会话 transcript 里提取「被纠正的回合」。
 *
 * 每条候选包含：主人的纠正原话、上一轮助手的做法（作为「被纠正的对象」）、
 * 时间戳。不做判断——是否值得成为规则由下一次会话里的 agent 或主人决定。
 */
export function extractCorrections(transcriptText, { maxPerSession = 12 } = {}) {
  const events = []
  for (const line of String(transcriptText ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 跳过坏行 */
    }
  }

  const found = []
  let lastAssistant = ''
  for (const event of events) {
    const data = event?.data ?? {}
    if (event.type === 'assistant/message') {
      const body = textOf(data.message?.content)
      if (body) lastAssistant = body
      continue
    }
    if (event.type !== 'user/message') continue
    if (data.source?.kind !== 'user') continue
    const said = textOf(data.content)
    if (!said || !CORRECTION_RE.test(said)) continue
    // 精度过滤：排除系统注入与长篇粘贴，纠正通常是人话、且总在回应某个产出之后
    if (!lastAssistant) continue
    if (said.length > 160) continue
    if (/^(You are|System:|【系统|这是一条系统)/.test(said)) continue
    found.push({
      at: event.time ? new Date(event.time).toISOString() : null,
      correction: clip(said),
      wasDoing: clip(lastAssistant, 180),
    })
    if (found.length >= maxPerSession) break
  }
  return found
}

/** 收集最近 N 天有更新的会话目录。 */
export function recentSessions({ sessionsRoot = join(homedir(), '.dsh', 'sessions'), days = 7 } = {}) {
  const cutoff = Date.now() - days * 86_400_000
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot)
  } catch {
    return out
  }
  for (const ws of workspaces) {
    const wsPath = join(sessionsRoot, ws)
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
    for (const dir of dirs) {
      if (!dir.startsWith('session-')) continue
      const archive = join(wsPath, dir, 'session.v4.jsonl.zstd')
      let st
      try {
        st = statSync(archive)
      } catch {
        continue
      }
      if (st.mtimeMs < cutoff) continue
      out.push({ sessionId: dir, archive, mtimeMs: st.mtimeMs, bytes: st.size })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * 扫描最近若干天的会话，汇总「被纠正」的回合。
 * 只读：不改任何记忆文件。
 */
export function scanCorrections({
  sessionsRoot = join(homedir(), '.dsh', 'sessions'),
  days = 7,
  maxSessions = 20,
  maxFrames = 400,
} = {}) {
  const sessions = recentSessions({ sessionsRoot, days }).slice(0, maxSessions)
  const results = []
  for (const session of sessions) {
    let text
    try {
      text = decompressTailFrames(readFileTail(session.archive), maxFrames).toString('utf8')
    } catch {
      continue
    }
    const corrections = extractCorrections(text)
    if (corrections.length === 0) continue
    results.push({
      sessionId: session.sessionId,
      mtime: new Date(session.mtimeMs).toISOString(),
      corrections,
    })
  }
  const total = results.reduce((n, r) => n + r.corrections.length, 0)
  return { scanned: sessions.length, total, sessions: results }
}

/** 把扫描结果渲染成一段可读的候选清单。 */
export function formatCorrections(scan, { max = 15 } = {}) {
  if (scan.total === 0) {
    return `扫描了最近 ${scan.scanned} 个会话，没有发现明确的纠正信号。`
  }
  const lines = [
    `扫描 ${scan.scanned} 个会话，发现 ${scan.total} 处纠正信号（显示前 ${Math.min(scan.total, max)} 处）：`,
    '',
  ]
  let shown = 0
  for (const session of scan.sessions) {
    if (shown >= max) break
    lines.push(`### ${session.sessionId.slice(0, 20)}…  ${session.mtime.slice(0, 10)}`)
    for (const item of session.corrections) {
      if (shown >= max) break
      shown += 1
      lines.push(`- 主人说：「${item.correction}」`)
      if (item.wasDoing) lines.push(`  当时我在做：${item.wasDoing}`)
    }
    lines.push('')
  }
  lines.push('—')
  lines.push('这些是候选。判断哪条该变成规则（AGENTS.md 硬规则 / pitfalls 条目）由你决定，本工具只收集不写入。')
  return lines.join('\n')
}
