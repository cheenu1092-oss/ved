# Ved

**The personal AI agent that remembers everything and proves it.**

Ved is a standalone AI assistant with auditable memory. Every action is hash-chain logged. Every memory is a Markdown file you can read and edit. Every tool call goes through an MCP server you can inspect.

No black boxes. No cloud lock-in. One TypeScript binary, an Obsidian vault, and a SQLite database.

```
npm install -g ved-ai
ved init       # choose provider, set API key, create vault
ved chat       # start talking
```

---

## 5 Things Ved Does Differently

### 1. Your memory is a folder of Markdown files
Ved's knowledge graph IS an Obsidian vault. Open it in Obsidian (or any editor) and you can see everything the agent knows — people, projects, decisions, concepts. Edit a file and Ved picks up the change. No opaque embedding stores, no proprietary formats.

### 2. Every action is hash-chain logged
Every LLM call, tool execution, memory write, and trust decision is recorded in a SQLite hash chain. Modify any entry and every subsequent hash breaks. Optional HMAC anchoring provides external tamper evidence. Run `ved history --verify` to prove integrity at any time.

### 3. Tool calls require human approval (when they should)
A 4-tier trust engine evaluates every tool call against a risk matrix. Owner-level users auto-approve low-risk actions. Unknown users need approval for everything. Medium/high-risk actions always go through a work order queue — approve or deny from Discord, CLI, or the web dashboard.

### 4. Memory compresses, not disappears
When a conversation gets long, Ved doesn't truncate — it summarizes. T1 working memory compresses into T2 daily notes (Markdown) with extracted facts, decisions, and entities promoted to T3 (the knowledge graph). The raw transcript is archived in T4. Nothing is lost; it just moves to a cheaper tier.

### 5. 500+ red-team tests, 21 vulnerabilities found and fixed
Ved was built security-first. Every new feature gets a red-team session: prompt injection, path traversal, trust escalation, race conditions, content filter evasion. 21 vulnerabilities were found and fixed before v1.0. Zero open security issues.

---

## How It Compares

| Feature | Ved | ChatGPT Memories | Claude Projects | MemGPT/Letta | Cursor |
|---------|-----|------------------|-----------------|--------------|--------|
| Memory format | Markdown files (Obsidian vault) | Opaque list | Project docs | JSON in vector DB | Codebase context |
| Memory is human-readable | ✅ Edit in any editor | ❌ API only | ⚠️ Upload only | ❌ | ⚠️ Code only |
| Audit trail | Hash-chain + HMAC | ❌ | ❌ | ❌ | ❌ |
| Trust tiers | 4-tier HITL | ❌ | ❌ | ❌ | ❌ |
| Works offline | ✅ (Ollama) | ❌ | ❌ | ⚠️ (needs API) | ⚠️ (needs API) |
| Tool calling | MCP servers | Plugins (closed) | ❌ | Functions | ❌ |
| Self-hosted | ✅ | ❌ | ❌ | ✅ | ❌ |
| Verifiable actions | ✅ (chain verify) | ❌ | ❌ | ❌ | ❌ |

---

## What Can Ved Do?

**Remember and retrieve**
```bash
# Search across all your knowledge
ved search "what did we decide about the API design?"

# Browse the knowledge graph
ved memory graph "project-alpha" --depth 2

# View today's notes
ved memory daily
```

**Chat with context**
```bash
# Interactive conversation with memory
ved chat

# One-shot query (scripts, automation)
ved run "Summarize what happened this week"

# Chain queries and commands into pipelines
ved pipe "list active projects" "!sort" "summarize priorities"
```

**Manage knowledge**
```bash
# Create entities from templates
ved template use person --var name="Bob Friday" --var role="Chief AI Officer"

# Import from other tools
ved migrate obsidian ~/my-vault
ved migrate json chatgpt-export.json

# Export everything
ved export --with-audit > backup.json
```

**Monitor and verify**
```bash
# Verify audit chain integrity
ved history --verify

# Run diagnostics
ved doctor --fix

# Watch vault changes in real-time
ved watch

# Web dashboard with live event stream
ved serve --port 3141
```

**Automate**
```bash
# Schedule recurring jobs
ved cron add "0 9 * * *" reindex     # re-index vault every morning
ved cron add "0 0 * * 0" backup      # weekly backup

# Lifecycle hooks
ved hook add audit_entry "curl -X POST https://my-webhook/events"

# Desktop notifications
ved notify add tool_executed --channel desktop
```

---

## Architecture

```
User (Discord / CLI / HTTP) → Ved Core → Trust Engine → MCP Tools → LLM
                                  │
                                  ├── T1: Working Memory (in-prompt, RAM)
                                  ├── T2: Episodic Memory (Obsidian daily notes)
                                  ├── T3: Semantic Memory (Obsidian knowledge graph)
                                  └── T4: Archival + Audit (SQLite + RAG embeddings)
```

**Core design:**
- Single-threaded event loop — no race conditions, no locks
- 7-step message pipeline: receive → enrich → decide → act → record → respond → maintain
- Every state mutation is audited before execution
- Crash recovery via work order replay

---

## Memory Tiers

