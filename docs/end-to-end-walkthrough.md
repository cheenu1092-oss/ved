# Ved — End-to-End Walkthrough & Interface Validation

> Session 28 · PLAN (5 of 5 — FINAL) · 2026-03-05
> Traces a complete user message through all 8 modules, validates every interface boundary, identifies gaps.
> Depends on: all prior PLAN docs (S24–S27) and THINK docs (S21–S23).

---

## 1. The Scenario

A Discord user (the owner, trust tier 4) sends:

> "What did I decide about the database migration strategy last week? Also, remind me to review the PR tomorrow."

This message requires:
- **RAG retrieval** — find the decision about database migration
- **Memory read** — check recent daily notes
- **Tool call** — create a reminder (needs MCP tool)
- **Memory write** — store the reminder as a fact and vault entity
- **Audit** — every step hash-chain logged

We'll trace this message through all 7 pipeline steps and 8 modules.

---

## 2. Step-by-Step Trace

### Step 0: Message Arrives at Discord

**Module:** `ved-channel` (DiscordAdapter)

```
Discord WebSocket → DiscordAdapter.onMessage handler
```

1. Discord.js fires `messageCreate` event.
2. `DiscordAdapter` constructs a `VedMessage`:
   ```typescript
   const msg: VedMessage = {
     id: ulid(),                        // "01HRXYZ..."
     channel: 'discord',
     author: '719990816659210360',       // Discord user ID
     content: 'What did I decide about the database migration...',
     attachments: [],
     replyTo: undefined,
     timestamp: Date.now(),
   };
   ```
3. Adapter calls the registered `onMessage` handler (set by `ChannelManager`).
4. `ChannelManager` forwards to `EventLoop` via `MessageQueue.enqueue(msg, 'high')`.

**Interface boundary:** `ChannelAdapter.onMessage → ChannelManager → MessageQueue.enqueue(VedMessage, MessagePriority)`

**Validation:** ✅ Types match. `VedMessage` is defined in `ved-types`. `MessagePriority` = `'high'` for direct user messages.

---

### Step 1: RECEIVE

**Module:** `ved-core` (EventLoop)

```
EventLoop main loop → dequeue → persist → create/resume session
```

1. `EventLoop.run()` is in its `while (running)` loop.
2. `MessageQueue.dequeue()` returns our message (highest priority).
3. **Crash-safe persistence:** INSERT into `inbox` table:
   ```sql
   INSERT INTO inbox (id, channel, channel_id, author_id, author_name, content,
                      attachments, reply_to, metadata, received_at, processed)
   VALUES (?, 'discord', ?, ?, ?, ?, '[]', NULL, '{}', ?, 0);
   ```
4. **Session lookup:** `SessionManager.getOrCreate('discord', '719990816659210360')`.
   - Checks `sessions` table for an active session with this channel+author.
   - If found and `status = 'active'`: resume (load `working_memory` JSON from column).
   - If not found or `status = 'closed'`: create new session, `WorkingMemory` initialized empty.
   - Updates `last_active` timestamp.
5. **Audit:**
   ```typescript
   AuditLog.log({
     eventType: 'message_received',
     actor: '719990816659210360',
     detail: { messageId: msg.id, channel: 'discord', contentLength: msg.content.length }
   });
   ```
   → Returns `AuditEntry` with hash chain: `SHA-256(prevHash + timestamp + 'message_received' + detail)`.

**Interface boundaries:**
- `MessageQueue.dequeue() → VedMessage | null` ✅
- `SessionManager.getOrCreate(ChannelId, AuthorId) → Session` ✅
- `AuditLog.log(AuditEntryInput) → AuditEntry` ✅
- SQLite `inbox` INSERT matches `database-schema.md` DDL ✅

**Validation:** ✅ All types align. `inbox` table has all needed columns. Session working memory deserialization via `WorkingMemory.deserialize(data)`.

---

### Step 2: ENRICH

**Modules:** `ved-core` (EventLoop), `ved-memory` (MemoryManager), `ved-rag` (RagPipeline)

```
Load T1 → RAG query (T3+T4) → Read T2 → Assemble prompt
```

#### 2a. Load Working Memory (T1)

```typescript
const wm: WorkingMemory = session.workingMemory;
// Contains: recent messages from this session, active facts
// wm.messages = [...previous conversation messages...]
// wm.facts = Map { 'current_project' → 'ved', ... }
```

Add the new user message to working memory:
```typescript
wm.addMessage({
  role: 'user',
  content: msg.content,
  timestamp: msg.timestamp,
});
```

**Interface:** `WorkingMemory.addMessage(ConversationMessage)` ✅

#### 2b. RAG Query (T3 + T4)

