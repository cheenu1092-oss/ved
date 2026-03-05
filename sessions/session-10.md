# Session 10 — PLAN: MVP Scope Lock + Testing Strategy + Package Finalization

**Date:** 2026-03-04 09:16 PST  
**Phase:** PLAN (Session 5 of 5 — FINAL PLAN SESSION)  
**Objective:** Lock MVP scope, write plugin integration tests, finalize package structure, update README.

---

## 1. Plugin Architecture Refactor

**Major change:** Rewrote `plugin.ts` from class-based to function-based `register(api)` entry point.

### Before (Session 5 class)
```typescript
export class WitnessPlugin {
  constructor(config) { ... }
  afterToolCall(event, context) { ... }
  handleCommand(args) { ... }
}
```

### After (Session 10 function)
```typescript
export function register(api: PluginAPI) {
  // hook after_tool_call
  // hook before_tool_call (gate modes only)
  // register /witness command
  // set up sweep interval
  // register unload handler
}
```

**Why:** OpenClaw plugins use `register(api)` pattern, not class instantiation. The old class was never compatible with how OpenClaw actually loads plugins.

### register() does:
1. Resolve config from `api.pluginConfig` (supports both snake_case and camelCase)
2. Create `AuditStore` with resolved dbPath
3. Register `after_tool_call` hook (always — audit logging)
4. Register `before_tool_call` hook (only in gate modes — blocking)
5. Register `/witness` command (11 subcommands)
6. Start sweep interval (expired work orders, every 5 min)
7. Register `onUnload` handler (cleanup)

**Legacy `WitnessPlugin` class preserved** for backward compatibility and direct testing.

---

## 2. Config Resolution

Designed and implemented `resolveConfig()` function:

```typescript
function resolveConfig(pluginConfig: Record<string, unknown> = {}): WitnessConfig
```

Accepts both formats (OpenClaw may use either):
- `db_path` or `dbPath` → `config.dbPath`
- `ttl_minutes` or `ttlMinutes` → `config.ttlMinutes`
- `auto_approve_threshold` or `autoApproveThreshold` → `config.autoApproveThreshold`
- `risk_overrides` or `riskOverrides` → `config.riskOverrides`

Defaults applied for any missing key.

---

## 3. Fixed Type Mismatch Bug

**Bug found:** `plugin.ts` imported `ToolCallEvent` from `types.ts` — but that type was renamed to `AfterToolCallEvent` in Session 9. The file wouldn't have compiled.

**Fix:** Updated all imports to use `AfterToolCallEvent`, `BeforeToolCallEvent`, `BeforeToolCallResult`.

---

## 4. Plugin Integration Tests — 40 Tests

Created `test/plugin.test.ts` with mock OpenClaw API.

### Mock API Design

```typescript
interface MockPluginAPI extends PluginAPI {
  hooks: Record<string, Function[]>;
  commands: Record<string, (args: string) => string>;
  unloadHandlers: Function[];
  systemEvents: Array<{ text: string; opts: Record<string, unknown> }>;
}
```

The mock captures:
- All registered hooks (by name)
- All registered commands (by name)
- Unload handlers
- System events (for approval notification testing)

Helper functions: `fireAfterToolCall()`, `fireBeforeToolCall()` simulate OpenClaw calling the hooks.

### Test Suites

| Suite | Tests | What's Tested |
|-------|-------|---------------|
| Plugin Registration | 6 | Hook registration per mode, command registration, unload handler |
| Audit Logging (Phase 1) | 5 | Tool call logging, error logging, risk tracking, chain verification |
| Gating (Phase 2) | 5 | Blocking high-risk, allowing low/medium, work order creation |
| Gate-all Mode | 2 | Blocking medium-risk, allowing low-risk |
| Command Handler | 9 | All 11 subcommands, edge cases, unknown subcommand |
| Approve/Reject Flow | 8 | Approve, reject, double-resolve, system events, trust updates |
| Config Resolution | 3 | snake_case, camelCase, defaults |
| Legacy Class | 2 | afterToolCall(), handleCommand() |
| **Total** | **40** | |

---

## 5. New Commands Added

Session 10 added 4 new commands to the handler:

| Command | Description |
|---------|-------------|
| `/witness pending` | Show pending work orders with age |
| `/witness approve <id> [note]` | Approve blocked action, send system event |
| `/witness reject <id> [note]` | Reject blocked action |
| `/witness trust <tool>` | Show trust history (approved/rejected counts, auto-approve status) |
| `/witness mode` | Show current operating mode |

Total commands: 12 (was 6 in Session 5).

---

## 6. Package Structure — Decided

**Distribution:** Both npm package AND ClawHub skill.

| Artifact | Purpose | Format |
|----------|---------|--------|
| `npm` (`openclaw-witness`) | For `npm install` into any Node.js project | package.json |
| ClawHub skill | For `openclaw skill install witness` | SKILL.md + openclaw.plugin.json |
| GitHub repo | Source of truth | cheenu1092-oss/witness |

**Files created:**
- `openclaw.plugin.json` — OpenClaw plugin manifest (hooks, commands, config schema)
- `SKILL.md` — ClawHub skill metadata (YAML frontmatter)
- `CONTRIBUTING.md` — Contributor guidelines
- `MVP.md` — Scope lock document

---

## 7. MVP Scope Lock

### Ships in MVP (all built + tested)
- `register(api)` plugin entry point
- `after_tool_call` audit logging
- `before_tool_call` gating (gate-writes, gate-all modes)
- SHA-256 hash chain on events
- Work order lifecycle (create, approve, reject, expire, re-execute)
- Trust ledger (auto-approve tracking)
- 12 `/witness` subcommands
- Risk assessment (27 tools + param escalation)
- Config resolution (snake_case + camelCase)
- System event notification on approval
- SQLite WAL, <100μs/insert

### Deferred (post-MVP)
- npm publish + GitHub repo creation
- Real-world testing on live OpenClaw
- FTS5 queries (schema has FTS, code uses LIKE)
- File export (currently placeholder)
- Discord buttons for approve/reject
- Cost tracking integration
- Dashboard / visualization

---

## 8. Test Results — 92/92 Passing

```
 ✓ test/risk.test.ts (20 tests) 3ms
 ✓ test/plugin.test.ts (40 tests) 108ms
 ✓ test/store.test.ts (32 tests) 160ms

 Test Files  3 passed (3)
      Tests  92 passed (92)
   Duration  534ms
```

---

## 9. PLAN Phase Summary

**5 PLAN sessions complete. Here's what was accomplished:**

| Session | Focus | Key Output |
|---------|-------|------------|
| 6 | Integration architecture | Plugin + Hook + Skill hybrid design. Discovery: exec-approvals exists |
| 7 | HITL work orders | 6-state lifecycle, param-aware risk, approval UX |
| 8 | Plugin API audit | No api.invokeTool(), system events for notifications, Phase 2 register code |
| 9 | Data model finalization | Schema v2 (10 changes), 52 tests, WAL concurrency validated |
| 10 | MVP scope lock | register() refactor, 40 integration tests, package artifacts, README |

**From PLAN phase we produced:**
- Complete plugin code (6 source files, ~1,800 lines)
- 92 passing tests across 3 test files
- Package artifacts (plugin manifest, SKILL.md, CONTRIBUTING.md, MVP.md)
- Detailed architecture documentation in session logs

**PLAN phase is COMPLETE. Next: BUILD (Session 11) — Fork repo, real-world testing.**

---

*Session duration: ~20 min*  
*Phase status: PLAN complete (5/5). Next: BUILD — Session 11.*
