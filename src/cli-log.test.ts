/**
 * Tests for ved log — structured log viewer CLI.
 * @module cli-log.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseLogLine,
  parseLogFile,
  parseRelativeTime,
  parseTimeInput,
  filterEntries,
  formatEntry,
  computeStats,
  parseFlags,
  resolveLogPath,
  type LogFilter,
} from './cli-log.js';
import type { LogEntry } from './core/log.js';

// ── Test data ──────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: '2026-03-07T18:00:00.000Z',
    level: 'info',
    msg: 'test message',
    ...overrides,
  };
}

function makeLogLine(overrides: Partial<LogEntry> = {}): string {
  return JSON.stringify(makeEntry(overrides));
}

function makeLogContent(entries: Partial<LogEntry>[]): string {
  return entries.map(e => makeLogLine(e)).join('\n') + '\n';
}

// ── parseLogLine ───────────────────────────────────────────────────────

describe('parseLogLine', () => {
  it('parses valid JSON log entry', () => {
    const entry = parseLogLine(makeLogLine());
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('info');
    expect(entry!.msg).toBe('test message');
  });

  it('returns null for empty line', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('   ')).toBeNull();
  });

  it('returns null for non-JSON', () => {
    expect(parseLogLine('not json')).toBeNull();
    expect(parseLogLine('12:00:00 INFO test')).toBeNull();
  });

  it('returns null for incomplete entry (missing fields)', () => {
    expect(parseLogLine('{"ts":"2026-03-07"}')).toBeNull();
    expect(parseLogLine('{"level":"info"}')).toBeNull();
    expect(parseLogLine('{"ts":"x","level":"info"}')).toBeNull();
  });

  it('parses entry with extra fields', () => {
    const entry = parseLogLine(makeLogLine({ module: 'core', sessionId: 's1' }));
    expect(entry).not.toBeNull();
    expect(entry!.module).toBe('core');
    expect(entry!.sessionId).toBe('s1');
  });

  it('trims whitespace before parsing', () => {
    const entry = parseLogLine('  ' + makeLogLine() + '  ');
    expect(entry).not.toBeNull();
  });
});

// ── parseLogFile ───────────────────────────────────────────────────────

describe('parseLogFile', () => {
  it('parses multiple entries', () => {
    const content = makeLogContent([
      { msg: 'first' },
      { msg: 'second' },
      { msg: 'third' },
    ]);
    const entries = parseLogFile(content);
    expect(entries).toHaveLength(3);
    expect(entries[0].msg).toBe('first');
    expect(entries[2].msg).toBe('third');
  });

  it('skips invalid lines', () => {
    const content = makeLogLine({ msg: 'valid' }) + '\nbad line\n' + makeLogLine({ msg: 'also valid' }) + '\n';
    const entries = parseLogFile(content);
    expect(entries).toHaveLength(2);
  });

  it('handles empty content', () => {
    expect(parseLogFile('')).toHaveLength(0);
    expect(parseLogFile('\n\n')).toHaveLength(0);
  });
});

// ── parseRelativeTime ──────────────────────────────────────────────────

describe('parseRelativeTime', () => {
  it('parses seconds', () => {
    const d = parseRelativeTime('30s');
    expect(d).not.toBeNull();
    const diff = Date.now() - d!.getTime();
    expect(diff).toBeGreaterThan(29_000);
    expect(diff).toBeLessThan(32_000);
  });

  it('parses minutes', () => {
    const d = parseRelativeTime('5m');
    expect(d).not.toBeNull();
    const diff = Date.now() - d!.getTime();
    expect(diff).toBeGreaterThan(4 * 60_000);
    expect(diff).toBeLessThan(6 * 60_000);
  });

  it('parses hours', () => {
    const d = parseRelativeTime('2h');
    expect(d).not.toBeNull();
    const diff = Date.now() - d!.getTime();
    expect(diff).toBeGreaterThan(1.9 * 3_600_000);
    expect(diff).toBeLessThan(2.1 * 3_600_000);
  });

  it('parses days', () => {
    const d = parseRelativeTime('7d');
    expect(d).not.toBeNull();
    const diff = Date.now() - d!.getTime();
    expect(diff).toBeGreaterThan(6.9 * 86_400_000);
    expect(diff).toBeLessThan(7.1 * 86_400_000);
  });

  it('parses weeks', () => {
    const d = parseRelativeTime('1w');
    expect(d).not.toBeNull();
    const diff = Date.now() - d!.getTime();
    expect(diff).toBeGreaterThan(6.9 * 86_400_000);
  });

  it('returns null for invalid input', () => {
    expect(parseRelativeTime('abc')).toBeNull();
    expect(parseRelativeTime('10x')).toBeNull();
    expect(parseRelativeTime('')).toBeNull();
  });
});

// ── parseTimeInput ─────────────────────────────────────────────────────

describe('parseTimeInput', () => {
  it('parses relative time', () => {
    expect(parseTimeInput('1h')).not.toBeNull();
  });

  it('parses ISO date', () => {
    const d = parseTimeInput('2026-03-07T18:00:00Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-07T18:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseTimeInput('not-a-date')).toBeNull();
  });
});

// ── filterEntries ──────────────────────────────────────────────────────

describe('filterEntries', () => {
  const entries: LogEntry[] = [
    makeEntry({ ts: '2026-03-07T10:00:00Z', level: 'debug', msg: 'debug msg', module: 'core' }),
    makeEntry({ ts: '2026-03-07T11:00:00Z', level: 'info', msg: 'info msg', module: 'llm' }),
    makeEntry({ ts: '2026-03-07T12:00:00Z', level: 'warn', msg: 'warn msg', module: 'core' }),
    makeEntry({ ts: '2026-03-07T13:00:00Z', level: 'error', msg: 'error msg', module: 'trust' }),
    makeEntry({ ts: '2026-03-07T14:00:00Z', level: 'info', msg: 'another info', module: 'rag' }),
  ];

  const baseFilter: LogFilter = { limit: 0, json: false, noColor: false };

  it('filters by level (minimum)', () => {
    const result = filterEntries(entries, { ...baseFilter, level: 'warn' });
    expect(result).toHaveLength(2);
    expect(result[0].level).toBe('warn');
    expect(result[1].level).toBe('error');
  });

  it('filters by module', () => {
    const result = filterEntries(entries, { ...baseFilter, module: 'core' });
    expect(result).toHaveLength(2);
    expect(result.every(e => e.module === 'core')).toBe(true);
  });

  it('module filter is case-insensitive', () => {
    const result = filterEntries(entries, { ...baseFilter, module: 'CORE' });
    expect(result).toHaveLength(2);
  });

  it('filters by since', () => {
    const result = filterEntries(entries, {
      ...baseFilter,
      since: new Date('2026-03-07T12:00:00Z'),
    });
    expect(result).toHaveLength(3);
    expect(result[0].msg).toBe('warn msg');
  });

  it('filters by until', () => {
    const result = filterEntries(entries, {
      ...baseFilter,
      until: new Date('2026-03-07T11:30:00Z'),
    });
    expect(result).toHaveLength(2);
  });

  it('filters by since AND until', () => {
    const result = filterEntries(entries, {
      ...baseFilter,
      since: new Date('2026-03-07T11:00:00Z'),
      until: new Date('2026-03-07T13:00:00Z'),
    });
    expect(result).toHaveLength(3);
  });

  it('filters by query (message text)', () => {
    const result = filterEntries(entries, { ...baseFilter, query: 'warn' });
    expect(result).toHaveLength(1);
    expect(result[0].msg).toBe('warn msg');
  });

  it('query search is case-insensitive', () => {
    const result = filterEntries(entries, { ...baseFilter, query: 'ERROR' });
    expect(result).toHaveLength(1);
  });

  it('query searches across module name', () => {
    const result = filterEntries(entries, { ...baseFilter, query: 'trust' });
    expect(result).toHaveLength(1);
  });

  it('applies limit (takes last N)', () => {
    const result = filterEntries(entries, { ...baseFilter, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].msg).toBe('error msg');
    expect(result[1].msg).toBe('another info');
  });

  it('combines multiple filters', () => {
    const result = filterEntries(entries, {
      ...baseFilter,
      level: 'info',
      module: 'core',
    });
    // core has debug (filtered out) and warn — only warn passes level>=info + module=core
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe('warn');
  });

  it('returns empty for no matches', () => {
    const result = filterEntries(entries, { ...baseFilter, module: 'nonexistent' });
    expect(result).toHaveLength(0);
  });
});

// ── formatEntry ────────────────────────────────────────────────────────

describe('formatEntry', () => {
  it('formats without color', () => {
    const entry = makeEntry({ module: 'core' });
    const formatted = formatEntry(entry, true);
    expect(formatted).toContain('INFO');
    expect(formatted).toContain('[core]');
    expect(formatted).toContain('test message');
    expect(formatted).not.toContain('\x1b[');
  });

  it('formats with color (contains ANSI codes)', () => {
    const entry = makeEntry({ level: 'error' });
    const formatted = formatEntry(entry, false);
    expect(formatted).toContain('\x1b[');
    expect(formatted).toContain('ERROR');
  });

  it('formats entry without module', () => {
    const entry = makeEntry();
    const formatted = formatEntry(entry, true);
    expect(formatted).not.toContain('[]');
    expect(formatted).toContain('test message');
  });

  it('includes extra fields', () => {
    const entry = makeEntry({ sessionId: 's123', extra: 'data' } as any);
    const formatted = formatEntry(entry, true);
    expect(formatted).toContain('s123');
    expect(formatted).toContain('data');
  });
});

// ── computeStats ───────────────────────────────────────────────────────

describe('computeStats', () => {
  it('computes stats for entries', () => {
    const entries: LogEntry[] = [
      makeEntry({ ts: '2026-03-07T10:00:00Z', level: 'info', module: 'core' }),
      makeEntry({ ts: '2026-03-07T11:00:00Z', level: 'error', module: 'llm' }),
      makeEntry({ ts: '2026-03-07T12:00:00Z', level: 'info', module: 'core' }),
      makeEntry({ ts: '2026-03-07T13:00:00Z', level: 'warn' }),
    ];

    const stats = computeStats(entries, '/tmp/test.log', 2048);
    expect(stats.totalEntries).toBe(4);
    expect(stats.fileSize).toBe(2048);
    expect(stats.errors).toBe(1);
    expect(stats.byLevel.info).toBe(2);
    expect(stats.byLevel.error).toBe(1);
    expect(stats.byLevel.warn).toBe(1);
    expect(stats.byModule.core).toBe(2);
    expect(stats.byModule.llm).toBe(1);
    expect(stats.firstEntry).toBe('2026-03-07T10:00:00Z');
    expect(stats.lastEntry).toBe('2026-03-07T13:00:00Z');
  });

  it('handles empty entries', () => {
    const stats = computeStats([], '/tmp/test.log', 0);
    expect(stats.totalEntries).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.firstEntry).toBeUndefined();
    expect(stats.lastEntry).toBeUndefined();
  });
});

// ── parseFlags ─────────────────────────────────────────────────────────

describe('parseFlags', () => {
  it('returns defaults with no args', () => {
    const { filter, remaining } = parseFlags([]);
    expect(filter.limit).toBe(50);
    expect(filter.json).toBe(false);
    expect(filter.noColor).toBe(false);
    expect(remaining).toHaveLength(0);
  });

  it('parses --level', () => {
    const { filter } = parseFlags(['--level', 'warn']);
    expect(filter.level).toBe('warn');
  });

  it('parses --module', () => {
    const { filter } = parseFlags(['--module', 'core']);
    expect(filter.module).toBe('core');
  });

  it('parses --limit / -n', () => {
    const { filter: f1 } = parseFlags(['--limit', '100']);
    expect(f1.limit).toBe(100);

    const { filter: f2 } = parseFlags(['-n', '25']);
    expect(f2.limit).toBe(25);
  });

  it('parses --json', () => {
    const { filter } = parseFlags(['--json']);
    expect(filter.json).toBe(true);
  });

  it('parses --no-color', () => {
    const { filter } = parseFlags(['--no-color']);
    expect(filter.noColor).toBe(true);
  });

  it('parses --since with relative time', () => {
    const { filter } = parseFlags(['--since', '1h']);
    expect(filter.since).not.toBeUndefined();
  });

  it('parses --until with ISO date', () => {
    const { filter } = parseFlags(['--until', '2026-03-07T18:00:00Z']);
    expect(filter.until).not.toBeUndefined();
    expect(filter.until!.toISOString()).toBe('2026-03-07T18:00:00.000Z');
  });

  it('separates remaining (non-flag) args', () => {
    const { remaining } = parseFlags(['show', '--level', 'info', '--json']);
    expect(remaining).toEqual(['show']);
  });

  it('combines flags with subcommand args', () => {
    const { filter, remaining } = parseFlags(['search', 'my query', '--level', 'error', '-n', '10']);
    expect(remaining).toEqual(['search', 'my query']);
    expect(filter.level).toBe('error');
    expect(filter.limit).toBe(10);
  });
});

// ── Integration: file I/O ──────────────────────────────────────────────

describe('file-based integration', () => {
  const tmpDir = join(tmpdir(), `ved-log-test-${Date.now()}`);
  const logFile = join(tmpDir, 'test.log');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a log file', () => {
    const content = makeLogContent([
      { level: 'info', msg: 'startup', module: 'core' },
      { level: 'debug', msg: 'loading config', module: 'config' },
      { level: 'error', msg: 'connection failed', module: 'llm' },
    ]);
    writeFileSync(logFile, content);

    const entries = parseLogFile(readFileSync(logFile, 'utf-8'));
    expect(entries).toHaveLength(3);
    expect(entries[2].level).toBe('error');
  });

  it('handles large log files', () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(makeLogLine({
        ts: `2026-03-07T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        level: i % 10 === 0 ? 'error' : 'info',
        msg: `message ${i}`,
        module: ['core', 'llm', 'rag', 'trust', 'mcp'][i % 5],
      }));
    }
    writeFileSync(logFile, lines.join('\n') + '\n');

    const entries = parseLogFile(readFileSync(logFile, 'utf-8'));
    expect(entries).toHaveLength(1000);

    // Filter errors only
    const errors = filterEntries(entries, { level: 'error', limit: 0, json: false, noColor: false });
    expect(errors).toHaveLength(100);

    // Filter by module
    const coreEntries = filterEntries(entries, { module: 'core', limit: 0, json: false, noColor: false });
    expect(coreEntries).toHaveLength(200);
  });

  it('handles empty log file', () => {
    writeFileSync(logFile, '');
    const entries = parseLogFile(readFileSync(logFile, 'utf-8'));
    expect(entries).toHaveLength(0);
  });

  it('handles log file with mixed valid/invalid lines', () => {
    const content = [
      makeLogLine({ msg: 'valid1' }),
      'not json at all',
      '{"partial": true}',
      makeLogLine({ msg: 'valid2' }),
      '',
      makeLogLine({ msg: 'valid3' }),
    ].join('\n');
    writeFileSync(logFile, content);

    const entries = parseLogFile(readFileSync(logFile, 'utf-8'));
    expect(entries).toHaveLength(3);
  });

  it('clear truncates the file', () => {
    writeFileSync(logFile, makeLogContent([{ msg: 'a' }, { msg: 'b' }]));
    expect(readFileSync(logFile, 'utf-8').length).toBeGreaterThan(0);

    writeFileSync(logFile, '', 'utf-8'); // simulate clear
    expect(readFileSync(logFile, 'utf-8')).toBe('');
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('filterEntries with limit=0 returns all', () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      makeEntry({ msg: `msg-${i}` })
    );
    const result = filterEntries(entries, { limit: 0, json: false, noColor: false });
    expect(result).toHaveLength(100);
  });

  it('filterEntries with limit=1 returns last entry', () => {
    const entries = [
      makeEntry({ msg: 'first' }),
      makeEntry({ msg: 'second' }),
      makeEntry({ msg: 'last' }),
    ];
    const result = filterEntries(entries, { limit: 1, json: false, noColor: false });
    expect(result).toHaveLength(1);
    expect(result[0].msg).toBe('last');
  });

  it('formatEntry handles all log levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const entry = makeEntry({ level });
      const formatted = formatEntry(entry, true);
      expect(formatted).toContain(level.toUpperCase());
    }
  });

  it('parseLogLine handles entry with nested objects', () => {
    const entry = {
      ts: '2026-03-07T18:00:00Z',
      level: 'info',
      msg: 'test',
      data: { nested: { deep: true } },
    };
    const parsed = parseLogLine(JSON.stringify(entry));
    expect(parsed).not.toBeNull();
    expect((parsed as any).data.nested.deep).toBe(true);
  });

  it('query search matches across entire JSON', () => {
    const entries = [
      makeEntry({ msg: 'hello', module: 'core', sessionId: 'abc123' }),
    ];
    // Searching for sessionId value
    const result = filterEntries(entries, { query: 'abc123', limit: 0, json: false, noColor: false });
    expect(result).toHaveLength(1);
  });
});
