# Ved — Config Schema, Error Codes & Logging Design

> Session 26 deliverable. PLAN phase (3 of 5).
> Depends on: module-interfaces.md (S24), database-schema.md (S25)

---

## 1. Configuration

### 1.1 File Location & Loading

```
~/.ved/
├── config.yaml          ← primary config
├── config.local.yaml    ← optional overrides (gitignored, secrets)
├── ved.db               ← SQLite (default dbPath)
└── logs/                ← optional file logging
```

**Loading order (deep merge, later wins):**
1. Built-in defaults (hardcoded in `ved-core`)
2. `~/.ved/config.yaml` (user config)
3. `~/.ved/config.local.yaml` (secrets, local overrides — optional)
4. Environment variables (`VED_*` prefix)
5. CLI flags (highest priority)

**Environment variable mapping:** Nested YAML keys flatten with `_` separator, uppercased.
- `llm.apiKey` → `VED_LLM_API_KEY`
- `llm.model` → `VED_LLM_MODEL`
- `trust.approvalTimeoutMs` → `VED_TRUST_APPROVAL_TIMEOUT_MS`
- `memory.vaultPath` → `VED_MEMORY_VAULT_PATH`
- `dbPath` → `VED_DB_PATH`
- `logLevel` → `VED_LOG_LEVEL`

**Why config.local.yaml?** API keys shouldn't be in the main config that might get committed to git. `config.local.yaml` is for secrets. Environment variables also work for CI/Docker.

### 1.2 Complete YAML Schema

```yaml
# ~/.ved/config.yaml — Ved configuration
# All values below show defaults. Only override what you need.

# === Identity ===
name: Ved                          # Agent display name
version: "0.1.0"                   # Populated at build time

# === Database ===
dbPath: ~/.ved/ved.db              # SQLite database path (~ expanded at runtime)

# === Logging ===
logLevel: info                     # debug | info | warn | error
logFormat: json                    # json | pretty (pretty = human-readable for dev)
logFile: null                      # Optional: path to log file (in addition to console)

# === LLM ===
llm:
  provider: anthropic              # anthropic | openai | openrouter | ollama
  model: claude-sonnet-4-20250514    # Model identifier
  apiKey: null                     # Set in config.local.yaml or VED_LLM_API_KEY
  baseUrl: null                    # Custom API endpoint (required for ollama)
  maxTokensPerMessage: 4096        # Max output tokens per LLM call
  maxTokensPerSession: 100000      # Budget per session before warning
  temperature: 0.7                 # 0.0-2.0
  systemPromptPath: null           # Custom system prompt file path (default: built-in)

# === Memory ===
memory:
  vaultPath: ~/ved-vault           # Obsidian vault root (~ expanded)
  workingMemoryMaxTokens: 8000     # T1 token budget
  ragContextMaxTokens: 4000        # Max RAG context injected into prompt
  compressionThreshold: 6000       # T1 token count that triggers compression
  sessionIdleMinutes: 30           # Idle time before T1→T2 flush
  gitEnabled: true                 # Auto-commit vault changes
  gitAutoCommitIntervalMinutes: 5  # Batch commit interval

# === Trust ===
trust:
  ownerIds: []                     # REQUIRED — at least one owner
  tribeIds: []                     # Tier 3 trusted users
  knownIds: []                     # Tier 2 known users
  defaultTier: stranger            # stranger | known | tribe | owner
  approvalTimeoutMs: 300000        # 5 min HITL approval timeout
  maxToolCallsPerMessage: 10       # Safety cap per user message
  maxAgenticLoops: 10              # Max DECIDE→ACT iterations

# === Audit ===
audit:
  anchorInterval: 100              # Create HMAC anchor every N entries
  hmacSecret: null                 # Set in config.local.yaml or VED_AUDIT_HMAC_SECRET
                                   # If null, anchoring disabled (logged as warning)

# === RAG ===
rag:
  vectorTopK: 10                   # Candidates from vector search
  ftsTopK: 10                      # Candidates from FTS5
  graphMaxDepth: 2                 # Wikilink graph walk depth
  graphMaxNodes: 20                # Max nodes visited in graph walk
  maxContextTokens: 4000           # Final context budget (after fusion + ranking)
  rrfK: 60                         # RRF constant (standard value)
  
  embedding:
    model: nomic-embed-text        # Ollama embedding model
    baseUrl: http://localhost:11434 # Ollama API endpoint
    batchSize: 32                  # Vectors per batch
    dimensions: 768                # nomic-embed-text dimensions
  
  chunking:
    maxTokens: 1024                # Max tokens per chunk
    minTokens: 64                  # Min tokens (skip tiny chunks)
    frontmatterPrefix: true        # Prepend YAML frontmatter to each chunk

# === Channels ===
channels:
  - type: cli                      # Always available
    enabled: true
    config: {}

  # - type: discord
  #   enabled: false
  #   config:
  #     token: null                # Bot token (use config.local.yaml)
  #     guildId: null
  #     channelIds: []

  # - type: push                   # Future: ntfy/push notifications
  #   enabled: false
  #   config:
  #     endpoint: null

# === MCP Servers ===
mcp:
  servers: []
  # - name: filesystem
  #   transport: stdio
  #   command: npx
  #   args: ["-y", "@anthropic/mcp-server-filesystem", "/home/user/docs"]
  #   enabled: true
  #   trustOverride: null          # Optional: override trust tier for this server's tools
  
  # - name: web-search
  #   transport: http
  #   url: http://localhost:3001/mcp
  #   enabled: true
```

