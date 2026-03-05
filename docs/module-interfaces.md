# Ved Module Interfaces — Design Document

**Session:** 24  
**Phase:** PLAN (1 of 5)  
**Date:** 2026-03-04  

---

## 1. Module Dependency Graph

```
                    ┌──────────────┐
                    │   ved-core   │
                    │  EventLoop   │
                    │  Session     │
                    │  Config      │
                    └──────┬───────┘
           ┌───────┬───────┼───────┬───────┬───────┐
           ▼       ▼       ▼       ▼       ▼       ▼
       ved-llm  ved-mcp ved-memory ved-rag ved-audit ved-channel
                           │         │       │
                           │         ▼       │
                           │     ved-audit ◄─┘
                           │         ▲
                           └─────────┘

ved-trust is used by ved-core (trust gate in ACT step)
ved-memory uses ved-rag (triggers re-index on vault changes)
ved-memory uses ved-audit (logs every memory operation)
ved-rag uses ved-audit (logs re-index events)
```

**Dependency Rules:**
1. ved-core depends on ALL modules (hub)
2. No module depends on ved-core (spokes)
3. ved-memory → ved-rag (re-index triggers)
4. ved-memory → ved-audit (memory op logging)
5. ved-rag → ved-audit (index event logging)
6. ved-trust → ved-audit (trust decision logging)
7. All modules share `ved-types` (common type definitions, no runtime code)

---

## 2. Shared Types (`ved-types`)

Not a module — a types-only package. No runtime code. Every module imports from here.

