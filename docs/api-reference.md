# Ved API Reference

Complete reference for Ved's CLI commands and HTTP API.

---

## CLI Commands

Ved has 46 commands organized into 9 categories. Every command supports `--help` / `-h`.

### Core

#### `ved start`
Start the Ved daemon with live TUI dashboard, HTTP API, and event loop.

```
ved start [--simple] [--port <port>] [--host <host>] [--token <token>] [--cors <origin>]
```

| Flag | Description |
|------|-------------|
| `--simple` | Disable TUI, use plain log output |
| `--port <n>` | HTTP API port (default: 3141) |
| `--host <addr>` | Bind address (default: 127.0.0.1) |
| `--token <secret>` | Bearer token for API auth |
| `--cors <origin>` | CORS allowed origin |

Starts the full pipeline: init → index vault → start channels → start watcher → event loop. Includes cron scheduler, webhook delivery, and SSE streaming.

#### `ved init`
Interactive setup wizard. Walks through provider selection, API key entry, vault location, and trust mode.

```
ved init [--force] [--yes]
```

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing config |
| `--yes` / `-y` | Non-interactive mode with sensible defaults |

Creates `config.yaml`, `config.local.yaml` (secrets), and vault directory structure. Auto-installs shell completions.

#### `ved chat`
Interactive conversation with TUI: streaming tokens, status bar, session picker, syntax highlighting.

```
ved chat [--model <m>] [--no-rag] [--no-tools] [--verbose] [--simple]
```

| Flag | Description |
|------|-------------|
| `--model <m>` | Override LLM model |
| `--no-rag` | Disable RAG enrichment |
| `--no-tools` | Disable MCP tool calling |
| `--verbose` | Show pipeline debug info |
| `--simple` | Disable TUI, use basic REPL |

**In-chat commands:** `/help`, `/status`, `/clear`, `/memory`, `/approve <id>`, `/deny <id> [reason]`, `/quit`

#### `ved run`
One-shot query — ask a question and get an answer without entering interactive mode.

```
ved run "<prompt>" [--model <m>] [--system <s>] [--no-rag] [--no-memory] [--json]
```

Aliases: `ask`, `query`, `q`

#### `ved version`
Show version. `--verbose` adds Node.js version, platform, OS, shell, config path.

#### `ved quickstart`
Print a color-coded cheat sheet for new users.

#### `ved status`
Health check and system overview.

#### `ved help [command]`
Show help overview or detailed help for a specific command.

---

### Memory & Knowledge

#### `ved memory`
Browse and manage the Obsidian knowledge graph.

| Subcommand | Description |
|------------|-------------|
| `list` | List entities (filter by `--type`, `--tag`, `--folder`) |
| `show <name>` | Show entity details, frontmatter, links |
| `graph <name>` | Walk wikilinks (`--depth <n>`) |
| `timeline` | Recent vault activity by date |
| `daily` | View/create today's daily note |
| `forget <name>` | Soft-delete (move to archive) |
| `tags` | Tag counts across vault |
| `types` | Entity type counts |

Aliases: `mem`, `ls`, `cat`, `read`, `links`, `recent`, `today`, `archive`

#### `ved template`
Manage vault templates for creating structured entities.

| Subcommand | Description |
|------------|-------------|
| `list` | List available templates with variable info |
| `show <name>` | Display template contents |
| `create <name>` | Create from built-in type or blank |
| `edit <name>` | Open in $EDITOR |
| `delete <name>` | Remove custom template |
| `use <name>` | Instantiate with `--var key=value` substitution |
| `vars <name>` | Show variable names and occurrence counts |

Built-in types: person, project, decision, concept, daily, topic.

#### `ved tag`
Manage vault tags across files.

| Subcommand | Description |
|------------|-------------|
| `list` | All tags |
| `show <tag>` | Files with this tag |
| `add <file> <tag>` | Add tag to file frontmatter |
| `remove <file> <tag>` | Remove tag |
| `rename <old> <new>` | Rename across all files |
| `set <file> <tags...>` | Replace all tags |
| `clear <file>` | Remove all tags |
| `orphans` | Tags with no files |
| `stats` | Usage statistics |
| `find <tags...>` | Files matching all tags |

#### `ved context`
Inspect and manage the context window sent to the LLM.

