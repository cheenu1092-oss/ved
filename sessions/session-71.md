# Session 71 — `ved env` — Environment Manager

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)
**Duration:** ~15 min

## What Was Built

### `ved env` — Environment Manager (10 subcommands)

Manage multiple configuration environments (dev, prod, test, staging, etc.) with YAML config overlays stored in `~/.ved/environments/`.

**Subcommands:**
1. `ved env` / `ved env current` — Show active environment
2. `ved env list` — List all environments with size, date, active marker
3. `ved env show <name>` — Display environment config
4. `ved env create <name>` — Create environment (blank, --from, --template, --from-current)
5. `ved env use <name>` — Switch to environment
6. `ved env edit <name>` — Open in $EDITOR
7. `ved env delete <name>` — Remove environment
8. `ved env diff <a> <b>` — Compare two environments (colored diff)
9. `ved env reset` — Deactivate environment
10. (implicit) Passing env name directly shows it

**Aliases:** `ved envs`, `ved environment`, `ved environments`

### Config Loader Integration

The active environment's YAML is now merged in the config loading order:
1. Built-in defaults
2. `~/.ved/config.yaml`
3. **Active environment overlay** ← NEW
4. `~/.ved/config.local.yaml` (secrets)
5. `VED_*` environment variables
6. CLI overrides

### Features
- **Built-in templates:** `dev` (debug/ollama), `prod` (warn/anthropic), `test` (error/deterministic)
- **Name validation:** letter-start, alphanumeric+hyphens, max 64 chars
- **Reserved name protection:** `default`, `config`, `local`, `none`, etc.
- **Copy from existing:** `--from <env>` clones another environment
- **Config snapshot:** `--from-current` captures merged config with secret redaction
- **Colored diff:** red/green line-by-line comparison
- **Active env persistence:** stored in `~/.ved/active-env`
- **Shell completions:** bash/zsh/fish updated for all subcommands

## Also Done

- **GitHub push (S67-70):** Pushed sessions 67-70 to GitHub (006c9aa) — context/run/pipe/alias CLIs

## Test Results

- **58 new tests** covering: name validation (7), active env management (5), CRUD operations (7), listing (4), config path (3), CLI subcommands (22), edge cases (4), built-in templates (6)
- **1791/1791 tests pass (host + Docker parity)**
- **0 type errors**

## Files Changed

- `src/cli-env.ts` — New: environment manager (~490 lines)
- `src/cli-env.test.ts` — New: 58 tests (~380 lines)
- `src/cli.ts` — Wired env command + aliases
- `src/core/config.ts` — Active environment config loading
- `src/app.ts` — Shell completions for env subcommands

## CLI Summary

**27 commands** after this session: init, start, chat, run, pipe, serve, status, stats, search, reindex, config, export, import, history, doctor, backup, cron, upgrade, watch, webhook, plugin, gc, memory, trust, user, prompt, template, context, alias, env, completions, version.
