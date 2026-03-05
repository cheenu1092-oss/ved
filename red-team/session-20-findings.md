# Red-Team Findings — Session 20

**Date:** 2026-03-04  
**Phase:** RED-TEAM (Cycle 3, 1 of 2)  
**Tests:** 44 attacks across 9 categories  

## Vulnerabilities Found

### V6 — CLI Crash on Non-SQLite Files (MEDIUM)
**Vector:** `witness stats --db /etc/passwd`  
**Impact:** CLI commands (stats, recent, search, pending, health) check `existsSync()` but don't catch `better-sqlite3` constructor errors when the file exists but isn't SQLite.  
**Result:** Uncaught `SqliteError: file is not a database` → process crash.  
**Fix:** Wrap `new AuditStore(path)` in try/catch in each CLI command.

### V7 — NaN Schema Version Blocks All Migrations (MEDIUM)
**Vector:** Corrupt `config` table: `schema_version = 'abc'`  
**Impact:** `getCurrentVersion()` returns `NaN`. Since `m.version > NaN` is always `false`, no migrations are ever pending. Silently blocks all future migrations.  
**Fix:** Add NaN check in `getCurrentVersion()` — if `isNaN`, return 0.

### V8 — Anchor Without HMAC Accepts Forged Consistency (MEDIUM)
**Vector:** Attacker modifies both DB chain and anchor file to match.  
**Impact:** Without `anchorSecret`, validation only compares hash equality. If attacker controls both files, forgery is undetectable.  
**Fix:** Document that `anchorSecret` is required for production. Consider making it mandatory when anchor is enabled.

### V9 — Version Field Accepts XSS Payload (LOW)
**Vector:** `version: "1.0.0<script>alert(1)</script>"`  
**Impact:** Semver regex `/^\d+\.\d+\.\d+/` matches the prefix, ignoring the XSS payload suffix. If version is rendered in HTML (e.g., admin dashboard), XSS is possible.  
**Fix:** Use strict semver regex: `/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/`

### V10 — NaN/Infinity TTL Bypass Validation (LOW)
**Vector:** `ttl_minutes: NaN` or `ttl_minutes: Infinity`  
**Impact:** Both pass `typeof === 'number'` check. NaN bypasses `< 1` (NaN comparisons are always false). Infinity means work orders never expire.  
**Fix:** Add `!isFinite(value) || isNaN(value)` checks for numeric config fields.

### V11 — Duplicate Hooks Not Detected (LOW)
**Vector:** `hooks: ['after_tool_call', 'after_tool_call', 'after_tool_call']`  
**Impact:** Manifest validation doesn't check for duplicates. Could cause double/triple logging if OpenClaw registers each hook instance.  
**Fix:** Add deduplication warning in `validateManifest`.

### V12 — LIKE Wildcard in Search (INFORMATIONAL)
**Vector:** `witness search "%"`  
**Impact:** `%` in search becomes `%%%` in SQL LIKE, matching all records. Not exploitable but could be surprising.  
**Fix:** Escape LIKE wildcards (`%` → `\%`, `_` → `\_`) in search query.

### V13 — Direct DB Access Bypasses Audit Trail for Work Orders (INFORMATIONAL)
**Vector:** Open `witness.db` directly, `UPDATE work_orders SET status = 'approved'`  
**Impact:** Work order state changes via direct DB access are not recorded in the hash chain audit trail (V5 only logs via `resolveWorkOrder()`).  
**Fix:** Already mitigated by V5 defense-in-depth — absence of an audit event for the state change IS the detection signal. Document this in security guide.

## Summary

| ID | Severity | Category | Status |
|----|----------|----------|--------|
| V6 | MEDIUM | CLI | NEW |
| V7 | MEDIUM | Migration | NEW |
| V8 | MEDIUM | Anchor | NEW (design limitation) |
| V9 | LOW | Validation | NEW |
| V10 | LOW | Validation | NEW |
| V11 | LOW | Validation | NEW |
| V12 | INFO | Search | NEW |
| V13 | INFO | Work Orders | MITIGATED (V5) |

**Cumulative totals (S15 + S16 + S20):**
- 13 vulnerabilities found
- 5 fixed in S16 (V1-V5)
- 8 new in S20 (V6-V13)
- 3 MEDIUM, 3 LOW, 2 INFORMATIONAL remaining

## Positive Findings (Things That DIDN'T Break)
- ✅ SQL injection fully mitigated (parameterized queries throughout)
- ✅ Prototype pollution via pluginConfig has no effect
- ✅ Work order state machine enforces `WHERE status = 'pending'` correctly
- ✅ Case-sensitivity bypass (V3 fix) holds — EXEC/Exec/exec all map to critical risk
- ✅ Unicode homoglyphs get medium risk (default) — still blocked in gate-all mode
- ✅ Concurrent migrations serialize cleanly via SQLite transactions
- ✅ 10MB param payloads handled without crash
