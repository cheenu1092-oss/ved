# Ved — Database Schema & Migration System

> Session 25 deliverable. Complete SQL DDL, migration framework, and supporting design decisions.

---

## 1. Design Principles

1. **Single database file** — `~/.ved/ved.db`. No external services. Backup = copy one file.
2. **WAL mode** — Concurrent reads during writes. Required for Ved's event loop (audit writes while RAG reads).
3. **ULIDs everywhere** — Sortable, unique, no auto-increment collisions. `TEXT PRIMARY KEY`.
4. **Timestamps as INTEGER** — Unix milliseconds. Smaller than ISO strings, sortable, no timezone ambiguity.
5. **JSON for flexible fields** — SQLite's `json()` validates on write. Structured where possible, JSON where schema varies.
6. **Triggers for FTS sync** — FTS5 content tables require manual sync triggers. No ORM magic.
7. **No foreign key cascades on delete** — Audit data is append-only. Work orders reference audit entries. Deleting anything breaks the chain.
8. **Migrations are SQL files** — No TypeScript migration DSL. Plain `.sql` files, numbered, run in order.

---

## 2. Complete DDL — v001 (Initial Schema)

```sql
-- ============================================================
-- Ved Database Schema v001 — Initial
-- File: migrations/v001_initial.sql
-- ============================================================

-- === Pragmas (applied on every connection, not in migration) ===
-- PRAGMA journal_mode = WAL;
-- PRAGMA foreign_keys = ON;
-- PRAGMA busy_timeout = 5000;
-- PRAGMA synchronous = NORMAL;

-- ============================================================
-- INBOX — Crash-safe message receipt
-- ============================================================
-- Every inbound message is written here FIRST, before any processing.
-- If Ved crashes mid-processing, unprocessed messages are retried on restart.

CREATE TABLE IF NOT EXISTS inbox (
  id            TEXT PRIMARY KEY,          -- ULID
  channel       TEXT NOT NULL,             -- 'discord' | 'cli' | 'cron' | 'push'
  channel_id    TEXT NOT NULL,             -- channel-specific ID (guild#channel, tty, etc.)
  author_id     TEXT NOT NULL,             -- channel-specific user ID
  author_name   TEXT NOT NULL DEFAULT '',  -- display name (for logs/UI, not auth)
  content       TEXT NOT NULL,             -- message body
  attachments   TEXT DEFAULT '[]',         -- JSON array of {url, filename, contentType}
  reply_to      TEXT,                      -- message ID being replied to (nullable)
  metadata      TEXT DEFAULT '{}',         -- JSON: channel-specific extras
  received_at   INTEGER NOT NULL,          -- unix ms — when Ved received it
  processed     INTEGER NOT NULL DEFAULT 0,-- 0=pending, 1=done, 2=error
  error         TEXT,                      -- error message if processed=2
  session_id    TEXT                       -- assigned session (set during processing)
);

CREATE INDEX idx_inbox_pending ON inbox(processed) WHERE processed = 0;
CREATE INDEX idx_inbox_received ON inbox(received_at);
CREATE INDEX idx_inbox_session ON inbox(session_id) WHERE session_id IS NOT NULL;

-- ============================================================
-- SESSIONS — Conversation sessions
-- ============================================================
-- A session groups messages from one author on one channel.
-- Working memory (T1) is serialized here for persistence across restarts.

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,          -- ULID
  channel         TEXT NOT NULL,             -- 'discord' | 'cli' | 'cron' | 'push'
  channel_id      TEXT NOT NULL,             -- channel-specific location
  author_id       TEXT NOT NULL,             -- who this session belongs to
  trust_tier      INTEGER NOT NULL DEFAULT 1,-- 1=stranger, 2=known, 3=tribe, 4=owner
  started_at      INTEGER NOT NULL,          -- unix ms
  last_active     INTEGER NOT NULL,          -- unix ms — updated on every message
  working_memory  TEXT DEFAULT '{}',         -- JSON: serialized T1 state (facts, context)
  token_count     INTEGER NOT NULL DEFAULT 0,-- running token usage for this session
  status          TEXT NOT NULL DEFAULT 'active', -- 'active' | 'idle' | 'closed'
  closed_at       INTEGER,                   -- unix ms — when session was closed
  summary         TEXT                       -- T1→T2 compression summary (written on close)
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_author ON sessions(author_id, channel);
CREATE INDEX idx_sessions_active ON sessions(last_active) WHERE status = 'active';

-- ============================================================
-- AUDIT_LOG — Hash-chained action log (append-only)
-- ============================================================
-- EVERY significant action is recorded here with a hash chain.
-- This is T4 storage. Never deleted. Never updated. Append-only.
--
-- Hash chain: hash = SHA-256(prev_hash + timestamp + event_type + actor + detail)
-- First entry: prev_hash = SHA-256("ved-genesis")

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,          -- ULID
  timestamp   INTEGER NOT NULL,          -- unix ms
  event_type  TEXT NOT NULL,             -- see Event Types below
  actor       TEXT NOT NULL,             -- 'ved' | 'user:<id>' | 'system' | 'cron'
  session_id  TEXT,                      -- nullable (some events are sessionless)
  detail      TEXT NOT NULL DEFAULT '{}',-- JSON: event-specific payload
  prev_hash   TEXT NOT NULL,             -- hash of previous entry (chain link)
  hash        TEXT NOT NULL              -- SHA-256 of this entry (chain head)
);

CREATE INDEX idx_audit_type ON audit_log(event_type);
CREATE INDEX idx_audit_time ON audit_log(timestamp);
CREATE INDEX idx_audit_actor ON audit_log(actor);
CREATE INDEX idx_audit_session ON audit_log(session_id) WHERE session_id IS NOT NULL;

-- Event types (documented, not enforced in schema):
-- message_received, message_sent, llm_call, llm_response,
-- tool_requested, tool_approved, tool_denied, tool_executed, tool_error,
-- memory_t1_write, memory_t1_delete, memory_t2_compress,
-- memory_t3_upsert, memory_t3_delete,
-- rag_reindex, rag_query,
-- session_start, session_close, session_idle,
-- trust_change, work_order_created, work_order_resolved,
-- anchor_created, config_change,
-- startup, shutdown, error

-- ============================================================
-- ANCHORS — HMAC integrity checkpoints
-- ============================================================
-- Periodic HMAC snapshots of the audit chain head.
-- Used for tamper detection: if someone modifies audit_log entries,
-- the HMAC won't match when verified against the anchor secret.

CREATE TABLE IF NOT EXISTS anchors (
  id              TEXT PRIMARY KEY,          -- ULID
  chain_head_id   TEXT NOT NULL,             -- audit_log.id at anchor time
  chain_head_hash TEXT NOT NULL,             -- hash of that entry
  chain_length    INTEGER NOT NULL,          -- total entries at anchor time
  hmac            TEXT NOT NULL,             -- HMAC-SHA256(chain_head_hash, secret)
  algorithm       TEXT NOT NULL DEFAULT 'hmac-sha256',
  timestamp       INTEGER NOT NULL           -- unix ms
);

CREATE INDEX idx_anchors_time ON anchors(timestamp);

-- ============================================================
-- WORK_ORDERS — HITL approval queue
-- ============================================================
-- When a tool call exceeds the user's trust tier auto-approve threshold,
-- it becomes a work order that needs human approval.

CREATE TABLE IF NOT EXISTS work_orders (
  id            TEXT PRIMARY KEY,          -- ULID
  session_id    TEXT NOT NULL,             -- which session triggered this
  message_id    TEXT NOT NULL,             -- which inbox message triggered this
  tool_name     TEXT NOT NULL,             -- MCP tool name
  tool_server   TEXT NOT NULL DEFAULT '',  -- MCP server name
  params        TEXT NOT NULL DEFAULT '{}',-- JSON: tool call parameters
  risk_level    TEXT NOT NULL,             -- 'low' | 'medium' | 'high' | 'critical'
  risk_reasons  TEXT DEFAULT '[]',         -- JSON array of strings explaining risk
  trust_tier    INTEGER NOT NULL,          -- trust tier of the requester
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'denied'|'expired'|'cancelled'
  result        TEXT,                      -- JSON: tool execution result (if approved+executed)
  error         TEXT,                      -- error message (if execution failed)
  created_at    INTEGER NOT NULL,          -- unix ms
  expires_at    INTEGER NOT NULL,          -- unix ms — auto-expire after timeout
  resolved_at   INTEGER,                   -- unix ms — when approved/denied
  resolved_by   TEXT,                      -- who approved/denied ('user:<id>' | 'system:timeout')
  audit_id      TEXT                       -- audit_log.id for the resolution event
);

CREATE INDEX idx_wo_status ON work_orders(status) WHERE status = 'pending';
CREATE INDEX idx_wo_session ON work_orders(session_id);
CREATE INDEX idx_wo_expires ON work_orders(expires_at) WHERE status = 'pending';

-- ============================================================
-- TRUST_LEDGER — Identity → trust tier mapping
-- ============================================================
-- Maps channel-specific user identities to trust tiers.
-- Config file has owner/tribe lists; this table allows runtime changes
-- and provides audit trail for trust modifications.

CREATE TABLE IF NOT EXISTS trust_ledger (
  id          TEXT PRIMARY KEY,          -- ULID
  channel     TEXT NOT NULL,             -- 'discord' | 'cli' | etc.
  user_id     TEXT NOT NULL,             -- channel-specific user ID
  user_name   TEXT NOT NULL DEFAULT '',  -- display name (convenience)
  trust_tier  INTEGER NOT NULL,          -- 1-4
  granted_by  TEXT NOT NULL,             -- 'config' | 'user:<id>' | 'system'
  granted_at  INTEGER NOT NULL,          -- unix ms
  revoked_at  INTEGER,                   -- unix ms (null = active)
  reason      TEXT DEFAULT '',           -- why this tier was granted
  UNIQUE(channel, user_id, revoked_at)   -- one active tier per user per channel
);

CREATE INDEX idx_trust_active ON trust_ledger(channel, user_id) WHERE revoked_at IS NULL;

-- ============================================================
-- RAG: CHUNKS — Obsidian vault file chunks
-- ============================================================
-- Every Obsidian vault file is chunked by heading and stored here.
-- Chunks are the unit of RAG retrieval.

CREATE TABLE IF NOT EXISTS chunks (
  rowid           INTEGER PRIMARY KEY AUTOINCREMENT,  -- needed for FTS5 content sync
  id              TEXT NOT NULL UNIQUE,     -- ULID
  file_path       TEXT NOT NULL,            -- relative to vault root (e.g., 'entities/nag.md')
  heading         TEXT DEFAULT '',          -- heading text (empty = file-level chunk)
  heading_level   INTEGER DEFAULT 0,        -- 0=none, 1=#, 2=##, etc.
  content         TEXT NOT NULL,            -- chunk text (includes heading)
  frontmatter     TEXT DEFAULT '{}',        -- JSON: file's YAML frontmatter (attached to all chunks from same file)
  token_count     INTEGER NOT NULL,         -- approximate token count
  chunk_index     INTEGER NOT NULL DEFAULT 0, -- order within file (0-based)
  file_modified_at INTEGER NOT NULL,        -- unix ms — file's mtime when indexed
  indexed_at      INTEGER NOT NULL          -- unix ms — when this chunk was created/updated
);

CREATE INDEX idx_chunks_file ON chunks(file_path);
CREATE INDEX idx_chunks_modified ON chunks(file_modified_at);

-- ============================================================
-- RAG: VECTOR INDEX (sqlite-vec)
-- ============================================================
-- Stores embeddings for each chunk. Linked to chunks by rowid.
-- nomic-embed-text produces 768-dimensional vectors.

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[768]
);

-- ============================================================
-- RAG: FULL-TEXT SEARCH INDEX (FTS5)
-- ============================================================
-- Content-sync'd FTS5 table for keyword search across chunks.
-- Uses porter stemmer + unicode61 tokenizer.

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  file_path,
  heading,
  content=chunks,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- FTS5 sync triggers — keep FTS in sync with chunks table
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

-- ============================================================
-- RAG: GRAPH EDGES — Wikilink relationship index
-- ============================================================
-- Extracted from Obsidian [[wikilinks]] during chunking.
-- Enables graph walk retrieval: find related files via link structure.

CREATE TABLE IF NOT EXISTS graph_edges (
  id          TEXT PRIMARY KEY,          -- ULID
  source_file TEXT NOT NULL,             -- file containing the [[link]]
  target_file TEXT NOT NULL,             -- resolved link target (relative path)
  link_text   TEXT NOT NULL,             -- raw wikilink text (e.g., 'nag|Nagarjun')
  context     TEXT DEFAULT '',           -- surrounding sentence for relevance
  indexed_at  INTEGER NOT NULL           -- unix ms
);

CREATE INDEX idx_edges_source ON graph_edges(source_file);
CREATE INDEX idx_edges_target ON graph_edges(target_file);
CREATE UNIQUE INDEX idx_edges_pair ON graph_edges(source_file, target_file, link_text);

-- ============================================================
-- OUTBOX — Outgoing messages (crash-safe send)
-- ============================================================
-- Mirrors inbox for outgoing messages. Ved writes here first,
-- then the channel adapter sends and marks as delivered.
-- If Ved crashes after LLM response but before send, retry on restart.

CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,          -- ULID
  session_id  TEXT NOT NULL,
  channel     TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',         -- JSON array
  reply_to    TEXT,                      -- message ID to reply to
  metadata    TEXT DEFAULT '{}',         -- JSON: channel-specific (embeds, components, etc.)
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'error'
  error       TEXT,
  created_at  INTEGER NOT NULL,          -- unix ms
  sent_at     INTEGER                    -- unix ms
);

CREATE INDEX idx_outbox_pending ON outbox(status) WHERE status = 'pending';
CREATE INDEX idx_outbox_session ON outbox(session_id);

-- ============================================================
-- LLM_CALLS — LLM request/response log
-- ============================================================
-- Detailed log of every LLM call for debugging, cost tracking,
-- and replay. Audit_log has the event; this has the full payloads.

CREATE TABLE IF NOT EXISTS llm_calls (
  id              TEXT PRIMARY KEY,          -- ULID
  session_id      TEXT NOT NULL,
  audit_id        TEXT,                      -- links to audit_log entry
  provider        TEXT NOT NULL,             -- 'anthropic' | 'openai' | 'openrouter' | 'ollama'
  model           TEXT NOT NULL,             -- model identifier
  system_prompt   TEXT,                      -- system message (can be large, compress if needed)
  messages        TEXT NOT NULL DEFAULT '[]',-- JSON: conversation messages sent
  tools           TEXT DEFAULT '[]',         -- JSON: tool definitions sent
  response        TEXT NOT NULL DEFAULT '{}',-- JSON: full LLM response
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,-- wall clock time
  cost_usd        REAL,                      -- estimated cost (nullable — local models = null)
  error           TEXT,                      -- error message if call failed
  created_at      INTEGER NOT NULL           -- unix ms
);

CREATE INDEX idx_llm_session ON llm_calls(session_id);
CREATE INDEX idx_llm_time ON llm_calls(created_at);
CREATE INDEX idx_llm_model ON llm_calls(model);

-- ============================================================
-- TOOL_CALLS — MCP tool execution log
-- ============================================================
-- Every tool execution (approved or auto-approved).
-- Links to work_order if HITL was involved.

CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,          -- ULID
  session_id      TEXT NOT NULL,
  audit_id        TEXT,                      -- links to audit_log entry
  work_order_id   TEXT,                      -- links to work_orders (null if auto-approved)
  server_name     TEXT NOT NULL,             -- MCP server name
  tool_name       TEXT NOT NULL,             -- MCP tool name
  params          TEXT NOT NULL DEFAULT '{}',-- JSON: input parameters
  result          TEXT,                      -- JSON: tool result
  error           TEXT,                      -- error message if failed
  risk_level      TEXT NOT NULL DEFAULT 'low',
  auto_approved   INTEGER NOT NULL DEFAULT 1,-- 1=auto, 0=HITL approved
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL           -- unix ms
);

CREATE INDEX idx_tool_session ON tool_calls(session_id);
CREATE INDEX idx_tool_name ON tool_calls(tool_name);
CREATE INDEX idx_tool_time ON tool_calls(created_at);

-- ============================================================
-- MCP_SERVERS — Configured MCP server registry
-- ============================================================
-- Stores MCP server configurations. Can be populated from config
-- file or added at runtime via admin commands.

CREATE TABLE IF NOT EXISTS mcp_servers (
  name        TEXT PRIMARY KEY,           -- unique server name
  transport   TEXT NOT NULL,              -- 'stdio' | 'http'
  command     TEXT,                       -- stdio: command to run
  args        TEXT DEFAULT '[]',          -- stdio: JSON array of args
  env         TEXT DEFAULT '{}',          -- stdio: JSON object of env vars
  url         TEXT,                       -- http: endpoint URL
  headers     TEXT DEFAULT '{}',          -- http: JSON object of headers
  enabled     INTEGER NOT NULL DEFAULT 1, -- 0=disabled, 1=enabled
  trust_floor INTEGER NOT NULL DEFAULT 2, -- minimum trust tier to use any tool
  tool_overrides TEXT DEFAULT '{}',       -- JSON: {toolName: {riskLevel, trustFloor}}
  added_at    INTEGER NOT NULL,           -- unix ms
  updated_at  INTEGER NOT NULL            -- unix ms
);

-- ============================================================
-- CRON_JOBS — Scheduled tasks
-- ============================================================
-- Ved's internal cron. Simpler than external cron — audit-integrated.

CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT PRIMARY KEY,          -- ULID
  name        TEXT NOT NULL UNIQUE,      -- human-readable job name
  schedule    TEXT NOT NULL,             -- cron expression (5-field)
  channel     TEXT NOT NULL DEFAULT 'cron', -- channel to deliver as
  message     TEXT NOT NULL,             -- message content to inject
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run    INTEGER,                   -- unix ms
  next_run    INTEGER,                   -- unix ms (pre-computed)
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_cron_next ON cron_jobs(next_run) WHERE enabled = 1;

-- ============================================================
-- SCHEMA VERSION — Migration tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,          -- unix ms
  filename    TEXT NOT NULL,             -- migration filename
  checksum    TEXT NOT NULL,             -- SHA-256 of migration file content
  description TEXT DEFAULT ''
);

INSERT INTO schema_version (version, applied_at, filename, checksum, description)
VALUES (1, strftime('%s','now') * 1000, 'v001_initial.sql', '', 'Initial schema');
```

