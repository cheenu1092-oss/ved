# Getting Started with Ved

A practical guide to installing, configuring, and running Ved — the personal AI agent that remembers everything and proves it.

---

## Prerequisites

- **Node.js** ≥ 20 (22+ recommended)
- **Ollama** — for local embeddings (`nomic-embed-text`)
- **SQLite** — included via `better-sqlite3`
- **Git** — for vault version control
- An **LLM API key** (OpenAI, Anthropic, or Ollama for local)

## Install

```bash
git clone https://github.com/cheenu1092-oss/ved.git
cd ved
npm install
npm run build
```

## Initialize

```bash
# Create vault directory structure, config template, and database
ved init

# Or specify a custom vault path
ved init --vault ~/my-vault
```

This creates:
```
~/ved-vault/
├── daily/          # T2: Episodic memory (daily notes)
├── entities/       # T3: People, organizations, places
├── concepts/       # T3: Ideas, technologies, mental models
├── decisions/      # T3: Dated decision records
├── topics/         # T3: Broad knowledge areas
└── README.md

~/.ved/
└── config.yaml     # Local configuration
```

## Configure

Edit `~/.ved/config.yaml`:

```yaml
# LLM provider
llm:
  provider: openai          # openai | anthropic | ollama
  model: gpt-4o             # or claude-3-5-sonnet, llama3, etc.
  apiKey: sk-...             # or set OPENAI_API_KEY env var

# Vault location (Obsidian-compatible)
vault:
  path: ~/ved-vault

# Trust tiers (who can do what)
trust:
  ownerIds:
    - owner                  # your user ID

# Optional: Ollama for embeddings (local, free)
rag:
  embedModel: nomic-embed-text
  ollamaUrl: http://localhost:11434
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `VED_CONFIG_DIR` | Override config directory (default: `~/.ved`) |
| `VED_VAULT_PATH` | Override vault path |

## Start Ollama (for RAG)

```bash
# Install Ollama if needed
brew install ollama     # macOS
# or curl -fsSL https://ollama.com/install.sh | sh   # Linux

# Pull the embedding model
ollama pull nomic-embed-text

# Ollama runs as a service — no manual start needed
```

## Your First Chat

```bash
# Interactive REPL — the main way to talk to Ved
ved chat

# With options
ved chat --model claude-3-5-sonnet --verbose
```

Once inside:
```
  Ved Chat
  The personal AI agent that remembers everything.
  Type /help for commands, /quit to exit.

you> What can you do?

ved>
  I'm Ved, your personal AI assistant. I can:
  - Remember our conversations (stored as Obsidian daily notes)
  - Search my knowledge graph for relevant context
  - Use tools via MCP servers (with your approval for risky ones)
  - Build a knowledge graph of people, projects, and decisions
  ...
```

### Chat Commands

| Command | Description |
|---------|-------------|
| `/search <query>` | Search vault via RAG |
| `/facts` | Show active working memory |
| `/memory [path]` | Browse vault files |
| `/approve <id>` | Approve a pending work order |
| `/deny <id> [reason]` | Deny a work order |
| `/stats` | Session statistics |
| `/multi` | Multi-line input mode |
| `/clear` | Clear screen |
| `/quit` | Exit |

## One-Shot Queries

```bash
# Ask a question without entering the REPL
ved run "What meetings do I have this week?"

# Pipe input
echo "Summarize this" | ved run --stdin

# Disable RAG for simple questions
ved run --no-rag "What's 2+2?"
```

## Index Your Vault

```bash
# Build RAG index (embeddings + FTS)
ved reindex

# Check index status
ved stats
```

Output:
```
Vault: 127 files across 5 folders
RAG:   127 indexed, 0 pending
Audit: 1,042 entries, chain valid
```

## Search

```bash
# Search via RAG (vector + keyword + graph fusion)
ved search "project deadlines"

# Full-text only (faster)
ved search --fts-only "budget 2026"
```

## Health Check

```bash
# Run 8-point diagnostics
ved doctor
```

Checks: config validity, database integrity, vault structure, git status, audit chain, RAG index, LLM connectivity, MCP tools.

## Memory Architecture

Ved has 4 memory tiers:

| Tier | Storage | Purpose |
|------|---------|---------|
| **T1** Working | RAM (in-prompt) | Current conversation context |
| **T2** Episodic | `daily/YYYY-MM-DD.md` | Session summaries |
| **T3** Semantic | `entities/`, `concepts/`, `decisions/` | Knowledge graph |
| **T4** Archival | SQLite | Audit log, vectors, FTS |

**Key principle:** Nothing is truly lost. T1 compresses to T2. T2 compresses to T4. T3 is permanent (git-tracked).

Open `~/ved-vault` in Obsidian to visualize your knowledge graph interactively.

## Audit Trail

Every action is hash-chain logged:

```bash
# View recent audit entries
ved history --limit 20

# Verify chain integrity
ved history --verify

# Filter by type
ved history --type tool_call --limit 10
```

## Backup & Restore

```bash
# Create a snapshot
ved backup create

# List backups
ved backup list

# Restore
ved backup restore <timestamp>
```

## Scheduled Jobs

```bash
# List cron jobs
ved cron list

# Add a daily backup at 2 AM
ved cron add --name daily-backup --schedule "0 2 * * *" --type backup

# Add hourly reindex
ved cron add --name hourly-reindex --schedule "0 * * * *" --type reindex
```

## HTTP API

```bash
# Start the API server
ved serve --port 3000 --token mysecret

# Health check
curl http://localhost:3000/api/health

# Search
curl -H "Authorization: Bearer mysecret" \
  "http://localhost:3000/api/search?q=meetings"

# Live event stream (SSE)
curl -H "Authorization: Bearer mysecret" \
  http://localhost:3000/api/events
```

The web dashboard is available at `http://localhost:3000/` with 6 panels: overview, events, search, history, vault, and doctor.

## Environments

```bash
# List environments
ved env list

# Create a test environment
ved env create test --template test

# Switch environments
ved env use test

# Compare
ved env diff dev prod
```

## Task Management

```bash
# Add a task
ved task add "Review PR #42" --priority high --project ved

# Kanban board view
ved task board

# Mark complete
ved task done <id>
```

## CLI Reference

Ved has 46 commands. Run `ved help` for the full list, or `ved help <command>` for details.

```bash
ved help           # Overview of all commands
ved help chat      # Detailed help for chat
ved config show    # Show resolved configuration
```

## Docker

```bash
# Build
docker compose build

# Run tests
docker compose run --rm ved npm run test:run

# Run Ved in Docker
docker compose run --rm ved ved chat
```

## What's Next?

- **Open your vault in Obsidian** — see the knowledge graph visually
- **Set up MCP tools** — `ved plugin add <server>` 
- **Configure Discord** — add a `channel.discord` section to config
- **Set up webhooks** — `ved webhook add <url>` for integrations
- **Explore the API** — `ved serve` and visit the dashboard

---

*Ved v0.6.0 • 46 commands • 3,000+ tests • MIT License*
