# Session 65 — `ved prompt` CLI + System Prompt Enhancements

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)

## What Happened

### `ved prompt` — System Prompt Profile Manager (cli-prompt.ts — 570 lines)

Built a dedicated CLI module for managing system prompt profiles. Prompts stored as plain `.md` files in `~/.ved/prompts/`. 8 subcommands:

1. **`ved prompt list`** — List profiles with size, date, active marker
2. **`ved prompt show [name]`** — Display prompt contents (active if omitted, shows default)
3. **`ved prompt create <name>`** — Create from template or stdin, path traversal protection
4. **`ved prompt edit <name>`** — Open in $EDITOR
5. **`ved prompt use <name>`** — Set as active (auto-updates config.yaml)
6. **`ved prompt test`** — Dry-run: preview fully assembled system prompt with sample facts + RAG
7. **`ved prompt reset`** — Revert to Ved default prompt
8. **`ved prompt diff <a> <b>`** — Line-by-line comparison, supports "default" pseudo-profile

**Aliases:** `prompts`, `sp`, `system-prompt` for the command; `ls`/`cat`/`view`/`new`/`set`/`activate`/`preview`/`dry-run`/`clear`/`compare` for subcommands.

### Also Committed (from prior sessions)
- **cli-chat.ts** (470 lines) — Interactive REPL with inline slash commands
- **system-prompt.test.ts** (614 lines, 26 tests) — System prompt assembly tests
- **event-loop.ts** enhancements — `buildSystemPrompt()` + `loadCustomSystemPrompt()` with caching

### Security
- Profile names validated: `[a-zA-Z0-9_-]` only, rejects path traversal
- Config file update uses simple YAML line editing (no full parse/rewrite)

### Shell Completions
- Updated all 3 shells (bash/zsh/fish) with prompt subcommands
- Added `prompt` to top-level commands list

### Tests (32 new prompt + 26 system-prompt)
- Help display (2)
- List: empty state, default subcommand (2)
- Show: default prompt, alias, nonexistent (3)
- Create: missing name, path traversal, dots, alias (4)
- Edit: missing name (1)
- Use: missing name, set alias, activate alias (3)
- Test: default preview, preview alias, dry-run alias, stats, custom file, missing file (6)
- Reset: confirmation, clear alias (2)
- Diff: missing args, one arg, compare alias, default vs default (4)
- Error handling: unknown subcommand, spaces, slashes (3)
- Config update: create when missing (1)
- Section ordering: facts before RAG (1)

### GitHub Push
- Committed and pushed (0e1f735) — includes cli-chat.ts and system-prompt tests from prior sessions.

## Stats
- **New files:** 3 (cli-prompt.ts, cli-prompt.test.ts, cli-chat.ts + system-prompt.test.ts)
- **Modified files:** 4 (app.ts, cli.ts, event-loop.ts, types/index.ts)
- **Lines added:** 2,398
- **Tests:** 58 new (32 prompt + 26 system-prompt), 1512 total
- **Type errors:** 0
- **CLI commands:** 21 (was 20)