```typescript
const ragContext: RetrievalContext = await ragPipeline.retrieve(
  msg.content,
  {
    vectorTopK: 10,    // from config.rag.vectorTopK
    ftsTopK: 10,       // from config.rag.ftsTopK
    graphMaxDepth: 1,  // from config.rag.graphMaxDepth
    graphMaxNodes: 5,
    maxContextTokens: 4096,
  }
);
```

**Inside `RagPipeline.retrieve()`:**

1. **Embed the query:**
   ```typescript
   const queryVec: Float32Array = await embedder.embedOne(msg.content);
   // Calls Ollama: POST http://localhost:11434/api/embeddings
   // model: 'nomic-embed-text', returns 768-dim vector
   ```

2. **Vector search:**
   ```sql
   SELECT c.id, c.file_path, c.heading, c.content,
          vec_distance_cosine(v.embedding, ?) AS distance
   FROM vec_chunks v
   JOIN chunks c ON c.rowid = v.rowid
   ORDER BY distance ASC
   LIMIT 10;
   ```
   Results: `VectorSearchResult[]` with normalized scores (1 - distance).

3. **FTS5 search:**
   ```sql
   SELECT c.id, c.file_path, c.heading, c.content,
          rank AS bm25_rank
   FROM chunks_fts
   JOIN chunks c ON c.rowid = chunks_fts.rowid
   WHERE chunks_fts MATCH 'database migration strategy decide'
   ORDER BY rank
   LIMIT 10;
   ```
   Results: `FtsSearchResult[]` with normalized scores.

4. **Graph walk:**
   - Seeds = top files from vector + FTS results (deduplicated).
   - For each seed file, parse `[[wikilinks]]` from content.
   - Resolve wikilinks to vault file paths via `VaultManager.resolveLink()`.
   - Load linked files up to `maxDepth: 1`, `maxNodes: 5`.
   - Score by: `backlinkCount / (depth + 1)`.
   Results: `GraphSearchResult[]`.

5. **RRF Fusion:**
   ```
   For each file across all three result sets:
     rrfScore = Σ(1 / (k + rank_in_source))   where k = 60
   ```
   Merge, sort by `rrfScore` descending.

6. **Token budget trim:**
   - Walk merged results top-down.
   - Accumulate token counts until `maxContextTokens` (4096) reached.
   - Truncate.

7. **Format context:**
   ```typescript
   return {
     text: formatContextString(results),  // Markdown-formatted context
     results: [...],
     tokenCount: 3200,
     metrics: { vectorSearchMs: 15, ftsSearchMs: 8, graphWalkMs: 12, ... }
   };
   ```

**Expected RAG results for our query:** The vault file `decisions/2026-02-27-migration-strategy.md` (or similar) should rank high in both vector and FTS. Graph walk may pull in related entities like `projects/ved.md` via wikilinks.

**Interface boundaries:**
- `RagPipeline.retrieve(string, RetrieveOptions) → RetrievalContext` ✅
- `Embedder.embedOne(string) → Float32Array` ✅
- `VaultManager.resolveLink(string) → string | null` (for graph walk) ✅
- `VaultManager.readFile(string) → VaultFile` (for graph walk content) ✅
- SQLite queries match `chunks`, `vec_chunks`, `chunks_fts` tables from DDL ✅

#### 2c. Read Today's Daily Note (T2)

```typescript
const dailyNote: VaultFile = await memoryManager.getTodayNote();
// Reads ~/ved-vault/daily/2026-03-05.md (today)
// If doesn't exist, creates from template
```

**Interface:** `MemoryManager.getTodayNote() → VaultFile` ✅

#### 2d. Assemble Prompt

```typescript
const systemPrompt = buildSystemPrompt(config);
// Includes: Ved identity, trust tier info, date/time, tool usage instructions

const prompt: LLMRequest = {
  systemPrompt,
  messages: [
    // Working memory context (T1 facts as system message)
    { role: 'system', content: wm.toPromptSection(), timestamp: now },
    // RAG context (T3 + T4 retrieval)
    { role: 'system', content: `## Relevant Knowledge\n${ragContext.text}`, timestamp: now },
    // Today's daily note excerpt (T2, if relevant)
    { role: 'system', content: `## Today's Notes\n${dailyNote.body}`, timestamp: now },
    // Conversation history
    ...wm.messages,
  ],
  tools: filteredTools,  // from MCP (see step 2e)
  maxTokens: config.llm.maxTokensPerMessage,
  temperature: config.llm.temperature,
};
```

**Token budget allocation:**
- T1 (working memory): priority 1 — gets full allocation (up to `workingMemoryMaxTokens: 8192`)
- T3/T4 (RAG context): priority 2 — up to `ragContextMaxTokens: 4096`
- T2 (daily note): priority 3 — whatever remains

**Interface:** `WorkingMemory.toPromptSection() → string` ✅

#### 2e. Filter MCP Tools for This Session

```typescript
const allTools: MCPToolDefinition[] = mcpClient.tools;
// Cached from discovery — e.g. ['@ved/mcp-memory.remember', '@ved/mcp-memory.recall', 
//   'reminders.create', 'reminders.list', 'fs.read', 'fs.write', ...]

