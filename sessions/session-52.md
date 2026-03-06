# Session 52 — `ved stats` + Incremental Startup Indexing + Git Auto-Commit

**Date:** 2026-03-06
**Phase:** CYCLE (BUILD)

## What Happened

### 1. `ved stats` CLI Command (NEW)
Added a comprehensive stats command showing system-wide metrics:

```bash
ved stats
```

**Output sections:**
- 📚 **Vault:** file count, tag count, type count, git clean/dirty status
- 🔍 **RAG Index:** files indexed, chunks, FTS entries, graph edges, queue depth
- 🔗 **Audit:** chain length, chain head hash (truncated to 12 chars)
- 💬 **Sessions:** active (active+idle) and total count

**Implementation:**
- `VedApp.getStats()` — new public method aggregating stats from vault index, RAG, audit chain head, and session DB queries
- `cli.ts` — new `stats` case in command switch, formatted console output
- Usage string updated: `ved [init|start|status|stats|reindex|version]`

### 2. Incremental Startup Indexing (ENHANCED)
Previously, `indexVaultOnStartup()` was binary: skip entirely if RAG index had any files, or full reindex if empty. Now it's smart:

**Logic:**
- If RAG index is **empty** → full reindex (same as before)
- If RAG index is **populated** → compare each vault file's `mtime` against its `indexed_at` in the chunks table
  - Files modified after `indexed_at` → re-index individually
  - Files not in index → re-index
  - Files up-to-date → skip

**New methods in `VedApp`:**
- `findStaleFiles(files)` — compares vault file mtimes against indexed_at timestamps
- `getFileIndexedAt(filePath)` — queries `MAX(indexed_at)` from chunks table for a file

**Benefit:** On restart with a populated index, only changed files get re-indexed instead of skipping entirely (which could miss manual vault edits between restarts) or doing a full reindex (slow).

### 3. Vault Git Auto-Commit on Startup (NEW)
Before any indexing, Ved now checks if the vault has uncommitted changes and auto-commits them.

**Implementation in `VedApp.autoCommitVault()`:**
- Checks `git.isRepo` → skip if not a git repo
- Checks `git.isClean()` → skip if nothing to commit
- Stages all files (`git add .`) and commits with message: `ved: startup auto-commit — uncommitted changes found`
- Graceful error handling — logs warning on failure, doesn't block startup

**Startup sequence is now:**
1. `init()` — all modules
2. `autoCommitVault()` — commit dirty vault files ← NEW
3. `indexVaultOnStartup()` — incremental or full RAG indexing ← ENHANCED
4. `channels.startAll()` — start Discord/CLI
5. `startVaultWatcher()` — watch for incremental changes
6. `eventLoop.run()` — enter main loop

### 4. Tests
19 new tests covering:
- **ved stats (6):** vault stats (files/tags/types), git clean/dirty, RAG stats, audit chain from DB, session counts from DB
- **Incremental indexing (5):** stale detection by mtime vs indexed_at, new file detection (null indexed_at), full reindex when empty, skip up-to-date, batch stale identification
- **Git auto-commit (5):** skip when clean, stage+commit when dirty, skip when not git repo, handle failure gracefully, ordering (commit before index)
- **CLI stats format (3):** field types/presence, chain head truncation, dirty count display

## Stats
- Tests: 996/996 pass (host + Docker parity)
- Type errors: 0
- New tests: 19
- Files changed: 3 (app.ts, cli.ts, stats-incremental-autocommit.test.ts)
