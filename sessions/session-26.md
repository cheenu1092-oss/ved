# Session 26 — PLAN: Config Schema, Error Codes & Logging

**Date:** 2026-03-05
**Phase:** PLAN (3 of 5)
**Duration:** ~15 min

## What Was Done

### 1. Complete Config Schema
- **File locations:** `~/.ved/config.yaml` (main) + `config.local.yaml` (secrets)
- **5-layer loading:** defaults → config.yaml → config.local.yaml → env vars → CLI flags
- **Environment variable mapping:** `VED_*` prefix, nested keys flattened with `_`
- **Full YAML template** with all fields and defaults documented
- **TypeScript interface** (final version, extends S24 draft with `logFormat`, `logFile`, `MCPConfig`)
- **16 validation rules** — 12 hard errors (won't start), 4 warnings (starts with degraded features)
- **Path expansion** — `~`, `$ENV_VAR`, relative paths resolved from `~/.ved/`
- **`ved init` command** — creates config files + vault structure

### 2. Error Codes Catalog
- **42 error codes** across 10 categories: CONFIG, DB, LLM, MCP, MEMORY, RAG, AUDIT, TRUST, CHANNEL, SESSION, GENERAL
- **Single `VedError` class** with `code`, `message`, `cause`, `context` — no class hierarchy
- **4 error handling patterns** documented with code examples
- **Error → user message mapping** — sanitization rules so users never see stack traces or internal details
- **Security events** (AUDIT_HASH_MISMATCH) always surfaced prominently

### 3. Structured Logging Design
- **Zero new dependencies** — `console.log` + JSON serialization
- **Two sinks:** console (ephemeral debug) vs. audit log (permanent, hash-chained)
- **Two formats:** `json` (production) and `pretty` (development)
- **Module-scoped logger factory** — `createLogger('ved-rag')` auto-tags entries
- **14 audit event types** covering the complete pipeline
- **Sensitive data redaction** — API keys, tokens, secrets never logged
- **Bootstrap order** specified: config → logger → DB → audit → everything else

### 4. Cross-Cutting Concerns
- Startup bootstrap order (6 steps, strict dependency chain)
- Sensitive data handling rules
- **Dependency count unchanged: 6 total** (swapped `gray-matter` for `yaml` — smaller, same purpose)

## Output
- `docs/config-errors-logging.md` (30KB)

## Key Decisions
1. **config.local.yaml for secrets** — keeps main config committable to git
2. **42 string error codes, not numbered** — grep-friendly, no collision risk
3. **Pretty log format for dev** — `09:15:32.123 INFO [ved-rag] message {data}` 
4. **Console ≠ truth** — audit log is always the source of truth
5. **`yaml` package replaces `gray-matter`** — handles both config and frontmatter, smaller footprint

## What's Next
- **Session 27:** PLAN — MCP integration spec (tool discovery, transport, permissions, retry)
- **Session 28:** PLAN — End-to-end message walkthrough + final PLAN review
