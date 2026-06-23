<p align="center">
  <h1 align="center">OhMyAgent</h1>
  <p align="center"><strong>Remembers. Understands. Respects.</strong></p>
  <p align="center">
    <a href="README_zh.md">中文</a>
  </p>
</p>

---

OhMyAgent is a self-hosted AI agent gateway with a memory system at its core. Unlike agents that forget everything between sessions, OhMyAgent builds a persistent, searchable knowledge base about you — and respects your boundaries with a built-in approval engine.

It runs on Termux (Android), Windows, macOS, and Linux. It's lightweight, token-efficient, and fast.

## Why OhMyAgent?

| | OhMyAgent |
|---|---|
| 🧠 **Real memory** | SQLite + better-sqlite3 + sqlite-vec vector similarity + FTS5 BM25 full-text search + LLM-driven auto-summarization + DreamCycle nightly maintenance — your agent actually learns who you are |
| 🛡️ **Approval gating** | Policy engine with per-tool approval before execution, path-scoped file access, and configurable tool visibility profiles (minimal / standard / advanced / full) |
| 💸 **Token efficient** | Layered context, progressive skill loading, tool search on demand |
| 🪶 **Lightweight** | Single process, embedded framework, runs on a phone |
| 📲 **Runs anywhere** | Termux on Android, Windows, macOS, Linux, Docker, or Electron desktop app |
| 🖥️ **Desktop app** | Electron tray app — local gateway or remote connect |

## Quick Start

### Desktop App

Pre-built installers are available on the [Releases](https://github.com/tscodeplus/OhMyAgent/releases) page for Windows, macOS, and Linux.

The desktop app can run as a **local gateway** (server + UI in one window) or connect to a **remote gateway** on another machine.

### One-Click Install

```bash
# Linux / macOS / Termux
curl -fsSL https://raw.githubusercontent.com/tscodeplus/OhMyAgent/main/install.sh | bash

# Windows (PowerShell)
iwr -Uri "https://raw.githubusercontent.com/tscodeplus/OhMyAgent/main/install.ps1" | iex
```

The script checks prerequisites, installs dependencies, and walks you through configuration interactively. After it finishes, the server starts automatically.

<details>
<summary>Manual install (if you prefer to set things up yourself)</summary>

### Prerequisites

- **Node.js** >= 20
- **pnpm** (recommended)
- **C++ build toolchain** (gcc/clang + make) — required for compiling native addons (`better-sqlite3` and `sqlite-vec`). Prebuilds are available for most common platforms; if installation fails with a compilation error, install `build-essential` (Linux), Xcode Command Line Tools (macOS), or Visual Studio Build Tools (Windows).

### Install & Run

```bash
git clone https://github.com/tscodeplus/OhMyAgent.git
cd OhMyAgent
pnpm install

cp config.yaml.example config.yaml
cp .env.example .env
```

**Minimal `.env` configuration:**

```bash
PI_AI_API_KEY=your-api-key-here   # required
WEBUI_TOKEN=your-chosen-password    # optional but recommended
```

```bash
pnpm dev
```

Open `http://localhost:9191/webui` and log in with your `WEBUI_TOKEN`.

</details>

## Key Features

### 🧠 Memory That Remembers

OhMyAgent's memory system is its core, not an afterthought:

- **Hybrid retrieval** — vector similarity (sqlite-vec cosine + vec search) combined with FTS5 BM25 full-text search and term sidecar index, merged via RRF or coverage-based fusion
- **LLM-driven summarization** — incremental session summaries extract preferences and key facts, compressing conversation history without losing signal
- **DreamCycle nightly maintenance** — 8-phase background job: lint orphan records, rebuild entity links, re-extract entities, cluster scenes, expire stale memories, fill missing embeddings, and evict cache
- **Scene clustering** — groups memories by scope + time windows into structured Markdown documents, enabling long-term narrative recall
- **Entity graph expansion** — regex-based entity extraction builds a `memory_links` graph; retrieval traverses related memories you didn't explicitly ask for
- **Memory hygiene** — automatic cleanup of temporary facts and tasks while preserving preferences and summaries indefinitely
- **Persona distillation** — background persona extraction from accumulated memories, giving the agent a stable sense of who you are
- **Multi-pool recall** — current / shared / other-agent pools with weighted scoring, temporal decay, and confidence-based reranking
- **Embedding cache** — SHA256 content-addressed cache with LRU eviction, so repeated queries avoid redundant embedding API calls

The result: your agent builds a real understanding of who you are over time.

### 🛡️ Respects Your Boundaries

Every tool execution passes through a **policy engine**:

```
Agent decides → Policy check → Approval gate → Execute (or deny)
```

- Shell commands require explicit approval (with allowlisting)
- File access is path-scoped and audited
- Custom approval flows per skill, per tool, per session

### 💸 Token-Optimized by Design

Built to minimize LLM costs without sacrificing quality:

- **Layered context** — only relevant content makes it into the prompt, keeping base overhead lean
- **Progressive skill loading** — skill names only (≈20 tokens each) until a skill is triggered
- **Tool search on demand** — deferrable tools activate via regex matching, not dumped into every request

### 📡 Multi-Channel

One agent across your messaging apps: **Feishu (Lark)** with CardKit 2.0 streaming cards, **Telegram**, **WeChat**, **QQ**, plus a **cron scheduler** for automated tasks.

### 🖥️ Flexible Deployment

| Mode | Description |
|---|---|
| CLI / Service | `pnpm dev` — minimal footprint, runs anywhere Node.js does |
| WebUI | Full chat interface at `http://host:port/webui` |
| Desktop App | Electron tray app — close-to-tray, auto-start |
| Local Gateway | Server + UI bundled in one desktop window |
| Remote Gateway | Desktop app connects to a remote server |
| Android (Termux) | Native — your phone as the server |

## Architecture

```
Message (Feishu / Telegram / WeChat / QQ)
        ↓
   Skill Router ──→ Memory Retriever (SQLite + sqlite-vec)
        ↓                  ↓
   Context Assembler ←──────┘
        ↓
   Agent (pi) ──→ Tool Policy Gate
        ↓                    ↓
   LLM Provider ←── Tool Execution (with approval)
        ↓
   Streaming Response ──→ Channel Reply
```

## References

OhMyAgent is built on [pi](https://github.com/earendil-works/pi) (formerly pi-mono, MIT © Mario Zechner), an embedded multi-provider AI agent framework.

Design inspiration from [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes Agent](https://github.com/NousResearch/hermes-agent) — two pioneering open-source AI agent projects.

Agent templates sourced from [agency-agents](https://github.com/msitarzewski/agency-agents) and [agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh).

Memory system architecture partially inspired by [TencentDB-Agent-Memory](https://github.com/TencentCloudBase/TencentDB-Agent-Memory).

## License

[MIT](https://opensource.org/licenses/MIT) — see [LICENSE](LICENSE).

---

<p align="center">
  <a href="README_zh.md">🇨🇳 中文文档</a>
</p>
