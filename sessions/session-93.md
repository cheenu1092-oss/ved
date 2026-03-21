# Session 93 — v0.6.0 Release

**Date:** 2026-03-21
**Phase:** CYCLE (release)

## What Happened

Released v0.6.0 — the agent profiles, session replay, graph analysis, and task management release.

### Changes
1. Verified all 2,931 tests pass in Docker (host + Docker parity)
2. Updated CHANGELOG.md with comprehensive v0.6.0 notes
3. Updated README.md: CLI table (35→46 commands), stats updated
4. Updated package.json + cli.ts version (0.5.0→0.6.0)
5. Committed, tagged v0.6.0, pushed to GitHub (0734290)
6. Created GitHub release with full release notes

### v0.6.0 Summary
- **4 new CLI commands:** agent (10 subcmds), replay (8 subcmds), graph (9 subcmds), task (10 subcmds)
- **2 red-team sessions:** 132 tests, 0 vulnerabilities found
- **Stats:** 46 CLI commands • 2,931 tests • ~42,600 LoC • 0 open vulns (21 total found+fixed)

### Test Results
- Host: 2,931/2,931 pass
- Docker: 2,931/2,931 pass
- TypeScript: 0 errors

## Artifacts
- GitHub release: https://github.com/cheenu1092-oss/ved/releases/tag/v0.6.0
- Git tag: v0.6.0
- Commit: 0734290
