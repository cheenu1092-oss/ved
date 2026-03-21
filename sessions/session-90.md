# Session 90 — RED-TEAM: Agent + Replay CLI Attack Surface

**Date:** 2026-03-19
**Phase:** CYCLE (red-team)
**Focus:** Security testing of `ved agent` and `ved replay` CLIs from S89

## Summary

Red-team tested the two newest CLI modules (agent + replay) across 12 attack categories with 69 tests. All existing defenses held — no new vulnerabilities found.

## Attack Categories (12)

### 1. Agent Name Path Traversal (8 tests)
Tested `../../../etc/passwd`, forward/backslashes, null bytes, dot-dot, empty names, overlong names, reserved names. All blocked by `validateAgentName()` regex + explicit checks.

### 2. YAML Parser Injection (8 tests)
Tested `__proto__` pollution, `!!python/exec` deserialization attacks, YAML anchors/aliases, extremely long values (100K chars), unicode, newline injection in quoted strings, empty/comment-only YAML. Our custom mini-parser safely treats everything as plain text — no tag execution, no prototype chain modification.

### 3. Agent Import Malicious Payloads (7 tests)
Tested path traversal in imported agent names, reserved name injection, `__proto__` poisoning via JSON.parse, large import payloads (1000 agents), non-array agents field, extra dangerous fields, unicode agent names. All caught by name validation. JSON.parse doesn't pollute prototypes.

### 4. Agent History JSONL Injection (5 tests)
Tested newlines in query fields, corrupt JSONL lines, empty files, limit parameter, nonexistent files. JSON.stringify safely encodes newlines. Corrupt lines are silently skipped (try/catch). Limit correctly returns last N entries.

### 5. Editor Command Injection (4 tests)
Tested semicolons, backticks, `$()` subshell, pipe characters in agent names. All blocked at name validation — names must be `[a-zA-Z][a-zA-Z0-9_-]*`. The edit command also uses `JSON.stringify()` for path quoting as defense-in-depth.

### 6. Replay SQL Injection (8 tests)
Tested `'; DROP TABLE`, `%` wildcard, `' OR '1'='1`, UNION SELECT, null session_id, malformed detail JSON, extremely large detail (100K chars). All queries use parameterized bindings. Malformed JSON parsed gracefully via try/catch. Large payloads handled.

### 7. Replay Export Integrity (5 tests)
Tested JSON validity, pipe character escaping in markdown tables, XSS content in markdown, special chars in session IDs, empty detail events. Export functions produce valid output. Pipe chars are escaped in markdown tables. XSS content is literal text (consumer's responsibility).

### 8. Replay Hash Chain Attacks (5 tests)
Tested genesis termination (all-zero prev_hash), depth limit enforcement, circular hash references, missing prev events, nonexistent events. Chain walk correctly terminates on genesis, respects depth limit, handles missing links (returns partial chain). Circular references bounded by depth parameter.

### 9. Replay Search Injection (5 tests)
Tested ANSI escape sequences, regex-like patterns, extremely long queries (10K chars), null bytes, all `extractContent()` field types. Search uses LIKE with parameterized binding — all patterns safe. `extractContent()` handles all known detail shapes correctly.

### 10. Agent Serialization Round-Trip (6 tests)
Tested scalar fields, arrays, empty arrays, multiline block scalars, boolean coercion, numeric coercion. Custom YAML serializer/parser correctly preserves all types through round-trip. Block scalar (`|`) used for multiline strings.

### 11. Replay Large Dataset DoS (4 tests)
Tested 5000-event datasets with limits, search limits, `formatDuration` edge cases (0, MAX_SAFE_INTEGER), `truncate` edge cases. All functions respect their limit parameters. No unbounded memory allocation.

### 12. Agent Template Security (4 tests)
Verified all built-in templates: trust tiers bounded (≤T3 except guardian at T4), maxTurns bounded (≤15), no shell_exec in non-coder templates, all templates have meaningful descriptions.

## Vulnerabilities Found: 0

All existing defenses held:
- Name validation regex blocks all path traversal and command injection
- Custom YAML parser avoids deserialization attacks by design (no tag execution)
- Parameterized SQL bindings prevent injection
- JSON.stringify safely encodes control characters
- Depth limits prevent infinite chain walks
- Limit parameters prevent DoS on large datasets

## Findings

**FINDING-1: YAML parser accepts `__proto__` as a plain key** (ACCEPTED RISK)
- The custom parser stores `__proto__` as a regular object property
- This is by design — no prototype chain pollution occurs
- JavaScript's `Object.create(null)` would be safer but unnecessary here since parsed objects are used only for data display

**FINDING-2: Replay search uses LIKE without escaping `%` and `_`** (ACCEPTED RISK)
- A search for literal `%` matches broadly — but this IS a search function
- Real SQLite parameterized binding prevents actual SQL injection
- Broad matching on wildcard chars is acceptable behavior for full-text search

## Test Suite
- **Before:** 2667
- **After:** 2736 (+69 red-team)
- **Host:** 2736/2736 pass
- **Docker:** 2735/2736 (1 pre-existing S87 quiet hours flake)
- **0 type errors**

## Git
- `f88f253` — red-team S90: agent + replay CLI attack surface testing (69 tests)
