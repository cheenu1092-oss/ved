# Ved

**The personal AI agent that remembers everything and proves it.**

Ved is a lightweight, standalone AI assistant with auditable memory. Every action is hash-chain logged. Every memory is a Markdown file you can read, edit, and visualize. Every tool call is an MCP server you can inspect.

No black boxes. No cloud lock-in. Just a single TypeScript binary, an Obsidian vault, and a SQLite database.

---

## Why Ved?

Every AI assistant today has the same problem: **you can't see what it knows, verify what it did, or fix what it got wrong.**

- ChatGPT's "memories" are an opaque list you can't search or connect.
- Agent frameworks store knowledge in vector DBs you can't read.
- Tool-calling systems run actions with no audit trail.
- Memory systems forget context or hallucinate connections.

Ved takes a different approach:

| Problem | Ved's Answer |
|---------|-------------|
| Memory is opaque | Your knowledge graph IS an Obsidian vault — Markdown files with wikilinks |
| No audit trail | Every action is hash-chain logged in SQLite. Tamper-evident. |
| Tools are black boxes | All tools are MCP servers with inspectable schemas |
| Trust is binary | 4-tier trust system with human-in-the-loop approval queues |
| Can't verify claims | Ved cites its sources — file paths, timestamps, confidence levels |

---

## Architecture

```
User (Discord/CLI) → Ved Core → Trust Engine → MCP Tools → LLM
                         │
                         ├── T1: Working Memory (in-prompt, RAM)
                         ├── T2: Episodic Memory (Obsidian daily notes)
                         ├── T3: Semantic Memory (Obsidian knowledge graph)
                         └── T4: Archival + Audit (SQLite + RAG embeddings)
```

**Core principles:**
- Single-threaded event loop. No race conditions. No locks.
- 7-step message pipeline: receive → enrich → decide → act → record → respond → maintain.
- Every state mutation is audited before execution.
- Crash recovery via work order replay.

---

## Memory

Ved has 4 memory tiers. Each serves a different purpose, and all are searchable.

### T1: Working Memory
Current conversation context. Lives in RAM. Injected into every LLM prompt. Compressed to T2 at session boundaries.

### T2: Episodic Memory
Daily notes in `~/ved-vault/daily/YYYY-MM-DD.md`. Auto-generated session summaries. Human-readable. Searchable via RAG.

### T3: Semantic Memory
The knowledge graph. An Obsidian vault with:
- `entities/` — people, organizations, places
- `projects/` — active work being tracked
- `concepts/` — ideas, technologies, mental models
- `decisions/` — dated decision records with reasoning
- `topics/` — broad knowledge areas

Every file has YAML frontmatter (type, confidence, source, tags). Wikilinks (`[[bob-friday]]`) are graph edges. Obsidian visualizes the whole thing as an interactive graph.

**You can open the vault in Obsidian and see Ved's entire mind.** Edit a file, and Ved picks up the change. It's a shared interface between human and agent.

### T4: Archival + Audit
SQLite database with:
- Hash-chained action log (every tool call, LLM response, memory edit)
- Vector embeddings for RAG search (nomic-embed-text via Ollama)
- FTS5 full-text search index
- Trust ledger and work order history
- External HMAC anchoring for tamper evidence

**Nothing is truly forgotten.** Moving a fact out of working memory means writing it to the vault. Compressing a session means archiving the transcript. Every transition is audited.

---

## RAG: How Ved Retrieves Knowledge

Three retrieval paths, fused into one ranking:

1. **Vector search** — semantic similarity via nomic-embed-text embeddings in SQLite (sqlite-vec)
2. **FTS5 search** — keyword/exact match via SQLite full-text search
3. **Graph walk** — follow wikilinks from top hits to pull in connected knowledge

Results are combined using Reciprocal Rank Fusion (RRF) and trimmed to a token budget before injection into the LLM prompt.

**Performance:** <600ms total retrieval for a 5000-chunk vault. The embedding call is the bottleneck; everything else is <15ms.

---

## Trust

Ved doesn't execute actions blindly. Every tool call is risk-assessed against a trust matrix:

|  | No-Risk | Low-Risk | Medium-Risk | High-Risk |
|--|---------|----------|-------------|-----------|
| **Tier 4 (Owner)** | Auto | Auto | Auto | Approve |
| **Tier 3 (Tribe)** | Auto | Auto | Approve | Deny |
| **Tier 2 (Known)** | Auto | Approve | Deny | Deny |
| **Tier 1 (Unknown)** | Approve | Deny | Deny | Deny |

