# Ved Obsidian Memory — Design Document

**Session:** 22  
**Phase:** THINK (2 of 3)  
**Date:** 2026-03-04  

---

## 1. Why Obsidian?

Obsidian is a Markdown editor with a graph view that renders `[[wikilinks]]` as edges between notes. Ved's semantic memory (T3) IS an Obsidian vault — meaning:

- **Human-readable:** Every memory is a `.md` file a human can open, read, and edit.
- **Human-editable:** The user can correct Ved's knowledge by editing files. No proprietary format.
- **Visualizable:** Obsidian's graph view shows Ved's entire knowledge graph — entities, connections, clusters.
- **Git-trackable:** Full version history of how Ved's knowledge evolved over time.
- **Portable:** Plain files. No lock-in. Move the vault anywhere.

Ved doesn't run Obsidian — it reads/writes the same Markdown files Obsidian uses. The vault is a shared interface between Ved (agent) and the human (editor/viewer).

---

## 2. Vault Structure

```
~/ved-vault/
├── .obsidian/              # Obsidian app config (graph settings, plugins)
│   └── graph.json          # Graph view colors/filters by folder
├── daily/                  # T2: Episodic memory (daily notes)
│   ├── 2026-03-04.md
│   ├── 2026-03-05.md
│   └── ...
├── entities/               # T3: People, orgs, places
│   ├── people/
│   │   ├── nagarjun-srinivasan.md
│   │   └── bob-friday.md
│   ├── orgs/
│   │   ├── hpe.md
│   │   └── mist-systems.md
│   └── places/
│       └── san-jose.md
├── projects/               # T3: Active projects and work
│   ├── ved.md
│   ├── bad-min-database.md
│   └── gita-speaker.md
├── concepts/               # T3: Ideas, technologies, domains
│   ├── hash-chain-audit.md
│   ├── mcp-protocol.md
│   └── trust-tiers.md
├── decisions/              # T3: Dated decision records
│   ├── 2026-03-01-pivot-to-standalone.md
│   └── 2026-03-04-single-threaded-loop.md
├── topics/                 # T3: Broader knowledge areas
│   ├── indoor-location.md
│   ├── reinforcement-learning.md
│   └── wireless-networking.md
├── templates/              # Templates for new notes (Obsidian uses these)
│   ├── person.md
│   ├── project.md
│   ├── decision.md
│   └── daily.md
├── ved.md                  # Ved's self-knowledge (identity, capabilities)
└── README.md               # What this vault is, how to use it
```

### Folder Rationale

| Folder | Purpose | Why separate? |
|--------|---------|---------------|
| `daily/` | Episodic memory — what happened each day | Time-indexed, high volume, auto-generated |
| `entities/` | People, orgs, places — real-world nouns | Core graph nodes. Sub-folders because entity types have different schemas |
| `projects/` | Work being tracked | Active, frequently updated, linked to people + decisions |
| `concepts/` | Technical ideas, mental models | Less volatile than projects. Ved's "understanding" |
| `decisions/` | Why we chose X over Y | Dated, immutable once written. Critical for reasoning audit |
| `topics/` | Broad knowledge areas | Aggregation nodes — link many entities/concepts together |
| `templates/` | Obsidian template files | Not memory — just structure helpers |

### File Naming Convention

- **Lowercase kebab-case:** `nagarjun-srinivasan.md`, `hash-chain-audit.md`
- **Decisions prefixed with date:** `2026-03-04-single-threaded-loop.md`
- **Daily notes by date:** `2026-03-04.md`
- **No ULIDs in filenames** — human-readable names are the whole point
- **Uniqueness enforced per folder** — `entities/people/bob-friday.md` won't collide with `concepts/bob-friday.md` (unlikely but safe)
- **Rename = update all wikilinks** — Ved must grep for `[[old-name]]` and replace when renaming

---

## 3. YAML Frontmatter Schema

Every vault file has YAML frontmatter. This is structured metadata that Ved can parse programmatically while humans read the Markdown body.

### 3.1 Common Fields (all files)

```yaml
---
type: person | org | place | project | concept | decision | topic | daily
created: 2026-03-04T20:16:00-08:00    # ISO 8601
updated: 2026-03-04T21:30:00-08:00    # last modification
source: conversation | observation | research | manual
confidence: high | medium | low        # how sure Ved is
tags:
  - tag1
  - tag2
---
```

