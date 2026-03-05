# Session 9 — PLAN: Data Model Finalization + Concurrency Validation

**Date:** 2026-03-04 08:16 PST  
**Phase:** PLAN (Session 4 of 5)  
**Objective:** Finalize data model, validate SQLite WAL concurrency, investigate `enqueueSystemEvent` timing, and align all source code to the finalized schema.

---

## 1. Data Model Decision: Keep Events + Work Orders Separate

**Decision: DO NOT merge events and work_orders tables.**

The Session 8 open question was whether to merge them. After analysis:

| Factor | Merged | Separate (chosen) |
|--------|--------|-------------------|
| Append-only invariant | ❌ Broken (WOs mutate) | ✅ Events never mutate |
| Hash chain integrity | ❌ Can't hash mutable rows | ✅ Chain covers events only |
| Query flexibility | ⚠️ Null-heavy columns | ✅ Each table purpose-fit |
| Denormalization cost | N/A | ~50 bytes per WO (tool_name + params duplication) |
| Join complexity | None | Minimal (WO.event_id FK) |

**Events are immutable, hash-chained, append-only.** Work orders are mutable state machines. Mixing them corrupts the core design principle.

---

## 2. Schema v2 — Finalized Changes

Updated `schema.sql` with all Session 7-8 refinements:

### Changes from v1 (Session 5):
1. **Renamed `params` → `params_json`** — clearer column name, avoids SQLite reserved word confusion
2. **Added `risk_reasons TEXT`** — JSON array of human-readable reasons (from risk assessment engine)
3. **Removed `decided_by`/`decided_at` from events** — decisions belong on work_orders, not events. Events record what *happened*, work orders track *decisions about blocked events*.
4. **Simplified event `action` enum** — removed `approved`/`rejected` from events (those are work order states). Events only: `logged | blocked | auto_approved`
5. **Added `PRAGMA busy_timeout = 5000`** — 5-second retry on SQLITE_BUSY for concurrent access
6. **Added `block_reason` to work_orders** — human-readable why the tool was blocked
7. **Added `resolution_note` to work_orders** — optional human note on approval/rejection
8. **Added `reexec_duration_ms` to work_orders** — track re-execution performance
9. **Added `idx_wo_tool` index** — query work orders by tool name
10. **Added `schema_version` config entry** — for future migrations

### Final Table Summary

| Table | Rows Grow? | Mutable? | Hash-chained? | Purpose |
|-------|-----------|----------|---------------|---------|
| `events` | Yes (append-only) | No | Yes | Audit log of every tool call |
| `work_orders` | Yes (per block) | Yes | No | Approval queue state machine |
| `trust_ledger` | Yes (per tool) | Yes | No | Auto-approval ramp tracking |
| `config` | Rarely | Yes | No | Runtime key-value settings |

---

## 3. `enqueueSystemEvent` Timing — Full Analysis

Investigated the OpenClaw source code to understand when system events are delivered.

### How It Works

```
enqueueSystemEvent(text, { sessionKey })
       ↓
In-memory Map<sessionKey, { queue: [], lastText, lastContextKey }>
       ↓
Queue entry: { text, ts: Date.now(), contextKey }
       ↓
drainSystemEventEntries(sessionKey) — called at START of next agent turn
       ↓
Prepended to system prompt as: "System: [HH:MM:SS] <text>"
```

### Key Findings

1. **Enqueue = in-memory queue push** (instant, no I/O)
2. **Drain = on next agent turn** (when user sends next message, or heartbeat fires)
3. **Deduplication** — if `text === lastText`, the event is SKIPPED (prevents spam)
4. **Max queue size** — bounded by `MAX_EVENTS` constant (events dropped if exceeded)
5. **Context key** — events with same `contextKey` replace each other (last wins)
6. **Format** — prepended as `System: [08:16:23] <compacted text>`

### Implications for Witness

