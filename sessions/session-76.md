# Session 76 — `ved diff` — Vault Diff Viewer & Change Tracker

**Date:** 2026-03-08
**Phase:** CYCLE (feature development)
**Duration:** ~1 session

## What Was Built

### `ved diff` — Vault diff viewer (cli-diff.ts, ~480 lines)

Because Ved's memory is an Obsidian vault with git versioning, `ved diff` lets you see exactly how knowledge evolves over time. 8 subcommands:

| Subcommand | Description |
|-----------|-------------|
| `ved diff` | Show uncommitted changes (staged + unstaged + untracked) |
| `ved diff <file>` | Show diff for a specific vault file |
| `ved diff log [--limit N] [--file <path>]` | Show git log of vault changes |
| `ved diff show <hash>` | Show a specific commit's changes |
| `ved diff stat [--since <date>]` | File change statistics |
| `ved diff blame <file>` | Line-by-line blame for vault file |
| `ved diff between <hash1> <hash2>` | Diff between two commits |
| `ved diff files [--since <date>]` | List changed files |
| `ved diff summary [--days N]` | Vault evolution summary (commits, lines, folders, top files) |

### Features
- **Color-coded output** — green additions, red deletions, cyan hunks, yellow hashes
- **Relative timestamps** — "5m ago", "3h ago", "2d ago"
- **Folder breakdown** — bar chart showing which vault folders are most active
- **Most active files** — top files by modification frequency
- **Aliases:** `ved changes`, `ved delta`
- **No app init required** — reads config for vault path, runs git directly (fast)

### Shell Completions
Updated all 3 shells (bash/zsh/fish) with diff subcommands and flags.

### Help Registry
Added to command registry in `cli-help.ts` under `memory` category.

## Tests

33 new tests covering:
- Working tree diffs (clean, uncommitted, untracked, staged, per-file)
- Git log (basic, limit, file filter)
- Show commit (details + diff output)
- Stat output
- Blame output
- Between commits (diff + identity)
- Files listing (status, since-date, clean)
- Summary (commit count, line stats, folder breakdown)
- Edge cases (empty diff, special chars, multi-modification)
- Help flag integration (--help, -h, normal args)
- Shell completions (bash, zsh, fish)
- CLI wiring verification

## Results

- **2073/2073 tests pass** (host + Docker parity)
- **0 type errors**
- **Pushed to GitHub** (429ae29)
- **CLI: 30 commands** (29 + diff)

## Files Changed

| File | Change |
|------|--------|
| `src/cli-diff.ts` | NEW — vault diff viewer (480 lines) |
| `src/cli-diff.test.ts` | NEW — 33 tests |
| `src/cli.ts` | Wired diff/changes/delta cases |
| `src/cli-help.ts` | Added diff to command registry |
| `src/app.ts` | Updated completions (bash/zsh/fish) |
