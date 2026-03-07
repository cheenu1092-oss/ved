# Session 55 — `ved history` + `ved doctor` CLI

**Date:** 2026-03-06
**Phase:** CYCLE (BUILD)

## What Happened

### 1. `ved history` CLI Command (NEW)
Audit log viewer with filtering, verification, and JSON output:

```bash
ved history                          # Show last 20 entries
ved history -n 50                    # Show last 50 entries
ved history --type tool_executed     # Filter by event type
ved history --from 2026-03-01        # Filter from date
ved history --to 2026-03-06          # Filter to date
ved history --verify                 # Verify hash chain integrity
ved history --types                  # List all event types in log
ved history --json                   # Output as JSON
```

**Features:**
- Newest-first display with timestamp, event type, actor, session ID snippet
- Smart detail preview: shows `tool=` for tool events, content preview for messages, key=value for others
- Combined filters (type + date range + limit all compose)
- `--verify` runs hash chain integrity check and reports broken/intact status
- `--types` lists all distinct event types found in the audit log
- `--json` outputs raw JSON for piping/scripting
- Default limit: 20 entries

**Implementation:**
- `src/app.ts` — new `VedApp.getHistory()`, `VedApp.verifyAuditChain()`, `VedApp.getAuditEventTypes()` methods
- `src/cli.ts` — new `history` command with full arg parser

### 2. `ved doctor` CLI Command (NEW)
Self-diagnostics across 8 subsystems:

```bash
ved doctor
```

```
Ved v0.1.0 — Doctor

  ✅ Config: Valid configuration
  ✅ Database: SQLite OK (/path/to/ved.db)
  ✅ Vault structure: All 4 folders present
  ✅ Vault git: Clean working tree
  ✅ Audit chain: 42 entries, chain intact (verified last 42)
  ⚠️  RAG index: 3/5 files indexed (2 stale). Run 'ved reindex' (fixable)
  ✅ LLM: Connected
  ℹ️  MCP tools: No MCP servers configured

  Summary: 5 passed, 1 warnings, 0 failed, 1 info

  ⚠️  Some warnings. Ved will work but may not be fully operational.
```

**8 Diagnostic Checks:**
1. **Config** — validates configuration, reports required fields missing vs warnings
2. **Database** — runs SQLite `pragma integrity_check`
3. **Vault structure** — verifies all 4 folders exist (daily, entities, concepts, decisions)
4. **Vault git** — checks if git enabled, repo exists, working tree clean/dirty count
5. **Audit chain** — verifies hash chain integrity (last 100 entries for speed)
6. **RAG index** — compares indexed files vs vault files, reports stale/missing
7. **LLM** — runs provider health check
8. **MCP tools** — checks MCP server connectivity

**Status levels:** ok, warn, fail, info. Some issues marked `fixable` for future auto-fix.
**Exit code:** non-zero if any checks fail (for CI/scripting).

**Implementation:**
- `src/app.ts` — new `VedApp.doctor()` method (uses existing `DoctorCheck`/`DoctorResult` interfaces)
- `src/cli.ts` — new `doctor` command
- `validateConfig` import added to app.ts

### 3. CLI Updated
```
Usage: ved [init|start|status|stats|search|reindex|config|export|import|history|doctor|version]
```
Ved CLI now has **12 commands**.

### 4. Tests
23 new tests covering:
- **History (13):** empty log, entries after append, limit, type filter, date range, future range, verify intact, verify empty, event types distinct, event types empty, entry fields, default limit, combined filters
- **Doctor (10):** valid setup, missing subdirs, empty audit chain, valid audit chain, git disabled, tally correctness, result shape, 8 diagnostic areas, healthy DB, RAG mismatch

## Stats
- Tests: 1053/1053 pass (host + Docker parity)
- Type errors: 0
- New tests: 23
- Files changed: 3 (app.ts, cli.ts) + 1 test file
- Pushed to GitHub: 82d0ce4
- Ved CLI now has 12 commands
