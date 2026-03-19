# Session 87 — RED-TEAM: Hook, Notify, Migrate, Sync

**Date:** 2026-03-18
**Phase:** CYCLE (red-team)
**Duration:** ~15 min

## Goals
- Push unpushed S85-86 work to GitHub
- Red-team features built since last red-team (S79): hook (S80), notify (S81), migrate (S82-83), sync (S85-86)
- Fix any vulnerabilities found

## What Happened

### GitHub Push
- Pushed S86 commit (431cf04) to GitHub — sync tests + TS fixes

### Red-Team: 83 Tests Across 18 Attack Categories

**Hook (S80):**
1. Command Blocking Bypass (10 tests) — Found VULN-20: rm flags like `-rfv`, `-r -f`, `--recursive`, `--force` bypassed the regex. **FIXED:** expanded regex.
2. Environment Variable Injection (4 tests) — Found VULN-21: null bytes in event sessionId crash executeHook (Node.js TypeError on env vars). **FIXED:** added `sanitizeEnv()` to strip null bytes.
3. YAML Store Corruption (6 tests) — YAML round-trip safe, corrupted file handling works, name validation blocks injection.
4. Concurrency Manipulation (3 tests) — maxConcurrent=0 and negative values correctly block all executions.

**Notify (S81):**
5. osascript Injection (4 tests) — Template rendering produces literal strings; quote escaping neutralizes injection.
6. Log Path Traversal (3 tests) — logPath has no containment (by design — user-configured, not user-input).
7. Template Injection (5 tests) — No double-interpretation, no format string execution, handles long/null/regex-special values.
8. Quiet Hours Edge Cases (4 tests) — Malformed/undefined/same times handled safely.
9. Rule Name Validation (5 tests) — Reserved names, metacharacters, empty/whitespace blocked. Case-insensitive.
10. Command Channel Safety (4 tests) — rm, sudo, shutdown, reboot all blocked in command delivery channel.
11. Mute State Tampering (3 tests) — Graceful fallback on corrupted/missing mute file.
12. YAML Rule Store Corruption (3 tests) — Special characters serialize safely, dangerous commands blocked at delivery.

**Migrate (S82-83):**
13. Path Traversal (6 tests) — sanitizeFileName strips separators, null bytes, control chars, Windows reserved chars. isPathSafe validates resolved paths.
14. CSV Injection (3 tests) — Formula patterns neutralized (plain markdown, not spreadsheet). Newlines and wide rows handled.

**Sync (S85-86):**
15. Shell Injection via sq() (6 tests) — URL validation + sq() single-quote wrapping protects against backtick/$() injection. Name validation blocks metacharacters.
16. Local Adapter Traversal (6 tests) — `..` blocked, relative paths blocked, absolute/tilde paths allowed.
17. SQL Injection (3 tests) — Parameterized queries protect name/URL/auth fields. Injection stored as literal data.
18. Adapter Type Safety (5 tests) — DB CHECK constraints enforce valid remote types, sync directions, sync statuses.

### Vulnerabilities Found & Fixed
| ID | Severity | Description | Fix |
|----|----------|-------------|-----|
| VULN-20 | LOW | rm flag bypass (`-rfv`, `-r -f`, `--recursive`, `--force`) | Expanded BLOCKED_PATTERNS regex |
| VULN-21 | MEDIUM | Null bytes in event fields crash executeHook via env vars | `sanitizeEnv()` strips `\0` before child_process |

### Findings (Accepted Risk)
| # | Description | Rationale |
|---|-------------|-----------|
| F1 | base64-encoded payloads bypass hook command blocking | Static analysis limitation — same as S43 encoding bypass |
| F2 | Variable expansion (`$R $F`) bypasses blocking | Static analysis limitation — commands are user-set |
| F3 | Notify logPath has no path containment check | By design — user configures the path, not untrusted input |
| F4 | maxConcurrent≤0 blocks all hook executions | Edge case, not exploitable — could confuse users |

### Defenses That Held
- YAML serialization (round-trip safe, injection-resistant)
- Hook name validation (blocks YAML control characters)
- sq() shell quoting (single-quote wrapping prevents backtick/dollar injection)
- Parameterized SQL queries (injection stored as literals)
- DB CHECK constraints (type/direction/status enforcement)
- Content filter (dangerous command blocking in notify command channel)
- osascript quote escaping (neutralizes shell metacharacters)
- sanitizeFileName (strips all dangerous characters)
- isPathSafe (validates resolved paths stay within vault)

## Test Results
- **83 new red-team tests**
- **2542/2542 pass (host + Docker parity)**
- **0 type errors**

## Git
- Pushed to GitHub: 37a7c9e