| Subcommand | Description |
|------------|-------------|
| `show` | Full assembled context |
| `tokens` | Token breakdown with progress bar |
| `facts` | List injected facts with per-fact token count |
| `add <fact>` | Add persistent fact |
| `remove <id>` | Remove fact |
| `clear` | Remove all facts |
| `messages` | Conversation history |
| `simulate <query>` | Dry-run RAG injection |
| `sessions` | List active/idle sessions |

All commands support `--session <id>` targeting.

#### `ved diff`
Vault change viewer — git-backed.

| Subcommand | Description |
|------------|-------------|
| *(none)* | Working tree diff (staged + unstaged + untracked) |
| `log` | Commit log (`--limit`, `--file`) |
| `show <commit>` | Commit details |
| `stat <commit>` | Change statistics |
| `blame <file>` | Line-by-line attribution |
| `between <a> <b>` | Diff two commits |
| `files` | Changed file list (`--since`) |
| `summary` | Knowledge evolution overview |

#### `ved graph`
Knowledge graph analysis.

| Subcommand | Description |
|------------|-------------|
| `hubs` | Most-connected entities |
| `orphans` | Entities with no links |
| `islands` | Disconnected clusters |
| `path <a> <b>` | Shortest path between entities |
| `neighbors <name>` | Direct connections |
| `broken` | Broken wikilinks |
| `dot` | Export to DOT/Graphviz format |
| `summary` | Full graph overview |

Aliases: `links`, `kg`

#### `ved task`
Task management backed by vault markdown files with YAML frontmatter.

| Subcommand | Description |
|------------|-------------|
| `list` | List tasks (`--status`, `--priority`, `--project`, `--assignee`, `--tag`) |
| `add <title>` | Create task (`--priority`, `--project`, `--due`, `--note`) |
| `show <id>` | Task details |
| `edit <id>` | Edit in $EDITOR |
| `done <id>` | Mark complete |
| `archive <id>` | Move to archive |
| `board` | Kanban board view (`--project`) |
| `stats` | Task statistics |
| `projects` | List projects |
| `search <query>` | Full-text search |

Aliases: `tasks`, `todo`, `todos`

---

### Search & RAG

#### `ved search`
Query the knowledge base via the RAG pipeline (FTS5 + vector + graph fusion with reranking).

```
ved search "<query>" [-n <limit>] [--verbose] [--fts-only] [--json]
```

| Flag | Description |
|------|-------------|
| `-n <limit>` | Max results (default: 5) |
| `--verbose` | Show scoring details |
| `--fts-only` | Skip vector search |
| `--json` | JSON output |

#### `ved reindex`
Force rebuild the entire RAG index from all vault `.md` files.

---

### Trust & Security

#### `ved trust`
Manage the trust engine — tiers, matrix, work orders.

| Subcommand | Description |
|------------|-------------|
| `matrix` | Display the trust×risk decision matrix |
| `resolve <channel> <id>` | Look up a user's trust tier |
| `assess <action> [params]` | Assess risk level of an action |
| `grant <channel> <id> <tier>` | Grant trust (`--as <owner>`) |
| `revoke <channel> <id>` | Revoke trust |
| `ledger` | Full trust ledger |
| `pending` | Pending work orders |
| `history` | Work order history |
| `show <id>` | Work order details |
| `config` | Trust configuration |

**Trust Tiers:**
1. **Tier 1** — Unknown. All actions gated.
2. **Tier 2** — Recognized. Low-risk actions auto-approved.
3. **Tier 3** — Trusted. Medium-risk auto-approved.
4. **Tier 4** — Owner. Full access.

#### `ved user`
Inspect known users and their activity.

| Subcommand | Description |
|------------|-------------|
| `list` | All known users |
| `show <id>` | User details |
| `sessions <id>` | User's sessions |
| `activity <id>` | Recent activity |
| `stats` | Aggregate user statistics |

---

### Tools & Automation

#### `ved agent`
Define and run sub-agent profiles with custom system prompts, tool sets, trust levels, and models.

| Subcommand | Description |
|------------|-------------|
| `list` | List profiles |
| `show <name>` | Profile details |
| `create <name>` | Create from template or blank |
| `edit <name>` | Edit in $EDITOR |
| `delete <name>` | Remove profile |
| `run <name> "<prompt>"` | Execute one-shot with profile |
| `history <name>` | Execution history |
| `clone <src> <dst>` | Duplicate profile |
| `export` | Export all profiles to JSON |
| `import` | Import profiles (`--merge`, `--dry-run`) |

