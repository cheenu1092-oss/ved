/**
 * Tests for EventBus — publish/subscribe event system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, type VedEvent } from './event-bus.js';
import type { AuditEntry } from './types/index.js';

function makeEvent(overrides: Partial<VedEvent> = {}): VedEvent {
  return {
    id: 'evt_001',
    timestamp: Date.now(),
    type: 'message_received',
    actor: 'user1',
    detail: { content: 'hello' },
    hash: 'abc123',
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'aud_001',
    timestamp: Date.now(),
    eventType: 'message_received',
    actor: 'user1',
    sessionId: 'ses_001',
    detail: JSON.stringify({ content: 'hello' }),
    prevHash: '0'.repeat(64),
    hash: 'abc123',
    ...overrides,
  };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ── Subscribe / Emit ──

  it('delivers events to subscribers', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event = makeEvent();
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('delivers to multiple subscribers', () => {
    const a: VedEvent[] = [];
    const b: VedEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit(makeEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('delivers multiple events in order', () => {
    const received: string[] = [];
    bus.subscribe((e) => received.push(e.id));

    bus.emit(makeEvent({ id: 'a' }));
    bus.emit(makeEvent({ id: 'b' }));
    bus.emit(makeEvent({ id: 'c' }));

    expect(received).toEqual(['a', 'b', 'c']);
  });

  // ── Filtering ──

  it('filters events by type', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e), ['llm_call', 'llm_response']);

    bus.emit(makeEvent({ type: 'message_received' }));
    bus.emit(makeEvent({ type: 'llm_call' }));
    bus.emit(makeEvent({ type: 'tool_executed' }));
    bus.emit(makeEvent({ type: 'llm_response' }));

    expect(received).toHaveLength(2);
    expect(received.map(e => e.type)).toEqual(['llm_call', 'llm_response']);
  });

  it('empty filter array delivers all events', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e), []);

    bus.emit(makeEvent({ type: 'message_received' }));
    bus.emit(makeEvent({ type: 'llm_call' }));

    expect(received).toHaveLength(2);
  });

  it('undefined filter delivers all events', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emit(makeEvent({ type: 'startup' }));
    bus.emit(makeEvent({ type: 'shutdown' }));

    expect(received).toHaveLength(2);
  });

  // ── Unsubscribe ──

  it('unsubscribe stops delivery', () => {
    const received: VedEvent[] = [];
    const sub = bus.subscribe((e) => received.push(e));

    bus.emit(makeEvent({ id: 'before' }));
    sub.unsubscribe();
    bus.emit(makeEvent({ id: 'after' }));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('before');
  });

  it('unsubscribe is idempotent', () => {
    const sub = bus.subscribe(() => {});
    sub.unsubscribe();
    sub.unsubscribe(); // should not throw
    expect(bus.subscriberCount).toBe(0);
  });

  it('returns unique subscription IDs', () => {
    const a = bus.subscribe(() => {});
    const b = bus.subscribe(() => {});
    expect(a.id).not.toBe(b.id);
  });

  // ── Error Isolation ──

  it('subscriber errors do not crash the bus', () => {
    const received: VedEvent[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((e) => received.push(e));

    bus.emit(makeEvent());

    expect(received).toHaveLength(1);
  });

  it('subscriber errors do not prevent other subscribers', () => {
    const order: string[] = [];
    bus.subscribe(() => { order.push('a'); throw new Error('a fails'); });
    bus.subscribe(() => { order.push('b'); });
    bus.subscribe(() => { order.push('c'); });

    bus.emit(makeEvent());

    expect(order).toEqual(['a', 'b', 'c']);
  });

  // ── emitFromAudit ──

  it('converts AuditEntry to VedEvent correctly', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const entry = makeAuditEntry({
      id: 'test_id',
      timestamp: 1234567890,
      eventType: 'tool_executed',
      actor: 'ved',
      sessionId: 'ses_123',
      detail: JSON.stringify({ tool: 'calculator', result: 42 }),
      hash: 'hash_abc',
    });

    bus.emitFromAudit(entry);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      id: 'test_id',
      timestamp: 1234567890,
      type: 'tool_executed',
      actor: 'ved',
      sessionId: 'ses_123',
      detail: { tool: 'calculator', result: 42 },
      hash: 'hash_abc',
    });
  });

  it('handles invalid JSON in audit detail gracefully', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emitFromAudit(makeAuditEntry({ detail: 'not-json{' }));

    expect(received).toHaveLength(1);
    expect(received[0].detail).toEqual({ raw: 'not-json{' });
  });

  it('handles undefined sessionId in audit entry', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emitFromAudit(makeAuditEntry({ sessionId: undefined }));

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBeUndefined();
  });

  // ── subscriberCount ──

  it('tracks subscriber count accurately', () => {
    expect(bus.subscriberCount).toBe(0);

    const a = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);

    const b = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);

    a.unsubscribe();
    expect(bus.subscriberCount).toBe(1);

    b.unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });

  // ── clear ──

  it('clear removes all subscribers', () => {
    bus.subscribe(() => {});
    bus.subscribe(() => {});
    bus.subscribe(() => {});

    expect(bus.subscriberCount).toBe(3);
    bus.clear();
    expect(bus.subscriberCount).toBe(0);
  });

  it('clear prevents further event delivery', () => {
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.clear();
    bus.emit(makeEvent());

    expect(received).toHaveLength(0);
  });

  // ── AuditLog.onAppend integration ──

  it('can be wired to AuditLog onAppend callback', () => {
    // Simulate what VedApp does
    const received: VedEvent[] = [];
    bus.subscribe((e) => received.push(e));

    // Simulate audit.onAppend being called
    const onAppend = (entry: AuditEntry) => bus.emitFromAudit(entry);
    onAppend(makeAuditEntry({ eventType: 'startup' }));
    onAppend(makeAuditEntry({ eventType: 'message_received' }));

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('startup');
    expect(received[1].type).toBe('message_received');
  });

  // ── Edge Cases ──

  it('handles emit with no subscribers gracefully', () => {
    // Should not throw
    bus.emit(makeEvent());
    expect(bus.subscriberCount).toBe(0);
  });

  it('subscriber added during emit may receive current event (Map iterator behavior)', () => {
    const received: VedEvent[] = [];
    let secondSub = false;

    bus.subscribe(() => {
      if (!secondSub) {
        secondSub = true;
        bus.subscribe((e) => received.push(e));
      }
    });

    bus.emit(makeEvent({ id: 'first' }));
    bus.emit(makeEvent({ id: 'second' }));

    // Map iterator includes entries added during iteration,
    // so the second subscriber receives both events
    expect(received).toHaveLength(2);
    expect(received[0].id).toBe('first');
    expect(received[1].id).toBe('second');
  });
});
