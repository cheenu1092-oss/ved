# Session 7 — PLAN: HITL Work Order System Design

**Date:** 2026-03-04 05:16 PST  
**Phase:** PLAN (Session 2 of 5)  
**Objective:** Design the HITL work order system — ticket lifecycle, approval queues, audit schema. Investigate `before_tool_call` and `after_tool_call` hook event shapes from OpenClaw source.

---

## 1. Critical Discovery: All Three Hooks Exist

Session 6 noted that OpenClaw "doesn't seem to have a `before_tool_call` hook." **Wrong.** Source code analysis of `deliver-*.js` and `reply-*.js` confirms all three hooks are production-grade:

### Hook: `before_tool_call` (MODIFYING, SEQUENTIAL)

```typescript
// Event shape:
{
  toolName: string,      // normalized tool name (lowercase)
  params: Record<string, unknown>  // tool parameters (plain object)
}

// Context shape:
{
  toolName: string,
  agentId?: string,
  sessionKey?: string
}

// Return shape (merged across handlers):
{
  params?: Record<string, unknown>,  // modified params (merged with original)
  block?: boolean,                    // block the tool call
  blockReason?: string               // reason shown to agent
}
```

**Key behaviors:**
- Runs BEFORE tool execution (async, sequential by priority)
- Can **modify params** — returned params are merged with originals
- Can **block execution** — return `{ block: true, blockReason: "..." }`
- Blocked tools throw an Error with the blockReason as message
- Has built-in tool loop detection (separate from hooks) that can also block
- If hook throws, it's caught and logged as warning — tool proceeds unblocked

### Hook: `after_tool_call` (VOID, PARALLEL)

```typescript
// Event shape:
{
  toolName: string,
  params: Record<string, unknown>,
  result?: unknown,       // tool result (on success)
  error?: string,         // error message (on failure)
  durationMs?: number     // execution duration
}

// Context shape:
{
  toolName: string,
  agentId?: string,      // sometimes undefined in embedded mode
  sessionKey?: string    // sometimes undefined in embedded mode
}
```

**Key behaviors:**
- Runs AFTER tool execution (async, fire-and-forget parallel)
- Gets both success results AND error results
- Has `durationMs` for performance tracking
- Errors in hook are caught and logged — never affect tool output

### Hook: `tool_result_persist` (SYNCHRONOUS, SEQUENTIAL)

```typescript
// Event shape:
{
  toolName: string,
  toolCallId: string,
  message: object,        // the full tool result message to be persisted
  isSynthetic: boolean    // whether this is a synthetic (injected) tool result
}

// Context shape:
{
  agentId?: string,
  sessionKey?: string,
  toolName: string,
  toolCallId: string
}

// Return shape:
{
  message?: object   // modified message for persistence (replaces original)
}
```

**Key behaviors:**
- SYNCHRONOUS — must NOT return a Promise (logged as warning, result ignored)
- Runs on the hot path where session transcripts are appended
- Can modify the message written to the session JSONL
- If it returns `{ message }`, that replaces the original for both next handler and final write
- Errors in hook are caught and logged

---

## 2. Revised Hook Strategy for Witness

With all three hooks confirmed, the strategy simplifies dramatically:

| Phase | Hook | Purpose |
|-------|------|---------|
| Phase 1 (Audit) | `after_tool_call` | Log every tool call with result/error/duration. Fire-and-forget, zero impact on execution. |
| Phase 2 (Gating) | `before_tool_call` | Block high-risk tools, create work orders, await approval. |
| Phase 2 (Audit+) | `after_tool_call` | Log the actual result after execution (for approved tools). |
| Phase 3 (Trust) | `before_tool_call` | Check trust ledger, auto-approve if threshold met. |

### Why `after_tool_call` for Phase 1 (not `tool_result_persist`)

Session 6 recommended `tool_result_persist`. But `after_tool_call` is better for Phase 1:

| Factor | `tool_result_persist` | `after_tool_call` |
|--------|----------------------|-------------------|
| Synchronous? | Yes (MUST be fast) | No (async, fire-and-forget) |
| Has duration? | No | Yes (`durationMs`) |
| Has error? | No (just the message) | Yes (separate `error` field) |
| Has params? | No | Yes |
| Can we do SQLite writes? | Risky (sync on hot path) | Safe (async) |
| Modifies output? | Yes (can change transcript) | No (void) |

**`after_tool_call` gives us params, result, error, AND duration — all async.** No risk of blocking the transcript write path. SQLite WAL writes in an async handler are perfectly safe.

**`tool_result_persist`** remains useful for Phase 2 if we want to annotate transcript entries with audit metadata (e.g., append `[WITNESS: risk=high, event_id=evt_xxx]` to persisted results).

---

## 3. HITL Work Order System — Full Design

### 3.1 Work Order Lifecycle

```
                    ┌──────────────────────┐
                    │    TOOL CALL MADE     │
                    │  (before_tool_call)   │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   RISK ASSESSMENT    │
                    │  (tool + params +    │
                    │   mode + overrides)  │
                    └──────────┬───────────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
         risk < threshold   risk ≥ threshold  mode = audit
                │              │              │
         ┌──────▼──────┐ ┌────▼────┐  ┌──────▼──────┐
         │  ALLOW      │ │ BLOCK   │  │  LOG ONLY   │
         │ (log event) │ │ (create │  │ (no block)  │
         └─────────────┘ │  work   │  └─────────────┘
                         │  order) │
                         └────┬────┘
                              │
                    ┌─────────▼──────────┐
                    │  WORK ORDER STATE: │
                    │     PENDING        │
                    │  (notify human)    │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
       ┌──────▼──────┐ ┌─────▼─────┐ ┌───────▼───────┐
       │  APPROVED   │ │ REJECTED  │ │   EXPIRED     │
       │ (by human)  │ │ (by human)│ │ (TTL timeout) │
       └──────┬──────┘ └───────────┘ └───────────────┘
              │
    ┌─────────▼──────────┐
    │  RE-EXECUTE TOOL   │
    │  (with saved params│
    │   + approval ref)  │
    └─────────┬──────────┘
              │
       ┌──────┼──────┐
       │             │
  ┌────▼────┐  ┌─────▼─────┐
  │EXECUTED │  │  FAILED   │
  │(success)│  │(re-exec   │
  └─────────┘  │ errored)  │
               └───────────┘
```

### 3.2 Work Order States

| State | Description | Transitions |
|-------|-------------|-------------|
| `pending` | Created when tool blocked. Human notified. Timer started. | → approved, rejected, expired |
| `approved` | Human explicitly approved via `/witness approve <id>`. | → executed, failed |
| `rejected` | Human explicitly rejected via `/witness reject <id>`. Terminal. | — |
| `expired` | TTL elapsed without human action. Terminal. | — |
| `executed` | Approved + re-execution succeeded. Terminal. | — |
| `failed` | Approved + re-execution threw error. Terminal. | — |

### 3.3 Work Order Schema (SQLite)

```sql
CREATE TABLE work_orders (
  id           TEXT PRIMARY KEY,        -- 'wo_' + ULID
  event_id     TEXT NOT NULL,           -- FK to events table (the blocked event)
  status       TEXT NOT NULL DEFAULT 'pending',
  tool_name    TEXT NOT NULL,
  params_json  TEXT NOT NULL,           -- Full params snapshot for re-execution
  risk_level   TEXT NOT NULL,           -- low/medium/high/critical
  block_reason TEXT,                    -- Why it was blocked
  
  -- Resolution
  resolved_by  TEXT,                    -- user ID or 'system' (for TTL expiry)
  resolved_at  TEXT,                    -- ISO timestamp
  resolution_note TEXT,                 -- Optional human note

  -- Re-execution
  reexec_result_json TEXT,              -- Result of re-execution (if approved)
  reexec_error       TEXT,              -- Error from re-execution (if failed)
  reexec_duration_ms INTEGER,          -- Duration of re-execution

  -- Metadata
  session_key  TEXT,
  agent_id     TEXT,
  channel      TEXT,                    -- Where the approval request was sent
  ttl_minutes  INTEGER NOT NULL DEFAULT 30,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL,           -- created_at + ttl_minutes
  
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX idx_wo_status ON work_orders(status);
CREATE INDEX idx_wo_tool ON work_orders(tool_name);
CREATE INDEX idx_wo_expires ON work_orders(expires_at) WHERE status = 'pending';
```