const filteredTools = allTools.filter(tool => {
  const decision = trustEngine.evaluate(
    { id: '', tool: tool.name, params: {} },  // dummy call for filtering
    trustTier,  // 4 (owner)
    tool.riskLevel
  );
  return decision !== 'deny';
});
// For tier 4 (owner): all tools pass except 'deny' (nothing is denied for owner)
```

**Interface:** `MCPClient.tools → MCPToolDefinition[]` ✅ (readonly getter, cached)
**Interface:** `TrustEngine.evaluate(ToolCall, TrustTier, RiskLevel) → TrustDecision` ✅

**Validation note:** The S27 MCP spec says tools are filtered before sending to LLM. The filtering logic uses the trust matrix. For tier 4 owner, only `critical` risk tools need `approve` — they're still shown to the LLM but will need approval at execution time. Correct.

---

### Step 3: DECIDE

**Module:** `ved-llm` (LLMClient)

```
Assembled prompt → LLM API call → Parse response
```

1. **Format request for provider:**
   ```typescript
   const llmResponse: LLMResponse = await llmClient.chat(prompt);
   ```
   Internally, the Anthropic adapter:
   - Converts `messages` to Anthropic format (system prompt separate, tool definitions as `tools` array).
   - Converts `MCPToolDefinition[]` to Anthropic's tool format:
     ```typescript
     tools: filteredTools.map(t => ({
       name: t.name,
       description: t.description,
       input_schema: t.inputSchema,
     }))
     ```
   - Sends HTTP POST to `https://api.anthropic.com/v1/messages`.

2. **Parse response:**
   The LLM returns a multi-part response:
   - **Text:** "Based on last week's decisions, you chose a forward-only migration strategy with checksums..."
   - **Tool call:** `{ tool: 'reminders.create', params: { text: 'Review PR', when: '2026-03-06' } }`
   - **Memory ops:** `[{ type: 'working_set', action: 'add', key: 'last_query_topic', value: 'database migration' }]`

   Parsed into `LLMDecision`:
   ```typescript
   const decision: LLMDecision = {
     response: "Based on last week's decisions, you chose...",
     toolCalls: [{
       id: 'call_abc123',
       tool: 'reminders.create',
       params: { text: 'Review PR', when: '2026-03-06' },
     }],
     memoryOps: [{
       type: 'working_set',
       action: 'add',
       key: 'last_query_topic',
       value: 'database migration',
     }],
     reasoning: 'User asks about migration decision + reminder creation...',
     usage: { promptTokens: 5200, completionTokens: 350, totalTokens: 5550, model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
   };
   ```

3. **Audit the LLM call:**
   ```typescript
   AuditLog.log({ eventType: 'llm_call', detail: { model, promptTokens: 5200, messageId: msg.id } });
   AuditLog.log({ eventType: 'llm_response', detail: { completionTokens: 350, hasToolCalls: true, toolCount: 1 } });
   ```

**Interface boundaries:**
- `LLMClient.chat(LLMRequest) → LLMResponse` ✅
- `LLMResponse.decision → LLMDecision` ✅
- `LLMDecision.toolCalls → ToolCall[]` ✅
- `LLMDecision.memoryOps → MemoryOp[]` ✅
- `AuditLog.log(AuditEntryInput) → AuditEntry` ✅

**Validation:** ✅ The `LLMRequest` type includes `tools?: MCPToolDefinition[]` which matches. The `LLMResponse` wraps `LLMDecision` with metadata. Provider adapter handles format conversion.

**Open question resolved:** How does the LLM express memory operations? Via the tool interface. `@ved/mcp-memory.remember` is an MCP tool that the LLM calls. The `memoryOps` field in `LLMDecision` is populated by `ved-core` after it detects that a tool call targets a memory tool. This keeps the LLM interface clean — it just calls tools.

**⚠️ GAP FOUND #1:** The `LLMDecision.memoryOps` field implies the LLM can directly express memory operations. But per S27, memory is accessed via MCP tools (`@ved/mcp-memory.*`). There are TWO paths:
- **Path A:** LLM calls `@ved/mcp-memory.remember` → treated as a tool call → executed → result triggers memory write.
- **Path B:** `memoryOps` in `LLMDecision` is populated by core after tool execution, not by the LLM directly.

