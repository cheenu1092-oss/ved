/**
 * `ved replay` — Session replay and analysis from audit logs.
 *
 * Reconstructs full conversation flow from audit events: messages, LLM calls,
 * tool execution, trust decisions, memory operations, and timing. Visualizes
 * the 7-step pipeline stages with color-coded output.
 *
 * Subcommands:
 *   list                     List sessions with activity
 *   show <sessionId>         Replay a session's full conversation flow
 *   trace <eventId>          Trace a single event's causal chain
 *   timeline <sessionId>     Show timing waterfall for a session
 *   stats <sessionId>        Session statistics (event counts, timing, tools)
 *   compare <s1> <s2>        Compare two sessions side-by-side
 *   export <sessionId>       Export session replay to JSON/markdown
 *   search <query>           Search across session replays
 *
 * Aliases: ved replays, ved trace, ved playback
 *
 * @module cli-replay
 */

import { writeFileSync } from 'node:fs';
import type { AuditEventType } from './types/index.js';

// ── ANSI colors ──

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  cyan: '\x1B[36m',
  red: '\x1B[31m',
  magenta: '\x1B[35m',
  blue: '\x1B[34m',
  white: '\x1B[37m',
  bgRed: '\x1B[41m',
  bgGreen: '\x1B[42m',
  bgYellow: '\x1B[43m',
  bgBlue: '\x1B[44m',
  bgMagenta: '\x1B[45m',
  bgCyan: '\x1B[46m',
};

// ── Types ──

export interface AuditRow {
  id: number;
  event_id: string;
  event_type: AuditEventType;
  actor: string;
  session_id: string | null;
  timestamp: string;
  detail: string; // JSON string
  prev_hash: string;
  hash: string;
}

