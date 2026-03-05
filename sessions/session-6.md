# Session 6 — PLAN: Core Architecture & OpenClaw Integration

**Date:** 2026-03-04 04:16 PST  
**Phase:** PLAN (Session 1 of 5)  
**Objective:** Map Witness to OpenClaw's actual plugin API. Decide registration mechanism, data directory, event loop, and command exposure.

---

## 1. OpenClaw Plugin System — What We Learned

After reading all relevant OpenClaw docs (`tools/plugin.md`, `plugins/manifest.md`, `plugins/agent-tools.md`, `automation/hooks.md`, `tools/exec-approvals.md`, `cli/hooks.md`), here's the real architecture:

### Plugin Types Available to Us

| Mechanism | What It Does | Where to Use |
|-----------|-------------|--------------|
| **Plugin (extension)** | Full TypeScript module loaded in-process. Can register tools, hooks, commands, RPC methods, background services. | Our main entry point. |
| **Hook** | Event-driven handler for command/lifecycle events (HOOK.md + handler.ts). Lighter weight. | Could supplement, but plugin is more powerful. |
| **Skill** | Agent-facing instructions (SKILL.md + scripts). The LLM reads SKILL.md. | We'll add a SKILL.md so the agent knows about `/witness`. |

### Key Discovery: OpenClaw Already Has `tool_result_persist` Hooks

From hooks doc: *"`tool_result_persist`: transform tool results before they are written to the session transcript. Must be synchronous."*

This is Phase 1's ideal integration point for audit logging — we see every tool result before it hits the transcript.

### Key Discovery: OpenClaw Already Has Exec Approvals

The `exec-approvals` system is a full HITL approval flow for shell commands, with:
- Allowlists, deny lists, ask modes
- UI prompts forwarded to chat channels (`/approve <id> allow-once`)
- macOS IPC flow (Gateway → Node Service → Mac App)
- Per-agent approval scoping

**Implication for Phase 2:** We do NOT need to build the approval UX from scratch. We can:
1. Extend the existing approval pattern to cover ALL tools (not just exec)
2. Use the same `/approve` slash command mechanism
3. Piggyback on the existing chat-channel forwarding

This is a **massive scope reduction** for Phase 2.

---

## 2. Architecture Decision: Plugin + Hook + Skill (Hybrid)

Witness will be a **plugin** (primary) that also ships a **skill** and uses **hooks**:

```
witness/
├── openclaw.plugin.json          # Plugin manifest (required)
├── package.json                   # npm metadata + openclaw.extensions
├── src/
│   ├── index.ts                   # Plugin entry: register(api) { ... }
│   ├── store.ts                   # AuditStore (SQLite, hash chain)
│   ├── risk.ts                    # Risk assessment
│   ├── hash.ts                    # Hash chain crypto
│   └── types.ts                   # Core types
├── skills/
│   └── witness/
│       └── SKILL.md               # Agent instructions for /witness
├── schema.sql                     # SQLite schema
└── test/
    └── store.test.ts
```

### Why Plugin (Not Just Hook)?

- **Hooks** can only listen to events. They can't register tools, commands, or RPC methods.
- **Plugins** can do everything: register tools, auto-reply commands, background services, hooks, RPC.
- We need `/witness` as an auto-reply command (no LLM needed to show recent events).
- We need a background service for DB lifecycle management.

### Why Also a Skill?

The agent needs to know Witness exists. A `SKILL.md` tells the LLM:
- What `/witness` does
- How to interpret audit data
- When to proactively check the audit log

### Why Also Hooks?

The `tool_result_persist` hook is the cleanest integration for Phase 1. But since plugins can register hooks via `api.registerHook(...)`, we do this from within the plugin — no separate HOOK.md needed.

---

## 3. Plugin Registration — Concrete Design

### `openclaw.plugin.json` (manifest)