### T1: Working Memory
Current conversation. Lives in RAM. Injected into every LLM prompt. Compressed to T2 when it gets large or the session goes idle.

### T2: Episodic Memory
Daily notes in `~/ved-vault/daily/YYYY-MM-DD.md`. Auto-generated session summaries with extracted facts, decisions, and TODOs. Human-readable.

### T3: Semantic Memory
The knowledge graph. An Obsidian vault with `entities/`, `projects/`, `concepts/`, `decisions/`, `topics/`. Every file has YAML frontmatter. Wikilinks (`[[bob-friday]]`) are graph edges. Open the vault in Obsidian and see the agent's entire mind as an interactive graph.

### T4: Archival + Audit
SQLite with hash-chained audit log, vector embeddings for RAG search, FTS5 full-text index, trust ledger, work order history, and HMAC anchoring.

---

## RAG Pipeline

Three retrieval paths, fused into one ranking:

1. **Vector search** — semantic similarity via nomic-embed-text embeddings (sqlite-vec)
2. **FTS5 search** — keyword/exact match via SQLite full-text search
3. **Graph walk** — follow wikilinks from top hits to pull in connected knowledge

Results are combined using Reciprocal Rank Fusion (RRF) and trimmed to a token budget. Retrieval takes <600ms on a 5,000-chunk vault.

---

## Trust Engine

Every tool call is risk-assessed:

|  | No-Risk | Low-Risk | Medium-Risk | High-Risk |
|--|---------|----------|-------------|-----------|
| **Tier 4 (Owner)** | Auto | Auto | Auto | Approve |
| **Tier 3 (Tribe)** | Auto | Auto | Approve | Deny |
| **Tier 2 (Known)** | Auto | Approve | Deny | Deny |
| **Tier 1 (Unknown)** | Approve | Deny | Deny | Deny |

Actions requiring approval enter a work order queue. Approve or deny from Discord, CLI, or the web dashboard.

---

## Tools

All tools are MCP (Model Context Protocol) servers. Ved discovers them at startup and routes LLM tool calls through the MCP client. Any MCP-compatible tool works out of the box.

```yaml
# config.yaml
mcp:
  servers:
    - name: calculator
      transport: stdio
      command: node
      args: [./my-tools/calc-server.js]
      enabled: true
```

---

## Audit Chain

Every action is recorded in a hash chain:

```
entry[n].hash = SHA-256(entry[n].data + entry[n-1].hash)
```

Modify any entry and every subsequent hash breaks. Periodic HMAC anchoring provides external tamper evidence.

---

## Getting Started

### Quick Start (npm)

```bash
# Requires Node.js 20+
npm install -g ved-ai

# Interactive setup — choose LLM provider, enter API key, configure trust
ved init

# Start chatting
ved chat
```

### From Source

```bash
git clone https://github.com/cheenu1092-oss/ved.git
cd ved && npm install && npm run build

# Optional: local embeddings for RAG
ollama pull nomic-embed-text

ved init
ved chat
```

### Web Dashboard

```bash
ved serve --port 3141
# Open http://localhost:3141
```

### Config IDE Support

Add a `$schema` comment to your `config.yaml` for autocompletion:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/cheenu1092-oss/ved/main/config.schema.json

llm:
  provider: ollama
  model: qwen3:1.7b
# ...
```

See [docs/getting-started.md](docs/getting-started.md) for the full walkthrough.

---

## CLI Commands (46)

| Category | Commands |
|----------|----------|
| **Core** | `start`, `init`, `chat`, `run`, `serve` |
| **Knowledge** | `memory`, `search`, `template`, `context`, `prompt`, `graph`, `task` |
| **Data** | `export`, `import`, `migrate`, `sync`, `backup`, `snapshot` |
| **Observability** | `stats`, `history`, `doctor`, `log`, `profile`, `replay`, `diff` |
| **Automation** | `cron`, `hook`, `notify`, `pipe`, `alias` |
| **Configuration** | `config`, `env`, `agent`, `upgrade`, `completions` |
| **Diagnostics** | `doctor`, `reindex`, `watch`, `quickstart`, `help`, `version` |

Every command supports `--help`. Shell completions install automatically.

See [docs/api-reference.md](docs/api-reference.md) for full usage.

---

## Design Constraints

- **Single SQLite database.** No Postgres, no Redis, no vector DB service.
- **Local-first.** LLM via Ollama or any OpenAI-compatible API. Embeddings via Ollama.
- **TypeScript + Node.js.** No framework, no ORM. `better-sqlite3`, `sqlite-vec`, standard library.
- **~45K LoC.** Small enough for one person to understand.

---

## Name

**Ved** (वेद) — from the Sanskrit *Vedas*, meaning "knowledge." The oldest texts in any Indo-European language.

---

## Stats

| Metric | Value |
|--------|-------|
| CLI commands | 46 |
| Tests | 3,600+ |
| Lines of code | ~45,000 |
| Vulnerabilities found | 21 (all fixed) |
| Red-team tests | 500+ |
| npm package size | 592 KB |
| Open security issues | 0 |

---

## License

MIT

---

*Built by [cheenu1092-oss](https://github.com/cheenu1092-oss). Designed in the open.*
