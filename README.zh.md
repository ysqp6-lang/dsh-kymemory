# dsh-kymemory

给 DeepSeek Harness 的**三层本地记忆**：索引常驻系统提示、路由层按需读取、证据层兜底检索。纯 Markdown 文件，零运行时依赖，数据可读可改可版本控制。

[English](./README.md) | 中文

## 为什么

DSH 的会话之间默认没有记忆：每次开新会话，agent 都从零开始。写进 `AGENTS.md` 的内容虽然每次都注入，但它是静态的、越长越贵，而且不会自己积累。

本插件把记忆拆成三层，按「先便宜地看一眼，需要再往下翻」的顺序加载——和翻书先看目录、再看章节、最后查脚注一个道理：

```
┌─ memory_summary.md ──────┐  索引层：有哪些主题     ← 自动注入系统提示（≤4KB）
│  ## What's in Memory     │
└──────────────────────────┘
              ↓ memory_recall
┌─ MEMORY.md ──────────────┐  路由层：一条条事实     ← 按任务族读取
│  ## infra                │
│  - 2026-10-18 Tailscale… │
└──────────────────────────┘
              ↓ memory_search
┌─ summaries/*.md ─────────┐  证据层：命令、输出、复现 ← 全文检索
└──────────────────────────┘
```

索引层由插件**自动注入系统提示**，不需要 agent 记得去读文件；索引内容每次组装 prompt 时**实时重读**，用编辑器改完下一轮就生效。

## 安装

```sh
dsh plugin --profile web add dsh-kymemory
```

装完重启 `dsh web` 生效。插件自带 `cordis.patch.yml`，会自动挂载自己。

## 快速开始

装完重启 DSH，然后开一个新会话说：

> 记住：这个项目用 pnpm，不用 npm

agent 会调用 `memory_save` 把这条写进记忆。下次新开会话直接问：

> 我们这个项目用什么包管理器？

它会先读系统提示里自动注入的索引，命中 `#env`，再用 `memory_recall env` 取到细节——**不需要你提醒它去查**。

想检查记忆有没有被养坏：

> 给我的记忆做个体检

会调用 `memory_doctor`，报出重复任务族、孤儿证据文件、索引超限、缺日期条目等结构问题。

## 配置

在 profile 的 `cordis.patch.yml` 里追加配置块（全部可省略，默认值即 `~/.dsh/memory` 布局）：

```yaml
- id: dsh-kymemory
  name: dsh-kymemory
  config:
    root: '~/.dsh/memory'      # 记忆根目录，支持 ~
    injectIndex: true          # 是否自动注入索引
    order: 150                 # 注入段落的排序权重
    enqueueOnDispose: true     # 会话关闭时登记到 pending.jsonl
    maxIndexBytes: 4096        # 索引注入的硬上限（字节，超出截断）
    summaryFile: 'memory_summary.md'
    routeFile: 'MEMORY.md'
    evidenceDir: 'summaries'
```

## 工具

装好后 agent 多出五个原生工具：

| 工具 | 作用 |
|---|---|
| `memory_search` | 跨路由层与证据层检索关键词，返回文件名、行号与命中行 |
| `memory_recall` | 取某个任务族的全部条目 |
| `memory_save` | 追加一条带日期的记忆到指定任务族 |
| `memory_groups` | 列出所有任务族及条目数 |
| `memory_stats` | 规模自检：索引行数/字节（含上限判定）、路由层统计、证据文件数 |
| `memory_doctor` | 记忆体检：重复任务族、索引超限、孤儿证据、缺日期条目、失效路由、重复条目 |
| `memory_forget` | 删除一条记忆（内容片段或行号，只在本任务族内生效） |
| `memory_archive` | 把一条记忆移进 `archive/`，保留可回溯性 |
| `memory_pending` | 查看待整理的会话队列（`pending.jsonl`） |
| `memory_curate` | 归档并清空待整理队列，给下一批让路 |

## 目录布局

```
~/.dsh/memory/
├── memory_summary.md    索引层（建议 ≤80 行 / 4KB）
├── MEMORY.md            路由层，按 `## <任务族>` 组织，条目以日期开头
├── summaries/           证据层，单条细节超过 5 行时单独成文
├── archive/             过时内容归档，不直接删
└── pending.jsonl        会话关闭时自动登记的待整理队列（插件与整理脚本共用）
```

条目约定：`- YYYY-MM-DD 内容`，一行一条，可独立读懂。

## 与手工方案的关系

这套布局和「自己建目录 + 在 AGENTS.md 里写读取规则」完全兼容——数据格式一样，装上插件只是把三件事接管了：

1. 索引不用再靠协议提醒 agent 去读，改成注入；
2. 读写不用再 `bash` 调脚本，改成原生工具；
3. 会话关闭不用再外挂 hook 配置，改成内置事件监听。

已有记忆目录可以直接指过去，无需迁移。

## 和别的记忆插件的区别

- **不做向量检索**：靠 Markdown 的目录 + 关键词，结果可解释、可 `git diff`。
- **不做后台自动抽取**：写入由 agent 在会话中主动发起，或由你自己的定时任务驱动。
- **不绑定模型**：记忆是文件，换个 agent 也能读。

## 开发

```sh
node --test test/store.test.mjs test/plugin.test.mjs
```

测试覆盖存储层与插件装配（用 mock ctx 验证工具契约、注入段落、事件处理）。

## License

MIT
