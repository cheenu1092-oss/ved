# Changelog

All notable changes to Ved are documented here.

## [0.7.0] — 2026-03-26

### Highlights
- **npm publish ready** — Ved is now `ved-ai` on npm with `npx ved-ai init` support
- **3,345+ tests** (up from 3,251 in v0.6.0)
- **~45,400 LoC** across all modules
- P0-P3 "Primetime Readiness" complete: live LLM testing, TUI overhaul, config wizard, web dashboard
- Post-install script with Ollama detection and helpful onboarding
- Dual binary entry: `ved` and `ved-ai` both work

### npm Publish (P4)
- Package renamed to `ved-ai` (available on npm)
- Dual `bin` entries: `ved` and `ved-ai` for CLI access
- `./types` subpath export for TypeScript consumers
- Post-install script: detects Ollama, prints quickstart guide, skips in CI
- `npm pack` verified: ~500KB tarball, zero test/doc/session leakage
- `prepublishOnly` runs full build + test suite
- `postinstall` is fault-tolerant (`|| true` — never blocks install)

### Gateway Web UI (P3) — Already Complete
- 12-panel web dashboard served from `ved serve` (2,270 lines, zero deps)
- Panels: Overview, Events (live SSE), Search (RAG), History (audit), Vault (file browser), Graph (force-directed canvas visualization), Memory (entity browser), Doctor (diagnostics), Trust & Approvals (work order management), Cron (job management), Config (YAML editor + env switcher), MCP (server/tool inspector)
- Config editor with save/cancel, environment selector with use/reset
- Session detail modal with conversation view
- Mobile-responsive dark theme
- Real-time updates via SSE with keepalive
- 36 dashboard-v2 tests covering config write, env management, HTML elements

### Config UX (P2)
- Interactive `ved init` wizard with @clack/prompts-style UX (723 lines)
- 4 LLM providers: Anthropic, OpenAI, Ollama, OpenRouter with model selection
- API key validation (prefix checks + env var detection)
- 3 trust modes: audit, gate-writes, gate-all
- Optional Discord channel setup
- `--yes` flag for non-interactive mode, `--force` for overwrite
- `ved config edit [local]` opens in $EDITOR with post-save validation

### TUI Overhaul (P1)
- Session picker on `ved chat` startup (resume active/idle or start new)
- Token streaming via `processMessageStream`
- Fixed status bar with ANSI scroll region + SIGWINCH resize handling
- Syntax highlighting for code blocks (box borders + keyword coloring)
- Color-coded risk badges on work order approvals
- `--simple` flag for fallback to original REPL
- `formatAgo()` relative timestamps throughout

### Live LLM Testing (P0)
- Ved successfully talked to Ollama qwen3:1.7b — first real LLM conversation
- Full 7-step pipeline works end-to-end: message → RAG → LLM → response
- Multi-turn conversation with name recall verified
- System prompt self-identification verified
- Audit trail integrity verified after live conversation
- 8-test live test script for ongoing validation

---

## [0.6.0] — 2026-03-21

### Highlights
- **46 CLI commands** (up from 35 in v0.5.0)
- **2,931 tests** (up from 2,542)
- **~42,600 LoC** across all modules
- 4 major new CLI commands: agent profiles, session replay, knowledge graph analysis, task management
- 2 red-team sessions covering all new surfaces (132 tests, 0 vulnerabilities found)
- v0.5.0 → v0.6.0: 4 feature sessions, 2 red-team sessions, 389 new tests, 0 regressions
- **Total vulnerabilities found and fixed: 21** (0 open)

### CLI — Agent Profiles
- `ved agent` — Agent persona manager. 10 subcommands: list, show, create, edit, delete, use, export, import, test, diff. 5 built-in templates (default, researcher, coder, writer, analyst). YAML-based profiles with name, description, system prompt, tools, and model overrides. Import/export with merge + dry-run. Test mode assembles full prompt preview. Aliases: ved persona, ved character