### 1.3 TypeScript Config Interface (Final)

Extends the S24 draft with new fields:

```typescript
// ved-types/config.ts

interface VedConfig {
  name: string;
  version: string;
  dbPath: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
  logFile: string | null;
  llm: LLMConfig;
  memory: MemoryConfig;
  trust: TrustConfig;
  audit: AuditConfig;
  rag: RagConfig;
  channels: ChannelConfig[];
  mcp: MCPConfig;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFormat = 'json' | 'pretty';

interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  maxTokensPerMessage: number;
  maxTokensPerSession: number;
  temperature: number;
  systemPromptPath: string | null;
}

interface MemoryConfig {
  vaultPath: string;
  workingMemoryMaxTokens: number;
  ragContextMaxTokens: number;
  compressionThreshold: number;
  sessionIdleMinutes: number;
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
  maxAgenticLoops: number;
}

interface AuditConfig {
  anchorInterval: number;
  hmacSecret: string | null;
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
  model: string;
  baseUrl: string;
  batchSize: number;
  dimensions: number;
}

interface ChunkConfig {
  maxTokens: number;
  minTokens: number;
  frontmatterPrefix: boolean;
}

type ChannelId = 'cli' | 'discord' | 'push';

interface ChannelConfig {
  type: ChannelId;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface MCPConfig {
  servers: MCPServerEntry[];
}

interface MCPServerEntry {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;         // stdio transport
  args?: string[];          // stdio transport
  url?: string;             // http transport
  enabled: boolean;
  trustOverride?: TrustTier | null;
}
```

### 1.4 Validation Rules

Config validated at startup using a pure-function validator (no library — keeps deps at zero).

```typescript
// ved-core/config.ts

interface ValidationError {
  path: string;      // 'trust.ownerIds'
  code: string;      // 'REQUIRED' | 'INVALID_TYPE' | 'OUT_OF_RANGE' | 'INVALID_VALUE'
  message: string;
}

function validateConfig(raw: unknown): { config: VedConfig; errors: ValidationError[] } {
  // Returns merged config (defaults + raw) and any validation errors.
  // If errors contain any with code 'REQUIRED', Ved refuses to start.
}
```