**For `before_tool_call` blocks (Phase 2):**
- The agent gets the block error IMMEDIATELY (in current turn) via the thrown Error with `blockReason`
- The system event is SUPPLEMENTARY — it'll appear in the next turn as "System: ..."
- This means the agent can relay the block message to the user immediately from the error
- The system event serves as a follow-up notification (e.g., after approval)

**For approval notifications:**
- After `/witness approve`, we enqueue: "✅ Witness: Work order wo_xxx APPROVED. You may re-execute."
- This appears at the START of the next agent turn
- The agent processes it and can re-execute or inform the user
- There's a natural delay (user must send another message to trigger the next turn)

**Design decision: Use `contextKey` wisely.**
- Block notifications: `contextKey: 'witness:block:<woId>'` (prevents duplicate block alerts)
- Approval notifications: `contextKey: 'witness:resolved:<woId>'` (unique per resolution)

### Is this good enough for Phase 2 MVP?

**Yes.** The block error message is immediate (agent sees it mid-turn). The system event for approval/rejection is slightly delayed (next turn), but this is fine:
1. User types `/witness approve wo_xxx` → approval command fires → system event queued
2. User sends any follow-up message → agent sees "System: ✅ Approved" → can re-execute

The UX is: block → user told about block → user approves → user sends follow-up → agent re-executes. Natural and non-intrusive.

---

## 4. Source Code Updates

All source files updated to match finalized data model:

### `types.ts` — Cleaned and expanded
- Separated `EventAction` (logged/blocked/auto_approved) from `WorkOrderStatus` (pending/approved/rejected/expired/executed/failed)
- Added `WorkOrder`, `TrustEntry`, `RiskAssessment`, `ChainVerification` types
- Added `BeforeToolCallEvent`, `BeforeToolCallResult` for Phase 2 hooks
- Removed `decided_by`/`decided_at` from `AuditEvent` (moved to WorkOrder)

### `store.ts` — Full Phase 2 + Phase 3 implementation
- **Events:** `append()` now returns `string` (event ID) instead of full AuditEvent object — simpler, lighter
- **Work Orders:** `createWorkOrder()`, `getWorkOrder()`, `listWorkOrders()`, `resolveWorkOrder()`, `recordReexecution()`, `sweepExpiredWorkOrders()`, `pendingCount()`
- **Trust Ledger:** `checkTrust()`, `getTrust()`, `setAutoApprove()`
- **Automatic trust tracking:** `resolveWorkOrder()` auto-updates trust_ledger (approve increments approved_count, reject increments rejected_count and resets auto_approve)
- **Concurrency:** `busy_timeout = 5000` pragma for resilience

### `risk.ts` — Param-aware escalation engine
- Added `escalate()` helper (only escalates UP, never down)
- Param rules for: `exec` (rm -rf, sudo, elevated, curl, pip), `message` (send action), `Write`/`Edit` (.env, .pem, .ssh), `browser` (navigate)
- `assessRisk()` now accepts `mode` parameter and returns `RiskAssessment` with `shouldBlock`
- Blocking logic: `audit` = never, `gate-writes` = high+critical, `gate-all` = medium+high+critical

### `schema.sql` — v2 with all refinements (see Section 2)

---

## 5. Test Results — 52/52 Passing

### Test Suite

| Suite | Tests | Status |
|-------|-------|--------|
| `risk.test.ts` | 20 | ✅ All pass |
| `store.test.ts` | 32 | ✅ All pass |
| **Total** | **52** | ✅ |

### Test Coverage by Category

**Events (8 tests):** append, hash chain, verify, search by tool, search by params, stats, risk reasons, result truncation

**Work Orders (9 tests):** create, approve, reject, double-resolve prevention, re-exec success, re-exec failure, sweep expired, list pending, expires_at calculation

**Trust Ledger (6 tests):** approval tracking, rejection tracking, rejection resets auto-approve, auto-approve at threshold, below threshold, manual override

