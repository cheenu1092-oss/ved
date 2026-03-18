/**
 * ved hook — Lifecycle hook manager.
 *
 * Define shell commands or scripts that execute when specific Ved events occur.
 * Hooks subscribe to EventBus event types and run asynchronously.
 *
 * Subcommands:
 *   ved hook                          — List all hooks (default)
 *   ved hook list                     — List all hooks
 *   ved hook add <name> <event> <cmd> — Create a hook
 *   ved hook remove <name>            — Remove a hook
 *   ved hook show <name>              — Show hook details
 *   ved hook edit <name> [flags]      — Update hook properties
 *   ved hook enable <name>            — Enable a disabled hook
 *   ved hook disable <name>           — Disable a hook (keeps config)
 *   ved hook test <name>              — Test-run a hook with synthetic event
 *   ved hook history [name]           — Show execution history
 *   ved hook types                    — List available event types
 *
 * Aliases: ved hooks, ved on, ved trigger
 *
 * @module cli-hook
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { getConfigDir } from './core/config.js';
import { AUDIT_EVENT_TYPES } from './types/index.js';
import type { AuditEventType } from './types/index.js';
import type { EventBus, VedEvent, Subscription } from './event-bus.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface HookEntry {
  /** Unique hook name */
  name: string;
  /** Event type(s) to listen for */
  events: AuditEventType[];
  /** Shell command to execute (receives event JSON on stdin) */
  command: string;
  /** Whether the hook is active */
  enabled: boolean;
  /** Optional description */
  description?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs: number;
  /** Max concurrent executions (default: 1) */
  maxConcurrent: number;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last modification */
  updatedAt: string;
}

export interface HookExecution {
  /** Hook name */
  hookName: string;
  /** Event type that triggered it */
  eventType: AuditEventType;
  /** Event ID that triggered it */
  eventId: string;
  /** ISO timestamp */
  executedAt: string;
  /** Exit code (null if timeout/signal) */
  exitCode: number | null;
  /** Duration in ms */
  durationMs: number;
  /** Stdout (truncated to 4KB) */
  stdout: string;
  /** Stderr (truncated to 4KB) */
  stderr: string;
  /** Success or failure */
  success: boolean;
}

export interface HookStore {
  hooks: HookEntry[];
  history: HookExecution[];
}

// ── Constants ──────────────────────────────────────────────────────────

const HOOK_FILE = 'hooks.yaml';
const HISTORY_FILE = 'hook-history.json';
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_HISTORY = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 1;
const MAX_OUTPUT_BYTES = 4096;