```json
{
  "id": "witness",
  "name": "Witness",
  "description": "Tamper-evident audit trails for OpenClaw agents",
  "version": "0.1.0",
  "kind": null,
  "skills": ["./skills/witness"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "mode": {
        "type": "string",
        "enum": ["audit", "gate-writes", "gate-all"],
        "default": "audit"
      },
      "dbPath": {
        "type": "string",
        "description": "Path to witness.db (relative to plugin data dir)"
      },
      "ttlMinutes": {
        "type": "number",
        "default": 30,
        "description": "Phase 2: Work order TTL in minutes"
      },
      "autoApproveThreshold": {
        "type": "number",
        "default": 10,
        "description": "Phase 3: Auto-approve after N manual approvals"
      },
      "riskOverrides": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "enum": ["low", "medium", "high", "critical"]
        },
        "default": {}
      }
    }
  },
  "uiHints": {
    "mode": { "label": "Witness Mode", "placeholder": "audit" },
    "dbPath": { "label": "Database Path" },
    "riskOverrides": { "label": "Risk Level Overrides" }
  }
}
```

### `src/index.ts` (plugin entry point)

```typescript
import { AuditStore } from './store.js';
import { assessRisk } from './risk.js';
import type { WitnessConfig } from './types.js';

const DEFAULTS: WitnessConfig = {
  mode: 'audit',
  dbPath: '', // resolved at runtime
  ttlMinutes: 30,
  autoApproveThreshold: 10,
  riskOverrides: {},
};

export default function register(api: any) {
  const cfg = { ...DEFAULTS, ...api.config };
  
  // Resolve DB path: prefer config, fallback to plugin data dir
  const dbPath = cfg.dbPath || api.runtime?.dataDir 
    ? `${api.runtime.dataDir}/witness.db`
    : `${process.env.HOME}/.openclaw/witness/witness.db`;
  
  const store = new AuditStore(dbPath);

  // ── Phase 1: Audit logging via tool_result_persist hook ──
  api.registerHook('tool_result_persist', (event: any) => {
    const riskLevel = assessRisk(
      event.toolName,
      event.params ?? {},
      cfg.riskOverrides,
    );
    
    store.append({
      timestamp: new Date().toISOString(),
      sessionKey: event.sessionKey ?? 'unknown',
      agentId: event.agentId ?? 'main',
      channel: event.channel,
      toolName: event.toolName,
      params: event.params ?? {},
      resultOk: !event.error,
      resultSummary: summarize(event.result, event.error),
      durationMs: event.durationMs,
      riskLevel,
      action: 'logged',
    });
    
    return undefined; // don't modify the tool result
  }, {
    name: 'witness.audit-logger',
    description: 'Log every tool call to Witness audit store',
  });

  // ── Auto-reply command: /witness ──
  api.registerCommand({
    name: 'witness',
    description: 'Query the Witness audit log',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const result = handleWitnessCommand(store, ctx.args ?? '');
      return { text: result };
    },
  });

  // ── Background service for DB lifecycle ──
  api.registerService({
    id: 'witness-db',
    start: () => api.logger?.info?.('[witness] Audit store ready'),
    stop: () => {
      store.close();
      api.logger?.info?.('[witness] Audit store closed');
    },
  });

  // ── Gateway RPC for external queries ──
  api.registerGatewayMethod('witness.recent', ({ respond, params }: any) => {
    const limit = params?.limit ?? 20;
    respond(true, store.recent(limit));
  });
  
  api.registerGatewayMethod('witness.stats', ({ respond }: any) => {
    respond(true, store.stats());
  });
  
  api.registerGatewayMethod('witness.verify', ({ respond }: any) => {
    respond(true, store.verify());
  });
}

function summarize(result: unknown, error?: string): string | undefined {
  if (error) return `ERROR: ${error}`.slice(0, 1024);
  if (result === undefined) return undefined;
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  return str.slice(0, 1024);
}

function handleWitnessCommand(store: AuditStore, args: string): string {
  // Same logic as WitnessPlugin.handleCommand — moved here
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] || 'recent';
  const rest = parts.slice(1).join(' ');
  
  switch (sub) {
    case 'recent': case '': return formatRecent(store, parseInt(rest) || 20);
    case 'search': return formatSearch(store, rest);
    case 'stats': return formatStats(store);
    case 'verify': return formatVerify(store);
    case 'help': return formatHelp();
    default: return `Unknown: ${sub}\n${formatHelp()}`;
  }
}

// ... format functions (same as current WitnessPlugin methods)
```

---

## 4. Data Directory Convention