### 3.2 Person Schema

```yaml
---
type: person
created: 2026-03-04T20:16:00-08:00
updated: 2026-03-04T20:16:00-08:00
source: conversation
confidence: high
tags:
  - person
  - colleague
aliases:
  - Nag
  - nagaconda
trust_tier: 4          # 1-4, mirrors Ved trust system
relation: owner        # owner | tribe | colleague | acquaintance | mentioned
---
# Nagarjun Srinivasan

Principal Systems Engineer at [[hpe|HPE]]. Reports to [[bob-friday|Bob Friday]].

## Key Facts
- Based in [[san-jose|San Jose, CA]]
- Working on [[bad-min-database]] and [[gita-speaker]]
- Career: [[mist-systems]] → Juniper → [[hpe|HPE]]

## Interactions
- 2026-03-04: Discussed [[ved]] architecture decisions
```

### 3.3 Project Schema

```yaml
---
type: project
created: 2026-03-04T20:16:00-08:00
updated: 2026-03-04T20:16:00-08:00
source: conversation
confidence: high
tags:
  - project
  - active
status: active         # active | paused | completed | abandoned
priority: high         # high | medium | low
owner: "[[nagarjun-srinivasan]]"
repo: https://github.com/cheenu1092-oss/witness
---
```

### 3.4 Decision Schema

```yaml
---
type: decision
created: 2026-03-04T20:16:00-08:00
updated: 2026-03-04T20:16:00-08:00
source: conversation
confidence: high
tags:
  - decision
  - architecture
decided_by: "[[nagarjun-srinivasan]]"
status: final          # proposed | final | reversed
context: "[[ved]]"     # what project/topic this decision belongs to
---
# Single-Threaded Event Loop

**Date:** 2026-03-04  
**Decision:** Use a single-threaded, message-driven event loop with no concurrency.

## Context
Ved is a personal assistant for one user. Concurrent request handling adds complexity (race conditions on memory, interleaved audit chains) with no benefit.

## Alternatives Considered
1. **Worker threads per channel** — Rejected: memory conflicts
2. **Async concurrent processing** — Rejected: audit chain ordering issues
3. **Single-threaded (chosen)** — Simple, correct, fast enough

## Consequences
- Max throughput: one message at a time
- No deadlocks, no race conditions
- Memory and audit operations are always serialized
```

### 3.5 Concept Schema

```yaml
---
type: concept
created: 2026-03-04T20:16:00-08:00
updated: 2026-03-04T20:16:00-08:00
source: research
confidence: high
tags:
  - concept
  - security
related:
  - "[[ved-audit]]"
  - "[[tamper-evidence]]"
---
```

### 3.6 Daily Note Schema (T2)

```yaml
---
type: daily
date: 2026-03-04
mood: productive        # optional, human can set
tags:
  - daily
---
# 2026-03-04

## Session Summary
- Discussed Ved architecture with [[nagarjun-srinivasan]]
- Designed core event loop (see [[2026-03-04-single-threaded-loop]])
- Key topics: [[hash-chain-audit]], [[trust-tiers]], [[mcp-protocol]]

## Key Facts Extracted
- Ved targets <10K LoC
- All tools via MCP servers
- Trust matrix: 4 tiers × 4 risk levels

## Open Questions
- Obsidian vault conventions (→ Session 22)
- RAG pipeline specifics (→ Session 23)
```

---

## 4. Wikilink Conventions

Wikilinks are Ved's **graph edges**. They connect entities, concepts, projects, and decisions. Obsidian renders them as a navigable, visual graph.

### 4.1 Syntax

```markdown
[[filename]]                    # link by filename (no path needed — Obsidian resolves)
[[filename|display text]]       # aliased link (shows "display text", links to filename)
[[filename#heading]]            # link to specific section
```

### 4.2 Resolution Rules

- **Obsidian resolves links by filename, not path.** So `[[bob-friday]]` finds `entities/people/bob-friday.md` regardless of where the linking file is.
- **Ved must maintain a filename index** — a Map<filename, filepath> updated on vault changes. This avoids filesystem scans on every link resolution.
- **Ambiguity:** If two files have the same name in different folders, use the full path: `[[entities/people/bob-friday]]`. Avoid this by keeping names unique (the naming convention helps).

