# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-10-26

### Added

- **六张状态卡片全部可点开**，点开后在下方展开详情面板，讲清「是什么 / 为什么 / 怎么办」：
  - **索引** → 行数、当前占用、预算上限、剩余空间，并说明超限会被截断
  - **任务族** → 按条目数排序的前 10 族（带作用域），提示单族超 50 条该拆分
  - **证据** → summaries/ 下的文件清单与大小
  - **inbox** → 候选清单（日期 + 会话 + 消息数）与处理流程
  - **体检** → 完整 issue 列表（此前只显示前 6 条）与检查项说明
  - **recall** → 从未被整族取过的族清单，以及「这不等于没用」的解释与三条改进路径
- `overview` 接口补充 `evidenceFiles`、完整的 `doctor.issues` 与 `usage.neverUsed`。

## [0.6.3] — 2026-10-26

### Changed

- **热力配色**：进度条改成整条铺「绿 → 黄 → 橙 → 红」渐变，再按进度用 `clip-path` 裁出可见部分，所以 57% 看到的是绿到黄、96% 才看得到红；圆环按百分比做 HSL 色相插值。
- recall 覆盖率这类「越高越好」的指标反向取色（7% 覆盖显示红色警示），并在标签里注明方向。

## [0.6.2] — 2026-10-26

### Changed

- 状态卡片改为 **3 列 × 2 行**，并给每张卡片加上有真实信息量的可视化：索引用横向预算条（2338/4096 → 57%）、任务族用「最大族占比」条（59/330 → 18%）、inbox 用上限条（4/50 → 8%）、体检与 recall 覆盖用**圆环进度**（环内显示百分比）。
- 移除了没有信息量的装饰性圆环（任务族与证据原本恒为 100%），证据卡改为纯计数 + 用途说明。

## [0.6.1] — 2026-10-26

### Changed

- **面板视觉重做**：六张状态卡片改为内联 SVG 图标 + 大数字 + 小标签；任务族改为**两列网格**（展开时占满整行），29 个族的高度砍掉一半；inbox 提到族列表之前并精简为「日期 + session 短 id」；搜索框、分隔线、hover 与聚焦过渡统一到一套暗色设计变量。

## [0.6.0] — 2026-10-25

### Added

- **客户端面板在 Web GUI 里复活**：会话视图多出「记忆」标签（对话 / 记忆 / 轨迹），含规模卡片、关键词搜索、任务族折叠列表（显示作用域）、inbox 与体检问题。

### Fixed

- **四个加载约定全踩过，逐条修正**：① `dsh.client` 不能声明 `immediately: true`（会让 bundle 执行两次触发 duplicate factory registration）；② `client.js` 顶层必须直接调用 `window.__ModuleLoader__.load`，包 IIFE 会让宿主认不出；③ bundle 的 `id` 必须等于**包名**（写成 `-panel` 后缀会让宿主报 `could not load`）；④ cordis 服务必须写进 `inject` 并通过 `ctx.webServer` 访问，`ctx.get('webServer')` 拿不到 → 路由从未注册 → API 404。
- 客户端请求改用基于 `location.href` 的绝对地址，并把失败时的请求地址与页面地址一并显示，便于定位宿主协议差异。

## [0.5.1] — 2026-10-25

### Fixed

- **启动崩溃**：`dsh.client` 声明让宿主在 web boot 阶段加载客户端 bundle，加载失败会把整个插件条目标记为未激活（`import failed`），进而弹「应用无法启动」。已撤掉客户端声明。
- **`memory_rules` 未定义引用**：`lib/index.js` 调用 `scanCorrections` / `formatCorrections` 却没有 `from './rules.js'` 的导入，工具一执行就会 `ReferenceError`。已补上。

### Changed

- 面板改为**独立网页** `/dsh-kymemory/panel`（由宿主 webServer 提供），不再走客户端插件插槽。零崩溃风险，功能一致：规模卡片、搜索、族列表、inbox、体检问题。

## [0.5.0] — 2026-10-25

### Added

- **记忆面板（Web GUI）**：会话视图多出一个「记忆」标签，与「对话」「轨迹」并列。包含：规模卡片（索引行数/字节、族数与条目数、inbox 待整理、体检状态、被 recall 过的族数）、关键词搜索、任务族折叠列表（点开看该族全部条目、显示作用域）、体检问题与 inbox 列表。
- 宿主半边新增三条**只读** API：`/dsh-kymemory/api/overview|group|search`。面板浏览用 `recordUsage: false`，看记忆不会污染用量统计。
- 客户端半边走官方插槽 `conversation.view`（order 8），带错误边界：面板出问题只让自己消失，不影响官方 UI。

### Notes

- 面板**只读**。写入仍只走 `memory_save` 等工具或直接改文件，避免 UI 路径写坏正式库。

## [0.4.0] — 2026-10-25

### Added