**Validation rules (hard errors — Ved won't start):**

| Path | Rule | Code |
|------|------|------|
| `trust.ownerIds` | Must have ≥1 entry | `REQUIRED` |
| `llm.provider` | Must be valid enum | `INVALID_VALUE` |
| `llm.model` | Must be non-empty string | `REQUIRED` |
| `llm.temperature` | 0.0 ≤ x ≤ 2.0 | `OUT_OF_RANGE` |
| `llm.maxTokensPerMessage` | > 0 | `OUT_OF_RANGE` |
| `llm.maxTokensPerSession` | > maxTokensPerMessage | `OUT_OF_RANGE` |
| `memory.vaultPath` | Must be non-empty string | `REQUIRED` |
| `memory.workingMemoryMaxTokens` | > 0 | `OUT_OF_RANGE` |
| `memory.compressionThreshold` | < workingMemoryMaxTokens | `OUT_OF_RANGE` |
| `rag.embedding.dimensions` | > 0 | `OUT_OF_RANGE` |
| `channels` | ≥1 enabled channel | `REQUIRED` |
| `dbPath` | Must be non-empty string | `REQUIRED` |

**Validation rules (warnings — Ved starts but logs warning):**

| Path | Rule | Warning |
|------|------|---------|
| `audit.hmacSecret` | null | "HMAC anchoring disabled — audit chain not externally verifiable" |
| `llm.apiKey` | null (non-ollama) | "No API key for {provider} — LLM calls will fail" |
| `rag.embedding.baseUrl` | unreachable | "Ollama not reachable — RAG embedding disabled" |
| `memory.gitEnabled` | true but no git repo | "Git enabled but vault is not a git repo" |

### 1.5 Path Expansion

All path fields (`dbPath`, `memory.vaultPath`, `logFile`, `llm.systemPromptPath`) support:
- `~` → `os.homedir()`
- Environment variables: `$HOME`, `${XDG_DATA_HOME}`
- Relative paths resolved from `~/.ved/`

```typescript
function expandPath(raw: string): string {
  let p = raw;
  p = p.replace(/^~(?=\/|$)/, os.homedir());
  p = p.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? '');
  if (!path.isAbsolute(p)) {
    p = path.resolve(path.join(os.homedir(), '.ved'), p);
  }
  return p;
}
```

### 1.6 Config Loading Implementation

```typescript
// ved-core/config.ts

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';    // 'yaml' package — one of our 6 deps

const CONFIG_DIR = path.join(os.homedir(), '.ved');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yaml');
const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'config.local.yaml');

function loadConfig(overrides?: Partial<VedConfig>): VedConfig {
  // 1. Start with defaults
  let config = structuredClone(DEFAULTS);

  // 2. Merge config.yaml
  if (existsSync(CONFIG_PATH)) {
    const raw = parseYaml(readFileSync(CONFIG_PATH, 'utf8'));
    config = deepMerge(config, raw);
  }

  // 3. Merge config.local.yaml (secrets)
  if (existsSync(LOCAL_CONFIG_PATH)) {
    const local = parseYaml(readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
    config = deepMerge(config, local);
  }

  // 4. Merge environment variables
  config = mergeEnvVars(config);

  // 5. Merge CLI overrides
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  // 6. Expand all paths
  config.dbPath = expandPath(config.dbPath);
  config.memory.vaultPath = expandPath(config.memory.vaultPath);
  if (config.logFile) config.logFile = expandPath(config.logFile);
  if (config.llm.systemPromptPath) config.llm.systemPromptPath = expandPath(config.llm.systemPromptPath);

  // 7. Validate
  const { errors } = validateConfig(config);
  const hard = errors.filter(e => e.code === 'REQUIRED' || e.code === 'OUT_OF_RANGE' || e.code === 'INVALID_VALUE');
  if (hard.length > 0) {
    throw new VedError('CONFIG_INVALID', `Config validation failed:\n${hard.map(e => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  return config;
}

function deepMerge(target: any, source: any): any {
  // Standard deep merge. Arrays are replaced, not concatenated.
  // null/undefined in source explicitly overrides target.
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
          && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  return result;
}
```

### 1.7 `ved init` — First Run

```bash
$ ved init
```

Creates `~/.ved/` directory with:
- `config.yaml` (commented template with defaults)
- `config.local.yaml` (template for secrets, `.gitignore`'d)
- `ved.db` (empty, migrations auto-run on first start)

Also initializes the Obsidian vault if it doesn't exist:
- `~/ved-vault/` with daily/, entities/, concepts/, decisions/, templates/
- `git init` + initial commit

---

## 2. Error Codes Catalog

### 2.1 Error Class

```typescript
// ved-types/errors.ts

class VedError extends Error {
  constructor(
    public readonly code: VedErrorCode,
    message: string,
    public readonly cause?: Error,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VedError';
  }

  /** Structured representation for logging */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause?.message,
    };
  }
}

