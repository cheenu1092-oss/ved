# Ved Architecture

A technical overview of how Ved works under the hood.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Ved Runtime                              │
│                                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Channels │  │ Event Loop│  │ Trust    │  │ MCP Client   │   │
│  │ (Discord,│──│ (7-step   │──│ Engine   │──│ (tool router)│   │
│  │  CLI)    │  │  pipeline)│  │          │  │              │   │
│  └──────────┘  └─────┬─────┘  └──────────┘  └──────────────┘   │
│                      │                                           │
│         ┌────────────┼────────────┐                              │
│         │            │            │                               │
│  ┌──────▼──┐  ┌──────▼──┐  ┌─────▼────┐                        │
│  │ LLM     │  │ Memory  │  │ Audit    │                        │
│  │ Client  │  │ (4-tier)│  │ Store    │                        │
│  │         │  │         │  │ (SQLite) │                        │
│  └─────────┘  └────┬────┘  └──────────┘                        │
│                    │                                             │
│     ┌──────────────┼──────────────┐                              │
│     │              │              │                               │
│  ┌──▼───┐  ┌──────▼──┐  ┌───────▼──┐                           │
│  │ T1   │  │ T2-T3   │  │ T4       │                           │
│  │ RAM  │  │ Vault   │  │ SQLite + │                           │
│  │      │  │ (Obsid.)│  │ RAG      │                           │
│  └──────┘  └─────────┘  └──────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

## Message Pipeline (7 Steps)

Every message flows through the same deterministic pipeline:

```
1. RECEIVE    → Channel adapter normalizes input
2. ENRICH     → RAG injects relevant context from vault + embeddings
3. DECIDE     → Trust engine evaluates risk, creates work orders if needed
4. ACT        → LLM generates response, may request tool calls
5. RECORD     → Audit store logs everything (hash-chained)
6. RESPOND    → Channel adapter delivers response to user
7. MAINTAIN   → Compression, session cleanup, cron tick
```

### Step Details

**1. Receive:** Messages arrive from channels (CLI, Discord). The channel adapter normalizes them into a `ChannelMessage` (id, content, author, channel, timestamp). Approval commands (`approve`/`deny`/`pending`) are intercepted here and handled as control plane operations — they never reach the LLM.

**2. Enrich:** The RAG pipeline queries the knowledge base with the message content. Results (FTS5 full-text + vector similarity + graph neighbors) are fused with reciprocal rank fusion, scored, and injected into the system prompt as additional context. Failure is non-fatal — the message continues without enrichment.

**3. Decide:** The trust engine resolves the sender's trust tier (1-4) and assesses the risk of the requested action (low/medium/high/critical). The trust×risk matrix determines the outcome:
- **Auto-approve:** Action proceeds immediately
- **Create work order:** Action queued for human approval
- **Deny:** Action rejected outright

**4. Act:** The assembled prompt (system + facts + RAG context + conversation history) is sent to the LLM. If the LLM requests tool calls, each tool is routed to the appropriate MCP server. Tool results feed back into the LLM for an agentic loop (capped at 10 iterations). Tool calls are individually trust-gated.

**5. Record:** Every significant event is appended to the hash-chained audit log. Each entry includes a SHA-256 hash linking to the previous entry, creating a tamper-evident chain. Optional HMAC external anchoring provides independent verification.

**6. Respond:** The LLM response is sent back through the originating channel. Discord responses handle message splitting (2K limit), code block preservation, typing indicators, and rich embeds for approval notifications.

**7. Maintain:** Session housekeeping runs after each message — T1→T2 compression check (threshold/idle triggers), stale session cleanup, cron tick evaluation.

## Memory Architecture

### T1: Working Memory (RAM)
- Current conversation context
- Stored in `SessionManager` as `ConversationMessage[]`
- Injected into every LLM prompt
- Compressed to T2 when session closes or thresholds fire

### T2: Episodic Memory (Obsidian daily notes)
- Files: `~/ved-vault/daily/YYYY-MM-DD.md`
- LLM-generated session summaries with structured sections:
  - Summary paragraph
  - Key facts
  - Decisions made
  - TODOs
  - Entities mentioned
- Human-readable, searchable via RAG

### T3: Semantic Memory (Obsidian knowledge graph)
- Files organized by type:
  - `entities/` — people, orgs, places
  - `projects/` — active work
  - `concepts/` — ideas, technologies
  - `decisions/` — dated records with reasoning
  - `topics/` — broad knowledge areas
- YAML frontmatter: type, confidence, source, tags, created, updated
- Wikilinks (`[[entity-name]]`) form graph edges
- Updated during T1→T2 compression (entity upserts)
- Viewable in Obsidian as an interactive graph

### T4: Archival (SQLite + RAG)
- Hash-chained audit log (tamper-evident)
- FTS5 full-text search index
- Vector embeddings (via Ollama `nomic-embed-text`)
- Trust ledger, work order history
- Backup/restore, migration tracking

### Compression Flow (T1→T2→T3)

```
Session ends / threshold hit / idle timeout
    │
    ▼
Compressor sends conversation to LLM
    │
    ▼
LLM returns structured summary:
  { summary, facts[], decisions[], todos[], entities[] }
    │
    ├──► T2: Write daily note (daily/YYYY-MM-DD.md)
    │
    ├──► T3: Upsert entities (entities/<slug>.md)
    │         Content filtered for sensitive data
    │
    └──► RAG: Re-index updated files
```

## Trust Engine

### Trust Tiers