```typescript
// ============================================================
// ved-types/index.ts — Shared type definitions for all modules
// ============================================================

// === Identifiers ===

/** ULID — sortable, unique, monotonic */
type VedId = string;

/** Channel identifier */
type ChannelId = 'discord' | 'cli' | 'push' | 'cron';

/** Author identifier — user ID string or 'ved' for system */
type AuthorId = string;

/** Trust tier — 1 (stranger) to 4 (owner) */
type TrustTier = 1 | 2 | 3 | 4;

/** Risk level for tool operations */
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Action lifecycle status */
type ActionStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed';

/** Session lifecycle states */
type SessionStatus = 'active' | 'idle' | 'closed';

/** Memory operation types */
type MemoryOpType = 'working_set' | 'episodic_write' | 'semantic_upsert' | 'archival_log' | 'rag_index';

/** Confidence levels for vault entries */
type Confidence = 'high' | 'medium' | 'low';

/** Source of knowledge */
type KnowledgeSource = 'conversation' | 'observation' | 'research' | 'manual';

/** Vault entity types (maps to folder structure) */
type VaultEntityType = 'person' | 'org' | 'place' | 'project' | 'concept' | 'decision' | 'topic' | 'daily';

// === Core Messages ===

interface VedMessage {
  id: VedId;
  channel: ChannelId;
  author: AuthorId;
  content: string;
  attachments?: Attachment[];
  replyTo?: VedId;
  timestamp: number;         // unix ms
}

interface Attachment {
  filename: string;
  contentType: string;
  url?: string;
  data?: Buffer;
  size: number;
}

interface VedResponse {
  id: VedId;
  inReplyTo: VedId;
  content: string;
  actions: WorkOrder[];
  memoryOps: MemoryOp[];
  channelRef?: string;       // channel-specific routing info
}

// === Memory Operations ===

type MemoryOp =
  | WorkingMemoryOp
  | EpisodicWriteOp
  | SemanticUpsertOp
  | ArchivalLogOp
  | RagIndexOp;

interface WorkingMemoryOp {
  type: 'working_set';
  action: 'add' | 'update' | 'remove';
  key: string;
  value?: string;
}

interface EpisodicWriteOp {
  type: 'episodic_write';
  path: string;              // relative vault path (e.g. daily/2026-03-04.md)
  content: string;
  append: boolean;           // true = append, false = overwrite
}

interface SemanticUpsertOp {
  type: 'semantic_upsert';
  path: string;              // relative vault path
  frontmatter?: Record<string, unknown>;
  body?: string;
  links: string[];           // wikilinks to add
}

interface ArchivalLogOp {
  type: 'archival_log';
  entry: AuditEntryInput;
}

interface RagIndexOp {
  type: 'rag_index';
  path: string;              // file to re-index
}

// === Work Orders ===

interface WorkOrder {
  id: VedId;
  messageId: VedId;
  tool: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  status: ActionStatus;
  trustTier: TrustTier;
  result?: unknown;
  error?: string;
  createdAt: number;
  resolvedAt?: number;
  auditHash?: string;
}

// === Audit ===

interface AuditEntry {
  id: VedId;
  timestamp: number;
  eventType: AuditEventType;
  actor: AuthorId;
  detail: string;            // JSON-serialized payload
  prevHash: string;
  hash: string;              // SHA-256(prevHash + timestamp + eventType + detail)
}

interface AuditEntryInput {
  eventType: AuditEventType;
  actor?: AuthorId;          // defaults to 'ved'
  detail: Record<string, unknown>;
}

type AuditEventType =
  | 'message_received'
  | 'message_sent'
  | 'llm_call'
  | 'llm_response'
  | 'tool_request'
  | 'tool_approved'
  | 'tool_rejected'
  | 'tool_executed'
  | 'tool_failed'
  | 'memory_t1_write'
  | 'memory_t1_read'
  | 'memory_t2_compress'
  | 'memory_t3_upsert'
  | 'memory_t3_delete'
  | 'vault_file_changed'     // external (human) edit
  | 'rag_reindex'
  | 'rag_full_reindex'
  | 'trust_decision'
  | 'session_start'
  | 'session_idle'
  | 'session_close'
  | 'anchor_hmac'
  | 'config_change'
  | 'startup'
  | 'shutdown';

// === LLM ===

interface LLMDecision {
  response?: string;
  toolCalls: ToolCall[];
  memoryOps: MemoryOp[];
  reasoning?: string;        // chain-of-thought (logged, not shown to user)
  usage?: LLMUsage;
}

interface ToolCall {
  id: string;                // tool-call ID from LLM
  tool: string;              // MCP tool name
  params: Record<string, unknown>;
}

interface ToolResult {
  callId: string;
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
}

// === Vault ===

interface VaultFile {
  path: string;              // relative to vault root
  frontmatter: Record<string, unknown>;
  body: string;              // markdown content without frontmatter
  links: string[];           // parsed [[wikilinks]]
  raw: string;               // full file content including frontmatter
  stats: VaultFileStats;
}

interface VaultFileStats {
  created: Date;
  modified: Date;
  size: number;              // bytes
}

interface VaultIndex {
  files: Map<string, string>;             // filename (no ext) → relative path
  backlinks: Map<string, Set<string>>;    // filename → set of filenames linking to it
  tags: Map<string, Set<string>>;         // tag → set of file paths
  types: Map<string, Set<string>>;        // entity type → set of file paths
}

// === RAG ===

interface VaultChunk {
  id: VedId;
  filePath: string;
  heading: string | null;
  content: string;
  tokenCount: number;
  embedding?: Float32Array;  // 768-dim, undefined before embedding
  updatedAt: number;
  fileModifiedAt: number;
}

interface RetrievalResult {
  filePath: string;
  chunkId?: VedId;
  heading?: string | null;
  content: string;
  rrfScore: number;
  sources: RetrievalSource[];
}

type RetrievalSource = 'vector' | 'fts' | 'graph';

// === Graph ===

interface GraphNode {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  links: string[];
  backlinks: string[];
  depth: number;
}

interface GraphWalkOptions {
  startFiles: string[];
  maxDepth: number;          // default: 1
  maxNodes: number;          // default: 5
  maxTokens: number;
  excludeFolders?: string[];
}

// === Configuration ===

interface VedConfig {
  name: string;              // 'Ved'
  version: string;

  llm: LLMConfig;
  memory: MemoryConfig;
  trust: TrustConfig;
  audit: AuditConfig;
  rag: RagConfig;
  channels: ChannelConfig[];
  
  dbPath: string;            // SQLite file path
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokensPerMessage: number;
  maxTokensPerSession: number;
  temperature: number;
  systemPromptPath?: string;
}

interface MemoryConfig {
  vaultPath: string;
  workingMemoryMaxTokens: number;   // T1 budget
  ragContextMaxTokens: number;      // injected RAG context budget
  compressionThreshold: number;     // T1 token count before compress
  sessionIdleMinutes: number;       // idle before T1→T2 flush
  gitEnabled: boolean;
  gitAutoCommitIntervalMinutes: number;
}

interface TrustConfig {
  ownerIds: string[];
  tribeIds: string[];
  knownIds: string[];
  defaultTier: TrustTier;
  approvalTimeoutMs: number;
  maxToolCallsPerMessage: number;
  maxAgenticLoops: number;          // max DECIDE→ACT iterations
}

interface AuditConfig {
  anchorInterval: number;
  hmacSecret?: string;
}

interface RagConfig {
  vectorTopK: number;
  ftsTopK: number;
  graphMaxDepth: number;
  graphMaxNodes: number;
  maxContextTokens: number;
  rrfK: number;
  embedding: EmbeddingConfig;
  chunking: ChunkConfig;
}

interface EmbeddingConfig {
  model: string;             // 'nomic-embed-text'
  baseUrl: string;           // 'http://localhost:11434'
  batchSize: number;         // 32
  dimensions: number;        // 768
}

interface ChunkConfig {
  maxTokens: number;         // 1024
  minTokens: number;         // 64
  frontmatterPrefix: boolean;
}

interface ChannelConfig {
  type: ChannelId;
  enabled: boolean;
  config: Record<string, unknown>; // channel-specific config
}

// === Lifecycle ===

/** Standard module lifecycle — all modules implement this */
interface VedModule {
  readonly name: string;
  init(config: VedConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<ModuleHealth>;
}

interface ModuleHealth {
  module: string;
  healthy: boolean;
  details?: string;
  checkedAt: number;
}
```

---

## 3. Module Interfaces

### 3.1 ved-core

The orchestrator. Owns the event loop, session lifecycle, and message queue.

