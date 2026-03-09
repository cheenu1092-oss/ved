# Changelog

All notable changes to Ved are documented here.

## [0.3.0] — 2026-03-08

### Highlights
- **31 CLI commands** (up from 27 in v0.2.0)
- **2,117 tests** (up from 1,791)
- **~32,200 LoC** across all modules
- Unified help system with `--help`/`-h` on every command
- Git-native vault introspection: diff viewer, change tracker, point-in-time snapshots
- Performance benchmarking and structured log analysis
- v0.2.0 → v0.3.0: 5 feature sessions, 326 new tests, 0 regressions

### CLI — Observability & Debugging
- `ved log` — Structured log viewer/analyzer with 9 subcommands: show, tail, search, stats, errors, clear, export, rotate, levels. 7 filter flags, relative time parsing, color-coded output, live tail mode
- `ved profile` — Performance benchmarking for 7 subsystems (audit, vault, RAG, trust, DB, hash, memory). Warmup iterations, JSON output, per-subsystem profiling
- `ved help` — Unified help system: overview, per-command details, `--help`/`-h` flags on all 33 command handlers. Command registry with 9 categories

### CLI — Vault History & Versioning
- `ved diff` — Vault diff viewer & change tracker. 8 subcommands: working tree diff (staged/unstaged/untracked), log, show, stat, blame, between (two commits), files (--since), summary (folder breakdown + most active files). Color-coded output, relative timestamps
- `ved snapshot` — Vault point-in-time snapshots. 7 subcommands: list, create (annotated git tags + auto-commit dirty vault), show (details + drift from HEAD), diff (vs HEAD or two snapshots, --stat), restore (safety snapshot + force flag), delete (safety tag protection), export (git archive to tar.gz)

### Infrastructure
- `checkHelp()` wired into all 33 CLI command handlers — `--help`/`-h` works everywhere without app initialization
- Shell completions updated for all new commands across bash/zsh/fish

### Fixed
- Webhook delivery test timing flake (durationMs >= 0 for fast mock responses)

## [0.2.0] — 2026-03-07

### Highlights
- **27 CLI commands** (up from 3 in v0.1.0)
- **1,791 tests** (up from 951)
- **~29,500 LoC** across all modules
- Full HTTP API with web dashboard, SSE event stream, and webhook delivery
- Comprehensive vault management: memory, templates, search, export/import, backup
- Automation: cron scheduler, pipelines, aliases, environments
- v0.1.0 → v0.2.0: 22 feature sessions, 840 new tests, 0 regressions

### CLI — Vault & Memory
- `ved memory` — 8 subcommands: list, show, graph (wikilink walk), timeline, daily, forget, tags, types
- `ved template` — 7 subcommands: list, show, create, edit, delete, use (variable substitution), vars. 6 built-in templates
- `ved search` — RAG pipeline query from CLI (FTS + vector + graph fusion, --fts-only, --verbose)
- `ved export` / `ved import` — Portable JSON vault export with audit + stats; merge/overwrite/fail import modes, dry-run, stdin support
- `ved context` — 9 subcommands: inspect/manage context window, token breakdown, fact CRUD, RAG simulation

### CLI — Operations
- `ved stats` — Vault, RAG, audit, and session metrics at a glance
- `ved config` — Validate, show (secrets redacted), and print config path
- `ved history` — Audit log viewer with type/date/limit filters, chain integrity verification
- `ved doctor` — 8-point self-diagnostics (config, DB, vault, git, audit chain, RAG, LLM, MCP)
- `ved backup` — Create, list, restore vault+DB snapshots as tar.gz. Auto-rotation (keep N)
- `ved upgrade` — Database migration lifecycle: status, run, verify checksums, history
- `ved reindex` — Force-rebuild entire RAG index
- `ved watch` — Standalone vault file watcher with live RAG re-indexing
- `ved completions` — Shell completion generators for bash/zsh/fish (all 27 commands)