| Tier | Name | Behavior |
|------|------|----------|
| 1 | Unknown | All actions gated. Must be approved. |
| 2 | Recognized | Low-risk auto-approved. Medium+ gated. |
| 3 | Trusted | Low + medium auto-approved. High gated. |
| 4 | Owner | Full access. Can approve/deny work orders. |

### Trust × Risk Matrix

```
              Low    Medium   High    Critical
Tier 1:      gate    gate    gate     deny
Tier 2:      auto    gate    gate     deny
Tier 3:      auto    auto    gate     deny
Tier 4:      auto    auto    auto     gate
```

### Work Orders
When an action is gated, a work order is created with:
- Action details (tool, parameters)
- Risk assessment (level + reasons)
- Expiry time
- Creator (session + actor)

Owners approve/deny via CLI commands or the web dashboard. Approved orders trigger deferred tool execution with the original parameters.

### Risk Assessment
Actions are classified by:
- Tool category (file I/O = medium, shell exec = high, network = high)
- File extension (`.sh`, `.bat` → escalated to high)
- Parameter patterns (destructive flags, sensitive paths)

## Module Map

```
src/
├── types.ts          # Shared TypeScript types (538 lines)
├── db.ts             # SQLite connection manager + migrations
├── audit.ts          # Hash-chained audit log + HMAC anchoring
├── trust.ts          # Trust tiers, risk matrix, work orders, ledger
├── core.ts           # SessionManager, EventLoop (7-step pipeline)
├── memory.ts         # VaultManager (file I/O, git, path containment)
├── llm.ts            # Multi-provider LLM client (Anthropic, OpenAI, Ollama)
├── mcp/              # MCP tool client (stdio servers)
├── rag.ts            # FTS5 + vector + graph fusion search
├── channel.ts        # Channel adapters (Discord, CLI)
├── compressor.ts     # T1→T2 memory compression
├── http.ts           # REST API + SSE + web dashboard
├── event-bus.ts      # Typed pub/sub event system
├── webhook.ts        # Webhook delivery with HMAC signing
├── app.ts            # VedApp wiring (dependency injection)
├── cli.ts            # CLI entry point (46 commands)
├── cli-*.ts          # Individual CLI command implementations
└── index.ts          # Root exports
```

## Data Flow Diagrams

### Chat Message Flow
```
User types in CLI/Discord
    │
    ▼
Channel.receive() → ChannelMessage
    │
    ▼
Is it approve/deny/pending? ──yes──► ApprovalParser → resolve work order
    │ no
    ▼
EventLoop.processMessage()
    │
    ├─► RAG.search(content) → inject context
    │
    ├─► Trust.resolve(author) → tier
    │   Trust.assessRisk(action) → risk level
    │   Matrix lookup → auto/gate/deny
    │
    ├─► LLM.chat(messages) → response
    │   │
    │   └─► Tool calls? → MCP.callTool() → results → back to LLM
    │       (loop up to 10x)
    │
    ├─► AuditLog.append() (for each step)
    │
    ├─► Channel.send(response)
    │
    └─► Maintain: compression check, session cleanup
```

### Startup Sequence
```
ved start
    │
    ├─► Load config (config.yaml + config.local.yaml + env overlay)
    ├─► Initialize SQLite (WAL mode, run migrations)
    ├─► Initialize vault (ensure directories, git init)
    ├─► Index vault → RAG (incremental: skip unchanged files)
    ├─► Start channels (Discord connect, CLI ready)
    ├─► Start file watcher (vault changes → RAG re-index)
    ├─► Start cron scheduler (tick every 30s)
    ├─► Start HTTP server (REST + SSE + dashboard)
    ├─► Start event loop (process incoming messages)
    └─► Ready
```

## Security Model

### Defense Layers
1. **Trust engine** — every action is risk-assessed before execution
2. **Hash-chain audit** — tamper-evident log of all operations
3. **HMAC anchoring** — external verification of audit integrity
4. **Content filter** — 11 patterns strip sensitive data (API keys, tokens, passwords) from T2/T3 memory writes
5. **NFKC normalization** — Unicode confusable and zero-width character bypass prevention
6. **Path containment** — all vault I/O methods enforce path traversal protection
7. **SQL injection** — parameterized queries everywhere, no string interpolation
8. **Dangerous command blocking** — hooks/scripts blocked from `rm -rf`, `sudo`, `dd`, fork bombs
9. **Work order expiry** — gated actions expire, preventing stale approval attacks

### Verified via Red-Team Testing
- 21 vulnerabilities found and fixed across 8 red-team sessions
- 500+ dedicated red-team tests
- Attack categories: prompt injection, path traversal, trust escalation, race conditions, content filter bypass, ReDoS, SSRF, shell injection, SQL injection

## Technology Stack

- **Runtime:** Node.js (ESM, TypeScript)
- **Database:** SQLite (better-sqlite3, WAL mode)
- **LLM:** Anthropic / OpenAI / Ollama / OpenRouter
- **Embeddings:** Ollama (nomic-embed-text)
- **Tools:** MCP protocol (stdio transport)
- **Knowledge:** Obsidian vault (Markdown + YAML frontmatter + wikilinks)
- **Testing:** Vitest (3,600+ tests)
- **HTTP:** Node.js `node:http` (zero deps)
- **Build:** TypeScript compiler → ESM modules

## Stats (v0.9.0)

- **Source:** ~45,100 lines of TypeScript
- **Tests:** 3,586 passing (88 test files)
- **CLI commands:** 46
- **HTTP endpoints:** 30+
- **Security vulns:** 21 found, 21 fixed, 0 open
- **npm package:** 592KB (390 files)
- **Dependencies:** Minimal (better-sqlite3, discord.js)
