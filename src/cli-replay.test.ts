/**
 * Tests for `ved replay` — session replay and analysis from audit logs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AuditEventType } from './types/index.js';
import {
  getSessionEvents,
  getSessionList,
  searchEvents,
  getEventById,
  getEventChain,
  formatDuration,
  formatTimestamp,
  formatDate,
  truncate,
  extractContent,
  exportToMarkdown,
  exportToJson,
  PIPELINE_STAGES,
  type AuditRow,
  type ReplayDb,
  type ReplayEvent,
  type SessionSummary,
} from './cli-replay.js';

// ── Mock database ──

function createMockDb(rows: AuditRow[]): ReplayDb {
  return {
    query(sql: string, ...params: unknown[]): AuditRow[] {
      // Simple mock SQL matching
      if (sql.includes('session_id = ?')) {
        const sessionId = params[0] as string;
        const limit = (params[1] as number) ?? 1000;
        return rows
          .filter(r => r.session_id === sessionId)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit);
      }
      if (sql.includes('GROUP BY session_id')) {
        const limit = params[0] as number;
        const sessions = new Map<string, AuditRow[]>();
        for (const row of rows) {
          if (row.session_id) {
            const arr = sessions.get(row.session_id) ?? [];
            arr.push(row);
            sessions.set(row.session_id, arr);
          }
        }
        // Return aggregated rows
        const result: AuditRow[] = [];
        for (const [sid, events] of sessions) {
          const sorted = events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
          let msgCount = 0, toolCalls = 0, llmCalls = 0, trustDecisions = 0, memoryOps = 0;
          for (const e of events) {
            if (e.event_type === 'message_received') msgCount++;
            if (e.event_type === 'tool_executed') toolCalls++;
            if (e.event_type === 'llm_call' || e.event_type === 'llm_response') llmCalls++;
            if (e.event_type === 'tool_approved' || e.event_type === 'tool_denied' || e.event_type === 'work_order_created') trustDecisions++;
            if (e.event_type === 'memory_t1_write' || e.event_type === 'memory_t2_compress' || e.event_type === 'memory_t3_upsert') memoryOps++;
          }
          result.push({
            session_id: sid,
            first_event: sorted[0].timestamp,
            last_event: sorted[sorted.length - 1].timestamp,
            event_count: events.length,
            message_count: msgCount,
            tool_calls: toolCalls,
            llm_calls: llmCalls,
            trust_decisions: trustDecisions,
            memory_ops: memoryOps,
          } as unknown as AuditRow);
        }
        return result.sort((a, b) => {
          const at = new Date((a as unknown as Record<string, string>).last_event).getTime();
          const bt = new Date((b as unknown as Record<string, string>).last_event).getTime();
          return bt - at;
        }).slice(0, limit);
      }
      if (sql.includes('detail LIKE ?')) {
        const pattern = params[0] as string;
        const limit = (params[1] as number) ?? 50;
        const search = pattern.replace(/%/g, '');
        return rows
          .filter(r => r.detail.includes(search))
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
      }
      return [];
    },
    queryOne(sql: string, ...params: unknown[]): AuditRow | undefined {
      if (sql.includes('event_id = ?')) {
        return rows.find(r => r.event_id === params[0]);
      }
      if (sql.includes('hash = ?')) {
        return rows.find(r => r.hash === params[0]);
      }
      return undefined;
    },
  };
}

function makeRow(overrides: Partial<AuditRow> & { id: number; event_type: AuditEventType }): AuditRow {
  return {
    event_id: `evt-${overrides.id}`,
    actor: 'user',
    session_id: 'session-1',
    timestamp: new Date(Date.now() - (1000 - overrides.id) * 1000).toISOString(),
    detail: '{}',
    prev_hash: '0'.repeat(64),
    hash: hashFor(overrides.id),
    ...overrides,
  };
}

function hashFor(id: number): string {
  return `hash${String(id).padStart(4, '0')}${'0'.repeat(60)}`.slice(0, 64);
}

// ── Pipeline event sequences ──

function makeConversation(sessionId = 'session-1'): AuditRow[] {
  const base = Date.now() - 60000;
  return [
    makeRow({ id: 1, event_type: 'session_start', session_id: sessionId, timestamp: new Date(base).toISOString(), detail: '{}' }),
    makeRow({ id: 2, event_type: 'message_received', session_id: sessionId, timestamp: new Date(base + 100).toISOString(), detail: '{"content":"Hello Ved"}', prev_hash: hashFor(1) }),
    makeRow({ id: 3, event_type: 'rag_query', session_id: sessionId, timestamp: new Date(base + 200).toISOString(), detail: '{"query":"Hello Ved","results":2}', prev_hash: hashFor(2) }),
    makeRow({ id: 4, event_type: 'llm_call', session_id: sessionId, timestamp: new Date(base + 300).toISOString(), detail: '{"model":"gpt-4o","tokens":150}', prev_hash: hashFor(3) }),
    makeRow({ id: 5, event_type: 'llm_response', session_id: sessionId, timestamp: new Date(base + 1500).toISOString(), detail: '{"content":"Hi! How can I help?","tokens":25}', prev_hash: hashFor(4) }),
    makeRow({ id: 6, event_type: 'memory_t1_write', session_id: sessionId, timestamp: new Date(base + 1600).toISOString(), detail: '{"key":"user_greeting"}', prev_hash: hashFor(5) }),
    makeRow({ id: 7, event_type: 'message_sent', session_id: sessionId, timestamp: new Date(base + 1700).toISOString(), detail: '{"content":"Hi! How can I help?"}', prev_hash: hashFor(6) }),
  ];
}

function makeToolConversation(sessionId = 'session-2'): AuditRow[] {
  const base = Date.now() - 30000;
  return [
    makeRow({ id: 10, event_type: 'session_start', session_id: sessionId, timestamp: new Date(base).toISOString() }),
    makeRow({ id: 11, event_type: 'message_received', session_id: sessionId, timestamp: new Date(base + 100).toISOString(), detail: '{"content":"Search for Ved"}' }),
    makeRow({ id: 12, event_type: 'llm_call', session_id: sessionId, timestamp: new Date(base + 200).toISOString(), detail: '{"model":"claude-sonnet-4-5-20250514"}' }),
    makeRow({ id: 13, event_type: 'llm_response', session_id: sessionId, timestamp: new Date(base + 800).toISOString(), detail: '{"toolCall":true}' }),
    makeRow({ id: 14, event_type: 'tool_requested', session_id: sessionId, timestamp: new Date(base + 900).toISOString(), detail: '{"toolName":"web_search","params":{"q":"Ved AI agent"}}' }),
    makeRow({ id: 15, event_type: 'tool_approved', session_id: sessionId, timestamp: new Date(base + 1000).toISOString(), detail: '{"toolName":"web_search"}' }),
    makeRow({ id: 16, event_type: 'tool_executed', session_id: sessionId, timestamp: new Date(base + 2000).toISOString(), detail: '{"toolName":"web_search","result":"Found 5 results"}' }),
    makeRow({ id: 17, event_type: 'llm_call', session_id: sessionId, timestamp: new Date(base + 2100).toISOString(), detail: '{"model":"claude-sonnet-4-5-20250514"}' }),
    makeRow({ id: 18, event_type: 'llm_response', session_id: sessionId, timestamp: new Date(base + 3000).toISOString(), detail: '{"content":"Here are the results..."}' }),
    makeRow({ id: 19, event_type: 'memory_t3_upsert', session_id: sessionId, timestamp: new Date(base + 3100).toISOString(), detail: '{"entityPath":"concepts/ved.md"}' }),
    makeRow({ id: 20, event_type: 'message_sent', session_id: sessionId, timestamp: new Date(base + 3200).toISOString(), detail: '{"content":"Here are the results..."}' }),
  ];
}

// ── getSessionEvents ──

describe('getSessionEvents', () => {
  it('returns events for a session in order', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    expect(events).toHaveLength(7);
    expect(events[0].type).toBe('session_start');
    expect(events[1].type).toBe('message_received');
    expect(events[6].type).toBe('message_sent');
  });

  it('respects limit parameter', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1', 3);

    expect(events).toHaveLength(3);
  });

  it('returns empty for unknown session', () => {
    const db = createMockDb(makeConversation());
    const events = getSessionEvents(db, 'unknown-session');
    expect(events).toHaveLength(0);
  });

  it('parses detail JSON correctly', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    expect(events[1].detail.content).toBe('Hello Ved');
    expect(events[3].detail.model).toBe('gpt-4o');
  });

  it('handles malformed detail JSON gracefully', () => {
    const rows = [makeRow({ id: 1, event_type: 'message_received', detail: 'not json' })];
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({});
  });
});

// ── getSessionList ──

describe('getSessionList', () => {
  it('returns session summaries', () => {
    const rows = [...makeConversation(), ...makeToolConversation()];
    const db = createMockDb(rows);
    const sessions = getSessionList(db);

    expect(sessions).toHaveLength(2);
  });

  it('counts event types correctly', () => {
    const rows = makeToolConversation();
    const db = createMockDb(rows);
    const sessions = getSessionList(db);

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.sessionId).toBe('session-2');
    expect(s.messageCount).toBe(1); // message_received
    expect(s.toolCalls).toBe(1); // tool_executed
    expect(s.llmCalls).toBe(4); // 2 llm_call + 2 llm_response
    expect(s.trustDecisions).toBe(1); // tool_approved
    expect(s.memoryOps).toBe(1); // memory_t3_upsert
  });

  it('respects limit', () => {
    const rows = [...makeConversation(), ...makeToolConversation()];
    const db = createMockDb(rows);
    const sessions = getSessionList(db, 1);

    expect(sessions).toHaveLength(1);
  });

  it('returns empty for empty database', () => {
    const db = createMockDb([]);
    const sessions = getSessionList(db);
    expect(sessions).toHaveLength(0);
  });

  it('calculates duration correctly', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const sessions = getSessionList(db);

    const s = sessions[0];
    expect(s.durationMs).toBeGreaterThan(0);
    expect(s.durationMs).toBeLessThan(10000); // our test data spans ~1.7s
  });
});

// ── searchEvents ──

describe('searchEvents', () => {
  it('finds events by content', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const results = searchEvents(db, 'Hello Ved');

    expect(results.length).toBeGreaterThan(0);
    expect(results.some(e => e.detail.content === 'Hello Ved')).toBe(true);
  });

  it('finds events by tool name', () => {
    const rows = makeToolConversation();
    const db = createMockDb(rows);
    const results = searchEvents(db, 'web_search');

    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty for no matches', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const results = searchEvents(db, 'nonexistent_xyz_123');

    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const results = searchEvents(db, 'session', 2);

    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ── getEventById ──

describe('getEventById', () => {
  it('finds event by event_id', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const event = getEventById(db, 'evt-3');

    expect(event).not.toBeNull();
    expect(event!.type).toBe('rag_query');
  });

  it('returns null for unknown event', () => {
    const db = createMockDb(makeConversation());
    const event = getEventById(db, 'nonexistent');
    expect(event).toBeNull();
  });
});

// ── getEventChain ──

describe('getEventChain', () => {
  it('walks backward through hash chain', () => {
    const rows = makeConversation();
    // Fix hash chain links
    for (let i = 1; i < rows.length; i++) {
      rows[i].prev_hash = rows[i - 1].hash;
    }

    const db = createMockDb(rows);
    const chain = getEventChain(db, 'evt-4'); // llm_call

    expect(chain.length).toBeGreaterThan(1);
    expect(chain[chain.length - 1].eventId).toBe('evt-4');
  });

  it('stops at genesis (all-zero prev_hash)', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const chain = getEventChain(db, 'evt-1');

    expect(chain).toHaveLength(1);
    expect(chain[0].eventId).toBe('evt-1');
  });

  it('respects depth limit', () => {
    const rows = makeConversation();
    for (let i = 1; i < rows.length; i++) {
      rows[i].prev_hash = rows[i - 1].hash;
    }

    const db = createMockDb(rows);
    const chain = getEventChain(db, 'evt-7', 2);

    expect(chain.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for unknown event', () => {
    const db = createMockDb(makeConversation());
    const chain = getEventChain(db, 'nonexistent');
    expect(chain).toHaveLength(0);
  });
});

// ── formatDuration ──

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(50)).toBe('50ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('formats minutes', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('formats hours', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(5400000)).toBe('1h 30m');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

// ── formatTimestamp ──

describe('formatTimestamp', () => {
  it('includes milliseconds', () => {
    const d = new Date('2026-03-19T14:30:45.123Z');
    const result = formatTimestamp(d);
    expect(result).toContain('.123');
  });

  it('pads milliseconds', () => {
    const d = new Date('2026-03-19T14:30:45.005Z');
    const result = formatTimestamp(d);
    expect(result).toContain('.005');
  });
});

// ── formatDate ──

describe('formatDate', () => {
  it('formats readable date', () => {
    const d = new Date('2026-03-19T14:30:00Z');
    const result = formatDate(d);
    expect(result).toContain('2026');
    expect(result).toContain('Mar');
  });
});

// ── truncate ──

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings with ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('handles exact length', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

// ── extractContent ──

describe('extractContent', () => {
  it('extracts content field', () => {
    expect(extractContent({ content: 'Hello' })).toBe('Hello');
  });

  it('extracts message field', () => {
    expect(extractContent({ message: 'Hi there' })).toBe('Hi there');
  });

  it('extracts query field', () => {
    expect(extractContent({ query: 'What is Ved?' })).toBe('What is Ved?');
  });

  it('extracts tool + params', () => {
    const result = extractContent({ tool: 'web_search', params: { q: 'test' } });
    expect(result).toContain('web_search');
    expect(result).toContain('test');
  });

  it('extracts toolName', () => {
    expect(extractContent({ toolName: 'file_read' })).toBe('file_read');
  });

  it('extracts result', () => {
    expect(extractContent({ result: 'Found 5 items' })).toBe('Found 5 items');
  });

  it('extracts error', () => {
    expect(extractContent({ error: 'Connection failed' })).toBe('Connection failed');
  });

  it('extracts tier', () => {
    expect(extractContent({ tier: 3 })).toBe('tier 3');
  });

  it('extracts entityPath', () => {
    expect(extractContent({ entityPath: 'entities/person.md' })).toBe('entities/person.md');
  });

  it('extracts key field', () => {
    expect(extractContent({ key: 'user_name' })).toBe('user_name');
  });

  it('falls back to first string value', () => {
    expect(extractContent({ count: 5, name: 'test' })).toBe('test');
  });

  it('returns empty for no extractable content', () => {
    expect(extractContent({ count: 5, nested: { deep: true } })).toBe('');
  });

  it('returns empty for empty object', () => {
    expect(extractContent({})).toBe('');
  });
});

// ── exportToMarkdown ──

describe('exportToMarkdown', () => {
  it('generates valid markdown', () => {
    const events = makeConversation().map((r, i) => ({
      id: r.id,
      eventId: r.event_id,
      type: r.event_type,
      actor: r.actor,
      sessionId: r.session_id,
      timestamp: new Date(r.timestamp),
      detail: JSON.parse(r.detail),
      prevHash: r.prev_hash,
      hash: r.hash,
    } as ReplayEvent));

    const md = exportToMarkdown(events, 'session-1');

    expect(md).toContain('# Session Replay: session-1');
    expect(md).toContain('**Events:** 7');
    expect(md).toContain('| Time | Type | Actor | Detail |');
    expect(md).toContain('session_start');
    expect(md).toContain('message_received');
    expect(md).toContain('message_sent');
  });

  it('escapes pipe characters in detail', () => {
    const events: ReplayEvent[] = [{
      id: 1,
      eventId: 'evt-1',
      type: 'message_received',
      actor: 'user',
      sessionId: 'test',
      timestamp: new Date(),
      detail: { content: 'test | with | pipes' },
      prevHash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    }];

    const md = exportToMarkdown(events, 'test');
    expect(md).not.toContain('| test | with | pipes |');
    expect(md).toContain('test \\| with \\| pipes');
  });
});

// ── exportToJson ──

describe('exportToJson', () => {
  it('generates valid JSON', () => {
    const events: ReplayEvent[] = [{
      id: 1,
      eventId: 'evt-1',
      type: 'message_received',
      actor: 'user',
      sessionId: 'test',
      timestamp: new Date('2026-03-19T14:00:00Z'),
      detail: { content: 'Hello' },
      prevHash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    }];

    const json = exportToJson(events, 'test-session');
    const parsed = JSON.parse(json);

    expect(parsed.sessionId).toBe('test-session');
    expect(parsed.eventCount).toBe(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].eventId).toBe('evt-1');
    expect(parsed.events[0].type).toBe('message_received');
    expect(parsed.events[0].detail.content).toBe('Hello');
  });

  it('includes exportedAt timestamp', () => {
    const json = exportToJson([], 'empty');
    const parsed = JSON.parse(json);
    expect(parsed.exportedAt).toBeTruthy();
    expect(new Date(parsed.exportedAt).getTime()).toBeGreaterThan(0);
  });
});

// ── PIPELINE_STAGES ──

describe('PIPELINE_STAGES', () => {
  it('covers all message flow event types', () => {
    const messageFlowTypes: AuditEventType[] = [
      'message_received', 'rag_query', 'llm_call', 'llm_response',
      'tool_requested', 'tool_approved', 'tool_denied',
      'tool_executed', 'tool_error',
      'memory_t1_write', 'memory_t1_delete', 'memory_t2_compress',
      'memory_t3_upsert', 'memory_t3_delete',
      'message_sent',
    ];

    for (const type of messageFlowTypes) {
      expect(PIPELINE_STAGES[type], `Missing pipeline stage for ${type}`).toBeDefined();
    }
  });

  it('has correct stage numbers for pipeline flow', () => {
    expect(PIPELINE_STAGES['message_received'].stage).toBe(1);
    expect(PIPELINE_STAGES['rag_query'].stage).toBe(2);
    expect(PIPELINE_STAGES['llm_call'].stage).toBe(3);
    expect(PIPELINE_STAGES['llm_response'].stage).toBe(3);
    expect(PIPELINE_STAGES['tool_requested'].stage).toBe(4);
    expect(PIPELINE_STAGES['tool_executed'].stage).toBe(5);
    expect(PIPELINE_STAGES['memory_t1_write'].stage).toBe(6);
    expect(PIPELINE_STAGES['message_sent'].stage).toBe(7);
  });

  it('lifecycle events have stage 0', () => {
    expect(PIPELINE_STAGES['session_start'].stage).toBe(0);
    expect(PIPELINE_STAGES['session_close'].stage).toBe(0);
    expect(PIPELINE_STAGES['session_idle'].stage).toBe(0);
  });

  it('all stages have labels and colors', () => {
    for (const [type, info] of Object.entries(PIPELINE_STAGES)) {
      expect(info.label, `${type} missing label`).toBeTruthy();
      expect(info.color, `${type} missing color`).toBeTruthy();
      expect(typeof info.stage, `${type} stage should be number`).toBe('number');
    }
  });
});

// ── Session event ordering and isolation ──

describe('session isolation', () => {
  it('does not mix events from different sessions', () => {
    const rows = [...makeConversation(), ...makeToolConversation()];
    const db = createMockDb(rows);

    const s1Events = getSessionEvents(db, 'session-1');
    const s2Events = getSessionEvents(db, 'session-2');

    expect(s1Events.every(e => e.sessionId === 'session-1')).toBe(true);
    expect(s2Events.every(e => e.sessionId === 'session-2')).toBe(true);
  });

  it('events are in chronological order', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp.getTime()).toBeGreaterThanOrEqual(events[i - 1].timestamp.getTime());
    }
  });
});

// ── Full pipeline replay ──

describe('full pipeline replay', () => {
  it('captures complete 7-step message flow', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    const types = events.map(e => e.type);
    expect(types).toContain('message_received');
    expect(types).toContain('rag_query');
    expect(types).toContain('llm_call');
    expect(types).toContain('llm_response');
    expect(types).toContain('memory_t1_write');
    expect(types).toContain('message_sent');
  });

  it('captures tool execution flow', () => {
    const rows = makeToolConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-2');

    const types = events.map(e => e.type);
    expect(types).toContain('tool_requested');
    expect(types).toContain('tool_approved');
    expect(types).toContain('tool_executed');
  });

  it('captures agentic loop (multiple LLM calls)', () => {
    const rows = makeToolConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-2');

    const llmCalls = events.filter(e => e.type === 'llm_call');
    expect(llmCalls.length).toBe(2); // Before and after tool use
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('handles session with single event', () => {
    const rows = [makeRow({ id: 1, event_type: 'session_start' })];
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    expect(events).toHaveLength(1);
  });

  it('handles events with empty detail', () => {
    const rows = [makeRow({ id: 1, event_type: 'session_start', detail: '{}' })];
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    expect(events[0].detail).toEqual({});
  });

  it('handles events with null session_id', () => {
    const rows = [makeRow({ id: 1, event_type: 'startup', session_id: null })];
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    // Should not include null session events when querying specific session
    expect(events).toHaveLength(0);
  });

  it('preserves hash chain data', () => {
    const rows = makeConversation();
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'session-1');

    for (const event of events) {
      expect(event.hash).toBeTruthy();
      expect(event.hash.length).toBe(64);
      expect(event.prevHash).toBeTruthy();
    }
  });

  it('extractContent handles very long content', () => {
    const longContent = 'x'.repeat(500);
    const detail = { content: longContent };
    expect(extractContent(detail)).toBe(longContent);
    // truncate should handle it
    expect(truncate(extractContent(detail), 100).length).toBe(100);
  });

  it('search across multiple sessions', () => {
    const rows = [...makeConversation(), ...makeToolConversation()];
    const db = createMockDb(rows);

    // Search for something in tool conversation
    const results = searchEvents(db, 'web_search');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(e => e.sessionId === 'session-2')).toBe(true);
  });

  it('export empty session', () => {
    const md = exportToMarkdown([], 'empty-session');
    expect(md).toContain('# Session Replay: empty-session');
    expect(md).toContain('**Events:** 0');

    const json = exportToJson([], 'empty-session');
    const parsed = JSON.parse(json);
    expect(parsed.eventCount).toBe(0);
    expect(parsed.events).toHaveLength(0);
  });
});
