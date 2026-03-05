# Ved Core Event Loop — Design Document

**Session:** 21  
**Phase:** THINK  
**Date:** 2026-03-04  

---

## 1. Design Principles

1. **Single-threaded event loop** — Node.js style. No threads, no race conditions, no locks.
2. **Message-driven** — Everything is a message. Channels produce them, core processes them.
3. **Pipeline architecture** — Each message flows through a fixed pipeline: receive → enrich → decide → act → record.
4. **Crash-safe** — Every state mutation is journaled to SQLite before execution. On restart, replay incomplete work orders.
5. **No framework dependencies** — Just TypeScript, SQLite (better-sqlite3), and the Node.js runtime.

---

## 2. Core Types

```typescript
// === Messages ===

interface VedMessage {
  id: string;               // ULID — sortable, unique
  channel: ChannelId;       // 'discord' | 'cli' | 'push' | 'cron'
  author: AuthorId;         // who sent it (user ID or 'system')
  content: string;          // raw text
  attachments?: Attachment[];
  replyTo?: string;         // message ID this replies to
  timestamp: number;        // unix ms
}

interface VedResponse {
  id: string;
  inReplyTo: string;        // VedMessage.id
  content: string;          // text to send back
  actions: AuditedAction[]; // tool calls that were made
  memoryOps: MemoryOp[];    // memory mutations that occurred
}

// === Actions ===

type ActionStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed';

interface WorkOrder {
  id: string;               // ULID
  messageId: string;        // originating message
  tool: string;             // MCP tool name
  params: Record<string, unknown>;
  riskLevel: RiskLevel;     // 'low' | 'medium' | 'high' | 'critical'
  status: ActionStatus;
  trustTier: TrustTier;     // 1-4, derived from author
  result?: unknown;
  error?: string;
  createdAt: number;
  resolvedAt?: number;
  auditHash?: string;       // hash-chain link
}

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type TrustTier = 1 | 2 | 3 | 4;

// === Memory Operations ===

type MemoryOp =
  | { type: 'working_set'; action: 'add' | 'update' | 'remove'; key: string; value?: string }
  | { type: 'episodic_write'; path: string; content: string }
  | { type: 'semantic_upsert'; path: string; content: string; links: string[] }
  | { type: 'archival_log'; entry: AuditEntry }
  | { type: 'rag_index'; path: string };
```

---

## 3. The Event Loop

```
┌─────────────────────────────────────────────────────┐
│                    Ved Core Loop                     │
│                                                      │
│   while (running) {                                  │
│     1. RECEIVE  — poll channels for messages         │
│     2. ENRICH   — load memory context (T1-T3)       │
│     3. DECIDE   — send to LLM with context          │
│     4. ACT      — execute tool calls via trust gate  │
│     5. RECORD   — audit everything to T4             │
│     6. RESPOND  — send response back to channel      │
│     7. MAINTAIN — compress, index, housekeep         │
│   }                                                  │
└─────────────────────────────────────────────────────┘
```

### 3.1 Step-by-Step

#### RECEIVE
- Each channel adapter (Discord, CLI, Push, Cron) implements `ChannelAdapter`:
  ```typescript
  interface ChannelAdapter {
    name: ChannelId;
    init(config: ChannelConfig): Promise<void>;
    poll(): AsyncIterable<VedMessage>;
    send(channelRef: string, response: VedResponse): Promise<void>;
    shutdown(): Promise<void>;
  }
  ```
- Core merges all channel iterables into a single ordered stream.
- Messages are immediately persisted to SQLite `inbox` table (crash-safe: we never lose a message).

#### ENRICH
- **T1 (Working Memory):** Load active session context — recent messages, active facts, current conversation.
- **T2 (Episodic):** Read today's daily note from Obsidian vault if it exists.
- **T3 (Semantic):** RAG query — embed the message, search vectors + FTS5, walk wikilinks from top hits.
- **Assemble prompt:** system prompt + working memory + relevant episodic/semantic context + user message.
- **Budget:** Hard token budget for context. T1 gets priority, then T3 (RAG results), then T2.

#### DECIDE
- Send assembled prompt to LLM (via ved-llm).
- LLM returns either:
  - **Text response** — just reply to user.
  - **Tool calls** — one or more `{ tool, params }` requests.
  - **Memory instructions** — "remember X", "update entity Y", etc.
- Parse LLM output into structured `LLMDecision`:
  ```typescript
  interface LLMDecision {
    response?: string;           // text to user
    toolCalls: ToolCall[];       // tools to invoke
    memoryOps: MemoryOp[];       // memory mutations
    reasoning?: string;          // chain-of-thought (logged, not shown)
  }
  ```

