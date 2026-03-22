/**
 * ved notify — Notification rules manager.
 *
 * Define notification rules that alert you when specific events occur.
 * Supports multiple delivery channels: terminal (bell/banner), desktop
 * (macOS/Linux), email (sendmail/SMTP), and custom commands.
 *
 * Subcommands:
 *   ved notify                                — List all rules (default)
 *   ved notify list                           — List all rules
 *   ved notify add <name> <events> <channel>  — Create a rule
 *   ved notify remove <name>                  — Remove a rule
 *   ved notify show <name>                    — Show rule details
 *   ved notify edit <name> [flags]            — Update rule properties
 *   ved notify enable <name>                  — Enable a disabled rule
 *   ved notify disable <name>                 — Disable a rule
 *   ved notify test <name>                    — Test-fire a rule
 *   ved notify history [name]                 — Show delivery history
 *   ved notify channels                       — List available channels
 *   ved notify mute [duration]                — Mute all notifications
 *   ved notify unmute                         — Unmute notifications
 *
 * Channels:
 *   terminal  — Bell character + colored banner in terminal
 *   desktop   — Native OS notification (macOS osascript / Linux notify-send)
 *   command   — Custom shell command (event JSON on stdin)
 *   log       — Append to notification log file
 *
 * Aliases: ved notifications, ved alert, ved alerts
 *
 * @module cli-notify
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { platform } from 'node:os';
import { getConfigDir } from './core/config.js';
import { AUDIT_EVENT_TYPES } from './types/index.js';
import type { AuditEventType } from './types/index.js';
import type { EventBus, VedEvent, Subscription } from './event-bus.js';

// ── Types ──────────────────────────────────────────────────────────────

export type NotifyChannel = 'terminal' | 'desktop' | 'command' | 'log';

export const NOTIFY_CHANNELS: NotifyChannel[] = ['terminal', 'desktop', 'command', 'log'];

export interface NotifyRule {
  /** Unique rule name */
  name: string;
  /** Event types to match */
  events: AuditEventType[];
  /** Delivery channel */
  channel: NotifyChannel;
  /** Whether the rule is active */
  enabled: boolean;
  /** Optional description */
  description?: string;
  /** Custom command (for 'command' channel) */
  command?: string;
  /** Log file path (for 'log' channel, default: ~/.ved/notifications.log) */
  logPath?: string;
  /** Title template (supports {type}, {actor}, {session}) */
  title?: string;
  /** Body template (supports {type}, {actor}, {session}, {detail}) */
  body?: string;
  /** Throttle: min ms between notifications for same rule (default: 0 = no throttle) */
  throttleMs: number;
  /** Quiet hours start (HH:MM, 24h format) */
  quietStart?: string;
  /** Quiet hours end (HH:MM, 24h format) */
  quietEnd?: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last modification */
  updatedAt: string;
}

export interface NotifyDelivery {
  /** Rule name */
  ruleName: string;
  /** Event type that triggered it */
  eventType: AuditEventType;
  /** Channel used */
  channel: NotifyChannel;
  /** Whether delivery succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** ISO timestamp */
  timestamp: string;
  /** Whether it was suppressed (throttle/mute/quiet hours) */
  suppressed?: boolean;
  /** Reason for suppression */
  suppressReason?: string;
}

// ── Storage ────────────────────────────────────────────────────────────

const RULES_FILE = 'notify-rules.yaml';
const HISTORY_FILE = 'notify-history.json';
const MUTE_FILE = 'notify-mute.json';
const MAX_HISTORY = 500;

function getRulesPath(): string {
  return join(getConfigDir(), RULES_FILE);
}

function getHistoryPath(): string {
  return join(getConfigDir(), HISTORY_FILE);
}

function getMutePath(): string {
  return join(getConfigDir(), MUTE_FILE);
}

export function loadRules(): NotifyRule[] {
  const path = getRulesPath();
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8');
  return parseYamlRules(content);
}

export function saveRules(rules: NotifyRule[]): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getRulesPath(), serializeYamlRules(rules), 'utf-8');
}