### 4.3 Relationship Encoding

Wikilinks encode typed relationships through **context** — the surrounding text tells you the relationship type:

```markdown
# In nagarjun-srinivasan.md:
Works at [[hpe|HPE]]                    # employment
Reports to [[bob-friday|Bob Friday]]    # hierarchy
Based in [[san-jose|San Jose]]          # location
Working on [[ved]]                      # involvement

# In ved.md:
Created by [[nagarjun-srinivasan]]      # authorship
Uses [[mcp-protocol]]                   # dependency
Decision: [[2026-03-04-single-threaded-loop]]  # decision link
```

**Why not typed links?** (e.g., `[[works_at::hpe]]`)
- Obsidian doesn't natively support typed links — they'd need plugins (Dataview).
- For RAG, the surrounding text provides enough context for the LLM to understand the relationship.
- Keeping it simple means the vault works in any Markdown editor, not just Obsidian.
- If we need typed relationships later, YAML frontmatter `related:` field already supports it.

### 4.4 Graph Walk Algorithm

When Ved retrieves context (ENRICH step), it can **walk wikilinks** to pull in related knowledge:

```
1. User asks about "Bob Friday"
2. RAG finds entities/people/bob-friday.md (direct hit)
3. Parse wikilinks in bob-friday.md → [[hpe]], [[mist-systems]], [[nagarjun-srinivasan]]
4. Depth-1 walk: pull summaries of those files too
5. Token budget decides how many hops and how much content
```

```typescript
interface GraphWalkOptions {
  startFile: string;       // initial file path
  maxDepth: number;        // how many link hops (default: 1)
  maxNodes: number;        // max files to include (default: 5)
  maxTokens: number;       // token budget for graph context
  excludeFolders?: string[]; // e.g., exclude 'daily/' for non-temporal queries
}

interface GraphNode {
  path: string;
  content: string;          // full or truncated content
  frontmatter: Record<string, unknown>;
  links: string[];          // outgoing wikilinks
  backlinks: string[];      // files that link TO this file
  depth: number;            // how many hops from start
}

function walkGraph(opts: GraphWalkOptions): GraphNode[] {
  // BFS from startFile
  // At each node: parse wikilinks, resolve to file paths
  // Respect maxDepth, maxNodes, maxTokens
  // Return nodes sorted by relevance (depth, then backlink count)
}
```

### 4.5 Backlinks

Obsidian shows backlinks natively (files that link TO the current file). Ved should compute these too:

