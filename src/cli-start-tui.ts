/**
 * `ved start` — Daemon TUI with live event stream and panels.
 *
 * Features:
 *   - Live event stream (real-time audit events via EventBus)
 *   - Active sessions panel (with message counts and status)
 *   - Pending work orders panel (with risk badges and approve/deny)
 *   - Memory/system stats (vault, RAG, audit, sessions)
 *   - Keyboard shortcuts for quick actions
 *   - Fixed header + footer with scroll region for events
 *
 * Usage: ved start [--simple] [--no-tui] [--port <port>]
 */

import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { VedApp } from './app.js';
import type { VedEvent } from './event-bus.js';
import type { Session } from './core/session.js';
import type { WorkOrder } from './types/index.js';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  italic: '\x1B[3m',
  cyan: '\x1B[36m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  magenta: '\x1B[35m',
  red: '\x1B[31m',
  blue: '\x1B[34m',
  gray: '\x1B[90m',
  white: '\x1B[37m',
  bgBlue: '\x1B[44m',
  bgGreen: '\x1B[42m',
  bgYellow: '\x1B[43m',
  bgRed: '\x1B[41m',
  reverse: '\x1B[7m',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DaemonTuiOptions {
  simple?: boolean;
  noTui?: boolean;
  port?: number;
  host?: string;
  token?: string;
  cors?: string;
}

export type DaemonPanel = 'events' | 'sessions' | 'approvals' | 'stats';

export interface DaemonState {
  startTime: number;
  eventCount: number;
  recentEvents: VedEvent[];
  activePanel: DaemonPanel;
  eventFilter: string | null;
  paused: boolean;
  lastRefresh: number;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseDaemonArgs(args: string[]): DaemonTuiOptions {
  const opts: DaemonTuiOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--simple':
      case '-s':
      case '--no-tui':
        opts.simple = true;
        break;
      case '--port':
      case '-p':
        opts.port = parseInt(args[++i] ?? '', 10);
        break;
      case '--host':
        opts.host = args[++i];
        break;
      case '--token':
        opts.token = args[++i];
        break;
      case '--cors':
        opts.cors = args[++i];
        break;
      case '--help':
      case '-h':
        printDaemonHelp();
        process.exit(0);
        break;
      default:
        if (args[i]?.startsWith('-')) {
          console.error(`Unknown flag: ${args[i]}`);
          printDaemonHelp();
          process.exit(1);
        }
    }
  }

  return opts;
}

export function printDaemonHelp(): void {
  stdout.write(`
${C.bold}ved start${C.reset} — Run Ved daemon with live TUI dashboard

${C.bold}Usage:${C.reset}
  ved start [options]

${C.bold}Options:${C.reset}
  --simple, -s, --no-tui  Plain log output (no TUI)
  --port, -p <port>       Also start HTTP API on this port
  --host <host>           HTTP API bind host (default: 127.0.0.1)
  --token <token>         HTTP API bearer token
  --cors <origin>         CORS allowed origin
  --help, -h              Show this help

${C.bold}Keyboard Shortcuts (TUI mode):${C.reset}
  Tab / 1-4       Switch panels (events/sessions/approvals/stats)
  f               Filter events by type
  p               Pause/resume event stream
  a <id>          Approve work order
  d <id>          Deny work order
  r               Refresh all panels
  q / Ctrl+C      Quit

`);
}

// ── Time formatting ───────────────────────────────────────────────────────────