export function loadHistory(): NotifyDelivery[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistory(history: NotifyDelivery[]): void {
  const trimmed = history.slice(-MAX_HISTORY);
  writeFileSync(getHistoryPath(), JSON.stringify(trimmed, null, 2), 'utf-8');
}

function appendHistory(entry: NotifyDelivery): void {
  const history = loadHistory();
  history.push(entry);
  saveHistory(history);
}

// ── Mute State ─────────────────────────────────────────────────────────

interface MuteState {
  muted: boolean;
  until?: string; // ISO timestamp
  reason?: string;
}

export function loadMuteState(): MuteState {
  const path = getMutePath();
  if (!existsSync(path)) return { muted: false };
  try {
    const state: MuteState = JSON.parse(readFileSync(path, 'utf-8'));
    // Auto-unmute if past expiry
    if (state.muted && state.until) {
      if (new Date(state.until).getTime() < Date.now()) {
        saveMuteState({ muted: false });
        return { muted: false };
      }
    }
    return state;
  } catch {
    return { muted: false };
  }
}

function saveMuteState(state: MuteState): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getMutePath(), JSON.stringify(state, null, 2), 'utf-8');
}

// ── YAML Parser/Serializer (simple, no deps) ──────────────────────────

function parseYamlRules(content: string): NotifyRule[] {
  // Simple YAML-like parser for our flat rule structure
  const rules: NotifyRule[] = [];
  let current: Partial<NotifyRule> | null = null;
  let inEvents = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      inEvents = false;
      continue;
    }

    // Top-level list item: "- name: foo"
    if (line.startsWith('- name:')) {
      if (current && current.name) {
        rules.push(finalizeRule(current));
      }
      current = { name: line.replace('- name:', '').trim() };
      inEvents = false;
      continue;
    }

    if (!current) continue;

    if (trimmed.startsWith('events:')) {
      inEvents = true;
      // Check inline: "events: [a, b]"
      const inline = trimmed.replace('events:', '').trim();
      if (inline.startsWith('[')) {
        current.events = inline.slice(1, -1).split(',').map(s => s.trim()) as AuditEventType[];
        inEvents = false;
      } else {
        current.events = [];
      }
      continue;
    }

    if (inEvents && trimmed.startsWith('- ')) {
      if (!current.events) current.events = [];
      current.events.push(trimmed.slice(2).trim() as AuditEventType);
      continue;
    }

    inEvents = false;

    // Key-value pairs
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      switch (key) {
        case 'channel': current.channel = value as NotifyChannel; break;
        case 'enabled': current.enabled = value === 'true'; break;
        case 'description': current.description = value || undefined; break;
        case 'command': current.command = value || undefined; break;
        case 'logPath': current.logPath = value || undefined; break;
        case 'title': current.title = value || undefined; break;
        case 'body': current.body = value || undefined; break;
        case 'throttleMs': current.throttleMs = parseInt(value, 10) || 0; break;
        case 'quietStart': current.quietStart = value || undefined; break;
        case 'quietEnd': current.quietEnd = value || undefined; break;
        case 'createdAt': current.createdAt = value; break;
        case 'updatedAt': current.updatedAt = value; break;
      }
    }
  }

  if (current && current.name) {
    rules.push(finalizeRule(current));
  }
  return rules;
}

function finalizeRule(partial: Partial<NotifyRule>): NotifyRule {
  const now = new Date().toISOString();
  return {
    name: partial.name || 'unnamed',
    events: partial.events || [],
    channel: partial.channel || 'terminal',
    enabled: partial.enabled !== false,
    description: partial.description,
    command: partial.command,
    logPath: partial.logPath,
    title: partial.title,
    body: partial.body,
    throttleMs: partial.throttleMs || 0,
    quietStart: partial.quietStart,
    quietEnd: partial.quietEnd,
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
  };
}