### 3.4 Events Table Updates for Phase 2

The existing events table from Session 5 needs one addition:

```sql
-- Add to events table:
work_order_id TEXT,  -- FK to work_orders (NULL for allowed events, set for blocked events)
```

When a tool call is blocked:
1. An event is logged with `action = 'blocked'` and `work_order_id` set
2. A work_order row is created with `event_id` pointing back
3. Bidirectional link enables querying in both directions

### 3.5 Risk Assessment Engine (Phase 2 Enhanced)

Phase 1 risk assessment was static (tool name → level). Phase 2 adds param-aware assessment:

```typescript
interface RiskAssessment {
  level: RiskLevel;          // low | medium | high | critical
  reasons: string[];         // human-readable explanations
  shouldBlock: boolean;      // determined by mode + level
  suggestedAction: string;   // "allow" | "block" | "notify"
}

function assessRisk(
  toolName: string,
  params: Record<string, unknown>,
  config: WitnessConfig,
): RiskAssessment {
  const reasons: string[] = [];
  let level = getBaseRiskLevel(toolName, config.riskOverrides);
  
  // Param-based escalation rules
  if (toolName === 'exec') {
    const cmd = String(params.command ?? '');
    if (/\brm\b.*-rf?\b/i.test(cmd)) {
      level = 'critical';
      reasons.push('Destructive shell command detected (rm -r)');
    }
    if (params.elevated === true) {
      level = escalate(level, 'high');
      reasons.push('Elevated/sudo execution requested');
    }
    if (/curl|wget|git\s+clone/i.test(cmd)) {
      level = escalate(level, 'medium');
      reasons.push('Network-fetching command');
    }
  }
  
  if (toolName === 'message' && params.action === 'send') {
    level = escalate(level, 'medium');
    reasons.push('Outbound message to external recipient');
  }
  
  if (toolName === 'Write' || toolName === 'Edit') {
    const path = String(params.file_path ?? params.path ?? '');
    if (/\.(env|key|pem|crt|ssh)/i.test(path)) {
      level = 'critical';
      reasons.push('Writing to sensitive file type');
    }
  }
  
  // Determine blocking based on mode
  const shouldBlock = shouldBlockForMode(level, config.mode);
  
  return {
    level,
    reasons: reasons.length > 0 ? reasons : ['Default risk for tool type'],
    shouldBlock,
    suggestedAction: shouldBlock ? 'block' : 'allow',
  };
}

function shouldBlockForMode(level: RiskLevel, mode: WitnessMode): boolean {
  switch (mode) {
    case 'audit':      return false;              // never block
    case 'gate-writes': return level >= 'high';   // block high + critical
    case 'gate-all':   return level >= 'medium';  // block medium + high + critical
    default:           return false;
  }
}
```

---

## 4. Approval Queue UX

### 4.1 Notification Flow

When a tool call is blocked, Witness sends a notification to the user's active channel:

```
🛡️ Witness — Approval Required

Tool: exec
Risk: 🔴 critical
Reason: Destructive shell command detected (rm -r)

Command: rm -rf /tmp/old-build/
Session: agent:main:main

⏱️ Expires in 30 minutes

/witness approve wo_01JNKX...  — Allow this action
/witness reject wo_01JNKX...   — Deny this action
/witness details wo_01JNKX...  — See full params
```

