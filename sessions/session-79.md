# Session 79 — RED-TEAM: HTTP API, Webhooks, SSE, Pipe, Snapshot, Alias

**Date:** 2026-03-09
**Phase:** CYCLE (RED-TEAM)
**Duration:** ~15 min

## Objective

Last red-team was Session 46 — 32 sessions ago with massive new attack surface added: HTTP API server (S61), EventBus + SSE (S62), webhook delivery (S63), web dashboard (S63), 15+ new CLI commands (S64-S77). Overdue for security sweep.

## Attack Categories (11)

1. **HTTP API Request Smuggling** — Malformed URLs, parameter pollution, null bytes, oversized URLs, body abuse
2. **Webhook SSRF** — Protocol smuggling (file://, ftp://, javascript://, data://), internal network probing, cloud metadata
3. **SSE Resource Exhaustion** — Subscription cleanup, filter bypass, post-disconnect safety
4. **Pipe Shell Injection** — Command injection via input, timeout enforcement, inline vs shell steps
5. **Snapshot Git Injection** — Name validation, git flag injection, path traversal, length limits
6. **Alias Command Injection** — Reserved name protection, metacharacter rejection, YAML round-trip
7. **HTTP Auth Bypass** — Missing/wrong/empty tokens, Bearer variants, CORS, preflight
8. **Webhook Payload Manipulation** — Unique constraints, toggle edge cases, URL validation, metadata
9. **HTTP Endpoint Edge Cases** — 404s, unsupported methods, work order resolution, input validation
10. **EventBus Edge Cases** — Subscriber crashes, mid-emit unsubscribe, filter behavior, malformed JSON
11. **Pipeline YAML Parsing** — Embedded commands, deep nesting, comment injection, colons in values

## Findings

### Vulnerabilities Found: 2

**VULN-18: Pipeline path traversal (MEDIUM)**
- `loadSavedPipeline()` and `deleteSavedPipeline()` used `join(dir, name)` without path containment
- `../` in pipeline name could read/delete files outside the pipelines directory
- **Fixed:** Added `assertPathContained()` check using `resolve()` — rejects if resolved path exits directory

**VULN-19: Webhook custom header override (MEDIUM)**
- `metadata.headers` in webhook config were applied AFTER security headers (HMAC signature, Content-Length)
- Attacker who controls webhook config could spoof `X-Ved-Signature-256` header
- **Fixed:** Added blocked header set (`x-ved-signature-256`, `content-length`, `host`, `authorization`, `x-ved-event-delivery`)

### Documented Findings (Accepted Risk): 3

**SSRF-1/SSRF-2: No URL deny list for internal/private/metadata IPs (LOW)**
- Webhook URLs can point to localhost, 127.0.0.1, 169.254.169.254 (cloud metadata)
- Risk: LOW for local deployment, MEDIUM in cloud. Mitigation: network-level isolation in Docker.

**INFO-1: X-Powered-By header reveals Ved (LOW)**
- Minor information disclosure. Acceptable for personal assistant use.

**SNAP-1: Snapshot names starting with -- not explicitly rejected (LOW)**
- However, `ved-snap/` tag prefix prevents git flag interpretation. Risk: negligible.

### What Held Up

- **Protocol validation:** file://, ftp://, javascript://, data:// all rejected
- **Shell step security:** Input piped via stdin, not interpolated into command
- **Pipeline name sanitization:** `savePipeline()` replaces special chars
- **Alias name validation:** Reserved names blocked, metacharacters rejected, length enforced
- **HTTP auth:** Bearer token comparison works correctly, CORS on all responses
- **SSE cleanup:** Subscriptions properly cleaned on disconnect and server stop
- **EventBus isolation:** Subscriber errors don't crash the bus
- **YAML parser:** No recursive parsing, handles edge cases safely
- **Work order endpoints:** Expired/resolved properly rejected

## Stats

- **91 new tests** across 11 attack categories
- **2 vulnerabilities found and fixed** (VULN-18, VULN-19)
- **3 findings documented** (accepted risk)
- **2208/2208 tests pass** (host + Docker parity)
- **0 type errors**
- **0 regressions**

## Files Changed

- `src/redteam-s79.test.ts` — 91 red-team tests (NEW)
- `src/cli-pipe.ts` — Added `assertPathContained()`, fixed `loadSavedPipeline()` and `deleteSavedPipeline()`
- `src/webhook.ts` — Added blocked header set in `httpPost()` custom header application