- **回合记忆栏**：`memory_search` / `memory_recall` 的返回末尾附带 `📎 记忆来源`（文件与行号），模型回答时能直接引用依据；AGENTS.md 同步约定「用了记忆就标来源」。
- **记忆作用域**：任务族可绑定项目目录（`## homework @~/Agent/MathorCup数模`）。`memory_search` / `memory_recall` 接受可选 `cwd`，只返回全局族 + 落在该目录内的项目族；不传 `cwd` 时不过滤，避免误杀。`memory_doctor` 会报出指向已不存在目录的作用域。
- **规则候选提取（程序性记忆）**：新工具 `memory_rules`，扫描最近会话，提取「主人纠正过的地方」并带上当时助手的做法。只收集不写入——哪条值得变成 AGENTS.md 硬规则或 pitfalls 条目由 agent/主人判断。

### Fixed

- 作用域匹配曾允许父目录看到子项目（反向前缀匹配），会破坏项目隔离；现在只认「cwd 落在 scope 之内」。

## [0.3.0] — 2026-10-23

### Added

- **疑似矛盾检测**：`memory_doctor` 现在会找出同族内「高度相似但否定词只在一边」的条目——例如「用 pnpm」与「不用 pnpm」并存。这是记忆最危险的失效方式，报成 `suspected-conflict`。
- **记忆用量统计**：`memory_recall` 会记录每个任务族的取用次数与最近使用时间（`usage.json`），`memory_doctor` 据此报出从未被取过、或 90 天没碰过的族，帮判断哪些记忆只是噪音。

### Changed

- 体检报告新增 `info` 级别，不参与「是否通过」的判定（只有 error 才算失败）。

## [Unreleased]

### Added

- **自动捕获**：`session/disposed` 与 `turn/end`（节流）两个触发点会把会话里的用户原话与压缩摘要收进 `inbox/`，作为候选素材。刻意不调用模型——解压与抽取是纯机械操作，提炼交给下一次会话里的 agent，零 API 成本、零幻觉风险。
- 多帧 zstd 尾部解压：DSH 每追加一次就写一帧，Node 内置解压只吃第一帧，因此从文件尾部按 magic 回溯只解最近 N 帧（5.4 MB 会话约 5 ms）。
- `memory_inbox` / `memory_promote`：查看候选素材、提炼入库后归档。
- 索引注入时若 inbox 有待整理候选，会在末尾附一行提示。
- `memory_save` 支持 `createGroup: true`：任务族不存在时一步创建并写入，不再需要先建组。
- `memory_forget`：按内容片段或行号删除一条记忆（会先校验该行确实在目标任务族内）。
- `memory_archive`：把一条记忆从 `MEMORY.md` 移入 `archive/YYYY-MM-DD-archived.md`，保留可回溯性。
- `memory_pending`：查看 `pending.jsonl` 里等待整理的会话队列。
- `memory_curate`：把已处理的队列归档为 `pending.processed.YYYY-MM-DD.jsonl`，为下一批让路。
- 检索升级：中文按 bigram 切分、英文按词切分，返回相关度分数并按分数排序。
- **IDF 加权检索**：稀有词（如 `zstd`）自动高于高频词（如「记忆」）；token 切碎导致的漏匹配（`sqlite` vs `sqlite3`）由子串兜底补回。
- 并发写保护：写 `MEMORY.md` / `pending.jsonl` 前获取文件锁，带退避重试，避免多会话同时写互相覆盖。

### Changed

- 索引注入前会压缩：去掉引用说明行与连续空行，同样预算下能多塞正文。
- `memory_search` 的输出带分数，命中的 token 越多分越高。

### Added (tooling)

- `scripts/selftest.mjs`：一键自检（语法 / 测试 / 零依赖 / 发布内容 / 真实会话捕获链路 / 注入性能），`npm run selftest`。

### Fixed

- 超大任务族与孤儿证据现在由 `memory_doctor` 稳定报出（此前只在大组场景下才提示）。
- **自查修复**：`findSessionArchive` 原用 `includes` 会把 `abc` 误配到 `session-abcdef`，改为精确匹配；`promoteInbox` 补上文件锁（两会话同时归档不再互相踩）；inbox 候选超过 30 天未处理会自动归入 `archive/`。
- **自动捕获的三处加固**：`session→时间戳` 的节流表超过 500 条会清理（常开进程不再慢性增长）；会话存档超过 4 MB 时只读尾部并从帧边界切入（内存不再随会话大小线性增长）；`inbox/` 超过 50 个候选时自动把最旧的推进 `inbox/archive/`。
- **`session/disposed` 在短命进程（如 headless）里不会触发**，导致 0.1.0 的 pending 队列在真实场景中可能从未生效；现在同时监听 `session/event` 的 `turn/end` 兜底。

## [0.1.0] — 2026-10-23

首个公开版本。

### Added

- 三层 Markdown 记忆：`memory_summary.md`（索引）→ `MEMORY.md`（路由）→ `summaries/`（证据）。
- 通过 `systemPrompt.section()` 把索引自动注入系统提示，`text` 用函数以便实时刷新，`interpolate: false` 避免记忆里的 `{{...}}` 被当成模板变量。
- 六个原生工具：`memory_search` / `memory_recall` / `memory_save` / `memory_groups` / `memory_stats` / `memory_doctor`。
- `session/disposed` 事件把关闭的会话登记进 `pending.jsonl`，供周期性整理任务消费。
- 零运行时依赖（只用到 `node:` 内置模块），任何 profile 都能安全加载。
- 34 个测试覆盖存储层、插件装配与体检逻辑。
