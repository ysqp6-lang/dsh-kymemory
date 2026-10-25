import { readFileSync } from 'node:fs'

import { normalizeConfig } from './config.js'
import { captureSession, writeInbox } from './capture.js'
import { createStore, expandHome } from './store.js'
import { formatCorrections, scanCorrections } from './rules.js'

export const name = 'dsh-kymemory'

/** `tools` is required to register the memory tools; `sessions` carries the lifecycle events. */
export const inject = ['tools', 'sessions']


/**
 * 只读 HTTP API，供客户端面板取数。
 * 刻意只读：面板能看不能改，避免从 UI 路径写坏正式记忆库。
 */
function registerPanelApi(webServer, store) {
  const replyJson = (res, data, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(data))
  }
  const param = (req, name) => {
    try {
      return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(name) ?? ''
    } catch {
      return ''
    }
  }

  try {
    webServer.register({
      kind: 'exact',
      path: '/dsh-kymemory/api/overview',
      handler: (req, res) => {
        try {
          const stats = store.stats()
          const doctor = store.doctor()
          const usage = store.usage()
          replyJson(res, {
            ok: true,
            root: stats.root,
            index: stats.index,
            route: stats.route,
            evidence: stats.evidence,
            limits: stats.limits,
            groups: store.groups(),
            inbox: store.inbox().map((item) => ({
              name: item.name ?? item.file ?? '',
              meta: item.meta ?? {},
            })),
            doctor: {
              ok: doctor.ok,
              counts: doctor.counts,
              issues: doctor.issues.slice(0, 10),
            },
            usage: { used: usage.rows.length, total: usage.totalGroups },
          })
        } catch (error) {
          replyJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/dsh-kymemory/api/group',
      handler: (req, res) => {
        const slug = param(req, 'slug')
        try {
          // recordUsage: false —— 面板浏览不该污染「哪些族真的被用过」的统计
          replyJson(res, { ok: true, ...store.recall(slug, { recordUsage: false }) })
        } catch (error) {
          replyJson(res, { ok: false, error: String(error?.message ?? error) }, 404)
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/dsh-kymemory/panel',
      handler: (req, res) => {
        try {
          const html = readFileSync(new URL('./panel.html', import.meta.url), 'utf8')
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error?.message ?? error))
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/dsh-kymemory/api/search',
      handler: (req, res) => {
        const query = param(req, 'q')
        try {
          replyJson(res, { ok: true, ...store.search(query, 20) })
        } catch (error) {
          replyJson(res, { ok: false, error: String(error?.message ?? error) }, 400)
        }
      },
    })
  } catch {
    /* 路由注册失败不该影响插件其余部分 */
  }
}

/** Format a search result as readable text for the model. */
function formatSearch(result) {
  if (result.total === 0) return `没有匹配「${result.query}」的记忆。`
  const lines = result.hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`)
  const head = `命中 ${result.total} 条（按相关度显示 ${result.returned} 条）：`
  // 来源摘要放在末尾：模型读到内容时来源就在眼前，回答里引用它不需要额外查
  const files = [...new Set(result.hits.map((hit) => hit.file))]
  const lines0 = result.hits.map((hit) => hit.line)
  const span = lines0.length > 0 ? `（第 ${Math.min(...lines0)}–${Math.max(...lines0)} 行）` : ''
  const sources = `${files.join('、')}${span}`
  return [head, ...lines, '', `📎 记忆来源：${sources}`].join('\n')
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
    .map((g) => {
      const scope = g.scope ? `  @${g.scope}` : ''
      return `${g.slug.padEnd(width)}${String(g.entries).padStart(3)} 条  ${g.title}${scope}`
    })
    .join('\n')
}

function formatDoctor(report) {
  const { ok, checked, counts, issues } = report
  const head = ok
    ? `✅ 记忆体检通过（${checked.groups} 个任务族 / ${checked.entries} 条 / ${checked.evidence} 个证据文件）`
    : `⚠ 记忆体检：${counts.error} 个错误、${counts.warn} 个警告、${counts.info ?? 0} 条提示（${checked.groups} 个任务族 / ${checked.entries} 条）`
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

/** Render the inbox listing (the read case returns text directly). */
function formatInboxList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return 'inbox 为空：没有待整理的候选素材。'
  }
  const lines = list.map(
    (item) => `  ${item.name}  (${item.meta?.messages ?? '?'} 条消息, ${item.bytes}B)`,
  )
  return [
    `待整理候选 ${list.length} 个：`,
    ...lines,
    '',
    '用 memory_inbox({ file }) 读取内容，提炼后 memory_save 入库，再 memory_promote 归档。',
  ].join('\n')
}

/** Accept "57" from a tool argument where a line number is intended. */
function numericIfPossible(value) {
  const raw = String(value ?? '').trim()
  return /^\d+$/.test(raw) ? Number(raw) : value
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
        cwd: {
          type: 'string',
          description: '可选，当前工作目录。传入后只返回全局族 + 绑定到该目录的项目族',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOutput(formatSearch),
    timeoutMs: 8000,
    isConcurrencySafe: () => true,
    execute: async (args) => store.search(args.query, args.limit, { cwd: args.cwd }),
  })

  ctx.tools.register({
    name: 'memory_recall',
    description:
      '取出某个任务族的完整路由内容（该主题下所有带日期的记忆条目）。先看系统提示里的索引定位族名，再调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '任务族名，例如 infra / kylina / pitfalls' },
        cwd: {
          type: 'string',
          description: '可选，当前工作目录。绑定到别的项目的族会被作用域拦下，避免跨项目串味',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    output: textOutput((value) => `${value.text}\n\n📎 记忆来源：${value.file ?? 'MEMORY.md'}#${value.slug}`),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async (args) => store.recall(args.slug, { cwd: args.cwd }),
  })

  ctx.tools.register({
    name: 'memory_save',
    description:
      '把一条值得跨会话保留的事实追加到指定任务族（自动带日期）。任务族不存在时加 createGroup: true 可直接创建。不要记密码、token、私钥等敏感值。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '目标任务族名；不存在时可加 createGroup 一步创建' },
        text: { type: 'string', description: '一条记忆的内容，尽量单行、可独立读懂' },
        date: { type: 'string', description: '可选，YYYY-MM-DD，默认今天' },
        createGroup: { type: 'boolean', description: '可选，任务族不存在时自动创建' },
        title: { type: 'string', description: '可选，配合 createGroup 给新任务族加中文标题' },
        scope: {
          type: 'string',
          description: '可选，配合 createGroup 把新族绑定到某个项目目录（如 ~/Agent/MathorCup数模）',
        },
      },
      required: ['slug', 'text'],
      additionalProperties: false,
    },
    output: textOutput(
      (value) => `${value.created ? '已新建任务族并写入' : '已写入'} ${value.slug}：${value.entry}`,
    ),
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args) =>
      store.save(args.slug, args.text, args.date, {
        createGroup: args.createGroup,
        title: args.title,
        scope: args.scope,
      }),
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

  ctx.tools.register({
    name: 'memory_forget',
    description:
      '删除一条记忆。match 传条目内容片段（须在本任务族内唯一命中）或 1-based 行号。只想让旧内容退场请用 memory_archive，它会保留历史。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '任务族名' },
        match: { type: 'string', description: '条目内容片段，或行号（如 "57"）' },
      },
      required: ['slug', 'match'],
      additionalProperties: false,
    },
    output: textOutput((value) => `已删除 ${value.slug} 第 ${value.line} 行：${value.removed}`),
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args) => store.forget(args.slug, numericIfPossible(args.match)),
  })

  ctx.tools.register({
    name: 'memory_archive',
    description:
      '把一条记忆从 MEMORY.md 移进 archive/YYYY-MM-DD-archived.md。用于过时但仍有回溯价值的内容；真正没用的才用 memory_forget。',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '任务族名' },
        match: { type: 'string', description: '条目内容片段，或行号（如 "57"）' },
      },
      required: ['slug', 'match'],
      additionalProperties: false,
    },
    output: textOutput((value) => `已归档到 ${value.file}：${value.archived}`),
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args) => store.archive(args.slug, numericIfPossible(args.match)),
  })

  ctx.tools.register({
    name: 'memory_pending',
    description:
      '列出等待整理的会话队列（pending.jsonl）。这些是会话关闭时自动登记的，供周期性整理任务读取。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput((value) =>
      value.count === 0
        ? '待整理队列为空。'
        : `待整理会话 ${value.count} 个：\n` +
          value.rows
            .map((row) => `  ${row.sessionId}${row.name ? `  ${row.name}` : ''}`)
            .join('\n'),
    ),
    timeoutMs: 5000,
    isConcurrencySafe: () => true,
    execute: async () => store.pending(),
  })

  ctx.tools.register({
    name: 'memory_curate',
    description:
      '把待整理队列整体归档为 pending.processed.YYYY-MM-DD.jsonl 并清空，给下一批会话让路。整理完队列后调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput((value) =>
      value.moved === 0 ? '队列为空，无需归档。' : `已归档 ${value.moved} 条到 ${value.file}`,
    ),
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async () => store.curate(),
  })

  ctx.tools.register({
    name: 'memory_inbox',
    description:
      '查看自动捕获的候选记忆素材。不传 file 时列出待整理文件；传 file 时读取内容（含用户原话与会话摘要）。提炼后 memory_save 入库，再用 memory_promote 归档。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选，文件名或其片段；省略则列出全部候选' },
      },
      additionalProperties: false,
    },
    output: textOutput((value) => value.text ?? formatInboxList(value.list)),
    timeoutMs: 8000,
    isConcurrencySafe: () => true,
    execute: async (args) =>
      args?.file ? store.readInbox(args.file) : { list: store.inbox() },
  })

  ctx.tools.register({
    name: 'memory_promote',
    description:
      '把已提炼入库的 inbox 候选文件移进 inbox/archive/，避免下次重复读取。省略 file 时处理最新一个。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '可选，文件名或其片段；省略则处理最新的候选' },
      },
      additionalProperties: false,
    },
    output: textOutput((value) => `已归档 ${value.name}，剩余 ${value.remaining} 个候选`),
    timeoutMs: 5000,
    isConcurrencySafe: () => false,
    execute: async (args) => store.promoteInbox(args?.file),
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

  // ── 4. 自动捕获：会话进行中与关闭时都会收集候选素材 ────────────────
  // 刻意不调模型：解压与抽取是纯机械操作（实测约 5ms），提炼交给下一次会话里
  // 的 agent。这样零 API 成本、零幻觉风险，且 agent 那时的上下文更完整。
  //
  // 触发点有两个，因为单纯监听 session/disposed 并不可靠——headless 之类的短命
  // 进程在会话收尾前就退出了，disposed 根本不会发出：
  //   · session/event 的 turn/end → 增量化（节流，覆盖写同一份候选）
  //   · session/disposed          → 强制收尾（绕过节流，拿最终状态）
  if (config.autoCapture === 'inbox') {
    const throttle = new Map()

    const autoCapture = (session, { force = false } = {}) => {
      const sessionId = session?.id ?? session?.sessionId
      if (!sessionId) return
      const now = Date.now()
      const last = throttle.get(sessionId) ?? 0
      if (!force && now - last < config.captureThrottleMs) return
      throttle.set(sessionId, now)
      // 常开的 DSH 进程会见到成百上千个会话 id，不清理就是慢性内存增长
      if (throttle.size > 500) {
        for (const [id, ts] of throttle) {
          if (now - ts > 3_600_000) throttle.delete(id)
        }
      }

      // 同步执行：解压尾部 300 帧 + 抽取 + 落盘约 5ms，对会话关闭无感；
      // 而 setImmediate 在短命进程里会被退出流程吃掉。
      try {
        const capture = captureSession({
          sessionsRoot: expandHome(config.sessionsRoot),
          sessionId,
          title: session?.title ?? session?.header?.title ?? '',
          cwd: session?.header?.cwd ?? session?.cwd ?? '',
          maxFrames: config.captureFrames,
          maxChars: config.captureMaxChars,
          minMessages: config.captureMinMessages,
        })
        if (capture && !capture.skipped) writeInbox(store.root, capture)
      } catch (error) {
        console.warn(`[dsh-kymemory] auto-capture failed: ${error?.message ?? error}`)
      }
    }

    ctx.on('session/event', (session, event) => {
      if (event?.type === 'turn/end') autoCapture(session)
    })
    ctx.on('session/disposed', (session) => autoCapture(session, { force: true }))
  }

  // ── 5. 程序性记忆：从会话里提取「被纠正的地方」作为规则候选 ───────────
  // 记忆分两种：事实（知道什么）和规则（知道怎么做）。自动捕获只管事实，
  // 这个工具补后者——它只收集候选，不写入任何记忆文件。
  ctx.tools.register({
    name: 'memory_rules',
    description:
      '从最近会话里提取主人纠正过的地方，作为「程序性记忆」候选（规则/流程）。' +
      '只读、不自动写入——哪条值得变成 AGENTS.md 硬规则或 pitfalls 条目，由你判断后手动落库。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回溯天数，默认 7' },
        maxSessions: { type: 'number', description: '最多扫描多少个会话，默认 20' },
      },
      additionalProperties: false,
    },
    output: textOutput((value) => value.text),
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const scan = scanCorrections({
        sessionsRoot: expandHome(config.sessionsRoot),
        days: Number(args.days) > 0 ? Number(args.days) : 7,
        maxSessions: Number(args.maxSessions) > 0 ? Number(args.maxSessions) : 20,
      })
      return { text: formatCorrections(scan), scanned: scan.scanned, total: scan.total }
    },
  })

  // ── 6. 客户端面板的数据接口（可选：没有 webServer 的环境自动跳过）─────
  try {
    const webServer = ctx.get('webServer', false)
    if (webServer && typeof webServer.register === 'function') registerPanelApi(webServer, store)
  } catch {
    /* 忽略：面板是锦上添花，坏了不影响记忆功能 */
  }

  return store
}
