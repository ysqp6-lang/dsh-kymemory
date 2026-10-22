/**
 * 默认配置与归一化。
 *
 * 刻意不依赖任何包：本插件常以 `link:` 安装在 profile 目录树之外，Node 会按
 * 真实路径解析其内部 import，因而**无法**解析 DSH 内部的 `@deepseek-ai/schemastery`。
 * 一旦在入口链路上 import 它，插件加载就会硬失败（ERR_MODULE_NOT_FOUND）。
 * 用「纯默认值 + 浅合并」替代 schema 校验，换取任何 profile 都能安全加载。
 */
export const DEFAULT_CONFIG = {
  root: '~/.dsh/memory',
  injectIndex: true,
  order: 150,
  enqueueOnDispose: true,
  maxIndexBytes: 4096,
  summaryFile: 'memory_summary.md',
  routeFile: 'MEMORY.md',
  evidenceDir: 'summaries',

  // ── 自动捕获 ─────────────────────────────────────────────────────
  // 'inbox'：会话关闭时把用户原话与摘要收进 inbox/，等 agent 提炼后入库。
  // 'off'：只登记 pending 队列，不做素材收集。
  autoCapture: 'inbox',
  captureFrames: 300,
  captureMaxChars: 4000,
  captureMinMessages: 2,
  captureThrottleMs: 60000,
  sessionsRoot: '~/.dsh/sessions',
}

/**
 * Merge user config over defaults, coercing the two numeric fields so a bad
 * value degrades to the default instead of producing NaN at render time.
 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null && value !== '') config[key] = value
    }
  }
  const maxBytes = Number(config.maxIndexBytes)
  config.maxIndexBytes =
    Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_CONFIG.maxIndexBytes
  const order = Number(config.order)
  config.order = Number.isFinite(order) ? order : DEFAULT_CONFIG.order
  config.injectIndex = config.injectIndex !== false
  config.enqueueOnDispose = config.enqueueOnDispose !== false
  config.autoCapture = config.autoCapture === 'off' ? 'off' : 'inbox'
  for (const key of ['captureFrames', 'captureMaxChars', 'captureMinMessages', 'captureThrottleMs']) {
    const n = Number(config[key])
    config[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONFIG[key]
  }
  return config
}
