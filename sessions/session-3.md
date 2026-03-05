# Session 3 — THINK: Ruflo vs OpenClaw Architecture Comparison

**Date:** 2026-03-04 01:16 PST  
**Phase:** THINK (Session 3 of 5)  
**Objective:** Side-by-side comparison of Ruflo and OpenClaw architectures. Identify where each wins, and the synthesis path for our fork.

---

## 1. Scale Comparison

| Metric | OpenClaw | Ruflo v3 |
|--------|----------|----------|
| **Core src (non-test)** | ~393K lines | ~4K lines (src/), ~393K (@claude-flow packages) |
| **Extensions/Plugins** | ~73K lines (40 extensions) | ~116K lines (15 plugins) |
| **Total non-test TS** | ~466K lines | ~512K lines |
| **Active contributors** | OSS Foundation (post-Steinberger) | Solo dev (@ruv) |
| **npm package** | `openclaw` | `claude-flow` |
| **License** | MIT | MIT |
| **GitHub stars** | 247K+ | Not available (smaller project) |
| **Maturity** | Production (thousands of daily users) | Prototype (stubs, no-ops, Math.random consensus) |

**Key insight:** Similar LOC, wildly different maturity. OpenClaw's 393K lines are battle-tested gateway code handling real messages across 15+ channels. Ruflo's 393K package lines are largely enterprise scaffolding with no-op implementations.

---

## 2. Architecture Models

### OpenClaw: Hub-and-Spoke Gateway

```
User ← Channel (Discord/Telegram/Signal/...) ← Gateway ← LLM Provider
                                                    ↕
                                              Agent Session
                                                    ↕
                                         Tools (exec, browser, memory, ...)
                                                    ↕
                                              Skills (plugins)
```

**Core Concepts:**
1. **Gateway** — Long-running Node.js daemon. HTTP + WebSocket server. Heart of the system (~34K lines).
2. **Channels** — Plugins that adapt messaging platforms (Discord, Telegram, Signal, WhatsApp, Slack, iMessage, etc.). Each is an extension package.
3. **Agent Sessions** — Stateful conversations between user and LLM. JSONL transcript storage. Session keys for routing.
4. **Auto-Reply Engine** — The message handling loop (~28K lines). Receives inbound, routes to LLM, handles commands, dispatches tools, sends response back through channel.
5. **Tools** — 40+ tools the LLM can call (exec, browser, web_search, message, sessions_spawn, etc.). Each is a function with schema. (~68K lines in agents/tools).
6. **Skills** — User-installable SKILL.md + scripts packages. Loaded at prompt time. Not code plugins — they're instruction files.
7. **Cron** — Scheduled tasks with isolated agent sessions.
8. **Memory** — Semantic search over .md files. Basic but effective.

**Philosophy:** The LLM IS the orchestrator. No workflow engine, no task queue, no agent topology. The LLM decides what to do, calls tools, gets results. Everything flows through one gateway process.

### Ruflo: Enterprise Multi-Agent Orchestration

```
CLI → SwarmCoordinator → Agent Pool → Task Execution → WorkflowEngine
         ↕                    ↕              ↕
    Consensus Engine    Plugin System    Memory Backends
         ↕                    ↕              ↕
    Claims System       MCP Server      SQLite/AgentDB
```

**Core Concepts:**
1. **SwarmCoordinator** — Manages multiple agent instances. Topologies: hierarchical (queen/worker), mesh, ring. (~350 lines, consensus is Math.random stub).
2. **Agent Lifecycle** — DDD entity. Spawn → execute → terminate. Processing is setTimeout. (~150 lines).
3. **Task Execution** — WorkflowEngine with sequential/parallel, rollback, pause/resume. Topological sort for dependencies. (~550 lines).
4. **Claims System** — Issue claiming + handoff + work stealing. The HITL gem. (~9.4K lines, well-typed).
5. **Memory** — Multi-backend (SQLite, AgentDB, Hybrid). Agent-scoped namespaces. (~19K lines).
6. **MCP** — Both client and server. 70+ tool definitions. (~7K lines).
7. **Plugins** — Named extension points, hook lifecycle. Over-engineered. (~38K lines for infra + 116K for plugins).
8. **Guidance** — WASM kernels for policy. Over-engineered. (~23K lines).
9. **Neural Coordination** — Fancy message routing between agents. (~13K lines).