**Resolution:** `memoryOps` should be **output of the RECORD step**, not parsed from LLM response. The LLM uses memory MCP tools. Core collects all memory mutations from tool execution results into `memoryOps` for auditing. Update: the field should be empty in the raw `LLMDecision` and populated in RECORD. This is a small type refinement — `LLMDecision.memoryOps` should be renamed or documented as "populated after tool execution."

---

### Step 4: ACT

**Modules:** `ved-core` (EventLoop), `ved-trust` (TrustEngine), `ved-mcp` (MCPClient)

```
For each tool call → trust gate → execute or queue → collect results
```

#### 4a. Trust Evaluation

```typescript
const toolCall = decision.toolCalls[0]; // reminders.create
const toolDef = mcpClient.getTool('reminders.create');
const riskLevel = toolDef.riskLevel; // 'medium' (creates external state)

const trustDecision = trustEngine.evaluate(toolCall, 4, 'medium');
// Trust matrix[4]['medium'] = 'auto'
// → Auto-approved
```

**Audit:**
```typescript
AuditLog.log({
  eventType: 'trust_decision',
  detail: { tool: 'reminders.create', tier: 4, risk: 'medium', decision: 'auto' }
});
```

#### 4b. Create Work Order

Even for auto-approved calls, a work order is created for audit trail:
```typescript
const wo: WorkOrder = await trustEngine.createWorkOrder(
  toolCall,
  msg.id,
  4,      // trust tier
  'medium' // risk level
);
// wo.status = 'approved' (auto-approved)
```

**Interface:** `TrustEngine.createWorkOrder(ToolCall, VedId, TrustTier, RiskLevel) → WorkOrder` ✅

#### 4c. Execute via MCP

```typescript
const result: ToolResult = await mcpClient.executeTool(toolCall);
```

**Inside `MCPClient.executeTool()`:**

1. **Route to server:** Parse tool name `'reminders.create'` → server `'reminders'`, tool `'create'`.
2. **Ensure connected:** Check server state. If `IDLE`, transition to `CONNECTING`:
   - For stdio: spawn child process, JSON-RPC handshake (`initialize` → `initialized`).
   - For HTTP: open SSE stream, POST `initialize`.
   - Transition to `READY`.
3. **Send JSON-RPC call:**
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "tools/call",
     "params": {
       "name": "create",
       "arguments": { "text": "Review PR", "when": "2026-03-06" }
     }
   }
   ```
4. **Receive result:**
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "result": {
       "content": [{ "type": "text", "text": "Reminder created: 'Review PR' for 2026-03-06" }]
     }
   }
   ```
5. **Convert to `ToolResult`:**
   ```typescript
   const result: ToolResult = {
     callId: 'call_abc123',
     tool: 'reminders.create',
     success: true,
     result: "Reminder created: 'Review PR' for 2026-03-06",
     durationMs: 45,
   };
   ```

**Audit:**
```typescript
AuditLog.log({
  eventType: 'tool_executed',
  detail: { tool: 'reminders.create', workOrderId: wo.id, success: true, durationMs: 45 }
});
```

**Update work order:**
```typescript
trustEngine.updateStatus(wo.id, 'completed', result.result);
```

#### 4d. Agentic Loop Check

Does the LLM need to see the tool result and decide again?

- The LLM's original response included both text AND a tool call.
- After tool execution, we check `finishReason`:
  - If `'tool_use'`: LLM wants to see results → loop back to DECIDE with tool results appended.
  - If `'stop'`: LLM is done → proceed to RECORD.

In our scenario: `finishReason = 'tool_use'` (Anthropic returns this when tool calls are present). So we loop:

```typescript
// Append tool result to conversation
wm.addMessage({
  role: 'tool',
  content: result.result,
  name: 'reminders.create',
  toolCallId: 'call_abc123',
  timestamp: Date.now(),
});

// Re-call LLM with updated context
const followUp: LLMResponse = await llmClient.chat({
  ...prompt,
  messages: [...prompt.messages, assistantToolCallMsg, toolResultMsg],
  toolResults: [result],
});
```

The LLM now responds with final text (no more tool calls):
```
"Last week (Feb 27), you decided on a **forward-only migration strategy** with checksums — no down migrations, each SQL file runs once and is tracked by version number with a SHA-256 checksum. I've also set a reminder for tomorrow to review the PR."
```

`finishReason = 'stop'` → exit agentic loop.

**Interface boundaries:**
- `TrustEngine.evaluate(ToolCall, TrustTier, RiskLevel) → TrustDecision` ✅
- `MCPClient.executeTool(ToolCall) → ToolResult` ✅
- `TrustEngine.createWorkOrder(...) → WorkOrder` ✅
- `TrustEngine.updateStatus(VedId, ActionStatus, ...) → WorkOrder` ✅
- `LLMClient.chat(LLMRequest) → LLMResponse` (second call with tool results) ✅

