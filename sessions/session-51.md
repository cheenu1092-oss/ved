# Session 51 — `ved reindex` CLI + Startup Vault Indexing

**Date:** 2026-03-06
**Phase:** CYCLE (BUILD)

## What Happened

### 1. `ved reindex` CLI Command (NEW)
Added a new CLI command for force-rebuilding the entire RAG index:

```bash
ved reindex
```

**Implementation in `src/cli.ts`:**
- New `reindex` case in the command switch
- Calls `app.reindexVault()` (new public method on VedApp)
- Prints stats: files indexed, chunks stored, FTS entries, graph edges, elapsed time
- Graceful error handling — prints message + exit code 1 on failure

**Implementation in `src/app.ts`:**
- `reindexVault()`: Public method that reads all vault files and passes them to `rag.fullReindex()`
- `readAllVaultFiles()`: Private helper — calls `vault.listFiles()`, reads each file, warns on failures
- Logs file count, timing, and final stats

**Usage:** `ved reindex` — One-shot command. Inits app, clears RAG index, re-indexes every .md file in the vault, exits. Useful after manual vault edits, migration, or corruption recovery.

### 2. Startup Vault Indexing (NEW)
When `ved start` runs, the app now automatically indexes all vault files into RAG **before** entering the event loop — but only if the index is empty (first boot or after DB wipe).

**Implementation in `src/app.ts` → `indexVaultOnStartup()`:**
- Checks `rag.stats().filesIndexed` — if > 0, skips (assumes incremental watcher keeps it current)
- If empty, reads all vault files and calls `rag.fullReindex()`
- Runs BEFORE channel start and vault watcher — so RAG is populated before any queries hit

**Startup sequence is now:**
1. `init()` — all modules
2. `indexVaultOnStartup()` — populate RAG if empty ← NEW
3. `channels.startAll()` — start Discord/CLI
4. `startVaultWatcher()` — watch for incremental changes
5. `eventLoop.run()` — enter main loop

### 3. Tests
16 new tests covering:
- **readAllVaultFiles (3):** reads all paths, skips unreadable files, handles empty vault
- **Startup indexing (4):** indexes when empty, skips when populated, handles empty vault, single-file vault
- **reindexVault (4):** full re-index with stats, empty vault, large vault (100 files), wikilink graph edges
- **CLI reindex (2):** stats reporting, init-required error
- **Startup+watcher interaction (3):** ordering verification, post-startup changes, reindex independence

### 4. Pushed to GitHub
Committed and pushed: `aff5e11` — `feat: ved reindex CLI + startup vault indexing`

## Stats
- Tests: 977/977 pass (host + Docker parity)
- Type errors: 0
- New tests: 16
- Files changed: 3 (app.ts, cli.ts, reindex-startup.test.ts)

## Next Session (52)
- Consider: `ved stats` CLI command (show RAG index stats without full health check)
- Consider: Vault git auto-commit on startup (commit any dirty files before indexing)
- Consider: Incremental startup indexing (only index files modified since last indexed_at timestamp)
- Feature work: CLI interactive mode improvements or Discord channel polish
