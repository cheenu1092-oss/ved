# Session 21 — THINK: Core Event Loop Design

**Date:** 2026-03-04 20:16 PST  
**Phase:** THINK (1 of 3)  
**Focus:** Core event loop + message flow architecture  

## What Happened

Designed Ved's core runtime event loop from scratch. This is the heartbeat of the entire agent.

### Key Design Decisions

1. **Single-threaded, message-driven loop** — No concurrency within a session. One message fully processed before the next. Eliminates race conditions on memory, audit chains, and tool execution. Ved is personal (one user) so this is the right trade-off.

2. **7-step pipeline:** RECEIVE → ENRICH → DECIDE → ACT → RECORD → RESPOND → MAINTAIN
   - RECEIVE: Channel adapters produce messages, persisted to SQLite inbox immediately (crash-safe)
   - ENRICH: Load T1 working memory + T2 daily notes + T3 RAG results into prompt
   - DECIDE: LLM returns text, tool calls, and/or memory operations
   - ACT: Trust gate evaluates each tool call against trust matrix → auto/approve/deny
   - RECORD: Hash-chain audit entry for every action
   - RESPOND: Send back to originating channel
   - MAINTAIN: Async housekeeping (compression, re-indexing, session boundaries)

3. **Agentic loop** — When LLM requests tool calls, sub-loop: DECIDE → TRUST GATE → EXECUTE → append results → DECIDE again. Max 10 iterations. Budget-capped.

4. **Trust matrix** — 4 trust tiers × 4 risk levels = 16 cells. Each maps to auto/approve/deny. Owner auto-approves everything except critical. Strangers need approval for everything.

5. **Crash recovery** — On startup: mark incomplete work orders as failed, resume unprocessed inbox messages, reload T1 from last session state.

6. **Hub-and-spoke module topology** — ved-core depends on all modules. No module depends on core. Clean boundaries.

### Artifacts Produced

- `docs/event-loop.md` — Full design document (14.7KB) covering:
  - Core types (VedMessage, WorkOrder, MemoryOp, AuditEntry)
  - Event loop steps with code sketches
  - Agentic loop with safety rails
  - Concurrency model (none — by design)
  - Session lifecycle (INIT → IDLE → ACTIVE → SHUTDOWN)
  - Configuration schema (VedConfig)
  - Module boundaries
  - SQLite schema (inbox, sessions, embeddings, vault_fts)
  - Comparison table: Ved vs OpenClaw

### Open Questions (for Session 22)

1. Obsidian vault conventions — frontmatter schema, wikilink semantics, folder vs tag organization
2. Git integration strategy — auto-commit vs batch, commit message format
3. T1→T2 compression prompt design — how to extract entities for T3
4. Vault file naming conventions
5. Offline/local LLM fallback strategy

## Stats
- **Design doc:** 14.7KB, 11 sections
- **New types defined:** 8 (VedMessage, VedResponse, WorkOrder, LLMDecision, MemoryOp, AuditEntry, ChannelAdapter, VedConfig)
- **SQLite tables designed:** 4 new (inbox, sessions, embeddings, vault_fts) + 2 reused from Witness (audit_log, work_orders)
