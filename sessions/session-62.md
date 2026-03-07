# Session 62 — EventBus + SSE Event Stream

**Date:** 2026-03-07
**Phase:** CYCLE
**Duration:** ~12 min

## What Was Done

### 1. GitHub Push (S61)

Pushed `ved serve` HTTP API server to GitHub (2b5d9f2, 7 files, +1349 lines).

### 2. EventBus (`src/event-bus.ts` — ~100 lines)

Typed publish/subscribe system for real-time event delivery:

- **VedEvent type**: id, timestamp, type, actor, sessionId, detail (parsed), hash
- **subscribe(callback, filter?)**: returns Subscription with unsubscribe()
- **emit(event)**: delivers to all matching subscribers
- **emitFromAudit(entry)**: converts AuditEntry → VedEvent and emits
- **Error isolation**: subscriber errors never crash the bus
- **Filtered subscriptions**: optionally filter by AuditEventType[]
- **clear()**: remove all subscribers (shutdown cleanup)

### 3. AuditLog.onAppend Hook

Added `onAppend` callback to `AuditLog` class — called after every `append()` with the new `AuditEntry`. VedApp wires this to `eventBus.emitFromAudit()` so every audit event automatically streams to SSE clients.

### 4. SSE Endpoint (`GET /api/events`)

Added Server-Sent Events endpoint to VedHttpServer:

- **URL**: `GET /api/events[?types=message_received,llm_call,...]`
- **Headers**: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`
- **Initial comment**: `:ok\n\n` (keeps connection alive through proxies)
- **Event format**: `event: <type>\ndata: <json>\nid: <audit_id>\n\n`
- **Type filtering**: optional `?types=` query param (comma-separated)
- **Keepalive**: `:keepalive\n\n` every 30 seconds
- **Auth**: Bearer token (if configured)
- **CORS**: Same origin policy as REST endpoints
- **Cleanup**: subscriptions cleaned up on client disconnect and server stop
- **Stats**: `/api/stats` now includes `sse.activeConnections` and `sse.busSubscribers`

### 5. Exports

Added `EventBus`, `VedEvent`, `EventSubscriber`, `Subscription` to `src/index.ts` root exports.

## Test Summary

- **20 EventBus tests**: subscribe/emit, filtering, unsubscribe, error isolation, emitFromAudit (JSON + invalid JSON + undefined sessionId), subscriber count, clear, AuditLog integration, edge cases
- **10 SSE HTTP tests**: content type, initial comment, real-time delivery, multiple events in order, type filtering, no-filter-all-events, disconnect cleanup, stats SSE count, server stop cleanup, auth with token
- **30 new tests total. 1278/1278 pass (host + Docker parity). 0 type errors.**

## Architecture Impact

```
AuditLog.append() → onAppend callback → EventBus.emitFromAudit() → SSE subscribers
                                                                  → (future: webhooks)
```

Every audited action in Ved is now streamable in real-time. This enables:
- Live dashboards (web UI can subscribe to all events)
- External monitoring (filter for errors only)
- Webhook delivery (future: EventBus subscriber that POSTs to URLs)
- Integration with other agents/systems

## Files Changed

| File | Change |
|------|--------|
| `src/event-bus.ts` | **NEW** — EventBus pub/sub system |
| `src/event-bus.test.ts` | **NEW** — 20 tests |
| `src/audit/store.ts` | Added `onAppend` callback hook |
| `src/app.ts` | Created EventBus, wired audit→bus |
| `src/http.ts` | Added SSE endpoint + SSE cleanup + stats |
| `src/http.test.ts` | Added 10 SSE tests |
| `src/index.ts` | Added EventBus exports |
