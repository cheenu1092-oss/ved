# Session 75 — Wire checkHelp() into all CLI command handlers

**Date:** 2026-03-07  
**Phase:** CYCLE  
**Duration:** ~15 min  

## Goal
Wire the `checkHelp()` utility (built in S74) into every CLI command handler so `ved <cmd> --help` and `ved <cmd> -h` show formatted help for any command without initializing the full app.

## What Was Done

### checkHelp() wiring (cli.ts)
- Added `import { checkHelp }` to cli.ts alongside existing `helpCmd` import
- Added `if (checkHelp('<name>', args.slice(1))) return;` to **33 command cases** in the main switch:
  - Simple commands: init, status, stats, reindex, doctor, watch, start
  - Args-passing commands: search, config, export, import, history, backup, cron, upgrade, plugin, gc, webhook, serve, completions
  - External module commands: chat, prompt, template, context, memory, trust, user, run, pipe, alias, env, log, profile
- Commands skip app initialization entirely when --help is detected (no DB connection, no config loading)

### Tests (cli-help.test.ts)
- Added `checkHelp wiring — all commands` test suite with parameterized tests:
  - `ved <cmd> --help` shows help and returns true (34 commands × 1 = 34 tests)
  - `ved <cmd> -h` shows help and returns true (34 commands × 1 = 34 tests)  
  - `ved <cmd> <normal args>` returns false (34 commands × 1 = 34 tests)
  - `--help` anywhere in args triggers help (not just first position) — 1 test
- **103 new tests total** (151 total in cli-help.test.ts, up from 48)

### Verification
- TypeScript: 0 type errors
- Host: 2037/2037 pass
- Docker: 2056/2056 pass (parity confirmed)
- Pushed to GitHub: 1c4e1e5

## Files Changed
| File | Changes |
|------|---------|
| src/cli.ts | +35 lines (1 import + 33 checkHelp guards) |
| src/cli-help.test.ts | +47 lines (103 new parameterized tests) |
| STATE.md | Updated session log |

## Stats
- **Tests:** 2037 (host) / 2056 (Docker)
- **Type errors:** 0
- **LoC delta:** +91 lines
- **Commands with --help support:** 33 (all except help itself)

## Next Session (76)
- `ved plugin discover` — MCP plugin discovery from registry?
- Config hot-reload (watch config.yaml, apply changes without restart)?
- v0.3.0 release candidate?
- `ved diff` — vault diff viewer (git-based)?