type VedErrorCode = typeof VED_ERROR_CODES[number];
```

### 2.2 Error Code Registry

Error codes are `UPPER_SNAKE_CASE` strings. Prefixed by module. Grep-friendly, serializable, no class hierarchy.

```typescript
const VED_ERROR_CODES = [
  // === CONFIG (1xx pattern — for docs, not actual numbers) ===
  'CONFIG_NOT_FOUND',          // ~/.ved/config.yaml doesn't exist
  'CONFIG_PARSE_ERROR',        // YAML syntax error
  'CONFIG_INVALID',            // Validation failed (missing required, out of range)
  'CONFIG_PATH_NOT_FOUND',     // Expanded path doesn't exist

  // === DATABASE ===
  'DB_OPEN_FAILED',            // Can't open SQLite file
  'DB_MIGRATION_FAILED',       // Migration SQL error
  'DB_MIGRATION_CHECKSUM',     // Migration file tampered (checksum mismatch)
  'DB_QUERY_FAILED',           // Generic query error
  'DB_CONSTRAINT_VIOLATION',   // UNIQUE/FK/CHECK constraint

  // === LLM ===
  'LLM_API_KEY_MISSING',       // No API key for non-ollama provider
  'LLM_REQUEST_FAILED',        // HTTP error from provider
  'LLM_TIMEOUT',               // Request exceeded timeout
  'LLM_RATE_LIMITED',          // 429 from provider
  'LLM_CONTEXT_OVERFLOW',      // Prompt exceeds model context window
  'LLM_INVALID_RESPONSE',      // Response doesn't match expected schema
  'LLM_BUDGET_EXCEEDED',       // Session token budget hit

  // === MCP / TOOLS ===
  'MCP_SERVER_UNREACHABLE',    // Can't connect to MCP server
  'MCP_SERVER_TIMEOUT',        // Server didn't respond in time
  'MCP_TOOL_NOT_FOUND',        // LLM requested tool that doesn't exist
  'MCP_TOOL_EXECUTION_ERROR',  // Tool returned error result
  'MCP_TRANSPORT_ERROR',       // stdio/http transport failure
  'MCP_SCHEMA_INVALID',        // Tool definition doesn't match MCP spec

  // === MEMORY ===
  'MEMORY_VAULT_NOT_FOUND',    // Vault path doesn't exist
  'MEMORY_VAULT_NOT_GIT',      // gitEnabled but not a git repo
  'MEMORY_FILE_READ_ERROR',    // Can't read vault file
  'MEMORY_FILE_WRITE_ERROR',   // Can't write vault file
  'MEMORY_COMPRESSION_FAILED', // T1→T2 compression error
  'MEMORY_GIT_ERROR',          // Git operation failed
  'MEMORY_TEMPLATE_NOT_FOUND', // Requested template doesn't exist
  'MEMORY_FRONTMATTER_INVALID',// YAML frontmatter parse error

  // === RAG ===
  'RAG_EMBED_FAILED',          // Ollama embedding request failed
  'RAG_EMBED_UNREACHABLE',     // Ollama server not running
  'RAG_INDEX_FAILED',          // Re-index operation error
  'RAG_SEARCH_FAILED',         // Combined search pipeline error

  // === AUDIT ===
  'AUDIT_HASH_MISMATCH',       // Hash chain verification failed (tampering detected!)
  'AUDIT_ANCHOR_FAILED',       // HMAC anchoring error
  'AUDIT_WRITE_FAILED',        // Can't write to audit_log

  // === TRUST ===
  'TRUST_DENIED',              // Action blocked by trust tier
  'TRUST_APPROVAL_TIMEOUT',    // HITL approval timed out
  'TRUST_APPROVAL_REJECTED',   // Human explicitly rejected
  'TRUST_LOOP_LIMIT',          // Max agentic loops exceeded
  'TRUST_TOOL_LIMIT',          // Max tool calls per message exceeded

  // === CHANNEL ===
  'CHANNEL_INIT_FAILED',       // Channel adapter failed to initialize
  'CHANNEL_SEND_FAILED',       // Can't send message to channel
  'CHANNEL_AUTH_FAILED',       // Channel authentication error (e.g., Discord token)
  'CHANNEL_NOT_FOUND',         // Referenced channel doesn't exist

  // === SESSION ===
  'SESSION_NOT_FOUND',         // No active session for this context
  'SESSION_CLOSED',            // Attempted operation on closed session
  'SESSION_CREATE_FAILED',     // Can't create new session

  // === GENERAL ===
  'INTERNAL_ERROR',            // Unexpected/unhandled error (bug)
  'SHUTDOWN_TIMEOUT',          // Graceful shutdown exceeded timeout
] as const;
```

### 2.3 Error Handling Patterns

```typescript
// Pattern 1: Wrapping external errors
try {
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
} catch (err) {
  throw new VedError('LLM_REQUEST_FAILED', `${provider} API error for ${model}`, err as Error, {
    provider, model, status: (err as any).status
  });
}

