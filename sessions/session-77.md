# Session 77 — `ved snapshot` — Vault Point-in-Time Snapshots

**Date:** 2026-03-08
**Phase:** CYCLE (feature development)

## What Was Built

### `ved snapshot` — Lightweight vault snapshots (cli-snapshot.ts, ~550 lines)

Named point-in-time snapshots using git tags with metadata. Different from `ved backup` (full tar.gz archives) — snapshots are zero-cost git references marking knowledge evolution milestones.

| Subcommand | Description |
|-----------|-------------|
| `ved snapshot` | List all snapshots (default) |
| `ved snapshot create <name> [-m <msg>]` | Create a named snapshot |
| `ved snapshot show <name>` | Show snapshot details + drift from HEAD |
| `ved snapshot diff <name> [<name2>]` | Diff snapshot vs HEAD or another snapshot |
| `ved snapshot restore <name>` | Restore vault to snapshot (creates safety snapshot first) |
| `ved snapshot delete <name>` | Delete a snapshot |
| `ved snapshot export <name> [path]` | Export snapshot state as tar.gz |

### Key Features
- **Annotated git tags** with `ved-snap/` prefix — zero disk cost, full git integration
- **Safety snapshots** — restore always creates `pre-restore-*` backup tag first
- **Uncommitted change handling** — auto-commits dirty vault before snapshotting
- **Name validation** — path traversal prevention, alphanumeric+hyphens/underscores, 128 char limit
- **Safety tag protection** — `pre-restore-*` tags require `--force` to delete
- **Color-coded diffs** — green additions, red deletions, cyan hunks
- **`--stat` flag** for summary diffs
- **`--force` flag** for restore with uncommitted changes
- **Restore cleans properly** — files added after snapshot are removed (rm+checkout strategy)
- **Aliases:** `ved snap`, `ved checkpoint`

### Shell Completions
Updated all 3 shells (bash/zsh/fish) with snapshot subcommands and flags.

### Help Registry
Added to command registry in `cli-help.ts` under `data` category.

## Tests

41 new tests covering:
- List: empty, populated, default subcommand
- Create: with message, default message, auto-commit, duplicate rejection, name validation (special chars, path traversal, spaces, length), valid hyphens/underscores
- Show: details, non-existent error, drift from HEAD, auto-show on name
- Diff: vs HEAD, two snapshots, identical (no diff), --stat flag, non-existent error
- Restore: full restore with file removal, safety snapshot creation, uncommitted rejection, --force override
- Delete: basic, non-existent error, safety protection, --force for safety tags
- Export: tar.gz creation, custom path, non-existent error
- Edge cases: 128-char limit, empty name, multiple snapshots over time
- Help: --help and -h flags
- Shell completions: bash, zsh, fish
- CLI wiring: switch cases and help registry

## Results

- **2117/2117 tests pass** (Docker parity: all pass; host: 2116/2117, 1 pre-existing webhook timing flake)
- **0 type errors**
- **CLI: 31 commands** (30 + snapshot)

## Files Changed

| File | Change |
|------|--------|
| `src/cli-snapshot.ts` | NEW — vault snapshot manager (551 lines) |
| `src/cli-snapshot.test.ts` | NEW — 41 tests (610 lines) |
| `src/cli.ts` | Wired snapshot/snap/checkpoint cases |
| `src/cli-help.ts` | Added snapshot to command registry |
| `src/app.ts` | Updated completions (bash/zsh/fish) + snapshotSubs |