function serializeYamlRules(rules: NotifyRule[]): string {
  return rules.map(r => {
    const lines: string[] = [`- name: ${r.name}`];
    if (r.events.length <= 3) {
      lines.push(`  events: [${r.events.join(', ')}]`);
    } else {
      lines.push('  events:');
      for (const e of r.events) lines.push(`    - ${e}`);
    }
    lines.push(`  channel: ${r.channel}`);
    lines.push(`  enabled: ${r.enabled}`);
    if (r.description) lines.push(`  description: "${r.description}"`);
    if (r.command) lines.push(`  command: "${r.command}"`);
    if (r.logPath) lines.push(`  logPath: "${r.logPath}"`);
    if (r.title) lines.push(`  title: "${r.title}"`);
    if (r.body) lines.push(`  body: "${r.body}"`);
    if (r.throttleMs > 0) lines.push(`  throttleMs: ${r.throttleMs}`);
    if (r.quietStart) lines.push(`  quietStart: ${r.quietStart}`);
    if (r.quietEnd) lines.push(`  quietEnd: ${r.quietEnd}`);
    lines.push(`  createdAt: ${r.createdAt}`);
    lines.push(`  updatedAt: ${r.updatedAt}`);
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

// ── Name Validation ────────────────────────────────────────────────────

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const RESERVED_NAMES = new Set([
  'list', 'add', 'remove', 'show', 'edit', 'enable', 'disable',
  'test', 'history', 'channels', 'mute', 'unmute', 'help',
]);

export function validateRuleName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return 'Name must start with a letter, contain only letters/numbers/hyphens/underscores, max 64 chars.';
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return `"${name}" is a reserved subcommand name.`;
  }
  return null;
}

// ── Template Rendering ─────────────────────────────────────────────────

export function renderTemplate(template: string, event: VedEvent): string {
  return template
    .replace(/\{type\}/g, event.type)
    .replace(/\{actor\}/g, event.actor || 'system')
    .replace(/\{session\}/g, event.sessionId || 'none')
    .replace(/\{detail\}/g, JSON.stringify(event.detail))
    .replace(/\{id\}/g, event.id)
    .replace(/\{timestamp\}/g, new Date(event.timestamp).toISOString());
}

// ── Quiet Hours Check ──────────────────────────────────────────────────

export function isInQuietHours(quietStart?: string, quietEnd?: string): boolean {
  if (!quietStart || !quietEnd) return false;

  // Validate HH:MM format
  const timeRe = /^\d{1,2}:\d{2}$/;
  if (!timeRe.test(quietStart) || !timeRe.test(quietEnd)) return false;

  const now = new Date();
  const [startH, startM] = quietStart.split(':').map(Number);
  const [endH, endM] = quietEnd.split(':').map(Number);

  // Validate ranges
  if (startH > 23 || startM > 59 || endH > 23 || endM > 59) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same day: e.g., 22:00 - 23:00
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Overnight: e.g., 22:00 - 07:00
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}

// ── Delivery Channels ──────────────────────────────────────────────────

function execPromise(cmd: string, stdin?: string, timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = execCb(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

export async function deliverTerminal(title: string, body: string): Promise<void> {
  // Bell + colored banner
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const blue = '\x1b[34m';
  const yellow = '\x1b[33m';
  process.stdout.write(`\x07`); // bell
  process.stdout.write(`\n${blue}${bold}🔔 ${title}${reset}\n`);
  if (body) process.stdout.write(`${yellow}   ${body}${reset}\n`);
}

export async function deliverDesktop(title: string, body: string): Promise<void> {
  const os = platform();
  if (os === 'darwin') {
    // macOS: osascript
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedBody = body.replace(/"/g, '\\"');
    await execPromise(
      `osascript -e 'display notification "${escapedBody}" with title "Ved" subtitle "${escapedTitle}"'`
    );
  } else if (os === 'linux') {
    // Linux: notify-send
    await execPromise(`notify-send "Ved: ${title}" "${body}"`);
  } else {
    throw new Error(`Desktop notifications not supported on ${os}`);
  }
}

export async function deliverCommand(command: string, event: VedEvent, timeoutMs = 30000): Promise<void> {
  // Validate command (reuse dangerous command detection from hooks)
  const dangerousPatterns = [
    /\brm\s+-rf?\s+\//i,
    /\bsudo\b/i,
    /\bdd\s+if=/i,
    /:\(\)\{.*\|.*&\s*\};/,  // fork bomb
    /\bmkfs\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      throw new Error(`Blocked dangerous command: ${command}`);
    }
  }

  await execPromise(command, JSON.stringify(event), timeoutMs);
}

export async function deliverLog(logPath: string, title: string, body: string, event: VedEvent): Promise<void> {
  const ts = new Date(event.timestamp).toISOString();
  const line = `[${ts}] [${event.type}] ${title}: ${body}\n`;
  appendFileSync(logPath, line, 'utf-8');
}

// ── NotifyRunner (runtime integration) ─────────────────────────────────

export class NotifyRunner {
  private subscription: Subscription | null = null;
  private lastFired: Map<string, number> = new Map();
  private deliveryCount = 0;
  private suppressCount = 0;

  constructor(private bus: EventBus) {}

  /** Start listening. Loads rules and subscribes to all events. */
  start(): void {
    if (this.subscription) return;
    this.subscription = this.bus.subscribe((event) => {
      // Fire-and-forget — don't block the event bus
      void this.processEvent(event);
    });
  }

  /** Stop listening. */
  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  /** Get delivery stats. */
  stats(): { deliveryCount: number; suppressCount: number; active: boolean } {
    return {
      deliveryCount: this.deliveryCount,
      suppressCount: this.suppressCount,
      active: this.subscription !== null,
    };
  }

  /** Process an event against all rules. */
  async processEvent(event: VedEvent): Promise<void> {
    const rules = loadRules();
    const muteState = loadMuteState();

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!rule.events.includes(event.type)) continue;

      // Check global mute
      if (muteState.muted) {
        this.recordSuppressed(rule, event, 'muted');
        this.suppressCount++;
        continue;
      }

      // Check quiet hours
      if (isInQuietHours(rule.quietStart, rule.quietEnd)) {
        this.recordSuppressed(rule, event, 'quiet_hours');
        this.suppressCount++;
        continue;
      }

      // Check throttle
      if (rule.throttleMs > 0) {
        const lastTime = this.lastFired.get(rule.name) || 0;
        if (Date.now() - lastTime < rule.throttleMs) {
          this.recordSuppressed(rule, event, 'throttled');
          this.suppressCount++;
          continue;
        }
      }

      // Deliver
      const title = rule.title
        ? renderTemplate(rule.title, event)
        : `${event.type}`;
      const body = rule.body
        ? renderTemplate(rule.body, event)
        : `Actor: ${event.actor || 'system'}`;

      try {
        switch (rule.channel) {
          case 'terminal':
            await deliverTerminal(title, body);
            break;
          case 'desktop':
            await deliverDesktop(title, body);
            break;
          case 'command':
            if (!rule.command) throw new Error('No command configured for command channel');
            await deliverCommand(rule.command, event);
            break;
          case 'log': {
            const logPath = rule.logPath || join(getConfigDir(), 'notifications.log');
            await deliverLog(logPath, title, body, event);
            break;
          }
        }
        this.lastFired.set(rule.name, Date.now());
        this.deliveryCount++;
        this.recordDelivery(rule, event, true);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.recordDelivery(rule, event, false, errMsg);
      }
    }
  }

  private recordDelivery(rule: NotifyRule, event: VedEvent, success: boolean, error?: string): void {
    appendHistory({
      ruleName: rule.name,
      eventType: event.type,
      channel: rule.channel,
      success,
      error,
      timestamp: new Date().toISOString(),
    });
  }

  private recordSuppressed(rule: NotifyRule, event: VedEvent, reason: string): void {
    appendHistory({
      ruleName: rule.name,
      eventType: event.type,
      channel: rule.channel,
      success: false,
      suppressed: true,
      suppressReason: reason,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── CLI Command ────────────────────────────────────────────────────────

export async function notifyCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      return listRules();
    case 'add':
    case 'create':
      return addRule(args.slice(1));
    case 'remove':
    case 'rm':
    case 'delete':
      return removeRule(args.slice(1));
    case 'show':
    case 'info':
      return showRule(args.slice(1));
    case 'edit':
    case 'update':
      return editRule(args.slice(1));
    case 'enable':
      return toggleRule(args.slice(1), true);
    case 'disable':
      return toggleRule(args.slice(1), false);
    case 'test':
      return testRule(args.slice(1));
    case 'history':
      return showHistory(args.slice(1));
    case 'channels':
      return listChannels();
    case 'mute':
      return muteNotifications(args.slice(1));
    case 'unmute':
      return unmuteNotifications();
    default:
      // Check if it's a rule name (implicit show)
      const rules = loadRules();
      if (rules.find(r => r.name === sub)) {
        return showRule([sub]);
      }
      console.error(`Unknown subcommand: ${sub}`);
      console.log('Run `ved notify --help` for usage.');
      process.exit(1);
  }
}

// ── Subcommand Implementations ─────────────────────────────────────────

function listRules(): void {
  const rules = loadRules();
  const muteState = loadMuteState();

  if (muteState.muted) {
    const until = muteState.until ? ` until ${muteState.until}` : '';
    console.log(`\x1b[33m🔇 Notifications muted${until}\x1b[0m\n`);
  }

  if (rules.length === 0) {
    console.log('No notification rules configured.');
    console.log('Run `ved notify add <name> <events> <channel>` to create one.');
    return;
  }

  console.log(`Notification Rules (${rules.length}):\n`);
  for (const rule of rules) {
    const status = rule.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
    const events = rule.events.length <= 2
      ? rule.events.join(', ')
      : `${rule.events[0]} +${rule.events.length - 1} more`;
    const throttle = rule.throttleMs > 0 ? ` (${rule.throttleMs}ms throttle)` : '';
    const quiet = rule.quietStart ? ` 🌙 ${rule.quietStart}-${rule.quietEnd}` : '';
    console.log(`  ${status} ${rule.name} → ${rule.channel} [${events}]${throttle}${quiet}`);
    if (rule.description) {
      console.log(`    ${rule.description}`);
    }
  }
}

function addRule(args: string[]): void {
  // Parse flags
  let name = '';
  let events: string[] = [];
  let channel: NotifyChannel = 'terminal';
  let description: string | undefined;
  let command: string | undefined;
  let logPath: string | undefined;
  let title: string | undefined;
  let body: string | undefined;
  let throttleMs = 0;
  let quietStart: string | undefined;
  let quietEnd: string | undefined;

  let i = 0;
  // First positional: name
  if (i < args.length && !args[i].startsWith('--')) {
    name = args[i++];
  }
  // Second positional: events (comma-separated)
  if (i < args.length && !args[i].startsWith('--')) {
    events = args[i++].split(',').map(s => s.trim());
  }
  // Third positional: channel
  if (i < args.length && !args[i].startsWith('--')) {
    channel = args[i++] as NotifyChannel;
  }

  // Named flags
  while (i < args.length) {
    const flag = args[i++];
    switch (flag) {
      case '--name': name = args[i++] || ''; break;
      case '--events': events = (args[i++] || '').split(',').map(s => s.trim()); break;
      case '--channel': channel = (args[i++] || 'terminal') as NotifyChannel; break;
      case '--description': case '--desc': description = args[i++]; break;
      case '--command': case '--cmd': command = args[i++]; break;
      case '--log-path': logPath = args[i++]; break;
      case '--title': title = args[i++]; break;
      case '--body': body = args[i++]; break;
      case '--throttle': throttleMs = parseInt(args[i++] || '0', 10); break;
      case '--quiet-start': quietStart = args[i++]; break;
      case '--quiet-end': quietEnd = args[i++]; break;
    }
  }

  if (!name) {
    console.error('Usage: ved notify add <name> <events> <channel> [flags]');
    process.exit(1);
  }

  // Validate name
  const nameError = validateRuleName(name);
  if (nameError) {
    console.error(`Invalid name: ${nameError}`);
    process.exit(1);
  }

  // Validate events
  if (events.length === 0) {
    console.error('At least one event type is required.');
    console.log(`Available: ${AUDIT_EVENT_TYPES.join(', ')}`);
    process.exit(1);
  }
  for (const e of events) {
    if (!AUDIT_EVENT_TYPES.includes(e as AuditEventType)) {
      console.error(`Unknown event type: ${e}`);
      console.log(`Available: ${AUDIT_EVENT_TYPES.join(', ')}`);
      process.exit(1);
    }
  }

  // Validate channel
  if (!NOTIFY_CHANNELS.includes(channel)) {
    console.error(`Unknown channel: ${channel}. Available: ${NOTIFY_CHANNELS.join(', ')}`);
    process.exit(1);
  }

  // Channel-specific validation
  if (channel === 'command' && !command) {
    console.error('Command channel requires --command flag.');
    process.exit(1);
  }

  // Check duplicate
  const rules = loadRules();
  if (rules.find(r => r.name === name)) {
    console.error(`Rule "${name}" already exists. Use 'ved notify edit' to modify.`);
    process.exit(1);
  }

  // Validate quiet hours format
  if (quietStart && !/^\d{2}:\d{2}$/.test(quietStart)) {
    console.error('Quiet start must be HH:MM format (e.g., 22:00)');
    process.exit(1);
  }
  if (quietEnd && !/^\d{2}:\d{2}$/.test(quietEnd)) {
    console.error('Quiet end must be HH:MM format (e.g., 07:00)');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const rule: NotifyRule = {
    name,
    events: events as AuditEventType[],
    channel,
    enabled: true,
    description,
    command,
    logPath,
    title,
    body,
    throttleMs,
    quietStart,
    quietEnd,
    createdAt: now,
    updatedAt: now,
  };

  rules.push(rule);
  saveRules(rules);
  console.log(`✅ Rule "${name}" created (${channel}, ${events.length} event${events.length === 1 ? '' : 's'}).`);
}

function removeRule(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved notify remove <name>');
    process.exit(1);
  }

  const rules = loadRules();
  const idx = rules.findIndex(r => r.name === name);
  if (idx === -1) {
    console.error(`Rule "${name}" not found.`);
    process.exit(1);
  }

  rules.splice(idx, 1);
  saveRules(rules);
  console.log(`✅ Rule "${name}" removed.`);
}

function showRule(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved notify show <name>');
    process.exit(1);
  }

  const rules = loadRules();
  const rule = rules.find(r => r.name === name);
  if (!rule) {
    console.error(`Rule "${name}" not found.`);
    process.exit(1);
  }

  console.log(`\nRule: ${rule.name}`);
  console.log(`  Status:   ${rule.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[31mdisabled\x1b[0m'}`);
  console.log(`  Channel:  ${rule.channel}`);
  console.log(`  Events:   ${rule.events.join(', ')}`);
  if (rule.description) console.log(`  Description: ${rule.description}`);
  if (rule.command) console.log(`  Command:  ${rule.command}`);
  if (rule.logPath) console.log(`  Log path: ${rule.logPath}`);
  if (rule.title) console.log(`  Title:    ${rule.title}`);
  if (rule.body) console.log(`  Body:     ${rule.body}`);
  if (rule.throttleMs > 0) console.log(`  Throttle: ${rule.throttleMs}ms`);
  if (rule.quietStart) console.log(`  Quiet:    ${rule.quietStart} - ${rule.quietEnd}`);
  console.log(`  Created:  ${rule.createdAt}`);
  console.log(`  Updated:  ${rule.updatedAt}`);

  // Show recent history
  const history = loadHistory().filter(h => h.ruleName === name);
  if (history.length > 0) {
    const recent = history.slice(-5);
    console.log(`\n  Recent deliveries (${history.length} total):`);
    for (const h of recent) {
      const status = h.suppressed
        ? `\x1b[33m⏸ ${h.suppressReason}\x1b[0m`
        : h.success
          ? '\x1b[32m✓\x1b[0m'
          : `\x1b[31m✗ ${h.error}\x1b[0m`;
      console.log(`    ${status} ${h.eventType} @ ${h.timestamp}`);
    }
  }
}

function editRule(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved notify edit <name> [flags]');
    process.exit(1);
  }

  const rules = loadRules();
  const rule = rules.find(r => r.name === name);
  if (!rule) {
    console.error(`Rule "${name}" not found.`);
    process.exit(1);
  }

  let changed = false;
  let i = 1;
  while (i < args.length) {
    const flag = args[i++];
    switch (flag) {
      case '--events':
        rule.events = (args[i++] || '').split(',').map(s => s.trim()) as AuditEventType[];
        changed = true;
        break;
      case '--channel':
        rule.channel = (args[i++] || 'terminal') as NotifyChannel;
        changed = true;
        break;
      case '--description': case '--desc':
        rule.description = args[i++];
        changed = true;
        break;
      case '--command': case '--cmd':
        rule.command = args[i++];
        changed = true;
        break;
      case '--log-path':
        rule.logPath = args[i++];
        changed = true;
        break;
      case '--title':
        rule.title = args[i++];
        changed = true;
        break;
      case '--body':
        rule.body = args[i++];
        changed = true;
        break;
      case '--throttle':
        rule.throttleMs = parseInt(args[i++] || '0', 10);
        changed = true;
        break;
      case '--quiet-start':
        rule.quietStart = args[i++];
        changed = true;
        break;
      case '--quiet-end':
        rule.quietEnd = args[i++];
        changed = true;
        break;
    }
  }

  if (!changed) {
    console.log('No changes specified. Use flags like --events, --channel, --throttle, etc.');
    return;
  }

  rule.updatedAt = new Date().toISOString();
  saveRules(rules);
  console.log(`✅ Rule "${name}" updated.`);
}

function toggleRule(args: string[], enable: boolean): void {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ved notify ${enable ? 'enable' : 'disable'} <name>`);
    process.exit(1);
  }

  const rules = loadRules();
  const rule = rules.find(r => r.name === name);
  if (!rule) {
    console.error(`Rule "${name}" not found.`);
    process.exit(1);
  }

  if (rule.enabled === enable) {
    console.log(`Rule "${name}" is already ${enable ? 'enabled' : 'disabled'}.`);
    return;
  }

  rule.enabled = enable;
  rule.updatedAt = new Date().toISOString();
  saveRules(rules);
  console.log(`✅ Rule "${name}" ${enable ? 'enabled' : 'disabled'}.`);
}

async function testRule(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved notify test <name>');
    process.exit(1);
  }

  const rules = loadRules();
  const rule = rules.find(r => r.name === name);
  if (!rule) {
    console.error(`Rule "${name}" not found.`);
    process.exit(1);
  }

  const eventType = rule.events[0] || 'message_received';
  const syntheticEvent: VedEvent = {
    id: `test_${Date.now()}`,
    timestamp: Date.now(),
    type: eventType,
    actor: 'test-user',
    sessionId: 'test-session',
    detail: { test: true, source: 'ved notify test' },
    hash: 'test-hash-' + Date.now().toString(36),
  };

  const title = rule.title
    ? renderTemplate(rule.title, syntheticEvent)
    : `${syntheticEvent.type}`;
  const body = rule.body
    ? renderTemplate(rule.body, syntheticEvent)
    : `Actor: ${syntheticEvent.actor}`;

  console.log(`Testing rule "${name}" (${rule.channel})...`);

  try {
    switch (rule.channel) {
      case 'terminal':
        await deliverTerminal(title, body);
        break;
      case 'desktop':
        await deliverDesktop(title, body);
        break;
      case 'command':
        if (!rule.command) throw new Error('No command configured');
        await deliverCommand(rule.command, syntheticEvent);
        break;
      case 'log': {
        const logPath = rule.logPath || join(getConfigDir(), 'notifications.log');
        await deliverLog(logPath, title, body, syntheticEvent);
        console.log(`  Logged to: ${logPath}`);
        break;
      }
    }
    console.log('✅ Test delivery succeeded.');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Test delivery failed: ${errMsg}`);
  }
}

