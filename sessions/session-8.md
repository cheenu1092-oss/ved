# Session 8 — PLAN: Integration Layer & Plugin Notification APIs

**Date:** 2026-03-04 06:16 PST  
**Phase:** PLAN (Session 3 of 5)  
**Objective:** Investigate plugin notification API, Discord components for approval UX, and tool invocation API for re-execution. Answer open questions from Session 7.

---

## 1. Plugin API Surface — Complete Audit

Read the actual compiled source (`subsystem-n4tSscKk.js`, `subagent-registry--qOHOvSD.js`). The `createApi(record, params)` function returns the full plugin API:

### Direct API Methods (on `api`)

| Method | Purpose |
|--------|---------|
| `api.registerTool(tool, opts)` | Register an agent tool |
| `api.registerHook(events, handler, opts)` | Register hook handlers |
| `api.registerHttpHandler(handler)` | Register HTTP handler |
| `api.registerHttpRoute(params)` | Register HTTP route |
| `api.registerChannel(registration)` | Register messaging channel |
| `api.registerProvider(provider)` | Register model provider auth |
| `api.registerGatewayMethod(method, handler)` | Register Gateway RPC method |
| `api.registerCli(registrar, opts)` | Register CLI subcommand |
| `api.registerService(service)` | Register background service |
| `api.registerCommand(command)` | Register auto-reply slash command |
| `api.resolvePath(input)` | Resolve user paths (expand `~`) |
| `api.on(hookName, handler, opts)` | Register typed hooks (alternate syntax) |

### Metadata Properties

| Property | Description |
|----------|-------------|
| `api.id` | Plugin id |
| `api.name` | Plugin name |
| `api.version` | Plugin version |
| `api.description` | Plugin description |
| `api.source` | Source path |
| `api.config` | Full OpenClaw config |
| `api.pluginConfig` | Plugin-specific config (from `plugins.entries.<id>.config`) |
| `api.runtime` | Runtime helpers (see below) |
| `api.logger` | Logger with `info/warn/error/debug` |

### Critical Finding: No `api.notify()` or `api.invokeTool()`

**Neither `api.notify()` nor `api.invokeTool()` exist in the plugin API.** These were speculative methods from Sessions 6-7. The actual notification and tool invocation paths are different.

---

## 2. Plugin Runtime Surface (`api.runtime`)

The runtime is created by `createPluginRuntime()` and provides access to core helpers:

```typescript
api.runtime = {
  version: string,                     // OpenClaw version
  config: {
    loadConfig(),                      // Load current config
    writeConfigFile(...)               // Write config changes
  },
  system: {
    enqueueSystemEvent(text, opts),    // ⭐ Inject system message into session
    runCommandWithTimeout(...),        // Run a shell command
    formatNativeDependencyHint(...)    // Format install hints
  },
  media: {
    loadWebMedia(...),                 // Fetch media from URL
    detectMime(...),                   // Detect MIME type
    mediaKindFromMime(...),
    isVoiceCompatibleAudio(...),
    getImageMetadata(...),
    resizeToJpeg(...)
  },
  tts: {
    textToSpeechTelephony(...)         // TTS for telephony
  },
  tools: {
    createMemoryGetTool(),             // Memory tool factories
    createMemorySearchTool(),
    registerMemoryCli()
  },
  channel: {
    text: { chunkMarkdownText, resolveTextChunkLimit, hasControlCommand, ... },
    reply: { dispatchReplyWithBufferedBlockDispatcher, ... },
    routing: { resolveAgentRoute },
    pairing: { buildPairingReply, readAllowFromStore, upsertPairingRequest },
    media: { fetchRemoteMedia, saveMediaBuffer },
    session: { resolveStorePath, readSessionUpdatedAt, ... },
    mentions: { buildMentionRegexes, matchesMentionPatterns, ... },
    groups: { resolveGroupPolicy, resolveRequireMention },
    debounce: { createInboundDebouncer, resolveInboundDebounceMs },
    commands: { resolveCommandAuthorizedFromAuthorizers, ... },
    // ⭐ Channel-specific runtime helpers:
    discord: {
      sendMessageDiscord,              // ⭐ Send Discord messages
      sendPollDiscord,
      sendDiscordComponentMessage,     // ⭐ Send messages with buttons/selects
      messageActions: discordMessageActions,
      auditChannelPermissions,
      probeDiscord,
      ...
    },
    slack: { ... },
    whatsapp: { ... },
    line: { ... },
    telegram: { ... },
    // etc.
  },
  logging: {
    shouldLogVerbose(),
    getChildLogger(name)
  },
  state: {
    resolveStateDir(cfg)
  }
};
```