#### ACT
- For each tool call, create a `WorkOrder`.
- **Trust Gate** evaluates:
  1. Author's trust tier (T1-stranger to T4-owner)
  2. Tool's risk level (from tool manifest)
  3. Trust policy: `trustMatrix[tier][riskLevel] → 'auto' | 'approve' | 'deny'`
- **Auto-approved** → execute immediately via MCP client.
- **Needs approval** → queue in `work_orders` table, notify user, WAIT.
- **Denied** → reject, tell LLM, let it retry or inform user.
- Results flow back. If LLM needs to see results (agentic loop), go back to DECIDE with tool results appended.

```
Trust Matrix (default):
                 low      medium    high     critical
Tier 4 (owner)  auto     auto      auto     approve
Tier 3 (tribe)  auto     auto      approve  deny
Tier 2 (known)  auto     approve   deny     deny
Tier 1 (stranger) approve deny     deny     deny
```

#### RECORD
- Every action → `AuditEntry` in SQLite:
  ```typescript
  interface AuditEntry {
    id: string;           // ULID
    timestamp: number;
    eventType: string;    // 'message_received' | 'llm_call' | 'tool_exec' | 'memory_op' | ...
    actor: string;        // user ID or 'ved'
    detail: string;       // JSON payload
    prevHash: string;     // hash of previous entry
    hash: string;         // SHA-256(prevHash + timestamp + eventType + detail)
  }
  ```
- Hash chain ensures tamper evidence: changing any entry breaks the chain.
- Periodic HMAC anchoring (every N entries) for external verification.

#### RESPOND
- Send `VedResponse` back through the originating channel adapter.
- If the response includes memory ops, they've already been applied in ACT.
- Log the response itself as an audit entry.

#### MAINTAIN (async, between messages)
- **T1 → T2 compression:** If working memory exceeds threshold, summarize old context into today's daily note.
- **T3 updates:** If conversation produced new facts/entities, create/update Obsidian vault files.
- **RAG re-index:** If vault files changed, update embeddings for modified files.
- **Session boundary:** On long idle (30min), compress T1 to T2, flush working memory.

---

## 4. Agentic Loop (Multi-Turn Tool Use)

When the LLM requests tool calls, Ved enters a sub-loop:

```
User Message
    │
    ▼
┌── DECIDE (LLM) ◄──────────────────────┐
│       │                                 │
│       ├── text only → RESPOND           │
│       │                                 │
│       └── tool calls                    │
│            │                            │
│            ▼                            │
│       TRUST GATE                        │
│       ├── denied → inform LLM ─────────┤
│       ├── needs approval → WAIT ────┐  │
│       └── auto → EXECUTE            │  │
│            │                        │  │
│            ▼                        │  │
│       MCP Tool Server               │  │
│            │                        │  │
│            ▼                        │  │
│       Tool Result ──────────────────┘  │
│            │                           │
│            └── append to context ──────┘
│
│   Max iterations: 10 (configurable)
│   Each iteration is a separate audit entry
└─────────────────────────────────────────
```

**Safety rails:**
- Max 10 tool calls per user message (configurable).
- Total LLM token budget per message (prevents runaway costs).
- If approval is needed, the loop PAUSES. User approves/rejects via channel. Loop resumes.
- Timeout on pending approvals (default: 5 minutes → auto-reject).

---

## 5. Concurrency Model

**No concurrency within a session.** One message at a time, fully processed before the next.

**Why:** Simplicity. Ved is a personal assistant — one user, one conversation at a time. No need for concurrent request handling. This eliminates entire classes of bugs (race conditions on memory, interleaved audit chains, conflicting tool executions).

**Between sessions:** Multiple channels can be active, but messages are serialized into a single queue. FIFO with priority (direct messages > cron > background).

**Message Queue:**
```typescript
class MessageQueue {
  private queue: PriorityQueue<VedMessage>;
  
  enqueue(msg: VedMessage): void;    // channel adapters call this
  dequeue(): VedMessage | null;       // core loop calls this
  
  // Priority: direct (3) > cron (2) > background (1)
}
```

---

## 6. Session Lifecycle

```
INIT ──► IDLE ──► ACTIVE ──► IDLE ──► ... ──► SHUTDOWN
  │                 │                            │
  │ load config     │ message received           │ graceful
  │ init channels   │ process pipeline           │ flush T1→T2
  │ load T1 state   │ agentic loop if needed     │ close channels
  │ init SQLite     │ update memory              │ close SQLite
  │ resume pending  │ respond                    │ final audit entry
  │ work orders     │ back to IDLE               │
```

**Startup recovery:**
1. Open SQLite database.
2. Check for incomplete work orders (status = 'executing'). Mark as 'failed' with recovery note.
3. Check for unprocessed inbox messages. Resume processing.
4. Load T1 working memory from last session state.
5. Resume normal loop.