**Philosophy:** Build an enterprise platform with every pattern (DDD, event sourcing, CQRS, consensus, WASM kernels). Agents are autonomous workers coordinated by topology. The human is a claimant in the system, not the center.

---

## 3. Feature Matrix: Who Wins Where

### Where OpenClaw Wins (Decisively)

| Feature | OpenClaw | Ruflo | Winner |
|---------|----------|-------|--------|
| **Multi-channel messaging** | 15+ channels, real production integrations | None | 🏆 OpenClaw |
| **Working LLM integration** | Anthropic, OpenAI, Google, DeepSeek, OpenRouter, local | Config only, no actual LLM calls | 🏆 OpenClaw |
| **Tool ecosystem** | 40+ working tools (exec, browser, web, message, etc.) | 70+ MCP definitions, most are stubs | 🏆 OpenClaw |
| **Skill marketplace** | ClawHub with community skills | Nothing | 🏆 OpenClaw |
| **Browser automation** | Playwright-based, snapshot/act pattern | Empty browser package | 🏆 OpenClaw |
| **Voice/TTS/STT** | Multiple providers, Discord voice | Nothing | 🏆 OpenClaw |
| **Node pairing** | Phone/device pairing via Bonjour | Nothing | 🏆 OpenClaw |
| **Desktop/mobile access** | 15+ messaging channels + web | CLI only | 🏆 OpenClaw |
| **Cron/scheduling** | Working isolated agent sessions | Nothing | 🏆 OpenClaw |
| **Community** | 247K stars, foundation-backed, Discord | Solo project | 🏆 OpenClaw |
| **Production hardening** | Thousands of daily users | No production users | 🏆 OpenClaw |
| **Security** | Exec approvals, sandbox, allowlists, TLS | aidefence package (1.3K lines) | 🏆 OpenClaw |

### Where Ruflo Wins (Conceptually)