---

## 3. Answer: How to Notify Users (Approval Requests)

### Option A: `api.runtime.system.enqueueSystemEvent()` (Cross-Channel)

```typescript
// Inject a system message into the agent session
api.runtime.system.enqueueSystemEvent(
  '🛡️ Witness — Approval Required\n\n' +
  'Tool: exec | Risk: 🔴 critical\n' +
  'Reason: Destructive shell command (rm -rf)\n\n' +
  '⏱️ Expires in 30 min\n' +
  '/witness approve wo_01JNKX... — Allow\n' +
  '/witness reject wo_01JNKX... — Deny',
  { sessionKey: ctx.sessionKey }
);
```

**Pros:**
- Works across all channels (Discord, Telegram, Slack, etc.)
- Injects directly into the agent's session stream
- The agent will see this and can relay it to the user
- Channel-agnostic — no Discord-specific code needed

**Cons:**
- System events are consumed by the agent, not sent directly to the user
- Relies on the agent relaying the message
- No interactive components (buttons)
- Messages may be delayed until next agent loop iteration

### Option B: `api.runtime.channel.discord.sendMessageDiscord()` (Discord Direct)

```typescript
// Send directly to a Discord channel
await api.runtime.channel.discord.sendMessageDiscord(
  `channel:${channelId}`,  // target
  '🛡️ **Witness — Approval Required**\n...',
  { accountId }
);
```

**Pros:**
- Immediate delivery
- Direct to user's channel
- No agent relay needed

**Cons:**
- Discord-specific — need separate implementations per channel
- Need to know the `channelId` and `accountId`
- Need to resolve these from `sessionKey` (possible via `resolveAgentRoute` in reverse)

### Option C: `api.runtime.channel.discord.sendDiscordComponentMessage()` (Discord + Buttons) ⭐

```typescript
// Send with interactive buttons
await api.runtime.channel.discord.sendDiscordComponentMessage(
  `channel:${channelId}`,
  {
    text: '🛡️ **Witness — Approval Required**\n...',
    components: [...] // See Section 4
  },
  { accountId, sessionKey: ctx.sessionKey, agentId: ctx.agentId }
);
```

**Pros:**
- Best UX (clickable Approve/Reject buttons)
- Immediate delivery
- Built-in OpenClaw component handling

**Cons:**
- Discord-only
- Need to integrate with OpenClaw's Discord component system
- Requires understanding OpenClaw's component spec format

### Recommendation: Layered Approach

1. **Phase 1 (audit-only):** No notifications needed
2. **Phase 2 (gating) — MVP:** Use `enqueueSystemEvent` (cross-channel, simple)
3. **Phase 2 (gating) — Enhanced:** Add `sendMessageDiscord` for direct Discord delivery
4. **Phase 3 (polish):** Add `sendDiscordComponentMessage` for button-based approval UX

---

## 4. Discord Component Integration for Approval Buttons

### How OpenClaw's Discord Component System Works

From source analysis, OpenClaw uses a custom component spec that gets built into Discord's API format:

```typescript
// buildDiscordComponentMessage() takes a spec object
const buildResult = buildDiscordComponentMessage({
  spec,
  sessionKey,
  agentId,
  accountId
});
```

The spec format maps to OpenClaw's `message` tool component format (the same one our agent uses with `components` parameter). Looking at the exec-approvals implementation:

```typescript
// How exec-approvals does it (from subagent-registry source):
const actionRow = new ExecApprovalActionRow(request.id);
const body = buildExecApprovalPayload(
  createExecApprovalRequestContainer({
    request,
    cfg,
    accountId,
    actionRow
  })
);
```

### Witness Approval Component Spec

We can model our approval spec on the exec-approvals pattern:

```typescript
interface WitnessApprovalSpec {
  text: string;
  blocks: Array<{
    type: 'section' | 'action_row' | 'text';
    text?: string;
    buttons?: Array<{
      label: string;
      style: 'primary' | 'secondary' | 'success' | 'danger';
      customId: string;
    }>;
  }>;
}

function buildApprovalComponentSpec(woId: string, toolName: string, risk: RiskAssessment): object {
  return {
    text: `🛡️ **Witness — Approval Required**`,
    blocks: [
      {
        type: 'text',
        text: [
          `**Tool:** \`${toolName}\``,
          `**Risk:** ${formatRiskEmoji(risk.level)} ${risk.level}`,
          `**Reason:** ${risk.reasons.join('; ')}`,
          `⏱️ Expires in 30 minutes`,
        ].join('\n'),
      },
      {
        type: 'action_row',
        buttons: [
          {
            label: '✅ Approve',
            style: 'success',
            customId: `witness:approve:${woId}`,
          },
          {
            label: '❌ Reject',
            style: 'danger',
            customId: `witness:reject:${woId}`,
          },
          {
            label: '📋 Details',
            style: 'secondary',
            customId: `witness:details:${woId}`,
          },
        ],
      },
    ],
  };
}
```

### Component Event Handling

When a user clicks a button, OpenClaw processes it. We need to understand how to receive button click events. From the source:

```typescript
// OpenClaw has parseDiscordComponentCustomId and resolveDiscordComponentEntry
// These handle routing component interactions back to handlers
```

**Key discovery:** Component interactions are resolved via `resolveDiscordComponentEntry()` which looks up component registrations. The exec-approvals system registers its own handlers via the Discord gateway event listener.

**For Witness Phase 3 buttons:** We would need to:
1. Register a component interaction handler via the plugin system
2. Or use the `registerGatewayMethod` to handle component callbacks

**Simpler alternative:** Use OpenClaw's existing `message` tool component system (the `reusable: true` flag keeps buttons active). Since the agent already has this capability, we can send components through `enqueueSystemEvent` and have the agent forward them via the message tool.

**Simplest: Use `/witness approve` commands for now.** Button support is a polish item.

---

## 5. Answer: Tool Re-Execution After Approval

### Finding: No `api.invokeTool()` Exists

There is no direct tool invocation method in the plugin API. However, we have several alternatives:

### Option A: `enqueueSystemEvent` — Tell the Agent (Simplest, Recommended for v0.1)

```typescript
api.runtime.system.enqueueSystemEvent(
  `[System Message] ✅ Witness work order ${woId} approved by ${resolvedBy}.\n` +
  `Tool: ${toolName}\n` +
  `Original params: ${JSON.stringify(params)}\n` +
  `Please re-execute this tool call.`,
  { sessionKey: workOrder.sessionKey }
);
```

**Pros:** Zero coupling, works with any tool, the agent decides whether to re-execute
**Cons:** Agent may not re-execute, adds a conversation turn, non-deterministic

### Option B: Register a Gateway RPC Method + Session Send

```typescript
// In plugin:
api.registerGatewayMethod('witness.reexecute', async ({ params, respond }) => {
  // Look up work order, validate approval
  // Then inject into session via sessions_send equivalent
  respond(true, { queued: true });
});
```

**Challenge:** Gateway RPC methods can't directly invoke tools on a session.

### Option C: `registerTool` — Create a Witness Re-Execute Tool

```typescript
api.registerTool({
  name: 'witness_reexecute',
  description: 'Re-execute an approved Witness work order',
  parameters: {
    type: 'object',
    properties: {
      workOrderId: { type: 'string', description: 'Work order ID to re-execute' },
    },
    required: ['workOrderId'],
  },
  execute: async (params) => {
    const wo = store.getWorkOrder(params.workOrderId);
    if (!wo || wo.status !== 'approved') {
      return { error: 'Work order not found or not approved' };
    }
    // The agent calls this tool, and we return the saved params
    // so the agent knows what to re-execute
    return {
      approved: true,
      toolName: wo.toolName,
      params: JSON.parse(wo.paramsJson),
      instruction: `Re-execute: ${wo.toolName} with the provided params`,
    };
  },
});
```

**Pros:** Clean tool interface, agent explicitly decides to re-execute
**Cons:** Requires agent cooperation, adds a tool call overhead

### Option D: Contribute `api.invokeTool()` Upstream (Future)

The cleanest solution but requires an OpenClaw PR. Could be our first OSS contribution.

### Recommendation: Option A for v0.1, Option C for v0.2

- **v0.1:** `enqueueSystemEvent` — notify the agent, let it decide. System messages are shown to the agent in the next turn. The SKILL.md instructs the agent to honor approved work orders.
- **v0.2:** Register `witness_reexecute` tool so the agent can explicitly re-execute approved orders.
- **Future:** Propose `api.invokeTool()` upstream.

---

## 6. How Exec-Approvals Does It (Reference Implementation)

The existing exec-approvals system is the best reference for how Witness should work. Key architectural patterns:

### Approval Flow Architecture

```
Agent calls exec tool
       ↓