Built-in templates: researcher, coder, writer, analyst, default.

#### `ved pipe`
Chain queries and shell commands into multi-step pipelines.

```bash
# Inline
ved pipe "list recent decisions" "summarize the themes" "!sort"

# From file
ved pipe -f analysis-pipeline.yaml

# Save/load
ved pipe save my-flow "step1" "step2"
ved pipe load my-flow
ved pipe list
ved pipe delete my-flow
```

Shell steps prefixed with `!` receive previous output on stdin.

#### `ved alias`
Command shortcuts with `@` syntax.

```bash
ved alias add daily "memory daily"
ved @daily                          # runs: ved memory daily
ved alias add search-people 'search "type:person"'
ved @search-people                  # runs: ved search "type:person"
```

| Subcommand | Description |
|------------|-------------|
| `list` | All aliases |
| `add <name> <command>` | Create alias |
| `remove <name>` | Delete alias |
| `show <name>` | Show alias command |
| `edit <name>` | Edit in $EDITOR |
| `run <name> [args]` | Execute alias |
| `export` | Export to JSON |
| `import [file]` | Import (`--merge`, `--dry-run`) |

#### `ved cron`
Manage scheduled jobs.

| Subcommand | Description |
|------------|-------------|
| `list` | All jobs with status and next run |
| `add <name> <type> <expr>` | Create job (types: backup, reindex, doctor) |
| `remove <name>` | Delete job |
| `enable <name>` | Enable job |
| `disable <name>` | Disable job |
| `run <name>` | Trigger immediately |
| `history` | Execution history with timing |

Cron expressions: standard 5-field (`minute hour day month weekday`).

#### `ved plugin`
Manage MCP tool plugins.

| Subcommand | Description |
|------------|-------------|
| `list` | Installed plugins |
| `tools` | All available tools across plugins |
| `add <name>` | Install plugin |
| `remove <name>` | Uninstall plugin |
| `test` | Test plugin connectivity |

#### `ved replay`
Replay and analyze past sessions from audit logs.

| Subcommand | Description |
|------------|-------------|
| `list` | List sessions |
| `show <id>` | Full session replay |
| `trace <id>` | Pipeline stage trace (7-stage color-coded) |
| `timeline <id>` | Chronological event timeline |
| `stats <id>` | Session statistics |
| `compare <id1> <id2>` | Side-by-side comparison |
| `export <id>` | Export to JSON or markdown |
| `search <query>` | Search across sessions |

#### `ved completions`
Generate shell completions.

```bash
ved completions bash >> ~/.bashrc
ved completions zsh >> ~/.zshrc
ved completions fish > ~/.config/fish/completions/ved.fish
```

---

### Monitoring & Logs

#### `ved stats`
Vault, RAG, audit, and session metrics at a glance.

#### `ved history`
Audit log viewer with filtering and chain verification.

```
ved history [--type <t>] [--since <date>] [--until <date>] [--limit <n>] [--verify] [--json]
```

| Flag | Description |
|------|-------------|
| `--type <t>` | Filter by event type |
| `--since` / `--until` | Date range |
| `--limit <n>` | Max entries |
| `--verify` | Verify hash chain integrity |
| `--types` | List all event types |
| `--json` | JSON output |

#### `ved doctor`
13-point self-diagnostics:

1. Config file validity
2. Database connectivity
3. Vault directory structure
4. Vault git status
5. Audit chain integrity
6. RAG index health
7. LLM connectivity (live ping with latency)
8. MCP tool availability
9. Shell completions
10. Log file status
11. Disabled webhook cleanup (`--fix`)
12. Stale session closure (`--fix`)
13. Webhook delivery compaction (`--fix`)

#### `ved log`
Structured log viewer and analyzer.

| Subcommand | Description |
|------------|-------------|
| `show` | Display recent logs |
| `tail` | Follow logs in real-time |
| `search <query>` | Search log entries |
| `stats` | Log level distribution |
| `levels` | List log levels |
| `modules` | List log modules |
| `clear` | Clear log file |
| `path` | Show log file location |

Filters: `--level`, `--module`, `--since`, `--until`, `-n`