### CLI — Automation & Workflow
- `ved cron` — Scheduled job engine: 5-field cron expressions, built-in jobs (backup/reindex/doctor), SQLite persistence, manual trigger, execution history
- `ved pipe` — Multi-step pipelines: chain queries + shell commands, YAML pipeline files, saved pipelines, dry-run
- `ved alias` — Command shortcuts with @-syntax (`ved @myalias`), YAML persistence, import/export
- `ved env` — Environment manager: config overlays (dev/prod/test), create/switch/diff/reset, built-in templates
- `ved run` — One-shot query mode (non-interactive)
- `ved prompt` — System prompt profile manager: create, edit, use, test, diff, reset

### CLI — Trust & Users
- `ved trust` — 10 subcommands: matrix display, resolve tiers, assess risk, grant/revoke, ledger, work order management
- `ved user` — 5 subcommands: list, show, sessions, activity, stats

### HTTP API & Dashboard
- `ved serve` — REST API on `node:http` (zero deps). 9 endpoints: health, stats, search, history, vault, doctor, approve/deny
- **EventBus + SSE** — Typed pub/sub event bus, real-time `/api/events` SSE stream with type filtering
- **Webhook delivery** — EventBus→HTTP POST with HMAC-SHA256 signing, exponential backoff retries, delivery log, event type filtering
- **Web dashboard** — Self-contained SPA: 6 panels (overview, events, search, history, vault, doctor), live SSE stream, dark theme

### Infrastructure
- Vault watcher → RAG integration: file changes auto-trigger re-indexing
- Incremental startup indexing (compare file mtime vs indexed_at)
- Vault git auto-commit on startup
- Interactive REPL (`ved chat`) with /help, /status, /clear
- System prompt enhancements: profile-based prompts with fact injection

### Fixed
- Critical code deduplication: removed ~646 lines of dead duplicate code in app.ts/cli.ts/mcp-client.ts
- Timezone-sensitive cron test failures (UTC→local Date constructors)
- Mock infrastructure: `createMockMemory()` factory eliminates shutdown warnings
- GitHub repo renamed witness→ved

## [0.1.0] — 2026-03-06

### Architecture
- Single-threaded event loop with 7-step message pipeline
- 4-tier hierarchical memory: Working (RAM) → Episodic (Obsidian daily notes) → Semantic (Obsidian knowledge graph) → Archival (SQLite + RAG)
- Hash-chain audit log with HMAC external anchoring
- 4-tier trust engine with human-in-the-loop approval queues
- MCP-native tool integration
- Multi-provider LLM client (OpenAI, Anthropic, Ollama)

### Modules
- **ved-core** — Event loop, session manager, compressor, idle timer
- **ved-audit** — Hash-chain store, HMAC anchoring
- **ved-trust** — Risk assessment, work orders, trust ledger
- **ved-memory** — Vault manager (Obsidian), working memory, T1→T2 compression
- **ved-rag** — RAG pipeline: embed (nomic-embed-text), FTS5, vector search, fusion ranking
- **ved-llm** — Multi-provider LLM client with streaming
- **ved-mcp** — MCP client for tool discovery and execution
- **ved-channel** — Discord adapter + CLI

### Security
- 17 vulnerabilities found and fixed across 5 red-team phases
- 927+ tests including adversarial red-team suites
- Content filter: 11 sensitive data patterns + NFKC normalization + zero-width char stripping
- Path traversal protection on all vault I/O methods
- SQL injection protection (parameterized queries throughout)
- ReDoS resistance verified (100K input <100ms)
- Trust escalation prevention (immutable config floor, owner-only grants)

### CLI
- Interactive REPL with `/help`, `/status`, `/clear`
- `ved init` — scaffold Obsidian vault structure + config template
- Approval commands: `approve <id>`, `deny <id> [reason]`, `pending`

### Open Source
- MIT License
- CONTRIBUTING.md with development guide
- Docker-based testing (host + Docker parity verified)
- README with architecture overview and quickstart

### Fixed
- GAP-4: U+2061-U+2064 invisible math operators now stripped by content filter
- All 17 CVEs documented in session logs with fix references
