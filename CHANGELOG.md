# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.2.0

### Added

- `memory_save` 支持 `createGroup: true`：任务族不存在时一步创建并写入，不再需要先建组。
- `memory_forget`：按内容片段或行号删除一条记忆（会先校验该行确实在目标任务族内）。
- `memory_archive`：把一条记忆从 `MEMORY.md` 移入 `archive/YYYY-MM-DD-archived.md`，保留可回溯性。
- `memory_pending`：查看 `pending.jsonl` 里等待整理的会话队列。
- `memory_curate`：把已处理的队列归档为 `pending.processed.YYYY-MM-DD.jsonl`，为下一批让路。
- 检索升级：中文按 bigram 切分、英文按词切分，返回相关度分数并按分数排序。
- 并发写保护：写 `MEMORY.md` / `pending.jsonl` 前获取文件锁，带退避重试，避免多会话同时写互相覆盖。

### Changed

- 索引注入前会压缩：去掉引用说明行与连续空行，同样预算下能多塞正文。
- `memory_search` 的输出带分数，命中的 token 越多分越高。

### Fixed

- 超大任务族与孤儿证据现在由 `memory_doctor` 稳定报出（此前只在大组场景下才提示）。

## [0.1.0] — 2026-10-23

首个公开版本。

### Added

- 三层 Markdown 记忆：`memory_summary.md`（索引）→ `MEMORY.md`（路由）→ `summaries/`（证据）。
- 通过 `systemPrompt.section()` 把索引自动注入系统提示，`text` 用函数以便实时刷新，`interpolate: false` 避免记忆里的 `{{...}}` 被当成模板变量。
- 六个原生工具：`memory_search` / `memory_recall` / `memory_save` / `memory_groups` / `memory_stats` / `memory_doctor`。
- `session/disposed` 事件把关闭的会话登记进 `pending.jsonl`，供周期性整理任务消费。
- 零运行时依赖（只用到 `node:` 内置模块），任何 profile 都能安全加载。
- 34 个测试覆盖存储层、插件装配与体检逻辑。
