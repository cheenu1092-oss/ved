# Session 2 — THINK: Clone Ruflo, Map Architecture, Core vs Bloat

**Date:** 2026-03-04 00:16 PST  
**Phase:** THINK (Session 2 of 5)  
**Objective:** Clone Ruflo, map its architecture in detail, classify every module as CORE / USEFUL / BLOAT

---

## 1. Repository Overview

- **Repo:** github.com/ruvnet/ruflo (formerly claude-flow)
- **npm package:** claude-flow@3.5.2
- **License:** MIT
- **Versions:** Three coexisting versions — root (legacy), v2 (178K LoC), v3 (424K LoC)
- **Active version:** v3 — all CLI traffic routes through `bin/cli.js → v3/@claude-flow/cli`
- **Dependencies:** Minimal runtime (semver, zod). Heavy optional deps (@ruvector/*, agentdb, agentic-flow)
- **Cloned to:** `~/clawd/projects/new-claw/ruflo/`

### Suspicious: preinstall script
The `package.json` has an aggressive preinstall script that:
1. Cleans up npm cache entries matching `claude-flow` or `ruflo`
2. Removes hidden directories in `node_modules` matching a regex pattern
This is unusual and potentially concerning — it's modifying npm's cache outside its own package scope. **Flag for security review.**

---

## 2. V3 Architecture Map

### 2.1 Core Source (`v3/src/`) — The Skeleton

The actual domain model is clean and small (~24 files, well-structured DDD):

| Module | Purpose | Lines | Quality |
|--------|---------|-------|---------|
| `shared/types/` | All type definitions (Agent, Task, Memory, Workflow, Swarm, Plugin, MCP) | ~380 | **Good** — clean, comprehensive |
| `agent-lifecycle/domain/Agent.ts` | Agent entity — spawn, execute, terminate | ~150 | **Good** — simple, extensible |
| `task-execution/domain/Task.ts` | Task entity — lifecycle, dependencies, topological sort | ~200 | **Good** — solid topo sort |
| `task-execution/application/WorkflowEngine.ts` | Workflow executor — sequential/parallel, rollback, pause/resume | ~350 | **Good** — useful patterns |
| `coordination/application/SwarmCoordinator.ts` | Multi-agent orchestration — topology, task distribution, consensus | ~350 | **Decent** — consensus is a stub (random votes) |
| `memory/domain/Memory.ts` | Memory entity | small | Standard |
| `memory/infrastructure/` | SQLite, AgentDB, Hybrid backends | ~3 files | **Useful** — multi-backend pattern |
| `infrastructure/mcp/` | MCP server + tool providers (Agent, Memory, Config tools) | ~4 files | **Useful** — MCP integration |
| `infrastructure/plugins/` | Plugin manager, extension points | ~3 files | **Useful** — clean plugin system |

**Verdict: The v3/src core is GOOD. ~1,500 lines of clean, DDD-style TypeScript. This is worth keeping.**

### 2.2 @claude-flow Packages — The Feature Sprawl

| Package | Lines | Classification | Notes |
|---------|-------|----------------|-------|
| **cli** | 98,646 | CORE (partially) | Main CLI entry point. ~170 files. Contains commands, MCP tools, services, ruvector integration. **Massive** — needs aggressive trimming |
| **claims** | 9,443 | CORE (HITL) | Issue claiming + handoff system. Well-typed (ADR-016). Work stealing, load balancing, contest windows. **This is the HITL gem.** |
| **shared** | 23,522 | USEFUL | Shared types, utilities across packages |
| **memory** | 19,067 | USEFUL | SQLite, hybrid, agent-scoped memory. HybridBackend is solid |
| **swarm** | 16,501 | USEFUL (partially) | Swarm coordination, topologies. Some is too enterprise |
| **hooks** | 10,072 | USEFUL | Git hooks, lifecycle hooks. Opinionated but useful pattern |
| **mcp** | 7,177 | CORE | MCP client/server implementation |
| **guidance** | 22,607 | BLOAT | WASM kernels for "guidance" — over-engineered policy engine |
| **plugins** | 37,634 | BLOAT | Massive plugin system — most plugins are domain-specific enterprise stuff |
| **neural** | 13,406 | BLOAT | "Neural coordination" — fancy name for basic message routing |
| **codex** | 7,611 | BLOAT (for us) | OpenAI Codex integration — not relevant to our goals |
| **integration** | 12,795 | EVALUATE | Third-party integrations — might have useful patterns |
| **performance** | 4,406 | BLOAT | Benchmarking/perf tooling — dev-only |
| **testing** | 14,198 | BLOAT (runtime) | Testing utilities — dev-only |
| **browser** | 4,902 | BLOAT | Browser automation — not core to personal assistant |
| **aidefence** | 1,304 | EVALUATE | Security/defense — small, potentially useful |
| **deployment** | 1,470 | BLOAT | Deployment tooling — enterprise-specific |
| **embeddings** | 4,345 | USEFUL | Embedding generation/management |
| **providers** | 4,515 | USEFUL | LLM provider abstraction |
| **security** | 3,828 | USEFUL | Security primitives |

### 2.3 Plugins Directory — Pure Enterprise Bloat

15 plugins, all domain-specific and irrelevant to a personal assistant:
- `financial-risk`, `healthcare-clinical`, `legal-contracts` — industry verticals
- `quantum-optimizer`, `hyperbolic-reasoning`, `cognitive-kernel` — academic/research
- `neural-coordination`, `prime-radiant` — over-engineered coordination
- `gastown-bridge`, `ruvector-upstream` — proprietary integrations
- `agentic-qe`, `test-intelligence`, `code-intelligence` — dev tooling
- `teammate-plugin`, `perf-optimizer` — nice-to-have, not core

**Verdict: DELETE ALL. Zero relevance to personal assistant use case.**

---

## 3. The Claims System — Deep Analysis

The `@claude-flow/claims` package is the most interesting part for us. It implements:

### 3.1 Core Concepts
- **Issue** — A work item with title, description, labels, priority, complexity
- **Claim** — An active claim on an issue by a claimant (human or agent)
- **Handoff** — Transfer of a claim between claimants (human→agent, agent→agent)
- **Work Stealing** — Automatic reassignment when an agent is stale/blocked/overloaded

### 3.2 Status Lifecycle
```
active → paused → active (resume)
active → blocked → active (unblock)
active → handoff-pending → active (handoff accepted)
active → review-requested → completed
active → stealable → active (stolen by new agent)
any → completed
```

### 3.3 What's Good
- **Well-typed domain model** — ADR-016 types are comprehensive
- **Event sourcing** — All state changes are events
- **Work stealing with contest windows** — Fair reassignment
- **Load balancing** — Agent load metrics, rebalancing
- **MCP tools** — 17 tools exposed via MCP

### 3.4 What's Missing for Our Work Order System
- **No approval queues** — Claims don't have pre-execution approval. It's claim-then-work, not propose-then-approve
- **No risk assessment** — No concept of action risk level driving approval requirements
- **No trust tiers** — No graduated autonomy based on trust
- **No cost tracking** — No token/API cost attribution per claim
- **No audit hash chain** — Events aren't hash-chained for immutability
- **No timeout escalation** — No SLA-based escalation to human
- **No structured output validation** — Claims don't validate what the agent produced

---

## 4. Core Architecture Patterns Worth Keeping

### Pattern 1: DDD Structure
```
domain/ → entities, value objects, types
application/ → services, coordinators
infrastructure/ → persistence, external integrations
api/ → MCP tools, CLI commands
```
Clean separation. We should keep this.

### Pattern 2: Event-Driven Everything
Events flow through an EventEmitter bus. Every agent spawn, task execution, workflow step emits events. Good for audit trails.

### Pattern 3: Memory Backend Abstraction
```
MemoryBackend interface → SQLiteBackend | HybridBackend | AgentDBBackend
```
Swap persistence without changing business logic. Keep.

### Pattern 4: MCP as First-Class Integration
All features are exposed as MCP tools. The assistant can both consume and provide tools. Keep.

### Pattern 5: Plugin Extension Points
Named extension points (e.g., `workflow.beforeExecute`) that plugins can hook into. Clean pattern, but current implementation is over-complex (37K lines of plugin infra).

---

## 5. Core vs Bloat Summary

### KEEP (Foundation) — ~15K lines estimated after trimming
- `v3/src/` core domain (Agent, Task, Workflow, Memory types)
- `@claude-flow/claims` — stripped of enterprise load balancing, adapted for work orders
- `@claude-flow/mcp` — MCP client/server
- `@claude-flow/memory` — SQLite + hybrid backends
- `@claude-flow/shared` — core types only
- `@claude-flow/security` — basic security primitives

### STRIP (Too Complex for Personal Use) — ~350K lines
- All 15 plugins (financial, healthcare, legal, quantum, etc.)
- `@claude-flow/guidance` — WASM policy engine
- `@claude-flow/neural` — over-engineered message routing
- `@claude-flow/codex` — Codex-specific integration
- `@claude-flow/browser` — browser automation
- `@claude-flow/deployment` — enterprise deployment
- `@claude-flow/performance` — benchmarking
- `@claude-flow/testing` — test utilities
- Most of `@claude-flow/cli` (~90K lines) — needs complete rewrite
- v2/ directory entirely
- ruvector/* integrations (proprietary vector DB)
- Appliance builder, GGUF engine, transfer/store system

### ADD (Our Unique Value) — To be designed in Sessions 6-10
- Work order system (approval queues, risk assessment, graduated autonomy)
- Audit hash chain (immutable, structured JSON event logs)
- Trust tier engine (per-user/per-action trust levels)
- Cost tracking (token/API cost per action)
- Channel adapters (Discord, Slack, CLI, mobile)
- Tauri desktop/mobile shell

---

## 6. Key Metrics

| Metric | Count |
|--------|-------|
| Total TS files (v3, non-test) | ~600+ |
| Total TS lines (v3) | 424,106 |
| Total TS lines (v2) | 178,883 |
| @claude-flow packages | 21 |
| Plugins | 15 |
| MCP tool definitions | 70+ |
| CLI commands | 30+ |
| Lines we'd keep (estimate) | ~15,000 |
| Lines to strip | ~410,000 |
| Strip ratio | **96.5%** |

---

## 7. Red Flags

1. **Preinstall script** — Modifies npm cache outside package scope. Unusual for an OSS package.
2. **Consensus is a stub** — `reachConsensus()` literally uses `Math.random()`. The "enterprise consensus" marketing is misleading.
3. **Optional deps are critical** — @ruvector/*, agentdb, agentic-flow are "optional" but the CLI uses them extensively.
4. **Version sprawl** — v2 and v3 coexist with different architectures. Migration path unclear.
5. **424K lines for an orchestration tool** — For context, OpenClaw core is ~30K lines and does more.
6. **Agent.processTaskExecution** — Just does a `setTimeout` based on priority. The "processing" is a no-op.

---

## 8. Next Session Plan (Session 3)

**Session 3: Compare Ruflo's approach vs OpenClaw. Where does each win?**
- Side-by-side architecture comparison
- Feature matrix: what Ruflo has that OpenClaw doesn't, and vice versa
- Identify the synthesis — how our fork combines the best of both
- Map the integration points where our fork talks to OpenClaw

---

*Session duration: ~15 min analysis time*
*Files analyzed: 20+ core source files, all package directories*