// Pattern 2: Trust denial (not an "error" — expected control flow)
if (riskLevel > allowedRisk) {
  throw new VedError('TRUST_DENIED', `Tool "${toolName}" requires ${requiredTier} trust`, undefined, {
    toolName, riskLevel, userTier, requiredTier
  });
}

// Pattern 3: Audit integrity (CRITICAL — never swallow)
const valid = await auditLog.verifyChain(fromId, toId);
if (!valid) {
  // This is a SECURITY EVENT — always log, always surface
  throw new VedError('AUDIT_HASH_MISMATCH', 
    `Hash chain broken between entries ${fromId}–${toId}. Possible tampering.`);
}

// Pattern 4: Top-level catch in event loop
try {
  await pipeline.process(message);
} catch (err) {
  if (err instanceof VedError) {
    log('error', err.message, { code: err.code, ...err.context });
    await auditLog.log({ type: 'error', payload: err.toJSON() });
    // Respond to user with sanitized message (no stack traces)
    await channel.send(sanitizeError(err));
  } else {
    // Unexpected — wrap in INTERNAL_ERROR
    const wrapped = new VedError('INTERNAL_ERROR', 'Unexpected error', err as Error);
    log('error', wrapped.message, wrapped.toJSON());
    await auditLog.log({ type: 'error', payload: wrapped.toJSON() });
    await channel.send('Something went wrong. Check the audit log.');
  }
}
```

### 2.4 Error → User Message Mapping

Not all errors should show raw messages to users. Sanitization rules:

| Code Pattern | User sees | Details logged to |
|---|---|---|
| `CONFIG_*` | Not shown (startup only, logged to console) | Console |
| `DB_*` | "Internal error. Check logs." | Console + audit |
| `LLM_RATE_LIMITED` | "Rate limited by {provider}. Retrying in {n}s..." | Audit |
| `LLM_TIMEOUT` | "LLM response timed out. Try again." | Audit |
| `LLM_BUDGET_EXCEEDED` | "Session token budget reached ({used}/{limit})." | Audit |
| `MCP_TOOL_NOT_FOUND` | "Tool '{name}' not available." | Audit |
| `MCP_TOOL_EXECUTION_ERROR` | "Tool '{name}' failed: {sanitized_msg}" | Audit (full detail) |
| `MEMORY_*` | "Memory operation failed. Details in audit log." | Audit |
| `TRUST_DENIED` | "This action requires {tier} trust level." | Audit |
| `TRUST_APPROVAL_TIMEOUT` | "Approval timed out after {n}s." | Audit |
| `TRUST_APPROVAL_REJECTED` | "Action was rejected." | Audit |
| `TRUST_LOOP_LIMIT` | "Too many tool iterations. Stopping." | Audit |
| `AUDIT_HASH_MISMATCH` | "⚠️ SECURITY: Audit chain integrity violation detected." | Audit + console |
| `CHANNEL_*` | Not shown (channel is broken) | Console |
| `INTERNAL_ERROR` | "Something went wrong. Check the audit log." | Console + audit |

---

## 3. Structured Logging

### 3.1 Design Principles

1. **Zero dependencies** — use `console.log/warn/error` with JSON serialization
2. **Two sinks, different purposes:**
   - **Console** (stdout/stderr) — developer debugging, operations
   - **Audit log** (SQLite `audit_log` table) — permanent, hash-chained, tamper-evident
3. **Console is ephemeral** — not the source of truth. Audit log is.
4. **Structured** — every log entry is a JSON object. No template strings.
5. **Two formats:** `json` (production/machine) and `pretty` (development/human)

### 3.2 Log Interface

```typescript
// ved-core/log.ts

