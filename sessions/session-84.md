# Session 84 — v0.4.0 Release

**Date:** 2026-03-17
**Phase:** CYCLE (release)
**Duration:** ~10 min

## What Happened

### 1. Docker Parity Verification
- Built Docker image, ran full test suite inside container
- **2393/2393 pass** (4 non-fatal EPIPE warnings from hook stdin writes — fixed below)
- Full Docker parity confirmed for all modules including migrate (S82-83)

### 2. v0.4.0 Release
- Updated package.json + cli.ts VERSION (0.3.0 → 0.4.0)
- Updated CHANGELOG.md with comprehensive v0.4.0 notes:
  - 3 new commands (hook, notify, migrate)
  - Red-team S79 summary (91 tests, 2 vulns fixed)
  - Stats: 34 commands, 2393 tests, ~35,700 LoC
- Updated README.md:
  - CLI table: 31 → 34 commands (added hook, notify, migrate)
  - Stats line: updated counts + "19 found and fixed" vuln count
- Committed, tagged v0.4.0, pushed to GitHub (171eb60)
- Created GitHub release with detailed notes

### 3. EPIPE Fix
- Fixed cosmetic EPIPE warning in `cli-hook.ts` `executeHook()` — child process may exit before reading stdin
- Added `child.stdin.on('error', ...)` handler to suppress harmless EPIPE
- All 45 hook tests pass clean (no warnings)
- Pushed fix (50d586c)

## v0.4.0 Summary

| Metric | v0.3.0 | v0.4.0 | Delta |
|--------|--------|--------|-------|
| CLI commands | 31 | 34 | +3 |
| Tests | 2,117 | 2,393 | +276 |
| LoC | ~32,200 | ~35,700 | +3,500 |
| Vulnerabilities | 17 fixed | 19 fixed | +2 |

### New in v0.4.0
- `ved hook` — lifecycle hook manager (11 subcommands, 45 tests)
- `ved notify` — notification rules manager (12 subcommands, 42 tests)
- `ved migrate` — data migration tool (9 subcommands, 50 tests)
- Red-team S79: 91 tests, VULN-18 + VULN-19 found and fixed

## Stats
- **Tests:** 2393/2393 pass (host + Docker)
- **Type errors:** 0
- **Open vulnerabilities:** 0

## Next Session (85)
Options:
- `ved plugin` — MCP plugin marketplace (discover, install, configure MCP tool servers)
- `ved sync` — vault sync across devices (git-based)
- `ved agent` — multi-agent coordination (spawn sub-agents for complex tasks)
- Test suite cleanup: fix the 1 pre-existing profile timing flake
- New red-team cycle targeting S80-83 features