### CLI — Session Replay & Analysis
- `ved replay` — Session replay and analysis from audit logs. 8 subcommands: list (sessions with message counts), show (full session transcript), trace (pipeline stage visualization), timeline (chronological event view), stats (session metrics + timing), compare (diff two sessions), export (JSON/markdown), search (cross-session text search). Pipeline-aware visualization with 7-stage color-coded flow (receive → enrich → decide → act → record → respond → maintain). Hash chain tracing from any audit entry

### CLI — Knowledge Graph Analysis
- `ved graph` — Obsidian vault knowledge graph analysis. 9 subcommands: hubs (most-connected entities), orphans (unlinked files), islands (disconnected clusters), path (shortest path between entities), neighbors (N-hop subgraph), broken (dead wikilinks), dot (Graphviz DOT export), summary (vault-wide graph metrics). Aliases: ved kg, ved links

### CLI — Task Management
- `ved task` — Task management as Markdown files with YAML frontmatter. 10 subcommands: list (filter by status/priority/project/assignee), add (create with metadata), show (task details), edit (update fields), done (mark complete), archive (move to done), board (Kanban view: todo/in-progress/done/blocked columns), stats (project metrics), projects (project listing), search (full-text). Priority levels: critical/high/medium/low. Aliases: ved tasks, ved todo, ved kanban

### Security — Red-Team Sessions 90 & 92
- **Session 90:** 69 red-team tests across 12 attack categories targeting agent and replay CLIs: agent name traversal, YAML injection, import payloads, JSONL injection, editor command injection, replay SQL injection, export integrity, hash chain attacks, search injection, serialization round-trip, large dataset DoS, template security. **0 vulnerabilities found.** All defenses held
- **Session 92:** 63 red-team tests across 12 attack categories targeting graph and task CLIs: DOT export path traversal, wikilink ReDoS, Graphviz injection, title/slug injection, frontmatter manipulation, search injection, archive traversal, ID matching ambiguity, symlinks/special files, date validation, large input DoS, concurrent operations. **0 vulnerabilities found.** 5 informational findings documented (all accepted risk). All defenses held: slugify sanitization, vault containment (VULN-14), in-memory search, directory skipping, date validation

### Infrastructure
- Shell completions updated for agent, replay, graph, task commands (bash/zsh/fish)
- Help system updated with all 4 new commands in correct categories
- Docker parity verified: 2,931/2,931 tests pass in both host and Docker
- GitHub pushed with all session work (S89-92)

## [0.5.0] — 2026-03-18

### Highlights
- **35 CLI commands** (up from 34 in v0.4.0)
- **2,542 tests** (up from 2,393)
- **~38,000 LoC** across all modules
- Vault synchronization with 4 remote types (git, S3, rsync, local)
- Red-team session covering hook, notify, migrate, sync (83 tests, 2 vulns found+fixed)
- v0.4.0 → v0.5.0: 2 feature sessions, 1 red-team session, 149 new tests, 0 regressions
- **Total vulnerabilities found and fixed: 21** (0 open)

### CLI — Vault Synchronization
- `ved sync` — Vault synchronization tool. 8 subcommands: remotes, add, remove, push, pull, status, auto, history. 4 remote types: git (clone/push/pull), S3 (aws s3 sync), rsync (delta transfer), local (cp -r). Features: conflict detection (push-before-pull enforcement), auto-sync on vault file changes, sync history with audit log, multiple named remotes, auth credential storage (redacted in display), enable/disable per-remote. Database migration v004 adds sync_remotes and sync_history tables with CHECK constraints on type/direction/status