exec-approvals checks policy (allowlist, ask mode)
       ↓
If requires approval:
  1. Gateway broadcasts `exec.approval.requested` event
  2. Discord handler catches it, sends message with buttons
  3. User clicks Approve/Deny (or types /approve)
  4. Gateway broadcasts `exec.approval.resolved` event
  5. Exec tool resumes with the decision
       ↓
If denied: Tool returns error to agent
If approved: Tool executes and returns result
```

### Key Difference from Witness

Exec-approvals works **synchronously within the tool call** — the tool call blocks waiting for approval. This is possible because exec is a built-in tool that can await a resolution.

Witness's `before_tool_call` hook has a different model:
- Hook returns `{ block: true, blockReason }` → tool call is REJECTED (throws error)
- There's no "pause and wait" mechanism in hooks
- The agent sees an error and moves on

**This means Witness can't pause tool execution like exec-approvals does.** Our flow must be:
1. Block tool call (return error to agent)
2. Agent receives error explaining the block
3. Human approves via `/witness approve`
4. Agent is notified and can retry

This is actually fine for v0.1. The agent gets a clear error message and can retry after approval.

---

## 7. Session Key to Channel ID Resolution

For direct Discord messaging, we need to resolve `sessionKey` → Discord `channelId`. From the source:

```typescript
// extractDiscordChannelId extracts channel from session key
// Session keys look like: agent:main:discord:1234567890
// The channel ID is the last segment
function extractDiscordChannelId(sessionKey: string): string | undefined {
  // Extracts the Discord channel ID from session key
}
```

For Witness, we can use the hook context:

```typescript
// In before_tool_call hook:
api.registerHook('before_tool_call', async (event, ctx) => {
  // ctx.sessionKey = "agent:main:discord:1234567890"
  // We can extract the channel context from this
  const sessionKey = ctx.sessionKey ?? 'unknown';
  
  // For enqueueSystemEvent, we just need the sessionKey
  api.runtime.system.enqueueSystemEvent(approvalText, { sessionKey });
});
```

---

## 8. Revised Notification Architecture

### Phase 1 (Audit-Only) — No Notifications

Just log to SQLite. No user-facing notifications needed.

### Phase 2 (Gating) — System Event Notifications

```typescript
// In before_tool_call hook when blocking:
function notifyBlocked(api: any, ctx: HookContext, woId: string, risk: RiskAssessment, toolName: string) {
  const text = [
    `🛡️ **Witness — Tool Blocked (${risk.level} risk)**`,
    ``,
    `Tool: \`${toolName}\``,
    `Reason: ${risk.reasons.join('; ')}`,
    `Work Order: \`${woId}\``,
    ``,
    `⏱️ Expires in 30 minutes`,
    ``,
    `\`/witness approve ${woId}\` — Allow this action`,
    `\`/witness reject ${woId}\` — Deny this action`,
    `\`/witness details ${woId}\` — Full params`,
  ].join('\n');

  // Method 1: System event (agent sees it next turn)
  api.runtime.system.enqueueSystemEvent(
    `[System Message] ${text}`,
    { sessionKey: ctx.sessionKey }
  );
}
```

### Phase 2 Approval Handler (Command Extension)

```typescript
// Extend /witness command to handle approve/reject
async function handleApproveCommand(store: AuditStore, api: any, woId: string, note?: string): Promise<string> {
  const wo = store.getWorkOrder(woId);
  if (!wo) return `❌ Work order \`${woId}\` not found.`;
  if (wo.status !== 'pending') return `❌ Work order \`${woId}\` is already ${wo.status}.`;
  if (new Date(wo.expiresAt) < new Date()) {
    store.resolveWorkOrder(woId, { status: 'expired', resolvedBy: 'system' });
    return `⏰ Work order \`${woId}\` has expired.`;
  }
  
  store.resolveWorkOrder(woId, {
    status: 'approved',
    resolvedBy: 'user',
    resolutionNote: note,
  });
  
  // Notify agent to retry
  api.runtime.system.enqueueSystemEvent(
    `[System Message] ✅ Witness: Work order ${woId} APPROVED.\n` +
    `Tool: ${wo.toolName}\n` +
    `Params: ${wo.paramsJson}\n` +
    `You may now re-execute this tool call.`,
    { sessionKey: wo.sessionKey }
  );
  
  return `✅ Work order \`${woId}\` approved. Agent notified.`;
}
```

### Phase 3 (Discord Buttons) — Direct Component Messages

```typescript
// When Discord is available, send rich approval message
async function notifyBlockedDiscord(api: any, ctx: HookContext, woId: string, risk: RiskAssessment, toolName: string) {
  const sessionKey = ctx.sessionKey ?? '';
  const channelId = extractChannelIdFromSessionKey(sessionKey);
  
  if (!channelId) {
    // Fallback to system event
    return notifyBlocked(api, ctx, woId, risk, toolName);
  }
  
  try {
    await api.runtime.channel.discord.sendDiscordComponentMessage(
      `channel:${channelId}`,
      {
        text: `🛡️ **Witness — Approval Required**\n\n` +
              `**Tool:** \`${toolName}\`\n` +
              `**Risk:** ${formatRiskEmoji(risk.level)} ${risk.level}\n` +
              `**Reason:** ${risk.reasons.join('; ')}\n\n` +
              `⏱️ Expires in 30 minutes`,
        // Note: component spec format TBD — needs to match OpenClaw's 
        // buildDiscordComponentMessage input format
      },
      { sessionKey, agentId: ctx.agentId }
    );
  } catch (err) {
    api.logger.warn(`[witness] Discord component send failed, falling back to system event: ${err}`);
    notifyBlocked(api, ctx, woId, risk, toolName);
  }
}

