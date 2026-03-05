# Ved RAG Pipeline — Design Document

**Session:** 23  
**Phase:** THINK (3 of 3 — final THINK session)  
**Date:** 2026-03-04  

---

## 1. Overview

Ved's RAG (Retrieval-Augmented Generation) pipeline answers the question: **how does Ved find relevant knowledge from its vault to inject into the LLM prompt?**

Three retrieval paths combine into one ranking:
1. **Vector search** — semantic similarity via embeddings
2. **FTS5 search** — keyword/exact match via SQLite full-text search
3. **Graph walk** — follow wikilinks from seed nodes

The pipeline is a module (`ved-rag`) that the core event loop calls during the **ENRICH** step.

```
User message
    │
    ▼
┌─────────────────────────────┐
│         ENRICH Step          │
│                              │
│  1. Vector search (top-K)    │
│  2. FTS5 search (top-K)      │
│  3. Graph walk (from seeds)  │
│  4. Merge + Reciprocal Rank  │
│  5. Token-budget trim        │
│  6. Inject into prompt       │
└─────────────────────────────┘
    │
    ▼
LLM call (with retrieved context)
```

---

## 2. Embedding Strategy

### 2.1 Model: nomic-embed-text (via Ollama, local)

- **Why:** Open-source, 137M params, 768-dim, 8192-token context window. Good quality for its size. Runs on Apple Silicon with no GPU required. Already installed on our Ollama instance.
- **Dimensions:** 768
- **Max tokens per chunk:** 8192 (but we'll chunk smaller for precision)
- **Matryoshka support:** Yes — can truncate to 256/512 dims for faster search if needed later. Start with full 768.

### 2.2 Chunking Strategy

Vault files are Markdown with YAML frontmatter. Chunking must respect document structure.

**Strategy: Heading-based chunking with frontmatter prefix**

```
Each chunk = YAML frontmatter (compact) + one heading section
```

**Rules:**
1. Strip YAML frontmatter, serialize as compact one-liner for prefix.
2. Split body by `## ` headings (H2). If no H2, split by `### ` (H3). If no headings, whole body = one chunk.
3. Each chunk gets the frontmatter prefix for context (type, tags, title).
4. If a chunk exceeds 1024 tokens, split at paragraph boundaries.
5. If a chunk is under 64 tokens, merge with the next chunk.
6. Overlap: 0 tokens. Headings provide natural boundaries; overlap adds noise in structured Markdown.

**Why heading-based, not fixed-size?**
- Vault files are structured Markdown — headings are semantic boundaries.
- A "Key Facts" section is a coherent unit. Splitting it at token 512 breaks meaning.
- Most vault files are small (entity files: 200-500 tokens, daily notes: 500-2000 tokens). Fixed chunking would create many tiny fragments.

**Example:**

```markdown
---
type: person
tags: [person, colleague]
---
# Bob Friday

## Key Facts
- Chief AI Officer at HPE
- Founded Mist Systems
- Reports: Nagarjun Srinivasan works under him

## Career
- Cisco → Mist Systems (founder) → Juniper → HPE
```

Produces 2 chunks:
1. `[person, colleague] Bob Friday | Key Facts: Chief AI Officer at HPE. Founded Mist Systems...`
2. `[person, colleague] Bob Friday | Career: Cisco → Mist Systems (founder) → Juniper → HPE`

### 2.3 Chunk Data Model

```typescript
interface VaultChunk {
  id: string;              // ULID
  filePath: string;        // relative to vault root
  heading: string | null;  // H2/H3 heading this chunk belongs to (null = preamble)
  content: string;         // the chunk text (frontmatter prefix + body)
  tokenCount: number;      // estimated tokens
  embedding: Float32Array; // 768-dim vector
  updatedAt: number;       // unix ms — when chunk was last embedded
  fileModifiedAt: number;  // file mtime when embedded — detect staleness
}
```

### 2.4 Token Estimation

Use a simple heuristic instead of a tokenizer library:
```typescript
function estimateTokens(text: string): number {
  // English text averages ~4 chars per token (GPT-class models)
  // Markdown overhead makes it closer to 3.5 for our structured content
  return Math.ceil(text.length / 3.5);
}
```

Good enough for chunking and budget decisions. Exact counts come from the LLM provider at response time.

---

## 3. Indexing

### 3.1 Storage: SQLite (same database as audit)

One database, multiple concerns. SQLite handles it fine at Ved's scale.

```sql
-- Vector storage (using sqlite-vec extension)
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  embedding float[768]
);

-- Chunk metadata
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,          -- ULID
  file_path TEXT NOT NULL,      -- relative path in vault
  heading TEXT,                 -- section heading
  content TEXT NOT NULL,        -- chunk text
  token_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,  -- unix ms
  file_modified_at INTEGER NOT NULL,
  rowid INTEGER                 -- links to vec_chunks rowid
);

CREATE INDEX idx_chunks_file ON chunks(file_path);
CREATE INDEX idx_chunks_updated ON chunks(updated_at);

-- FTS5 index (separate from vector — different query paths)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  file_path,
  heading,
  content=chunks,
  content_rowid=rowid,
  tokenize='porter unicode61'  -- stemming + unicode
);

-- Triggers to keep FTS in sync
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, file_path, heading)
  VALUES (new.rowid, new.content, new.file_path, new.heading);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
  VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path, heading)
  VALUES ('delete', old.rowid, old.content, old.file_path, old.heading);
  INSERT INTO chunks_fts(rowid, content, file_path, heading)
  VALUES (new.rowid, new.content, new.file_path, new.heading);
END;
```

### 3.2 sqlite-vec

[sqlite-vec](https://github.com/asg017/sqlite-vec) is a SQLite extension for vector search:
- Exact KNN (brute-force) — fine for our scale (hundreds to low thousands of chunks)
- No approximate index needed until >100K vectors
- Ships as a loadable extension: `db.loadExtension('vec0')`
- Works with better-sqlite3 (our SQLite driver)

**Why not a vector DB (Chroma, Qdrant, etc.)?**
- Ved targets <10K LoC. Adding a vector DB is a separate service to manage.
- At our scale (a personal vault = hundreds of files, maybe 2-5K chunks), brute-force KNN in SQLite is <10ms.
- Single database file = simple backup, simple deployment.

### 3.3 Embedding via Ollama

```typescript
interface EmbeddingClient {
  embed(texts: string[]): Promise<Float32Array[]>;
}

class OllamaEmbedder implements EmbeddingClient {
  private baseUrl: string;   // default: http://localhost:11434
  private model: string;     // 'nomic-embed-text'

  async embed(texts: string[]): Promise<Float32Array[]> {
    // POST /api/embed { model, input: texts }
    // Returns { embeddings: number[][] }
    // Batch up to 32 texts per request
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    const data = await response.json();
    return data.embeddings.map((e: number[]) => new Float32Array(e));
  }
}
```

**Batching:** Ollama's `/api/embed` accepts arrays. Batch up to 32 chunks per call for indexing throughput.

---

## 4. Retrieval

### 4.1 Vector Search

```typescript
interface VectorSearchResult {
  chunkId: string;
  filePath: string;
  heading: string | null;
  content: string;
  distance: number;       // L2 distance (lower = more similar)
  score: number;          // normalized 0-1 (1 = perfect match)
}

async function vectorSearch(query: string, topK: number = 10): Promise<VectorSearchResult[]> {
  // 1. Embed the query
  const [queryVec] = await embedder.embed([query]);

  // 2. KNN search via sqlite-vec
  // SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?
  const vecResults = db.prepare(`
    SELECT rowid, distance
    FROM vec_chunks
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(queryVec, topK);

  // 3. Join with chunks table for metadata
  const results = vecResults.map(vr => {
    const chunk = db.prepare('SELECT * FROM chunks WHERE rowid = ?').get(vr.rowid);
    return {
      chunkId: chunk.id,
      filePath: chunk.file_path,
      heading: chunk.heading,
      content: chunk.content,
      distance: vr.distance,
      score: 1 / (1 + vr.distance),  // normalize: closer → higher score
    };
  });

  return results;
}
```

### 4.2 FTS5 Search

```typescript
interface FtsSearchResult {
  chunkId: string;
  filePath: string;
  heading: string | null;
  content: string;
  rank: number;           // BM25 rank from FTS5 (lower = more relevant)
  score: number;          // normalized 0-1
}

function ftsSearch(query: string, topK: number = 10): FtsSearchResult[] {
  // FTS5 with BM25 ranking
  const results = db.prepare(`
    SELECT c.*, f.rank
    FROM chunks_fts f
    JOIN chunks c ON c.rowid = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY f.rank
    LIMIT ?
  `).all(query, topK);

  // Normalize BM25 ranks to 0-1 scores
  if (results.length === 0) return [];
  const maxRank = Math.abs(results[results.length - 1].rank);
  return results.map(r => ({
    chunkId: r.id,
    filePath: r.file_path,
    heading: r.heading,
    content: r.content,
    rank: r.rank,
    score: maxRank === 0 ? 1 : 1 - (Math.abs(r.rank) / maxRank),
  }));
}
```

### 4.3 Graph Walk

```typescript
interface GraphSearchResult {
  filePath: string;
  content: string;        // full file or summary
  depth: number;          // hops from seed
  backlinkCount: number;  // importance signal
  score: number;          // normalized 0-1
}

function graphSearch(
  seedFiles: string[],      // files from vector/FTS hits
  maxDepth: number = 1,
  maxNodes: number = 5
): GraphSearchResult[] {
  // BFS from seed files following wikilinks
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [];
  const results: GraphSearchResult[] = [];

  for (const seed of seedFiles) {
    queue.push({ path: seed, depth: 0 });
    visited.add(seed);  // seeds already in vector/FTS results — skip them
  }

  while (queue.length > 0 && results.length < maxNodes) {
    const { path, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    const links = vaultManager.getLinks(path);
    for (const link of links) {
      const resolved = vaultManager.resolveLink(link);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);

      const file = vaultManager.readFileSync(resolved);
      const backlinkCount = vaultManager.getBacklinks(resolved).length;

      results.push({
        filePath: resolved,
        content: file.body,
        depth,
        backlinkCount,
        score: backlinkCount / (backlinkCount + 5) * (1 / (depth + 1)),
        // Decay by depth, boost by backlink count (diminishing returns via +5)
      });

      if (depth < maxDepth) {
        queue.push({ path: resolved, depth: depth + 1 });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxNodes);
}
```

### 4.4 Reciprocal Rank Fusion (RRF)

Three retrieval paths produce three ranked lists. We need a single combined ranking.

**Why RRF?** It's simple, parameter-free (besides k), and well-studied. No need to normalize heterogeneous scores (cosine sim vs BM25 rank vs graph hops).

```typescript
interface MergedResult {
  filePath: string;
  chunkId?: string;
  heading?: string | null;
  content: string;
  rrfScore: number;
  sources: ('vector' | 'fts' | 'graph')[];
}

function reciprocalRankFusion(
  vectorResults: VectorSearchResult[],
  ftsResults: FtsSearchResult[],
  graphResults: GraphSearchResult[],
  k: number = 60  // standard RRF constant
): MergedResult[] {
  const scoreMap = new Map<string, { score: number; sources: Set<string>; content: string; heading?: string | null; chunkId?: string }>();

  // Helper: add RRF score for a result
  function addScore(key: string, rank: number, source: string, content: string, heading?: string | null, chunkId?: string) {
    const existing = scoreMap.get(key) || { score: 0, sources: new Set(), content, heading, chunkId };
    existing.score += 1 / (k + rank + 1);  // RRF formula
    existing.sources.add(source);
    // Keep the longest content version
    if (content.length > existing.content.length) existing.content = content;
    scoreMap.set(key, existing);
  }

  // Vector results keyed by filePath (chunks from same file grouped)
  vectorResults.forEach((r, i) => addScore(r.filePath, i, 'vector', r.content, r.heading, r.chunkId));

  // FTS results
  ftsResults.forEach((r, i) => addScore(r.filePath, i, 'fts', r.content, r.heading, r.chunkId));

  // Graph results (these are full files, not chunks)
  graphResults.forEach((r, i) => addScore(r.filePath, i, 'graph', r.content));

  // Sort by RRF score descending
  const merged = [...scoreMap.entries()]
    .map(([filePath, data]) => ({
      filePath,
      chunkId: data.chunkId,
      heading: data.heading,
      content: data.content,
      rrfScore: data.score,
      sources: [...data.sources] as ('vector' | 'fts' | 'graph')[],
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore);

  return merged;
}
```

**Key detail:** We key by `filePath`, not by `chunkId`. Multiple chunks from the same file should boost that file's rank, not compete as separate entries. After ranking, we may pull multiple chunks from a high-ranked file.

### 4.5 Token Budget & Context Assembly

The merged results need to fit within a token budget before injection into the LLM prompt.

```typescript
interface RetrievalConfig {
  vectorTopK: number;        // default: 10
  ftsTopK: number;           // default: 10
  graphMaxDepth: number;     // default: 1
  graphMaxNodes: number;     // default: 5
  maxContextTokens: number;  // default: 4096 (budget for retrieved context)
  rrfK: number;              // default: 60
}

function assembleContext(
  results: MergedResult[],
  maxTokens: number
): string {
  const sections: string[] = [];
  let tokenBudget = maxTokens;

  for (const result of results) {
    const header = `### ${result.filePath}${result.heading ? ` > ${result.heading}` : ''}`;
    const section = `${header}\n${result.content}\n`;
    const tokens = estimateTokens(section);

    if (tokens > tokenBudget) {
      // Try to fit a truncated version
      if (tokenBudget > 100) {
        const truncated = result.content.slice(0, tokenBudget * 3.5);  // rough char→token
        sections.push(`${header}\n${truncated}...\n`);
      }
      break;
    }

    sections.push(section);
    tokenBudget -= tokens;
  }

  return `## Retrieved Context\n\n${sections.join('\n---\n\n')}`;
}
```

---

## 5. Indexing Pipeline

### 5.1 Full Re-index

Run on first boot or when explicitly requested.

```typescript
async function fullReindex(vaultPath: string): Promise<IndexStats> {
  const files = await vaultManager.listFiles();
  let chunksCreated = 0;

  // Clear existing index
  db.exec('DELETE FROM chunks');
  db.exec('DELETE FROM vec_chunks');

  // Process files in batches
  const batchSize = 32;  // match Ollama batch size
  const allChunks: Array<{ chunk: Omit<VaultChunk, 'embedding'>; text: string }> = [];

  for (const filePath of files) {
    const file = await vaultManager.readFile(filePath);
    const chunks = chunkFile(file);
    for (const chunk of chunks) {
      allChunks.push({ chunk, text: chunk.content });
    }
  }

  // Embed in batches
  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    const texts = batch.map(b => b.text);
    const embeddings = await embedder.embed(texts);

    // Insert into SQLite (transactional batch)
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const { chunk } = batch[j];
        const embedding = embeddings[j];

        // Insert metadata
        const info = db.prepare(`
          INSERT INTO chunks (id, file_path, heading, content, token_count, updated_at, file_modified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(chunk.id, chunk.filePath, chunk.heading, chunk.content, chunk.tokenCount, Date.now(), chunk.fileModifiedAt);

        // Insert vector
        db.prepare(`
          INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)
        `).run(info.lastInsertRowid, embedding);

        chunksCreated++;
      }
    })();
  }

  return { filesProcessed: files.length, chunksCreated };
}
```

### 5.2 Incremental Update

When a vault file changes (Ved write or human edit), re-index only that file.

```typescript
async function reindexFile(filePath: string): Promise<void> {
  // 1. Delete existing chunks for this file
  const oldChunks = db.prepare('SELECT rowid FROM chunks WHERE file_path = ?').all(filePath);
  db.transaction(() => {
    for (const old of oldChunks) {
      db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(old.rowid);
      db.prepare('DELETE FROM chunks WHERE rowid = ?').run(old.rowid);
    }
  })();

  // 2. Read and chunk the updated file
  const file = await vaultManager.readFile(filePath);
  const chunks = chunkFile(file);

  // 3. Embed new chunks
  const texts = chunks.map(c => c.content);
  const embeddings = await embedder.embed(texts);

  // 4. Insert new chunks
  db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];

      const info = db.prepare(`
        INSERT INTO chunks (id, file_path, heading, content, token_count, updated_at, file_modified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(chunk.id, chunk.filePath, chunk.heading, chunk.content, chunk.tokenCount, Date.now(), chunk.fileModifiedAt);

      db.prepare(`
        INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)
      `).run(info.lastInsertRowid, embedding);
    }
  })();

  // 5. Audit
  await audit.log({
    eventType: 'rag_reindex',
    detail: { filePath, chunksCreated: chunks.length },
  });
}
```

### 5.3 Reindex Queue

File changes during a conversation shouldn't block the response. Use a simple async queue:

```typescript
class ReindexQueue {
  private queue: string[] = [];
  private processing = false;

  enqueue(filePath: string): void {
    if (!this.queue.includes(filePath)) {
      this.queue.push(filePath);
    }
    this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const filePath = this.queue.shift()!;
      try {
        await reindexFile(filePath);
      } catch (err) {
        console.error(`Reindex failed for ${filePath}:`, err);
        // Don't retry — will be caught on next full reindex or file change
      }
    }
    this.processing = false;
  }
}
```

---

## 6. Chunking Implementation

```typescript
interface ChunkOptions {
  maxTokens: number;        // max tokens per chunk (default: 1024)
  minTokens: number;        // min tokens — merge if smaller (default: 64)
  frontmatterPrefix: boolean; // prepend compact frontmatter (default: true)
}

function chunkFile(file: VaultFile, opts: ChunkOptions = { maxTokens: 1024, minTokens: 64, frontmatterPrefix: true }): Omit<VaultChunk, 'embedding'>[] {
  const chunks: Omit<VaultChunk, 'embedding'>[] = [];

  // Build frontmatter prefix: "[type: person, tags: colleague, engineer] Bob Friday"
  let prefix = '';
  if (opts.frontmatterPrefix && file.frontmatter) {
    const fm = file.frontmatter;
    const parts: string[] = [];
    if (fm.type) parts.push(`type: ${fm.type}`);
    if (fm.tags && Array.isArray(fm.tags)) parts.push(`tags: ${fm.tags.join(', ')}`);
    prefix = `[${parts.join(', ')}] `;
  }

  // Extract title from first H1
  const titleMatch = file.body.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1] : file.path.split('/').pop()?.replace('.md', '') || '';
  prefix += `${title} | `;

  // Split by H2 headings
  const sections = splitByHeadings(file.body, 2);

  // If no H2 sections, try H3
  if (sections.length <= 1) {
    const h3Sections = splitByHeadings(file.body, 3);
    if (h3Sections.length > 1) {
      return chunkSections(h3Sections, prefix, file, opts);
    }
  }

  // If still one section (no headings), treat whole body as one chunk
  if (sections.length <= 1) {
    const content = `${prefix}${file.body}`;
    const tokens = estimateTokens(content);
    if (tokens > opts.maxTokens) {
      // Split at paragraph boundaries
      return splitAtParagraphs(content, file, opts);
    }
    return [{
      id: generateUlid(),
      filePath: file.path,
      heading: null,
      content,
      tokenCount: tokens,
      fileModifiedAt: file.stats.modified.getTime(),
    }];
  }

  return chunkSections(sections, prefix, file, opts);
}

interface Section {
  heading: string | null;
  body: string;
}

function splitByHeadings(markdown: string, level: number): Section[] {
  const regex = new RegExp(`^${'#'.repeat(level)} (.+)$`, 'gm');
  const sections: Section[] = [];
  let lastIndex = 0;
  let lastHeading: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      sections.push({
        heading: lastHeading,
        body: markdown.slice(lastIndex, match.index).trim(),
      });
    }
    lastHeading = match[1];
    lastIndex = match.index + match[0].length;
  }

  // Last section
  if (lastIndex < markdown.length) {
    sections.push({
      heading: lastHeading,
      body: markdown.slice(lastIndex).trim(),
    });
  }

  return sections.filter(s => s.body.length > 0);
}