/** Dangerous command patterns blocked for safety */
const BLOCKED_PATTERNS = [
  /\brm\s+(-\w*[rf]\w*\s+)+[/~]/i,      // rm -rf /, rm -rfv /, rm -r -f /
  /\brm\s+--recursive\b/i,               // rm --recursive
  /\brm\s+--force\b/i,                   // rm --force
  /\bsudo\b/i,
  /\b(mkfs|fdisk)\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\//i,
  /:\(\)\s*\{/,  // fork bomb :(){ :|:& };:
];

// ── YAML helpers (minimal, no deps) ────────────────────────────────────

function serializeYaml(store: HookStore): string {
  const lines: string[] = ['hooks:'];
  for (const h of store.hooks) {
    lines.push(`  - name: ${yamlStr(h.name)}`);
    lines.push(`    events:`);
    for (const e of h.events) {
      lines.push(`      - ${e}`);
    }
    lines.push(`    command: ${yamlStr(h.command)}`);
    lines.push(`    enabled: ${h.enabled}`);
    if (h.description) lines.push(`    description: ${yamlStr(h.description)}`);
    lines.push(`    timeoutMs: ${h.timeoutMs}`);
    lines.push(`    maxConcurrent: ${h.maxConcurrent}`);
    lines.push(`    createdAt: ${yamlStr(h.createdAt)}`);
    lines.push(`    updatedAt: ${yamlStr(h.updatedAt)}`);
  }
  return lines.join('\n') + '\n';
}

function yamlStr(s: string): string {
  if (/[:\n"'#{}\[\],&*!|>%@`]/.test(s) || s.trim() !== s) {
    return JSON.stringify(s);
  }
  return s;
}

function parseYaml(content: string): HookStore {
  // Minimal YAML parser for our known structure
  const store: HookStore = { hooks: [], history: [] };
  const lines = content.split('\n');
  let current: Partial<HookEntry> | null = null;
  let inEvents = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.match(/^\s*-\s+name:\s+/)) {
      if (current && current.name) {
        store.hooks.push(finalizeHook(current));
      }
      current = { name: unquote(line.replace(/^\s*-\s+name:\s+/, '')), events: [] };
      inEvents = false;
      continue;
    }

    if (!current) continue;

    if (line.match(/^\s+events:\s*$/)) {
      inEvents = true;
      continue;
    }

    if (inEvents && line.match(/^\s+-\s+\S/)) {
      const event = line.replace(/^\s+-\s+/, '').trim();
      if (AUDIT_EVENT_TYPES.includes(event as AuditEventType)) {
        current.events = current.events || [];
        current.events.push(event as AuditEventType);
      }
      continue;
    }

    if (inEvents && !line.match(/^\s+-/)) {
      inEvents = false;
    }

    const kv = line.match(/^\s+(\w+):\s+(.*)/);
    if (kv) {
      const [, key, val] = kv;
      switch (key) {
        case 'command': current.command = unquote(val); break;
        case 'enabled': current.enabled = val.trim() === 'true'; break;
        case 'description': current.description = unquote(val); break;
        case 'timeoutMs': current.timeoutMs = parseInt(val, 10) || DEFAULT_TIMEOUT_MS; break;
        case 'maxConcurrent': current.maxConcurrent = parseInt(val, 10) || DEFAULT_MAX_CONCURRENT; break;
        case 'createdAt': current.createdAt = unquote(val); break;
        case 'updatedAt': current.updatedAt = unquote(val); break;
      }
    }
  }

  if (current && current.name) {
    store.hooks.push(finalizeHook(current));
  }

  return store;
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  return trimmed;
}

function finalizeHook(partial: Partial<HookEntry>): HookEntry {
  const now = new Date().toISOString();
  return {
    name: partial.name || 'unnamed',
    events: partial.events || [],
    command: partial.command || '',
    enabled: partial.enabled ?? true,
    description: partial.description,
    timeoutMs: partial.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxConcurrent: partial.maxConcurrent || DEFAULT_MAX_CONCURRENT,
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
  };
}

// ── Store I/O ──────────────────────────────────────────────────────────

function resolveConfigDir(): string {
  return process.env.VED_CONFIG_DIR ?? getConfigDir();
}

function getHookPath(): string {
  return join(resolveConfigDir(), HOOK_FILE);
}

function getHistoryPath(): string {
  return join(resolveConfigDir(), HISTORY_FILE);
}

export function loadHooks(): HookStore {
  const path = getHookPath();
  if (!existsSync(path)) return { hooks: [], history: [] };
  try {
    const content = readFileSync(path, 'utf-8');
    const store = parseYaml(content);
    // Load history separately
    store.history = loadHistory();
    return store;
  } catch {
    return { hooks: [], history: [] };
  }
}

function loadHistory(): HookExecution[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveHooks(store: HookStore): void {
  const dir = resolveConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getHookPath(), serializeYaml(store), 'utf-8');
}

function saveHistory(history: HookExecution[]): void {
  const dir = resolveConfigDir();
  mkdirSync(dir, { recursive: true });
  // Keep only last MAX_HISTORY entries
  const trimmed = history.slice(-MAX_HISTORY);
  writeFileSync(getHistoryPath(), JSON.stringify(trimmed, null, 2), 'utf-8');
}

// ── Validation ─────────────────────────────────────────────────────────

