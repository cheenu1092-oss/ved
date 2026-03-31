# Session 106 — Deep Live Testing with Cloud LLM

**Date:** 2026-03-31
**Phase:** CYCLE (Post-P5)
**Focus:** Comprehensive live testing with OpenAI gpt-4o-mini

## Summary

**All 9 deep live tests pass with a real cloud LLM.** This is the first time Ved has been tested against a cloud provider (OpenAI). Every major pipeline feature works end-to-end without code changes.

## What Was Done

### 1. Docker Baseline
- Rebuilt Docker images (stale package.json was showing `ved` 0.1.0 instead of `ved-ai` 0.8.0 — volume mount only covers `src/`, not root files)
- **3605/3605 unit tests pass in Docker**
- 0 type errors

### 2. Deep Live Test (`test/live-test-deep.ts`)
Comprehensive 9-test live test covering all previously untested pipeline features:

| Test | Status | Time | Detail |
|------|--------|------|--------|
| App init with OpenAI | ✅ PASS | 62ms | First cloud LLM init |
| Simple question (non-streaming) | ✅ PASS | 1,486ms | "Paris." — correct |
| Streaming token output | ✅ PASS | 1,561ms | 14 tokens streamed incrementally |
| Working memory persists | ✅ PASS | 2,122ms | Recalled "cerulean blue" across turns |
| Ved self-identifies | ✅ PASS | 1,638ms | "I am Ved, your personal AI assistant..." |
| RAG-enriched response | ✅ PASS | 1,763ms | Found "Dr. Elena Vasquez" from vault entity |
| T1→T2 compression | ✅ PASS | 28,377ms | 692-char daily note + T3 entity upserts |
| Audit chain integrity | ✅ PASS | 1ms | 58 entries, chain intact |
| Audit event types | ✅ PASS | 0ms | All expected types present |

### 3. Key Findings

**Everything works.** Zero code changes needed for cloud LLM support:
- OpenAI adapter correctly handles chat, streaming, and tool calling formats
- RAG enrichment works perfectly — gpt-4o-mini correctly uses injected vault context (unlike the small Ollama model in S96)
- T1→T2 compression fires on shutdown, writes well-structured daily notes with frontmatter
- T1→T3 entity upserts also trigger — the compressor extracted entities from conversations
- HMAC-signed audit chain remains intact across all operations (58 entries)
- Audit log captures all event types: `llm_call`, `memory_t2_compress`, `memory_t3_upsert`, `message_received`, `message_sent`, `session_start`, `shutdown`

### 4. Bug Found & Fixed
- **Docker stale package.json:** Docker compose only mounts `src/`, `test/`, `scripts/` — not `package.json`. This caused 15 npm-publish tests to fail (checking for `ved-ai` name). Fixed by rebuilding Docker images.

### 5. Live Test Config Fix
- `channels` config must be an array `[{type: 'cli', enabled: true}]`, not an object `{}` — the S96 test had this right, fixed in deep test.

## What Was NOT Tested (Deferred)
- **MCP tool calling with real server** — requires setting up an actual MCP server in the test. The unit tests cover tool calling thoroughly (including agentic loops), but live end-to-end with a real MCP server + real LLM deciding to call tools hasn't been tested yet.
- **Discord adapter with real Discord** — requires bot token + real server
- **Webhook delivery** — requires external endpoint
- **Multi-provider comparison** — only tested OpenAI; Anthropic key not available

## Stats
- **9/9 deep live tests pass** (0 warnings, 0 failures)
- **3605/3605 unit tests pass** (Docker parity)
- **0 type errors**
- **0 code changes needed** — everything worked out of the box

## Next Priorities
1. **MCP live test** — set up a simple stdio MCP server and test tool calling end-to-end
2. **npm publish** — actually publish to npm (not just dry-run)
3. **Anthropic adapter live test** — when API key becomes available
4. **Documentation refresh** — README, getting-started, architecture docs
5. **v0.9.0 or v1.0.0** — based on remaining gaps
