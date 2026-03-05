# Session 23 — RAG Pipeline Design + Ved Manifesto

**Date:** 2026-03-04  
**Phase:** THINK (3 of 3 — final THINK session)  
**Duration:** ~25 min  

---

## What Was Done

### 1. RAG Pipeline Design (`docs/rag-pipeline.md` — 27KB)

Comprehensive design for Ved's retrieval-augmented generation pipeline:

**Embedding Strategy:**
- Model: nomic-embed-text (768-dim, 8192-token context, via Ollama local)
- Chunking: heading-based with frontmatter prefix (respects Markdown structure)
- Max chunk: 1024 tokens, min: 64 tokens, no overlap (headings are natural boundaries)
- Token estimation: simple heuristic (length / 3.5), no tokenizer dependency

**Storage:**
- Everything in SQLite (same DB as audit — one file)
- sqlite-vec extension for vector KNN (brute-force, fine at <5K chunks)
- FTS5 for keyword search with BM25 ranking + porter stemmer
- Triggers keep FTS in sync with chunks table automatically

**Three Retrieval Paths:**
1. Vector search — semantic similarity via embeddings
2. FTS5 search — keyword/exact match with BM25
3. Graph walk — BFS through wikilinks from seed nodes (depth 1, max 5)

**Fusion:**
- Reciprocal Rank Fusion (RRF, k=60) to merge all three ranked lists
- Keyed by filePath (multiple chunks from same file boost the file, not compete)
- Token-budget trimming to fit 4096-token context window

**Indexing:**
- Full re-index: ~30s for 1000 files (batch embed 32 chunks/call)
- Incremental: <500ms per file change (delete old chunks, re-embed)
- Async queue for non-blocking updates during conversation
- Total ENRICH step: <600ms (embedding call is bottleneck)

**Failure modes:** Ollama offline → degrade to FTS5 + graph only. Every failure has a fallback.

**Intentional omissions:** No re-ranker model, no query expansion, no multi-hop reasoning, no external vector DB. All can be added later without architectural changes.

### 2. Ved Manifesto/README (`README.md` — 7KB)

The public-facing README that explains what Ved is and why it exists:

- **Problem statement:** AI assistants have opaque memory, no audit trails, black-box tools, binary trust
- **Core thesis:** Your knowledge graph is an Obsidian vault, every action is hash-chain logged, all tools are MCP servers
- **Architecture overview:** 4-tier memory, single-threaded event loop, 7-step pipeline
- **Trust matrix:** 4 tiers × 4 risk levels, visual table
- **Design constraints:** <10K LoC, single SQLite DB, local-first, no frameworks
- **Module breakdown with target LoC** (9,000 total)
- **Name etymology:** Ved (वेद) from Sanskrit Vedas = "knowledge"
- **Getting started section** (placeholder for when build is ready)

---

## THINK Phase Complete ✅

All three THINK sessions delivered:

| Session | Deliverable | Size |
|---------|-------------|------|
| 21 | `docs/event-loop.md` — Core runtime design | 14.7KB |
| 22 | `docs/obsidian-memory.md` — Memory + vault design | 26KB |
| 23 | `docs/rag-pipeline.md` — RAG pipeline design | 27KB |
| 23 | `README.md` — Ved manifesto | 7KB |

**Total design documentation: ~75KB across 4 files.**

The three docs together fully specify:
- How messages flow through the system (event-loop)
- How knowledge is stored, organized, and connected (obsidian-memory)
- How knowledge is retrieved and injected into prompts (rag-pipeline)

---

## Next: PLAN Phase (Sessions 24-28)

The THINK phase produced high-level designs. PLAN phase turns these into implementation-ready specs:

- **Session 24:** Module interfaces + TypeScript type definitions (all modules)
- **Session 25:** Database schema (complete SQL DDL for SQLite)
- **Session 26:** API specs for MCP tools + LLM client interfaces
- **Session 27:** Vault structure templates + init scripts
- **Session 28:** Docker setup + CI pipeline + test plan

---

## Key Decisions Made

1. **Heading-based chunking** over fixed-size — Markdown structure is semantic, splitting at headings preserves meaning
2. **sqlite-vec brute-force** over ANN index — at <5K chunks, brute-force KNN is <10ms. No complexity needed
3. **RRF fusion** over learned ranking — parameter-free, well-studied, no training data needed
4. **No re-ranker** — overkill at this scale, adds latency, can be bolted on later
5. **Single SQLite DB** for chunks + vectors + FTS + audit — one file to backup, simple deployment
6. **Async reindex queue** — file changes don't block conversation responses