function chunkSections(
  sections: Section[],
  prefix: string,
  file: VaultFile,
  opts: ChunkOptions
): Omit<VaultChunk, 'embedding'>[] {
  const chunks: Omit<VaultChunk, 'embedding'>[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let content = `${prefix}${section.heading ? section.heading + ': ' : ''}${section.body}`;
    let tokens = estimateTokens(content);

    // Merge small chunks with next section
    if (tokens < opts.minTokens && i + 1 < sections.length) {
      sections[i + 1].body = `${section.body}\n\n${sections[i + 1].body}`;
      continue;
    }

    // Split large chunks at paragraphs
    if (tokens > opts.maxTokens) {
      const subChunks = splitAtParagraphs(content, file, opts);
      for (const sc of subChunks) {
        sc.heading = section.heading;
      }
      chunks.push(...subChunks);
      continue;
    }

    chunks.push({
      id: generateUlid(),
      filePath: file.path,
      heading: section.heading,
      content,
      tokenCount: tokens,
      fileModifiedAt: file.stats.modified.getTime(),
    });
  }

  return chunks;
}
```

---

## 7. Full Retrieval Flow (ENRICH step)

```typescript
async function enrich(
  message: VedMessage,
  workingMemory: WorkingMemory,
  config: RetrievalConfig
): Promise<string> {
  const query = message.content;

  // 1. Vector search
  const vectorResults = await vectorSearch(query, config.vectorTopK);

  // 2. FTS5 search
  const ftsResults = ftsSearch(query, config.ftsTopK);

  // 3. Graph walk — seed with top files from vector + FTS
  const seedFiles = [
    ...new Set([
      ...vectorResults.slice(0, 3).map(r => r.filePath),
      ...ftsResults.slice(0, 3).map(r => r.filePath),
    ])
  ];
  const graphResults = graphSearch(seedFiles, config.graphMaxDepth, config.graphMaxNodes);

  // 4. Reciprocal Rank Fusion
  const merged = reciprocalRankFusion(vectorResults, ftsResults, graphResults, config.rrfK);

  // 5. Assemble within token budget
  const context = assembleContext(merged, config.maxContextTokens);

  return context;
}
```

---

## 8. Performance Budget

At Ved's target scale (personal vault):

| Metric | Target | Reasoning |
|--------|--------|-----------|
| Vault files | 100-1000 | Personal use, grows ~1-5/day |
| Total chunks | 500-5000 | ~3-5 chunks per file average |
| Embedding call | <500ms | Ollama local, single query embedding |
| Vector KNN (5000 vectors) | <10ms | sqlite-vec brute force is O(n) but n is tiny |
| FTS5 query | <5ms | SQLite FTS5 is very fast at this scale |
| Graph walk (depth 1) | <5ms | In-memory index, BFS |
| Total ENRICH step | <600ms | Embedding is the bottleneck |
| Full re-index (1000 files) | ~30s | 5000 chunks ÷ 32/batch = 156 batches × ~200ms/batch |
| Incremental re-index (1 file) | <500ms | 3-5 chunks, one embed call |

These are comfortable margins. No optimization needed until the vault exceeds ~10K files.

---

## 9. Configuration Defaults

```typescript
const DEFAULT_RAG_CONFIG: RetrievalConfig = {
  vectorTopK: 10,           // retrieve top 10 vector matches
  ftsTopK: 10,              // retrieve top 10 keyword matches
  graphMaxDepth: 1,         // 1 hop from seed nodes
  graphMaxNodes: 5,         // max 5 graph-discovered files
  maxContextTokens: 4096,   // ~1 page of context
  rrfK: 60,                 // standard RRF constant
};