```typescript
// ============================================================
// ved-core — Event loop, session management, message queue
// Target: ~1K lines
// ============================================================

import { VedConfig, VedMessage, VedResponse, VedModule, VedId,
         LLMDecision, ToolResult, MemoryOp, WorkOrder } from 'ved-types';

// === Event Loop ===

interface EventLoop extends VedModule {
  readonly name: 'core';

  /** Start the main loop. Blocks until shutdown. */
  run(): Promise<void>;

  /** Request graceful shutdown. Completes current message, flushes state. */
  requestShutdown(): void;

  /** Check if the loop is running */
  readonly isRunning: boolean;
}

// The 7-step pipeline (internal, not exported as interface — these are the methods EventLoop calls):
// 1. receive()  — poll all channels, dequeue next message
// 2. enrich()   — load T1, RAG query, assemble prompt
// 3. decide()   — call LLM
// 4. act()      — trust gate → execute tools → agentic loop
// 5. record()   — audit everything
// 6. respond()  — send response to channel
// 7. maintain() — compress memory, re-index, git commit

// === Session Manager ===

interface SessionManager {
  /** Create or resume a session for a channel+author pair */
  getOrCreate(channel: ChannelId, author: AuthorId): Promise<Session>;

  /** Get an active session by ID */
  get(sessionId: VedId): Promise<Session | null>;

  /** Mark session as idle (starts compression timer) */
  markIdle(sessionId: VedId): Promise<void>;

  /** Close a session (flush T1→T2, mark closed) */
  close(sessionId: VedId): Promise<void>;

  /** Close all sessions older than idleMinutes */
  closeStale(idleMinutes: number): Promise<number>;
}

interface Session {
  id: VedId;
  channel: ChannelId;
  author: AuthorId;
  startedAt: number;
  lastActive: number;
  status: SessionStatus;
  workingMemory: WorkingMemory;
}

// === Working Memory (T1) ===

interface WorkingMemory {
  /** Recent messages in this session (sliding window) */
  messages: ConversationMessage[];

  /** Active facts — key-value pairs the LLM can read/write */
  facts: Map<string, string>;

  /** Current token count estimate */
  tokenCount: number;

  /** Add a message to conversation history */
  addMessage(msg: ConversationMessage): void;

  /** Get/set/delete active facts */
  getFact(key: string): string | undefined;
  setFact(key: string, value: string): void;
  deleteFact(key: string): void;

  /** Serialize for prompt injection */
  toPromptSection(): string;

  /** Serialize for persistence (SQLite sessions table) */
  serialize(): string;

  /** Restore from serialized state */
  static deserialize(data: string): WorkingMemory;
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;           // tool name for tool messages
  toolCallId?: string;     // links tool result to tool call
  timestamp: number;
}

// === Message Queue ===

interface MessageQueue {
  /** Add a message to the queue (channel adapters call this) */
  enqueue(msg: VedMessage, priority?: MessagePriority): void;

  /** Take the next message (core loop calls this) */
  dequeue(): VedMessage | null;

  /** Check queue depth */
  readonly length: number;

  /** Peek without removing */
  peek(): VedMessage | null;
}

type MessagePriority = 'high' | 'normal' | 'low';
// high = direct user messages, normal = cron, low = background
```

### 3.2 ved-llm

Multi-provider LLM client. Handles prompt assembly, API calls, response parsing.

```typescript
// ============================================================
// ved-llm — Multi-provider LLM client
// Target: ~800 lines
// ============================================================

import { VedConfig, LLMConfig, LLMDecision, LLMUsage, VedModule,
         ConversationMessage, ToolCall, ToolResult } from 'ved-types';

interface LLMClient extends VedModule {
  readonly name: 'llm';
  readonly provider: string;
  readonly model: string;

  /**
   * Send a conversation to the LLM and get a structured decision.
   * Handles tool-use format for each provider.
   */
  chat(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Compress text (used for T1→T2 compression).
   * Separate from chat() because it uses a different system prompt.
   */
  compress(text: string, instructions: string): Promise<string>;

  /**
   * Extract entities/facts from text (used for T3 extraction).
   * Returns structured extraction result.
   */
  extract(text: string, instructions: string): Promise<ExtractionResult>;

  /** Get total tokens used this session */
  readonly sessionUsage: LLMUsage;
}

interface LLMRequest {
  systemPrompt: string;
  messages: ConversationMessage[];
  tools?: MCPToolDefinition[];     // available tools for this call
  toolResults?: ToolResult[];      // results from previous tool calls
  maxTokens?: number;
  temperature?: number;
}

interface LLMResponse {
  decision: LLMDecision;
  raw: unknown;                    // raw provider response (for debugging)
  usage: LLMUsage;
  durationMs: number;
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  riskLevel: RiskLevel;
}

interface ExtractionResult {
  facts: ExtractedFact[];
  entities: ExtractedEntity[];
  decisions: ExtractedDecision[];
}

interface ExtractedFact {
  fact: string;
  entity: string;               // kebab-case filename
  entityType: VaultEntityType;
  confidence: Confidence;
}

interface ExtractedEntity {
  filename: string;              // kebab-case
  folder: string;                // e.g. 'entities/people'
  action: 'create' | 'update';
  name: string;                  // display name
  type: VaultEntityType;
}

interface ExtractedDecision {
  title: string;
  filename: string;              // e.g. '2026-03-04-single-threaded-loop'
  context: string;               // wikilink to project/topic
  reasoning: string;
}

// === Provider Adapter (internal — one per provider) ===

interface LLMProviderAdapter {
  readonly provider: string;

  /** Convert VedRequest → provider-specific API call */
  formatRequest(request: LLMRequest): unknown;

  /** Parse provider response → VedResponse */
  parseResponse(raw: unknown): LLMResponse;

  /** Make the HTTP call */
  call(formattedRequest: unknown): Promise<unknown>;
}

// Implementations: AnthropicAdapter, OpenAIAdapter, OpenRouterAdapter, OllamaAdapter
// Each ~150 lines handling API-specific formats
```

### 3.3 ved-mcp

MCP client for tool discovery and execution.

```typescript
// ============================================================
// ved-mcp — MCP client for tool discovery and execution
// Target: ~600 lines
// ============================================================

import { VedConfig, VedModule, MCPToolDefinition, ToolCall, ToolResult } from 'ved-types';

interface MCPClient extends VedModule {
  readonly name: 'mcp';

  /** Discover all available tools from configured MCP servers */
  discoverTools(): Promise<MCPToolDefinition[]>;

  /** Execute a single tool call */
  executeTool(call: ToolCall): Promise<ToolResult>;

  /** Get all registered tool definitions (cached from discovery) */
  readonly tools: MCPToolDefinition[];

  /** Get tool definition by name */
  getTool(name: string): MCPToolDefinition | undefined;

  /** Check if a specific MCP server is healthy */
  serverHealth(serverName: string): Promise<boolean>;
}

// === MCP Server Configuration ===

interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'http';

  // stdio transport
  command?: string;            // e.g. 'npx'
  args?: string[];             // e.g. ['-y', '@ved/tools-fs']
  env?: Record<string, string>;

  // http transport
  url?: string;                // e.g. 'http://localhost:3100/mcp'

  // Common
  timeout: number;             // ms, default 30000
  riskLevel: RiskLevel;        // default risk level for all tools from this server
  toolOverrides?: Record<string, { riskLevel: RiskLevel }>;  // per-tool risk override
}

// === Internal: MCP Transport ===

interface MCPTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(method: string, params?: unknown): Promise<unknown>;
  readonly connected: boolean;
}

// StdioTransport: spawns child process, communicates via stdin/stdout JSON-RPC
// HttpTransport: connects to HTTP SSE endpoint, sends JSON-RPC over HTTP
```