---

## 7. Configuration

```typescript
interface VedConfig {
  // Identity
  name: string;                    // 'Ved'
  
  // LLM
  llm: {
    provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
    model: string;
    apiKey?: string;
    maxTokensPerMessage: number;   // cost guard
    temperature: number;
  };
  
  // Memory
  memory: {
    vaultPath: string;             // path to Obsidian vault
    workingMemoryMaxTokens: number; // T1 budget
    ragTopK: number;               // how many chunks to retrieve
    compressionThreshold: number;  // T1 token count before compress
    sessionIdleMinutes: number;    // idle before T1→T2 flush
  };
  
  // Trust
  trust: {
    ownerIds: string[];            // tier 4
    tribeIds: string[];            // tier 3
    knownIds: string[];            // tier 2
    defaultTier: TrustTier;        // for unknown users
    approvalTimeoutMs: number;
    maxToolCallsPerMessage: number;
  };
  
  // Audit
  audit: {
    anchorInterval: number;        // entries between HMAC anchors
    hmacSecret?: string;           // for external anchoring
  };
  
  // Channels
  channels: ChannelConfig[];
  
  // Database
  dbPath: string;                  // SQLite file path
}
```

---

## 8. Module Boundaries

```
ved-core (this document)
├── EventLoop          — the main loop (receive/enrich/decide/act/record/respond)
├── MessageQueue       — priority queue for incoming messages
├── SessionManager     — lifecycle (init/idle/active/shutdown)
├── Config             — load/validate configuration
│
├── uses: ved-llm      — LLM client (send prompt, parse response)
├── uses: ved-mcp      — MCP client (discover tools, call tools)
├── uses: ved-memory   — 4-tier memory (T1-T4 read/write)
├── uses: ved-rag      — RAG pipeline (embed, search, rank)
├── uses: ved-audit    — hash-chain audit log (REUSED from Witness)
├── uses: ved-trust    — risk assessment + work orders (REUSED from Witness)
└── uses: ved-channel  — channel adapters (Discord, CLI, push)
```

**Key dependency rule:** ved-core depends on all modules. No module depends on ved-core. Modules communicate only through ved-core (hub-and-spoke).

---

## 9. SQLite Schema (Core Tables)

```sql
-- Inbox: crash-safe message receipt
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,           -- ULID
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT,              -- JSON array
  reply_to TEXT,
  received_at INTEGER NOT NULL,
  processed INTEGER DEFAULT 0   -- 0=pending, 1=done
);

-- Sessions: track conversation state
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  working_memory TEXT,           -- JSON: T1 state
  status TEXT DEFAULT 'active'   -- active | idle | closed
);

-- Work orders: HITL approval queue (from Witness)
-- (schema already designed in sessions 6-10)

-- Audit log: hash-chained entries (from Witness)
-- (schema already designed in sessions 6-10)

-- RAG index: vector embeddings
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,       -- float32 vector
  updated_at INTEGER NOT NULL,
  UNIQUE(file_path, chunk_index)
);

-- FTS5 for keyword search
CREATE VIRTUAL TABLE vault_fts USING fts5(
  file_path,
  content,
  tokenize='porter'
);
```

---

## 10. Open Questions for Session 22

1. **Obsidian vault conventions:** What frontmatter schema? How do wikilinks encode relationship types? Do we use folders or tags for entity types?
2. **Git integration:** Auto-commit on every vault change, or batch? Commit message format?
3. **T1→T2 compression:** What LLM prompt compresses working memory into a good daily note entry? How do we extract entities for T3?
4. **Vault file naming:** Slugified titles? ULIDs? Human-readable names?
5. **Offline/local LLM fallback:** Should Ved work with Ollama as primary? Or always cloud LLM?

---

## 11. What's Different from OpenClaw

| Aspect | OpenClaw | Ved |
|--------|----------|-----|
| Architecture | Gateway + LLM + skills | Single process + MCP tools |
| Memory | Flat files (MEMORY.md) | 4-tier hierarchical (Obsidian + SQLite) |
| Audit | Session JSONL files | Hash-chained SQLite with HMAC anchoring |
| HITL | Chat-based ("should I?") | Trust matrix + work order queue |
| Tools | Skills (JS/TS plugins) | MCP servers (protocol standard) |
| Size | ~50K+ LoC | Target <10K LoC |
| Users | Multi-user possible | Single user, personal |
| State | Ephemeral sessions | Persistent, crash-recoverable |
| Search | memory_search + qmd | Built-in RAG (vectors + FTS5 + graph) |

---

*End of event loop design. Next: Session 22 — Obsidian memory deep dive.*