export function validateHookName(name: string): string | null {
  if (!name) return 'Hook name is required';
  if (!NAME_REGEX.test(name)) return 'Hook name must start with a letter, contain only alphanumeric/hyphens/underscores, max 64 chars';
  return null;
}

export function validateCommand(command: string): string | null {
  if (!command || !command.trim()) return 'Command is required';
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return `Command blocked for safety: matches dangerous pattern`;
  }
  return null;
}

export function validateEvents(events: string[]): { valid: AuditEventType[]; invalid: string[] } {
  const valid: AuditEventType[] = [];
  const invalid: string[] = [];
  for (const e of events) {
    if (AUDIT_EVENT_TYPES.includes(e as AuditEventType)) {
      valid.push(e as AuditEventType);
    } else {
      invalid.push(e);
    }
  }
  return { valid, invalid };
}

// ── Hook Runtime (EventBus integration) ────────────────────────────────

/** Tracks active concurrent executions per hook */
const activeCounts = new Map<string, number>();

/**
 * Execute a hook's command with event data on stdin.
 * Returns the execution record.
 */
export function executeHook(hook: HookEntry, event: VedEvent): Promise<HookExecution> {
  return new Promise((resolve) => {
    const start = Date.now();
    const eventJson = JSON.stringify(event);

    // Check concurrency limit
    const active = activeCounts.get(hook.name) || 0;
    if (active >= hook.maxConcurrent) {
      resolve({
        hookName: hook.name,
        eventType: event.type,
        eventId: event.id,
        executedAt: new Date().toISOString(),
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: `Skipped: ${active}/${hook.maxConcurrent} concurrent executions`,
        success: false,
      });
      return;
    }

    activeCounts.set(hook.name, active + 1);

    // Set environment variables for the hook
    // Strip null bytes from all values — Node.js rejects them in env vars (TypeError)
    const sanitizeEnv = (s: string): string => s.replace(/\0/g, '');
    const env = {
      ...process.env,
      VED_EVENT_TYPE: sanitizeEnv(event.type),
      VED_EVENT_ID: sanitizeEnv(event.id),
      VED_EVENT_ACTOR: sanitizeEnv(event.actor),
      VED_EVENT_SESSION: sanitizeEnv(event.sessionId || ''),
      VED_EVENT_TIMESTAMP: String(event.timestamp),
    };

    const child = execCb(hook.command, {
      timeout: hook.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      env,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const currentActive = activeCounts.get(hook.name) || 1;
      activeCounts.set(hook.name, Math.max(0, currentActive - 1));

      const result: HookExecution = {
        hookName: hook.name,
        eventType: event.type,
        eventId: event.id,
        executedAt: new Date(start).toISOString(),
        exitCode: error ? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? null : (error as any).status ?? null : 0,
        durationMs,
        stdout: truncate(stdout, MAX_OUTPUT_BYTES),
        stderr: truncate(stderr, MAX_OUTPUT_BYTES),
        success: !error,
      };

      resolve(result);
    });

    // Pipe event JSON to stdin
    if (child.stdin) {
      child.stdin.on('error', () => { /* ignore EPIPE — child may exit before reading stdin */ });
      child.stdin.write(eventJson);
      child.stdin.end();
    }
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…[truncated]';
}

/**
 * HookRunner — subscribes to EventBus and executes matching hooks.
 * Created by VedApp on startup.
 */
export class HookRunner {
  private subscription: Subscription | null = null;
  private store: HookStore;

  constructor(private eventBus: EventBus) {
    this.store = loadHooks();
  }

  /** Start listening for events */
  start(): void {
    if (this.subscription) return;
    this.subscription = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  /** Stop listening */
  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  /** Reload hooks from disk */
  reload(): void {
    this.store = loadHooks();
  }

  private handleEvent(event: VedEvent): void {
    for (const hook of this.store.hooks) {
      if (!hook.enabled) continue;
      if (!hook.events.includes(event.type)) continue;

      // Fire and forget — don't block the event bus
      executeHook(hook, event).then((result) => {
        // Save to history
        const history = loadHistory();
        history.push(result);
        saveHistory(history);
      }).catch(() => {
        // Never crash the event bus
      });
    }
  }
}

// ── CLI Command ────────────────────────────────────────────────────────

export async function hookCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      return listHooks();
    case 'add':
    case 'create':
      return addHook(args.slice(1));
    case 'remove':
    case 'rm':
    case 'delete':
      return removeHook(args.slice(1));
    case 'show':
    case 'info':
      return showHook(args.slice(1));
    case 'edit':
    case 'update':
      return editHook(args.slice(1));
    case 'enable':
      return toggleHook(args.slice(1), true);
    case 'disable':
      return toggleHook(args.slice(1), false);
    case 'test':
    case 'dry-run':
      return testHook(args.slice(1));
    case 'history':
    case 'log':
      return showHistory(args.slice(1));
    case 'types':
    case 'events':
      return listTypes();
    default:
      // Maybe it's a hook name — show it
      const store = loadHooks();
      if (store.hooks.some(h => h.name === sub)) {
        return showHook([sub]);
      }
      console.error(`Unknown hook subcommand: ${sub}`);
      console.error('Run "ved hook --help" for usage.');
      process.exitCode = 1;
  }
}

// ── Subcommands ────────────────────────────────────────────────────────

function listHooks(): void {
  const store = loadHooks();
  if (store.hooks.length === 0) {
    console.log('No hooks configured.');
    console.log('Add one: ved hook add <name> <event> <command>');
    return;
  }

  console.log(`\n  Hooks (${store.hooks.length}):\n`);
  for (const h of store.hooks) {
    const status = h.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
    const events = h.events.join(', ');
    console.log(`  ${status} ${h.name}`);
    console.log(`    Events:  ${events}`);
    console.log(`    Command: ${h.command}`);
    if (h.description) console.log(`    Desc:    ${h.description}`);
    console.log(`    Timeout: ${h.timeoutMs}ms  Concurrency: ${h.maxConcurrent}`);
    console.log();
  }
}

function addHook(args: string[]): void {
  // Parse flags
  let description: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxConcurrent = DEFAULT_MAX_CONCURRENT;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--desc' || args[i] === '--description') {
      description = args[++i];
    } else if (args[i] === '--timeout') {
      timeoutMs = parseInt(args[++i], 10) || DEFAULT_TIMEOUT_MS;
    } else if (args[i] === '--concurrency' || args[i] === '--max-concurrent') {
      maxConcurrent = parseInt(args[++i], 10) || DEFAULT_MAX_CONCURRENT;
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length < 3) {
    console.error('Usage: ved hook add <name> <event[,event2,...]> <command...>');
    console.error('Example: ved hook add notify-slack message_received "curl -X POST https://hooks.slack.com/..."');
    process.exitCode = 1;
    return;
  }

  const [name, eventStr, ...cmdParts] = positional;
  const command = cmdParts.join(' ');

  // Validate name
  const nameErr = validateHookName(name);
  if (nameErr) {
    console.error(`Error: ${nameErr}`);
    process.exitCode = 1;
    return;
  }

  // Validate events
  const eventList = eventStr.split(',').map(e => e.trim()).filter(Boolean);
  const { valid, invalid } = validateEvents(eventList);
  if (invalid.length > 0) {
    console.error(`Unknown event types: ${invalid.join(', ')}`);
    console.error('Run "ved hook types" to see available types.');
    process.exitCode = 1;
    return;
  }
  if (valid.length === 0) {
    console.error('At least one valid event type is required.');
    process.exitCode = 1;
    return;
  }

  // Validate command
  const cmdErr = validateCommand(command);
  if (cmdErr) {
    console.error(`Error: ${cmdErr}`);
    process.exitCode = 1;
    return;
  }

  // Check for duplicate name
  const store = loadHooks();
  if (store.hooks.some(h => h.name === name)) {
    console.error(`Hook "${name}" already exists. Use "ved hook edit" to modify.`);
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  const hook: HookEntry = {
    name,
    events: valid,
    command,
    enabled: true,
    description,
    timeoutMs,
    maxConcurrent,
    createdAt: now,
    updatedAt: now,
  };

  store.hooks.push(hook);
  saveHooks(store);
  console.log(`Hook "${name}" created.`);
  console.log(`  Events:  ${valid.join(', ')}`);
  console.log(`  Command: ${command}`);
}

function removeHook(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved hook remove <name>');
    process.exitCode = 1;
    return;
  }

  const store = loadHooks();
  const idx = store.hooks.findIndex(h => h.name === name);
  if (idx === -1) {
    console.error(`Hook "${name}" not found.`);
    process.exitCode = 1;
    return;
  }

  store.hooks.splice(idx, 1);
  saveHooks(store);
  console.log(`Hook "${name}" removed.`);
}