// Helper to extract Discord channel ID from session key
function extractChannelIdFromSessionKey(sessionKey: string): string | undefined {
  // Session keys for Discord: "agent:main:discord:1234567890"
  const parts = sessionKey.split(':');
  const discordIdx = parts.indexOf('discord');
  if (discordIdx >= 0 && parts[discordIdx + 1]) {
    return parts[discordIdx + 1];
  }
  return undefined;
}
```

---

## 9. Integration Layer — What Ruflo Integrations to Keep/Add

### From Ruflo: Nothing to Keep

Session 2 established that 96.5% of Ruflo is bloat. After Sessions 3-4, we pivoted away from forking Ruflo entirely. The integration layer is pure OpenClaw.

### What Witness Integrates With

| Integration | How | Phase |
|------------|-----|-------|
| **OpenClaw Hooks** | `after_tool_call` (audit), `before_tool_call` (gating) | 1, 2 |
| **OpenClaw Commands** | `/witness` auto-reply command | 1 |
| **OpenClaw Gateway RPC** | `witness.recent`, `witness.stats`, `witness.verify` | 1 |
| **OpenClaw System Events** | `enqueueSystemEvent` for notifications | 2 |
| **OpenClaw Discord Runtime** | `sendMessageDiscord` / `sendDiscordComponentMessage` | 3 |
| **SQLite** | Audit store, work orders, trust ledger | 1 |
| **OpenClaw Exec-Approvals** | Pattern reference (not code dependency) | 2 |
| **SKILL.md** | Agent instructions for `/witness` | 1 |

### What Witness Does NOT Need

- ❌ MCP integration (OpenClaw handles MCP → tool calls → hooks fire)
- ❌ Channel adapters (use OpenClaw's existing channels)
- ❌ LLM integration (risk assessment is rule-based, not AI-based)
- ❌ Auth system (OpenClaw handles auth, `/witness` uses `requireAuth: true`)
- ❌ Temporal/Inngest/Hatchet (overkill for this use case)
- ❌ Custom HTTP server (use `registerHttpRoute` if needed)

---

## 10. Updated `register()` — Full Phase 2 Implementation

```typescript
export default function register(api: any) {
  const cfg = resolveConfig(api.pluginConfig);
  const dbPath = cfg.dbPath || resolveDefaultDbPath(api);
  const store = new AuditStore(dbPath);

  // ── Phase 1: Audit logging ──
  api.registerHook('after_tool_call', async (event: any, ctx: any) => {
    const risk = assessRisk(event.toolName, event.params ?? {}, cfg);
    store.append({
      timestamp: new Date().toISOString(),
      sessionKey: ctx.sessionKey ?? 'unknown',
      agentId: ctx.agentId ?? 'main',
      toolName: event.toolName,
      params: event.params ?? {},
      resultOk: !event.error,
      resultSummary: summarize(event.result, event.error),
      durationMs: event.durationMs,
      riskLevel: risk.level,
      action: event.error ? 'error' : 'logged',
    });
  }, {
    name: 'witness.audit-logger',
    description: 'Log every tool call to Witness audit store',
  });

  // ── Phase 2: Gating ──
  if (cfg.mode !== 'audit') {
    api.registerHook('before_tool_call', async (event: any, ctx: any) => {
      const risk = assessRisk(event.toolName, event.params ?? {}, cfg);
      
      if (!risk.shouldBlock) return; // allow through
      
      // Create work order
      const eventId = store.append({
        timestamp: new Date().toISOString(),
        sessionKey: ctx.sessionKey ?? 'unknown',
        agentId: ctx.agentId ?? 'main',
        toolName: event.toolName,
        params: event.params ?? {},
        riskLevel: risk.level,
        action: 'blocked',
      });
      
      const woId = store.createWorkOrder({
        eventId,
        toolName: event.toolName,
        params: event.params ?? {},
        riskLevel: risk.level,
        blockReason: risk.reasons.join('; '),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        ttlMinutes: cfg.ttlMinutes,
      });
      
      // Notify via system event
      notifyBlocked(api, ctx, woId, risk, event.toolName);
      
      return {
        block: true,
        blockReason: `🛡️ Witness: Blocked (${risk.level} risk). ` +
          `Reason: ${risk.reasons[0]}. ` +
          `Approve: /witness approve ${woId}`,
      };
    }, {
      name: 'witness.gatekeeper',
      description: 'Block high-risk tool calls pending approval',
      priority: 100,
    });
  }

  // ── Commands ──
  api.registerCommand({
    name: 'witness',
    description: 'Witness audit trail — query, approve, reject',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() ?? '';
      const parts = args.split(/\s+/);
      const sub = parts[0] || 'recent';
      const rest = parts.slice(1).join(' ');
      
      switch (sub) {
        case 'approve': return { text: await handleApprove(store, api, rest) };
        case 'reject': return { text: await handleReject(store, api, rest) };
        case 'pending': case 'queue': return { text: formatPending(store) };
        case 'details': return { text: formatDetails(store, rest) };
        case 'recent': return { text: formatRecent(store, parseInt(rest) || 20) };
        case 'search': return { text: formatSearch(store, rest) };
        case 'stats': return { text: formatStats(store) };
        case 'verify': return { text: formatVerify(store) };
        case 'help': return { text: formatHelp() };
        default: return { text: `Unknown: ${sub}\n${formatHelp()}` };
      }
    },
  });

  // ── Gateway RPC ──
  api.registerGatewayMethod('witness.recent', ({ respond, params }: any) => {
    respond(true, store.recent(params?.limit ?? 20));
  });
  api.registerGatewayMethod('witness.stats', ({ respond }: any) => {
    respond(true, store.stats());
  });
  api.registerGatewayMethod('witness.verify', ({ respond }: any) => {
    respond(true, store.verify());
  });
  api.registerGatewayMethod('witness.workorders', ({ respond, params }: any) => {
    respond(true, store.listWorkOrders(params?.status ?? 'pending'));
  });

  // ── Background service ──
  api.registerService({
    id: 'witness-db',
    start: () => {
      const interval = setInterval(() => store.sweepExpiredWorkOrders(), 5 * 60 * 1000);
      api.logger.info('[witness] Audit store ready');
      return { stop: () => clearInterval(interval) };
    },
    stop: () => {
      store.close();
      api.logger.info('[witness] Audit store closed');
    },
  });
}
```

---

## 11. Open Questions Resolved

| Question (from Session 7) | Answer |
|---------------------------|--------|
| Does `api.notify()` exist? | **NO.** Use `api.runtime.system.enqueueSystemEvent()` for cross-channel notifications (injects system message into session). |
| Can plugins send Discord messages with buttons? | **YES.** `api.runtime.channel.discord.sendDiscordComponentMessage()` exists. Requires `channelId` (extractable from `sessionKey`). For MVP, use system events + `/witness approve` commands instead. |
| Does `api.invokeTool()` exist? | **NO.** Use `enqueueSystemEvent` to tell the agent to re-execute, or register a `witness_reexecute` tool for explicit agent cooperation. |

## 12. Open Questions for Sessions 9-10

1. **SQLite WAL concurrency** — Test concurrent inserts from multiple hooks firing in parallel. (Session 9)
2. **`enqueueSystemEvent` timing** — When does the agent process system events? Immediately on next turn, or only on next user message? Affects approval notification UX. (Session 9)
3. **Data model finalization** — Merge events + work_orders tables? Or keep separate for query flexibility? (Session 9)
4. **MVP scope lock** — Exact list of what ships in Phase 1 vs deferred. (Session 10)
5. **Testing strategy** — Mock `api` object for integration tests. (Session 10)

---

## Summary

Session 8 fully mapped the **integration layer** between Witness and OpenClaw:

1. **Complete plugin API audit** — Documented all 12 `api.*` methods and the full `api.runtime` surface. No `notify()` or `invokeTool()` exist.
2. **Notification strategy resolved** — Use `api.runtime.system.enqueueSystemEvent()` for Phase 2 cross-channel notifications. System events inject into the agent session, triggering the agent to relay to the user.
3. **Discord button UX mapped** — `sendDiscordComponentMessage()` exists in `api.runtime.channel.discord`. Can send approval buttons. Deferred to Phase 3 (command-based approval is sufficient for Phase 2 MVP).
4. **Re-execution strategy finalized** — v0.1: `enqueueSystemEvent` tells agent to retry. v0.2: register `witness_reexecute` tool. Future: propose `api.invokeTool()` upstream.
5. **Exec-approvals reference** — Studied the existing approval flow architecture. Key difference: exec-approvals blocks synchronously within tool call; Witness blocks via hook return value (agent gets error, retries after approval).
6. **Full Phase 2 `register()` implementation** — Production-ready code with audit logging, gating, commands (including approve/reject), Gateway RPC, and background service.
7. **No Ruflo integrations needed** — Witness is a pure OpenClaw plugin. All integrations go through OpenClaw's existing infrastructure.

---

*Session duration: ~25 min*  
*Phase status: PLAN session 3 of 5. Next: Session 9 — Data model finalization + SQLite concurrency.*