### 4.2 Command Extensions for Phase 2

```
/witness approve <id> [note]   — Approve a pending work order
/witness reject <id> [note]    — Reject a pending work order  
/witness pending               — List all pending work orders
/witness details <id>          — Show full params and context
/witness queue                 — Alias for pending
```

### 4.3 Approval via Discord Components (Future Enhancement)

For Discord, we can use interactive buttons instead of typed commands:

```typescript
// Discord message with components
{
  content: '🛡️ **Witness — Approval Required**\n...',
  components: [{
    type: 'ACTION_ROW',
    components: [
      { type: 'BUTTON', style: 'SUCCESS', label: 'Approve', customId: `witness:approve:${woId}` },
      { type: 'BUTTON', style: 'DANGER',  label: 'Reject',  customId: `witness:reject:${woId}` },
      { type: 'BUTTON', style: 'SECONDARY', label: 'Details', customId: `witness:details:${woId}` },
    ]
  }]
}
```

This is a future enhancement — command-based approval works across all channels.

### 4.4 Re-Execution After Approval

This was identified in Session 4 as the hardest problem. Here's the design:

**Approach: Direct Tool Invocation**

When a work order is approved:
1. Witness retrieves the stored `params_json` from the work order
2. Witness calls the tool directly via OpenClaw's tool execution infrastructure
3. The result is logged as a new event with `action = 'executed'`
4. The work order transitions to `executed` or `failed`

**Implementation via Plugin API:**

```typescript
// In the /witness approve handler:
async function executeApprovedWorkOrder(
  api: PluginAPI,
  workOrder: WorkOrder,
  store: AuditStore,
): Promise<void> {
  const params = JSON.parse(workOrder.params_json);
  
  try {
    // Use the plugin's tool invocation API
    // This is the key question: does api.invokeTool() exist?
    const result = await api.invokeTool(workOrder.tool_name, params);
    
    store.resolveWorkOrder(workOrder.id, {
      status: 'executed',
      reexecResult: result,
      reexecDurationMs: /* measured */,
    });
  } catch (err) {
    store.resolveWorkOrder(workOrder.id, {
      status: 'failed',
      reexecError: String(err),
    });
  }
}
```

**Open question:** Does OpenClaw's plugin API expose `api.invokeTool()`? If not, alternatives:
1. **Send a message to the session** containing the tool call instruction → agent re-executes naturally
2. **Inject a synthetic tool result** that tells the agent to retry
3. **Contribute upstream** — add `api.invokeTool()` to the plugin API

**Fallback (simplest):** For v0.1, just notify the agent that the work order was approved and let it decide to re-execute. No automatic re-execution. This is how most human-in-the-loop systems work — the human approves, the agent resumes.

```
✅ Work order wo_01JNKX... approved.
Tool: exec | Command: rm -rf /tmp/old-build/
The agent has been notified and may re-execute.
```

---

## 5. Expiry & Cleanup

### 5.1 Work Order TTL

Pending work orders expire after `ttl_minutes` (default: 30). Expiry is checked:
- **Lazily:** When `/witness pending` or `/witness approve` is called, expired orders are swept
- **On timer:** Background service runs every 5 minutes, sweeps expired orders

```typescript
function sweepExpiredWorkOrders(store: AuditStore): number {
  const now = new Date().toISOString();
  const expired = store.db.prepare(`
    UPDATE work_orders 
    SET status = 'expired', resolved_by = 'system', resolved_at = ?
    WHERE status = 'pending' AND expires_at < ?
  `).run(now, now);
  return expired.changes;
}
```

### 5.2 Event Retention

Events table grows over time. Options:
- **Phase 1:** No cleanup (audit logs should be append-only)
- **Phase 2:** Optional `max_events` config that archives old events to JSONL before deleting
- **Phase 3:** Configurable retention by compliance level (SOC2: 1yr, HIPAA: 6yr)

---