interface LogEntry {
  ts: string;              // ISO 8601 timestamp
  level: LogLevel;         // debug | info | warn | error
  msg: string;             // Human-readable message
  module?: string;         // ved-core | ved-llm | ved-memory | etc.
  sessionId?: string;      // Current session (if in session context)
  [key: string]: unknown;  // Arbitrary structured data
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
```

### 3.3 Logger Implementation

```typescript
// ved-core/log.ts

let _config: { level: LogLevel; format: LogFormat; file: string | null } = {
  level: 'info',
  format: 'json',
  file: null,
};

let _fileStream: import('node:fs').WriteStream | null = null;

function initLogger(config: VedConfig): void {
  _config = { level: config.logLevel, format: config.logFormat, file: config.logFile };
  if (_config.file) {
    const fs = require('node:fs');
    const dir = require('node:path').dirname(_config.file);
    fs.mkdirSync(dir, { recursive: true });
    _fileStream = fs.createWriteStream(_config.file, { flags: 'a' });
  }
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[_config.level]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };

  const output = _config.format === 'pretty' ? formatPretty(entry) : JSON.stringify(entry);

  // Console: stderr for warn/error, stdout for info/debug
  if (level === 'error' || level === 'warn') {
    console.error(output);
  } else {
    console.log(output);
  }

  // File sink (always JSON, even if console is pretty)
  if (_fileStream) {
    _fileStream.write(JSON.stringify(entry) + '\n');
  }
}