**Decision: `~/.openclaw/witness/`**

Rationale:
- OpenClaw plugins store data under `~/.openclaw/` (the runtime root)
- Plugin-specific data goes in `~/.openclaw/<plugin-id>/`
- `witness.db` lives at `~/.openclaw/witness/witness.db`
- This survives workspace changes, gateway restarts, and plugin updates

Layout:
```
~/.openclaw/witness/
├── witness.db          # Main audit database (SQLite WAL mode)
└── exports/            # Phase 2: JSONL exports
```

**Config override:** Users can set `plugins.entries.witness.config.dbPath` to any path.

---

## 5. Event Loop Design

### Phase 1 Flow (Audit-Only)

```
Agent calls tool
       ↓
OpenClaw executes tool
       ↓
tool_result_persist hook fires
       ↓
Witness intercepts (synchronous):
  1. Assess risk (tool name → level)
  2. Compute hash chain (SHA-256)
  3. INSERT INTO events (SQLite WAL, ~0.1ms)
  4. Return undefined (don't modify result)
       ↓
OpenClaw persists to transcript (unmodified)
```

**Performance characteristics:**
- Hash computation: ~0.02ms (SHA-256 is fast)
- SQLite WAL write: ~0.05-0.2ms
- Total overhead per tool call: <0.5ms
- The `tool_result_persist` hook is synchronous — we MUST be fast

### Phase 2 Flow (Gating) — Preview

```
Agent calls tool
       ↓
[NEW] before_tool_call hook fires
       ↓
Witness intercepts:
  1. Assess risk
  2. Check mode (gate-writes? gate-all?)
  3. If risk ≥ threshold:
     a. Create work_order (status: pending)
     b. Post approval request to chat channel
     c. BLOCK the tool call (return { blocked: true, ... })
       ↓
[BLOCKED] Tool not executed. Agent told: "Awaiting approval."
       ↓
Human: /approve <id> allow-once
       ↓
Witness resolves work order → OpenClaw re-executes tool
```

**Important:** OpenClaw doesn't seem to have a `before_tool_call` hook in the current hooks system. The hooks are: `command:*`, `agent:bootstrap`, `gateway:startup`, `message:*`, `tool_result_persist`.

**Phase 2 approach options:**
1. **Plugin tool interception** — Register a plugin that wraps/modifies the tool dispatch. Need to investigate if `api` exposes tool middleware.
2. **Exec approvals extension** — Extend the existing exec-approvals pattern. It already has `before` gating for `exec` tool. Could we generalize it?
3. **Custom tool** — Register a `witness_gate` tool that the agent must call before sensitive operations. (Ugly, requires agent cooperation.)
4. **Contribute upstream** — Add `before_tool_call` hook to OpenClaw's hook system. This is the cleanest path and could be our first OSS contribution.

**Recommendation:** Option 4 (contribute upstream) as primary, Option 2 (extend exec-approvals) as fallback. This becomes a Session 7-8 planning item.

---

## 6. Installation Path

### For Users

```bash
# Option A: npm install
openclaw plugins install openclaw-witness

# Option B: local install (during development)
openclaw plugins install -l ~/clawd/projects/new-claw/witness

# Option C: manual (workspace extensions)
cp -r witness/ ~/.openclaw/extensions/witness/
```

### Config After Install

```json5
{
  plugins: {
    entries: {
      witness: {
        enabled: true,
        config: {
          mode: "audit",          // Phase 1 default
          riskOverrides: {
            "exec": "critical",   // Upgrade exec to critical
          }
        }
      }
    }
  }
}
```

### Gateway Restart

```bash
openclaw gateway restart
```

---

## 7. SKILL.md Design (Agent Instructions)

