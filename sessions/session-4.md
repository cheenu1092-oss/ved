# Session 4 — THINK: Red-Team the Strategy

**Date:** 2026-03-04 02:16 PST  
**Phase:** THINK (Session 4 of 5)  
**Objective:** Adversarially challenge every assumption from Sessions 1-3. Break the "Witness as OpenClaw extension" strategy before we commit to building it.

---

## 1. Recap of What We're Red-Teaming

**Strategy (from Session 3):** Don't fork Ruflo. Build "Witness" — a ~3-5K line OpenClaw plugin that:
- Intercepts tool calls via `before_tool_call` / `after_tool_call` hooks
- Assesses risk level per tool call
- Routes high-risk actions to approval queues
- Logs everything with SHA-256 hash-chain audit trail
- Implements trust tiers for graduated autonomy
- Takes inspiration from Ruflo's Claims domain model (not code)

**Claim:** This is better than forking 400K lines of Ruflo code.

Let's break it.

---

## 2. Red-Team: Is the Plugin Architecture Actually Viable?

### 2.1 ✅ CONFIRMED: OpenClaw's hook system supports tool interception

After reading the actual source (`src/plugins/hooks.ts` + `src/plugins/types.ts`), the hook system is robust:

```typescript
// before_tool_call can BLOCK tool calls
export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;  // modify params
  block?: boolean;                    // BLOCK execution
  blockReason?: string;               // tell the LLM why
};

// after_tool_call observes results
export type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};
```

**Verdict:** The intercept point exists and is designed for exactly this use case. Plugins can block, modify, and observe every tool call. Priority ordering ensures our plugin runs before others. This is not hypothetical — it's production infrastructure.

### 2.2 ⚠️ CHALLENGE: Can `before_tool_call` support async human approval?

The `before_tool_call` hook is async (`Promise<Result | void>`). But can it WAIT for human input?

**The problem:** When Witness blocks a tool call pending human approval, what happens to the LLM session? The LLM made a tool call and is waiting for a result. If we block indefinitely:
- The LLM provider connection may timeout
- The session may get stuck
- The user experience degrades (agent just... stops)

**Possible approaches:**
1. **Return a block result immediately** — Tell the LLM "this action requires approval, the user has been notified." The LLM generates a message saying "I've requested approval for X." When the user approves, trigger a new agent session that replays the action.
   - Pro: No timeout issues, clean UX
   - Con: Requires re-initiating the action, LLM may lose context
   - Con: The approval→re-execution flow needs careful state management

2. **Long-poll with timeout** — Hold the hook for N seconds, auto-reject if no approval
   - Pro: Simpler flow
   - Con: Blocks the entire session, poor UX, provider timeouts

3. **Return synthetic result** — Block the tool call, inject a synthetic "pending approval" result, and expose a separate `/approve` command
   - Pro: Session continues, LLM adapts
   - Con: LLM may try the action again or get confused

**Verdict: Approach 1 is correct but non-trivial.** The approval flow is async by nature. The plugin blocks the tool call, returns a reason, and the LLM communicates this to the user. A separate mechanism (Discord button, `/approve` command, web UI) triggers re-execution. This needs a **pending work order queue** with re-execution capability.

**Risk level: MEDIUM.** Architecturally sound but the state management between "blocked tool call" and "approved re-execution" is the hardest part of the entire project.

### 2.3 ⚠️ CHALLENGE: Hook context is insufficient for risk assessment

The `before_tool_call` event provides:
```typescript
{ toolName: string; params: Record<string, unknown> }
```
Context provides:
```typescript
{ agentId?: string; sessionKey?: string; toolName: string }
```

**What's missing for proper risk assessment:**
- Who triggered this session? (user identity, trust tier)
- What's the session's cumulative cost so far?
- What tool calls have already been made in this session?
- Is this a cron session or interactive?
- What channel is the user on? (affects approval UI)

**Mitigation:** Our plugin can:
1. Query session metadata via OpenClaw's runtime APIs
2. Maintain its own state (SQLite) tracking session history
3. Read config for channel/user context

**Risk level: LOW-MEDIUM.** Solvable, but requires our plugin to maintain its own state rather than relying solely on hook context.

