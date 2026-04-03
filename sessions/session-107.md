# Session 107 — MCP Live Test: Tool Calling with Real LLM + Real MCP Server

**Date:** 2026-04-03
**Phase:** CYCLE
**Focus:** End-to-end MCP tool calling with OpenAI gpt-4o-mini + stdio MCP server

## Summary

**All 9 MCP live tests pass.** Ved successfully routes tool calls from a real LLM through a real MCP server and feeds results back for multi-step reasoning. Three bugs were found and fixed during testing.

## What Was Done

### 1. MCP Test Server (`test/mcp-test-server.ts`)
Minimal stdio MCP server providing 3 tools:
- `calculator` — safe arithmetic evaluation
- `get_weather` — fake weather data for 5 cities
- `get_time` — current ISO timestamp

Full JSON-RPC 2.0 protocol: initialize handshake, tools/list, tools/call.

### 2. Live Test Results (`test/live-test-mcp.ts`)

| Test | Status | Time | Detail |
|------|--------|------|--------|
| App init + MCP server connects | ✅ PASS | 552ms | Discovered 3 tools |
| LLM uses calculator for math | ✅ PASS | 7,311ms | 347 * 23 = 7981 ✓ |
| LLM uses weather tool | ✅ PASS | 3,218ms | SF: 62°F, Foggy, 78% humidity |
| LLM uses time tool | ✅ PASS | 1,844ms | Current ISO time returned |
| Multi-step reasoning | ✅ PASS | 2,972ms | 15 * 17 = 255, correctly not prime |
| Multi-city weather comparison | ✅ PASS | 3,991ms | Tokyo (68°F) warmer than London (50°F) |
| Audit trail captures tool events | ✅ PASS | 1ms | tool_requested + tool_executed present |
| Audit chain integrity | ✅ PASS | 0ms | 28 entries, chain intact |
| Tool call details in audit | ✅ PASS | 1ms | 6 tool_executed events with details |

### 3. Bugs Found & Fixed

**BUG 1: Tool name sanitization (MCP client)**
- Tool names used dot separator (`server.tool`) but OpenAI/Anthropic require `^[a-zA-Z0-9_-]+$`
- Fixed: Changed to double-underscore separator (`server__tool`) with character sanitization

**BUG 2: OpenAI tool calling protocol (event loop)**
- OpenAI requires assistant messages to include `tool_calls` array before tool result messages
- Ved was sending tool results without the preceding assistant+tool_calls message
- Fixed in all 3 message processing paths (async, direct, stream)

**BUG 3: ConversationMessage type missing toolCalls**
- Added `toolCalls?: ToolCall[]` to ConversationMessage type to support the protocol fix

## Stats
- **9/9 MCP live tests pass** (0 warnings, 0 failures)
- **3605/3605 unit tests pass** (Docker parity)
- **0 type errors**
- **3 bugs found and fixed**
- **6 files changed, +594/-20 lines**
- Pushed to GitHub (088792e)

## Next Priorities
1. **npm publish** — actually publish to npm
2. **v0.9.0 or v1.0.0 release** — all major features tested end-to-end
3. **Documentation refresh** — architecture docs, contributor guide