#### `ved profile`
Performance benchmarking for 7 subsystems.

```
ved profile [category] [--iterations <n>] [--warmup <n>] [--json]
```

Categories: `all`, `audit`, `vault`, `rag`, `trust`, `db`, `hash`, `memory`

---

### Data & Backup

#### `ved export` / `ved import`
Portable vault serialization.

```bash
ved export backup.json --include-audit --include-stats
ved import backup.json --mode merge --dry-run
cat backup.json | ved import -
```

Import modes: `merge` (keep existing), `overwrite` (replace), `fail` (abort on conflict).

#### `ved backup`
Vault + database snapshot archives (tar.gz).

| Subcommand | Description |
|------------|-------------|
| `create` | Create snapshot (WAL checkpoint, .git preserved) |
| `list` | List available backups |
| `restore <name\|latest>` | Restore from backup |

Auto-rotation with `--keep <n>`.

#### `ved gc`
Garbage collection for old sessions, audit entries, and temp files.

| Subcommand | Description |
|------------|-------------|
| `status` | Show what would be cleaned |
| `run` | Execute cleanup |

#### `ved sync`
Sync vault to/from remote endpoints.

| Subcommand | Description |
|------------|-------------|
| `list` | Configured remotes |
| `add <name> <type> <url>` | Add remote (types: git, s3, rsync, local) |
| `remove <name>` | Remove remote |
| `push <name>` | Push vault to remote |
| `pull <name>` | Pull from remote (`--force`) |
| `status` | Sync status |
| `history` | Sync history (`--limit`, `--failed-only`) |

#### `ved migrate`
Import data from external sources.

| Subcommand | Description |
|------------|-------------|
| `status` | Migration status |
| `markdown <path>` | Import markdown files (`-r` for recursive) |
| `json <file>` | Import JSON export |
| `obsidian <path>` | Import from Obsidian vault |
| `csv <file>` | Import CSV (`--name-col`) |
| `jsonl <file>` | Import JSONL conversations |
| `validate <type> <file>` | Validate without importing |
| `undo <id>` | Reverse a migration |
| `history` | Migration history |

#### `ved snapshot`
Lightweight point-in-time vault snapshots (git tags).

| Subcommand | Description |
|------------|-------------|
| `list` | List snapshots with timestamps |
| `create <name>` | Create annotated snapshot (`-m <message>`) |
| `show <name>` | Snapshot details + drift from HEAD |
| `diff <name> [name2]` | Diff vs HEAD or between two snapshots |
| `restore <name>` | Restore (creates safety snapshot first) |
| `delete <name>` | Remove snapshot |
| `export <name> <file>` | Export as tar.gz |

---

### Server & API

#### `ved serve`
Start the HTTP API server with REST endpoints, SSE streaming, and web dashboard.

```
ved serve [--port <n>] [--host <addr>] [--token <secret>] [--cors <origin>]
```

Dashboard available at `http://localhost:3141/` with 6 panels: Overview, Events, Search, History, Vault, Doctor.

#### `ved mcp-serve`
Expose Ved as an MCP tool server for other agents to connect to.

```bash
ved mcp-serve              # stdio mode (pipe to another agent)
ved mcp-serve --http       # HTTP/SSE on port 3142
```

#### `ved webhook`
Manage webhook event delivery with HMAC-SHA256 signing.

| Subcommand | Description |
|------------|-------------|
| `list` | Configured webhooks |
| `add <name> <url>` | Add webhook (`--secret`, `--events`) |
| `remove <name>` | Remove webhook |
| `enable` / `disable` | Toggle webhook |
| `deliveries <name>` | Delivery history |
| `stats` | Delivery statistics |
| `test <name>` | Send test event |

#### `ved watch`
Standalone vault watcher — indexes file changes to RAG without starting the full event loop.

#### `ved hook`
Lifecycle hooks — trigger shell commands on Ved events.

| Subcommand | Description |
|------------|-------------|
| `list` | All hooks |
| `add <name> <event> <cmd>` | Create hook |
| `remove <name>` | Delete hook |
| `show <name>` | Hook details |
| `edit <name>` | Edit in $EDITOR |
| `enable` / `disable` | Toggle hook |
| `test <name>` | Trigger with test event |
| `history` | Execution history |
| `types` | List hookable event types |

Features: concurrency limits, timeout enforcement, dangerous command blocking.

