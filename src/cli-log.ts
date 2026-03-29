/**
 * ved log — Structured log viewer, tailer, and analyzer.
 *
 * Read, filter, tail, search, and analyze Ved's JSON log file.
 * The log file path comes from config.yaml `logFile` (or VED_LOG_FILE env var).
 *
 * Subcommands:
 *   ved log                              — Show recent entries (default: last 50)
 *   ved log show                         — Show entries with filters
 *   ved log tail                         — Live-follow the log file
 *   ved log search <query>               — Full-text search through logs
 *   ved log stats                        — Log file statistics
 *   ved log levels                       — Show log level breakdown
 *   ved log modules                      — Show module breakdown
 *   ved log clear                        — Truncate the log file
 *   ved log path                         — Print log file path
 *
 * Filters (for show/tail/search):
 *   --level <debug|info|warn|error>      — Minimum log level
 *   --module <name>                      — Filter by module name
 *   --since <ISO|relative>               — Entries after this time
 *   --until <ISO|relative>               — Entries before this time
 *   --limit <n>                          — Max entries (default: 50, 0=unlimited)
 *   --json                               — Output raw JSON lines
 *   --no-color                           — Disable ANSI colors
 *
 * Aliases: ved logs
 *
 * @module cli-log
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getConfigDir } from './core/config.js';
import type { LogLevel, LogEntry } from './core/log.js';
import { errHint, errUsage } from './errors.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface LogFilter {
  level?: LogLevel;
  module?: string;
  since?: Date;
  until?: Date;
  limit: number;
  json: boolean;
  noColor: boolean;
  query?: string;
}

export interface LogStats {
  filePath: string;
  fileSize: number;
  totalEntries: number;
  byLevel: Record<string, number>;
  byModule: Record<string, number>;
  firstEntry?: string;
  lastEntry?: string;
  errors: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // gray
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// ── Log file resolution ────────────────────────────────────────────────

/**
 * Resolve the log file path from config or env.
 */
export function resolveLogPath(): string | null {
  // 1. Environment variable
  if (process.env.VED_LOG_FILE) {
    return resolve(process.env.VED_LOG_FILE);
  }

  // 2. Config file
  const configDir = getConfigDir();
  const configPath = join(configDir, 'config.yaml');
  const localConfigPath = join(configDir, 'config.local.yaml');

  for (const p of [localConfigPath, configPath]) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      const match = content.match(/^logFile:\s*(.+)$/m);
      if (match) {
        const val = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (val && val !== 'null' && val !== '~') {
          return resolve(val.replace(/^~/, process.env.HOME ?? ''));
        }
      }
    }
  }

  // 3. Default location
  const defaultPath = join(configDir, 'ved.log');
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

// ── Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a single JSON log line. Returns null on parse failure.
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const entry = JSON.parse(trimmed);
    if (!entry.ts || !entry.level || !entry.msg) return null;
    return entry as LogEntry;
  } catch {
    return null;
  }
}

/**
 * Parse all log lines from file content.
 */
