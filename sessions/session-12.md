# Session 12 — BUILD (2 of 2)
**Date:** 2026-03-04 11:16 PST  
**Phase:** BUILD  
**Duration:** ~15 min

## What Was Done

### 1. GitHub Actions CI Pipeline
Created `.github/workflows/ci.yml`:
- Matrix build: Node 20 + Node 22
- Steps: checkout → setup-node → npm ci → build → test
- Separate Docker job: build image → run tests in container
- **Blocker:** `gh` OAuth token lacks `workflow` scope, so the CI file is committed locally but can't push to GitHub yet. Needs Nag to either:
  - Run `gh auth refresh -s workflow` to add the scope, or
  - Push the workflow file manually from a terminal with full access

### 2. npm Publish Preparation
- Added `files` array to `package.json` (only ships `dist/`, `schema.sql`, `openclaw.plugin.json`, `SKILL.md`, `README.md`, `LICENSE`)
- Added `prepublishOnly` script: clean → build → test
- Created `.npmignore` (excludes src/, test/, .github/, Dockerfile, etc.)
- Created `LICENSE` file (MIT)

### 3. Example Configurations
- `examples/basic-config.yaml` — default audit-only setup with inline docs
- `examples/paranoid-config.yaml` — gate-all mode, short TTL, high threshold

### 4. README Polish
- Added CI badge + MIT badge
- Checked off GitHub repo + CI items in MVP checklist
- Added CI to project status

### 5. Docker Validation
```bash
# Full build + test in Docker (92/92 passing)
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c \
  'apt-get update -qq && apt-get install -y -qq python3 make g++ && npm ci && npm run build && npm test -- --run'

# Tagged image
docker build -t witness-dev:s12 .
```

### 6. Git
- Commit `79b836f`: npm publish prep, examples, LICENSE → **pushed to GitHub**
- Commit `f8fad6e`: GitHub Actions workflow → **local only** (needs workflow scope)

## Test Results (Docker, Node 22)
```
✓ test/risk.test.ts (20 tests)
✓ test/plugin.test.ts (40 tests)
✓ test/store.test.ts (32 tests)

Test Files  3 passed (3)
     Tests  92 passed (92)
```

## Blockers
1. **GitHub Actions push needs `workflow` OAuth scope** — `gh auth refresh -s workflow` or manual push

## What's Next (Session 13 — TEST Phase)
- Push CI workflow (if scope fixed)
- Spin up Docker Compose integration tests with mock OpenClaw
- Test failure modes: corrupt DB, concurrent writes, chain verification after crash
- Test gating modes end-to-end (before_tool_call → block → approve → system event)