#### `ved notify`
Notification rules for Ved events.

| Subcommand | Description |
|------------|-------------|
| `list` | All rules |
| `add <name> <events> <channel>` | Create rule |
| `remove <name>` | Delete rule |
| `show <name>` | Rule details |
| `edit <name>` | Edit in $EDITOR |
| `enable` / `disable` | Toggle rule |
| `test <name>` | Send test notification |
| `history` | Delivery history |
| `channels` | Available delivery channels |
| `mute [duration]` | Mute all notifications |
| `unmute` | Unmute |

Channels: `terminal` (bell+banner), `desktop` (OS notification), `command` (shell), `log` (file).

---

### Configuration

#### `ved config`
Manage configuration.

| Subcommand | Description |
|------------|-------------|
| `validate` | Check config for errors |
| `show` | Print resolved config (secrets redacted) |
| `path` | Print config directory path |
| `edit [local]` | Open in $EDITOR (validates after save) |

#### `ved env`
Manage configuration environments (overlays between config.yaml and config.local.yaml).

| Subcommand | Description |
|------------|-------------|
| `current` | Active environment |
| `list` | All environments |
| `show <name>` | Environment contents |
| `create <name>` | Create (`--template`, `--from`, `--from-current`) |
| `use <name>` | Switch environment |
| `edit <name>` | Edit in $EDITOR |
| `delete <name>` | Remove environment |
| `diff <a> [b]` | Compare environments |
| `reset` | Deactivate environment |

Built-in templates: dev, prod, test.

#### `ved prompt`
Manage system prompt profiles.

| Subcommand | Description |
|------------|-------------|
| `list` | All profiles |
| `show [name]` | Display profile contents (or default) |
| `create <name>` | Create from template or stdin |
| `edit <name>` | Edit in $EDITOR |
| `use <name>` | Set active profile |
| `test` | Preview assembled prompt with facts + RAG |
| `reset` | Revert to default prompt |
| `diff [name]` | Diff against default |

#### `ved upgrade`
Database migration management.

| Subcommand | Description |
|------------|-------------|
| `status` | Current schema version + pending migrations |
| `run` | Apply pending migrations (auto-backup first) |
| `verify` | Checksum integrity verification |
| `history` | Migration history with dates |

---

## HTTP API

Base URL: `http://localhost:3141` (configurable via `--port`/`--host`)

### Authentication
Optional bearer token auth. Set via `--token <secret>` on `ved serve`/`ved start`.

```
Authorization: Bearer <token>
```

### Endpoints

#### Health & Stats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (`{ status: "ok", version, uptime }`) |
| `GET` | `/api/stats` | System metrics (vault files, RAG entries, audit count, sessions, SSE connections) |
| `GET` | `/api/doctor` | Run all diagnostic checks |

#### Search & Knowledge

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/search?q=<query>&n=<limit>` | RAG search (FTS + vector + graph fusion) |
| `GET` | `/api/vault/files` | List all vault files |
| `GET` | `/api/vault/file?path=<path>` | Read a vault file (path traversal protected) |
| `GET` | `/api/vault/graph` | Knowledge graph data (nodes + edges for visualization) |

#### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List recent sessions |
| `GET` | `/api/sessions/:id` | Session details with messages |

#### Trust & Approvals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trust` | Trust configuration and matrix |
| `GET` | `/api/work-orders` | Pending work orders |
| `GET` | `/api/work-orders/:id` | Single work order details |
| `POST` | `/api/approve/:id` | Approve work order (`{ ownerId }`) |
| `POST` | `/api/deny/:id` | Deny work order (`{ ownerId, reason? }`) |

#### Audit

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/history` | Audit log (`?type=`, `?since=`, `?until=`, `?limit=`, `?verify=true`) |

#### Events (SSE)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | Server-Sent Events stream (`?types=` to filter) |

**Event format:**
```
data: {"id":1,"type":"message_received","timestamp":"...","data":{...}}
```

30-second keepalive pings. Reconnect on disconnect.

#### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/webhooks` | List configured webhooks |
| `GET` | `/api/webhooks/stats` | Delivery statistics |
| `GET` | `/api/webhooks/:id/deliveries` | Delivery history for a webhook |
| `POST` | `/api/webhooks` | Create webhook |
| `DELETE` | `/api/webhooks/:id` | Remove webhook |

