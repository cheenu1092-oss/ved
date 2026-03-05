# Session 20 — RED-TEAM (Cycle 3, 1 of 2)

**Date:** 2026-03-04 19:16 PST  
**Phase:** RED-TEAM  
**Duration:** ~15 min  

## What Happened

Attacked the Session 18-19 additions (CLI, migration system, anchor module) plus plugin config and validation bypasses.

### Attack Vectors Tested (9 categories, 44 tests)

1. **CLI Argument Injection** (7 tests) — Path traversal, null bytes, negative/huge limits, SQL injection via search, shell injection in command name
2. **Migration System Attacks** (6 tests) — Schema version corruption (high, zero, NaN), config table deletion, concurrent migration races, target version limiting
3. **Anchor Forgery** (8 tests) — Hash forgery with/without HMAC, HMAC bypass with wrong secret, replay attacks, malformed JSON, wrong version number
4. **Validation Bypass** (9 tests) — Prototype pollution in manifest, extreme name length, duplicate hooks, null risk_overrides, Infinity/NaN in numeric fields, XSS in version
5. **SQL Injection via Store** (2 tests) — 5 injection payloads + 10MB param stress test
6. **Plugin Config Pollution** (2 tests) — __proto__ in pluginConfig, array as riskOverrides
7. **Work Order State Manipulation** (3 tests) — Double-resolve, direct DB bypass, expire-then-approve
8. **Risk Assessment Bypass** (4 tests) — Unicode homoglyphs, zero-width characters, case variations, empty tool name
9. **CLI with Hostile Database** (2 tests) — Corrupt file, empty SQLite file

### Findings

**8 new vulnerabilities found:**
- 3 MEDIUM: CLI crash on non-SQLite files, NaN schema version blocks migrations, unsigned anchor forgery
- 3 LOW: XSS in version field, NaN/Infinity TTL bypass, duplicate hooks undetected
- 2 INFORMATIONAL: LIKE wildcard in search, direct DB work order bypass

### Docker Commands

```bash
# Run red-team tests
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c 'npm install && npx vitest run test/red-team-s20.test.ts'

# Full suite (393 tests)
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c 'npm install && npx vitest run'
```

### Stats
- **393 tests total, all passing** (44 new in this session)
- Image tagged: `witness-dev:s20`
- Pushed to GitHub: `cheenu1092-oss/witness`
