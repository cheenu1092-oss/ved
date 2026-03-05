# Session 14 — TEST (2 of 2)
**Date:** 2026-03-04 13:16 PST
**Phase:** TEST
**Duration:** ~10 minutes

## What Was Done

### 1. Benchmark Test Suite (`test/benchmark.test.ts`) — 17 tests
High-volume performance testing covering:

| Benchmark | Result |
|-----------|--------|
| Insert 10K events | **7,253 events/sec** (chain intact) |
| Insert with 5K existing | **9,369 events/sec** (no degradation) |
| `recent(20)` query | **0.16ms** avg (5K events) |
| `search("exec")` | **0.08ms** avg (5K events) |
| `stats()` | **0.60ms** avg (5K events) |
| Verify 5K chain | **6ms** |
| Verify 10K (tampered) | **13ms** (detects at correct position) |
| Create 1K work orders | **7,398/sec** |
| Resolve 1K work orders | **27,007/sec** |
| Sweep 500 expired | **6ms** |
| Mixed ops (write+read+search+verify) | **12,099 ops/sec** |
| Risk assessment 10K | **1.8M/sec** |
| Hash computation 100K | **1.5M/sec** |
| `recent(1000)` from 5K | **3ms** |
| 100KB params × 100 events | ✅ No OOM |
| DB size: 5K events | **2.7 MB** (~562 bytes/event, linear growth) |
| Read-only/bad-path DB | ✅ Throws correctly |

### 2. E2E Gateway Simulation (`test/e2e-gateway.test.ts`) — 9 tests
Full gateway lifecycle tests:
- **Multi-session:** 3 concurrent sessions, independent work orders, correct system events
- **Single hash chain:** 100 events across 5 sessions, chain intact
- **Gateway restart:** Data preserved across unload→reload cycles
- **Pending work orders survive restart** and can be approved post-restart
- **5 rapid restart cycles:** 100 events, zero data loss
- **Mode transitions:** audit → gate-writes → gate-all across restarts
- **Realistic 30-min coding session:** Read files → search → blocked exec → approve → trust ramp → auto-approve
- **Error output audit:** Failed commands properly recorded with ❌

### 3. Bug Fix
- Read-only DB test was failing in Docker (root ignores chmod 444). Fixed to test non-existent directory instead.

## Docker Commands Used
```bash
# Test run
docker run --rm -v "$(pwd)":/app -w /app node:22-slim sh -c \
  'apt-get update -qq && apt-get install -y -qq python3 make g++ > /dev/null 2>&1 && \
   npm install --ignore-scripts && npm rebuild better-sqlite3 && npx vitest run'

# Image tag
docker build -t witness-dev:s14 .
```

## Test Results
```
Test Files  6 passed (6)
     Tests  159 passed (159)
  Duration  7.10s
```

## Key Findings
1. **Performance is excellent.** 7K+ events/sec insert, sub-millisecond queries, 6ms chain verify on 5K events. For an agent doing 1-5 tool calls/sec, Witness adds <0.15ms overhead.
2. **DB size is reasonable.** ~562 bytes/event = ~500KB for a 1,000-call agent session. A full day of heavy usage (~10K events) = 5.5 MB.
3. **Trust ramp works end-to-end.** After N approvals, exec auto-approves. Rejection resets trust.
4. **Gateway restarts are seamless.** All data survives, chain stays intact, pending work orders persist.

## Git
- Commit: `aead17f` — benchmarks + e2e gateway tests
- Pushed to `github.com/cheenu1092-oss/witness`
- Image tagged: `witness-dev:s14`

## Next Session (15)
**RED-TEAM phase (1 of 2):**
- Try to forge hash chain entries
- Try to bypass gating (call tools without approval)
- Fuzz inputs (malformed tool names, huge params, Unicode edge cases)
- All attacks in isolated Docker containers
- Document findings in `red-team/`