### 3.4 ved-memory

4-tier memory manager + Obsidian vault integration.

```typescript
// ============================================================
// ved-memory — 4-tier memory manager + Obsidian vault
// Target: ~2.5K lines (largest module)
// ============================================================

import { VedConfig, VedModule, VedId, MemoryOp, WorkingMemory,
         VaultFile, VaultIndex, VaultChunk, VaultFileStats,
         GraphNode, GraphWalkOptions, VaultEntityType, Confidence,
         KnowledgeSource, AuditEntryInput } from 'ved-types';

// === Memory Manager (top-level interface) ===

interface MemoryManager extends VedModule {
  readonly name: 'memory';

  // --- T1: Working Memory ---
  /** Get or create working memory for a session */
  getWorkingMemory(sessionId: VedId): WorkingMemory;

  /** Persist working memory state to SQLite */
  persistWorkingMemory(sessionId: VedId): Promise<void>;

  /** Load working memory from SQLite (session resume) */
  loadWorkingMemory(sessionId: VedId): Promise<WorkingMemory | null>;

  // --- T2: Episodic Memory ---
  /** Get today's daily note (or create if missing) */
  getTodayNote(): Promise<VaultFile>;

  /** Append a session summary to today's daily note */
  appendToDaily(content: string): Promise<void>;

  /** Compress working memory into a daily note entry */
  compressToDaily(sessionId: VedId): Promise<CompressResult>;

  // --- T3: Semantic Memory ---
  /** Create or update a vault entity file */
  upsertEntity(op: EntityUpsertInput): Promise<string>; // returns file path

  /** Read an entity by path or filename */
  readEntity(pathOrFilename: string): Promise<VaultFile | null>;

  /** Search entities by tag, type, or frontmatter field */
  queryEntities(query: EntityQuery): Promise<VaultFile[]>;

  /** Delete an entity (with audit trail) */
  deleteEntity(path: string): Promise<void>;

  // --- T4: Archival (delegated to ved-audit + ved-rag) ---
  // No direct methods — ved-audit and ved-rag handle T4

  // --- Cross-tier Operations ---
  /** Execute a batch of memory operations (from LLM decision) */
  executeOps(ops: MemoryOp[], actor: string): Promise<MemoryOpResult[]>;

  /** Get the vault manager (for direct vault operations) */
  readonly vault: VaultManager;
}

interface CompressResult {
  dailyPath: string;         // path to daily note
  summary: string;           // generated summary
  entitiesCreated: string[]; // new vault files
  entitiesUpdated: string[]; // updated vault files
  factCount: number;         // facts extracted
}

interface EntityUpsertInput {
  filename: string;           // kebab-case, no extension
  folder: string;             // e.g. 'entities/people', 'projects', 'concepts'
  type: VaultEntityType;
  name: string;               // display name
  source: KnowledgeSource;
  confidence: Confidence;
  tags?: string[];
  extraFrontmatter?: Record<string, unknown>;
  body?: string;              // markdown body
  links?: string[];           // wikilinks to include
  appendFacts?: string[];     // facts to append to ## Key Facts section
}

interface EntityQuery {
  type?: VaultEntityType;
  tags?: string[];
  folder?: string;
  frontmatter?: Record<string, unknown>;
  limit?: number;
}

interface MemoryOpResult {
  op: MemoryOp;
  success: boolean;
  path?: string;
  error?: string;
}

// === Vault Manager ===

interface VaultManager {
  // --- Lifecycle ---
  init(vaultPath: string): Promise<void>;
  watch(): void;                // start filesystem watcher for human edits
  stopWatch(): void;
  close(): void;

  // --- Read ---
  readFile(path: string): Promise<VaultFile>;
  readFileSync(path: string): VaultFile;
  exists(path: string): boolean;
  listFiles(folder?: string): Promise<string[]>;
  getBacklinks(filename: string): string[];
  resolveLink(wikilink: string): string | null;

  // --- Write ---
  createFile(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void>;
  updateFile(path: string, updates: VaultFileUpdate): Promise<void>;
  appendToFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;

  // --- Search (local, non-RAG) ---
  findByTag(tag: string): string[];
  findByType(type: VaultEntityType): string[];
  findByFrontmatter(key: string, value: unknown): string[];

  // --- Graph ---
  walkGraph(opts: GraphWalkOptions): GraphNode[];
  getLinks(path: string): string[];
  getAllBacklinks(): Map<string, Set<string>>;

  // --- Index ---
  rebuildIndex(): Promise<void>;
  getIndex(): VaultIndex;

  // --- Events ---
  on(event: 'file-changed', handler: (path: string, changeType: 'create' | 'update' | 'delete') => void): void;
  off(event: 'file-changed', handler: Function): void;

  // --- Git ---
  readonly git: VaultGit;
}

interface VaultFileUpdate {
  frontmatter?: Partial<Record<string, unknown>>;
  body?: string;                     // if provided, replaces entire body
  appendBody?: string;               // if provided, appends to body
  mergeFrontmatter?: boolean;        // true (default) = merge, false = replace
}

// === Vault Git ===

interface VaultGit {
  init(): Promise<void>;
  stage(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  isClean(): Promise<boolean>;
  log(limit?: number): Promise<GitLogEntry[]>;
  diff(path: string): Promise<string>;

  /** Mark a file as dirty (will be included in next commit) */
  markDirty(path: string): void;

  /** Flush all dirty files: stage + commit with auto-generated message */
  flush(message?: string): Promise<void>;

  /** Get dirty file count */
  readonly dirtyCount: number;
}

interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: Date;
  files: string[];
}

// === Template Engine ===

interface TemplateEngine {
  /** Load templates from the vault's templates/ folder */
  loadTemplates(templatesDir: string): Promise<void>;

  /** Render a template with variables */
  render(templateName: string, vars: Record<string, unknown>): string;

  /** List available templates */
  list(): string[];
}
```

