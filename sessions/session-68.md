# Session 68 — `ved run` — One-Shot Query Mode

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)

## What Happened

### `ved run` — One-Shot Query Mode (cli-run.ts — 310 lines)

Built a one-shot query command for scripting and piping. Sends a single message through the full Ved pipeline (RAG → LLM → tools → response) and exits.

**Usage patterns:**
```bash
ved run "What is Ved?"                           # Direct query
ved run -q "translate" -f letter.txt             # Query + file context
echo "explain this" | ved run -                  # Read from stdin
ved run "summarize" -f notes.md --raw | pbcopy   # Pipe to clipboard
ved run "status" --session myproject --json      # Persistent session + JSON
ved run "translate" --no-rag --no-tools --raw    # Minimal mode
```

**Aliases:** `ved ask`, `ved query`, `ved q`

**Flags:**
- `-q, --query` — Explicit query text
- `-f, --file` — Attach file content (max 1MB)
- `-s, --session` — Named session (persists context across runs)
- `-m, --model` — Override LLM model
- `--system` — Override system prompt
- `--json` — Structured JSON output
- `--raw` — Response text only (no headers/timing)
- `--no-rag` — Skip RAG retrieval
- `--no-tools` — Disable tool execution
- `-t, --timeout` — Timeout in seconds (default 120)
- `-v, --verbose` — Show query metadata and timing
- `-h, --help` — Full help text

**Exit codes:** 0 success, 1 error, 2 timeout, 3 no query

**Output formats:**
- `text` (default) — Response content with optional verbose header and pending action list
- `json` — Structured with id, content, actions, memoryOps, durationMs
- `raw` — Response text only, perfect for piping

### Implementation Details

- Uses `processMessageDirect()` (built in S30) — full 7-step pipeline without channel adapters
- File attachment: reads file, prepends as context with filename header
- Stdin: reads all input, combines with query (query=instruction, stdin=context)
- Named sessions: author field carries session ID for context persistence across runs
- Timeout: `Promise.race` with configurable timeout, exit code 2
- Added `'run'` to `ChannelId` union type

### Shell Completions
Updated all 3 shells (bash/zsh/fish) with run command flags and aliases.

### Also Changed
- `ChannelId` type: added `'run'` variant
- CLI: `ved run` now routes to one-shot mode (previously was alias for `start`)
- Completions: added `ask`, `query`, `q` aliases to command list
- Usage help string updated

### Tests (39 new)
- parseRunArgs: positional query, -q/--query, stdin, -f/--file, --json, --raw, --session, --model, --no-rag, --no-tools, --timeout, --system, --verbose, all flags combined, empty args, unknown flag exit, invalid/negative timeout exit (18)
- formatOutput: text content, raw content, json structure, verbose metadata, verbose memory ops, pending actions, long query truncation, no-tools verbose, json actions (9)
- runQuery: empty query error, file not found error, correct message shape, named session channel, unique channels per run, timeout throws, file attachment, file too large error, file-only query (9)
- Edge cases: help flag, combined -q + positional (3)

## Stats
- **New files:** cli-run.ts (310 lines), cli-run.test.ts (390 lines)
- **Modified files:** cli.ts, app.ts, types/index.ts
- **New tests:** 39
- **Total tests:** 1632/1632 pass (host + Docker parity)
- **Type errors:** 0
- **CLI commands:** 24 (was 23)
