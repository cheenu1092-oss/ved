# Session 53 — `ved search` CLI + `ved config` CLI

**Date:** 2026-03-06
**Phase:** CYCLE (BUILD)

## What Happened

### 1. `ved search` CLI Command (NEW)
Added a full-featured search command that queries the RAG pipeline from the command line:

```bash
ved search "distributed systems" -n 10 --verbose
ved search "SQLite WAL" --fts-only
```

**Features:**
- Multi-word query support (all non-flag args joined)
- `-n <limit>` / `--limit <limit>` — control result count (default 5)
- `--verbose` / `-v` — show per-source counts, timing breakdown, token count
- `--fts-only` / `--fts` — restrict to FTS search only (no vector/graph)
- Results show: rank, file path, heading, RRF score, source signals, content preview (200 chars)
- Clean formatted output with elapsed time

**Implementation:**
- `cli.ts` — new `search` command case + `search()` async function with full arg parser
- `app.ts` — new `VedApp.search(query, options?)` method delegating to `rag.retrieve()`
- Imports: `RetrieveOptions`, `RetrievalContext` from rag/types

### 2. `ved config` CLI Command (NEW)
Added config management subcommands:

```bash
ved config validate    # Check config for errors
ved config show        # Print resolved config (secrets redacted)
ved config path        # Print config directory path
```

**`ved config validate`:**
- Loads config via `loadConfig()`, runs `validateConfig()`
- Shows ✅ for valid, ❌/⚠️ per issue with path + message + code
- Exits with code 1 if errors found

**`ved config show`:**
- Loads and prints fully resolved config as JSON
- Redacts `llm.apiKey` and all `channel[].token` fields → `***REDACTED***`
- Original config untouched (deep clone before redaction)

**`ved config path`:**
- Prints `~/.ved` directory path

**Implementation:**
- `cli.ts` — new `config` command case + `config()` function with sub-dispatch
- Uses existing `loadConfig`, `validateConfig`, `getConfigDir` from core/config

### 3. CLI Usage String Updated
```
Usage: ved [init|start|status|stats|search|reindex|config|version]
```

### 4. Tests
30 new tests covering:
- **VedApp.search() (7):** FTS matching, empty results, FTS-only filter, metrics, uninitialized error, result structure, cross-file search
- **Config validation (10):** valid config, missing ownerIds, invalid provider, empty model, temperature range, no channels, compression threshold, empty dbPath, negative tokens, session≤message tokens
- **Config show redaction (3):** API key redaction, channel token redaction, null apiKey no-op
- **Config path (1):** returns .ved path
- **Search arg parsing (9):** simple query, -n, --limit, --verbose, -v, --fts-only, --fts, all combined, empty

## Stats
- Tests: 1026/1026 pass (host + Docker parity)
- Type errors: 0
- New tests: 30
- Files changed: 3 (app.ts, cli.ts, session-53-search-config.test.ts)
- Ved CLI now has 8 commands: init, start, status, stats, search, reindex, config, version