**Validation:** ✅ The agentic loop follows event-loop.md (S21) design. Max 10 iterations enforced. Each iteration gets its own audit entries.

---

### Step 5: RECORD

**Modules:** `ved-core` (EventLoop), `ved-memory` (MemoryManager), `ved-audit` (AuditLog)

```
Execute memory ops → audit everything → check anchor interval
```

#### 5a. Execute Memory Operations

The LLM called `@ved/mcp-memory.remember` as part of the tool calls (or `ved-core` synthesizes memory ops from the conversation). In our scenario, the core extracts:

```typescript
const memoryOps: MemoryOp[] = [
  // T1: Working memory fact
  {
    type: 'working_set',
    action: 'add',
    key: 'last_query_topic',
    value: 'database migration strategy',
  },
  // T3: Update the decisions entity (link to the reminder)
  {
    type: 'semantic_upsert',
    path: 'decisions/2026-02-27-migration-strategy.md',
    frontmatter: { updated: '2026-03-05', confidence: 'high' },
    body: undefined,  // don't change body
    links: [],
  },
];

const results: MemoryOpResult[] = await memoryManager.executeOps(memoryOps, msg.author);
```

**Inside `MemoryManager.executeOps()`:**

For each op:

1. **WorkingMemoryOp:**
   ```typescript
   wm.setFact('last_query_topic', 'database migration strategy');
   await auditLog.log({ eventType: 'memory_t1_write', detail: { key, value, action: 'add' } });
   ```

2. **SemanticUpsertOp:**
   ```typescript
   await vault.updateFile('decisions/2026-02-27-migration-strategy.md', {
     frontmatter: { updated: '2026-03-05', confidence: 'high' },
     mergeFrontmatter: true,
   });
   await auditLog.log({ eventType: 'memory_t3_upsert', detail: { path, changes } });
   ragPipeline.enqueueReindex('decisions/2026-02-27-migration-strategy.md');
   vault.git.markDirty('decisions/2026-02-27-migration-strategy.md');
   ```

**Interface boundaries:**
- `MemoryManager.executeOps(MemoryOp[], string) → MemoryOpResult[]` ✅
- `VaultManager.updateFile(string, VaultFileUpdate) → void` ✅
- `RagPipeline.enqueueReindex(string) → void` ✅
- `VaultGit.markDirty(string) → void` ✅
- `AuditLog.log(AuditEntryInput) → AuditEntry` ✅

#### 5b. Anchor Check

```typescript
const entryCount = await auditLog.count();
if (entryCount % config.audit.anchorInterval === 0) {
  await auditLog.anchor();
  // Creates HMAC of chain head, stores in anchors table
}
```

**Interface:** `AuditLog.anchor() → AnchorResult` ✅

**Validation:** ✅ All memory operations flow through `MemoryManager` which coordinates vault writes, audit logging, RAG re-indexing, and git marking. Single responsibility per module, clean interfaces.

---

### Step 6: RESPOND

**Modules:** `ved-core` (EventLoop), `ved-channel` (ChannelManager)

```
Format response → send via channel → audit
```

1. **Build response:**
   ```typescript
   const response: VedResponse = {
     id: ulid(),
     inReplyTo: msg.id,
     content: "Last week (Feb 27), you decided on a **forward-only migration strategy** with checksums...",
     actions: [wo],  // completed work orders
     memoryOps: memoryOps,
     channelRef: msg.channel,
   };
   ```

2. **Send via channel:**
   ```typescript
   await channelManager.send('discord', response);
   ```
   `ChannelManager` routes to `DiscordAdapter.send(response)`:
   - Formats Markdown for Discord (already compatible).
   - Sends via Discord.js `channel.send()` or `message.reply()`.

3. **Audit:**
   ```typescript
   AuditLog.log({
     eventType: 'message_sent',
     actor: 'ved',
     detail: { responseId: response.id, inReplyTo: msg.id, channel: 'discord', contentLength: response.content.length }
   });
   ```

4. **Mark inbox as processed:**
   ```sql
   UPDATE inbox SET processed = 1 WHERE id = ?;
   ```

**Interface boundaries:**
- `ChannelManager.send(ChannelId, VedResponse) → void` ✅
- `AuditLog.log(AuditEntryInput) → AuditEntry` ✅

**Validation:** ✅ `VedResponse` matches type definition. Discord adapter handles formatting.

---

### Step 7: MAINTAIN

**Modules:** `ved-core` (EventLoop), `ved-memory` (MemoryManager), `ved-rag` (RagPipeline)

```
Compress if needed → drain RAG queue → git flush if timer → check session idle
```

This runs after every message, asynchronously (non-blocking for next message).

#### 7a. T1 → T2 Compression Check

