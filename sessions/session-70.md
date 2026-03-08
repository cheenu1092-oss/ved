# Session 70 — `ved alias` — Command Shortcut Manager

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)

## What Happened

### `ved alias` — Command Shortcut Manager (cli-alias.ts — 625 lines)

Built a command shortcut system that lets users create, manage, and run custom aliases for frequently used ved commands. Aliases are stored in `~/.ved/aliases.yaml` and can be invoked via `ved @<name>` or `ved alias run <name>`.

**Usage patterns:**
```bash
ved alias add ss search --fts-only              # Create alias
ved alias add daily memory daily -d "Today"     # With description
ved @ss "my query"                               # Run via @shortcut
ved alias edit ss search --verbose               # Update command
ved alias remove ss                              # Delete alias
ved alias list                                   # List all aliases
ved alias show ss                                # Show details
ved alias export > aliases.yaml                  # Backup
ved alias import aliases.yaml                    # Restore (merge)
```

**Aliases:** `ved aliases`, `ved shortcut`, `ved shortcuts`

**8 subcommands:**
- `list` (ls) — List all aliases with aligned display
- `add` (create, set) — Create a new alias with optional description
- `remove` (rm, delete, del) — Remove an alias
- `show` (get, info) — Show alias details (command, description, timestamps)
- `edit` (update) — Update command and/or description
- `run` (exec) — Run an alias explicitly (or use `ved @name`)
- `export` — Export aliases as YAML or JSON (`--json`)
- `import` — Import aliases from file with merge semantics, `--dry-run` support

**Key features:**
- **@-shortcut syntax:** `ved @myalias [extra-args...]` expands alias and appends extra args
- **Name validation:** Must start with letter, alphanumeric + hyphens/underscores, max 64 chars
- **Reserved name protection:** Cannot shadow any built-in ved command (30+ reserved names)
- **YAML storage:** Human-readable, manually editable, with comments
- **Special character handling:** Commands with quotes, colons, hashes properly round-trip
- **Shell completions updated:** bash, zsh, and fish all include alias subcommands

### Integration with cli.ts

Wired `ved alias` into the main CLI switch plus:
- `@`-prefix alias resolution in the default case (before "unknown command" error)
- Non-@-prefix alias resolution as fallback (aliases can be invoked without @ too)
- Recursive main() call with expanded args for clean command dispatch

### Shell Completions Updated

All 3 shells (bash/zsh/fish) now complete `alias` subcommands.

## Tests

**43 new tests** covering:
- Name validation (9): valid names, invalid patterns, reserved names, edge lengths
- Store persistence (7): round-trips, special characters, empty lists, timestamps, corrupted files, directory creation
- Alias resolution (3): found, not found, no file
- YAML serialization (4): colons, hashes, descriptions with specials, bulk (50 aliases)
- Reserved name completeness (13): all critical ved commands blocked
- Store mutations (3): add→remove, add→edit, add-multiple→remove-one
- Edge cases (4): max-length names, single-char names, long commands, idempotent saves

## Stats
- **New files:** `src/cli-alias.ts` (625 lines), `src/cli-alias.test.ts` (402 lines)
- **Modified:** `src/cli.ts` (alias routing + @-shortcut), `src/app.ts` (completions)
- **Tests:** 43 new, **1733/1733 pass** (host + Docker parity)
- **Type errors:** 0
- **CLI commands:** 26 (was 25)