export function parseLogFile(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = parseLogLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Parse relative time strings like "1h", "30m", "2d", "1w".
 */
export function parseRelativeTime(input: string): Date | null {
  const match = input.match(/^(\d+)([smhdw])$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  const ms: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return new Date(now - value * (ms[unit] ?? 0));
}

/**
 * Parse a time input — ISO string or relative.
 */
export function parseTimeInput(input: string): Date | null {
  // Try relative first
  const rel = parseRelativeTime(input);
  if (rel) return rel;
  // Try ISO
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

// ── Filtering ──────────────────────────────────────────────────────────

/**
 * Apply filters to log entries.
 */
export function filterEntries(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  let result = entries;

  // Level filter
  if (filter.level) {
    const minPriority = LEVEL_PRIORITY[filter.level] ?? 0;
    result = result.filter(e => (LEVEL_PRIORITY[e.level as LogLevel] ?? 0) >= minPriority);
  }

  // Module filter
  if (filter.module) {
    const mod = filter.module.toLowerCase();
    result = result.filter(e => e.module?.toLowerCase() === mod);
  }

  // Since filter
  if (filter.since) {
    const sinceMs = filter.since.getTime();
    result = result.filter(e => new Date(e.ts).getTime() >= sinceMs);
  }

  // Until filter
  if (filter.until) {
    const untilMs = filter.until.getTime();
    result = result.filter(e => new Date(e.ts).getTime() <= untilMs);
  }

  // Text search
  if (filter.query) {
    const q = filter.query.toLowerCase();
    result = result.filter(e => {
      const text = `${e.msg} ${e.module ?? ''} ${JSON.stringify(e)}`.toLowerCase();
      return text.includes(q);
    });
  }

  // Limit (take last N)
  if (filter.limit > 0 && result.length > filter.limit) {
    result = result.slice(-filter.limit);
  }

  return result;
}

// ── Formatting ─────────────────────────────────────────────────────────

/**
 * Format a log entry for pretty display.
 */
export function formatEntry(entry: LogEntry, noColor: boolean): string {
  const time = entry.ts.slice(0, 19).replace('T', ' ');
  const lvl = entry.level.toUpperCase().padEnd(5);
  const mod = entry.module ? `[${entry.module}]` : '';
  const { ts: _ts, level: _l, msg, module: _m, ...rest } = entry;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';

  if (noColor) {
    return `${time} ${lvl} ${mod ? mod + ' ' : ''}${msg}${extra}`;
  }

  const color = LEVEL_COLORS[entry.level as LogLevel] ?? '';
  return `${DIM}${time}${RESET} ${color}${lvl}${RESET} ${BOLD}${mod}${RESET}${mod ? ' ' : ''}${msg}${extra ? DIM + extra + RESET : ''}`;
}

/**
 * Format a number with commas.
 */
function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Format bytes to human-readable.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Stats computation ──────────────────────────────────────────────────

/**
 * Compute stats from log entries.
 */
export function computeStats(entries: LogEntry[], filePath: string, fileSize: number): LogStats {
  const byLevel: Record<string, number> = {};
  const byModule: Record<string, number> = {};
  let errors = 0;

  for (const e of entries) {
    byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
    if (e.module) {
      byModule[e.module] = (byModule[e.module] ?? 0) + 1;
    }
    if (e.level === 'error') errors++;
  }

  return {
    filePath,
    fileSize,
    totalEntries: entries.length,
    byLevel,
    byModule,
    firstEntry: entries.length > 0 ? entries[0].ts : undefined,
    lastEntry: entries.length > 0 ? entries[entries.length - 1].ts : undefined,
    errors,
  };
}

// ── Parse CLI flags ────────────────────────────────────────────────────

export function parseFlags(args: string[]): { filter: LogFilter; remaining: string[] } {
  const filter: LogFilter = {
    limit: DEFAULT_LIMIT,
    json: false,
    noColor: false,
  };
  const remaining: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--level' && i + 1 < args.length) {
      const lvl = args[++i] as LogLevel;
      if (!LEVEL_PRIORITY[lvl] && lvl !== 'debug') {
        errHint(`Invalid level: ${lvl}. Use: debug, info, warn, error`);
        process.exitCode = 1;
        return { filter, remaining };
      }
      filter.level = lvl;
    } else if (arg === '--module' && i + 1 < args.length) {
      filter.module = args[++i];
    } else if (arg === '--since' && i + 1 < args.length) {
      const d = parseTimeInput(args[++i]);
      if (!d) {
        errHint(`Invalid --since value: ${args[i]}. Use ISO date or relative (e.g. 1h, 30m, 2d)`);
        process.exitCode = 1;
        return { filter, remaining };
      }
      filter.since = d;
    } else if (arg === '--until' && i + 1 < args.length) {
      const d = parseTimeInput(args[++i]);
      if (!d) {
        errHint(`Invalid --until value: ${args[i]}. Use ISO date or relative (e.g. 1h, 30m, 2d)`);
        process.exitCode = 1;
        return { filter, remaining };
      }
      filter.until = d;
    } else if (arg === '--limit' || arg === '-n') {
      const n = parseInt(args[++i], 10);
      if (isNaN(n) || n < 0) {
        errHint('--limit must be a non-negative integer');
        process.exitCode = 1;
        return { filter, remaining };
      }
      filter.limit = n;
    } else if (arg === '--json') {
      filter.json = true;
    } else if (arg === '--no-color') {
      filter.noColor = true;
    } else {
      remaining.push(arg);
    }

    i++;
  }

  return { filter, remaining };
}

// ── Subcommands ────────────────────────────────────────────────────────

function readLogFile(logPath: string): { entries: LogEntry[]; content: string } {
  if (!existsSync(logPath)) {
    return { entries: [], content: '' };
  }
  const content = readFileSync(logPath, 'utf-8');
  return { entries: parseLogFile(content), content };
}

function printEntries(entries: LogEntry[], filter: LogFilter): void {
  if (entries.length === 0) {
    console.log('No matching log entries.');
    return;
  }

  for (const entry of entries) {
    if (filter.json) {
      console.log(JSON.stringify(entry));
    } else {
      console.log(formatEntry(entry, filter.noColor));
    }
  }

  if (!filter.json) {
    console.log(`\n${DIM}${entries.length} entries shown${RESET}`);
  }
}

async function cmdShow(logPath: string, filter: LogFilter): Promise<void> {
  const { entries } = readLogFile(logPath);
  const filtered = filterEntries(entries, filter);
  printEntries(filtered, filter);
}

async function cmdTail(logPath: string, filter: LogFilter): Promise<void> {
  if (!existsSync(logPath)) {
    errHint(`Log file not found: ${logPath}`, 'Check the name and try again');
    errHint('Start Ved with logFile configured, then try again.');
    process.exitCode = 1;
    return;
  }

  // Show last few entries first
  const initialFilter = { ...filter, limit: filter.limit || 20 };
  const { entries } = readLogFile(logPath);
  const initial = filterEntries(entries, initialFilter);
  for (const entry of initial) {
    if (filter.json) {
      console.log(JSON.stringify(entry));
    } else {
      console.log(formatEntry(entry, filter.noColor));
    }
  }

  console.log(`${DIM}--- tailing ${logPath} (Ctrl+C to stop) ---${RESET}`);

  // Watch for changes
  let lastSize = statSync(logPath).size;

  const checkForNew = (): void => {
    try {
      const currentSize = statSync(logPath).size;
      if (currentSize <= lastSize) {
        if (currentSize < lastSize) lastSize = 0; // File was truncated
        return;
      }

      // Read only new content
      const fd = require('node:fs').openSync(logPath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      require('node:fs').readSync(fd, buf, 0, buf.length, lastSize);
      require('node:fs').closeSync(fd);

      const newContent = buf.toString('utf-8');
      const newEntries = parseLogFile(newContent);
      const filtered = filterEntries(newEntries, { ...filter, limit: 0 });

      for (const entry of filtered) {
        if (filter.json) {
          console.log(JSON.stringify(entry));
        } else {
          console.log(formatEntry(entry, filter.noColor));
        }
      }

      lastSize = currentSize;
    } catch {
      // File may have been rotated/deleted
    }
  };

  // Poll every 500ms (more reliable than fs.watch across platforms)
  const interval = setInterval(checkForNew, 500);

  // Handle graceful shutdown
  const cleanup = (): void => {
    clearInterval(interval);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Keep alive
  await new Promise<void>(() => {}); // eslint-disable-line @typescript-eslint/no-empty-function
}

async function cmdSearch(logPath: string, query: string, filter: LogFilter): Promise<void> {
  if (!query) {
    errUsage('ved log search <query> [--level <lvl>] [--module <mod>] [--since <t>] [--until <t>] [-n <limit>]');
    process.exitCode = 1;
    return;
  }

  filter.query = query;
  filter.limit = filter.limit === DEFAULT_LIMIT ? 0 : filter.limit; // Default unlimited for search
  const { entries } = readLogFile(logPath);
  const filtered = filterEntries(entries, filter);
  printEntries(filtered, filter);
}

async function cmdStats(logPath: string): Promise<void> {
  const { entries } = readLogFile(logPath);
  const fileSize = existsSync(logPath) ? statSync(logPath).size : 0;
  const stats = computeStats(entries, logPath, fileSize);

  console.log(`📊 Log Statistics`);
  console.log(`  File:      ${stats.filePath}`);
  console.log(`  Size:      ${formatBytes(stats.fileSize)}`);
  console.log(`  Entries:   ${formatNum(stats.totalEntries)}`);
  console.log(`  Errors:    ${stats.errors}`);
  if (stats.firstEntry) {
    console.log(`  First:     ${stats.firstEntry}`);
    console.log(`  Last:      ${stats.lastEntry}`);
  }

  if (Object.keys(stats.byLevel).length > 0) {
    console.log('\n📈 By Level:');
    for (const [level, count] of Object.entries(stats.byLevel).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / stats.totalEntries) * 100).toFixed(1);
      const bar = '█'.repeat(Math.ceil((count / stats.totalEntries) * 30));
      console.log(`  ${level.padEnd(6)} ${formatNum(count).padStart(8)}  ${pct.padStart(5)}%  ${bar}`);
    }
  }

  if (Object.keys(stats.byModule).length > 0) {
    console.log('\n🏗️  By Module:');
    const sorted = Object.entries(stats.byModule).sort((a, b) => b[1] - a[1]);
    for (const [mod, count] of sorted.slice(0, 15)) {
      const pct = ((count / stats.totalEntries) * 100).toFixed(1);
      console.log(`  ${mod.padEnd(20)} ${formatNum(count).padStart(8)}  ${pct.padStart(5)}%`);
    }
    if (sorted.length > 15) {
      console.log(`  ... and ${sorted.length - 15} more modules`);
    }
  }
}

async function cmdLevels(logPath: string): Promise<void> {
  const { entries } = readLogFile(logPath);
  const counts: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const e of entries) {
    counts[e.level] = (counts[e.level] ?? 0) + 1;
  }

  console.log('Log Level Breakdown:');
  for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) {
    const count = counts[level] ?? 0;
    const pct = entries.length > 0 ? ((count / entries.length) * 100).toFixed(1) : '0.0';
    const color = LEVEL_COLORS[level];
    console.log(`  ${color}${level.toUpperCase().padEnd(5)}${RESET}  ${formatNum(count).padStart(8)}  (${pct}%)`);
  }
  console.log(`\n  Total: ${formatNum(entries.length)}`);
}

