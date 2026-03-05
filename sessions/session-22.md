# Session 22 — THINK: Obsidian Memory Deep Dive

**Date:** 2026-03-04 21:16 PST  
**Phase:** THINK (2 of 3)  
**Focus:** Obsidian vault structure, wikilinks, YAML schema, git integration, read/write/search interfaces  

## What Happened

Designed Ved's Obsidian-native memory architecture — the core innovation that makes Ved's knowledge graph human-readable, editable, visualizable, and auditable simultaneously.

### Key Design Decisions

1. **6-folder vault structure:** `daily/` (T2 episodic), `entities/` (people/orgs/places), `projects/`, `concepts/`, `decisions/`, `topics/`. Each folder serves a distinct purpose with a different frontmatter schema. Templates in `templates/`.

2. **YAML frontmatter for structured metadata:** Every file has `type`, `created`, `updated`, `source`, `confidence`, `tags`. Entity-specific fields: `aliases`, `trust_tier`, `relation` (people), `status`, `priority`, `owner` (projects), `decided_by`, `context` (decisions).

3. **Wikilinks as graph edges via context, not typed links:** `[[bob-friday]]` links are untyped — the surrounding prose provides relationship context ("Works at [[hpe]]", "Reports to [[bob-friday]]"). This keeps the vault compatible with any Markdown editor, not just Obsidian. Typed relationships go in YAML `related:` field if needed.

4. **VaultManager interface:** Full CRUD + search + graph walk API. `readFile`, `createFile`, `updateFile`, `appendToFile`, `findByTag`, `findByType`, `walkGraph`, `getBacklinks`. Maintains in-memory indices (filename→path map, backlink reverse index, tag index, type index).

5. **Graph walk for context retrieval:** BFS from a starting file, following wikilinks up to `maxDepth` hops, bounded by `maxNodes` and `maxTokens`. Used in ENRICH step to pull related knowledge into the LLM prompt.

6. **Batched git auto-commits (not per-write):** Commits at session boundaries, after entity extraction batches, on shutdown, and every 15 minutes if dirty. Commit messages prefixed with `ved:` for clear attribution. Human edits detected via filesystem watcher and separately committed.

7. **T1→T2 compression via LLM:** A dedicated prompt summarizes working memory into bullet points, extracts facts/entities/decisions, and identifies vault files to create/update. Output is structured and programmatically processed.

8. **File watcher for human edits:** When Obsidian user edits vault files, Ved detects changes, re-parses frontmatter/links, updates indices, logs audit entry with `actor: human`, and queues for RAG re-indexing.

9. **Simple template engine:** Mustache-style `{{variable}}` substitution — ~20 lines of code, no library needed. Templates for person, project, decision, daily note.

10. **Obsidian app config out-of-the-box:** `.obsidian/graph.json` with color-coded folders so the knowledge graph looks great when opened in Obsidian.

### Artifacts Produced

- `docs/obsidian-memory.md` — Full design document (26KB) covering:
  - Vault structure with rationale
  - YAML frontmatter schemas for all entity types
  - Wikilink conventions and graph walk algorithm
  - VaultManager TypeScript interface
  - File change detection and human edit handling
  - T1→T2 compression prompt and processing
  - Git integration strategy (batched commits)
  - Template system
  - Memory tier integration diagram
  - Comparison with existing systems (ChatGPT, OpenClaw, Mem0, Letta)

### What's Different About Ved's Memory

The key insight: Ved's knowledge graph IS the Obsidian vault. Not a separate database that exports to Obsidian — the Markdown files ARE the source of truth. This means:
- Humans can read, edit, and correct Ved's knowledge with any text editor
- Obsidian's graph view visualizes the knowledge graph for free
- Git tracks knowledge evolution over time
- RAG indexes the same files for semantic search
- No import/export, no sync issues, no proprietary formats

## Answers to Session 21 Open Questions

1. **Frontmatter schema:** Defined per entity type with common base fields.
2. **Git integration:** Batched commits, not per-write. `ved:` prefix in commit messages.
3. **T1→T2 compression:** LLM prompt extracts summaries, facts, decisions, entities.
4. **Vault file naming:** Lowercase kebab-case, decisions date-prefixed, dailies date-named.
5. **Offline LLM:** Deferred to Session 23 (RAG pipeline discussion).

## Next Session

**Session 23:** RAG pipeline design + Ved manifesto (README). How do embeddings + FTS5 + graph walk combine? What's the chunking strategy? Write the project README.
