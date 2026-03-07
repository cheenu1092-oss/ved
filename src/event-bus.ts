/**
 * EventBus — typed publish/subscribe for Ved's internal event system.
 *
 * Enables real-time event streaming (SSE) and future webhook delivery.
 * Subscribers receive events as they happen, filtered by event type.
 *
 * Thread-safe by design: synchronous emit, async-friendly subscribers.
 */

import type { AuditEntry, AuditEventType } from './types/index.js';

// ── Types ──

/** An event emitted when an audit entry is appended. */
export interface VedEvent {
  /** Audit entry ID */
  id: string;
  /** Unix ms timestamp */
  timestamp: number;
  /** Event type (audit event type) */
  type: AuditEventType;
  /** Actor who triggered the event */
  actor: string;
  /** Session ID (if applicable) */
  sessionId?: string;
  /** Parsed detail payload */
  detail: Record<string, unknown>;
  /** Hash chain position */
  hash: string;
}

export type EventSubscriber = (event: VedEvent) => void;

export interface Subscription {
  /** Unique subscription ID */
  id: string;
  /** Unsubscribe — removes this listener */
  unsubscribe: () => void;
}

// ── EventBus ──

let nextSubId = 0;

export class EventBus {
  private subscribers: Map<string, { callback: EventSubscriber; filter?: AuditEventType[] }> = new Map();

  /**
   * Subscribe to events. Optionally filter by event types.
   * Returns a Subscription with an unsubscribe() method.
   */
  subscribe(callback: EventSubscriber, filter?: AuditEventType[]): Subscription {
    const id = `sub_${++nextSubId}`;
    this.subscribers.set(id, { callback, filter });
    return {
      id,
      unsubscribe: () => { this.subscribers.delete(id); },
    };
  }

  /**
   * Emit an event to all matching subscribers.
   * Called internally when an audit entry is appended.
   */
  emit(event: VedEvent): void {
    for (const [, sub] of this.subscribers) {
      // If filter is set, only deliver matching event types
      if (sub.filter && sub.filter.length > 0 && !sub.filter.includes(event.type)) {
        continue;
      }
      try {
        sub.callback(event);
      } catch {
        // Subscriber errors never crash the bus
      }
    }
  }

  /**
   * Convert an AuditEntry to a VedEvent and emit it.
   */
  emitFromAudit(entry: AuditEntry): void {
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(entry.detail);
    } catch {
      detail = { raw: entry.detail };
    }

    this.emit({
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.eventType,
      actor: entry.actor,
      sessionId: entry.sessionId,
      detail,
      hash: entry.hash,
    });
  }

  /** Number of active subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Remove all subscribers (used on shutdown). */
  clear(): void {
    this.subscribers.clear();
  }
}