### 3.5 ved-rag

RAG pipeline: embed, index, search, rank.

```typescript
// ============================================================
// ved-rag — RAG pipeline: embed, index, search, rank
// Target: ~1K lines
// ============================================================

import { VedConfig, VedModule, VaultFile, VaultChunk, RetrievalResult,
         RetrievalSource, RagConfig, VedId } from 'ved-types';

// === RAG Pipeline (top-level interface) ===

interface RagPipeline extends VedModule {
  readonly name: 'rag';

  /**
   * Retrieve relevant context for a query.
   * This is the main method called by ved-core during ENRICH.
   * Runs all three retrieval paths, fuses with RRF, trims to budget.
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalContext>;

  /**
   * Full re-index of all vault files.
   * Called on first boot or explicitly.
   */
  fullReindex(): Promise<IndexStats>;

  /**
   * Incremental re-index of a single file.
   * Called when a vault file changes.
   */
  reindexFile(filePath: string): Promise<void>;

  /**
   * Remove a file from the index.
   */
  removeFile(filePath: string): Promise<void>;

  /**
   * Enqueue a file for async re-indexing.
   * Non-blocking — file will be re-indexed in background.
   */
  enqueueReindex(filePath: string): void;

  /** Process any pending re-index queue items */
  drainQueue(): Promise<void>;

  /** Get index stats */
  stats(): Promise<IndexStats>;
}

interface RetrieveOptions {
  vectorTopK?: number;
  ftsTopK?: number;
  graphMaxDepth?: number;
  graphMaxNodes?: number;
  maxContextTokens?: number;
  excludePaths?: string[];        // paths to exclude from results
  boostPaths?: string[];          // paths to boost in ranking
  sources?: RetrievalSource[];    // which retrieval paths to use (default: all)
}

interface RetrievalContext {
  /** Formatted context string ready for prompt injection */
  text: string;

  /** Individual results with scores */
  results: RetrievalResult[];

  /** Token count estimate of the context */
  tokenCount: number;

  /** Performance metrics */
  metrics: RetrievalMetrics;
}

interface RetrievalMetrics {
  vectorSearchMs: number;
  ftsSearchMs: number;
  graphWalkMs: number;
  fusionMs: number;
  totalMs: number;
  vectorResultCount: number;
  ftsResultCount: number;
  graphResultCount: number;
  mergedResultCount: number;
  contextTokens: number;
}

interface IndexStats {
  filesIndexed: number;
  chunksStored: number;
  vectorsStored: number;
  ftsEntries: number;
  lastFullReindex?: number;      // unix ms
  lastIncrementalReindex?: number;
  queueDepth: number;
}

// === Embedder ===

interface Embedder {
  /** Embed one or more texts. Returns one Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>;

  /** Embed a single text (convenience). */
  embedOne(text: string): Promise<Float32Array>;

  /** Check if the embedding model is available */
  isAvailable(): Promise<boolean>;

  readonly model: string;
  readonly dimensions: number;
}

// === Chunker ===

interface Chunker {
  /** Chunk a vault file into embeddable pieces */
  chunk(file: VaultFile): ChunkResult[];
}

interface ChunkResult {
  heading: string | null;
  content: string;
  tokenCount: number;
}

// === Search Interfaces (internal) ===

interface VectorSearchResult {
  chunkId: VedId;
  filePath: string;
  heading: string | null;
  content: string;
  distance: number;
  score: number;               // normalized 0-1 (1 = best)
}

interface FtsSearchResult {
  chunkId: VedId;
  filePath: string;
  heading: string | null;
  content: string;
  rank: number;                // BM25 rank (lower = better)
  score: number;               // normalized 0-1
}

interface GraphSearchResult {
  filePath: string;
  content: string;
  depth: number;
  backlinkCount: number;
  score: number;
}
```

### 3.6 ved-audit

Hash-chain audit log. Mostly reused from Witness (sessions 11-20).