function formatPretty(entry: LogEntry): string {
  const time = entry.ts.slice(11, 23); // HH:mm:ss.sss
  const lvl = entry.level.toUpperCase().padEnd(5);
  const mod = entry.module ? `[${entry.module}]` : '';
  const { ts, level, msg, module, ...rest } = entry;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${time} ${lvl} ${mod} ${msg}${extra}`;
}

// Convenience wrappers (used by all modules)
const debug = (msg: string, data?: Record<string, unknown>) => log('debug', msg, data);
const info  = (msg: string, data?: Record<string, unknown>) => log('info',  msg, data);
const warn  = (msg: string, data?: Record<string, unknown>) => log('warn',  msg, data);
const error = (msg: string, data?: Record<string, unknown>) => log('error', msg, data);

// Module-scoped logger factory
function createLogger(moduleName: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, { module: moduleName, ...data }),
    info:  (msg: string, data?: Record<string, unknown>) => log('info',  msg, { module: moduleName, ...data }),
    warn:  (msg: string, data?: Record<string, unknown>) => log('warn',  msg, { module: moduleName, ...data }),
    error: (msg: string, data?: Record<string, unknown>) => log('error', msg, { module: moduleName, ...data }),
  };
}

export { initLogger, log, debug, info, warn, error, createLogger };
```

### 3.4 What Gets Logged Where

**Console only** (development/debugging — ephemeral):

| Level | What | Example |
|-------|------|---------|
| debug | Internal pipeline steps | `"RAG search: 12 candidates, 5 after fusion"` |
| debug | Config loading details | `"Merged config.local.yaml"` |
| debug | MCP transport bytes | `"MCP stdio: 234 bytes sent"` |
| info | Startup/shutdown | `"Ved started, 3 channels, 2 MCP servers"` |
| info | Session lifecycle | `"Session s_abc created for user discord:123"` |
| info | Memory operations | `"T1→T2 compression: 6200→1800 tokens"` |
| warn | Non-critical issues | `"Ollama not reachable, RAG disabled"` |
| error | Handled errors | `"LLM timeout after 30s for claude-sonnet-4-20250514"` |

**Audit log** (permanent, hash-chained — source of truth):

| Event Type | What | Always logged |
|------------|------|:---:|
| `message_received` | Every incoming user message | ✅ |
| `message_sent` | Every outgoing response | ✅ |
| `llm_call` | Every LLM request/response | ✅ |
| `tool_call` | Every MCP tool invocation | ✅ |
| `memory_op` | Every T1/T2/T3/T4 operation | ✅ |
| `trust_decision` | Every risk assessment | ✅ |
| `work_order` | HITL approval request/result | ✅ |
| `session_start` | Session created | ✅ |
| `session_end` | Session closed | ✅ |
| `config_change` | Config reload | ✅ |
| `error` | VedError instances | ✅ |
| `anchor_created` | HMAC anchor point | ✅ |
| `rag_query` | RAG pipeline invocation | ✅ |

**Key rule:** Console logging is *debug aid*. Audit log is *ground truth*. If they disagree, audit wins.

### 3.5 Log Output Examples

**JSON format** (production):
```json
{"ts":"2026-03-05T09:15:32.123Z","level":"info","msg":"Session created","module":"ved-core","sessionId":"s_a1b2c3","userId":"discord:719990816659210360","trustTier":"owner"}
{"ts":"2026-03-05T09:15:32.456Z","level":"debug","msg":"RAG retrieval","module":"ved-rag","sessionId":"s_a1b2c3","query":"what did we decide about the API?","vectorHits":8,"ftsHits":3,"graphHits":5,"fusedResults":6,"finalTokens":2847}
{"ts":"2026-03-05T09:15:33.789Z","level":"info","msg":"LLM response","module":"ved-llm","sessionId":"s_a1b2c3","provider":"anthropic","model":"claude-sonnet-4-20250514","inputTokens":4521,"outputTokens":1203,"durationMs":1334,"finishReason":"stop"}
{"ts":"2026-03-05T09:15:34.012Z","level":"warn","msg":"HMAC anchoring disabled — no secret configured","module":"ved-audit"}
{"ts":"2026-03-05T09:15:35.567Z","level":"error","msg":"Tool execution failed","module":"ved-mcp","code":"MCP_TOOL_EXECUTION_ERROR","tool":"filesystem.read","error":"ENOENT: no such file","sessionId":"s_a1b2c3"}
```

**Pretty format** (development):
```
09:15:32.123 INFO  [ved-core] Session created {"sessionId":"s_a1b2c3","userId":"discord:719990816659210360","trustTier":"owner"}
09:15:32.456 DEBUG [ved-rag] RAG retrieval {"query":"what did we decide about the API?","vectorHits":8,"ftsHits":3,"graphHits":5,"fusedResults":6,"finalTokens":2847}
09:15:33.789 INFO  [ved-llm] LLM response {"provider":"anthropic","model":"claude-sonnet-4-20250514","inputTokens":4521,"outputTokens":1203,"durationMs":1334}
09:15:34.012 WARN  [ved-audit] HMAC anchoring disabled — no secret configured
09:15:35.567 ERROR [ved-mcp] Tool execution failed {"code":"MCP_TOOL_EXECUTION_ERROR","tool":"filesystem.read","error":"ENOENT: no such file"}
```

### 3.6 Performance Considerations

- **No async logging** — `console.log` is sync and that's fine for our scale
- **Structured data passed by reference** — no cloning until serialization
- **Level check is first** — debug entries skip entirely in production
- **File stream is append-only** — no rotation (user's responsibility, or add later)
- **Audit writes are async but awaited** — can't lose audit entries

---

## 4. Cross-Cutting Concerns

### 4.1 Config → Logger → Audit Bootstrap Order

Startup must happen in this exact order:

```
1. loadConfig()           — Parse YAML, merge defaults, validate
2. initLogger(config)     — Set log level/format, open file stream
3. openDatabase(config)   — Open SQLite, run migrations
4. initAuditLog(db)       — Initialize hash chain from last entry
5. log config_change to audit — Record startup config
6. init remaining modules — Memory, RAG, Trust, MCP, Channels
```

**Why this order:** Logger needs config. Audit needs DB. Everything else needs all three. If config fails, we can't even log properly — so config errors go to raw stderr.

### 4.2 Sensitive Data Rules

**Never log:**
- `llm.apiKey` or `audit.hmacSecret` — redacted in all outputs
- Full user messages (audit log stores hash + reference, not raw PII in console)
- Stack traces to user-facing channels (console only)

**Always redact in console:**
```typescript
function redactConfig(config: VedConfig): Record<string, unknown> {
  const redacted = structuredClone(config) as any;
  if (redacted.llm?.apiKey) redacted.llm.apiKey = '***';
  if (redacted.audit?.hmacSecret) redacted.audit.hmacSecret = '***';
  for (const ch of redacted.channels ?? []) {
    if (ch.config?.token) ch.config.token = '***';
  }
  return redacted;
}
```

### 4.3 Dependency Tally Update

This design adds **0 new dependencies**. Running tally:
1. `yaml` — YAML parsing (config + Obsidian frontmatter) [already counted in S24 as `gray-matter`; switching to `yaml` — smaller, same purpose]
2. `better-sqlite3` — SQLite
3. `@anthropic-ai/sdk` — Anthropic client
4. `openai` — OpenAI/OpenRouter client
5. `discord.js` — Discord channel
6. `tiktoken` — Token counting

Total: **6 external dependencies.** Target met.

---

## 5. Open Questions for Next Session

None. All PLAN-phase open questions resolved (Q1-Q5 from S24 + config/errors/logging from this session).

**Remaining PLAN sessions (27-28):**
- **Session 27:** MCP integration spec — tool discovery flow, transport details, permission model, retry/timeout behavior. How does Ved discover tools from stdio/http MCP servers at startup? How do trust tiers map to tool permissions?
- **Session 28:** End-to-end walkthrough — trace a complete user message through all modules (inbox → session → working memory → RAG → LLM → tool call → HITL → audit → response → T1→T2 compression). Validate all interfaces connect. Final PLAN review.

---

*Config: 1 YAML file + 1 local secrets file + env vars + CLI flags. 16 validation rules.*
*Errors: 42 codes across 10 categories. One class, no hierarchy.*
*Logging: Structured JSON/pretty to console, hash-chained audit to SQLite. Zero new deps.*
