/**
 * RED-TEAM S90: Agent + Replay CLI attack surface testing.
 *
 * Attack categories:
 * 1. Agent name path traversal (8 tests)
 * 2. YAML parser injection (8 tests)
 * 3. Agent import malicious payloads (7 tests)
 * 4. Agent history JSONL injection (5 tests)
 * 5. Editor command injection (4 tests)
 * 6. Replay SQL injection (8 tests)
 * 7. Replay export path traversal (5 tests)
 * 8. Replay hash chain attacks (5 tests)
 * 9. Replay search injection (5 tests)
 * 10. Agent serialization round-trip integrity (6 tests)
 * 11. Replay large dataset DoS (4 tests)
 * 12. Agent template injection (4 tests)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateAgentName,
  AgentProfile,
  AgentRunRecord,
  serializeYaml,
  parseYaml,
  TEMPLATES,
} from './cli-agent.js';
import {
  getSessionEvents,
  getSessionList,
  searchEvents,
  getEventById,
  getEventChain,
  formatDuration,
  truncate,
  extractContent,
  exportToMarkdown,
  exportToJson,
  PIPELINE_STAGES,
  type AuditRow,
  type ReplayDb,
  type ReplayEvent,
} from './cli-replay.js';
import type { AuditEventType } from './types/index.js';

// ── Helpers ──

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ved-rt-s90-'));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeAuditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    event_id: 'evt-001',
    event_type: 'message_received' as AuditEventType,
    actor: 'user',
    session_id: 'sess-001',
    timestamp: '2026-01-01T00:00:00.000Z',
    detail: '{}',
    prev_hash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    ...overrides,
  };
}

function createMockDb(rows: AuditRow[]): ReplayDb {
  return {
    query(sql: string, ...params: unknown[]): AuditRow[] {
      if (sql.includes('session_id = ?')) {
        const sessionId = params[0] as string;
        const limit = (params[1] as number) ?? 1000;
        return rows.filter(r => r.session_id === sessionId).slice(0, limit);
      }
      if (sql.includes('detail LIKE ?')) {
        const pattern = (params[0] as string).slice(1, -1); // strip leading/trailing %
        const limit = (params[1] as number) ?? 50;
        return rows.filter(r => r.detail.includes(pattern)).slice(0, limit);
      }
      if (sql.includes('GROUP BY session_id')) {
        const limit = (params[0] as number) ?? 50;
        const sessions = new Map<string, AuditRow[]>();
        for (const r of rows) {
          if (!r.session_id) continue;
          if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
          sessions.get(r.session_id)!.push(r);
        }
        // Return mock aggregate rows
        const results: any[] = [];
        for (const [sid, evts] of [...sessions.entries()].slice(0, limit)) {
          results.push({
            session_id: sid,
            first_event: evts[0].timestamp,
            last_event: evts[evts.length - 1].timestamp,
            event_count: evts.length,
            message_count: evts.filter(e => e.event_type === 'message_received').length,
            tool_calls: evts.filter(e => e.event_type === 'tool_executed').length,
            llm_calls: evts.filter(e => ['llm_call', 'llm_response'].includes(e.event_type)).length,
            trust_decisions: 0,
            memory_ops: 0,
          });
        }
        return results;
      }
      return rows;
    },
    queryOne(sql: string, ...params: unknown[]): AuditRow | undefined {
      if (sql.includes('event_id = ?')) {
        return rows.find(r => r.event_id === params[0]);
      }
      if (sql.includes('hash = ?')) {
        return rows.find(r => r.hash === params[0]);
      }
      return rows[0];
    },
  };
}

function makeReplayEvent(overrides: Partial<AuditRow & { parsedDetail?: Record<string, unknown> }> = {}): ReplayEvent {
  const row = makeAuditRow(overrides);
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(row.detail || '{}'); } catch { /* */ }
  if (overrides.parsedDetail) detail = overrides.parsedDetail;
  return {
    id: row.id,
    eventId: row.event_id,
    type: row.event_type as AuditEventType,
    actor: row.actor,
    sessionId: row.session_id,
    timestamp: new Date(row.timestamp),
    detail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function writeHistory(dir: string, name: string, records: AgentRunRecord[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, `${name}.jsonl`), content, 'utf8');
}

