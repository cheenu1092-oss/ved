# Project Ved — Session State

## Identity
- **Name:** Ved (from Vedas — knowledge)
- **Tagline:** The personal AI agent that remembers everything and proves it.
- **Type:** Standalone lightweight personal AI assistant (NOT a plugin, NOT a fork)
- **License:** MIT, open source from day 1

## Core Differentiators
1. Audit-first — every action hash-chain logged in SQLite
2. HITL-native — trust tiers + approval queues = execution engine
3. Obsidian-native memory — knowledge graph IS an Obsidian vault (human-readable, editable, visualizable)
4. 4-tier hierarchical memory — Working (RAM) + Episodic (daily notes) + Semantic (Obsidian graph) + Archival (SQLite audit + RAG)
5. MCP-native — all tools are MCP servers
6. Tiny — target <10K LoC

## Evolution
- Sessions 1-5: THINK → Analyzed Ruflo (96.5% bloat), pivoted away from fork
- Sessions 6-10: PLAN → Designed "Witness" as OpenClaw plugin
- Sessions 11-20: BUILD/TEST/RED-TEAM → 393 tests, 8 vulns found+fixed, Docker-first
- Session ~20: **PIVOT** → Not a plugin. Standalone agent. Name: Ved.
- Sessions 21+: Redesigning as standalone agent with hierarchical memory

## Reusable Assets (from Witness)
- ved-audit: store.ts, hash.ts, anchor.ts (393 tests)
- ved-trust: risk.ts, work orders, trust ledger
- Schema + migrations
- Dockerfile + docker-compose.yml
- GitHub: github.com/cheenu1092-oss/witness (will become ved)

## Phase Schedule
| Sessions | Phase | Description |
|----------|-------|-------------|
| 21-23 | THINK | Design runtime + memory architecture |
| 24-28 | PLAN | Architecture docs, memory schema, API specs |
| 29-30 | BUILD | Core runtime + audit + memory T4 |
| 31-32 | BUILD | Memory T1-T3 + LLM client |
| 33-34 | BUILD | MCP tool router + Discord channel |
| 35-36 | TEST | Integration testing (Docker) |
| 37-38 | RED-TEAM | Security + memory integrity attacks |
| 39+ | CYCLE | BUILD(2)/TEST(2)/RED-TEAM(2) |

## Current State
- **Session Number:** 28
- **Current Phase:** PLAN COMPLETE ✅ — Ready for BUILD
- **Last Run:** 2026-03-05
- **Cron ID:** cb0cd4f6-834e-42ea-a816-aecddc51ca2d
- **Next Session:** 29 — BUILD: `ved-types` + `ved-audit` + `ved-trust` + database schema (foundation)

## Session Log
(Sessions 1-20: see individual session files in sessions/)
- Sessions 1-5: THINK — Ruflo analysis, strategic pivot to OpenClaw plugin "Witness"
- Sessions 6-10: PLAN — Full architecture, 92 tests, plugin API designed
- Sessions 11-12: BUILD — GitHub repo, CI, Docker setup
- Sessions 13-14: TEST — 159 tests, benchmarks, e2e simulation
- Sessions 15-16: RED-TEAM — 5 vulns found+fixed, external anchoring
- Sessions 17-18: BUILD — CLI, migrations, validation, 300 tests
- Sessions 19-20: TEST/RED-TEAM — 393 tests, 8 total vulns found+fixed
- **Session 21:** THINK — Core event loop design. 7-step pipeline (receive→enrich→decide→act→record→respond→maintain). Trust matrix, agentic sub-loop, crash recovery. Produced `docs/event-loop.md` (14.7KB).
- **Session 22:** THINK — Obsidian memory deep dive. 6-folder vault structure, YAML frontmatter schemas, wikilink conventions, VaultManager interface, graph walk algorithm, T1→T2 compression, batched git integration, template system. Produced `docs/obsidian-memory.md` (26KB).
- **Session 23:** THINK — RAG pipeline design: heading-based chunking, sqlite-vec + FTS5 + graph walk, RRF fusion, async reindex queue. Ved manifesto README. Produced `docs/rag-pipeline.md` (27KB) + `README.md` (7KB). **THINK PHASE COMPLETE.**
- **Session 24:** PLAN — Module interfaces + TypeScript type definitions. All 8 modules + shared types fully specified. 48KB `docs/module-interfaces.md`: ved-types (shared), ved-core (EventLoop, SessionManager, WorkingMemory, MessageQueue), ved-llm (LLMClient, provider adapters), ved-mcp (MCPClient, transports), ved-memory (MemoryManager, VaultManager, VaultGit, TemplateEngine), ved-rag (RagPipeline, Embedder, Chunker), ved-audit (AuditLog, anchoring), ved-trust (TrustEngine, work orders), ved-channel (ChannelManager, adapters). Complete SQLite DDL. File structure with ~7,700 LoC estimate. Only 6 external deps.
- **Session 25:** PLAN — Complete database schema: 16 tables (8 expanded + 8 new), forward-only migration system with checksums, 29 indexes, data lifecycle rules, resolved all 5 open questions from S24. Produced `docs/database-schema.md` (37KB).
- **Session 26:** PLAN — Config schema (5-layer loading, 16 validation rules, `ved init`), error codes (42 codes, 10 categories, `VedError` class), structured logging (JSON/pretty, module-scoped, 14 audit event types). Produced `docs/config-errors-logging.md` (30KB). Zero new deps.
- **Session 27:** PLAN — MCP integration spec: server lifecycle (5-state FSM, lazy connect), stdio + HTTP/SSE transports (full implementation), tool discovery (namespacing, caching, dynamic changes), permission model (trust×risk matrix, server trust floors, tool filtering), execution flow (5-step sequential pipeline), retry/timeout (no tool retries, exponential backoff for servers), LLM formatting, built-in MCP servers (@ved/mcp-memory, @ved/mcp-vault-git). Resolved 6 open questions. Produced `docs/mcp-integration.md` (33KB).
- **Session 28:** PLAN — End-to-end walkthrough: traced full user message through all 7 pipeline steps and 8 modules. Validated 21 interface boundaries. Found 6 gaps (1 medium, 4 low, 1 trivial) — all resolved. Build order defined: types+audit+trust → core → memory → RAG → LLM → MCP+channels. Produced `docs/end-to-end-walkthrough.md` (35KB). **PLAN PHASE COMPLETE.**
- **Session 29 (next):** BUILD — `ved-types` + `ved-audit` + `ved-trust` + database schema (foundation, Docker)
