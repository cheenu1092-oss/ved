# Red-Team Findings — Session 15

**Date:** 2026-03-04
**Tester:** Cheenu (automated red-team suite)
**Tests:** 45 across 9 attack categories
**Result:** 5 vulnerabilities found, 0 critical blockers for Phase 1 (audit-only)

---

## Vulnerability Summary

| # | Severity | Finding | Phase Impact | Fix Priority |
|---|----------|---------|--------------|--------------|
| V1 | HIGH | Full hash chain rewrite passes verification | Phase 1 | P1 (Phase 2+) |
| V2 | MEDIUM | No genesis anchor validation in verifyChain | Phase 1 | P2 |
| V3 | MEDIUM | Tool name case-sensitivity bypass (Exec vs exec) | Phase 2 | P1 |
| V4 | MEDIUM | Trust auto-approve can be gamed by bulk approvals | Phase 3 | P2 |
| V5 | LOW | Work orders lack integrity protection (no hash chain) | Phase 2 | P3 |

---

## V1: Full Hash Chain Rewrite (HIGH)

**Attack:** An attacker with DB file access can modify any event's content, then recompute all subsequent hashes to produce a valid chain.

**Why it works:** `verifyChain()` only checks internal consistency (each hash matches its inputs, each prevHash links to the prior hash). There's no external anchor — no signed root, no timestamped checkpoint, no external witness.

**Impact:** An attacker who gains file-system access to `witness.db` can silently rewrite history. The `verify()` command will report the chain as intact.

**Mitigation options (for Phase 2+):**
1. **External anchoring:** Periodically publish root hash to an external service (Discord message, git commit, blockchain)
2. **Signed checkpoints:** Use an asymmetric key to sign periodic chain summaries
3. **Merkle tree:** Replace linear chain with Merkle tree — makes partial rewrites computationally harder
4. **Rate-limited write access:** Ensure only the Witness process can write to the DB (OS-level file permissions)

**Phase 1 risk:** LOW — audit-only mode assumes trusted environment. File-system access = game over regardless.

---

## V2: No Genesis Anchor Validation (MEDIUM)

**Attack:** `verifyChain()` does not check that the first event's `prevHash` equals `GENESIS_HASH`. An attacker can replace the genesis anchor with any value, recompute the first hash, and verification passes.

**Fix:** Add to `verifyChain()`:
```typescript
if (events.length > 0 && events[0].prevHash !== GENESIS_HASH) return 0;
```

**Priority:** P2 — simple fix, should be in next BUILD session.

---

## V3: Tool Name Case-Sensitivity Bypass (MEDIUM)

**Attack:** Risk defaults are case-sensitive. `exec` → high risk, `Exec` → unknown (defaults to medium). In `gate-writes` mode, medium-risk tools are not blocked, so `Exec` bypasses gating.

**Real-world likelihood:** LOW for OpenClaw (tool names are controlled by the framework). But if any plugin registers a tool with different casing, it could bypass risk assessment.

**Fix:** Normalize tool names to lowercase in `assessRisk()`:
```typescript
const normalizedName = toolName.toLowerCase();
```

**Priority:** P1 for Phase 2 — must be fixed before gating goes live.

---

## V4: Trust Auto-Approve Gaming (MEDIUM)

**Attack:** With `autoApproveThreshold: 3`, an attacker who can approve 3 benign `exec` commands (e.g., `echo hello`) gets auto-approval for ALL future exec commands, including `rm -rf /`.

**The trust system is tool-name granular, not param-aware.** Once `exec` is trusted, every exec command is trusted.

**Mitigation options:**
1. **Param-aware trust:** Track trust per tool+param-pattern (e.g., `exec:echo*` vs `exec:rm*`)
2. **Risk-level gate:** Never auto-approve critical-risk assessments regardless of trust history
3. **Sliding window:** Only count recent approvals (last N days), not all-time
4. **Higher default threshold:** 10+ approvals with mandatory cool-down period

**Priority:** P2 for Phase 3 — trust system isn't active in Phase 1-2.

---

## V5: Work Orders Lack Integrity Protection (LOW)

**Attack:** Work orders are stored in a regular mutable table with no hash chain. Direct DB access allows changing a rejected work order to approved.

**Real-world likelihood:** Same as V1 — requires file-system access.

**Mitigation:** Log work order state transitions in the events table (append-only). This creates a cross-reference: if work_orders says "approved" but events says "rejected", tampering is detected.

**Priority:** P3 — defense-in-depth, not blocking.

---

## What Held Up Well

1. **SQL injection:** All prepared statements. Zero injection vectors found across 5 test scenarios.
2. **Input fuzzing:** Handles null bytes, 1MB tool names, 10MB params, 100-level nesting, CJK/RTL/emoji, zero-width chars — no crashes.
3. **Work order state machine:** Can't double-approve, can't approve rejected, can't approve expired. Only pending→approved/rejected transitions work.
4. **Crash recovery:** Corrupt DB throws (no silent data loss), zero-byte DB auto-creates, read-only DB fails explicitly.
5. **Race conditions:** 1000 rapid inserts maintain chain integrity. Concurrent work order resolution — first writer wins.
6. **Command handler:** Handles proto injection, million-char args, special chars in search — all safe.

---

## TTL Edge Case Found (Bug)

`ttlMinutes: 0` does NOT immediately expire a work order. The sweep query uses `expires_at < @now` (strict less-than), but with 0 TTL, `expires_at` equals `created_at` which equals `now`. The order stays pending until the next sweep cycle where `now` has advanced.

**Severity:** LOW (edge case, no security impact)
**Fix:** Use `<=` in sweep query, or disallow `ttlMinutes: 0`.

---

## Recommendations for Session 16 (RED-TEAM 2)

1. Fix V2 (genesis anchor) and V3 (case normalization) — they're quick wins
2. Add external anchor prototype (publish root hash to a file/Discord)
3. Fuzz the plugin registration path more (corrupt `register()` calls, missing hooks)
4. Test the plugin under OpenClaw's actual hook lifecycle (mock more realistically)
5. Prototype param-aware trust (V4 mitigation) even if Phase 3 is distant
