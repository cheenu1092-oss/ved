/**
 * Tests for cli-start-tui.ts — Daemon TUI dashboard.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDaemonArgs,
  printDaemonHelp,
  formatAgo,
  formatUptime,
  formatTimestamp,
  formatBytes,
  riskBadge,
  styleEventType,
  formatEvent,
  formatSession,
  formatWorkOrder,
  renderHeader,
  renderFooter,
  renderEventsPanel,
  renderSessionsPanel,
  renderApprovalsPanel,
  renderStatsPanel,
  stripAnsi,
  type DaemonState,
  type DaemonPanel,
  type StatsPanelData,
  type ApprovalsPanelData,
} from './cli-start-tui.js';
import type { VedEvent } from './event-bus.js';
import type { Session } from './core/session.js';
import type { WorkOrder } from './types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<VedEvent> = {}): VedEvent {
  return {
    id: 'evt_01',
    timestamp: Date.now(),
    type: 'message_received',
    actor: 'owner',
    sessionId: 'sess_abcdef12',
    detail: { content: 'Hello world' },
    hash: 'abc123',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_01ABCDEF' as any,
    channel: 'chat' as any,
    channelId: 'test',
    author: 'owner' as any,
    trustTier: 4 as any,
    startedAt: Date.now() - 60000,
    lastActive: Date.now() - 5000,
    status: 'active' as any,
    workingMemory: {
      messageCount: 5,
      messages: [{ role: 'user', content: 'Hello there', timestamp: Date.now() }],
      facts: [],
      tokenCount: 100,
    } as any,
    ...overrides,
  };
}

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo_01ABCDEF' as any,
    sessionId: 'sess_01' as any,
    messageId: 'msg_01' as any,
    tool: 'file_write',
    toolServer: 'ved-fs',
    params: { path: '/tmp/test.txt', content: 'hello' },
    riskLevel: 'medium' as any,
    riskReasons: ['writes to filesystem'],
    trustTier: 2 as any,
    status: 'pending' as any,
    createdAt: Date.now() - 30000,
    expiresAt: Date.now() + 270000,
    ...overrides,
  };
}

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    startTime: Date.now() - 60000,
    eventCount: 10,
    recentEvents: [],
    activePanel: 'events',
    eventFilter: null,
    paused: false,
    lastRefresh: Date.now(),
    ...overrides,
  };
}

// ── parseDaemonArgs ───────────────────────────────────────────────────────────

describe('parseDaemonArgs', () => {
  it('parses empty args', () => {
    const opts = parseDaemonArgs([]);
    expect(opts.simple).toBeUndefined();
    expect(opts.port).toBeUndefined();
  });

  it('parses --simple', () => {
    expect(parseDaemonArgs(['--simple']).simple).toBe(true);
    expect(parseDaemonArgs(['-s']).simple).toBe(true);
    expect(parseDaemonArgs(['--no-tui']).simple).toBe(true);
  });

  it('parses --port', () => {
    expect(parseDaemonArgs(['--port', '3000']).port).toBe(3000);
    expect(parseDaemonArgs(['-p', '8080']).port).toBe(8080);
  });

  it('parses --host', () => {
    expect(parseDaemonArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });

  it('parses --token', () => {
    expect(parseDaemonArgs(['--token', 'secret123']).token).toBe('secret123');
  });

  it('parses --cors', () => {
    expect(parseDaemonArgs(['--cors', 'http://localhost:3000']).cors).toBe('http://localhost:3000');
  });

  it('parses multiple flags', () => {
    const opts = parseDaemonArgs(['--port', '3000', '--token', 'abc', '--cors', '*']);
    expect(opts.port).toBe(3000);
    expect(opts.token).toBe('abc');
    expect(opts.cors).toBe('*');
  });

  it('exits on unknown flag', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      parseDaemonArgs(['--unknown']);
    } catch { /* expected */ }
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('exits on --help', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      parseDaemonArgs(['--help']);
    } catch { /* expected */ }
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
});

// ── Time formatting ───────────────────────────────────────────────────────────

