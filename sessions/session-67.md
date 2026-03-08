# Session 67 — `ved context` CLI

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)

## What Happened

### `ved context` — Context Window Inspector & Manager (cli-context.ts — 697 lines)

Built a context window inspection and manipulation tool. Most AI assistants hide what goes into the LLM prompt — Ved exposes it because audit-first transparency is a core differentiator.

**9 subcommands:**

1. **`ved context show`** — Display full assembled context (system prompt + facts + RAG + conversation)
2. **`ved context tokens`** — Token count breakdown by section with usage bar visualization
3. **`ved context facts`** — List active working memory facts with per-fact token counts
4. **`ved context add <key> <value>`** — Add/update a fact in working memory (audit-logged)
5. **`ved context remove <key>`** — Remove a fact from working memory (audit-logged)
6. **`ved context clear`** — Clear all working memory facts (audit-logged)
7. **`ved context messages`** — List conversation messages (with --verbose for full content)
8. **`ved context simulate <query>`** — Dry-run RAG retrieval to see what would be injected
9. **`ved context sessions`** — List all active/idle sessions with metadata

**Aliases:** `ctx`, `window`, `prompt-debug` for the command; `view`/`inspect`, `budget`/`usage`, `fact`, `set`, `rm`/`delete`/`del`, `reset`, `msgs`/`history`/`conversation`, `sim`/`dry-run`/`preview`, `list`/`ls` for subcommands.

### Key Features

- **Full context assembly** — Mirrors EventLoop.buildSystemPrompt exactly, showing what the LLM sees
- **Token breakdown** — Per-section and per-role token counts with visual progress bar
- **Fact CRUD with audit** — All fact modifications (add/update/remove/clear) are audit-logged
- **RAG simulation** — Preview what context would be injected for any query without sending to LLM
- **Session targeting** — All commands support `--session <id>` to inspect specific sessions
- **Graceful no-session handling** — All subcommands work even without active sessions (show base costs)

### Shell Completions
Updated all 3 shells (bash/zsh/fish) with context subcommands and aliases.

### Tests (44 new)
- estimateTokens: basic, empty, single char, exact multiples, large text (5)
- parseWorkingMemory: valid, empty object, invalid JSON, missing fields, null messages, non-object facts (6)
- assembleSystemPrompt: default, with facts, with RAG, both, custom file, missing file (6)
- Session operations: insert+retrieve, most recent, exclude closed, list active/idle (4)
- Fact management: add, update, remove, clear, preserve messages during fact edit (5)
- Token breakdown: base tokens, per-role, facts impact (3)
- Message listing: ordered, tool messages with name, empty (3)
- Edge cases: large WM, special chars, multi-author, idle lookup, concurrent updates (5)
- Format helpers: truncate long, short passthrough, age formatting (3)
- Context assembly: deterministic, section ordering, empty sections omitted ×2 (4)

### Changes to Existing Files
- `src/cli.ts` — Added context/ctx/window/prompt-debug case with app init/stop lifecycle
- `src/app.ts` — Added 'context' to commands array, contextSubs to completions, updated bash/zsh/fish

## Stats
- **New tests:** 44
- **Total tests:** 1593/1593 pass (host + Docker parity)
- **Type errors:** 0
- **New LoC:** ~697 (cli-context.ts)
- **CLI commands:** 23
