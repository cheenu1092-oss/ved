# Session 16 — RED-TEAM 2

**Date:** 2026-03-04 15:16 PST
**Phase:** RED-TEAM (2 of 2)
**Duration:** ~20 min

## Objective
Fix vulnerabilities V2-V4 from Session 15, prototype external anchoring (V1 mitigation), deeper plugin fuzzing, and validate all fixes.

## Fixes Applied

### V2: Genesis Anchor Validation (MEDIUM → FIXED)
- `verifyChain()` now checks that the first event's `prevHash === GENESIS_HASH`
- If an attacker replaces the genesis anchor with a custom value, verification fails at index 0
- File: `src/hash.ts`

### V3: Case-Sensitivity Bypass (MEDIUM → FIXED)
- `assessRisk()` now normalizes tool names: checks original, lowercase, and capitalized forms
- `getBaseRiskLevel()` also normalized
- PARAM_RULES lookup tries original, normalized, and capitalized (catches `write` → `Write` rules)
- `Exec`, `EXEC`, `exec` all get `high` risk now
- File: `src/risk.ts`

### V4: Critical Risk Auto-Approve Guard (MEDIUM → PARTIALLY FIXED)
- `checkTrust()` accepts optional `riskLevel` parameter
- If `riskLevel === 'critical'`, returns `false` regardless of trust history
- Plugin passes risk level when checking trust
- Still tool-name granular (not param-aware) for non-critical — full param-aware trust is Phase 3
- Files: `src/store.ts`, `src/plugin.ts`

### TTL Edge Case (LOW → FIXED)
- Sweep query changed from `<` to `<=` — `ttlMinutes: 0` now expires immediately
- File: `src/store.ts`

### Plugin Defensive Guards
- `after_tool_call` handler now null-coalesces `event.params` and `event.toolName`
- Prevents NOT NULL constraint crash when hooks fire with incomplete event data
- File: `src/plugin.ts`

## New: External Anchoring (V1 Mitigation)

Created `src/anchor.ts` — a lightweight external checkpoint system:

- **HMAC-signed checkpoints:** Periodically snapshot the chain's latest hash with HMAC-SHA256 signature
- **Anchor file:** JSON file stored separately from the DB (different location = defense in depth)
- **Validation:** Compare current chain hash against checkpointed hash at same seq — mismatch = tampering
- **HMAC tampering detection:** If attacker modifies the anchor file to match their forged chain, HMAC verification fails

### API
- `createCheckpoint(seq, hash, eventCount, secret?)` → `Checkpoint`
- `verifyCheckpoint(cp, secret)` → `boolean`
- `appendCheckpoint(anchorPath, seq, hash, eventCount, secret?)` → `Checkpoint`
- `validateAgainstAnchor(anchorPath, currentHash, currentSeq, secret?)` → validation result

### What It Catches That Internal Verify Cannot
Internal `verifyChain()` only checks chain consistency. An attacker who rewrites ALL events (keeping valid genesis + recomputing all hashes) produces a chain that passes internal verification. External anchoring catches this because the checkpointed hash no longer matches the rewritten chain's hash.

## Test Results

**43 new tests** in `test/red-team-s16.test.ts`:
- V2 Fix Validation: 3 tests (genesis anchor tamper detection)
- V3 Fix Validation: 6 tests (case normalization across all variants)
- V4 Fix Validation: 2 tests (critical never auto-approved, plugin blocks critical)
- TTL Edge Case: 1 test (zero TTL expires immediately)
- External Anchoring: 8 tests (HMAC, tamper detection, corrupt files, chain rewrite detection)
- Plugin Registration Fuzzing: 6 tests (minimal API, invalid config, missing fields, proto pollution)
- Param-Aware Risk: 10 tests (nested injection, env exfil, .env/.ssh/.pem paths, sudo, pip)
- Combined Attack: 2 tests (full rewrite + external anchor catches it)
- Work Order State Machine: 4 tests (re-approve, cross-status, expired, direct DB bypass)

**Updated 2 old S15 tests** to expect fixed behavior (V2 genesis, V3 case bypass).

**Total: 247 tests, all passing in Docker.**

## Docker Commands
```bash
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c 'npm install && npm test'
docker build -t witness-dev .
docker tag witness-dev witness-dev:s16
```

## Remaining Vulnerabilities

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| V1 | HIGH | Full chain rewrite (with genesis preserved) | MITIGATED — external anchoring detects it |
| V2 | MEDIUM | Genesis anchor validation | ✅ FIXED |
| V3 | MEDIUM | Case-sensitivity bypass | ✅ FIXED |
| V4 | MEDIUM | Trust gaming (bulk approvals) | PARTIALLY FIXED — critical blocked, param-aware deferred to Phase 3 |
| V5 | LOW | Work orders lack integrity protection | DOCUMENTED — defense-in-depth for future |

## Git
- Commit: `0d50c72` on `main`
- Pushed to `github.com/cheenu1092-oss/witness`
- Image tagged: `witness-dev:s16`

## RED-TEAM Phase Complete ✅
All Session 15 vulnerabilities addressed. 247 tests. External anchoring prototype working. Ready for next BUILD cycle (Sessions 17-18).
