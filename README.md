# dsh-kymemory

**Layered local memory for DeepSeek Harness**: an index that rides along in the system prompt, a route layer read on demand, and evidence files for the details. Plain Markdown, zero runtime dependencies, fully readable and version-controllable.

English | [中文](./README.zh.md)

## Why

DSH sessions have no memory by default: every new session starts from zero. Content written into `AGENTS.md` is injected on every request, but it is static, costs context on every turn, and never accumulates on its own.

This plugin splits memory into three layers and loads them cheapest-first — the same way you read a book by checking the table of contents, then the chapter, then the footnotes:

```
┌─ memory_summary.md ──────┐  index: what topics exist  ← injected into the system prompt (≤4KB)
│  ## What's in Memory     │
└──────────────────────────┘
              ↓ memory_recall
┌─ MEMORY.md ──────────────┐  route: one fact per bullet ← read per task group
│  ## infra                │
│  - 2026-10-18 Tailscale… │
└──────────────────────────┘
              ↓ memory_search
┌─ summaries/*.md ─────────┐  evidence: commands, output, repro ← full-text search
└──────────────────────────┘
```

The index is **injected by the plugin**, so the agent never has to remember to read a file. It is **re-read on every prompt assembly**, so an edit made in any editor shows up on the next turn without a restart.

## Install

```sh
dsh plugin --profile web add dsh-kymemory
```

Restart `dsh web`. The package ships its own `cordis.patch.yml` and mounts itself.

## Quick start

Install, restart DSH, then open a new session and say:

> Remember: this project uses pnpm, not npm.

The agent calls `memory_save` and the fact is stored. Next time you open a session, just ask:

> Which package manager does this project use?

It reads the index the plugin injected into the system prompt, resolves `#env`, then calls
`memory_recall env` for the details — **without you having to remind it to look**.

To check whether the memory itself has rotted:

> Run a health check on my memory

That calls `memory_doctor`, reporting duplicate task groups, orphaned evidence files, an
over-budget index, and bullets missing their date prefix.

## Configure

Add a config block to your profile's `cordis.patch.yml` (everything is optional; defaults match the `~/.dsh/memory` layout):

```yaml
- id: dsh-kymemory
  name: dsh-kymemory
  config:
    root: '~/.dsh/memory'      # memory root, supports ~
    injectIndex: true          # inject the index into the system prompt
    order: 150                 # section ordering weight
    enqueueOnDispose: true     # record closed sessions into pending.jsonl
    maxIndexBytes: 4096        # hard cap for the injected index (bytes)
    summaryFile: 'memory_summary.md'
    routeFile: 'MEMORY.md'
    evidenceDir: 'summaries'

    # auto-capture (0.2.0)
    autoCapture: 'inbox'       # 'inbox' collects candidates; 'off' disables
    captureFrames: 300         # frames decoded from the tail
    captureMaxChars: 4000      # body cap per candidate
    captureMinMessages: 2      # skip sessions shorter than this
    captureThrottleMs: 60000   # throttle for turn/end incremental capture
    sessionsRoot: '~/.dsh/sessions'
```

## Tools

Five native tools become available to the agent:

| Tool | Purpose |
|---|---|
| `memory_search` | Keyword search across route and evidence layers; returns file, line and matching line |
| `memory_recall` | Full contents of one task group |
| `memory_save` | Append one dated fact to a task group |
| `memory_groups` | List task groups with entry counts |
| `memory_stats` | Size report: index lines/bytes (with limit check), route stats, evidence count |
| `memory_doctor` | Health check: duplicate groups, over-budget index, orphaned evidence, missing dates, dead routes |
| `memory_forget` | Delete one memory (by substring or line number, scoped to that group) |
| `memory_archive` | Move one memory into `archive/`, keeping it recoverable |
| `memory_pending` | Inspect the queue of closed sessions awaiting curation |
| `memory_curate` | Archive and clear the queue, making room for the next batch |
| `memory_inbox` | Inspect auto-captured candidates; pass `file` to read one |
| `memory_promote` | Archive a promoted candidate into `inbox/archive/` |

## Layout

```
~/.dsh/memory/
├── memory_summary.md    index layer (keep under ~80 lines / 4KB)
├── MEMORY.md            route layer, `## <group>` blocks, dated bullets
├── summaries/           evidence layer, one file per detailed topic
├── archive/             stale content, archived rather than deleted
└── pending.jsonl        sessions queued on close, shared with your curation script
```

Bullet convention: `- YYYY-MM-DD content`, one line, readable on its own.

## Compatibility with the hand-rolled approach

The layout is identical to the "build a directory, then write read rules into `AGENTS.md`" approach — same data format. Installing the plugin only takes over three jobs:

1. the index no longer needs a protocol to remind the agent to read it — it is injected;
2. reads and writes no longer shell out to a script — they are native tools;
3. session-close archiving no longer needs an external hook config — it is built in.

An existing memory directory can be pointed at directly; no migration required.

## How it differs from other memory plugins

- **No vector search**: Markdown structure plus keywords. Results are explainable and `git diff`-able.
- **No background extraction**: writes are initiated by the agent in-session, or driven by your own periodic task.
- **Not model-bound**: memory is files; any other agent can read them.

## Development

```sh
node --test test/store.test.mjs test/plugin.test.mjs
```

Tests cover the store layer and plugin assembly (mock ctx verifies the tool contract, the injected section, and event handling).

## License

MIT