describe('formatAgo', () => {
  it('formats just now', () => {
    expect(formatAgo(500)).toBe('just now');
  });

  it('formats seconds', () => {
    expect(formatAgo(30000)).toBe('30s ago');
  });

  it('formats minutes', () => {
    expect(formatAgo(300000)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(formatAgo(7200000)).toBe('2h ago');
  });

  it('formats days', () => {
    expect(formatAgo(172800000)).toBe('2d ago');
  });
});

describe('formatUptime', () => {
  it('formats minutes and seconds', () => {
    expect(formatUptime(90000)).toBe('1m 30s');
  });

  it('formats hours and minutes', () => {
    expect(formatUptime(3720000)).toBe('1h 2m');
  });

  it('formats zero', () => {
    expect(formatUptime(500)).toBe('0m 0s');
  });
});

describe('formatTimestamp', () => {
  it('formats HH:MM:SS', () => {
    const ts = new Date(2026, 2, 25, 14, 30, 45).getTime();
    expect(formatTimestamp(ts)).toBe('14:30:45');
  });

  it('pads single digits', () => {
    const ts = new Date(2026, 0, 1, 9, 5, 3).getTime();
    expect(formatTimestamp(ts)).toBe('09:05:03');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2.0KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0MB');
  });
});

// ── Badges and styles ─────────────────────────────────────────────────────────

describe('riskBadge', () => {
  it('critical', () => {
    expect(stripAnsi(riskBadge('critical'))).toBe('CRIT');
  });

  it('high', () => {
    expect(stripAnsi(riskBadge('high'))).toBe('HIGH');
  });

  it('medium', () => {
    expect(stripAnsi(riskBadge('medium'))).toBe('MED');
  });

  it('low', () => {
    expect(stripAnsi(riskBadge('low'))).toBe('LOW');
  });

  it('unknown level', () => {
    expect(stripAnsi(riskBadge('custom'))).toBe('custom');
  });
});

describe('styleEventType', () => {
  it('styles message events in cyan', () => {
    const styled = styleEventType('message_received');
    expect(styled).toContain('message_received');
    expect(styled).toContain('\x1B[36m'); // cyan
  });

  it('styles llm events in magenta', () => {
    const styled = styleEventType('llm_call');
    expect(styled).toContain('\x1B[35m'); // magenta
  });

  it('styles tool events in yellow', () => {
    const styled = styleEventType('tool_executed');
    expect(styled).toContain('\x1B[33m'); // yellow
  });

  it('styles memory events in blue', () => {
    const styled = styleEventType('memory_t1_write');
    expect(styled).toContain('\x1B[34m'); // blue
  });

  it('styles error in red', () => {
    const styled = styleEventType('error');
    expect(styled).toContain('\x1B[31m'); // red
  });

  it('styles startup in bold', () => {
    const styled = styleEventType('startup');
    expect(styled).toContain('\x1B[1m'); // bold
  });

  it('dims unknown types', () => {
    const styled = styleEventType('cron_job_executed');
    expect(styled).toContain('\x1B[2m'); // dim
  });
});

// ── stripAnsi ─────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('strips ANSI codes', () => {
    expect(stripAnsi('\x1B[36mhello\x1B[0m')).toBe('hello');
  });

  it('passes plain text through', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles multiple codes', () => {
    expect(stripAnsi('\x1B[1m\x1B[36mtest\x1B[0m')).toBe('test');
  });
});

// ── formatEvent ───────────────────────────────────────────────────────────────

describe('formatEvent', () => {
  it('formats a basic event', () => {
    const event = makeEvent();
    const output = stripAnsi(formatEvent(event, 120));
    expect(output).toContain('message_received');
    expect(output).toContain('sess_abc');
    expect(output).toContain('Hello world');
  });

  it('shows tool name in detail', () => {
    const event = makeEvent({ type: 'tool_executed', detail: { tool: 'file_write', riskLevel: 'medium' } });
    const output = stripAnsi(formatEvent(event, 120));
    expect(output).toContain('file_write');
    expect(output).toContain('[medium]');
  });

  it('shows model in LLM events', () => {
    const event = makeEvent({ type: 'llm_call', detail: { model: 'gpt-4' } });
    const output = stripAnsi(formatEvent(event, 120));
    expect(output).toContain('gpt-4');
  });

  it('handles missing session', () => {
    const event = makeEvent({ sessionId: undefined });
    const output = stripAnsi(formatEvent(event, 120));
    expect(output).toContain('────────');
  });

  it('truncates long details', () => {
    const event = makeEvent({ detail: { content: 'a'.repeat(200) } });
    const output = stripAnsi(formatEvent(event, 80));
    expect(output).toContain('…');
  });
});

// ── formatSession ─────────────────────────────────────────────────────────────

describe('formatSession', () => {
  it('formats active session', () => {
    const session = makeSession();
    const output = stripAnsi(formatSession(session, 120));
    expect(output).toContain('●');
    expect(output).toContain('sess_01ABC');
    expect(output).toContain('5 msgs');
    expect(output).toContain('chat');
  });

  it('formats idle session', () => {
    const session = makeSession({ status: 'idle' as any });
    const output = stripAnsi(formatSession(session, 120));
    expect(output).toContain('○');
  });

  it('shows last message preview', () => {
    const session = makeSession();
    const output = stripAnsi(formatSession(session, 120));
    expect(output).toContain('Hello there');
  });

  it('handles empty messages', () => {
    const session = makeSession({
      workingMemory: { messageCount: 0, messages: [], facts: [], tokenCount: 0 } as any,
    });
    const output = stripAnsi(formatSession(session, 120));
    expect(output).toContain('0 msgs');
  });
});