Actions that need approval go into a queue. The human approves or rejects. The decision is logged.

---

## Tools

All tools are MCP (Model Context Protocol) servers. Ved discovers them at startup and routes LLM tool calls through the MCP client.

This means:
- Tools are separate processes with defined schemas
- You can inspect, replace, or add tools without touching Ved's core
- Any MCP-compatible tool works with Ved out of the box

---

## Audit Chain

Every action Ved takes is recorded in a hash-chain:

```
entry[n].hash = SHA-256(entry[n].data + entry[n-1].hash)
```

If any entry is modified, every subsequent hash breaks. You can verify the chain at any time.

For stronger guarantees, Ved periodically anchors chain state via external HMAC — a signed checkpoint that proves the chain existed at a specific time.

---

## Design Constraints

- **Single SQLite database.** No Postgres, no Redis, no vector DB service. One file.
- **Local-first.** LLM via Ollama or any OpenAI-compatible API. Embeddings via Ollama. No cloud dependencies for core functionality.
- **TypeScript + Node.js.** No framework. No ORM. Just `better-sqlite3`, `sqlite-vec`, and the standard library.

---

## CLI Commands (34)

| Command | Description |
|---------|-------------|
| `ved start` | Start the agent (event loop + channels) |
| `ved init` | Scaffold vault structure + config template |
| `ved chat` | Interactive REPL |
| `ved run` | One-shot query (non-interactive) |
| `ved search` | Query RAG pipeline (FTS + vector + graph fusion) |
| `ved memory` | Vault browser: list, show, graph walk, timeline, daily notes |
| `ved template` | Vault templates: create entities from 6 built-in types |
| `ved context` | Context window inspector: tokens, facts, messages, simulate |
| `ved prompt` | System prompt profiles: create, edit, use, test, diff |
| `ved stats` | Vault, RAG, audit, and session metrics |
| `ved config` | Validate, show (secrets redacted), print config path |
| `ved history` | Audit log viewer with chain integrity verification |
| `ved doctor` | 8-point self-diagnostics |
| `ved backup` | Create, list, restore vault+DB snapshots |
| `ved export` | Export vault to portable JSON |
| `ved import` | Import vault from JSON (merge/overwrite/fail modes) |
| `ved migrate` | Import from ChatGPT, Claude, Obsidian, CSV, JSONL, Markdown |
| `ved reindex` | Force-rebuild entire RAG index |
| `ved watch` | Standalone vault file watcher with live re-indexing |
| `ved upgrade` | Database migration lifecycle |
| `ved serve` | HTTP API server with web dashboard |
| `ved cron` | Scheduled job engine (5-field cron expressions) |
| `ved hook` | Lifecycle hooks: run shell commands on EventBus events |
| `ved notify` | Notification rules: terminal, desktop, command, log delivery |
| `ved pipe` | Multi-step pipelines (queries + shell commands) |
| `ved alias` | Command shortcuts with @-syntax |
| `ved env` | Environment manager (config overlays) |
| `ved trust` | Trust tier management + work order inspection |
| `ved user` | User profiles, sessions, activity |
| `ved log` | Structured log viewer/analyzer with tail mode |
| `ved profile` | Performance benchmarking for 7 subsystems |
| `ved diff` | Vault diff viewer & change tracker |
| `ved snapshot` | Vault point-in-time snapshots |
| `ved completions` | Shell completions (bash/zsh/fish) |

All commands support `--help`/`-h`. Shell completions cover all subcommands and flags.

---

## Getting Started

```bash
# Prerequisites: Node.js 20+, Ollama with nomic-embed-text

# Clone
git clone https://github.com/cheenu1092-oss/ved.git
cd ved

# Install
npm install

# Pull embedding model
ollama pull nomic-embed-text

# Initialize vault + config
ved init --vault ~/ved-vault

# Start the agent
ved start

# Or run a one-shot query
ved run "What do you know about Project Alpha?"

# Or start the web dashboard
ved serve --port 3000
```

---

## Name

**Ved** (वेद) — from the Sanskrit *Vedas*, meaning "knowledge." The oldest texts in any Indo-European language. A fitting name for an agent whose purpose is to know, remember, and prove.

---

## License

MIT

---

**Current stats:** 34 CLI commands • 2,393 tests • ~35,700 LoC • 0 open vulnerabilities (19 found and fixed)

*Built by [cheenu1092-oss](https://github.com/cheenu1092-oss). Designed in the open.*