export interface ReplayEvent {
  id: number;
  eventId: string;
  type: AuditEventType;
  actor: string;
  sessionId: string | null;
  timestamp: Date;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface SessionSummary {
  sessionId: string;
  firstEvent: Date;
  lastEvent: Date;
  eventCount: number;
  messageCount: number;
  toolCalls: number;
  llmCalls: number;
  trustDecisions: number;
  memoryOps: number;
  durationMs: number;
}

// ── Pipeline stage classification ──

const PIPELINE_STAGES: Record<string, { stage: number; label: string; color: string }> = {
  'message_received':    { stage: 1, label: 'RECEIVE',  color: C.cyan },
  'rag_query':           { stage: 2, label: 'RAG',      color: C.blue },
  'llm_call':            { stage: 3, label: 'LLM→',     color: C.magenta },
  'llm_response':        { stage: 3, label: 'LLM←',     color: C.magenta },
  'tool_requested':      { stage: 4, label: 'TOOL-REQ', color: C.yellow },
  'work_order_created':  { stage: 4, label: 'WORK-ORD', color: C.yellow },
  'tool_approved':       { stage: 5, label: 'APPROVE',  color: C.green },
  'tool_denied':         { stage: 5, label: 'DENY',     color: C.red },
  'work_order_resolved': { stage: 5, label: 'RESOLVE',  color: C.green },
  'tool_executed':       { stage: 5, label: 'EXEC',     color: C.green },
  'tool_error':          { stage: 5, label: 'EXEC-ERR', color: C.red },
  'memory_t1_write':     { stage: 6, label: 'MEM-T1',   color: C.blue },
  'memory_t1_delete':    { stage: 6, label: 'MEM-T1⌫',  color: C.blue },
  'memory_t2_compress':  { stage: 6, label: 'MEM-T2',   color: C.blue },
  'memory_t3_upsert':    { stage: 6, label: 'MEM-T3',   color: C.blue },
  'memory_t3_delete':    { stage: 6, label: 'MEM-T3⌫',  color: C.blue },
  'message_sent':        { stage: 7, label: 'RESPOND',  color: C.cyan },
  'session_start':       { stage: 0, label: 'START',    color: C.green },
  'session_close':       { stage: 0, label: 'CLOSE',    color: C.red },
  'session_idle':        { stage: 0, label: 'IDLE',     color: C.dim },
  'trust_change':        { stage: 0, label: 'TRUST',    color: C.yellow },
  'rag_reindex':         { stage: 0, label: 'REINDEX',  color: C.dim },
};

// ── Database interface ──

export interface ReplayDb {
  query(sql: string, ...params: unknown[]): AuditRow[];
  queryOne(sql: string, ...params: unknown[]): AuditRow | undefined;
}

function parseRow(row: AuditRow): ReplayEvent {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(row.detail || '{}');
  } catch { /* empty */ }
  return {
    id: row.id,
    eventId: row.event_id,
    type: row.event_type,
    actor: row.actor,
    sessionId: row.session_id,
    timestamp: new Date(row.timestamp),
    detail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

// ── Query helpers ──

export function getSessionEvents(db: ReplayDb, sessionId: string, limit = 1000): ReplayEvent[] {
  const rows = db.query(
    'SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC LIMIT ?',
    sessionId, limit
  );
  return rows.map(parseRow);
}

export function getSessionList(db: ReplayDb, limit = 50): SessionSummary[] {
  const rows = db.query(`
    SELECT
      session_id,
      MIN(timestamp) as first_event,
      MAX(timestamp) as last_event,
      COUNT(*) as event_count,
      SUM(CASE WHEN event_type = 'message_received' THEN 1 ELSE 0 END) as message_count,
      SUM(CASE WHEN event_type = 'tool_executed' THEN 1 ELSE 0 END) as tool_calls,
      SUM(CASE WHEN event_type IN ('llm_call', 'llm_response') THEN 1 ELSE 0 END) as llm_calls,
      SUM(CASE WHEN event_type IN ('tool_approved', 'tool_denied', 'work_order_created') THEN 1 ELSE 0 END) as trust_decisions,
      SUM(CASE WHEN event_type IN ('memory_t1_write', 'memory_t2_compress', 'memory_t3_upsert') THEN 1 ELSE 0 END) as memory_ops
    FROM audit_log
    WHERE session_id IS NOT NULL AND session_id != ''
    GROUP BY session_id
    ORDER BY MAX(timestamp) DESC
    LIMIT ?
  `, limit);

  return rows.map(row => {
    const r = row as unknown as Record<string, unknown>;
    const first = new Date(r.first_event as string);
    const last = new Date(r.last_event as string);
    return {
      sessionId: r.session_id as string,
      firstEvent: first,
      lastEvent: last,
      eventCount: r.event_count as number,
      messageCount: r.message_count as number,
      toolCalls: r.tool_calls as number,
      llmCalls: r.llm_calls as number,
      trustDecisions: r.trust_decisions as number,
      memoryOps: r.memory_ops as number,
      durationMs: last.getTime() - first.getTime(),
    };
  });
}

export function searchEvents(db: ReplayDb, query: string, limit = 50): ReplayEvent[] {
  const rows = db.query(
    `SELECT * FROM audit_log WHERE detail LIKE ? ORDER BY id DESC LIMIT ?`,
    `%${query}%`, limit
  );
  return rows.map(parseRow);
}

export function getEventById(db: ReplayDb, eventId: string): ReplayEvent | null {
  const row = db.queryOne(
    'SELECT * FROM audit_log WHERE event_id = ?',
    eventId
  );
  return row ? parseRow(row) : null;
}

export function getEventChain(db: ReplayDb, eventId: string, depth = 20): ReplayEvent[] {
  // Walk backward through the hash chain
  const chain: ReplayEvent[] = [];
  let current = getEventById(db, eventId);
  let remaining = depth;

  while (current && remaining > 0) {
    chain.unshift(current);
    if (!current.prevHash || current.prevHash === '0'.repeat(64)) break;

    const prev = db.queryOne(
      'SELECT * FROM audit_log WHERE hash = ?',
      current.prevHash
    );
    current = prev ? parseRow(prev) : null;
    remaining--;
  }

  return chain;
}

// ── Formatting helpers ──

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatTimestamp(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + d.getMilliseconds().toString().padStart(3, '0');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function relativeTime(d: Date): string {
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function stageIcon(type: AuditEventType): string {
  const info = PIPELINE_STAGES[type];
  if (!info) return `${C.dim}[?]${C.reset}`;
  return `${info.color}[${info.label}]${C.reset}`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

function extractContent(detail: Record<string, unknown>): string {
  // Try common fields for a readable summary
  if (detail.content && typeof detail.content === 'string') return detail.content;
  if (detail.message && typeof detail.message === 'string') return detail.message;
  if (detail.query && typeof detail.query === 'string') return detail.query;
  if (detail.tool && typeof detail.tool === 'string') {
    const params = detail.params ? ` ${JSON.stringify(detail.params)}` : '';
    return `${detail.tool}${truncate(params, 80)}`;
  }
  if (detail.toolName && typeof detail.toolName === 'string') {
    return `${detail.toolName}`;
  }
  if (detail.result && typeof detail.result === 'string') return truncate(detail.result, 120);
  if (detail.error && typeof detail.error === 'string') return detail.error;
  if (detail.tier !== undefined) return `tier ${detail.tier}`;
  if (detail.entityPath && typeof detail.entityPath === 'string') return detail.entityPath;
  if (detail.key && typeof detail.key === 'string') return detail.key;

  // Fallback: first string value
  for (const val of Object.values(detail)) {
    if (typeof val === 'string' && val.length > 0 && val.length < 200) return val;
  }
  return '';
}

// ── Waterfall visualization ──

function renderWaterfall(events: ReplayEvent[]): void {
  if (events.length === 0) return;

  const startTime = events[0].timestamp.getTime();
  const endTime = events[events.length - 1].timestamp.getTime();
  const totalDuration = endTime - startTime || 1;
  const barWidth = 50;

  console.log(`\n  ${C.bold}Timeline Waterfall${C.reset}\n`);
  console.log(`  ${'TIME'.padEnd(14)} ${'STAGE'.padEnd(12)} ${'BAR'.padEnd(barWidth + 2)} DETAIL`);
  console.log(`  ${'─'.repeat(14)} ${'─'.repeat(12)} ${'─'.repeat(barWidth + 2)} ${'─'.repeat(40)}`);

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const offset = event.timestamp.getTime() - startTime;
    const nextEvent = events[i + 1];
    const duration = nextEvent
      ? nextEvent.timestamp.getTime() - event.timestamp.getTime()
      : 0;

    const barStart = Math.floor((offset / totalDuration) * barWidth);
    const barLen = Math.max(1, Math.ceil((duration / totalDuration) * barWidth));

    const info = PIPELINE_STAGES[event.type];
    const color = info?.color ?? C.dim;
    const label = info?.label ?? event.type.slice(0, 10);

    const bar = ' '.repeat(barStart) + color + '█'.repeat(Math.min(barLen, barWidth - barStart)) + C.reset;
    const time = formatTimestamp(event.timestamp);
    const content = truncate(extractContent(event.detail), 40);

    console.log(`  ${C.dim}${time}${C.reset} ${color}${label.padEnd(12)}${C.reset} ${bar.padEnd(barWidth + 20)} ${C.dim}${content}${C.reset}`);
  }

  console.log(`\n  ${C.dim}Total: ${formatDuration(totalDuration)}${C.reset}\n`);
}

// ── Export formatting ──

function exportToMarkdown(events: ReplayEvent[], sessionId: string): string {
  const lines: string[] = [
    `# Session Replay: ${sessionId}`,
    '',
    `**Date:** ${events.length > 0 ? formatDate(events[0].timestamp) : 'N/A'}`,
    `**Events:** ${events.length}`,
    `**Duration:** ${events.length > 1 ? formatDuration(events[events.length - 1].timestamp.getTime() - events[0].timestamp.getTime()) : 'N/A'}`,
    '',
    '## Events',
    '',
    '| Time | Type | Actor | Detail |',
    '|------|------|-------|--------|',
  ];

  for (const event of events) {
    const time = formatTimestamp(event.timestamp);
    const content = extractContent(event.detail).replace(/\|/g, '\\|');
    lines.push(`| ${time} | ${event.type} | ${event.actor} | ${truncate(content, 80)} |`);
  }

  return lines.join('\n');
}

function exportToJson(events: ReplayEvent[], sessionId: string): string {
  return JSON.stringify({
    sessionId,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
    events: events.map(e => ({
      eventId: e.eventId,
      type: e.type,
      actor: e.actor,
      timestamp: e.timestamp.toISOString(),
      detail: e.detail,
      hash: e.hash,
    })),
  }, null, 2);
}

// ── CLI Entry Point ──

export async function replayCommand(args: string[], db?: ReplayDb): Promise<void> {
  const sub = args[0] ?? 'list';

  // Lazy-load DB if not injected (for testing)
  let database: ReplayDb;
  if (db) {
    database = db;
  } else {
    try {
      const { createApp } = await import('./app.js');
      const app = createApp();
      await app.init();
      // Wrap the app's audit DB access
      database = {
        query: (sql: string, ...params: unknown[]) => app.queryAudit(sql, ...params) as AuditRow[],
        queryOne: (sql: string, ...params: unknown[]) => app.queryAuditOne(sql, ...params) as AuditRow | undefined,
      };
    } catch (err) {
      console.error(`Failed to initialize: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
  }

  switch (sub) {
    case 'list':
    case 'ls':
    case 'sessions':
      return listCmd(database, args.slice(1));
    case 'show':
    case 'replay':
    case 'play':
      return showCmd(database, args.slice(1));
    case 'trace':
    case 'chain':
      return traceCmd(database, args.slice(1));
    case 'timeline':
    case 'waterfall':
      return timelineCmd(database, args.slice(1));
    case 'stats':
    case 'summary':
      return statsCmd(database, args.slice(1));
    case 'compare':
    case 'cmp':
    case 'diff':
      return compareCmd(database, args.slice(1));
    case 'export':
      return exportCmd(database, args.slice(1));
    case 'search':
    case 'find':
    case 'grep':
      return searchCmd(database, args.slice(1));
    default:
      // Try as session ID shortcut
      if (sub && !sub.startsWith('-')) {
        return showCmd(database, [sub, ...args.slice(1)]);
      }
      console.error(`Unknown replay subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}

function printUsage(): void {
  console.log(`
${C.bold}Usage: ved replay <subcommand> [options]${C.reset}

${C.dim}Subcommands:${C.reset}
  list                     List sessions with activity
  show <sessionId>         Replay a session's full conversation flow
  trace <eventId>          Trace a single event's causal chain
  timeline <sessionId>     Show timing waterfall for a session
  stats <sessionId>        Session statistics (event counts, timing)
  compare <s1> <s2>        Compare two sessions side-by-side
  export <sessionId>       Export session replay to JSON/markdown
  search <query>           Search across session replays

${C.dim}Aliases:${C.reset} ved replays, ved trace, ved playback
`);
}

// ── Subcommand Implementations ──

function listCmd(db: ReplayDb, args: string[]): void {
  let limit = 20;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      json = true;
    }
  }

  const sessions = getSessionList(db, limit);

  if (json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(`\n  ${C.dim}No sessions found in audit log.${C.reset}\n`);
    return;
  }

  console.log(`\n  ${C.bold}Sessions${C.reset} (${sessions.length})\n`);

  const maxId = Math.max(...sessions.map(s => s.sessionId.length), 10);

  for (const s of sessions) {
    const when = relativeTime(s.lastEvent);
    const dur = formatDuration(s.durationMs);
    const msgs = `${s.messageCount}msg`;
    const tools = s.toolCalls > 0 ? ` ${s.toolCalls}tool` : '';
    const llm = s.llmCalls > 0 ? ` ${s.llmCalls / 2}llm` : '';
    const mem = s.memoryOps > 0 ? ` ${s.memoryOps}mem` : '';

    console.log(`  ${C.cyan}${s.sessionId.slice(0, maxId).padEnd(maxId)}${C.reset}  ${C.dim}${when.padEnd(10)}${C.reset}  ${dur.padEnd(8)}  ${msgs}${tools}${llm}${mem}  ${C.dim}(${s.eventCount} events)${C.reset}`);
  }

  console.log();
}

function showCmd(db: ReplayDb, args: string[]): void {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('Usage: ved replay show <sessionId>');
    process.exitCode = 1;
    return;
  }

  let limit = 500;
  let verbose = false;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  const events = getSessionEvents(db, sessionId, limit);

  if (events.length === 0) {
    console.error(`No events found for session: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  const duration = events.length > 1
    ? formatDuration(events[events.length - 1].timestamp.getTime() - events[0].timestamp.getTime())
    : 'N/A';

  console.log(`\n  ${C.bold}Session Replay: ${C.cyan}${sessionId}${C.reset}`);
  console.log(`  ${C.dim}${formatDate(events[0].timestamp)} · ${events.length} events · ${duration}${C.reset}\n`);

  let prevTime: number | null = null;

  for (const event of events) {
    const time = formatTimestamp(event.timestamp);
    const icon = stageIcon(event.type);
    const content = extractContent(event.detail);

    // Show time gap if > 1s
    if (prevTime !== null) {
      const gap = event.timestamp.getTime() - prevTime;
      if (gap > 1000) {
        console.log(`  ${C.dim}${'·'.repeat(6)} ${formatDuration(gap)} gap ${'·'.repeat(30)}${C.reset}`);
      }
    }

    const contentStr = content ? ` ${truncate(content, 80)}` : '';
    console.log(`  ${C.dim}${time}${C.reset} ${icon} ${C.dim}${event.actor.padEnd(12)}${C.reset}${contentStr}`);

    if (verbose && Object.keys(event.detail).length > 0) {
      const detailStr = JSON.stringify(event.detail, null, 2)
        .split('\n')
        .map(l => `             ${C.dim}${l}${C.reset}`)
        .join('\n');
      console.log(detailStr);
    }

    prevTime = event.timestamp.getTime();
  }

  console.log();
}

function traceCmd(db: ReplayDb, args: string[]): void {
  const eventId = args[0];
  if (!eventId) {
    console.error('Usage: ved replay trace <eventId>');
    process.exitCode = 1;
    return;
  }

  let depth = 20;
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--depth' || args[i] === '-d') && args[i + 1]) {
      depth = parseInt(args[++i], 10);
    }
  }

  const chain = getEventChain(db, eventId, depth);

  if (chain.length === 0) {
    console.error(`Event not found: ${eventId}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${C.bold}Hash Chain Trace${C.reset} (${chain.length} events)\n`);

  for (let i = 0; i < chain.length; i++) {
    const event = chain[i];
    const isTarget = event.eventId === eventId;
    const marker = isTarget ? `${C.bgCyan}${C.white} ► ${C.reset}` : '   ';
    const time = formatTimestamp(event.timestamp);
    const icon = stageIcon(event.type);
    const content = truncate(extractContent(event.detail), 60);
    const hashPreview = event.hash.slice(0, 8);

    console.log(`${marker}${C.dim}${time}${C.reset} ${icon} ${C.dim}${hashPreview}${C.reset} ${content}`);

    if (i < chain.length - 1) {
      console.log(`   ${C.dim}  │${C.reset}`);
    }
  }

  console.log();
}

function timelineCmd(db: ReplayDb, args: string[]): void {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('Usage: ved replay timeline <sessionId>');
    process.exitCode = 1;
    return;
  }

  let limit = 200;
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    }
  }

  const events = getSessionEvents(db, sessionId, limit);

  if (events.length === 0) {
    console.error(`No events found for session: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  renderWaterfall(events);
}

function statsCmd(db: ReplayDb, args: string[]): void {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('Usage: ved replay stats <sessionId>');
    process.exitCode = 1;
    return;
  }

  let json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') json = true;
  }

  const events = getSessionEvents(db, sessionId, 10000);

  if (events.length === 0) {
    console.error(`No events found for session: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  // Compute stats
  const typeCounts = new Map<string, number>();
  const stageCounts = new Map<number, number>();
  let totalLLMDuration = 0;
  let llmCallCount = 0;
  const toolNames = new Set<string>();
  const actors = new Set<string>();
  const memoryPaths = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
    actors.add(event.actor);

    const stage = PIPELINE_STAGES[event.type]?.stage ?? -1;
    if (stage >= 0) {
      stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    }

    if (event.type === 'llm_call') {
      llmCallCount++;
      // Find matching response for timing
      const response = events.slice(i + 1).find(e => e.type === 'llm_response');
      if (response) {
        totalLLMDuration += response.timestamp.getTime() - event.timestamp.getTime();
      }
    }

    if (event.type === 'tool_executed' && event.detail.tool) {
      toolNames.add(event.detail.tool as string);
    }
    if (event.type === 'tool_executed' && event.detail.toolName) {
      toolNames.add(event.detail.toolName as string);
    }

    if ((event.type === 'memory_t3_upsert' || event.type === 'memory_t1_write') && event.detail.entityPath) {
      memoryPaths.add(event.detail.entityPath as string);
    }
    if (event.detail.key && typeof event.detail.key === 'string') {
      memoryPaths.add(event.detail.key);
    }
  }

  const firstTime = events[0].timestamp.getTime();
  const lastTime = events[events.length - 1].timestamp.getTime();
  const totalDuration = lastTime - firstTime;

  const stats = {
    sessionId,
    events: events.length,
    duration: totalDuration,
    durationFormatted: formatDuration(totalDuration),
    firstEvent: events[0].timestamp.toISOString(),
    lastEvent: events[events.length - 1].timestamp.toISOString(),
    actors: [...actors],
    typeCounts: Object.fromEntries(typeCounts),
    llmCalls: llmCallCount,
    avgLLMLatency: llmCallCount > 0 ? Math.round(totalLLMDuration / llmCallCount) : 0,
    toolsUsed: [...toolNames],
    memoryPaths: [...memoryPaths],
  };

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(`\n  ${C.bold}Session Stats: ${C.cyan}${sessionId}${C.reset}\n`);

  console.log(`  ${C.dim}Duration:${C.reset}  ${formatDuration(totalDuration)}`);
  console.log(`  ${C.dim}Events:${C.reset}    ${events.length}`);
  console.log(`  ${C.dim}Actors:${C.reset}    ${[...actors].join(', ')}`);
  console.log(`  ${C.dim}Period:${C.reset}    ${formatDate(events[0].timestamp)} ${formatTimestamp(events[0].timestamp)} → ${formatTimestamp(events[events.length - 1].timestamp)}`);

  if (llmCallCount > 0) {
    console.log(`  ${C.dim}LLM calls:${C.reset} ${llmCallCount} (avg latency: ${formatDuration(stats.avgLLMLatency)})`);
  }

  if (toolNames.size > 0) {
    console.log(`  ${C.dim}Tools:${C.reset}     ${[...toolNames].join(', ')}`);
  }

  if (memoryPaths.size > 0) {
    console.log(`  ${C.dim}Memory:${C.reset}    ${[...memoryPaths].slice(0, 10).join(', ')}${memoryPaths.size > 10 ? ` (+${memoryPaths.size - 10} more)` : ''}`);
  }

  // Event type breakdown
  console.log(`\n  ${C.bold}Event Breakdown${C.reset}\n`);

  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(...sorted.map(([, c]) => c));
  const barMax = 30;

  for (const [type, count] of sorted) {
    const bar = '█'.repeat(Math.ceil((count / maxCount) * barMax));
    const info = PIPELINE_STAGES[type];
    const color = info?.color ?? C.dim;
    console.log(`  ${color}${type.padEnd(25)}${C.reset} ${color}${bar}${C.reset} ${count}`);
  }

  // Pipeline stage breakdown
  console.log(`\n  ${C.bold}Pipeline Stages${C.reset}\n`);
  const stageLabels = ['LIFECYCLE', 'RECEIVE', 'RAG', 'LLM', 'TRUST', 'EXECUTE', 'MEMORY', 'RESPOND'];
  for (let s = 0; s < stageLabels.length; s++) {
    const count = stageCounts.get(s) ?? 0;
    if (count > 0) {
      const bar = '█'.repeat(Math.ceil((count / maxCount) * barMax));
      console.log(`  ${C.dim}${stageLabels[s].padEnd(12)}${C.reset} ${bar} ${count}`);
    }
  }

  console.log();
}

function compareCmd(db: ReplayDb, args: string[]): void {
  const [s1, s2] = args;
  if (!s1 || !s2) {
    console.error('Usage: ved replay compare <session1> <session2>');
    process.exitCode = 1;
    return;
  }

  const events1 = getSessionEvents(db, s1, 10000);
  const events2 = getSessionEvents(db, s2, 10000);

  if (events1.length === 0) {
    console.error(`No events found for session: ${s1}`);
    process.exitCode = 1;
    return;
  }

  if (events2.length === 0) {
    console.error(`No events found for session: ${s2}`);
    process.exitCode = 1;
    return;
  }

  const dur1 = events1.length > 1 ? events1[events1.length - 1].timestamp.getTime() - events1[0].timestamp.getTime() : 0;
  const dur2 = events2.length > 1 ? events2[events2.length - 1].timestamp.getTime() - events2[0].timestamp.getTime() : 0;

  const types1 = new Map<string, number>();
  const types2 = new Map<string, number>();
  for (const e of events1) types1.set(e.type, (types1.get(e.type) ?? 0) + 1);
  for (const e of events2) types2.set(e.type, (types2.get(e.type) ?? 0) + 1);

  const allTypes = new Set([...types1.keys(), ...types2.keys()]);

  console.log(`\n  ${C.bold}Session Comparison${C.reset}\n`);
  console.log(`  ${''.padEnd(25)} ${C.cyan}${s1.slice(0, 20).padEnd(20)}${C.reset} ${C.magenta}${s2.slice(0, 20).padEnd(20)}${C.reset}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(20)} ${'─'.repeat(20)}`);

  console.log(`  ${'Events'.padEnd(25)} ${String(events1.length).padEnd(20)} ${String(events2.length).padEnd(20)}`);
  console.log(`  ${'Duration'.padEnd(25)} ${formatDuration(dur1).padEnd(20)} ${formatDuration(dur2).padEnd(20)}`);

  console.log(`\n  ${'Event Type'.padEnd(25)} ${C.cyan}S1${C.reset}${' '.repeat(18)} ${C.magenta}S2${C.reset}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(20)} ${'─'.repeat(20)}`);

  for (const type of [...allTypes].sort()) {
    const c1 = types1.get(type) ?? 0;
    const c2 = types2.get(type) ?? 0;
    const diff = c2 - c1;
    const diffStr = diff > 0 ? `${C.green}+${diff}${C.reset}` : diff < 0 ? `${C.red}${diff}${C.reset}` : `${C.dim}=${C.reset}`;
    console.log(`  ${type.padEnd(25)} ${String(c1).padEnd(20)} ${String(c2).padEnd(15)} ${diffStr}`);
  }

  console.log();
}

function exportCmd(db: ReplayDb, args: string[]): void {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('Usage: ved replay export <sessionId> [--format json|markdown] [--output <file>]');
    process.exitCode = 1;
    return;
  }

  let format = 'json';
  let outputFile: string | null = null;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--format' || args[i] === '-f') && args[i + 1]) {
      format = args[++i];
    } else if ((args[i] === '--output' || args[i] === '-o') && args[i + 1]) {
      outputFile = args[++i];
    } else if (args[i] === '--markdown' || args[i] === '--md') {
      format = 'markdown';
    }
  }

  const events = getSessionEvents(db, sessionId, 10000);

  if (events.length === 0) {
    console.error(`No events found for session: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  let output: string;
  if (format === 'markdown' || format === 'md') {
    output = exportToMarkdown(events, sessionId);
  } else {
    output = exportToJson(events, sessionId);
  }

  if (outputFile) {
    writeFileSync(outputFile, output + '\n', 'utf8');
    console.log(`  ${C.green}✓${C.reset} Exported ${events.length} events to ${C.cyan}${outputFile}${C.reset}`);
  } else {
    console.log(output);
  }
}

function searchCmd(db: ReplayDb, args: string[]): void {
  const queryParts: string[] = [];
  let limit = 30;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      json = true;
    } else if (!args[i].startsWith('-')) {
      queryParts.push(args[i]);
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error('Usage: ved replay search <query> [--limit <n>] [--json]');
    process.exitCode = 1;
    return;
  }

  const events = searchEvents(db, query, limit);

  if (json) {
    console.log(JSON.stringify(events.map(e => ({
      eventId: e.eventId,
      type: e.type,
      actor: e.actor,
      sessionId: e.sessionId,
      timestamp: e.timestamp.toISOString(),
      detail: e.detail,
    })), null, 2));
    return;
  }

  if (events.length === 0) {
    console.log(`\n  ${C.dim}No events matching: "${query}"${C.reset}\n`);
    return;
  }

  console.log(`\n  ${C.bold}Search: "${query}"${C.reset} (${events.length} results)\n`);

  for (const event of events) {
    const time = formatTimestamp(event.timestamp);
    const date = formatDate(event.timestamp);
    const icon = stageIcon(event.type);
    const content = truncate(extractContent(event.detail), 60);
    const session = event.sessionId ? ` ${C.dim}[${event.sessionId.slice(0, 12)}]${C.reset}` : '';

    console.log(`  ${C.dim}${date} ${time}${C.reset} ${icon}${session} ${content}`);
  }

  console.log();
}

// ── Exports for testing ──

export {
  PIPELINE_STAGES,
  formatDuration,
  formatTimestamp,
  formatDate,
  relativeTime,
  truncate,
  extractContent,
  renderWaterfall,
  exportToMarkdown,
  exportToJson,
};