```markdown
---
name: witness
description: "Query and manage the Witness audit trail"
---

# Witness — Audit Trail

Witness records every tool call you make into a tamper-evident audit log.

## Commands (auto-reply, no AI needed)

- `/witness` — Show 20 most recent events
- `/witness recent 50` — Show 50 most recent
- `/witness search <query>` — Search by tool name, params, or result
- `/witness stats` — Aggregate statistics (total events, risk breakdown, costs)
- `/witness verify` — Verify hash chain integrity (detect tampering)
- `/witness help` — Command reference

## When to Use

- User asks "what did you do?" → `/witness recent`
- User asks about specific tool usage → `/witness search exec`
- Security audit → `/witness verify`
- Cost review → `/witness stats`

## What Gets Logged

Every tool call is logged with:
- Tool name, parameters, result (truncated to 1KB)
- Risk level (low/medium/high/critical)
- Hash chain (tamper-evident, each event links to previous)
- Session key, agent ID, channel, timestamp, duration
```

---

## 8. Refactoring Plan: Session 5 Code → Plugin API

| Current (Session 5) | Target (Plugin API) | Change |
|---------------------|---------------------|--------|
| `WitnessPlugin` class | `register(api)` function | Class → function export. OpenClaw plugins export a function, not a class. |
| `afterToolCall()` method | `api.registerHook('tool_result_persist', ...)` | Method → hook registration |
| `handleCommand()` method | `api.registerCommand({ name: 'witness', ... })` | Method → auto-reply command |
| Constructor creates DB | `api.registerService({ start, stop })` | Lifecycle managed by plugin service |
| `this.config` | `api.config` | Config comes from OpenClaw's config system |
| `this.store` | Module-level `store` | Shared across all registrations |
| No manifest | `openclaw.plugin.json` | New file required |
| No skill | `skills/witness/SKILL.md` | New file for agent awareness |

### What Stays the Same
- `store.ts` — No changes needed. AuditStore is pure SQLite, no OpenClaw deps.
- `hash.ts` — No changes needed. Pure crypto.
- `risk.ts` — No changes needed. Pure mapping.
- `types.ts` — Minor additions (add plugin API types).
- `schema.sql` — No changes.
- `test/store.test.ts` — No changes (tests the store, not the plugin layer).

---

## 9. Open Questions Resolved

| Question (from Session 5) | Answer |
|---------------------------|--------|
| How does a plugin register? | Export a function: `(api) => { ... }`. Manifest: `openclaw.plugin.json`. |
| Where does witness.db live? | `~/.openclaw/witness/witness.db` (or configurable via plugin config). |
| How to expose /witness command? | `api.registerCommand({ name: 'witness', ... })` — auto-reply, no AI needed. |
| Re-execution after approval? | Defer to Phase 2. Existing exec-approvals has a pattern. May contribute `before_tool_call` hook upstream. |
| Testing strategy? | Vitest with in-memory SQLite (`:memory:` path to better-sqlite3). |

## 10. New Open Questions for Sessions 7-10

1. **`tool_result_persist` hook shape** — What exactly does the event object look like? Need to inspect OpenClaw source or test with a dummy plugin. (Session 7)
2. **`before_tool_call` hook gap** — Is this the right place for our Phase 2 gating, or should we extend exec-approvals? (Session 7)
3. **HITL work order UI** — Exactly how do approval requests render in Discord? What components? (Session 8)
4. **SQLite WAL concurrency** — If multiple agents run simultaneously, do we get WAL lock contention? (Session 9)
5. **Plugin data directory API** — Does `api.runtime.dataDir` exist? If not, what's the convention? (Session 7, testable)

---

## Summary

Session 6 delivered a **complete integration architecture** for Witness as an OpenClaw plugin:

1. **Plugin structure** — manifest, entry point, service lifecycle, command registration
2. **Data convention** — `~/.openclaw/witness/witness.db`
3. **Event loop** — `tool_result_persist` hook for Phase 1 (synchronous, <0.5ms overhead)
4. **Phase 2 preview** — Existing exec-approvals pattern can be extended; may contribute `before_tool_call` upstream
5. **Refactoring plan** — Clear mapping from Session 5 class-based code to plugin function API
6. **Installation path** — npm, local link, or manual copy
7. **SKILL.md** — Agent instructions for `/witness` commands

**Code changes needed:** Rewrite `src/index.ts` and `src/plugin.ts` → single `src/index.ts` using `register(api)` pattern. Add `openclaw.plugin.json` and `skills/witness/SKILL.md`. Everything else stays.

---

*Session duration: ~25 min*
*Phase status: PLAN session 1 of 5. Next: Session 7 — HITL work order system design.*