- **On vault load:** Build a reverse index `Map<filename, Set<filename>>` of all backlinks.
- **On file change:** Update incrementally (parse changed file's links, update reverse index).
- **Why backlinks matter:** They show what's connected to an entity. If many files link to `[[mcp-protocol]]`, it's a central concept. Backlink count is a rough importance signal.

---

## 5. How Ved Reads/Writes/Searches the Vault

### 5.1 Vault Manager Interface

```typescript
interface VaultManager {
  // === Lifecycle ===
  init(vaultPath: string): Promise<void>;   // load index, build backlinks
  watch(): void;                             // watch for external changes (human edits)
  close(): void;

  // === Read ===
  readFile(path: string): Promise<VaultFile>;
  listFiles(folder?: string): Promise<string[]>;
  getBacklinks(filename: string): string[];
  resolveLink(wikilink: string): string | null;  // filename → full path

  // === Write ===
  createFile(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void>;
  updateFile(path: string, frontmatter?: Partial<Record<string, unknown>>, body?: string): Promise<void>;
  appendToFile(path: string, content: string): Promise<void>;  // for daily notes
  deleteFile(path: string): Promise<void>;

  // === Search (local, non-RAG) ===
  findByTag(tag: string): string[];
  findByType(type: string): string[];
  findByFrontmatter(key: string, value: unknown): string[];

  // === Graph ===
  walkGraph(opts: GraphWalkOptions): GraphNode[];
  getLinks(path: string): string[];          // outgoing links from a file
  
  // === Index ===
  rebuildIndex(): Promise<void>;             // full re-index
  getIndex(): VaultIndex;
}

interface VaultFile {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;                // markdown content (without frontmatter)
  links: string[];             // parsed wikilinks
  raw: string;                 // full file content
  stats: { created: Date; modified: Date; size: number };
}

interface VaultIndex {
  files: Map<string, string>;              // filename → path
  backlinks: Map<string, Set<string>>;     // filename → set of files linking to it
  tags: Map<string, Set<string>>;          // tag → set of file paths
  types: Map<string, Set<string>>;         // type → set of file paths
}
```

### 5.2 File Change Detection

When Ved writes a vault file, it must:
1. Parse the new/updated file for wikilinks.
2. Update the filename index.
3. Update the backlink reverse index.
4. Trigger RAG re-indexing for that file (ved-rag).
5. Create an audit entry (T4) for the memory operation.
6. If git is enabled, stage the file.

When a **human** edits a vault file (detected via filesystem watcher):
1. Same index/backlink updates.
2. Re-index for RAG.
3. Audit entry: `source: manual`, `actor: human`.
4. Git stage (human edits are equally tracked).

```typescript
// File watcher (chokidar or Node.js fs.watch)
vault.watch();  // starts watching vaultPath recursively

// On change event:
// 1. Re-parse frontmatter + links
// 2. Update indices
// 3. Queue for RAG re-embedding
// 4. Audit log: { eventType: 'vault_file_changed', actor: 'human', detail: { path, changeType } }
```

### 5.3 Writing Vault Files

Ved writes files in two contexts:

**A. During MAINTAIN step (automatic):**
- T1→T2: Compress working memory into daily note (append to `daily/YYYY-MM-DD.md`)
- T3 extraction: Create/update entity files based on conversation content

**B. During ACT step (LLM-directed):**
- LLM explicitly says "remember that Bob Friday is the Chief AI Officer"
- Creates `MemoryOp { type: 'semantic_upsert', path: 'entities/people/bob-friday.md', ... }`
- Ved executes the memory op

**File creation flow:**
```
LLM says "remember X about Y"
    │
    ▼
Parse into MemoryOp
    │
    ▼
Does entities/people/y.md exist?
├── Yes → updateFile (merge new facts into body, update frontmatter.updated)
└── No  → createFile (use template, populate frontmatter + body)
    │
    ▼
Update indices + audit log
    │
    ▼
Queue for RAG re-embedding
```

---

## 6. T1→T2 Compression (Working Memory → Daily Notes)

### 6.1 When Does Compression Happen?

- **Session boundary:** When Ved goes idle for >30 minutes (configurable).
- **Token overflow:** When T1 working memory exceeds `compressionThreshold` tokens.
- **Explicit flush:** LLM requests "end of conversation" or user says "done for now".
- **Shutdown:** On graceful shutdown, always compress remaining T1.

### 6.2 Compression Prompt

```typescript
const compressionPrompt = `
You are summarizing a conversation session for daily notes.

CONVERSATION:
${workingMemoryContent}

Instructions:
1. Write a concise summary (3-5 bullet points) of what happened.
2. Extract any NEW FACTS about people, projects, or concepts.
3. List any DECISIONS made (with reasoning).
4. Note any OPEN QUESTIONS or TODO items.
5. List all entities mentioned that should have vault files.

Output format:
## Session Summary
- bullet points

## Facts Extracted
- fact: <fact> | entity: <entity_filename> | type: <person|project|concept>

## Decisions
- decision: <what> | context: <why> | file: <decision_filename>

## Open Questions
- question

## Entities to Create/Update
- filename: <kebab-case> | folder: <entities/people|projects|concepts> | action: <create|update>
`;
```

### 6.3 Compression Output Processing

1. **Session Summary** → Append to `daily/YYYY-MM-DD.md` under the current time heading.
2. **Facts Extracted** → For each fact, upsert the corresponding entity file in T3.
3. **Decisions** → Create new decision files in `decisions/`.
4. **Entities to Create/Update** → Batch create/update vault files.
5. **All ops audited** — each file write is a separate audit entry.

### 6.4 Entity Extraction Heuristics

Not all entity extraction goes through the compression prompt. During conversation, Ved can recognize entity-relevant statements:

```typescript
// Patterns that trigger entity extraction:
// - "Bob Friday is the Chief AI Officer at HPE"
//   → upsert entities/people/bob-friday.md, add fact
// - "We decided to use single-threaded architecture"
//   → create decisions/2026-03-04-single-threaded-arch.md
// - "Remember that the API key expires March 15"
//   → append to relevant entity or create note

// The LLM handles this via MemoryOp in its response.
// Ved doesn't do NER — the LLM is the NER engine.
```

---

## 7. Git Integration

The Obsidian vault is a git repository. Every knowledge change is version-tracked.

### 7.1 Strategy: Batched Auto-Commits

- **NOT** on every file write (too noisy, kills performance).
- **Batch commits** at natural boundaries:
  1. After T1→T2 compression (end of session)
  2. After entity extraction batch (multiple files updated)
  3. On shutdown
  4. On a timer (every 15 minutes if dirty)

### 7.2 Commit Message Format

```
ved: <action> — <summary>

Examples:
ved: session-compress — 2026-03-04 session summary + 3 entity updates
ved: entity-update — bob-friday.md (new role: Chief AI Officer)
ved: decision — 2026-03-04-single-threaded-loop.md
ved: daily-note — 2026-03-04 session at 20:16
ved: human-edit — detected external changes to 2 files
```

### 7.3 Git Operations

```typescript
interface VaultGit {
  init(): Promise<void>;          // git init if not already a repo
  stage(paths: string[]): Promise<void>;    // git add
  commit(message: string): Promise<void>;   // git commit
  isClean(): Promise<boolean>;    // any unstaged changes?
  log(limit?: number): Promise<GitLogEntry[]>;  // recent commits
  diff(path: string): Promise<string>;  // what changed in a file
}

// Ved tracks dirty files and batches:
class GitBatcher {
  private dirty: Set<string> = new Set();
  private timer: NodeJS.Timeout | null = null;

  markDirty(path: string): void {
    this.dirty.add(path);
    this.scheduleCommit();  // 15-minute debounce
  }

  async flush(message: string): Promise<void> {
    if (this.dirty.size === 0) return;
    await git.stage([...this.dirty]);
    await git.commit(message);
    this.dirty.clear();
  }

  private scheduleCommit(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.flush('ved: auto-commit — periodic vault sync');
      this.timer = null;
    }, 15 * 60 * 1000);
  }
}
```

### 7.4 Human Edit Detection

When the file watcher detects changes Ved didn't make:
1. Identify which files changed (mtime comparison or watcher events).
2. Re-parse frontmatter and links.
3. Update indices.
4. Audit log: `{ eventType: 'vault_external_edit', actor: 'human', detail: { paths } }`.
5. Mark files dirty for git.
6. Auto-commit: `ved: human-edit — detected external changes to N files`.

This means `git log` shows a clear narrative: Ved's changes, human corrections, and when they happened.

---

## 8. Template System

Templates reduce code in Ved — instead of building Markdown strings programmatically, Ved fills in templates.

### 8.1 Person Template

```markdown
---
type: person
created: {{created}}
updated: {{updated}}
source: {{source}}
confidence: {{confidence}}
tags:
  - person
aliases: []
trust_tier: 1
relation: mentioned
---
# {{name}}

## Key Facts
{{#facts}}
- {{.}}
{{/facts}}

## Connections
{{#connections}}
- {{.}}
{{/connections}}

## Interactions
- {{date}}: First mentioned in conversation
```

### 8.2 Template Engine

Simple Mustache-style substitution. No need for a library — a 20-line function:

```typescript
function renderTemplate(template: string, vars: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    if (Array.isArray(value)) {
      // Handle {{#key}}...{{.}}...{{/key}} blocks
      const blockRegex = new RegExp(`{{#${key}}}([\\s\\S]*?){{/${key}}}`, 'g');
      result = result.replace(blockRegex, (_, inner) =>
        value.map(item => inner.replace(/{{\.}}/g, String(item))).join('\n')
      );
    } else {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }
  }
  // Remove unfilled blocks
  result = result.replace(/{{#\w+}}[\s\S]*?{{\/\w+}}/g, '');
  // Remove unfilled vars
  result = result.replace(/{{\w+}}/g, '');
  return result;
}
```

---

## 9. Obsidian App Configuration

Ved creates a `.obsidian/` directory with graph settings so when a human opens the vault in Obsidian, it looks good out of the box.

### 9.1 Graph Colors by Folder

```json
{
  "colorGroups": [
    { "query": "path:daily",     "color": { "a": 1, "rgb": 5025616 } },
    { "query": "path:entities",  "color": { "a": 1, "rgb": 2201331 } },
    { "query": "path:projects",  "color": { "a": 1, "rgb": 16750848 } },
    { "query": "path:concepts",  "color": { "a": 1, "rgb": 8388736 } },
    { "query": "path:decisions", "color": { "a": 1, "rgb": 16711680 } },
    { "query": "path:topics",    "color": { "a": 1, "rgb": 65280 } }
  ]
}
```

### 9.2 Recommended Plugins

Ved doesn't require any Obsidian plugins, but recommends:
- **Dataview** — query frontmatter across files (e.g., "show all active projects")
- **Calendar** — navigate daily notes by date
- **Graph Analysis** — betweenness centrality, clustering on the knowledge graph
- **Git** — visual git history within Obsidian

---

## 10. Memory Tier Integration Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    Ved Memory Architecture                       │
│                                                                  │
│  T1: WORKING MEMORY (RAM)                                       │
│  ├── Current conversation context                                │
│  ├── Active facts for this session                               │
│  ├── Prompt-injected (highest priority)                          │
│  └── On session end → compress to T2 + extract to T3            │
│                                                                  │
│  T2: EPISODIC MEMORY (Obsidian daily/)                          │
│  ├── daily/YYYY-MM-DD.md                                        │
│  ├── Auto-generated from T1 compression                         │
│  ├── Human-readable session summaries                            │
│  └── Searchable via RAG + FTS5                                   │
│                                                                  │
│  T3: SEMANTIC MEMORY (Obsidian vault)                           │
│  ├── entities/ — people, orgs, places                            │
│  ├── projects/ — active work                                     │
│  ├── concepts/ — ideas, technologies                             │
│  ├── decisions/ — dated decision records                         │
│  ├── topics/ — broad knowledge areas                             │
│  ├── [[wikilinks]] = graph edges (visualized in Obsidian)       │
│  ├── YAML frontmatter = structured metadata                      │
│  ├── git-tracked = full knowledge evolution history              │
│  └── Searchable via RAG + FTS5 + graph walk                     │
│                                                                  │
│  T4: ARCHIVAL + AUDIT (SQLite)                                  │
│  ├── Hash-chained action log                                     │
│  ├── Vector embeddings (RAG index)                               │
│  ├── FTS5 full-text search                                       │
│  ├── Trust ledger + work orders                                  │
│  └── External HMAC anchoring                                     │
│                                                                  │
│  TRANSITIONS:                                                    │
│  T1 → T2: Session compression (summarize → daily note)          │
│  T1 → T3: Entity extraction (facts → vault files)               │
│  T2 → T4: Original transcripts archived (summaries stay in T2)  │
│  T3 → T4: Every vault edit is an audit entry                    │
│  T4 → T1: RAG retrieval injects archived knowledge into prompt  │
│  T3 → T1: Graph walk pulls related entities into context        │
│  Every transition is an audited event in T4.                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11. Open Questions for Session 23

1. **RAG pipeline details:** How do we chunk vault files for embedding? By heading? Fixed token count? Whole file if small?
2. **Hybrid search ranking:** How do vector similarity + FTS5 scores + graph proximity combine into a single ranking?
3. **Embedding model:** nomic-embed-text via Ollama (local). What chunk size? What overlap? Dimension?
4. **Re-indexing strategy:** On every file change? Batch? Background queue?
5. **README/manifesto:** What should Ved's public README look like? What's the pitch?

---

## 12. Comparison: Ved Memory vs. Existing Approaches

| System | Memory Model | Searchable? | Human-readable? | Audited? | Visualizable? |
|--------|-------------|-------------|-----------------|----------|---------------|
| ChatGPT | Flat "memories" list | No | Barely | No | No |
| OpenClaw | MEMORY.md + daily files | memory_search | Yes | No | No |
| Mem0 | Vector DB + graph | API only | No | No | No |
| Letta/MemGPT | Tiered (core/archival) | Vector search | No | No | No |
| **Ved** | **4-tier Obsidian + SQLite** | **RAG + FTS5 + graph** | **Yes (Markdown)** | **Hash-chain** | **Obsidian graph** |

Ved's advantage: the knowledge graph is simultaneously a human-readable document store, a searchable RAG corpus, an audited record, and a visual graph. No other system provides all four.

---

*End of Obsidian memory design. Next: Session 23 — RAG pipeline design + Ved manifesto (README).*
