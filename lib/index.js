import { normalizeConfig } from './config.js'
import { createStore } from './store.js'

export const name = 'dsh-kymemory'

/** `tools` is required to register the memory tools; `sessions` carries the lifecycle events. */
export const inject = ['tools', 'sessions']

/** Format a search result as readable text for the model. */
function formatSearch(result) {
  if (result.total === 0) return `没有匹配「${result.query}」的记忆。`
  const lines = result.hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`)
  const head = `命中 ${result.total} 条（显示 ${result.returned} 条）：`
  return [head, ...lines].join('\n')
}

function formatStats(stats) {
  const { index, route, evidence, limits } = stats
  const flag = stats.indexWithinLimit ? '' : '  ⚠ 超出上限，建议精简'
  return [
    `记忆根目录：${stats.root}`,
    `索引  ${index.lines} 行 / ${index.bytes} 字节（上限 ${limits.maxIndexBytes} 字节）${flag}`,
    `路由  ${route.lines} 行 / ${route.bytes} 字节，${route.groups} 个任务族 / ${route.entries} 条记忆`,
    `证据  ${evidence} 个文件`,
  ].join('\n')
}

function formatGroups(value) {
  const groups = Array.isArray(value?.groups) ? value.groups : []
  if (groups.length === 0) return '（还没有任何任务族）'
  const width = Math.max(...groups.map((g) => g.slug.length)) + 2
  return groups
    .map((g) => `${g.slug.padEnd(width)}${String(g.entries).padStart(3)} 条  ${g.title}`)
    .join('\n')
}

function formatDoctor(report) {
  const { ok, checked, counts, issues } = report
  const head = ok
    ? `✅ 记忆体检通过（${checked.groups} 个任务族 / ${checked.entries} 条 / ${checked.evidence} 个证据文件）`
    : `⚠ 记忆体检：${counts.error} 个错误、${counts.warn} 个警告（${checked.groups} 个任务族 / ${checked.entries} 条）`
  const lines = [head]
  if (issues.length === 0) {
    lines.push('', '没有发现问题。')
  } else {
    lines.push('')
    for (const issue of issues) {
      lines.push(`${issue.level === 'error' ? '✖' : '·'} [${issue.code}] ${issue.message}`)
    }
  }
  lines.push('', `索引 ${checked.indexBytes} 字节 / ${checked.indexLines} 行`)
  return lines.join('\n')
}

/** One text block is enough for every tool in this plugin. */
const textOutput = (formatter) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: formatter(value) }],
})

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const store = createStore(config)

  // ── 1. 索引自动注入 ────────────────────────────────────────────────
  // `text` accepts a function, so the index is re-read on every prompt assembly:
  // an edit made in any session is visible in the next turn without a restart.
  // `interpolate: false` is mandatory — the system prompt would otherwise treat
  // any `{{...}}` inside memorized text as a variable reference and throw.
  const systemPrompt = ctx.get('systemPrompt', false)
  const canInject =
    systemPrompt &&
    typeof systemPrompt === 'object' &&
    typeof systemPrompt.section === 'function'
  if (canInject && config.injectIndex !== false) {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'plugin:dsh-kymemory',
          order: Number(config.order ?? 150),
          interpolate: false,
          text: () => store.renderIndex(),
        }),
      'dsh-kymemory: memory index section',
    )
  }

  // ── 2. 原生工具 ────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'memory_search',
    description:
      '在 DSH 本地记忆中检索（路由层 MEMORY.md + 证据层 summaries/）。用于「上次那个事叫什么」「之前怎么解决的」这类回忆。返回文件名、行号与命中行。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，大小写不敏感，可中文' },
        limit: { type: 'number', description: '最多返回条数，默认 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOutput(formatSearch),
    timeoutMs: 8000,
    isConcurrencySafe: () => true,
    execute: async (args) => store.search(args.query, args.limit),
  })

  ctx.tools.register({
    name: 'memory_recall',
    description:
      '取出某个任务族的完整路由内容（该主题下所有带日期的记忆条目）。先看系统提示里的索引定位族名，再调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '任务族名，例如 infra / kylina / pitfalls' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    output: textOutput((value) => value.text),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async (args) => store.recall(args.slug),
  })

  ctx.tools.register({
    name: 'memory_save',
    description:
      '把一条值得跨会话保留的事实追加到指定任务族（自动带日期）。用于稳定事实、技术决策、踩坑与解法、项目结构变化。不要记密码、token、私钥等敏感值。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '目标任务族名；不存在会报错并列出可选族' },
        text: { type: 'string', description: '一条记忆的内容，尽量单行、可独立读懂' },
        date: { type: 'string', description: '可选，YYYY-MM-DD，默认今天' },
      },
      required: ['slug', 'text'],
      additionalProperties: false,
    },
    output: textOutput((value) => `已写入 ${value.slug}：${value.entry}`),
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args) => store.save(args.slug, args.text, args.date),
  })

  ctx.tools.register({
    name: 'memory_groups',
    description: '列出所有任务族及其条目数量，用于判断记忆里已经有哪些主题。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(formatGroups),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async () => ({ groups: store.groups() }),
  })

  ctx.tools.register({
    name: 'memory_stats',
    description:
      '记忆规模自检：索引行数/字节（含上限判定）、路由层行数与任务族数量、证据文件数。索引超限时应当把细节下沉到路由层。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(formatStats),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async () => store.stats(),
  })

  ctx.tools.register({
    name: 'memory_doctor',
    description:
      '记忆体检：检查重复任务族、索引超限、缺日期条目、孤儿证据文件、失效路由、完全重复条目等结构问题。只报告不修改，用于记忆变乱时定位该修哪里。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput(formatDoctor),
    timeoutMs: 8000,
    isConcurrencySafe: () => true,
    execute: async () => store.doctor(),
  })

  // ── 3. 会话关闭自动登记 ────────────────────────────────────────────
  // Fire-and-forget: a failed enqueue must never break a session teardown.
  if (config.enqueueOnDispose !== false) {
    ctx.on('session/disposed', (session) => {
      try {
        store.enqueue(session)
      } catch (error) {
        console.warn(`[dsh-kymemory] enqueue failed: ${error?.message ?? error}`)
      }
    })
  }

  return store
}