// ── formatWorkOrder ───────────────────────────────────────────────────────────

describe('formatWorkOrder', () => {
  it('formats pending work order', () => {
    const wo = makeWorkOrder();
    const output = stripAnsi(formatWorkOrder(wo, 120));
    expect(output).toContain('MED');
    expect(output).toContain('wo_01ABCDE');
    expect(output).toContain('file_write');
    expect(output).toContain('sess:sess_01');
  });

  it('shows risk badges for all levels', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      const wo = makeWorkOrder({ riskLevel: level as any });
      const output = stripAnsi(formatWorkOrder(wo, 120));
      expect(output.length).toBeGreaterThan(0);
    }
  });
});

// ── renderHeader ──────────────────────────────────────────────────────────────

describe('renderHeader', () => {
  it('shows Ved Daemon title', () => {
    const state = makeState();
    const header = stripAnsi(renderHeader(state, 120));
    expect(header).toContain('Ved Daemon');
  });

  it('shows RUNNING status', () => {
    const state = makeState({ paused: false });
    const header = stripAnsi(renderHeader(state, 120));
    expect(header).toContain('RUNNING');
  });

  it('shows PAUSED status', () => {
    const state = makeState({ paused: true });
    const header = stripAnsi(renderHeader(state, 120));
    expect(header).toContain('PAUSED');
  });

  it('shows event count', () => {
    const state = makeState({ eventCount: 42 });
    const header = stripAnsi(renderHeader(state, 120));
    expect(header).toContain('42');
  });

  it('highlights active panel', () => {
    const state = makeState({ activePanel: 'sessions' });
    const header = renderHeader(state, 120);
    // Active panel should have reverse video
    expect(header).toContain('\x1B[7m SESSIONS \x1B[0m');
  });

  it('shows all panel tabs', () => {
    const state = makeState();
    const header = stripAnsi(renderHeader(state, 120));
    expect(header).toContain('EVENTS');
    expect(header).toContain('sessions');
    expect(header).toContain('approvals');
    expect(header).toContain('stats');
  });
});

// ── renderFooter ──────────────────────────────────────────────────────────────

describe('renderFooter', () => {
  it('shows filter/pause hints for events panel', () => {
    const state = makeState({ activePanel: 'events' });
    const footer = stripAnsi(renderFooter(state, 120));
    expect(footer).toContain('[f]ilter');
    expect(footer).toContain('[p]ause');
    expect(footer).toContain('[c]lear');
  });

  it('shows approve/deny hints for approvals panel', () => {
    const state = makeState({ activePanel: 'approvals' });
    const footer = stripAnsi(renderFooter(state, 120));
    expect(footer).toContain('[a] approve');
    expect(footer).toContain('[d] deny');
  });

  it('always shows quit and refresh', () => {
    for (const panel of ['events', 'sessions', 'approvals', 'stats'] as DaemonPanel[]) {
      const state = makeState({ activePanel: panel });
      const footer = stripAnsi(renderFooter(state, 120));
      expect(footer).toContain('[q]uit');
      expect(footer).toContain('[r]efresh');
    }
  });
});

// ── renderEventsPanel ─────────────────────────────────────────────────────────

describe('renderEventsPanel', () => {
  it('shows "no events" when empty', () => {
    const state = makeState({ recentEvents: [] });
    const lines = renderEventsPanel(state, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('No events yet');
  });

  it('renders events', () => {
    const events = [makeEvent(), makeEvent({ type: 'llm_call', detail: { model: 'gpt-4' } })];
    const state = makeState({ recentEvents: events });
    const lines = renderEventsPanel(state, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('message_received');
    expect(text).toContain('llm_call');
  });

  it('filters events by type', () => {
    const events = [
      makeEvent({ type: 'message_received' }),
      makeEvent({ type: 'llm_call', detail: {} }),
    ];
    const state = makeState({ recentEvents: events, eventFilter: 'llm' });
    const lines = renderEventsPanel(state, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('llm_call');
    expect(text).not.toContain('message_received');
  });

  it('pads to fill panel rows', () => {
    const state = makeState({ recentEvents: [makeEvent()] });
    const lines = renderEventsPanel(state, 10, 120);
    expect(lines.length).toBe(9); // rows - 1
  });

  it('limits visible events to panel size', () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `evt_${i}`, type: 'message_received' }),
    );
    const state = makeState({ recentEvents: events });
    const lines = renderEventsPanel(state, 10, 120);
    // Should only show last (rows-1) events
    const nonEmpty = lines.filter(l => stripAnsi(l).trim().length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(9);
  });
});