---

## 3. Migration System

### 3.1 Philosophy

Simple. Boring. Reliable.

- **Forward-only** — No "down" migrations. If a migration is wrong, write a new one that fixes it.
- **SQL files** — No TypeScript migration DSL. Plain SQL, versioned, readable.
- **Checksums** — Each migration file is SHA-256'd before execution. Stored in `schema_version`. Detects tampering.
- **Transactional** — Each migration runs inside a transaction. If it fails, nothing changes.
- **Idempotent schema** — `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` everywhere. Safe to re-run.

### 3.2 File Convention

```
src/db/
├── migrations/
│   ├── v001_initial.sql         # The DDL above
│   ├── v002_add_foo.sql         # Future migration
│   └── v003_fix_bar.sql         # Future migration
├── connection.ts                # Database connection + pragma setup
├── migrate.ts                   # Migration runner
└── schema.ts                    # TypeScript types for all tables (generated or manual)
```

Migration filenames: `v{NNN}_{description}.sql`
- `NNN` = zero-padded 3-digit version number
- Version extracted from filename, must be sequential (no gaps)
- Description is for humans only

### 3.3 Migration Runner

```typescript
// src/db/migrate.ts

import Database from 'better-sqlite3';
import { createHash, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface MigrationFile {
  version: number;
  filename: string;
  path: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: number;
  filename: string;
  checksum: string;
}

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Discover migration files on disk, sorted by version.
 */
function discoverMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^v\d{3}_.*\.sql$/.test(f))
    .sort();

  return files.map(filename => {
    const version = parseInt(filename.slice(1, 4), 10);
    const filePath = join(MIGRATIONS_DIR, filename);
    const sql = readFileSync(filePath, 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { version, filename, path: filePath, checksum, sql };
  });
}

/**
 * Get already-applied migrations from the database.
 */
function getApplied(db: Database.Database): AppliedMigration[] {
  // schema_version table might not exist yet (fresh database)
  const tableExists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='schema_version'
  `).get();

  if (!tableExists) return [];

  return db.prepare(`
    SELECT version, filename, checksum FROM schema_version
    ORDER BY version
  `).all() as AppliedMigration[];
}