function showHook(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved hook show <name>');
    process.exitCode = 1;
    return;
  }

  const store = loadHooks();
  const hook = store.hooks.find(h => h.name === name);
  if (!hook) {
    console.error(`Hook "${name}" not found.`);
    process.exitCode = 1;
    return;
  }

  const status = hook.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[90mdisabled\x1b[0m';
  console.log(`\n  Hook: ${hook.name} (${status})`);
  console.log(`  Events:      ${hook.events.join(', ')}`);
  console.log(`  Command:     ${hook.command}`);
  if (hook.description) console.log(`  Description: ${hook.description}`);
  console.log(`  Timeout:     ${hook.timeoutMs}ms`);
  console.log(`  Concurrency: ${hook.maxConcurrent}`);
  console.log(`  Created:     ${hook.createdAt}`);
  console.log(`  Updated:     ${hook.updatedAt}`);

  // Show recent history
  const history = store.history.filter(h => h.hookName === name).slice(-5);
  if (history.length > 0) {
    console.log(`\n  Recent executions:`);
    for (const exec of history) {
      const icon = exec.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`    ${icon} ${exec.eventType} (${exec.durationMs}ms) — ${exec.executedAt}`);
      if (exec.stderr && !exec.success) {
        console.log(`      stderr: ${exec.stderr.split('\n')[0]}`);
      }
    }
  }
  console.log();
}