#### MCP

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mcp/servers` | List MCP servers |
| `GET` | `/api/mcp/tools` | List all available tools |

#### Cron

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/cron` | List cron jobs |
| `GET` | `/api/cron/history` | Cron execution history |
| `POST` | `/api/cron/:id/run` | Trigger job immediately |
| `POST` | `/api/cron/:id/toggle` | Enable/disable job |

#### Configuration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Sanitized configuration |
| `POST` | `/api/config` | Write config changes (`{ yaml: string }` → config.local.yaml) |
| `GET` | `/api/envs` | List environments |
| `GET` | `/api/envs/current` | Active environment |
| `POST` | `/api/envs/use` | Switch environment (`{ name: string }`) |
| `POST` | `/api/envs/reset` | Deactivate environment |

#### Dashboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Web dashboard (SPA) |
| `GET` | `/dashboard` | Web dashboard (alias) |

---

## Audit Event Types

Ved logs every action as a hash-chained audit event. Event types include:

| Type | Description |
|------|-------------|
| `message_received` | Incoming message from any channel |
| `message_sent` | Outgoing response |
| `llm_request` | LLM API call |
| `llm_response` | LLM API response |
| `tool_requested` | Tool call initiated |
| `tool_executed` | Tool call completed |
| `rag_query` | RAG search performed |
| `rag_result` | RAG results returned |
| `trust_resolved` | Trust tier lookup |
| `work_order_created` | Approval request created |
| `work_order_resolved` | Approval granted/denied |
| `session_created` | New session started |
| `session_close` | Session closed |
| `memory_write` | Vault file written |
| `memory_compress` | T1→T2 compression fired |
| `entity_upsert` | T3 entity created/updated |
| `backup_created` | Backup snapshot created |
| `backup_restored` | Backup restored |
| `migration_started` | Data migration begun |
| `migration_completed` | Data migration finished |
| `migration_undone` | Migration reversed |
| `cron_executed` | Scheduled job ran |
| `config_changed` | Configuration modified |
| `error` | Pipeline error |

Each event includes: `id`, `type`, `timestamp`, `session_id`, `actor`, `data` (JSON), `hash` (SHA-256 chain link), `prev_hash`.

---

## Configuration Reference

Ved uses YAML configuration split into two files:

- **`config.yaml`** — Non-secret settings (committed to git)
- **`config.local.yaml`** — Secrets (gitignored)

### Minimal config.yaml

```yaml
llm:
  provider: anthropic          # anthropic | openai | ollama | openrouter
  model: claude-sonnet-4-20250514

vault:
  path: ~/ved-vault

trust:
  mode: gate-writes            # audit | gate-writes | gate-all
  ownerIds:
    - discord:your-user-id
```

### Full config.yaml options

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  temperature: 0.7
  maxTokens: 4096
  baseUrl: null                # Custom API endpoint (for Ollama, proxies)

vault:
  path: ~/ved-vault
  autoCommit: true             # Git auto-commit on writes
  watchEnabled: true           # File watcher for RAG re-indexing

trust:
  mode: gate-writes            # audit | gate-writes | gate-all
  ownerIds:
    - discord:your-user-id
  defaultTier: 1

channels:
  discord:
    token: null                # In config.local.yaml
    prefix: "!"

rag:
  enabled: true
  embedModel: nomic-embed-text # Ollama embedding model
  topK: 5
  minScore: 0.3

memory:
  compression:
    threshold: 10              # Messages before T1→T2 fires
    idleMinutes: 30            # Idle time trigger
  maxWorkingMemory: 20         # Max T1 messages per session

http:
  port: 3141
  host: 127.0.0.1
  cors: null

mcp:
  servers: []                  # MCP server configurations
```

### config.local.yaml (secrets)

```yaml
llm:
  apiKey: sk-ant-...

channels:
  discord:
    token: MTIz...
```

---

## Database Schema

Ved uses SQLite with WAL mode. 4 migration versions.

**Key tables:** `audit_log`, `sessions`, `trust_ledger`, `work_orders`, `rag_documents`, `rag_chunks`, `cron_jobs`, `cron_history`, `webhooks`, `webhook_deliveries`, `sync_remotes`, `sync_history`

See `docs/database-schema.md` for complete schema with all 16 tables and 29 indexes.