**Concurrency/WAL (5 tests):** 500 rapid sequential appends + chain verify, interleaved reads/writes, mixed event types with work orders, close/reopen chain continuity, full lifecycle chain integrity

**Edge Cases (4 tests):** empty database, special characters (emoji/unicode/nested), null optional fields, nonexistent work order ID

**Risk Assessment (20 tests):** base levels (low/medium/high), unknown tools, user overrides, param escalation (rm -rf, sudo, elevated, curl, pip, .env, .ssh, .pem, outbound message), blocking modes (audit/gate-writes/gate-all)

---

## 6. Concurrency Validation Results

### better-sqlite3 + WAL Concurrency Model

**Key insight:** better-sqlite3 is synchronous (runs on main thread). There are NO concurrent writers — Node.js event loop serializes all calls. WAL mode matters for:

1. **Multiple processes** reading the same DB (e.g., Gateway RPC handler reading while plugin hook writes)
2. **Read consistency** — WAL allows readers during writes without blocking
3. **Crash recovery** — WAL provides atomic writes

**For Witness specifically:**
- `after_tool_call` hooks fire in parallel (Promise.all) but each calls `store.append()` synchronously on the Node event loop — they naturally serialize
- The in-process `lastHash` and `lastSeq` tracking is safe because it's single-threaded
- `busy_timeout = 5000` protects against the rare case of an external process (Gateway RPC) querying while the plugin writes

### Test Results

- **500 rapid appends:** Chain intact, 0 errors, ~33ms total (~66μs per insert)
- **Interleaved reads/writes (150 operations):** All reads returned correct data mid-write-sequence
- **Close/reopen continuity:** Chain survives process restart (loadChainState from DB)
- **Mixed event types + work orders:** Work order mutations don't affect event chain

**Conclusion: SQLite WAL + better-sqlite3 is production-safe for Witness.**

---

## 7. Open Questions for Session 10 (Final PLAN Session)

1. **MVP scope lock** — Exact list: what ships in Phase 1 vs deferred. Plugin manifest, SKILL.md instructions, README.
2. **Testing strategy** — Mock `api` object for plugin integration tests (register(), hook handlers, command handler). Currently only store and risk are tested.
3. **Package structure** — Should Witness be an npm package, a ClawHub skill, or both? How does it integrate into OpenClaw's plugin loading?
4. **Config resolution** — How does `api.pluginConfig` map to `WitnessConfig`? What's the user-facing config format?
5. **README update** — Align README.md with finalized architecture (it was written in Session 5 before many design decisions).

---

## Summary

Session 9 finalized the **data model**, validated **SQLite WAL concurrency**, and aligned all source code:

1. **Data model decision:** Events and work_orders stay SEPARATE. Events are immutable and hash-chained. Work orders are mutable state machines. Merging would break the append-only invariant.
2. **Schema v2:** 10 changes from v1 — renamed params→params_json, added risk_reasons, removed decided_by/at from events, simplified event actions, added busy_timeout, improved work order fields.
3. **System event timing:** Enqueue is instant (in-memory). Drain happens at start of next agent turn. Block errors are immediate (thrown Error). Approval notifications arrive on next user message. This is good enough for Phase 2 MVP.
4. **All source updated:** types.ts, store.ts, risk.ts, schema.sql — fully aligned to finalized design.
5. **52 tests passing:** Events (8), work orders (9), trust ledger (6), concurrency (5), edge cases (4), risk assessment (20).
6. **Concurrency validated:** 500 rapid inserts + chain verify, interleaved R/W, close/reopen, full lifecycle — all pass. ~66μs per insert.
7. **Store API finalized:** append (returns ID), createWorkOrder, resolveWorkOrder, recordReexecution, sweepExpiredWorkOrders, checkTrust, getTrust, setAutoApprove.

---

*Session duration: ~25 min*  
*Phase status: PLAN session 4 of 5. Next: Session 10 — MVP scope lock + testing strategy + README.*