function editHook(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved hook edit <name> [--events <e1,e2>] [--command <cmd>] [--desc <text>] [--timeout <ms>] [--concurrency <n>]');
    process.exitCode = 1;
    return;
  }

  const store = loadHooks();
  const hook = store.hooks.find(h => h.name === name);
  if (!hook) {
    console.error(`Hook "${name}" not found.`);
    process.exitCode = 1;
    return;
  }

  let changed = false;
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--events': {
        const eventList = (args[++i] || '').split(',').map(e => e.trim()).filter(Boolean);
        const { valid, invalid } = validateEvents(eventList);
        if (invalid.length > 0) {
          console.error(`Unknown event types: ${invalid.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        if (valid.length === 0) {
          console.error('At least one valid event type is required.');
          process.exitCode = 1;
          return;
        }
        hook.events = valid;
        changed = true;
        break;
      }
      case '--command': case '--cmd': {
        const cmd = args.slice(i + 1).join(' ');
        const err = validateCommand(cmd);
        if (err) {
          console.error(`Error: ${err}`);
          process.exitCode = 1;
          return;
        }
        hook.command = cmd;
        changed = true;
        i = args.length; // consume rest
        break;
      }
      case '--desc': case '--description':
        hook.description = args[++i];
        changed = true;
        break;
      case '--timeout':
        hook.timeoutMs = parseInt(args[++i], 10) || DEFAULT_TIMEOUT_MS;
        changed = true;
        break;
      case '--concurrency': case '--max-concurrent':
        hook.maxConcurrent = parseInt(args[++i], 10) || DEFAULT_MAX_CONCURRENT;
        changed = true;
        break;
    }
  }

  if (!changed) {
    console.error('No changes specified. Use flags: --events, --command, --desc, --timeout, --concurrency');
    process.exitCode = 1;
    return;
  }

  hook.updatedAt = new Date().toISOString();
  saveHooks(store);
  console.log(`Hook "${name}" updated.`);
}

function toggleHook(args: string[], enable: boolean): void {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ved hook ${enable ? 'enable' : 'disable'} <name>`);
    process.exitCode = 1;
    return;
  }

  const store = loadHooks();
  const hook = store.hooks.find(h => h.name === name);
  if (!hook) {
    console.error(`Hook "${name}" not found.`);
    process.exitCode = 1;
    return;
  }

  if (hook.enabled === enable) {
    console.log(`Hook "${name}" is already ${enable ? 'enabled' : 'disabled'}.`);
    return;
  }

  hook.enabled = enable;
  hook.updatedAt = new Date().toISOString();
  saveHooks(store);
  console.log(`Hook "${name}" ${enable ? 'enabled' : 'disabled'}.`);
}