| Feature | Ruflo | OpenClaw | Winner |
|---------|-------|----------|--------|
| **HITL primitives** | Claims system: claim, handoff, contest, review, work-stealing | Chat-based approval only (ask user, wait for reply) | 🏆 Ruflo |
| **Event sourcing** | All claim state changes are events | JSONL session transcripts (not domain events) | 🏆 Ruflo |
| **DDD structure** | Clean domain/application/infrastructure separation | Functional modules (gateway, agents, channels) | 🏆 Ruflo |
| **Multi-agent coordination** | SwarmCoordinator, topologies, task distribution | Sub-agent spawning (flat, no coordination) | 🏆 Ruflo |
| **Workflow engine** | Sequential/parallel, rollback, pause/resume, topo sort | None (LLM decides everything) | 🏆 Ruflo |
| **Memory architecture** | Multi-backend, agent-scoped, hybrid | Flat .md files with semantic search | 🏆 Ruflo |
| **Plugin extension points** | Named hooks (beforeExecute, afterComplete) | Skills are instruction files, not code hooks | 🏆 Ruflo |
| **MCP server mode** | Exposes agent capabilities as MCP tools | MCP client only (consumes, doesn't serve) | 🏆 Ruflo |
| **Task decomposition** | Explicit task graph with dependencies | LLM-driven (no structure) | 🏆 Ruflo |

### Neither Wins (Both Missing)

| Feature | Status |
|---------|--------|
| **Formal approval queues** | Neither has pre-execution approval with risk assessment |
| **Audit hash chain** | Neither has immutable, hash-chained event logs |
| **Trust tiers** | Neither has graduated autonomy based on trust levels |
| **Cost tracking per action** | Neither attributes token/API costs to specific work items |
| **SLA-based escalation** | Neither auto-escalates to human on timeout |
| **Structured output validation** | Neither validates what the agent produced against spec |
| **Native mobile app** | Neither (OpenClaw uses messaging channels as proxy) |
| **Compliance framework** | Neither is SOC2/HIPAA ready out of the box |

---

## 4. Architectural Philosophy Clash

### OpenClaw: "The LLM is the Brain"
- No workflow engine because the LLM decides the workflow
- No multi-agent topology because spawning sub-agents is just another tool call
- No task graph because the LLM decomposes tasks in-context
- Simple but effective: works because modern LLMs are good at planning

**Strengths:** Low complexity. One mental model. The system is as smart as the LLM.  
**Weaknesses:** No auditability. No deterministic workflows. Can't reproduce a run. LLM failures cascade invisibly. No cost controls per action.

### Ruflo: "The System is the Brain"
- Explicit workflow engine with steps, rollback, dependencies
- Multi-agent topologies with consensus (queen decides)
- Task graphs with topological sort
- Enterprise patterns (DDD, event sourcing, CQRS)

**Strengths:** Deterministic. Auditable. Reproducible. Structured.  
**Weaknesses:** Over-engineered for personal use. 96.5% bloat. Stubs instead of implementations. The "brain" doesn't actually think — it's scaffolding for a brain that was never built.

### The Synthesis: "The LLM is the Brain, but the System Keeps Receipts"

Our fork should combine:
1. **OpenClaw's pragmatism** — LLM drives decisions, tool calls are the primitive
2. **Ruflo's domain modeling** — Claims/work-orders as typed entities with event sourcing
3. **Neither's weakness** — Add approval queues, trust tiers, cost tracking, audit hash chains

The LLM proposes actions → the system validates, logs, and gates them → the human approves high-risk ones → everything is immutably recorded.

---

## 5. Integration Strategy: Fork Builds ON TOP of OpenClaw

### Critical Realization: We Don't Fork OpenClaw. We Extend It.

After deep analysis, the correct architecture is:

```
OpenClaw (existing gateway, channels, tools, LLM routing)
    ↕
Our Layer (HITL work orders, audit, trust, approval queues)
    ↕
Ruflo DNA (Claims domain model, event sourcing, memory patterns)
```

**Why:**
- OpenClaw already does messaging, LLM routing, tool execution, browser automation, cron, etc.
- Rebuilding any of that is a waste of months
- Our value-add is the HITL/audit/trust layer BETWEEN the LLM's decisions and the tool executions
- Ruflo's Claims system is the best starting point for that layer
- This can ship as an OpenClaw extension or plugin

### What We Take From Each

**From Ruflo (~2K lines, heavily adapted):**
- `Claims` domain types (Issue, Claim, Claimant, Handoff)
- `ClaimDomainEvent` pattern (event sourcing for state changes)
- Memory backend abstraction (SQLite-first, interface for future backends)
- Duration/priority value objects

**From OpenClaw (use as-is, don't fork):**
- Gateway + all channel integrations
- Agent sessions + tool system
- Cron + scheduling
- Browser automation
- Exec sandbox + security
- Everything that already works

**New (our unique value):**
- Work order system: Propose → Assess Risk → Route to Queue → Approve/Reject → Execute → Log → Verify
- Trust tier engine: per-user/per-action trust levels driving auto-approval thresholds
- Audit hash chain: SHA-256 chain of all events, tamper-evident
- Cost tracking: token + API cost per work order
- Approval UI: Discord components, web dashboard, CLI
- Escalation engine: SLA timers → auto-escalate to human

---

## 6. Concrete Integration Points

### Where Our Layer Hooks Into OpenClaw

1. **Tool execution intercept** — Before any tool call reaches the exec/browser/message layer, our system:
   - Creates a WorkOrder from the tool call
   - Assesses risk (is this a read? a write? a send? a delete?)
   - Checks trust tier (does this user/agent have auto-approval for this risk level?)
   - If auto-approved: execute, log, continue
   - If needs approval: queue, notify human, wait
   - After execution: record result, cost, hash-chain event

2. **Session middleware** — Between the auto-reply engine and the LLM, add:
   - Work order context injection (pending orders, recent history)
   - Cost budget checks (has this session exceeded its budget?)
   - Rate limiting by trust tier

3. **MCP server exposure** — Expose our work order system as MCP tools:
   - `work_order.create`, `work_order.approve`, `work_order.reject`
   - `work_order.list`, `work_order.history`
   - `trust.check`, `trust.escalate`
   - `audit.query`, `audit.verify`

4. **Channel-native approval UI** — Approval notifications that work in Discord (buttons), Telegram (inline keyboards), web (dashboard)

---

## 7. Risk Assessment of This Strategy

| Risk | Severity | Mitigation |
|------|----------|------------|
| OpenClaw API instability | Medium | Build against plugin-sdk types, not internals. Abstract behind our own interfaces |
| OpenClaw governance uncertainty | Low | MIT license means we can always fork if foundation fails |
| Ruflo Claims code quality | Low | Only taking ~2K lines, heavily rewriting to fit our needs |
| Scope creep (building too much) | High | MVP = tool execution intercept + SQLite audit log. Nothing else first |
| Performance overhead of intercepting every tool call | Medium | Fast-path for low-risk reads. Only gate writes/sends/deletes |
| User adoption friction | Medium | Must be zero-config for basic mode. Advanced features opt-in |

---

## 8. Name Direction

Working names considered:
- **ClawGuard Pro** — extension of our existing ClawGuard security skill (but confusing scope)
- **WorkClaw** — work orders + OpenClaw (too corporate)
- **Audit Claw** — audit focus (too narrow)
- **Claw Orders** — (too restaurant-y)
- **GateKeep** — gates tool execution (too generic)
- **CerberusClaw** — three-headed guardian (audit, trust, approval) (too mythology-heavy)
- **Overseer** — human oversight layer (connotations with Fallout franchise)
- **Witness** — "the system that witnesses every action" (clean, memorable, philosophical)

Leaning toward: **Witness** — it's what the system does. It witnesses, records, and when asked, gates.

---

## 9. Revised Project Architecture

```
witness/
├── src/
│   ├── domain/          # From Ruflo DNA, heavily adapted
│   │   ├── work-order.ts    # WorkOrder entity (evolved from Claim)
│   │   ├── trust-tier.ts    # Trust tier definitions
│   │   ├── risk-level.ts    # Risk assessment types
│   │   └── events.ts        # Domain events (event sourcing)
│   ├── application/     # Core services
│   │   ├── gate.ts          # Tool execution interceptor
│   │   ├── assessor.ts      # Risk assessment engine
│   │   ├── approver.ts      # Approval routing (auto vs human)
│   │   ├── auditor.ts       # Hash-chain audit log
│   │   └── escalator.ts     # SLA-based escalation
│   ├── infrastructure/  # Persistence + integrations
│   │   ├── sqlite.ts        # SQLite backend
│   │   ├── hash-chain.ts    # SHA-256 event chain
│   │   └── mcp-server.ts    # MCP tool exposure
│   └── adapters/        # OpenClaw integration
│       ├── openclaw-hook.ts # Plugin/extension entry point
│       ├── discord-ui.ts    # Approval buttons for Discord
│       └── web-ui.ts        # Web dashboard
├── tests/
├── package.json
├── README.md
└── CONTRIBUTING.md
```

Estimated core: ~3-5K lines. Clean, focused, auditable.

---

## 10. Key Takeaway

**The fork isn't Ruflo → our thing. It's OpenClaw + Ruflo DNA → our thing.**

We're not forking either project. We're building a focused, small layer that:
1. Takes Ruflo's best pattern (Claims/event-sourcing) as domain model inspiration
2. Plugs into OpenClaw's existing infrastructure as an extension/plugin
3. Adds the three things neither has: formal approval queues, trust tiers, audit hash chains

This is ~5K lines of new TypeScript, not 400K lines of forked code.

---

## 11. Next Session Plan (Session 4)

**Session 4: Red-team the fork decision. What are the risks?**
- Challenge every assumption in this session
- What if OpenClaw's plugin system can't support tool intercept?
- What if the overhead of gating every tool call kills UX?
- What if nobody wants auditable personal assistants?
- Community dynamics: how does OpenClaw community react to this?
- Maintenance burden: who keeps this alive?

---

*Session duration: ~20 min analysis*
*Files analyzed: OpenClaw source tree (~/clawd/oss/openclaw/src), Ruflo v3 packages, Claims domain types*
*Key pivot: From "fork Ruflo" to "extend OpenClaw with Ruflo DNA"*