/**
 * Run all pending migrations. Returns count of migrations applied.
 *
 * Safety:
 * - Validates no gaps in version sequence
 * - Validates checksums of already-applied migrations haven't changed
 * - Each migration runs in a transaction
 * - Records result in schema_version with checksum
 */
export function migrate(db: Database.Database): number {
  const available = discoverMigrations();
  const applied = getApplied(db);

  // Validate: no version gaps
  for (let i = 0; i < available.length; i++) {
    if (available[i].version !== i + 1) {
      throw new Error(
        `Migration version gap: expected v${String(i + 1).padStart(3, '0')}, ` +
        `found ${available[i].filename}`
      );
    }
  }

  // Validate: applied migrations haven't been tampered with
  for (const prev of applied) {
    const file = available.find(m => m.version === prev.version);
    if (!file) {
      throw new Error(
        `Applied migration v${String(prev.version).padStart(3, '0')} ` +
        `(${prev.filename}) not found on disk`
      );
    }
    if (file.checksum !== prev.checksum) {
      throw new Error(
        `Migration ${prev.filename} has been modified after application! ` +
        `Expected checksum ${prev.checksum}, got ${file.checksum}`
      );
    }
  }

  // Find pending migrations
  const appliedVersions = new Set(applied.map(a => a.version));
  const pending = available.filter(m => !appliedVersions.has(m.version));

  if (pending.length === 0) return 0;

  // Apply each pending migration in order
  const insertVersion = db.prepare(`
    INSERT INTO schema_version (version, applied_at, filename, checksum, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const migration of pending) {
    console.log(`Applying migration: ${migration.filename}`);

    const txn = db.transaction(() => {
      // Execute migration SQL
      db.exec(migration.sql);

      // Record in schema_version
      insertVersion.run(
        migration.version,
        Date.now(),
        migration.filename,
        migration.checksum,
        migration.filename.slice(5, -4).replace(/_/g, ' ') // description from filename
      );
    });

    txn();
    console.log(`  ✓ Applied v${String(migration.version).padStart(3, '0')}`);
  }

  return pending.length;
}

/**
 * Get current schema version.
 */
export function currentVersion(db: Database.Database): number {
  const applied = getApplied(db);
  return applied.length > 0 ? Math.max(...applied.map(a => a.version)) : 0;
}

/**
 * Verify integrity of applied migrations against disk files.
 * Returns list of issues (empty = all good).
 */
export function verify(db: Database.Database): string[] {
  const available = discoverMigrations();
  const applied = getApplied(db);
  const issues: string[] = [];

  for (const prev of applied) {
    const file = available.find(m => m.version === prev.version);
    if (!file) {
      issues.push(`Applied migration v${prev.version} (${prev.filename}) missing from disk`);
    } else if (file.checksum !== prev.checksum) {
      issues.push(`Migration ${prev.filename} modified after application`);
    }
  }

  return issues;
}
```

### 3.4 Connection Setup

```typescript
// src/db/connection.ts

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrate.js';

export interface DbOptions {
  path: string;         // e.g., '~/.ved/ved.db'
  readonly?: boolean;
  verbose?: boolean;
}

/**
 * Open (or create) the Ved database.
 * Applies pragmas and runs pending migrations.
 */
export function openDatabase(options: DbOptions): Database.Database {
  const dbPath = options.path.replace(/^~/, process.env.HOME || '');

  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, {
    readonly: options.readonly,
    verbose: options.verbose ? console.log : undefined,
  });

  // === Pragmas (MUST be set on every connection) ===
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');       // Safe with WAL, faster than FULL
  db.pragma('cache_size = -64000');         // 64MB cache (negative = KB)
  db.pragma('temp_store = MEMORY');         // temp tables in RAM

  // Load sqlite-vec extension if available
  try {
    db.loadExtension('vec0');
  } catch {
    // sqlite-vec not available — vector search will be disabled
    console.warn('sqlite-vec extension not loaded — vector search disabled');
  }

  // Run migrations (unless readonly)
  if (!options.readonly) {
    const applied = migrate(db);
    if (applied > 0) {
      console.log(`Applied ${applied} migration(s)`);
    }
  }

  return db;
}

/**
 * Close database cleanly. Call on shutdown.
 */
export function closeDatabase(db: Database.Database): void {
  // Optimize before closing (runs ANALYZE on tables that need it)
  db.pragma('optimize');
  db.close();
}
```

---

## 4. Table Summary

| Table | Purpose | Est. Rows (1yr personal use) | Growth |
|-------|---------|-------------------------------|--------|
| `inbox` | Crash-safe message receipt | ~10K | ~30/day |
| `sessions` | Conversation sessions | ~3K | ~10/day |
| `audit_log` | Hash-chained action log | ~100K | ~300/day |
| `anchors` | HMAC integrity checkpoints | ~1K | 1/100 audit entries |
| `work_orders` | HITL approval queue | ~500 | As needed |
| `trust_ledger` | Identity → trust mapping | ~50 | Rarely |
| `chunks` | RAG vault chunks | ~5K | On vault changes |
| `vec_chunks` | Vector embeddings | ~5K | Mirrors chunks |
| `chunks_fts` | FTS5 full-text index | ~5K | Mirrors chunks |
| `graph_edges` | Wikilink graph edges | ~10K | On vault changes |
| `outbox` | Crash-safe outgoing messages | ~10K | ~30/day |
| `llm_calls` | LLM request/response log | ~10K | ~30/day |
| `tool_calls` | MCP tool execution log | ~5K | ~15/day |
| `mcp_servers` | MCP server registry | ~20 | Rarely |
| `cron_jobs` | Scheduled tasks | ~10 | Rarely |
| `schema_version` | Migration tracking | ~10 | Per release |

**Estimated database size after 1 year:** ~50-100MB (dominated by llm_calls.messages/response JSON).

---

## 5. New Tables vs. Session 24 Draft

Session 24 had 8 tables. Session 25 adds 8 more for completeness:

| Table | Status | Why |
|-------|--------|-----|
| `inbox` | **Expanded** — added `channel_id`, `author_name`, `metadata`, `error`, `session_id` |
| `sessions` | **Expanded** — added `channel_id`, `trust_tier`, `token_count`, `closed_at`, `summary` |
| `audit_log` | **Expanded** — added `session_id` for cross-referencing |
| `anchors` | **Expanded** — added `chain_length`, `algorithm` |
| `work_orders` | **Expanded** — added `tool_server`, `risk_reasons`, `expires_at`, `audit_id` |
| `chunks` | **Expanded** — added `heading_level`, `frontmatter`, `chunk_index`, renamed `updated_at`→`indexed_at` |
| `trust_ledger` | **NEW** — runtime trust tier management with audit trail |
| `graph_edges` | **NEW** — wikilink relationship index for graph walk retrieval |
| `outbox` | **NEW** — crash-safe outgoing message queue |
| `llm_calls` | **NEW** — detailed LLM call log (cost tracking, replay, debugging) |
| `tool_calls` | **NEW** — MCP tool execution log with HITL linkage |
| `mcp_servers` | **NEW** — MCP server configuration registry |
| `cron_jobs` | **NEW** — internal scheduled tasks |
| `schema_version` | **Expanded** — added `filename`, `checksum` for tamper detection |

---

## 6. Index Strategy

Every index serves a specific query pattern in Ved's runtime:

| Index | Serves |
|-------|--------|
| `idx_inbox_pending` | Startup recovery: find unprocessed messages |
| `idx_inbox_received` | Chronological message listing |
| `idx_inbox_session` | Find messages for a session |
| `idx_sessions_status` | Find active sessions |
| `idx_sessions_author` | Find/resume session for a user |
| `idx_sessions_active` | Session timeout: find stale sessions |
| `idx_audit_type` | Filter audit by event type |
| `idx_audit_time` | Time-range audit queries |
| `idx_audit_actor` | Filter audit by actor |
| `idx_audit_session` | Session-scoped audit trail |
| `idx_anchors_time` | Find latest anchor |
| `idx_wo_status` | Find pending work orders |
| `idx_wo_session` | Session-scoped work orders |
| `idx_wo_expires` | Expire stale work orders |
| `idx_trust_active` | Look up current trust tier |
| `idx_chunks_file` | Re-index a specific file's chunks |
| `idx_chunks_modified` | Find stale chunks for re-indexing |
| `idx_edges_source` | Graph walk: find links FROM a file |
| `idx_edges_target` | Graph walk: find links TO a file (backlinks) |
| `idx_edges_pair` | Prevent duplicate edges |
| `idx_outbox_pending` | Send pending outgoing messages |
| `idx_outbox_session` | Session-scoped outbox |
| `idx_llm_session` | Session-scoped LLM calls |
| `idx_llm_time` | Chronological LLM call listing |
| `idx_llm_model` | Cost analysis by model |
| `idx_tool_session` | Session-scoped tool calls |
| `idx_tool_name` | Tool usage analytics |
| `idx_tool_time` | Chronological tool listing |
| `idx_cron_next` | Find next cron job to run |

All partial indexes use `WHERE` clauses to minimize index size (e.g., only index pending items).

---

## 7. Data Lifecycle & Retention

| Data | Retention | Cleanup |
|------|-----------|---------|
| `inbox` (processed) | 30 days | `DELETE WHERE processed=1 AND received_at < ?` |
| `outbox` (sent) | 30 days | `DELETE WHERE status='sent' AND sent_at < ?` |
| `sessions` (closed) | Forever | Compressed summary in `summary` column |
| `audit_log` | Forever | Append-only. Never delete. |
| `anchors` | Forever | Integrity checkpoints. |
| `work_orders` | 90 days (resolved) | `DELETE WHERE status != 'pending' AND resolved_at < ?` |
| `llm_calls` | 30 days | `DELETE WHERE created_at < ?` (or compress: drop messages/response JSON) |
| `tool_calls` | 30 days | `DELETE WHERE created_at < ?` |
| `chunks` | Matches vault | Stale chunks removed on file re-index |
| `graph_edges` | Matches vault | Stale edges removed on file re-index |
| `cron_jobs` | Until removed | Manual management |

**Maintenance task** (runs in EventLoop.maintain()):

```typescript
async function cleanupOldData(db: Database.Database): Promise<void> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  db.transaction(() => {
    // Processed inbox messages older than 30 days
    db.prepare('DELETE FROM inbox WHERE processed = 1 AND received_at < ?')
      .run(thirtyDaysAgo);

    // Sent outbox messages older than 30 days
    db.prepare('DELETE FROM outbox WHERE status = \'sent\' AND sent_at < ?')
      .run(thirtyDaysAgo);

    // LLM calls older than 30 days (keep summary, drop payloads)
    db.prepare('DELETE FROM llm_calls WHERE created_at < ?')
      .run(thirtyDaysAgo);

    // Tool calls older than 30 days
    db.prepare('DELETE FROM tool_calls WHERE created_at < ?')
      .run(thirtyDaysAgo);

    // Resolved work orders older than 90 days
    db.prepare('DELETE FROM work_orders WHERE status != \'pending\' AND resolved_at < ?')
      .run(ninetyDaysAgo);
  })();
}
```

---

## 8. Open Questions Resolved

### Q1: Migration system? (from Session 24)
**A:** Forward-only SQL files with checksum validation. See §3 above. No TypeScript DSL, no down migrations.

### Q2: Config file format?
**A: YAML** (`~/.ved/config.yaml`). Reasoning:
- Human-readable/editable (TOML works too, but YAML has better library support in Node.js)
- Comments supported (unlike JSON)
- `gray-matter` already in our deps (for Obsidian frontmatter)
- Config loaded once at startup, validated against TypeScript interface, merged with defaults

### Q3: Error types?
**A: Error codes, not class hierarchy.** Keep it simple:
```typescript
class VedError extends Error {
  constructor(
    public readonly code: string,     // 'DB_MIGRATION_FAILED' | 'LLM_TIMEOUT' | etc.
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'VedError';
  }
}
```
Error codes are strings (grep-able, serializable). No deep class hierarchies. The `cause` chain handles wrapping.

### Q4: Logging interface?
**A: Structured console + audit log.** No pino dependency. Pattern:
```typescript
function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console[level === 'debug' ? 'log' : level](JSON.stringify(entry));
}
```
Important events also go to `audit_log`. Console logging is for development/debugging. Audit log is the source of truth.

### Q5: Testing strategy?
**A: Both unit and integration, all in Docker.**
- **Unit tests:** Per module, mock database with in-memory SQLite (`:memory:`), mock LLM responses
- **Integration tests:** Docker container with full Ved instance, real SQLite, mock MCP servers
- **Framework:** Node.js built-in `node:test` + `node:assert` (zero deps)
- **Coverage target:** >80% on core modules (audit, trust, memory)

---

## 9. Next Session

**Session 26:** PLAN — Config schema (YAML format, TypeScript interface, validation, defaults) + Ved error codes catalog + structured logging design.

---

*End of database schema. 16 tables, forward-only migrations, all queries indexed.*