---

## 3. Red-Team: Is Ruflo's Claims Model Actually Worth Taking?

### 3.1 🔴 CHALLENGE: Claims model solves a DIFFERENT problem

Ruflo's Claims system is about **multi-agent work distribution**:
- Multiple agents competing to claim issues
- Work stealing when an agent is overloaded
- Load balancing across agent pools
- Contest windows for fair reassignment

Our problem is **human approval of agent actions**:
- One agent (the LLM) proposes an action
- One human decides to approve or reject
- Risk assessment drives the routing
- Audit trail records everything

These are fundamentally different patterns:
- Claims = multi-producer, multi-consumer work queue
- Witness = single-producer (LLM), single-consumer (human) approval gate

**Verdict: We're over-indexing on Ruflo.** The Claims domain model is elegant but solves multi-agent coordination. Our "work order" is simpler:

```
WorkOrder {
  id: string
  toolName: string
  params: Record<string, unknown>
  riskLevel: low | medium | high | critical
  status: pending | approved | rejected | executed | failed
  sessionKey: string
  createdAt: Date
  decidedAt?: Date
  executedAt?: Date
  decision?: { approver: string, reason?: string }
  result?: unknown
  costUsd?: number
  auditHash: string
}
```

That's it. No claims, no handoffs, no work stealing, no contest windows. A simple state machine with 5 states.

### 3.2 🔴 CHALLENGE: "Ruflo DNA" is now just marketing

After three sessions of analysis:
- Session 2 found 96.5% of Ruflo is bloat
- Session 3 said "take ~2K lines, heavily adapted"
- Now Session 4 says the Claims pattern doesn't even match our problem

**What are we actually taking from Ruflo?** The concept of "typed domain events for state changes." That's not Ruflo DNA — that's event sourcing, a pattern from 2005 (Greg Young, CQRS/ES). Ruflo didn't invent it.

**Verdict: Drop the "Ruflo DNA" framing entirely.** We're building a standard approval-gate plugin using well-known patterns (event sourcing, state machines, risk assessment). Attributing this to Ruflo adds confusion without adding value.

---

## 4. Red-Team: Will Anyone Actually Want This?

### 4.1 ⚠️ CHALLENGE: The "auditable personal assistant" market may not exist

**Who wants this?**
- Enterprise compliance teams → They use Temporal + custom workflows, not OpenClaw plugins
- Security-conscious individuals → They already use OpenClaw's built-in exec approval
- Developers → They want LESS friction, not more approval gates
- Nag → Yes, but "we want it" ≠ "others want it"

**Counter-argument:** The research report identifies a real gap — no personal assistant has proper audit trails. But "gap" ≠ "demand." Sometimes gaps exist because nobody cares enough.

**Verdict: The target user is narrow but real.** Power users who:
1. Give their AI agent real capabilities (email, finances, deployments)
2. Want to gradually increase autonomy with safety rails
3. Need to demonstrate to others (boss, spouse, compliance) that the agent is controlled

This is a NICHE product, not a mass-market one. Which is fine — niche products can be great OSS contributions.

### 4.2 ⚠️ CHALLENGE: Friction kills adoption

Every approval prompt is a context switch. A user who has to approve 10 tool calls per task will disable Witness after day 1.

**Mitigation:**
- Smart defaults: reads are auto-approved, writes need review, deletes need approval
- Trust ramp-up: after N approved actions of type X, auto-approve future ones
- Configurable aggressiveness: `witness.mode = "audit-only" | "gate-writes" | "gate-all"`
- Batch approval: "Approve all 3 pending actions? [Y/n]"

**Risk level: HIGH.** This is the #1 adoption risk. The default configuration MUST be nearly invisible. Audit-only mode (log everything, block nothing) should be the default. Gating should be opt-in per tool or risk level.

---

## 5. Red-Team: Maintenance and Sustainability

### 5.1 ⚠️ CHALLENGE: OpenClaw plugin API stability

OpenClaw is under active development. The plugin hook system could change:
- Hook signatures may evolve
- New hooks added, old ones deprecated
- Internal APIs we depend on may be refactored
- The foundation (post-Steinberger) may change direction