async function testHook(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved hook test <name>');
    process.exitCode = 1;
    return;
  }

  const store = loadHooks();
  const hook = store.hooks.find(h => h.name === name);
  if (!hook) {
    console.error(`Hook "${name}" not found.`);
    process.exitCode = 1;
    return;
  }

  // Create synthetic event
  const event: VedEvent = {
    id: 'test_' + Date.now(),
    timestamp: Date.now(),
    type: hook.events[0] || 'message_received',
    actor: 'ved-test',
    sessionId: 'test-session',
    detail: { test: true, hookName: name },
    hash: 'test_hash_' + Date.now().toString(36),
  };

  console.log(`Testing hook "${name}"...`);
  console.log(`  Event: ${event.type} (synthetic)`);
  console.log(`  Command: ${hook.command}`);
  console.log();

  const result = await executeHook(hook, event);

  if (result.success) {
    console.log(`\x1b[32m✓ Success\x1b[0m (${result.durationMs}ms, exit ${result.exitCode})`);
  } else {
    console.log(`\x1b[31m✗ Failed\x1b[0m (${result.durationMs}ms, exit ${result.exitCode})`);
  }
  if (result.stdout) {
    console.log(`\n  stdout:\n${indent(result.stdout, 4)}`);
  }
  if (result.stderr) {
    console.log(`\n  stderr:\n${indent(result.stderr, 4)}`);
  }
}

function showHistory(args: string[]): void {
  const name = args[0]; // optional filter
  let limit = 20;

  // Parse --limit flag
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' || args[i] === '-n') {
      limit = parseInt(args[i + 1], 10) || 20;
    }
  }

  const history = loadHistory();
  const filtered = name
    ? history.filter(h => h.hookName === name)
    : history;

  if (filtered.length === 0) {
    console.log(name ? `No execution history for hook "${name}".` : 'No execution history.');
    return;
  }

  const recent = filtered.slice(-limit);
  console.log(`\n  Hook execution history (${recent.length}/${filtered.length}):\n`);

  for (const exec of recent) {
    const icon = exec.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const exit = exec.exitCode !== null ? `exit ${exec.exitCode}` : 'killed';
    console.log(`  ${icon} ${exec.hookName} ← ${exec.eventType}`);
    console.log(`    ${exec.executedAt} (${exec.durationMs}ms, ${exit})`);
    if (exec.stderr && !exec.success) {
      console.log(`    stderr: ${exec.stderr.split('\n')[0]}`);
    }
  }
  console.log();
}

function listTypes(): void {
  console.log('\n  Available event types:\n');

  // Group by prefix
  const groups = new Map<string, string[]>();
  for (const t of AUDIT_EVENT_TYPES) {
    const prefix = t.split('_')[0];
    const group = groups.get(prefix) || [];
    group.push(t);
    groups.set(prefix, group);
  }

  for (const [prefix, types] of groups) {
    console.log(`  ${prefix}:`);
    for (const t of types) {
      console.log(`    ${t}`);
    }
    console.log();
  }
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s.split('\n').map(l => pad + l).join('\n');
}
