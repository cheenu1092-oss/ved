# Session 25 — PLAN: Database Schema & Migration System

**Date:** 2026-03-05
**Phase:** PLAN (2 of 5)
**Duration:** ~15 min

## What Was Done

### Complete Database Schema (v001)
Expanded the 8-table draft from Session 24 into a production-ready 16-table DDL:

**Expanded tables (6):**
- `inbox` — added `channel_id`, `author_name`, `metadata`, `error`, `session_id`
- `sessions` — added `channel_id`, `trust_tier`, `token_count`, `closed_at`, `summary`
- `audit_log` — added `session_id` for cross-referencing
- `anchors` — added `chain_length`, `algorithm`
- `work_orders` — added `tool_server`, `risk_reasons`, `expires_at`, `audit_id`
- `chunks` — added `heading_level`, `frontmatter`, `chunk_index`

**New tables (8):**
- `trust_ledger` — runtime trust tier management with revocation + audit trail
- `graph_edges` — wikilink relationship index for graph walk RAG retrieval
- `outbox` — crash-safe outgoing message queue (mirrors inbox pattern)
- `llm_calls` — detailed LLM request/response log (cost tracking, replay)
- `tool_calls` — MCP tool execution log with HITL linkage
- `mcp_servers` — MCP server configuration registry
- `cron_jobs` — internal scheduled task definitions
- `schema_version` — expanded with `filename` + `checksum` for tamper detection

### Migration System
- **Forward-only SQL files** — no down migrations, no TypeScript DSL
- **Checksum validation** — SHA-256 of migration file stored on apply, verified on future runs
- **Transactional** — each migration in a transaction, atomic apply
- **File convention:** `v{NNN}_{description}.sql`
- **Full TypeScript runner** with `migrate()`, `currentVersion()`, `verify()`
- **Connection setup** with pragmas (WAL, FK, busy timeout, cache)

### Supporting Design
- **29 indexes** — every index mapped to a specific runtime query pattern
- **Data lifecycle & retention** — cleanup rules for transient vs. permanent data
- **1-year size estimate** — ~50-100MB for personal use

### Open Questions Resolved (all 5 from Session 24)
1. Migration system → forward-only SQL + checksums
2. Config format → YAML (`~/.ved/config.yaml`)
3. Error types → `VedError` class with string codes, no hierarchy
4. Logging → structured console JSON + audit_log (no pino dep)
5. Testing → unit (in-memory SQLite) + integration (Docker), `node:test`

## Output
- `docs/database-schema.md` (37KB) — complete DDL, migration runner, lifecycle, decisions

## Next Session
**Session 26:** PLAN — Config schema (YAML format, TypeScript interface, validation, defaults) + Ved error codes catalog + structured logging design.
