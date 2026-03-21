# Session 92 — RED-TEAM: Graph + Task CLI

**Date:** 2026-03-21
**Phase:** CYCLE (red-team)
**Focus:** Security testing of `ved graph` and `ved task` CLIs

## Summary

63 red-team tests across 12 attack categories targeting the two newest CLIs. **0 vulnerabilities found.** All existing defenses held. Several findings documented as accepted risk.

## Attack Categories

### 1. Graph DOT Export Path Traversal (7 tests)
- `exportDot()` writes to user-provided `--output` path via raw `writeFileSync` — no vault containment check
- **Accepted risk:** CLI is local-only, user already has filesystem access. Not exposed via HTTP API
- Null byte injection blocked by OS
- Double-quote escaping in node names verified

### 2. Wikilink Regex Injection & ReDoS (6 tests)
- 100K input strings processed in <500ms — no catastrophic backtracking
- Nested brackets, alternating open/close patterns all safe
- Path traversal in wikilink targets: extracted as map keys, not filesystem paths (broken links only)
- Pipe/hash separators correctly stripped

### 3. DOT Graphviz Injection (5 tests)
- Graphviz label injection via filenames neutralized by double-quote escaping
- HTML-like labels, unicode, self-referencing nodes all handled correctly

### 4. Task Title/Slug Injection (7 tests)
- `slugify()` strips all non-alphanumeric characters → path separators, shell metacharacters, null bytes eliminated
- Empty/whitespace-only input produces empty string (caught by validation)
- Truncation at 64 chars enforced
- Slug collision handled by `exists()` check before `createFile()`

### 5. Task Frontmatter Manipulation (6 tests)
- YAML injection in `type:` field: regex extracts single line only
- Prototype pollution keys (`__proto__`, `constructor`): no effect — frontmatter is `Record<string, unknown>`
- 100K-char values don't crash
- Status/priority validation rejects all unknown values

### 6. Task Search Injection (5 tests)
- Search uses `.includes()` — regex special chars are literal
- No SQL involved — all in-memory filtering
- 100K query string completes in <100ms
- Null bytes handled as regular characters

### 7. Task Archive Path Traversal (5 tests)
- Archive path is `tasks/archive/${task.id}.md` — ID from slugified filename
- Vault `createFile`/`deleteFile` have VULN-14 containment checks
- Date validation rejects traversal strings
- Files outside `tasks/` directory never loaded as tasks

### 8. Task ID Matching Ambiguity (5 tests)
- Priority order: exact ID → case-insensitive title → partial match
- **Finding:** Empty query matches everything via `.includes('')` — but CLI checks for empty query before `findTask()`
- **Finding:** Partial match is order-dependent — first found wins. Not a vulnerability, but could confuse users

### 9. Graph buildGraph with Symlinks (4 tests)
- **Finding:** `buildGraph` follows symlinks via `readFileSync` — can read files outside vault
  - Severity: LOW — graph CLI is local-only, user created the symlink, content only used for link extraction
- Symlink loops handled by try/catch in walkDir
- `.git`, `node_modules`, `.obsidian` directories correctly skipped

### 10. Task Date Validation (5 tests)
- **Finding:** JS `Date('2026-02-30')` is valid (wraps to March 2) — impossible dates pass validation
  - Severity: INFORMATIONAL — only used for filtering, not security
- DST transitions handled by `Math.round`
- Far-future and epoch dates don't crash

### 11. Graph Large Input DoS (4 tests)
- 1000 interconnected files: <5s
- 100 files × 100 wikilinks (10K broken links): <5s
- 20 deeply nested directories: handled correctly
- BFS on 500-node disconnected graph: terminates correctly, only visits reachable cluster

### 12. Task Concurrent Operations (4 tests)
- Duplicate slug prevented by `exists()` check
- Archive is create+delete (not atomic) — known trade-off
- Multiple filters AND correctly
- Sort is deterministic with tiebreaking by created date

## Findings Summary

| Finding | Severity | Status |
|---------|----------|--------|
| DOT export has no path containment | LOW | Accepted risk (local CLI) |
| buildGraph follows symlinks outside vault | LOW | Accepted risk (local CLI) |
| Empty query matches all tasks via partial | LOW | Guarded by pre-check |
| Partial match is order-dependent | INFORMATIONAL | By design |
| JS Date allows Feb 30 | INFORMATIONAL | Non-security context |

## Test Results
- **New tests:** 63
- **Host:** 2912/2912 pass
- **Docker:** 2912/2912 pass
- **0 type errors**
- **0 vulnerabilities found** — all defenses held
