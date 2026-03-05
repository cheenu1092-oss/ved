# Session 15 — RED-TEAM (1 of 2)

**Date:** 2026-03-04 14:16 PST
**Phase:** RED-TEAM
**Duration:** ~10 min

## What Happened

Wrote and executed a comprehensive red-team test suite: **45 tests across 9 attack categories**, all running in Docker (`node:22-slim`).

### Attack Categories
1. **Hash Chain Forgery (6 tests)** — Tested direct DB modification, event deletion, reordering, hash recomputation, full chain rewrite, genesis forgery
2. **Gating Bypass (7 tests)** — Case-sensitivity bypass, unknown tools, param rule scope, risk overrides, trust gaming, rejection behavior
3. **SQL Injection (5 tests)** — Injection in tool names, params, search queries, session keys, resolution notes
4. **Input Fuzzing (9 tests)** — Null bytes, 1MB tool names, 10MB params, 100-level nesting, CJK/RTL/emoji, zero-width homoglyphs, empty strings
5. **Work Order Manipulation (4 tests)** — Double-approve, approve-after-reject, approve-after-expire, direct DB manipulation
6. **Config Attacks (3 tests)** — Runtime mode change, risk override neutralization, corrupt pluginConfig
7. **DB File Attacks (4 tests)** — Missing schema, corrupt DB, zero-byte DB, read-only DB
8. **Command Handler (4 tests)** — Proto injection, huge args, non-existent IDs, special chars in search
9. **Race Conditions (3 tests)** — 1000 rapid inserts, interleaved reads/writes, concurrent work order resolution

### Findings
- **5 vulnerabilities documented** (see `red-team/session-15-findings.md`)
- V1 (HIGH): Full chain rewrite passes verification — no external anchor
- V2 (MEDIUM): No genesis hash validation in verifyChain
- V3 (MEDIUM): Case-sensitive tool name bypass
- V4 (MEDIUM): Trust auto-approve gameable via bulk approvals
- V5 (LOW): Work orders lack integrity protection
- **1 bug found:** TTL=0 doesn't immediately expire (strict `<` in sweep query)

### What Held Up
- SQL injection: 100% safe (prepared statements)
- Input fuzzing: No crashes on any edge case
- Work order state machine: Correct (no double-approve, no post-reject approval)
- Crash recovery: Correct failure modes (throw on corrupt, auto-create on empty)

## Docker Commands
```bash
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c 'npm install --ignore-scripts && npx vitest run test/red-team.test.ts'
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c 'npm install --ignore-scripts && npx vitest run'
docker tag node:22-slim witness-dev:s15
```

## Test Results
- **204 total tests, all passing** (45 new red-team + 159 existing)
- Image tagged: `witness-dev:s15`
- Pushed to GitHub: `cheenu1092-oss/witness`

## Next Session (16)
RED-TEAM 2: Fix V2+V3 (quick wins), add external anchor prototype, deeper plugin registration fuzzing, param-aware trust prototype.