const DEFAULT_CHUNK_CONFIG: ChunkOptions = {
  maxTokens: 1024,          // max chunk size
  minTokens: 64,            // merge if smaller
  frontmatterPrefix: true,  // prepend metadata
};

const DEFAULT_EMBEDDING_CONFIG = {
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:11434',
  batchSize: 32,
  dimensions: 768,
};
```

---

## 10. Failure Modes & Fallbacks

| Failure | Fallback |
|---------|----------|
| Ollama offline | Skip vector search. FTS5 + graph walk still work. Log warning. |
| sqlite-vec not loaded | Skip vector search. FTS5 + graph walk still work. |
| FTS5 query syntax error | Fall back to LIKE query on chunks.content. |
| Vault file corrupt (bad YAML) | Skip file during indexing. Log error. Serve raw content. |
| Token budget exceeded | Truncate last result. Never exceed budget. |
| Graph walk cycle | `visited` set prevents infinite loops (already in algorithm). |
| Embedding dimension mismatch | Full re-index. Log version change. |

---

## 11. What Ved's RAG Does NOT Do (Intentionally)

- **No re-ranker model.** RRF is good enough for <5K chunks. A cross-encoder would be overkill and add latency.
- **No query expansion/rewriting.** The LLM can rephrase if needed, but the first query is usually sufficient.
- **No multi-hop reasoning over RAG.** Graph walk provides neighborhood context, but Ved doesn't do iterative retrieval loops.
- **No streaming embeddings.** Batch at natural boundaries (session end, file change), not per-token.
- **No external vector DB.** SQLite is the only dependency.

All of these could be added later without architectural changes. The retrieval interface is clean.

---

## 12. Integration with Event Loop

From `event-loop.md`, the ENRICH step:

```
RECEIVE → ENRICH → DECIDE → ACT → RECORD → RESPOND → MAINTAIN
              │
              ├── 1. Load working memory (T1)
              ├── 2. RAG retrieval (T2 + T3 + T4) ← THIS DOCUMENT
              └── 3. Assemble system prompt + context
```

The RAG module is called once per message during ENRICH. Results are injected into the system prompt as a "Retrieved Context" section that the LLM can reference.

---

*End of RAG pipeline design. Now: Ved manifesto (README.md).*