```typescript
// ============================================================
// ved-audit — Hash-chain audit log + HMAC anchoring
// Target: ~800 lines (reused from Witness)
// ============================================================

import { VedConfig, VedModule, AuditEntry, AuditEntryInput, AuditEventType, VedId } from 'ved-types';

interface AuditLog extends VedModule {
  readonly name: 'audit';

  /** Log an event. Returns the created audit entry with hash. */
  log(input: AuditEntryInput): Promise<AuditEntry>;

  /** Get the latest entry (head of hash chain) */
  head(): Promise<AuditEntry | null>;

  /** Verify the hash chain integrity from entry N to M (inclusive) */
  verify(fromId?: VedId, toId?: VedId): Promise<VerifyResult>;

  /** Query audit entries with filters */
  query(filter: AuditFilter): Promise<AuditEntry[]>;

  /** Count entries matching a filter */
  count(filter?: AuditFilter): Promise<number>;

  /** Create an HMAC anchor for the current chain head */
  anchor(): Promise<AnchorResult>;

  /** Verify a specific anchor */
  verifyAnchor(anchorId: VedId): Promise<boolean>;

  /** Get all anchors */
  listAnchors(): Promise<Anchor[]>;

  /** Export entries as JSONL (for external verification) */
  export(filter?: AuditFilter): AsyncIterable<string>;
}

interface AuditFilter {
  eventType?: AuditEventType | AuditEventType[];
  actor?: string;
  after?: number;              // unix ms
  before?: number;
  limit?: number;
  offset?: number;
}

interface VerifyResult {
  valid: boolean;
  entriesChecked: number;
  firstBrokenAt?: VedId;       // ID of first entry where chain breaks
  error?: string;
}

interface AnchorResult {
  id: VedId;
  chainHeadId: VedId;
  chainHeadHash: string;
  hmac: string;
  timestamp: number;
  entriesSinceLastAnchor: number;
}

interface Anchor {
  id: VedId;
  chainHeadId: VedId;
  chainHeadHash: string;
  hmac: string;
  timestamp: number;
}
```

### 3.7 ved-trust

Risk assessment + HITL approval engine. Reused from Witness.

```typescript
// ============================================================
// ved-trust — Risk assessment + HITL approval engine
// Target: ~800 lines (reused from Witness)
// ============================================================

import { VedConfig, VedModule, VedId, TrustTier, RiskLevel,
         WorkOrder, ActionStatus, AuthorId, ToolCall } from 'ved-types';

interface TrustEngine extends VedModule {
  readonly name: 'trust';

  /** Determine the trust tier for an author */
  getTier(authorId: AuthorId): TrustTier;

  /** Evaluate a tool call: should it be auto-approved, queued, or denied? */
  evaluate(call: ToolCall, authorTier: TrustTier, toolRisk: RiskLevel): TrustDecision;

  /** Create a work order for a tool call that needs approval */
  createWorkOrder(call: ToolCall, messageId: VedId, authorTier: TrustTier, toolRisk: RiskLevel): Promise<WorkOrder>;

  /** Approve a pending work order (called when user approves) */
  approve(workOrderId: VedId, approver: AuthorId): Promise<WorkOrder>;

  /** Reject a pending work order */
  reject(workOrderId: VedId, rejector: AuthorId, reason?: string): Promise<WorkOrder>;

  /** Get pending work orders (waiting for approval) */
  getPending(messageId?: VedId): Promise<WorkOrder[]>;

  /** Get a work order by ID */
  getWorkOrder(id: VedId): Promise<WorkOrder | null>;

  /** Update work order status (executing, completed, failed) */
  updateStatus(id: VedId, status: ActionStatus, result?: unknown, error?: string): Promise<WorkOrder>;

  /** Check for timed-out work orders and auto-reject them */
  expireStale(): Promise<WorkOrder[]>;

  /** Get the trust matrix */
  readonly trustMatrix: TrustMatrix;
}

type TrustDecision = 'auto' | 'approve' | 'deny';

/**
 * Trust matrix: trustMatrix[tier][riskLevel] → decision
 *
 * Default:
 *              low      medium    high     critical
 * Tier 4      auto     auto      auto     approve
 * Tier 3      auto     auto      approve  deny
 * Tier 2      auto     approve   deny     deny
 * Tier 1      approve  deny      deny     deny
 */
type TrustMatrix = Record<TrustTier, Record<RiskLevel, TrustDecision>>;
```

### 3.8 ved-channel

Channel adapters for Discord, CLI, and push notifications.

```typescript
// ============================================================
// ved-channel — Channel adapters (Discord, CLI, Push, Cron)
// Target: ~1.5K lines
// ============================================================

import { VedConfig, VedModule, VedMessage, VedResponse,
         ChannelId, ChannelConfig, WorkOrder } from 'ved-types';

// === Channel Manager ===

interface ChannelManager extends VedModule {
  readonly name: 'channel';

  /** Register and initialize all configured channels */
  initChannels(configs: ChannelConfig[]): Promise<void>;

  /** Get a specific channel adapter */
  getChannel(id: ChannelId): ChannelAdapter | undefined;

  /** Get all active channel adapters */
  readonly channels: ChannelAdapter[];

  /** Subscribe to messages from all channels */
  onMessage(handler: (msg: VedMessage) => void): void;

  /** Send a response through the appropriate channel */
  send(channelId: ChannelId, response: VedResponse): Promise<void>;

  /** Notify user about a pending work order (approval request) */
  notifyApproval(channelId: ChannelId, workOrder: WorkOrder): Promise<void>;
}

// === Channel Adapter (one per channel type) ===

interface ChannelAdapter {
  readonly id: ChannelId;
  readonly connected: boolean;

  /** Initialize the channel (connect, authenticate, etc.) */
  init(config: ChannelConfig): Promise<void>;

  /** Start listening for messages */
  start(): Promise<void>;

  /** Stop listening */
  stop(): Promise<void>;

  /** Send a response to a specific destination */
  send(response: VedResponse): Promise<void>;

  /** Subscribe to incoming messages */
  onMessage(handler: (msg: VedMessage) => void): void;

  /** Send an approval request notification */
  sendApprovalRequest(workOrder: WorkOrder): Promise<void>;

  /** Send a plaintext notification */
  notify(text: string): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;
}

// === Discord Channel Config ===

interface DiscordChannelConfig {
  type: 'discord';
  token: string;
  guildId?: string;
  channelIds?: string[];         // channels to listen in (all if omitted)
  prefix?: string;               // command prefix (e.g. '!ved')
}

// === CLI Channel Config ===

interface CLIChannelConfig {
  type: 'cli';
  prompt?: string;               // default: 'ved> '
  historyFile?: string;          // readline history
}

// === Push Channel Config ===

interface PushChannelConfig {
  type: 'push';
  provider: 'ntfy' | 'pushover';
  topic?: string;                // ntfy topic
  userKey?: string;              // pushover user key
  apiToken?: string;             // pushover api token
}

// === Cron Channel Config ===

interface CronChannelConfig {
  type: 'cron';
  jobs: CronJob[];
}

interface CronJob {
  name: string;
  schedule: string;              // cron expression
  message: string;               // message to inject
  enabled: boolean;
}
```