**Mitigation:**
- Code against the typed interfaces, not internal implementations
- Pin to OpenClaw version ranges
- Contribute upstream to stabilize the plugin API
- Keep our codebase small (~3-5K lines) so updates are cheap

**Risk level: MEDIUM.** Manageable for a small plugin. Would be catastrophic for a 400K line fork.

### 5.2 ✅ ADVANTAGE: Small codebase = sustainable maintenance

A 3-5K line TypeScript plugin is maintainable by 1-2 people indefinitely. Compare:
- Ruflo fork (400K lines) → unmaintainable without a team
- OpenClaw fork (466K lines) → even worse
- Witness plugin (3-5K lines) → one person, one weekend per quarter

### 5.3 ⚠️ CHALLENGE: Who maintains this after the project?

If Nag loses interest, what happens?
- It's OSS (MIT), so others can fork
- Small codebase means low bus factor risk
- But realistically, most OSS plugins die when the author moves on

**Verdict:** Acceptable risk. Better to ship something useful and let it die naturally than to never ship at all.

---

## 6. Red-Team: Technical Risks

### 6.1 ⚠️ CHALLENGE: Hash-chain audit is overkill for personal use

SHA-256 hash chains make sense for compliance (SOC2, HIPAA) where you need to prove logs weren't tampered with. For a personal assistant:
- Who's the auditor? You're auditing yourself.
- What's the threat model? If an attacker modifies your SQLite, they own your machine — the hash chain is irrelevant.
- Is the complexity worth it? Hash chains add implementation complexity for marginal security benefit.

**Counter-argument:** Hash chains are trivial to implement (~50 lines) and provide a foundation for future enterprise features. They also make great demo material ("look, tamper-evident audit logs").

**Verdict: Keep it, but don't over-invest.** Simple implementation, nice-to-have, not critical path.

### 6.2 ⚠️ CHALLENGE: Risk assessment is the hardest unsolved problem

How do you automatically assess the risk of `exec("rm -rf /")` vs `exec("ls")`? Or `message(send, to="#general", "hello")` vs `message(send, to="#announcements", "@everyone server is shutting down")`?

**Options:**
1. **Static rules** — Hardcode risk levels per tool name (exec=high, read=low)
   - Simple but coarse. `exec("ls")` and `exec("rm -rf /")` get same risk level.
2. **Param analysis** — Parse params for danger signals (destructive commands, @everyone mentions, financial amounts)
   - Better but fragile. Regex/heuristic matching is never complete.
3. **LLM-based assessment** — Ask a cheap model "is this dangerous?"
   - Good accuracy but adds latency and cost to every tool call
4. **User-defined rules** — Let users configure per-tool risk levels and param patterns
   - Most flexible but requires user effort

**Recommendation:** Start with static rules (option 1) + user overrides (option 4). Add param analysis (option 2) as a v2 feature. Skip LLM-based assessment (too expensive for every tool call).

**Risk level: MEDIUM.** The initial implementation will be coarse. Refinement is iterative.

### 6.3 🔴 CHALLENGE: Re-execution after approval is fragile

When a tool call is blocked and later approved, re-executing it may fail because:
- Session context has changed
- The LLM has moved on to a different topic
- Params reference ephemeral state (e.g., "edit the file I just read")
- The approval came hours later and the task is no longer relevant

**Mitigation:**
- Store complete tool call params at block time (not just references)
- Add TTL to pending work orders (auto-reject after N minutes)
- Re-execute in the original session context when possible
- If re-execution fails, notify user with context

**Risk level: HIGH.** This is the second hardest technical problem (after risk assessment). The "block now, execute later" pattern creates temporal coupling that's inherently fragile.

---

## 7. Red-Team: Competitive Landscape

### 7.1 What if OpenClaw adds this natively?

OpenClaw already has exec approval dialogs. If they add formal approval queues, our plugin is redundant.