```typescript
if (wm.tokenCount > config.memory.compressionThreshold) {
  // 6000 tokens threshold
  const compressResult = await memoryManager.compressToDaily(session.id);
  // Uses LLMClient.compress() to summarize old messages
  // Appends summary to daily/2026-03-05.md
  // Trims working memory, keeping recent messages + facts
}
```

In our case: `wm.tokenCount ≈ 2000` (short conversation), so compression doesn't trigger.

**Interface:** `MemoryManager.compressToDaily(VedId) → CompressResult` ✅

#### 7b. Drain RAG Re-index Queue

```typescript
await ragPipeline.drainQueue();
// Processes any files enqueued during RECORD step
// For our scenario: re-indexes decisions/2026-02-27-migration-strategy.md
// 1. Re-chunk the file
// 2. Delete old chunks from chunks + vec_chunks + chunks_fts
// 3. Insert new chunks
// 4. Embed new chunks via Ollama
// 5. Insert new vectors into vec_chunks
// Audit: AuditLog.log({ eventType: 'rag_reindex', ... })
```

**Interface:** `RagPipeline.drainQueue() → void` ✅

#### 7c. Git Flush (Timer-Based)

```typescript
if (vault.git.dirtyCount > 0 && timeSinceLastCommit > config.memory.gitAutoCommitIntervalMinutes * 60_000) {
  await vault.git.flush('ved: auto-commit after user interaction');
  // git add <dirty files> → git commit -m "..."
}
```

**Interface:** `VaultGit.flush(string?) → void` ✅

#### 7d. Session Idle Check

```typescript
await sessionManager.closeStale(config.memory.sessionIdleMinutes);
// Checks all sessions where last_active < now - 30min
// For stale sessions: compress T1 → T2, mark status = 'closed'
```

**Interface:** `SessionManager.closeStale(number) → number` ✅

#### 7e. Persist Working Memory

```typescript
await memoryManager.persistWorkingMemory(session.id);
// Serializes current T1 state to sessions.working_memory column
// Crash-safe: if Ved dies before next message, T1 is recoverable
```

**Interface:** `MemoryManager.persistWorkingMemory(VedId) → void` ✅

---

## 3. Audit Chain Summary

For our single message, the audit log captures (in order):

| # | Event Type | Actor | Key Detail |
|---|-----------|-------|------------|
| 1 | `message_received` | user | messageId, channel |
| 2 | `llm_call` | ved | model, promptTokens |
| 3 | `llm_response` | ved | completionTokens, hasToolCalls |
| 4 | `trust_decision` | ved | tool, tier, risk, decision=auto |
| 5 | `tool_request` | ved | tool=reminders.create, workOrderId |
| 6 | `tool_executed` | ved | tool, success, durationMs |
| 7 | `llm_call` | ved | (2nd call with tool results) |
| 8 | `llm_response` | ved | final text, no tool calls |
| 9 | `memory_t1_write` | ved | key=last_query_topic |
| 10 | `memory_t3_upsert` | ved | path=decisions/... |
| 11 | `rag_reindex` | ved | path=decisions/... |
| 12 | `message_sent` | ved | responseId, channel |

**12 audit entries** for one user message. Each entry is hash-chained: `hash[n] = SHA-256(hash[n-1] + timestamp + eventType + detail)`.

---

## 4. Interface Validation Summary

### All Module Boundaries Verified

| From → To | Interface | Status |
|-----------|-----------|--------|
| ChannelAdapter → ChannelManager | `onMessage(VedMessage)` | ✅ |
| ChannelManager → MessageQueue | `enqueue(VedMessage, MessagePriority)` | ✅ |
| EventLoop → MessageQueue | `dequeue() → VedMessage` | ✅ |
| EventLoop → SessionManager | `getOrCreate(ChannelId, AuthorId) → Session` | ✅ |
| EventLoop → AuditLog | `log(AuditEntryInput) → AuditEntry` | ✅ |
| EventLoop → MemoryManager | `getWorkingMemory(VedId) → WorkingMemory` | ✅ |
| EventLoop → RagPipeline | `retrieve(string, options) → RetrievalContext` | ✅ |
| EventLoop → LLMClient | `chat(LLMRequest) → LLMResponse` | ✅ |
| EventLoop → TrustEngine | `evaluate(ToolCall, TrustTier, RiskLevel) → TrustDecision` | ✅ |
| EventLoop → MCPClient | `executeTool(ToolCall) → ToolResult` | ✅ |
| EventLoop → ChannelManager | `send(ChannelId, VedResponse)` | ✅ |
| MemoryManager → VaultManager | `updateFile(string, VaultFileUpdate)` | ✅ |
| MemoryManager → AuditLog | `log(AuditEntryInput)` | ✅ |
| MemoryManager → RagPipeline | `enqueueReindex(string)` | ✅ |
| MemoryManager → VaultGit | `markDirty(string)` | ✅ |
| MemoryManager → LLMClient | `compress(string, string) → string` | ✅ |
| RagPipeline → Embedder | `embedOne(string) → Float32Array` | ✅ |
| RagPipeline → VaultManager | `resolveLink(string), readFile(string)` | ✅ |
| RagPipeline → AuditLog | `log(AuditEntryInput)` | ✅ |
| TrustEngine → AuditLog | `log(AuditEntryInput)` | ✅ |
| MCPClient → Transport | `send(method, params) → unknown` | ✅ |