---

## 4. Database Schema (Complete)

All SQLite tables in one database. Indexes included.

```sql
-- ============================================================
-- Ved Database Schema — SQLite
-- Single file: ved.db
-- ============================================================

-- === Pragma ===
PRAGMA journal_mode = WAL;           -- concurrent reads during writes
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- === Inbox (crash-safe message receipt) ===
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,                -- ULID
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT,                   -- JSON array
  reply_to TEXT,
  received_at INTEGER NOT NULL,      -- unix ms
  processed INTEGER DEFAULT 0        -- 0=pending, 1=done
);
CREATE INDEX idx_inbox_pending ON inbox(processed) WHERE processed = 0;

-- === Sessions ===
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- ULID
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  working_memory TEXT,                -- JSON: serialized T1 state
  status TEXT DEFAULT 'active'        -- active | idle | closed
);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_author ON sessions(author, channel);

-- === Audit Log (hash-chained) ===
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,                -- ULID
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL,               -- JSON
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX idx_audit_type ON audit_log(event_type);
CREATE INDEX idx_audit_time ON audit_log(timestamp);
CREATE INDEX idx_audit_actor ON audit_log(actor);

-- === HMAC Anchors ===
CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY,                -- ULID
  chain_head_id TEXT NOT NULL REFERENCES audit_log(id),
  chain_head_hash TEXT NOT NULL,
  hmac TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- === Work Orders (HITL approval queue) ===
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,                -- ULID
  message_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  params TEXT NOT NULL,               -- JSON
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trust_tier INTEGER NOT NULL,
  result TEXT,                        -- JSON
  error TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,
  audit_hash TEXT
);
CREATE INDEX idx_wo_status ON work_orders(status);
CREATE INDEX idx_wo_message ON work_orders(message_id);

-- === RAG: Chunks ===
CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,            -- ULID
  file_path TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  file_modified_at INTEGER NOT NULL
);
CREATE INDEX idx_chunks_file ON chunks(file_path);

-- === RAG: Vector Index (sqlite-vec) ===
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[768]
);

-- === RAG: FTS5 ===
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  file_path,
  heading,
  content=chunks,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, file_path, heading)
  VALUES (new.rowid, new.content, new.file_path, new.heading);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
  VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
  VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
  INSERT INTO chunks_fts(rowid, content, file_path, heading)
  VALUES (new.rowid, new.content, new.file_path, new.heading);
END;

-- === Schema version (for migrations) ===
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
INSERT OR IGNORE INTO schema_version VALUES (1, strftime('%s','now') * 1000, 'Initial schema');
```

---

## 5. Module Sizes & File Structure

```
src/
├── types/
│   └── index.ts                    # ~350 lines — all shared types
├── core/
│   ├── event-loop.ts               # ~400 lines — main loop
│   ├── session.ts                  # ~200 lines — session manager
│   ├── queue.ts                    # ~80 lines — priority message queue
│   ├── config.ts                   # ~150 lines — load, validate, defaults
│   └── working-memory.ts           # ~200 lines — T1 working memory
├── llm/
│   ├── client.ts                   # ~200 lines — LLMClient implementation
│   ├── adapters/
│   │   ├── anthropic.ts            # ~150 lines
│   │   ├── openai.ts               # ~150 lines
│   │   ├── openrouter.ts           # ~100 lines (thin wrapper on openai)
│   │   └── ollama.ts               # ~120 lines
│   └── prompts.ts                  # ~100 lines — system prompt, compression, extraction
├── mcp/
│   ├── client.ts                   # ~250 lines — MCPClient implementation
│   ├── stdio-transport.ts          # ~200 lines
│   └── http-transport.ts           # ~150 lines
├── memory/
│   ├── manager.ts                  # ~400 lines — MemoryManager implementation
│   ├── vault.ts                    # ~500 lines — VaultManager
│   ├── vault-git.ts                # ~200 lines — GitBatcher
│   ├── vault-index.ts              # ~300 lines — indexing, backlinks, wikilink parsing
│   ├── templates.ts                # ~100 lines — template engine
│   └── compression.ts              # ~200 lines — T1→T2 compression
├── rag/
│   ├── pipeline.ts                 # ~300 lines — RagPipeline implementation
│   ├── embedder.ts                 # ~150 lines — Ollama embedder
│   ├── chunker.ts                  # ~250 lines — heading-based chunking
│   ├── search.ts                   # ~200 lines — vector + FTS5 + graph search
│   └── fusion.ts                   # ~100 lines — RRF + context assembly
├── audit/
│   ├── log.ts                      # ~400 lines — AuditLog implementation
│   ├── hash.ts                     # ~100 lines — SHA-256 hash chain
│   └── anchor.ts                   # ~150 lines — HMAC anchoring
├── trust/
│   ├── engine.ts                   # ~400 lines — TrustEngine implementation
│   ├── matrix.ts                   # ~100 lines — trust matrix + evaluation
│   └── work-order.ts              # ~200 lines — work order CRUD
├── channel/
│   ├── manager.ts                  # ~200 lines — ChannelManager
│   ├── discord.ts                  # ~500 lines — Discord adapter
│   ├── cli.ts                      # ~250 lines — CLI adapter
│   ├── push.ts                     # ~200 lines — Push notifications
│   └── cron.ts                     # ~150 lines — Cron adapter
├── db/
│   ├── connection.ts               # ~100 lines — better-sqlite3 wrapper
│   └── schema.sql                  # ~80 lines — DDL (above)
└── index.ts                        # ~50 lines — entry point, wires modules

Total estimate: ~7,700 lines
Budget: <10K lines ✓ (2,300 lines of headroom)
```