### Security — Red-Team Session 87
- **83 new red-team tests** across 18 attack categories: hook command blocking bypass, hook env var injection, hook YAML corruption, notify osascript injection, notify log path traversal, notify template injection, migrate path traversal, migrate CSV injection, sync shell injection, sync local adapter traversal, sync SQL injection, quiet hours edge cases, rule name validation, command channel safety, hook concurrency manipulation, mute state tampering, YAML rule store corruption, sync adapter type safety
- **VULN-20 (LOW):** rm flag bypass (`-rfv`, `-r -f`, `--recursive`, `--force`) in hook command blocking — fixed with expanded BLOCKED_PATTERNS regex
- **VULN-21 (MEDIUM):** Null bytes in event fields crash executeHook via env vars — fixed with `sanitizeEnv()` stripping `\0` before child_process
- 4 findings documented as accepted risk. All existing defenses held (YAML serialization, sq() quoting, parameterized SQL, DB CHECK constraints, content filter, osascript escaping, sanitizeFileName, isPathSafe)

### Infrastructure
- Shell completions updated for sync command across bash/zsh/fish
- Help system updated with sync command
- Docker parity verified for all new test suites
- 63 sync-specific tests covering validation, CRUD, local adapter, history, security, edge cases

## [0.4.0] — 2026-03-17

### Highlights
- **34 CLI commands** (up from 31 in v0.3.0)
- **2,393 tests** (up from 2,117)
- **~35,700 LoC** across all modules
- Lifecycle hooks and notification rules for event-driven automation
- Data migration tool for importing from ChatGPT, Claude, Obsidian, CSV, JSONL, and Markdown
- Red-team session covering HTTP API, webhooks, SSE, pipes, snapshots, aliases (91 tests, 2 vulns found+fixed)
- v0.3.0 → v0.4.0: 5 feature sessions, 1 red-team session, 276 new tests, 0 regressions

### CLI — Automation & Event-Driven
- `ved hook` — Lifecycle hook manager. 11 subcommands: list, add, remove, show, edit, enable, disable, test, history, types. Hooks subscribe to EventBus event types and execute shell commands asynchronously. Event JSON piped to stdin + VED_EVENT_* env vars. Features: concurrency limits (per-hook), timeout enforcement, execution history (500 max), dangerous command blocking (rm -rf, sudo, dd, fork bombs), YAML persistence, HookRunner for runtime EventBus integration
- `ved notify` — Notification rules manager. 12 subcommands: list, add, remove, show, edit, enable, disable, test, history, channels, mute, unmute. 4 delivery channels: terminal (bell+banner), desktop (osascript/notify-send), command (stdin JSON), log (append). Features: template system ({type}/{actor}/{session}/{detail}), per-rule throttling, quiet hours, global mute with auto-expiry, suppression tracking, delivery history (500 max), NotifyRunner for runtime integration

### CLI — Data Migration
- `ved migrate` — Data migration tool. 9 subcommands: status, markdown, json, obsidian, csv, jsonl import, undo, validate, history. Supports ChatGPT export JSON, Claude export JSON, generic JSON arrays, CSV with header mapping, JSONL streams, Obsidian vault directories, and Markdown files/directories. Features: migration tracking in ~/.ved/migrations/, frontmatter preservation, entity auto-routing, wikilink preservation, audit logging (3 new event types), collision handling (skip/overwrite/merge)

### Security — Red-Team Session 79
- **91 new red-team tests** across 11 attack categories: HTTP API request smuggling, webhook SSRF, SSE resource exhaustion, pipe shell injection, snapshot git injection, alias command injection, HTTP auth bypass, webhook payload manipulation, HTTP endpoint edge cases, EventBus edge cases, pipeline YAML parsing
- **VULN-18 (MEDIUM):** Pipeline path traversal in load/delete — fixed with path containment checks
- **VULN-19 (MEDIUM):** Webhook custom header override could spoof HMAC signature — fixed by blocking reserved header names
- 3 findings documented as accepted risk. All existing defenses held
- **Total vulnerabilities found and fixed across all red-team sessions: 19** (0 open)

### Infrastructure
- Shell completions updated for all new commands across bash/zsh/fish
- Help system updated with hook, notify, and migrate commands
- Docker parity verified for all new test suites

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