// ── renderSessionsPanel ───────────────────────────────────────────────────────

describe('renderSessionsPanel', () => {
  it('shows "no active sessions" when empty', () => {
    const lines = renderSessionsPanel([], 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('No active sessions');
  });

  it('renders active and idle sessions', () => {
    const sessions = [
      makeSession({ status: 'active' as any }),
      makeSession({ id: 'sess_02ABCDEF' as any, status: 'idle' as any }),
    ];
    const lines = renderSessionsPanel(sessions, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('Active Sessions');
    expect(text).toContain('(1)');
  });

  it('shows counts in header', () => {
    const sessions = [
      makeSession({ status: 'active' as any }),
      makeSession({ id: 'sess_02' as any, status: 'active' as any }),
      makeSession({ id: 'sess_03' as any, status: 'idle' as any }),
    ];
    const lines = renderSessionsPanel(sessions, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('(2)');
    expect(text).toContain('(1)');
  });

  it('pads to fill rows', () => {
    const lines = renderSessionsPanel([], 10, 120);
    expect(lines.length).toBe(10);
  });
});

// ── renderApprovalsPanel ──────────────────────────────────────────────────────

describe('renderApprovalsPanel', () => {
  it('shows "all clear" when empty', () => {
    const data: ApprovalsPanelData = { pending: [] };
    const lines = renderApprovalsPanel(data, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('All clear');
    expect(text).toContain('(0)');
  });

  it('renders pending work orders', () => {
    const data: ApprovalsPanelData = { pending: [makeWorkOrder()] };
    const lines = renderApprovalsPanel(data, 10, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('file_write');
    expect(text).toContain('(1)');
  });

  it('shows "and N more" when overflow', () => {
    const pending = Array.from({ length: 20 }, (_, i) =>
      makeWorkOrder({ id: `wo_${i.toString().padStart(8, '0')}` as any }),
    );
    const data: ApprovalsPanelData = { pending };
    const lines = renderApprovalsPanel(data, 5, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('… and');
    expect(text).toContain('more');
  });

  it('pads to fill rows', () => {
    const data: ApprovalsPanelData = { pending: [] };
    const lines = renderApprovalsPanel(data, 10, 120);
    expect(lines.length).toBe(10);
  });
});

// ── renderStatsPanel ──────────────────────────────────────────────────────────

describe('renderStatsPanel', () => {
  const stats: StatsPanelData = {
    vault: { fileCount: 42, tagCount: 15, gitClean: true },
    rag: { filesIndexed: 40, chunksStored: 200 },
    audit: { chainLength: 1500, chainHead: 'abc123def456' },
    sessions: { active: 3, total: 25 },
    cron: { jobs: 2 },
    eventBusSubscribers: 4,
  };

  it('shows vault stats', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('42 files');
    expect(text).toContain('clean');
    expect(text).toContain('15 tags');
  });

  it('shows RAG stats', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('40 files');
    expect(text).toContain('200 chunks');
  });

  it('shows audit stats', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('1500 entries');
    expect(text).toContain('abc123def456');
  });

  it('shows session stats', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('3 active');
    expect(text).toContain('25 total');
  });

  it('shows dirty vault status', () => {
    const dirtyStats = { ...stats, vault: { ...stats.vault, gitClean: false } };
    const lines = renderStatsPanel(dirtyStats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('dirty');
  });

  it('shows cron job count', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('2 scheduled');
  });

  it('shows EventBus subscribers', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('4 subscribers');
  });

  it('pads to fill rows', () => {
    const lines = renderStatsPanel(stats, 15, 120);
    expect(lines.length).toBe(15);
  });
});

// ── printDaemonHelp ───────────────────────────────────────────────────────────

describe('printDaemonHelp', () => {
  it('prints without throwing', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printDaemonHelp();
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).toContain('ved start');
    expect(output).toContain('--simple');
    expect(output).toContain('Tab');
  });
});

// ── Import verification ───────────────────────────────────────────────────────

import { vi } from 'vitest';

describe('module exports', () => {
  it('exports DaemonDashboard class', async () => {
    const mod = await import('./cli-start-tui.js');
    expect(mod.DaemonDashboard).toBeDefined();
    expect(typeof mod.DaemonDashboard).toBe('function');
  });

  it('exports runDaemonTui function', async () => {
    const mod = await import('./cli-start-tui.js');
    expect(mod.runDaemonTui).toBeDefined();
    expect(typeof mod.runDaemonTui).toBe('function');
  });

  it('exports setupKeyboardHandler', async () => {
    const mod = await import('./cli-start-tui.js');
    expect(mod.setupKeyboardHandler).toBeDefined();
  });
});
