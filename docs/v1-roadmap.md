# Ved v1.0.0 Roadmap

## What v1.0.0 Means

v1.0.0 signals: **Ved is ready for real users.** The API surface is stable, breaking changes will follow semver, and the core experience (install → configure → chat → remember → verify) is polished end-to-end.

## Status: What's Already Done

| Area | Status | Notes |
|------|--------|-------|
| Core Pipeline | ✅ | 7-step event loop, fully tested with real LLMs |
| Memory (T1-T4) | ✅ | Working → Episodic → Semantic → Archival, compression fires |
| Trust Engine | ✅ | 4 tiers, work orders, approval queues |
| MCP Tools | ✅ | Stdio server support, tool calling verified with real LLMs |
| CLI (46 commands) | ✅ | Full coverage, help system, shell completions |
| Audit Trail | ✅ | Hash-chain, HMAC anchoring, tamper detection |
| Web Dashboard | ✅ | 6 panels, SSE live updates, knowledge graph viz |
| HTTP API | ✅ | REST + SSE, webhook delivery, bearer auth |
| Security | ✅ | 21 vulns found+fixed, 500+ red-team tests, 0 open issues |
| npm Package | ✅ | 592KB, verified install flow, awaiting publish |
| Docs (Getting Started) | ✅ | Install → config → first chat → memory → audit |
| Live Tests | ✅ | Ollama (qwen3), OpenAI (gpt-4o-mini), MCP tool calling |
| Test Suite | ✅ | 3,586 tests, 88 test files, 0 failures |

## What's Needed for v1.0.0

### Must-Have (Blockers)

#### 1. npm Publish ⬜
- `npm login` with cheenu1092-oss account (needs human)
- `npm publish --access public`
- Verify `npx ved-ai init` on fresh machine
- **Blocker: needs interactive npm auth**

#### 2. API Reference Doc ⬜
- Every CLI command with full usage, flags, examples
- HTTP API endpoint reference (request/response shapes)
- SSE event types catalog
- Config YAML schema reference

#### 3. Architecture Overview Doc ⬜
- Simplified visual architecture for README
- Module dependency graph
- Data flow diagrams (message pipeline, memory compression, trust evaluation)
- For contributors and curious users

### Nice-to-Have (v1.0.0 polish)

#### 4. README Refresh for Launch ⬜
- Animated terminal GIF/screenshot (or ASCII demo)
- Comparison table vs. other AI agents
- "5 things Ved does differently" section
- Testimonial-ready (even if self-authored for now)

#### 5. Config Schema Validation ⬜
- JSON Schema for config.yaml
- IDE autocomplete support (schemastore.org registration)
- `ved config validate` already exists — just needs the formal schema

#### 6. Changelog Polish ⬜
- v1.0.0 changelog entry (cumulative highlights)
- Categorized: Core, CLI, Security, DX, Docs

### Post-v1.0.0 (v1.1+)

- **Plugin system** — user-installable MCP tool bundles
- **Multi-LLM routing** — different models for different tasks
- **Docs site** — GitHub Pages or Starlight (Astro)
- **VS Code extension** — memory browser + audit viewer
- **Mobile companion** — PWA for approvals on the go
- **Team mode** — multi-user vault with per-user trust

## v1.0.0 Release Checklist

```
[ ] npm publish succeeds
[ ] npx ved-ai init works on fresh machine (macOS + Linux)
[ ] docs/api-reference.md complete
[ ] docs/architecture.md complete
[ ] README updated with launch content
[ ] CHANGELOG v1.0.0 entry written
[ ] GitHub release created
[ ] Package size < 600KB
[ ] 0 test failures
[ ] 0 TypeScript errors
```

## Timeline

| Session | Task |
|---------|------|
| 109 | v1.0.0 planning + API reference doc |
| 110 | Architecture doc + README refresh |
| 111 | npm publish (if auth ready) + config schema |
| 112 | Final polish + v1.0.0 release |