function showHistory(args: string[]): void {
  const name = args[0]; // optional filter
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(args[limitFlag + 1] || '20', 10) : 20;

  let history = loadHistory();
  if (name) {
    history = history.filter(h => h.ruleName === name);
  }

  if (history.length === 0) {
    console.log(name ? `No history for rule "${name}".` : 'No notification history.');
    return;
  }

  const shown = history.slice(-limit);
  console.log(`Notification History (${shown.length}/${history.length}):\n`);

  for (const h of shown) {
    const status = h.suppressed
      ? `\x1b[33m⏸ ${h.suppressReason}\x1b[0m`
      : h.success
        ? '\x1b[32m✓\x1b[0m'
        : `\x1b[31m✗ ${h.error || 'unknown'}\x1b[0m`;
    const ts = new Date(h.timestamp).toLocaleString();
    console.log(`  ${status} [${h.ruleName}] ${h.eventType} via ${h.channel} @ ${ts}`);
  }
}

function listChannels(): void {
  console.log('Available notification channels:\n');
  console.log('  terminal  — Bell character + colored banner in terminal');
  console.log('  desktop   — Native OS notification (macOS/Linux)');
  console.log('  command   — Custom shell command (event JSON on stdin)');
  console.log('  log       — Append to notification log file');
  console.log('\nUsage: ved notify add <name> <events> <channel>');
}

function muteNotifications(args: string[]): void {
  const duration = args[0]; // e.g., "1h", "30m", "2h", or empty for indefinite

  let until: string | undefined;
  if (duration) {
    const match = duration.match(/^(\d+)(m|h|d)$/);
    if (!match) {
      console.error('Duration must be like: 30m, 1h, 2d (or omit for indefinite)');
      process.exit(1);
    }
    const num = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === 'm' ? num * 60000 : unit === 'h' ? num * 3600000 : num * 86400000;
    until = new Date(Date.now() + ms).toISOString();
  }

  saveMuteState({ muted: true, until });
  if (until) {
    console.log(`🔇 Notifications muted until ${until}`);
  } else {
    console.log('🔇 Notifications muted indefinitely. Run `ved notify unmute` to resume.');
  }
}

function unmuteNotifications(): void {
  saveMuteState({ muted: false });
  console.log('🔔 Notifications unmuted.');
}