export function formatAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 2) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60) % 60;
  const hrs = Math.floor(secs / 3600);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m ${secs % 60}s`;
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

// ── Risk badge ────────────────────────────────────────────────────────────────

export function riskBadge(level: string): string {
  switch (level) {
    case 'critical': return `${C.bold}${C.red}CRIT${C.reset}`;
    case 'high':     return `${C.red}HIGH${C.reset}`;
    case 'medium':   return `${C.yellow}MED${C.reset}`;
    case 'low':      return `${C.green}LOW${C.reset}`;
    default:         return `${C.gray}${level}${C.reset}`;
  }
}

// ── Event type styling ────────────────────────────────────────────────────────

export function styleEventType(type: string): string {
  if (type.startsWith('message_')) return `${C.cyan}${type}${C.reset}`;
  if (type.startsWith('llm_')) return `${C.magenta}${type}${C.reset}`;
  if (type.startsWith('tool_')) return `${C.yellow}${type}${C.reset}`;
  if (type.startsWith('memory_')) return `${C.blue}${type}${C.reset}`;
  if (type.startsWith('work_order_')) return `${C.bold}${C.yellow}${type}${C.reset}`;
  if (type.startsWith('session_')) return `${C.green}${type}${C.reset}`;
  if (type === 'error') return `${C.red}${type}${C.reset}`;
  if (type === 'startup' || type === 'shutdown') return `${C.bold}${type}${C.reset}`;
  return `${C.dim}${type}${C.reset}`;
}

// ── Event formatting ──────────────────────────────────────────────────────────

export function formatEvent(event: VedEvent, termWidth: number): string {
  const time = formatTimestamp(event.timestamp);
  const type = styleEventType(event.type);
  const sess = event.sessionId ? `${C.dim}${event.sessionId.slice(0, 8)}${C.reset}` : `${C.dim}────────${C.reset}`;
  const actor = event.actor ? `${C.dim}${event.actor.slice(0, 10)}${C.reset}` : '';

  // Extract useful detail snippet
  let detail = '';
  const d = event.detail;
  if (d.content && typeof d.content === 'string') {
    detail = d.content.slice(0, 60).replace(/\n/g, '↵');
  } else if (d.tool && typeof d.tool === 'string') {
    detail = `${d.tool}${d.riskLevel ? ` [${d.riskLevel}]` : ''}`;
  } else if (d.model && typeof d.model === 'string') {
    detail = d.model;
  } else if (d.message && typeof d.message === 'string') {
    detail = d.message.slice(0, 60).replace(/\n/g, '↵');
  } else if (d.path && typeof d.path === 'string') {
    detail = d.path;
  } else if (d.count !== undefined) {
    detail = `count: ${d.count}`;
  }

  if (detail) {
    const maxDetail = Math.max(10, termWidth - 55);
    if (detail.length > maxDetail) detail = detail.slice(0, maxDetail - 1) + '…';
    detail = `  ${C.dim}${detail}${C.reset}`;
  }

  return `${C.dim}${time}${C.reset} ${sess} ${type}${actor ? ` ${actor}` : ''}${detail}`;
}

// ── Session formatting ────────────────────────────────────────────────────────

export function formatSession(session: Session, termWidth: number): string {
  const statusIcon = session.status === 'active' ? `${C.green}●${C.reset}`
    : session.status === 'idle' ? `${C.yellow}○${C.reset}`
      : `${C.dim}○${C.reset}`;
  const ago = formatAgo(Date.now() - session.lastActive);
  const msgs = session.workingMemory.messageCount;
  const channel = session.channel;
  const id = session.id.slice(0, 10);

  const preview = session.workingMemory.messages.length > 0
    ? (session.workingMemory.messages[session.workingMemory.messages.length - 1]?.content ?? '').slice(0, 40).replace(/\n/g, '↵')
    : '';

  const maxPreview = Math.max(10, termWidth - 55);
  const previewTrunc = preview.length > maxPreview ? preview.slice(0, maxPreview - 1) + '…' : preview;

  return `  ${statusIcon} ${C.cyan}${id}…${C.reset}  ${C.dim}${channel}${C.reset}  ${msgs} msgs  ${C.dim}${ago}${C.reset}${previewTrunc ? `  ${C.dim}${previewTrunc}${C.reset}` : ''}`;
}

// ── Work order formatting ─────────────────────────────────────────────────────

export function formatWorkOrder(wo: WorkOrder, _termWidth: number): string {
  const badge = riskBadge(wo.riskLevel);
  const ago = formatAgo(Date.now() - wo.createdAt);
  const expires = formatAgo(wo.expiresAt - Date.now());
  const id = wo.id.slice(0, 10);

  return `  ${badge} ${C.cyan}${id}…${C.reset}  ${C.yellow}${wo.tool}${C.reset}  ${C.dim}sess:${wo.sessionId.slice(0, 8)}  ${ago}  expires in ${expires}${C.reset}`;
}

// ── Panels ────────────────────────────────────────────────────────────────────

export function renderHeader(state: DaemonState, termWidth: number): string {
  const uptime = formatUptime(Date.now() - state.startTime);
  const panelNames: DaemonPanel[] = ['events', 'sessions', 'approvals', 'stats'];
  const tabs = panelNames.map(p => {
    if (p === state.activePanel) return `${C.reverse} ${p.toUpperCase()} ${C.reset}`;
    return ` ${C.dim}${p}${C.reset} `;
  }).join(`${C.dim}│${C.reset}`);

  const status = state.paused
    ? `${C.yellow}⏸ PAUSED${C.reset}`
    : `${C.green}● RUNNING${C.reset}`;

  const left = `  ${C.bold}${C.cyan}Ved Daemon${C.reset}  ${status}  ${C.dim}up ${uptime}  events: ${state.eventCount}${C.reset}`;
  const right = tabs;

  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  const gap = Math.max(1, termWidth - leftLen - rightLen);

  return left + ' '.repeat(gap) + right;
}

export function renderFooter(state: DaemonState, _termWidth: number): string {
  const hints: string[] = [];
  switch (state.activePanel) {
    case 'events':
      hints.push(`${C.dim}[f]ilter${C.reset}`, `${C.dim}[p]ause${C.reset}`, `${C.dim}[c]lear${C.reset}`);
      break;
    case 'approvals':
      hints.push(`${C.dim}[a] approve <id>${C.reset}`, `${C.dim}[d] deny <id>${C.reset}`);
      break;
    default:
      break;
  }
  hints.push(`${C.dim}[Tab] panels${C.reset}`, `${C.dim}[r]efresh${C.reset}`, `${C.dim}[q]uit${C.reset}`);
  return `  ${hints.join('  ')}`;
}

export function renderEventsPanel(state: DaemonState, rows: number, termWidth: number): string[] {
  const lines: string[] = [];
  const maxEvents = rows - 1; // Reserve 1 for header

  let events = state.recentEvents;
  if (state.eventFilter) {
    events = events.filter(e => e.type.includes(state.eventFilter!));
  }

  const visible = events.slice(-maxEvents);

  if (visible.length === 0) {
    lines.push(`  ${C.dim}No events yet. Waiting for activity…${C.reset}`);
  } else {
    for (const event of visible) {
      lines.push(formatEvent(event, termWidth));
    }
  }

  // Pad to fill panel
  while (lines.length < maxEvents) {
    lines.push('');
  }

  return lines;
}

export function renderSessionsPanel(
  sessions: Session[],
  rows: number,
  termWidth: number,
): string[] {
  const lines: string[] = [];
  const maxRows = rows - 2;

  const active = sessions.filter(s => s.status === 'active');
  const idle = sessions.filter(s => s.status === 'idle');

  lines.push(`  ${C.bold}Active Sessions${C.reset} ${C.dim}(${active.length})${C.reset}    ${C.bold}Idle${C.reset} ${C.dim}(${idle.length})${C.reset}`);
  lines.push(`  ${C.dim}${'─'.repeat(Math.max(0, termWidth - 4))}${C.reset}`);

  if (active.length === 0 && idle.length === 0) {
    lines.push(`  ${C.dim}No active sessions.${C.reset}`);
  } else {
    for (const s of active.slice(0, Math.ceil(maxRows / 2))) {
      lines.push(formatSession(s, termWidth));
    }
    for (const s of idle.slice(0, Math.floor(maxRows / 2))) {
      lines.push(formatSession(s, termWidth));
    }
  }

  while (lines.length < rows) lines.push('');
  return lines;
}

export interface ApprovalsPanelData {
  pending: WorkOrder[];
}

export function renderApprovalsPanel(
  data: ApprovalsPanelData,
  rows: number,
  termWidth: number,
): string[] {
  const lines: string[] = [];
  const maxRows = rows - 2;

  lines.push(`  ${C.bold}Pending Approvals${C.reset} ${C.dim}(${data.pending.length})${C.reset}`);
  lines.push(`  ${C.dim}${'─'.repeat(Math.max(0, termWidth - 4))}${C.reset}`);

  if (data.pending.length === 0) {
    lines.push(`  ${C.dim}No pending work orders. All clear.${C.reset}`);
  } else {
    for (const wo of data.pending.slice(0, maxRows)) {
      lines.push(formatWorkOrder(wo, termWidth));
    }
    if (data.pending.length > maxRows) {
      lines.push(`  ${C.dim}… and ${data.pending.length - maxRows} more${C.reset}`);
    }
  }

  while (lines.length < rows) lines.push('');
  return lines;
}

export interface StatsPanelData {
  vault: { fileCount: number; tagCount: number; gitClean: boolean };
  rag: { filesIndexed: number; chunksStored: number };
  audit: { chainLength: number; chainHead: string };
  sessions: { active: number; total: number };
  cron: { jobs: number; nextRun?: string };
  eventBusSubscribers: number;
}

export function renderStatsPanel(
  data: StatsPanelData,
  rows: number,
  _termWidth: number,
): string[] {
  const lines: string[] = [];

  lines.push(`  ${C.bold}System Statistics${C.reset}`);
  lines.push('');
  lines.push(`  ${C.cyan}Vault${C.reset}       ${data.vault.fileCount} files  ${data.vault.gitClean ? `${C.green}clean${C.reset}` : `${C.yellow}dirty${C.reset}`}  ${C.dim}${data.vault.tagCount} tags${C.reset}`);
  lines.push(`  ${C.cyan}RAG Index${C.reset}   ${data.rag.filesIndexed} files  ${C.dim}${data.rag.chunksStored} chunks${C.reset}`);
  lines.push(`  ${C.cyan}Audit${C.reset}       ${data.audit.chainLength} entries  ${C.dim}head: ${data.audit.chainHead}${C.reset}`);
  lines.push(`  ${C.cyan}Sessions${C.reset}    ${data.sessions.active} active / ${data.sessions.total} total`);
  lines.push(`  ${C.cyan}Cron${C.reset}        ${data.cron.jobs} scheduled jobs${data.cron.nextRun ? `  next: ${data.cron.nextRun}` : ''}`);
  lines.push(`  ${C.cyan}EventBus${C.reset}    ${data.eventBusSubscribers} subscribers`);

  while (lines.length < rows) lines.push('');
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── ANSI helper ───────────────────────────────────────────────────────────────

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// ── Dashboard renderer ────────────────────────────────────────────────────────

export class DaemonDashboard {
  private rows = 24;
  private cols = 80;
  private active = false;
  private state: DaemonState;
  private app: VedApp;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(app: VedApp) {
    this.app = app;
    this.state = {
      startTime: Date.now(),
      eventCount: 0,
      recentEvents: [],
      activePanel: 'events',
      eventFilter: null,
      paused: false,
      lastRefresh: Date.now(),
    };
  }

  getState(): DaemonState {
    return this.state;
  }

  init(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.active = true;

    // Hide cursor
    stdout.write('\x1B[?25l');
    // Clear screen
    stdout.write('\x1B[2J\x1B[H');

    process.on('SIGWINCH', () => {
      this.rows = process.stdout.rows || 24;
      this.cols = process.stdout.columns || 80;
      this.fullRender();
    });

    // Subscribe to EventBus
    this.app.eventBus.subscribe((event) => {
      this.state.eventCount++;
      this.state.recentEvents.push(event);
      // Keep last 500 events in memory
      if (this.state.recentEvents.length > 500) {
        this.state.recentEvents = this.state.recentEvents.slice(-400);
      }
      if (!this.state.paused) {
        this.fullRender();
      }
    });

    // Periodic full refresh for uptime/stats (every 5s)
    this.refreshTimer = setInterval(() => {
      this.state.lastRefresh = Date.now();
      if (!this.state.paused) {
        this.fullRender();
      }
    }, 5000);

    this.fullRender();
  }

  pushEvent(event: VedEvent): void {
    this.state.eventCount++;
    this.state.recentEvents.push(event);
    if (this.state.recentEvents.length > 500) {
      this.state.recentEvents = this.state.recentEvents.slice(-400);
    }
    if (!this.state.paused && this.active) {
      this.fullRender();
    }
  }

  setPanel(panel: DaemonPanel): void {
    this.state.activePanel = panel;
    if (this.active) this.fullRender();
  }

  nextPanel(): void {
    const panels: DaemonPanel[] = ['events', 'sessions', 'approvals', 'stats'];
    const idx = panels.indexOf(this.state.activePanel);
    this.state.activePanel = panels[(idx + 1) % panels.length]!;
    if (this.active) this.fullRender();
  }

  togglePause(): void {
    this.state.paused = !this.state.paused;
    if (this.active) this.fullRender();
  }

  setFilter(filter: string | null): void {
    this.state.eventFilter = filter;
    if (this.active) this.fullRender();
  }

  clearEvents(): void {
    this.state.recentEvents = [];
    this.state.eventCount = 0;
    if (this.active) this.fullRender();
  }

  fullRender(): void {
    if (!this.active) return;

    const lines: string[] = [];

    // Header (1 line)
    lines.push(renderHeader(this.state, this.cols));
    lines.push(`${C.dim}${'─'.repeat(this.cols)}${C.reset}`);

    // Panel content (rows - 4: header, separator, footer separator, footer)
    const panelRows = Math.max(3, this.rows - 4);

    switch (this.state.activePanel) {
      case 'events':
        lines.push(...renderEventsPanel(this.state, panelRows, this.cols));
        break;
      case 'sessions': {
        const sessions = this.app.listRecentSessions(20);
        lines.push(...renderSessionsPanel(sessions, panelRows, this.cols));
        break;
      }
      case 'approvals': {
        const pending = this.app.eventLoop.workOrders.getPending();
        lines.push(...renderApprovalsPanel({ pending }, panelRows, this.cols));
        break;
      }
      case 'stats': {
        const statsData = this.gatherStats();
        lines.push(...renderStatsPanel(statsData, panelRows, this.cols));
        break;
      }
    }

    // Footer
    lines.push(`${C.dim}${'─'.repeat(this.cols)}${C.reset}`);
    lines.push(renderFooter(this.state, this.cols));

    // Write to screen
    stdout.write('\x1B[H'); // Move to top
    for (let i = 0; i < Math.min(lines.length, this.rows); i++) {
      stdout.write(`${lines[i]}\x1B[K\n`); // Write line + clear to EOL
    }
    // Clear any remaining lines
    for (let i = lines.length; i < this.rows; i++) {
      stdout.write('\x1B[K\n');
    }
  }

  private gatherStats(): StatsPanelData {
    try {
      const appStats = this.app.getStats();
      const cronJobs = this.app.cron.list();
      const enabledCron = cronJobs.filter((j: { enabled: boolean }) => j.enabled);

      return {
        vault: {
          fileCount: appStats.vault.fileCount,
          tagCount: appStats.vault.tagCount,
          gitClean: appStats.vault.gitClean,
        },
        rag: {
          filesIndexed: appStats.rag.filesIndexed,
          chunksStored: appStats.rag.chunksStored,
        },
        audit: appStats.audit,
        sessions: appStats.sessions,
        cron: {
          jobs: enabledCron.length,
          nextRun: enabledCron.length > 0 ? formatAgo(Date.now() - (enabledCron[0] as any).nextRun) : undefined,
        },
        eventBusSubscribers: this.app.eventBus.subscriberCount,
      };
    } catch {
      return {
        vault: { fileCount: 0, tagCount: 0, gitClean: true },
        rag: { filesIndexed: 0, chunksStored: 0 },
        audit: { chainLength: 0, chainHead: '' },
        sessions: { active: 0, total: 0 },
        cron: { jobs: 0 },
        eventBusSubscribers: 0,
      };
    }
  }

  destroy(): void {
    this.active = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Show cursor
    stdout.write('\x1B[?25h');
    // Clear screen
    stdout.write('\x1B[2J\x1B[H');
  }
}

// ── Keyboard handler ──────────────────────────────────────────────────────────

export function setupKeyboardHandler(
  dashboard: DaemonDashboard,
  app: VedApp,
  onQuit: () => void,
): void {
  if (!stdin.isTTY) return;

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  let inputBuffer = '';
  let inputMode: 'normal' | 'approve' | 'deny' | 'filter' = 'normal';

  stdin.on('keypress', (_str, key) => {
    if (!key) return;

    // Ctrl+C always quits
    if (key.ctrl && key.name === 'c') {
      onQuit();
      return;
    }

    if (inputMode !== 'normal') {
      if (key.name === 'escape') {
        inputMode = 'normal';
        inputBuffer = '';
        dashboard.fullRender();
        return;
      }
      if (key.name === 'return') {
        handleInputSubmit(inputMode, inputBuffer.trim(), app, dashboard);
        inputMode = 'normal';
        inputBuffer = '';
        dashboard.fullRender();
        return;
      }
      if (key.name === 'backspace') {
        inputBuffer = inputBuffer.slice(0, -1);
        return;
      }
      if (key.sequence && !key.ctrl && !key.meta) {
        inputBuffer += key.sequence;
      }
      return;
    }

    // Normal mode
    switch (key.name) {
      case 'q':
        onQuit();
        return;
      case 'tab':
        dashboard.nextPanel();
        return;
      case 'p':
        dashboard.togglePause();
        return;
      case 'r':
        dashboard.fullRender();
        return;
      case 'c':
        dashboard.clearEvents();
        return;
      case 'f':
        inputMode = 'filter';
        inputBuffer = '';
        return;
      case 'a':
        inputMode = 'approve';
        inputBuffer = '';
        return;
      case 'd':
        inputMode = 'deny';
        inputBuffer = '';
        return;
      default:
        break;
    }

    // Number keys 1-4 for panel switching
    if (key.sequence === '1') dashboard.setPanel('events');
    else if (key.sequence === '2') dashboard.setPanel('sessions');
    else if (key.sequence === '3') dashboard.setPanel('approvals');
    else if (key.sequence === '4') dashboard.setPanel('stats');
  });
}

function handleInputSubmit(
  mode: 'approve' | 'deny' | 'filter',
  input: string,
  app: VedApp,
  dashboard: DaemonDashboard,
): void {
  if (mode === 'filter') {
    dashboard.setFilter(input || null);
    return;
  }

  if (!input) return;

  try {
    const workOrders = app.eventLoop.workOrders;

    if (mode === 'approve') {
      // Try to match by prefix
      const pending = workOrders.getPending();
      const match = pending.find(wo => wo.id.startsWith(input));
      if (match) {
        workOrders.approve(match.id, 'owner');
      }
    } else if (mode === 'deny') {
      const pending = workOrders.getPending();
      const match = pending.find(wo => wo.id.startsWith(input));
      if (match) {
        workOrders.deny(match.id, 'owner');
      }
    }
  } catch {
    // Best effort — dashboard will refresh
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run Ved daemon with TUI dashboard.
 */
export async function runDaemonTui(app: VedApp, args: string[]): Promise<void> {
  const opts = parseDaemonArgs(args);

  // --simple falls back to plain start()
  if (opts.simple) {
    return plainStart(app);
  }

  const dashboard = new DaemonDashboard(app);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    dashboard.destroy();
    stdout.write(`${C.dim}Shutting down Ved…${C.reset}\n`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Initialize the dashboard before starting (shows "starting" state)
    dashboard.init();

    // Start HTTP API if --port specified
    let httpCleanup: (() => Promise<void>) | null = null;
    if (opts.port) {
      const { VedHttpServer } = await import('./http.js');
      const httpServer = new VedHttpServer(app, {
        port: opts.port,
        host: opts.host || '127.0.0.1',
        apiToken: opts.token || '',
        corsOrigin: opts.cors || '*',
      });
      const actualPort = await httpServer.start();
      httpCleanup = () => httpServer.stop();
      // Push a synthetic event for HTTP start
      dashboard.pushEvent({
        id: 'http-started',
        timestamp: Date.now(),
        type: 'startup',
        actor: 'system',
        detail: { message: `HTTP API listening on port ${actualPort}` },
        hash: '',
      });
    }

    // Setup keyboard shortcuts
    setupKeyboardHandler(dashboard, app, shutdown);

    // Start the Ved daemon (this blocks until shutdown)
    await app.start();

    // Cleanup HTTP if running
    if (httpCleanup) await httpCleanup();
  } catch (err) {
    dashboard.destroy();
    console.error(`\nDaemon error: ${err instanceof Error ? err.message : String(err)}`);
    try { await app.stop(); } catch { /* best effort */ }
    process.exit(1);
  }
}

/**
 * Plain start — no TUI, just console output.
 */
async function plainStart(app: VedApp): Promise<void> {
  const shutdown = async () => {
    console.log('\nShutting down...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await app.start();
  } catch (err) {
    console.error(`\nFailed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