**Result: 21 interface boundaries traced. All type-compatible.**

---

## 5. Gaps, Clarifications & Refinements

### GAP #1: `LLMDecision.memoryOps` Ambiguity (MEDIUM)

**Problem:** `LLMDecision` has a `memoryOps` field, but the LLM doesn't directly emit memory operations — it calls `@ved/mcp-memory.*` tools instead (S27 design).

**Resolution:** Two options:
- **Option A (recommended):** Remove `memoryOps` from `LLMDecision`. Memory mutations happen via MCP tool execution. Core collects them from tool results during RECORD.
- **Option B:** Keep `memoryOps` as a convenience field populated by `ved-core` after it recognizes memory tool calls and translates them. The LLM never fills it directly.

**Decision:** **Option B.** Keep the field but document it as "populated by EventLoop after tool execution, never by LLM parser." This is useful for the RECORD step to have a clean list of all memory mutations. Add a comment to the type.

### GAP #2: Memory Extraction Timing (LOW)

**Problem:** When does Ved extract entities/facts from conversations to create T3 vault files? The MAINTAIN step mentions it, but the `LLMClient.extract()` method isn't called anywhere in the trace.

**Resolution:** Entity extraction happens in MAINTAIN, not during the message pipeline:
1. After responding, if the conversation contains potentially extractable knowledge (names, decisions, facts).
2. `ved-core` calls `LLMClient.extract(conversationText, instructions)` with the recent conversation.
3. For each extracted entity/decision, `MemoryManager.upsertEntity()` is called.
4. This is **background, non-blocking, and not on every message** — only when the conversation warrants it (heuristic: new names mentioned, explicit "remember this", decisions made).

**Add to design:** A `shouldExtract(messages: ConversationMessage[]) → boolean` heuristic in `ved-core`. Simple v1: extract if conversation contains more than 5 user messages, or if keywords like "decide", "remember", "important" appear.

### GAP #3: Approval Flow — Channel Routing (LOW)

**Problem:** When a tool call needs approval, `ChannelManager.notifyApproval()` is called. But where does the user's approval response come back? It enters as a regular `VedMessage` through the channel.

**Resolution:** Already handled — the EventLoop's RECEIVE step checks for pending work orders. If the incoming message matches an approval pattern (e.g., "approve", "reject", referencing a work order ID), it's handled as an approval rather than a new conversation message.

**Add to design:** An `isApprovalResponse(msg: VedMessage) → WorkOrder | null` function in `ved-core` that checks:
1. Are there pending work orders?
2. Does the message author have sufficient trust to approve?
3. Does the message content match approval patterns ("yes", "approve", "reject", "no")?

### GAP #4: Tool Namespacing in LLM Format (LOW)

**Problem:** MCP tools are namespaced as `server.tool` (e.g., `reminders.create`). But Anthropic's tool-use format uses `name` as a flat string. Does the LLM see `reminders.create` or just `create`?

**Resolution:** Already addressed in S27: "Tool names are `{server}.{tool}` everywhere, including what the LLM sees." The period is valid in tool names for Anthropic and OpenAI APIs. No conflict.

### GAP #5: Error Recovery — Mid-Pipeline Crash (LOW)

**Problem:** If Ved crashes between steps (e.g., after DECIDE but before RECORD), what happens on restart?

**Resolution:** Already designed in S21 (event-loop.md):
1. `inbox` table has `processed = 0` for unfinished messages.
2. On restart, `EventLoop` queries `SELECT * FROM inbox WHERE processed = 0 ORDER BY received_at`.
3. Reprocesses from RECEIVE. LLM call is repeated (tool calls may be re-executed if not idempotent — acceptable for v1).
4. Work orders in `pending` state are expired via `TrustEngine.expireStale()`.

**No gap** — this is already covered.

### GAP #6: Config Validation Timing (TRIVIAL)

**Problem:** When does config validation run? If `config.yaml` is malformed, does Ved fail at startup or silently use defaults?

**Resolution:** Already addressed in S26: "Fail fast. 16 validation rules run at startup. Any failure = VedError with specific code (CONFIG_*). Ved does not start with invalid config."

**No gap** — already covered.

---

## 6. Pre-BUILD Checklist

