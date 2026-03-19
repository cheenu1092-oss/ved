# Session 88 — v0.5.0 Release

**Date:** 2026-03-18
**Phase:** CYCLE (release)
**Duration:** ~10 min

## Goals
- Release v0.5.0 (sync + red-team since v0.4.0)

## What Happened

### Pre-Release Verification
- Full test suite: **2542/2542 pass** (21.12s)
- TypeScript: **0 type errors**

### Release Artifacts Updated
1. **CHANGELOG.md** — v0.5.0 section: sync CLI (35th command), red-team S87 (83 tests, VULN-20/21 fixed), 149 new tests since v0.4.0
2. **README.md** — CLI table updated to 35 commands (added `ved sync`), stats updated (2,542 tests, ~38K LoC, 21 vulns fixed)
3. **package.json** — 0.4.0 → 0.5.0
4. **src/cli.ts** — VERSION constant 0.4.0 → 0.5.0

### Release Summary
| Metric | v0.4.0 | v0.5.0 | Delta |
|--------|--------|--------|-------|
| CLI commands | 34 | 35 | +1 |
| Tests | 2,393 | 2,542 | +149 |
| LoC | ~35,700 | ~38,000 | +2,300 |
| Vulns fixed | 19 | 21 | +2 |
| Open vulns | 0 | 0 | — |

### New in v0.5.0
- `ved sync` — vault synchronization (git/S3/rsync/local remotes, conflict detection, auto-sync, history)
- VULN-20 fix: rm flag bypass in hook command blocking
- VULN-21 fix: null bytes in env vars crash executeHook
- DB migration v004 (sync_remotes + sync_history tables)

## Git
- Tagged v0.5.0
- Pushed to GitHub