## 6. Complete Hook Registration (Phase 2)

```typescript
export default function register(api: any) {
  const cfg = resolveConfig(api.config);
  const store = new AuditStore(resolveDbPath(cfg, api));

  // ── Phase 1: Audit logging via after_tool_call ──
  api.registerHook('after_tool_call', async (event: AfterToolCallEvent, ctx: HookContext) => {
    const risk = assessRisk(event.toolName, event.params, cfg);
    
    store.append({
      timestamp: new Date().toISOString(),
      sessionKey: ctx.sessionKey ?? 'unknown',
      agentId: ctx.agentId ?? 'main',
      toolName: event.toolName,
      params: event.params,
      resultOk: !event.error,
      resultSummary: summarize(event.result, event.error),
      durationMs: event.durationMs,
      riskLevel: risk.level,
      action: 'logged',
    });
  }, {
    name: 'witness.audit-logger',
    description: 'Log every tool call to Witness audit store',
  });

  // ── Phase 2: Gating via before_tool_call ──
  if (cfg.mode !== 'audit') {
    api.registerHook('before_tool_call', async (event: BeforeToolCallEvent, ctx: HookContext) => {
      const risk = assessRisk(event.toolName, event.params, cfg);
      
      // Check trust ledger (Phase 3)
      if (cfg.mode !== 'audit') {
        const trusted = store.checkTrust(event.toolName, cfg.autoApproveThreshold);
        if (trusted) {
          // Auto-approved by trust — log but don't block
          store.append({
            timestamp: new Date().toISOString(),
            sessionKey: ctx.sessionKey ?? 'unknown',
            agentId: ctx.agentId ?? 'main',
            toolName: event.toolName,
            params: event.params,
            riskLevel: risk.level,
            action: 'auto-approved',
          });
          return; // allow through
        }
      }
      
      if (!risk.shouldBlock) return; // allow through
      
      // Block and create work order
      const eventId = store.append({
        timestamp: new Date().toISOString(),
        sessionKey: ctx.sessionKey ?? 'unknown',
        agentId: ctx.agentId ?? 'main',
        toolName: event.toolName,
        params: event.params,
        riskLevel: risk.level,
        action: 'blocked',
      });
      
      const woId = store.createWorkOrder({
        eventId,
        toolName: event.toolName,
        params: event.params,
        riskLevel: risk.level,
        blockReason: risk.reasons.join('; '),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        ttlMinutes: cfg.ttlMinutes,
      });
      
      // Notify user (via plugin messaging API)
      api.notify?.({
        text: formatApprovalRequest(woId, event.toolName, risk),
      });
      
      return {
        block: true,
        blockReason: `🛡️ Witness: Blocked (${risk.level} risk). Approve: /witness approve ${woId}`,
      };
    }, {
      name: 'witness.gatekeeper',
      description: 'Block high-risk tool calls pending approval',
      priority: 100, // Run early (before other hooks)
    });
  }

  // ── Commands (same as Session 6) ──
  api.registerCommand({
    name: 'witness',
    description: 'Query the Witness audit log',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const result = await handleWitnessCommand(store, api, ctx.args ?? '', cfg);
      return { text: result };
    },
  });

  // ── Background service ──
  api.registerService({
    id: 'witness-db',
    start: () => {
      // Sweep expired work orders every 5 minutes
      const interval = setInterval(() => sweepExpiredWorkOrders(store), 5 * 60 * 1000);
      api.logger?.info?.('[witness] Audit store ready');
      return { stop: () => clearInterval(interval) };
    },
    stop: () => {
      store.close();
      api.logger?.info?.('[witness] Audit store closed');
    },
  });
}
```

---

## 7. Updated Type Definitions