function loadHistoryDirect(dir: string, name: string, limit = 50): AgentRunRecord[] {
  const p = join(dir, `${name}.jsonl`);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  const records: AgentRunRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try { records.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return records;
}

// ═══════════════════════════════════════════════════════════════
// 1. Agent Name Path Traversal
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Agent name path traversal', () => {
  it('rejects ../../../etc/passwd', () => {
    expect(validateAgentName('../../../etc/passwd')).toBeTruthy();
  });

  it('rejects names with forward slashes', () => {
    expect(validateAgentName('foo/bar')).toBeTruthy();
    expect(validateAgentName('/etc/shadow')).toBeTruthy();
  });

  it('rejects names with backslashes', () => {
    expect(validateAgentName('foo\\bar')).toBeTruthy();
    expect(validateAgentName('..\\..\\windows\\system32')).toBeTruthy();
  });

  it('rejects names with null bytes', () => {
    expect(validateAgentName('agent\x00.yaml')).toBeTruthy();
  });

  it('rejects names starting with dot-dot', () => {
    expect(validateAgentName('..')).toBeTruthy();
    expect(validateAgentName('..hidden')).toBeTruthy();
  });

  it('rejects empty name', () => {
    expect(validateAgentName('')).toBeTruthy();
  });

  it('rejects very long names (>64 chars)', () => {
    expect(validateAgentName('a'.repeat(65))).toBeTruthy();
  });

  it('rejects all reserved names', () => {
    for (const reserved of ['list', 'show', 'create', 'edit', 'delete', 'run', 'help', 'system', 'ved', 'history', 'clone', 'export', 'import', 'default']) {
      expect(validateAgentName(reserved)).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. YAML Parser Injection
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: YAML parser injection', () => {
  it('does not execute constructor prototype pollution', () => {
    const yaml = `name: test\n__proto__: polluted\nconstructor: evil`;
    const parsed = parseYaml(yaml);
    expect(({} as any).polluted).toBeUndefined();
    // __proto__ stored as key, not as prototype chain modification
    expect(parsed['__proto__']).toBeDefined();
  });

  it('handles YAML deserialization attack tags as plain text', () => {
    const yaml = `prompt: |
  You are an agent.
  Inject: !!python/exec 'import os; os.system("rm -rf /")'
  More text here.`;
    const parsed = parseYaml(yaml);
    expect(typeof parsed.prompt).toBe('string');
    expect((parsed.prompt as string)).toContain('!!python/exec');
  });

  it('handles YAML anchors/aliases as plain text', () => {
    const yaml = `name: test\nvalue: !!binary SGVsbG8=\nalias: *anchor`;
    const parsed = parseYaml(yaml);
    expect(parsed.value).toBeDefined();
    // Should not crash or execute anything special
  });

  it('handles extremely long values without crashing', () => {
    const longVal = 'x'.repeat(100_000);
    const yaml = `name: test\nvalue: ${longVal}`;
    const parsed = parseYaml(yaml);
    expect(parsed.value).toBe(longVal);
  });

  it('handles unicode in keys and values', () => {
    const yaml = `name: test\ndescription: 你好世界 🌍`;
    const parsed = parseYaml(yaml);
    expect(parsed.description).toBe('你好世界 🌍');
  });

  it('does not cross-pollute keys via newline injection in quoted values', () => {
    // Attacker embeds a fake key:value inside a quoted string
    const yaml = 'name: innocent\nsystemPrompt: "harmless\\ntrustTier: 4"';
    const parsed = parseYaml(yaml);
    // trustTier should NOT be set from the injected string
    expect(parsed.trustTier).toBeUndefined();
  });

  it('handles empty/null YAML gracefully', () => {
    expect(parseYaml('')).toEqual({});
    expect(parseYaml('# just a comment')).toEqual({});
    expect(parseYaml('\n\n\n')).toEqual({});
  });

  it('serializeYaml handles special characters', () => {
    const obj = {
      name: 'test',
      prompt: 'Hello "world" with #hash and: colons',
      tags: ['tag:1', '"quoted"'],
    };
    const yaml = serializeYaml(obj);
    // Should not throw
    expect(yaml).toContain('name');
    expect(yaml).toContain('tags');
    // Round-trip back
    const parsed = parseYaml(yaml);
    expect(parsed.name).toBe('test');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Agent Import Malicious Payloads
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Agent import malicious payloads', () => {
  it('rejects agents with path traversal names', () => {
    const agents = [
      { name: '../../../etc/cron.d/evil', description: 'backdoor' },
      { name: '..\\windows\\system32\\evil', description: 'backdoor' },
      { name: 'innocent/../../../etc/shadow', description: 'traverse' },
    ];
    for (const agent of agents) {
      expect(validateAgentName(agent.name)).toBeTruthy();
    }
  });

  it('rejects agents with reserved names', () => {
    for (const name of ['system', 'ved', 'default', 'help']) {
      expect(validateAgentName(name)).toBeTruthy();
    }
  });

  it('JSON.parse does not create proto pollution from __proto__', () => {
    const json = '{"name":"safe","__proto__":{"isAdmin":true}}';
    const data = JSON.parse(json);
    expect((data as any).isAdmin).toBeUndefined();
    expect(({} as any).isAdmin).toBeUndefined();
  });

  it('handles extremely large import payloads', () => {
    const agents = Array.from({ length: 1000 }, (_, i) => ({
      name: `agent-${i}`,
      description: `Agent number ${i}`,
    }));
    // Validation works on each
    for (const agent of agents.slice(0, 10)) {
      expect(validateAgentName(agent.name)).toBeNull();
    }
  });

  it('rejects import with non-array agents field', () => {
    const data = { agents: 'not an array' };
    expect(Array.isArray(data.agents)).toBe(false);
  });

  it('extra dangerous fields in agent do not affect validation', () => {
    const agent = {
      name: 'sneaky',
      description: 'innocent',
      __dirname: '/etc',
      _filePath: '/root/.ssh/id_rsa',
    };
    // Name validates fine
    expect(validateAgentName(agent.name)).toBeNull();
    // saveAgent would just serialize extra fields as YAML data (harmless)
  });

  it('agent names with unicode are rejected (not alphanumeric)', () => {
    expect(validateAgentName('агент')).toBeTruthy(); // Cyrillic
    expect(validateAgentName('エージェント')).toBeTruthy(); // Katakana
    expect(validateAgentName('agent™')).toBeTruthy(); // TM symbol
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Agent History JSONL Injection
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Agent history JSONL injection', () => {
  it('JSON.stringify safely encodes newlines in query', () => {
    const record: AgentRunRecord = {
      timestamp: new Date().toISOString(),
      agent: 'test-agent',
      query: 'normal query\n{"injected": true}\nanother injection',
      responseSummary: 'response',
      durationMs: 100,
      toolsUsed: [],
      status: 'success',
    };
    const line = JSON.stringify(record);
    expect(line.split('\n').length).toBe(1); // Single JSONL line
  });

  it('corrupt JSONL lines are skipped on load', () => {
    const histDir = join(tempDir, 'history');
    mkdirSync(histDir, { recursive: true });
    writeFileSync(join(histDir, 'corrupt.jsonl'), [
      '{"timestamp":"2026-01-01","agent":"corrupt","query":"good","responseSummary":"ok","durationMs":10,"toolsUsed":[],"status":"success"}',
      'THIS IS NOT JSON',
      '{"broken json',
      '{"timestamp":"2026-01-02","agent":"corrupt","query":"also good","responseSummary":"ok","durationMs":20,"toolsUsed":[],"status":"success"}',
    ].join('\n'));

    const loaded = loadHistoryDirect(histDir, 'corrupt', 50);
    expect(loaded.length).toBe(2);
    expect(loaded[0].query).toBe('good');
    expect(loaded[1].query).toBe('also good');
  });

  it('empty history file returns empty array', () => {
    const histDir = join(tempDir, 'history');
    mkdirSync(histDir, { recursive: true });
    writeFileSync(join(histDir, 'empty.jsonl'), '');
    const loaded = loadHistoryDirect(histDir, 'empty', 10);
    expect(loaded.length).toBe(0);
  });

  it('respects limit parameter (returns last N entries)', () => {
    const histDir = join(tempDir, 'history');
    mkdirSync(histDir, { recursive: true });
    const records = Array.from({ length: 100 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      agent: 'many',
      query: `query-${i}`,
      responseSummary: 'ok',
      durationMs: 10,
      toolsUsed: [] as string[],
      status: 'success' as const,
    }));
    writeHistory(histDir, 'many', records);
    const loaded = loadHistoryDirect(histDir, 'many', 5);
    expect(loaded.length).toBe(5);
    expect(loaded[0].query).toBe('query-95');
  });

  it('nonexistent history file returns empty array', () => {
    const loaded = loadHistoryDirect(tempDir, 'does-not-exist', 10);
    expect(loaded.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Editor Command Injection
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Editor command injection', () => {
  it('name with semicolons is rejected', () => {
    expect(validateAgentName('test; rm -rf /')).toBeTruthy();
  });

  it('name with backticks is rejected', () => {
    expect(validateAgentName('`whoami`')).toBeTruthy();
  });

  it('name with $() subshell is rejected', () => {
    expect(validateAgentName('$(whoami)')).toBeTruthy();
  });

  it('name with pipe is rejected', () => {
    expect(validateAgentName('agent|cat /etc/passwd')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Replay SQL Injection
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Replay SQL injection', () => {
  it('searchEvents with SQL injection in query', () => {
    const db = createMockDb([
      makeAuditRow({ detail: '{"content":"normal message"}' }),
    ]);
    const results = searchEvents(db, "'; DROP TABLE audit_log; --", 50);
    expect(Array.isArray(results)).toBe(true);
  });

  it('searchEvents with % wildcard injection', () => {
    const db = createMockDb([
      makeAuditRow({ id: 1, detail: '{"content":"secret data"}' }),
      makeAuditRow({ id: 2, detail: '{"content":"public data"}' }),
    ]);
    const results = searchEvents(db, '%', 50);
    expect(Array.isArray(results)).toBe(true);
  });

  it('getSessionEvents with SQL injection session ID', () => {
    const db = createMockDb([
      makeAuditRow({ session_id: 'sess-001' }),
    ]);
    const results = getSessionEvents(db, "' OR '1'='1", 100);
    expect(results.length).toBe(0);
  });

  it('getEventById with crafted event ID', () => {
    const db = createMockDb([makeAuditRow()]);
    const result = getEventById(db, "' UNION SELECT * FROM sqlite_master --");
    expect(result).toBeNull();
  });

  it('getSessionList respects limit', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeAuditRow({ id: i, session_id: `sess-${i}`, event_id: `evt-${i}` })
    );
    const db = createMockDb(rows);
    const sessions = getSessionList(db, 5);
    expect(sessions.length).toBeLessThanOrEqual(5);
  });

  it('handles null session_id in events', () => {
    const db = createMockDb([
      makeAuditRow({ session_id: null }),
      makeAuditRow({ session_id: 'valid-sess' }),
    ]);
    const events = getSessionEvents(db, 'valid-sess', 100);
    expect(events.every(e => e.sessionId === 'valid-sess')).toBe(true);
  });

  it('handles malformed detail JSON in audit rows', () => {
    const db = createMockDb([
      makeAuditRow({ detail: 'NOT JSON AT ALL', session_id: 's1' }),
      makeAuditRow({ detail: '{broken', session_id: 's1' }),
      makeAuditRow({ detail: '', session_id: 's1' }),
      makeAuditRow({ detail: '{"valid":"data"}', session_id: 's1' }),
    ]);
    const events = getSessionEvents(db, 's1', 100);
    for (const event of events) {
      expect(event.detail).toBeDefined();
      expect(typeof event.detail).toBe('object');
    }
  });

  it('handles extremely large detail JSON', () => {
    const bigDetail = JSON.stringify({ content: 'x'.repeat(100_000) });
    const db = createMockDb([
      makeAuditRow({ detail: bigDetail, session_id: 's1' }),
    ]);
    const events = getSessionEvents(db, 's1', 100);
    expect((events[0].detail as any).content).toBe('x'.repeat(100_000));
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Replay Export Integrity
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Replay export integrity', () => {
  it('exportToJson produces valid parseable JSON', () => {
    const events = [makeReplayEvent({ parsedDetail: { content: 'test' } })];
    const json = exportToJson(events, 'test-session');
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe('test-session');
    expect(parsed.events).toHaveLength(1);
  });

  it('exportToMarkdown escapes pipe characters in detail', () => {
    const events = [makeReplayEvent({ parsedDetail: { content: 'value|with|pipes' } })];
    const md = exportToMarkdown(events, 'test-session');
    expect(md).toContain('\\|');
  });

  it('exportToMarkdown includes XSS content as plain text', () => {
    const events = [makeReplayEvent({ parsedDetail: { content: '<script>alert(1)</script>' } })];
    const md = exportToMarkdown(events, 'test-session');
    expect(md).toContain('<script>');
    // Markdown files are text — rendering safety is consumer's job
  });

  it('exportToJson with special chars in session ID', () => {
    const json = exportToJson([], '../../etc/passwd');
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe('../../etc/passwd');
  });

  it('export handles events with empty detail', () => {
    const events = [makeReplayEvent({ parsedDetail: {} })];
    const json = exportToJson(events, 'empty-detail');
    expect(() => JSON.parse(json)).not.toThrow();
    const md = exportToMarkdown(events, 'empty-detail');
    expect(md).toContain('empty-detail');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Replay Hash Chain Attacks
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Replay hash chain attacks', () => {
  it('getEventChain terminates on genesis (all-zero prev_hash)', () => {
    const db = createMockDb([
      makeAuditRow({ event_id: 'evt-001', prev_hash: '0'.repeat(64), hash: 'a'.repeat(64) }),
    ]);
    const chain = getEventChain(db, 'evt-001', 100);
    expect(chain.length).toBe(1);
    expect(chain[0].eventId).toBe('evt-001');
  });

  it('getEventChain respects depth limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeAuditRow({
        id: i + 1,
        event_id: `evt-${i.toString().padStart(3, '0')}`,
        prev_hash: i === 0 ? '0'.repeat(64) : `hash-${(i - 1).toString().padStart(3, '0')}`.padEnd(64, '0'),
        hash: `hash-${i.toString().padStart(3, '0')}`.padEnd(64, '0'),
      })
    );
    const db = createMockDb(rows);
    const chain = getEventChain(db, 'evt-009', 3);
    expect(chain.length).toBeLessThanOrEqual(3);
  });

  it('getEventChain handles circular hash reference', () => {
    const rows = [
      makeAuditRow({ event_id: 'evt-A', prev_hash: 'hash-B'.padEnd(64, '0'), hash: 'hash-A'.padEnd(64, '0') }),
      makeAuditRow({ event_id: 'evt-B', prev_hash: 'hash-A'.padEnd(64, '0'), hash: 'hash-B'.padEnd(64, '0') }),
    ];
    const db = createMockDb(rows);
    const chain = getEventChain(db, 'evt-A', 20);
    expect(chain.length).toBeLessThanOrEqual(20);
  });

  it('getEventChain handles missing prev event', () => {
    const db = createMockDb([
      makeAuditRow({ event_id: 'evt-orphan', prev_hash: 'nonexistent'.padEnd(64, '0'), hash: 'orphan-hash'.padEnd(64, '0') }),
    ]);
    const chain = getEventChain(db, 'evt-orphan', 20);
    expect(chain.length).toBe(1);
  });

  it('getEventChain returns empty for nonexistent event', () => {
    const db = createMockDb([]);
    const chain = getEventChain(db, 'does-not-exist', 20);
    expect(chain.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Replay Search Injection
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Replay search injection', () => {
  it('search with ANSI escape sequences in query', () => {
    const db = createMockDb([makeAuditRow({ detail: '{"content":"normal data"}' })]);
    const results = searchEvents(db, '\x1b[31mred\x1b[0m', 50);
    expect(Array.isArray(results)).toBe(true);
  });

  it('search with regex-like patterns', () => {
    const db = createMockDb([makeAuditRow({ detail: '{"content":"test (value)"}' })]);
    expect(Array.isArray(searchEvents(db, '.*', 50))).toBe(true);
    expect(Array.isArray(searchEvents(db, '[a-z]+', 50))).toBe(true);
    expect(Array.isArray(searchEvents(db, '()()()', 50))).toBe(true);
  });

  it('search with extremely long query', () => {
    const db = createMockDb([makeAuditRow({ detail: '{"content":"short"}' })]);
    const results = searchEvents(db, 'x'.repeat(10_000), 50);
    expect(Array.isArray(results)).toBe(true);
  });

  it('search with null bytes in query', () => {
    const db = createMockDb([makeAuditRow({ detail: '{"content":"data"}' })]);
    const results = searchEvents(db, 'data\x00injection', 50);
    expect(Array.isArray(results)).toBe(true);
  });

  it('extractContent handles all detail field types safely', () => {
    expect(extractContent({ content: 'hello' })).toBe('hello');
    expect(extractContent({ message: 'world' })).toBe('world');
    expect(extractContent({ query: 'search' })).toBe('search');
    expect(extractContent({ tool: 'web_search', params: { q: 'test' } })).toContain('web_search');
    expect(extractContent({ toolName: 'vault_read' })).toBe('vault_read');
    expect(extractContent({ result: 'done' })).toBe('done');
    expect(extractContent({ error: 'failed' })).toBe('failed');
    expect(extractContent({ tier: 3 })).toBe('tier 3');
    expect(extractContent({ entityPath: '/entities/bob.md' })).toBe('/entities/bob.md');
    expect(extractContent({ key: 'working.fact1' })).toBe('working.fact1');
    expect(extractContent({})).toBe('');
    expect(extractContent({ nested: { deep: 'value' } })).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Agent Serialization Round-Trip Integrity
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Agent serialization round-trip', () => {
  it('preserves all scalar fields through serialize/parse', () => {
    const obj: Record<string, unknown> = {
      description: 'Full round-trip test',
      trustTier: 3,
      maxTurns: 15,
      noRag: true,
      timeout: 60,
      model: 'claude-sonnet-4',
    };
    const yaml = serializeYaml(obj);
    const parsed = parseYaml(yaml);
    expect(parsed.description).toBe('Full round-trip test');
    expect(parsed.trustTier).toBe(3);
    expect(parsed.maxTurns).toBe(15);
    expect(parsed.noRag).toBe(true);
    expect(parsed.timeout).toBe(60);
    expect(parsed.model).toBe('claude-sonnet-4');
  });

  it('preserves arrays through round-trip', () => {
    const obj = { tools: ['tool-a', 'tool-b', 'tool-c'], tags: ['alpha', 'beta'] };
    const yaml = serializeYaml(obj);
    const parsed = parseYaml(yaml);
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect((parsed.tools as string[]).length).toBe(3);
    expect(Array.isArray(parsed.tags)).toBe(true);
  });

  it('preserves empty arrays', () => {
    const obj = { tools: [], tags: [] };
    const yaml = serializeYaml(obj);
    const parsed = parseYaml(yaml);
    expect(parsed.tools).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  it('preserves multiline strings via block scalar', () => {
    const obj = { prompt: 'Line 1\nLine 2\nLine 3' };
    const yaml = serializeYaml(obj);
    expect(yaml).toContain('|');
    const parsed = parseYaml(yaml);
    expect((parsed.prompt as string)).toContain('Line 1');
    expect((parsed.prompt as string)).toContain('Line 2');
  });

  it('handles boolean coercion correctly', () => {
    const yaml = 'enabled: true\ndisabled: false\ntext: maybe';
    const parsed = parseYaml(yaml);
    expect(parsed.enabled).toBe(true);
    expect(parsed.disabled).toBe(false);
    expect(parsed.text).toBe('maybe');
  });

  it('handles numeric coercion correctly', () => {
    const yaml = 'integer: 42\nfloat: 3.14\nnegative: -7\ntext: 12abc';
    const parsed = parseYaml(yaml);
    expect(parsed.integer).toBe(42);
    expect(parsed.float).toBe(3.14);
    expect(parsed.negative).toBe(-7);
    expect(parsed.text).toBe('12abc');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. Replay Large Dataset DoS
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Replay large dataset handling', () => {
  it('getSessionEvents respects limit on large datasets', () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      makeAuditRow({ id: i, event_id: `evt-${i}`, session_id: 'big-sess' })
    );
    const db = createMockDb(rows);
    const events = getSessionEvents(db, 'big-sess', 100);
    expect(events.length).toBeLessThanOrEqual(100);
  });

  it('searchEvents limits results', () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      makeAuditRow({ id: i, event_id: `evt-${i}`, detail: '{"content":"match"}' })
    );
    const db = createMockDb(rows);
    const results = searchEvents(db, 'match', 25);
    expect(results.length).toBeLessThanOrEqual(25);
  });

  it('formatDuration handles edge cases', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(Number.MAX_SAFE_INTEGER)).toBeDefined();
  });

  it('truncate handles edge cases', () => {
    expect(truncate('', 10)).toBe('');
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactly10!', 10)).toBe('exactly10!');
    expect(truncate('this is longer than ten', 10)).toBe('this is...');
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. Agent Template Injection
// ═══════════════════════════════════════════════════════════════

describe('RED-TEAM S90: Agent template security', () => {
  it('all built-in templates have safe trustTier', () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      if (name === 'guardian') {
        expect(tpl.trustTier).toBe(4); // Guardian is intentionally T4
      } else {
        expect(tpl.trustTier).toBeLessThanOrEqual(3);
      }
    }
  });

  it('built-in templates have bounded maxTurns', () => {
    for (const [, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl.maxTurns).toBeDefined();
      expect(tpl.maxTurns!).toBeLessThanOrEqual(15);
      expect(tpl.maxTurns!).toBeGreaterThan(0);
    }
  });

  it('non-coder templates do not include shell_exec', () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      if (name !== 'coder') {
        expect(tpl.tools ?? []).not.toContain('shell_exec');
      }
    }
  });

  it('all templates have descriptions', () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl.description).toBeTruthy();
      expect(tpl.description.length).toBeGreaterThan(10);
    }
  });
});