**Counter:** 
- OpenClaw moves slowly on governance features (it's community-driven now)
- Our plugin can prototype features that OpenClaw eventually adopts (best outcome)
- If OpenClaw adds it, we contributed to the ecosystem (also good)

### 7.2 What about LangGraph / CrewAI / Temporal?

These are full orchestration frameworks with HITL. Why not use them instead?

**Counter:**
- They require rearchitecting away from OpenClaw
- Nag uses OpenClaw daily — the value is in extending what he already uses
- A plugin is zero-friction adoption; switching frameworks is months of migration

---

## 8. Revised Risk Matrix

| Risk | Severity | Likelihood | Impact | Mitigation |
|------|----------|------------|--------|------------|
| Async approval UX is awkward | High | High | Users disable it | Audit-only default, smart auto-approval ramp |
| Re-execution after approval fails | High | Medium | Broken workflow | TTL on work orders, store full params, graceful degradation |
| Risk assessment is too coarse | Medium | High | False positives annoy users | Static rules + user overrides, iterate |
| OpenClaw plugin API breaks | Medium | Medium | Maintenance burden | Small codebase, typed interfaces, version pinning |
| Nobody wants this | Medium | Medium | Wasted effort | Ship fast, validate with real usage |
| Hash-chain complexity | Low | Low | Over-engineering | Trivial implementation (~50 lines) |
| Ruflo patent/IP issues | Low | Very Low | Legal | MIT license, we're not using Ruflo code anyway |

---

## 9. Strategic Conclusions

### What survived the red-team:
1. **Building as an OpenClaw plugin is correct.** The hook system exists, is typed, supports blocking. This is the right architecture.
2. **Small codebase (~3-5K lines) is the right scope.** Maintainable, focused, shippable.
3. **Audit logging is valuable even without gating.** Pure observation mode (log everything, block nothing) is useful standalone.
4. **The plugin API is robust enough.** `before_tool_call` with block/modify capabilities is exactly what we need.

### What needs to change:
1. **Drop "Ruflo DNA" framing.** We're not taking meaningful code or patterns from Ruflo. We're building standard event-sourced approval gates. Ruflo was useful for sparking the idea, but the implementation is our own.
2. **Default to audit-only mode.** Don't gate anything by default. Let users opt into approval queues per tool or risk level. Friction kills adoption.
3. **Simplify the work order model.** 5 states, not the full Claims lifecycle. No work stealing, no contest windows, no multi-agent coordination.
4. **Solve the re-execution problem before building.** This is the hardest technical challenge and needs a clear design before code is written.
5. **Risk assessment starts simple.** Static tool→risk mapping with user overrides. Don't try to be smart on day 1.

### The MVP is even smaller than we thought:

**Phase 1 (MVP):** Audit-only plugin
- `after_tool_call` hook → log every tool call to SQLite
- Hash-chain append (simple)
- `/witness` command to query audit log
- Zero friction, zero blocking, pure observation
- ~500-800 lines

**Phase 2:** Gating layer
- `before_tool_call` hook → risk assessment → block if needed
- Approval queue (SQLite-backed)
- Discord button for approve/reject
- Re-execution on approval
- ~1500-2000 additional lines

**Phase 3:** Trust and intelligence
- Trust tiers, auto-approval ramp, cost tracking
- ~1000-1500 additional lines

Total: ~3-4K lines across three phases.

---

## 10. Name Decision

**Witness** still works after red-teaming. It's:
- Accurate (it witnesses and records)
- Non-threatening (not "guard" or "gate" — those imply friction)
- Memorable
- Available as an npm package name (checked: `openclaw-witness` is available)

Alternative considered: **Ledger** (emphasizes the audit trail). But "Witness" is more evocative.

**Final name: Witness**

---

## 11. Next Session Plan (Session 5)

**Session 5: Write the manifesto — what we keep, strip, add. Name the project.**

With the red-team complete, Session 5 should:
1. Write the project README.md (the manifesto)
2. Define the exact MVP scope (Phase 1: audit-only)
3. Spec the SQLite schema for audit events
4. Spec the plugin registration and hook handlers
5. Create the project skeleton in `~/clawd/projects/new-claw/witness/`

This transitions from THINK to pre-PLAN — the manifesto IS the deliverable.

---

*Session duration: ~25 min analysis*
*Key finding: The strategy survives red-teaming but with significant simplifications. Drop Ruflo DNA, default to audit-only, solve re-execution before building.*
*Red flags: Async approval UX and re-execution fragility are the two hardest problems.*