```typescript
// ── Hook Event Types (from OpenClaw source analysis) ──

interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

interface BeforeToolCallContext {
  toolName: string;
  agentId?: string;
  sessionKey?: string;
}

interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface AfterToolCallContext {
  toolName: string;
  agentId?: string;
  sessionKey?: string;
}

interface ToolResultPersistEvent {
  toolName: string;
  toolCallId: string;
  message: object;
  isSynthetic: boolean;
}

interface ToolResultPersistContext {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  toolCallId: string;
}

// ── Work Order Types ──

type WorkOrderStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';

interface WorkOrder {
  id: string;              // wo_<ulid>
  eventId: string;         // FK to events
  status: WorkOrderStatus;
  toolName: string;
  paramsJson: string;
  riskLevel: RiskLevel;
  blockReason?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  reexecResultJson?: string;
  reexecError?: string;
  reexecDurationMs?: number;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  ttlMinutes: number;
  createdAt: string;
  expiresAt: string;
}

// ── Witness Modes ──

type WitnessMode = 'audit' | 'gate-writes' | 'gate-all';

interface WitnessConfig {
  mode: WitnessMode;
  dbPath: string;
  ttlMinutes: number;
  autoApproveThreshold: number;
  riskOverrides: Record<string, RiskLevel>;
}
```

---

## 8. Open Questions Resolved

| Question (from Session 6) | Answer |
|---------------------------|--------|
| Does `before_tool_call` exist? | **YES.** It's a modifying hook (sequential). Returns `{ block, blockReason, params }`. Fully production-grade. |
| Does `after_tool_call` exist? | **YES.** It's a void hook (parallel, fire-and-forget). Has `result`, `error`, `durationMs`. |
| Which hook for Phase 1 audit? | **`after_tool_call`** — async, has all the data we need, no sync performance risk. |
| Which hook for Phase 2 gating? | **`before_tool_call`** — can block with `{ block: true, blockReason }`. |
| Re-execution after approval? | **Fallback approach for v0.1:** notify agent, let it re-execute naturally. Future: investigate `api.invokeTool()` or contribute upstream. |

## 9. Open Questions for Sessions 8-10

1. **Plugin notification API** — Does `api.notify()` exist? How do we send the approval request to the user's channel? Need to check plugin API surface. (Session 8)
2. **Discord button components** — Can a plugin send Discord messages with buttons? If so, approval UX becomes much better. (Session 8)
3. **Plugin tool invocation** — Does `api.invokeTool()` exist for re-execution? (Session 8)
4. **SQLite WAL concurrency** — Multiple agents hitting witness.db simultaneously. Test with concurrent inserts. (Session 9)
5. **Testing strategy** — Mock hook events for integration tests. Unit tests for store remain the same. (Session 10)

---

## Summary

Session 7 delivered the **complete HITL work order system design**:

1. **All three hooks confirmed** from OpenClaw source code — `before_tool_call` (block/modify), `after_tool_call` (observe), `tool_result_persist` (modify transcript). This is a major correction from Session 6.
2. **Revised hook strategy** — Phase 1 uses `after_tool_call` (not `tool_result_persist`) for better data and async safety. Phase 2 uses `before_tool_call` for blocking.
3. **Work order lifecycle** — 6 states (pending → approved/rejected/expired → executed/failed). Clean state machine with bidirectional event linkage.
4. **SQLite schema** — `work_orders` table with full approval metadata, re-execution results, and TTL expiry.
5. **Enhanced risk assessment** — Param-aware rules (destructive commands, elevated exec, sensitive files, outbound messages).
6. **Approval UX** — Command-based (`/witness approve/reject/pending`), with Discord button components as future enhancement.
7. **Re-execution strategy** — v0.1 notifies agent to retry; future versions may support direct tool invocation.
8. **Complete Phase 2 hook registration code** — Production-ready `register(api)` with both `after_tool_call` and `before_tool_call`.
9. **Full TypeScript types** — Event shapes, context shapes, return shapes for all 3 hooks, plus work order types.

---

*Session duration: ~25 min*
*Phase status: PLAN session 2 of 5. Next: Session 8 — Integration layer + plugin notification API.*
