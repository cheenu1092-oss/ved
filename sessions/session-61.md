# Session 61 — HTTP API Server (`ved serve`)

**Date:** 2026-03-07
**Phase:** CYCLE
**Duration:** ~15 min

## What Was Done

### 1. HTTP API Server (`src/http.ts` — 370 lines)

Built a lightweight REST API server using `node:http` (zero external dependencies). Exposes Ved's core functionality over HTTP:

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (200/503) |
| GET | `/api/stats` | System stats (vault, RAG, audit, sessions) |
| GET | `/api/search?q=&n=` | RAG search (vector + FTS + graph fusion) |
| GET | `/api/history` | Audit history (with type/date/limit filters, chain verify) |
| GET | `/api/vault/files` | List vault files (optional folder filter) |
| GET | `/api/vault/file?path=` | Read a vault file (frontmatter + body + links) |
| GET | `/api/doctor` | Run diagnostics |
| POST | `/api/approve/:id` | Approve a work order |
| POST | `/api/deny/:id` | Deny a work order |

**Features:**
- Bearer token auth (optional, via `--token` or `VED_API_TOKEN` env)
- CORS support (configurable origin, preflight handling)
- Path traversal protection on vault file reads (403)
- Input validation on all endpoints (400 for bad params)
- Proper HTTP status codes (200/400/403/404/409/500/503)
- URL-encoded query params and path params decoded correctly
- JSON body parsing with 1MB limit
- `X-Powered-By: Ved` header

### 2. CLI Command (`ved serve`)

New CLI command with flags:
```
ved serve                    — Start on default port (3141)
ved serve --port 8080        — Custom port
ved serve --host 0.0.0.0     — Bind to all interfaces
ved serve --token <secret>   — Require Bearer token auth
ved serve --cors '*'         — Set CORS origin
```

### 3. Shell Completions Updated

All 3 shells (bash/zsh/fish) updated with `serve` command and its flags.

### 4. Tests (56 new)

Comprehensive test coverage across 12 categories:
- Lifecycle (4): start, stop, double-start, idempotent stop
- Health (2): healthy/unhealthy status codes
- Stats (1): full stats response
- Search (6): query, missing query, n param, fts_only, invalid n, n > 100
- History (7): entries, type filter, limit, date filters, chain verify, invalid limit, invalid date
- Vault files (2): list, folder filter
- Vault file (4): read, missing path, 404 not found, 403 path traversal
- Doctor (2): healthy/unhealthy diagnostics
- Approve (4): approve, unknown, expired, no body
- Deny (4): deny, unknown, resolved, default reason
- Auth (4): no token, wrong token, correct token, malformed scheme
- CORS (3): default headers, OPTIONS preflight, custom origin
- Routing (4): unknown path, root, wrong method, trailing slash
- Response format (2): JSON content type, X-Powered-By
- Error handling (3): sync throw, async reject, non-Error throw
- URL encoding (2): query decode, path param decode
- Missing owners (2): approve/deny without owner IDs

## Stats
- **Tests:** 1229/1229 pass (host) + Docker parity verified
- **Type errors:** 0
- **New files:** `src/http.ts` (370 lines), `src/http.test.ts` (560 lines)
- **CLI commands:** 18 (added `serve`)
- **No new dependencies** — pure `node:http`