Everything needed before writing code:

| Document | Content | Status |
|----------|---------|--------|
| `event-loop.md` (S21) | 7-step pipeline, agentic loop, crash recovery | ✅ |
| `obsidian-memory.md` (S22) | Vault structure, YAML schemas, wikilink conventions | ✅ |
| `rag-pipeline.md` (S23) | Chunking, embedding, RRF fusion, index maintenance | ✅ |
| `module-interfaces.md` (S24) | All 8 module interfaces, shared types, file structure | ✅ |
| `database-schema.md` (S25) | 16 tables, migration system, indexes, lifecycle rules | ✅ |
| `config-errors-logging.md` (S26) | Config schema, 42 error codes, structured logging | ✅ |
| `mcp-integration.md` (S27) | Server lifecycle, transports, permissions, built-in servers | ✅ |
| `end-to-end-walkthrough.md` (S28) | Full message trace, interface validation, gap analysis | ✅ |

### Design Document Stats
| Metric | Value |
|--------|-------|
| Total design docs | 8 |
| Total doc size | ~225 KB |
| Interfaces specified | 21 module boundaries |
| Types defined | ~60 TypeScript interfaces |
| SQL tables | 16 |
| Error codes | 42 |
| Estimated LoC | ~7,700 |
| External dependencies | 6 |

### Build Order (Sessions 29+)

Based on dependency graph and this walkthrough:

| Session | Module(s) | Why This Order |
|---------|-----------|----------------|
| 29 | `ved-types` + `ved-audit` + `ved-trust` + DB schema | Foundation. Types first. Audit + trust are reused from Witness. |
| 30 | `ved-core` (EventLoop, Session, Queue, WorkingMemory) | Hub module. Needs types + audit. |
| 31 | `ved-memory` (VaultManager, MemoryManager, templates) | Largest module. Needs audit. |
| 32 | `ved-rag` (Embedder, Chunker, Pipeline, FTS+vector search) | Needs vault files to exist. |
| 33 | `ved-llm` (LLMClient, provider adapters) | Needs types only. Could be earlier, but testing needs memory+rag. |
| 34 | `ved-mcp` (MCPClient, transports) + `ved-channel` (Discord, CLI) | Edges. Last because they're adapters. |

### Acceptance Criteria for BUILD Phase

Each module is "done" when:
1. ✅ All interface methods implemented per `module-interfaces.md`
2. ✅ Unit tests pass (at least happy path + one error case per method)
3. ✅ All SQLite operations use prepared statements
4. ✅ Every public method that mutates state logs to `ved-audit`
5. ✅ TypeScript compiles with `strict: true`
6. ✅ Runs in Docker (no host dependencies except Ollama for RAG)

---

## 7. Final PLAN Phase Review

### What We've Designed (Sessions 21-28)

**THINK (S21-23):** Core architecture — event loop, Obsidian memory, RAG pipeline. The "what" and "why."

**PLAN (S24-28):** Detailed specifications — types, interfaces, schemas, config, errors, MCP, end-to-end validation. The "how."

### What We're Confident About
- **Event loop architecture** — Simple, single-threaded, crash-safe. Well-suited for personal assistant.
- **Memory hierarchy** — Obsidian vault for T2/T3 is genuinely novel. Human-readable, editable, visualizable.
- **Audit chain** — Reused from Witness with 393 tests. Proven.
- **Trust engine** — Clean 4×4 matrix, work order queue. Reused from Witness.
- **MCP-native tools** — Clean separation. Memory as MCP tool unifies the interface.
- **RAG pipeline** — Three-path retrieval with RRF is well-established. Heading-based chunking fits Obsidian well.
- **Size target** — 7,700 LoC estimate is comfortably under 10K.

### What We'll Learn During BUILD
- Exact performance of sqlite-vec for 768-dim vectors at vault scale
- Whether heading-based chunking needs adjustment for real conversations
- Discord.js event handling patterns (reconnect, rate limits)
- Real-world token budgets for prompt assembly
- The `shouldExtract()` heuristic for T3 entity extraction

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| sqlite-vec perf at scale | Low | Medium | Benchmark early (S32). Fallback: separate vector file. |
| Ollama embedding latency | Low | Low | Async queue. Re-index is non-blocking. |
| LLM tool-use parsing edge cases | Medium | Medium | Extensive test fixtures per provider. |
| Obsidian vault conflicts (human + Ved editing same file) | Medium | Low | Git merge strategy. Ved yields to human edits. |
| Token budget overflows | Medium | Medium | Hard limits + graceful truncation. Test with large conversations. |

---

**PLAN PHASE COMPLETE. Ready for BUILD.**

*Next session (29): `ved-types` + `ved-audit` + `ved-trust` + database schema — the foundation.*
