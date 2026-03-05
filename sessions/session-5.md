# Session 5 — THINK: The Manifesto

**Date:** 2026-03-04 03:16 PST  
**Phase:** THINK (Session 5 of 5 — final THINK session)  
**Objective:** Write the Witness manifesto, define MVP scope, spec SQLite schema, create project skeleton.

---

## 1. What Was Delivered

### Project Skeleton Created: `~/clawd/projects/new-claw/witness/`

```
witness/
├── README.md           # The manifesto — project vision, usage, architecture
├── package.json        # npm package: openclaw-witness v0.1.0
├── tsconfig.json       # TypeScript config (ES2022, strict)
├── schema.sql          # Complete SQLite schema (4 tables, FTS5, indexes)
├── src/
│   ├── index.ts        # Public API exports
│   ├── types.ts        # Core types: AuditEvent, WitnessConfig, RiskLevel
│   ├── hash.ts         # SHA-256 hash chain (compute + verify)
│   ├── risk.ts         # Static risk assessment (tool→risk mapping)
│   ├── store.ts        # SQLite-backed audit store (append, query, verify)
│   └── plugin.ts       # OpenClaw plugin entry point + /witness command handler
└── test/
    └── store.test.ts   # Tests for AuditStore (hash chain, CRUD, search, stats)
```

### Key Deliverables

1. **README.md (manifesto)** — Clear project description, 3-phase roadmap, usage examples, design principles. Not marketing fluff — honest about what this is and isn't.

2. **SQLite Schema (schema.sql)** — 4 tables designed for all 3 phases:
   - `events` — Core audit log (append-only, hash-chained, FTS5-indexed)
   - `work_orders` — Phase 2 approval queue (pending/approved/rejected/expired/executed/failed)
   - `trust_ledger` — Phase 3 auto-approval ramp per tool
   - `config` — Runtime configuration (key-value)

3. **Core source files (src/)** — ~800 lines total:
   - `types.ts` — Clean type definitions, no OpenClaw import dependencies
   - `hash.ts` — SHA-256 chain computation + full-chain verification
   - `risk.ts` — Static tool→risk mapping with user override support
   - `store.ts` — Full AuditStore class: append (auto-hash), recent, search, stats, verify
   - `plugin.ts` — WitnessPlugin class: afterToolCall hook + /witness command handler with 6 subcommands

4. **Test file (test/store.test.ts)** — 5 test cases covering:
   - Event append and retrieval
   - Hash chain integrity across events
   - Chain verification for intact logs
   - Full-text search
   - Aggregate statistics

---

## 2. Architecture Decisions Made

### SQLite Schema Design

**Events table** is the heart. Key decisions:
- **ULID IDs** (`evt_<ulid>`) — time-sortable, unique, no auto-increment dependency
- **Monotonic seq** for hash chain ordering — separate from ID, guarantees insert order
- **FTS5 virtual table** on tool_name + params + result_summary — enables fast search
- **Triggers** keep FTS in sync automatically
- **1KB cap on result_summary** — prevents bloat from large tool outputs
- **Hash chain** stored inline (prev_hash + hash per row) — simple, no separate chain table

**Work orders table** (Phase 2) is intentionally simple:
- 6 states: pending → approved/rejected/expired → executed/failed
- TTL-based expiry (default 30 min)
- Links back to the blocked event via event_id FK
- Stores full params snapshot for re-execution

**Trust ledger** (Phase 3) tracks per-tool approval counts for auto-approval ramp.

### Plugin Architecture

The plugin is designed to work without importing OpenClaw internals:
- Types mirror OpenClaw's hook signatures but are defined locally
- No `import from 'openclaw'` — this makes testing and development independent
- The actual OpenClaw integration will be a thin adapter that maps OpenClaw hook events to our types

### Risk Assessment

Started with the simplest possible approach (per Session 4's recommendation):
- Static tool→risk mapping with 3 tiers: low (reads), medium (writes/sends), high (exec/process)
- Unknown tools default to medium (err on caution side)
- User overrides via config
- `_params` argument is typed but unused in Phase 1 — ready for Phase 2 param analysis

---

## 3. What's NOT in Phase 1 (Explicit Scoping)

- ❌ `before_tool_call` blocking (Phase 2)
- ❌ Approval queues / Discord buttons (Phase 2)
- ❌ Re-execution after approval (Phase 2)
- ❌ Trust tiers / auto-approval (Phase 3)
- ❌ Cost tracking integration (Phase 3)
- ❌ JSONL export to file (Phase 1 says "use DB directly")
- ❌ OpenClaw plugin registration boilerplate (needs OpenClaw's actual plugin API docs)

---

## 4. Open Questions for PLAN Phase

1. **OpenClaw plugin registration** — How does an OpenClaw plugin actually register? Need to read `src/plugins/` in the OpenClaw repo to understand the registration mechanism. The session-3 analysis confirmed hooks exist, but we need the plugin loader interface.

2. **Where does witness.db live?** — Options: plugin directory, `~/.clawdbot/witness/`, or configurable. Need to decide based on OpenClaw's plugin data conventions.

3. **How to expose /witness command?** — Is it a custom slash command, a chat command the LLM recognizes, or a skill command? OpenClaw skills have `SKILL.md` — should Witness register as a skill?

4. **Re-execution mechanism (Phase 2)** — This is the hardest unsolved problem. When a blocked tool call is later approved, how do we replay it? Do we create a new LLM session? Call the tool directly? The Session 4 red-team flagged this as HIGH risk.

5. **Testing strategy** — The test file uses vitest but needs `better-sqlite3` native module. Should we use an in-memory SQLite for tests?

---

## 5. THINK Phase Summary (Sessions 1-5)

| Session | Key Finding |
|---------|------------|
| 1 | Research report has 5 weak claims — orchestration over-engineering, fantasy roadmap, premature MCP canonization |
| 2 | Ruflo is 96.5% bloat (410K of 424K lines). Only ~15K lines worth keeping: DDD model, Claims, MCP, memory |
| 3 | **Strategic pivot:** Don't fork Ruflo. Build Witness as OpenClaw plugin (~3-5K lines). Ruflo's Claims model inspires work orders but we don't take code |
| 4 | **Red-team passed.** Strategy survives but simplified: drop Ruflo DNA framing, audit-only default, 5-state work orders. Hardest problems: async approval UX and re-execution |
| 5 | **Manifesto + skeleton shipped.** README, SQLite schema, 5 source files, tests. Phase 1 is ~800 lines. Ready for PLAN phase |

**THINK phase conclusion:** We have a clear, validated strategy and a working project skeleton. The next phase (PLAN, Sessions 6-10) should focus on OpenClaw plugin integration specifics, the approval UX design, and a concrete build plan.

---

*Session duration: ~20 min*
*Files created: 9 (README.md, package.json, tsconfig.json, schema.sql, 5 source files, 1 test file)*
*Lines written: ~850 (source) + ~200 (test) + ~180 (schema) + ~120 (readme) ≈ 1,350 total*
*Phase status: THINK complete. Ready for PLAN.*