---

## 6. Cross-Module Interaction Patterns

### 6.1 Message Processing (happy path)

```
1. ChannelAdapter.onMessage(msg)
   → ChannelManager routes to EventLoop

2. EventLoop.receive(msg)
   → AuditLog.log({ eventType: 'message_received', ... })
   → inbox INSERT (crash-safe)

3. EventLoop.enrich(msg, session)
   → MemoryManager.getWorkingMemory(session.id)
   → RagPipeline.retrieve(msg.content)
   → assemble prompt string

4. EventLoop.decide(prompt)
   → LLMClient.chat(request)
   → AuditLog.log({ eventType: 'llm_call', ... })
   → AuditLog.log({ eventType: 'llm_response', ... })
   → returns LLMDecision

5. EventLoop.act(decision)
   → for each toolCall:
       TrustEngine.evaluate(call, tier, risk)
       → 'auto': MCPClient.executeTool(call)
       → 'approve': TrustEngine.createWorkOrder(...)
       → 'deny': skip, inform LLM
   → AuditLog.log({ eventType: 'tool_executed', ... })
   → if more tool calls needed: goto 4 (agentic loop)

6. EventLoop.record(everything)
   → MemoryManager.executeOps(decision.memoryOps)
   → AuditLog anchor check

7. EventLoop.respond(response)
   → ChannelManager.send(channelId, response)
   → AuditLog.log({ eventType: 'message_sent', ... })

8. EventLoop.maintain()
   → MemoryManager.compressToDaily() (if threshold)
   → RagPipeline.drainQueue() (if pending)
   → VaultGit.flush() (if dirty + timer)
```

### 6.2 Memory Write Flow

```
LLM says "remember X" → MemoryOp
   │
   ▼
MemoryManager.executeOps([op])
   │
   ├── WorkingMemoryOp → WorkingMemory.setFact(key, value)
   │   → AuditLog.log({ eventType: 'memory_t1_write', ... })
   │
   ├── EpisodicWriteOp → VaultManager.appendToFile(dailyPath, content)
   │   → AuditLog.log({ eventType: 'memory_t2_compress', ... })
   │   → RagPipeline.enqueueReindex(dailyPath)
   │   → VaultGit.markDirty(dailyPath)
   │
   ├── SemanticUpsertOp → VaultManager.createFile/updateFile(...)
   │   → AuditLog.log({ eventType: 'memory_t3_upsert', ... })
   │   → RagPipeline.enqueueReindex(path)
   │   → VaultGit.markDirty(path)
   │
   └── RagIndexOp → RagPipeline.reindexFile(path)
       → AuditLog.log({ eventType: 'rag_reindex', ... })
```

---

## 7. Configuration Defaults

```typescript
const DEFAULT_CONFIG: VedConfig = {
  name: 'Ved',
  version: '0.1.0',

  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    maxTokensPerMessage: 4096,
    maxTokensPerSession: 100_000,
    temperature: 0.7,
  },

  memory: {
    vaultPath: '~/ved-vault',
    workingMemoryMaxTokens: 8192,
    ragContextMaxTokens: 4096,
    compressionThreshold: 6000,
    sessionIdleMinutes: 30,
    gitEnabled: true,
    gitAutoCommitIntervalMinutes: 15,
  },

  trust: {
    ownerIds: [],
    tribeIds: [],
    knownIds: [],
    defaultTier: 1,
    approvalTimeoutMs: 5 * 60 * 1000,  // 5 minutes
    maxToolCallsPerMessage: 10,
    maxAgenticLoops: 10,
  },

  audit: {
    anchorInterval: 100,               // every 100 entries
  },

  rag: {
    vectorTopK: 10,
    ftsTopK: 10,
    graphMaxDepth: 1,
    graphMaxNodes: 5,
    maxContextTokens: 4096,
    rrfK: 60,
    embedding: {
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
      batchSize: 32,
      dimensions: 768,
    },
    chunking: {
      maxTokens: 1024,
      minTokens: 64,
      frontmatterPrefix: true,
    },
  },

  channels: [],

  dbPath: '~/.ved/ved.db',
  logLevel: 'info',
};
```

---

## 8. External Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `better-sqlite3` | SQLite driver (sync, fast) | ~2MB |
| `sqlite-vec` | Vector search extension | ~500KB |
| `ulid` | ULID generation | ~5KB |
| `chokidar` | Filesystem watcher (vault) | ~100KB |
| `discord.js` | Discord channel adapter | ~2MB |
| `gray-matter` | YAML frontmatter parsing | ~30KB |
| `readline` | CLI channel (Node.js built-in) | 0 |

**Total external deps: 6 packages** (7 with discord.js optional).
No frameworks. No ORMs. No vector DBs. No build tools beyond TypeScript compiler.

---

## 9. Open Questions for Session 25

1. **Migration system:** How do we handle schema changes? Simple version table + up/down SQL scripts?
2. **Config file format:** YAML? TOML? JSON? Where does it live?
3. **Error types:** Should we define a Ved error hierarchy? Or just use Error + codes?
4. **Logging interface:** Structured logging (pino)? Or console + audit log is enough?
5. **Testing strategy:** Unit tests per module? Integration tests via Docker? Both?

---

*End of module interfaces. Next: Session 25 — Database schema (complete SQL DDL) + migration system.*