async function cmdModules(logPath: string): Promise<void> {
  const { entries } = readLogFile(logPath);
  const counts: Record<string, number> = {};
  let noModule = 0;
  for (const e of entries) {
    if (e.module) {
      counts[e.module] = (counts[e.module] ?? 0) + 1;
    } else {
      noModule++;
    }
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  console.log('Log Module Breakdown:');
  for (const [mod, count] of sorted) {
    const pct = ((count / entries.length) * 100).toFixed(1);
    console.log(`  ${mod.padEnd(24)} ${formatNum(count).padStart(8)}  (${pct}%)`);
  }
  if (noModule > 0) {
    console.log(`  ${'(no module)'.padEnd(24)} ${formatNum(noModule).padStart(8)}  (${((noModule / entries.length) * 100).toFixed(1)}%)`);
  }
  console.log(`\n  Total: ${formatNum(entries.length)} entries, ${sorted.length} modules`);
}

async function cmdClear(logPath: string): Promise<void> {
  if (!existsSync(logPath)) {
    console.log('Log file does not exist. Nothing to clear.');
    return;
  }

  const { entries } = readLogFile(logPath);
  writeFileSync(logPath, '', 'utf-8');
  console.log(`Cleared ${formatNum(entries.length)} entries from ${logPath}`);
}

async function cmdPath(logPath: string | null): Promise<void> {
  if (logPath) {
    console.log(logPath);
  } else {
    console.log('No log file configured.');
    console.log('Set logFile in config.yaml or VED_LOG_FILE environment variable.');
    process.exitCode = 1;
  }
}

// ── Main dispatch ──────────────────────────────────────────────────────

export async function logCmd(args: string[]): Promise<void> {
  const { filter, remaining } = parseFlags(args);

  const subcmd = remaining[0] ?? 'show';
  const subArgs = remaining.slice(1);

  // Path is needed for all commands except 'path'
  const logPath = resolveLogPath();

  switch (subcmd) {
    case 'show':
      if (!logPath) return cmdPath(null);
      return cmdShow(logPath, filter);

    case 'tail':
    case 'follow':
    case '-f':
      if (!logPath) return cmdPath(null);
      return cmdTail(logPath, filter);

    case 'search':
    case 'grep':
    case 'find':
      if (!logPath) return cmdPath(null);
      return cmdSearch(logPath, subArgs.join(' '), filter);

    case 'stats':
    case 'info':
      if (!logPath) return cmdPath(null);
      return cmdStats(logPath);

    case 'levels':
      if (!logPath) return cmdPath(null);
      return cmdLevels(logPath);

    case 'modules':
    case 'mods':
      if (!logPath) return cmdPath(null);
      return cmdModules(logPath);

    case 'clear':
    case 'truncate':
      if (!logPath) return cmdPath(null);
      return cmdClear(logPath);

    case 'path':
      return cmdPath(logPath);

    default:
      errHint(`Unknown subcommand: ${subcmd}`, 'Run "ved help" to see available commands');
      errUsage('ved log [show|tail|search|stats|levels|modules|clear|path]');
      process.exitCode = 1;
  }
}
