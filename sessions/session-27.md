# Session 27 — MCP Integration Spec

**Date:** 2026-03-05
**Phase:** PLAN (4 of 5)
**Duration:** ~15 min

## What Was Done

Wrote the complete MCP integration specification (`docs/mcp-integration.md`, ~33KB) covering:

1. **Server lifecycle** — 5 states (IDLE→CONNECTING→READY→RECONNECTING→FAILED), lazy connection on first use, eager discovery at init
2. **Transport details** — Full implementation sketches for StdioTransport (spawn + JSON-RPC over stdin/stdout) and HttpTransport (SSE + POST). Security constraints (no shell:true, no metacharacters)
3. **Tool discovery** — Namespacing (`{server}.{tool}`), caching, dynamic tool change notifications, deduplication
4. **Permission model** — Trust × Risk matrix (4×4), server trust floors, tool filtering (denied tools hidden from LLM), per-tool/per-server risk overrides
5. **Tool execution flow** — 5-step pipeline (VALIDATE→PERMISSION→EXECUTE→AUDIT→RESULT), sequential execution, result formatting (text-only v1)
6. **Retry/timeout** — No automatic tool retries (LLM decides), exponential backoff for server reconnection (3 retries, 1s/2s/4s), per-server timeouts
7. **LLM tool formatting** — MCPToolDefinition → Anthropic/OpenAI format, tool filtering by session trust, tool call parsing
8. **Built-in MCP servers** — `@ved/mcp-memory` (7 tools wrapping VaultManager) and `@ved/mcp-vault-git` (3 tools for git operations)
9. **MCPClient class structure** — Complete interface matching S24 estimate (~600 lines across 3 files)

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Sequential tool execution | Audit ordering, safety, simplicity |
| No automatic tool retries | Non-idempotent risk; LLM should decide |
| Memory as MCP tool | Unifies interface, gets trust + audit free |
| Namespace tools by server | Prevents collisions, enables routing |
| Filter denied tools from LLM | Reduces token waste, fewer confusing errors |
| Lazy connection (except init discovery) | Faster startup, graceful degradation |

## Resolved Questions
6 open questions answered (parallel execution, retry policy, dynamic tools, memory interface, naming collisions, tool filtering).

## Output
- `docs/mcp-integration.md` — 33KB, 13 sections

## Next
Session 28 — PLAN (5 of 5): End-to-end walkthrough tracing a complete user message through ALL modules. Final PLAN review before BUILD.
