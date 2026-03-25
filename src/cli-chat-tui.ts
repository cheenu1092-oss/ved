/**
 * `ved chat` — Upgraded TUI version.
 *
 * Enhancements over cli-chat.ts:
 *   - Real token streaming (tokens appear as they arrive from LLM)
 *   - Fixed status bar at terminal bottom (ANSI scroll region)
 *   - Animated spinner while waiting
 *   - Syntax highlighting for fenced code blocks
 *   - Color-coded risk badges on pending work orders
 *   - Graceful terminal resize (SIGWINCH)
 *
 * Falls back to cli-chat.ts via `ved chat --simple`.
 *
 * Usage: ved chat [--model <model>] [--no-rag] [--no-tools] [--verbose]
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ulid } from 'ulid';
import type { VedApp } from './app.js';
import type { VedMessage } from './types/index.js';

// ── ANSI ──────────────────────────────────────────────────────────────────────

export const C = {
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
  bgBlue: '\x1B[44m',
  reverse: '\x1B[7m',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TuiOptions {
  model?: string;
  noRag?: boolean;
  noTools?: boolean;
  verbose?: boolean;
  simple?: boolean;
}

export interface TuiStats {
  messageCount: number;
  startTime: number;
  lastResponseMs: number;
  model: string;
  provider: string;
  trustTier: string;
  sessionId: string;
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseTuiArgs(args: string[]): TuiOptions {
  const opts: TuiOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
      case '-m':
        opts.model = args[++i];
        break;
      case '--no-rag':
        opts.noRag = true;
        break;
      case '--no-tools':
        opts.noTools = true;
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--simple':
      case '-s':
        opts.simple = true;
        break;
      case '--help':
      case '-h':
        printTuiHelp();
        process.exit(0);
        break;
      default:
        if (args[i]?.startsWith('-')) {
          console.error(`Unknown flag: ${args[i]}`);
          printTuiHelp();
          process.exit(1);
        }
    }
  }

  return opts;
}

export function printTuiHelp(): void {
  stdout.write(`
${C.bold}ved chat${C.reset} — Interactive conversation with Ved

${C.bold}Usage:${C.reset}
  ved chat [options]

${C.bold}Options:${C.reset}
  --model, -m <model>    Override LLM model
  --no-rag               Disable RAG context retrieval
  --no-tools             Disable MCP tool calling
  --verbose, -v          Show timing details
  --simple, -s           Use basic terminal mode (no TUI)
  --help, -h             Show this help

${C.bold}Commands:${C.reset}
  /help                  Show this help
  /search <query>        Search vault via RAG
  /facts                 Show active working memory facts
  /memory [path]         Browse vault files
  /approve <id>          Approve a pending work order
  /deny <id> [reason]    Deny a pending work order
  /stats                 Show session statistics
  /clear                 Clear screen
  /multi                 Multi-line input (empty line to send)
  /quit, /exit           Exit chat

`);
}

// ── Syntax Highlighting ───────────────────────────────────────────────────────

/**
 * Apply basic syntax highlighting to a fenced code block's content.
 * Detects strings, keywords, comments, and numbers.
 */
export function highlightCodeLine(line: string, _lang: string): string {
  // Apply simple token-based coloring (order matters: strings first)
  return line
    // Strings (single, double, backtick)
    .replace(/(["'`])((?:(?!\1)[^\\]|\\.)*)(\1)/g,
      `${C.yellow}$1$2$3${C.reset}`)
    // Line comments
    .replace(/(\/\/.*$)/g, `${C.gray}$1${C.reset}`)
    // Keywords
    .replace(
      /\b(const|let|var|function|class|interface|type|return|if|else|for|while|import|export|from|async|await|new|this|extends|implements|null|undefined|true|false|void|string|number|boolean)\b/g,
      `${C.cyan}$1${C.reset}`,
    )
    // Numbers
    .replace(/\b(\d+(?:\.\d+)?)\b/g, `${C.magenta}$1${C.reset}`);
}

/**
 * Render fenced code blocks with a box border and per-line highlighting.
 * Passes through non-code text unchanged.
 */
export function renderWithCodeHighlighting(text: string, termWidth: number): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let inCode = false;
  let lang = '';

  for (const line of lines) {
    if (!inCode) {
      const fenceMatch = line.match(/^```(\w*)$/);
      if (fenceMatch) {
        inCode = true;
        lang = fenceMatch[1] ?? '';
        const label = lang ? `─ ${lang} ` : '─';
        const border = `${C.dim}┌${label}${'─'.repeat(Math.max(0, termWidth - label.length - 4))}┐${C.reset}`;
        output.push(border);
      } else {
        output.push(line);
      }
    } else {
      if (line === '```') {
        inCode = false;
        lang = '';
        const border = `${C.dim}└${'─'.repeat(Math.max(0, termWidth - 2))}┘${C.reset}`;
        output.push(border);
      } else {
        const highlighted = highlightCodeLine(line, lang);
        output.push(`${C.dim}│${C.reset} ${highlighted}`);
      }
    }
  }

  // If code block wasn't closed, close it
  if (inCode) {
    const border = `${C.dim}└${'─'.repeat(Math.max(0, termWidth - 2))}┘${C.reset}`;
    output.push(border);
  }

  return output.join('\n');
}

// ── Status Bar ────────────────────────────────────────────────────────────────

/**
 * Fixed status bar rendered on the last terminal line.
 * Uses ANSI scroll region to keep it pinned while content scrolls above.
 */
export class StatusBar {
  private rows = 24;
  private cols = 80;
  private active = false;
  private content = '';

  init(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.active = true;
    // Reserve last line: set scroll region to rows 1..rows-1
    stdout.write(`\x1B[1;${this.rows - 1}r`);
    // Move cursor to beginning of scroll region
    stdout.write('\x1B[1;1H');
    process.on('SIGWINCH', () => { this.handleResize(); });
  }

  update(stats: TuiStats): void {
    if (!this.active) return;

    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    const uptimeStr = `${mins}m ${secs.toString().padStart(2, '0')}s`;

    const parts = [
      `${C.dim}sess:${C.reset} ${C.gray}${stats.sessionId.slice(0, 10)}…${C.reset}`,
      `${C.dim}msgs:${C.reset} ${stats.messageCount}`,
      uptimeStr,
      stats.model !== 'none' ? stats.model : '',
      stats.trustTier ? `${C.green}${stats.trustTier} ●${C.reset}` : '',
    ].filter(Boolean).join(`  ${C.dim}│${C.reset}  `);

    this.content = parts;
    this.render();
  }

  private render(): void {
    if (!this.active) return;
    const visLen = this.stripAnsi(this.content).length;
    // Pad to terminal width using visual length (not byte length with ANSI codes)
    const padding = ' '.repeat(Math.max(0, this.cols - visLen));
    const displayBar = this.content + padding;

    stdout.write(
      '\x1B[s' +                            // save cursor
      `\x1B[${this.rows};1H` +              // move to last line
      `\x1B[7m${displayBar}\x1B[0m` +       // render reversed
      '\x1B[u',                             // restore cursor
    );
  }

  destroy(): void {
    if (!this.active) return;
    this.active = false;
    // Reset scroll region, clear status line
    stdout.write(
      `\x1B[r` +                            // reset scroll region
      `\x1B[${this.rows};1H\x1B[2K`,       // clear status line
    );
  }

  private handleResize(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    // Re-apply scroll region after resize
    stdout.write(`\x1B[1;${this.rows - 1}r`);
    this.render();
  }

  /** Strip ANSI escape codes for length measurement. */
  private stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1B\[[0-9;]*m/g, '');
  }
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export class TuiSpinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;

  start(label = 'thinking'): void {
    this.stop();
    this.frameIndex = 0;
    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length];
      stdout.write(`\r  ${C.dim}${frame} ${label}…${C.reset}  `);
      this.frameIndex++;
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      stdout.write('\r\x1B[K');
    }
  }
}

// ── Risk badge ────────────────────────────────────────────────────────────────

export function riskBadge(level: string): string {
  switch (level) {
    case 'critical': return `${C.bold}${C.red}[CRITICAL]${C.reset}`;
    case 'high':     return `${C.red}[HIGH]${C.reset}`;
    case 'medium':   return `${C.yellow}[MEDIUM]${C.reset}`;
    case 'low':      return `${C.green}[LOW]${C.reset}`;
    default:         return `${C.gray}[${level}]${C.reset}`;
  }
}

// ── Session Picker ────────────────────────────────────────────────────────────

/**
 * Show recent sessions and let user pick one or start a new conversation.
 * Returns the selected session ID, or null for a new session.
 */
export async function showSessionPicker(
  app: VedApp,
  rl: readline.Interface,
): Promise<string | null> {
  const sessions = app.listRecentSessions(8);
  const resumable = sessions.filter(s => s.status === 'active' || s.status === 'idle');

  if (resumable.length === 0) {
    return null; // No sessions to resume — start fresh
  }

  stdout.write(`\n  ${C.bold}Recent Sessions${C.reset}\n`);
  stdout.write(`  ${C.dim}${'─'.repeat(60)}${C.reset}\n`);

  for (let i = 0; i < resumable.length; i++) {
    const s = resumable[i]!;
    const ago = formatAgo(Date.now() - s.lastActive);
    const statusIcon = s.status === 'active' ? `${C.green}●${C.reset}` : `${C.yellow}○${C.reset}`;
    const msgCount = s.workingMemory.messageCount;
    const preview = s.workingMemory.messages.length > 0
      ? s.workingMemory.messages[s.workingMemory.messages.length - 1]?.content?.slice(0, 50) ?? ''
      : '';
    const previewTrunc = preview.length >= 50 ? preview + '…' : preview;

    stdout.write(
      `  ${C.bold}${i + 1}${C.reset}  ${statusIcon} ${C.cyan}${s.id.slice(0, 10)}…${C.reset}  ` +
      `${C.dim}${ago} · ${msgCount} msgs · ${s.channel}${C.reset}` +
      (previewTrunc ? `\n     ${C.dim}${previewTrunc.replace(/\n/g, ' ')}${C.reset}` : '') +
      '\n',
    );
  }

  stdout.write(`  ${C.bold}n${C.reset}  ${C.green}+${C.reset} New conversation\n`);
  stdout.write(`  ${C.dim}${'─'.repeat(60)}${C.reset}\n`);

  const answer = await rl.question(`  ${C.dim}Pick session [n]:${C.reset} `);
  const trimmed = answer.trim().toLowerCase();

  if (!trimmed || trimmed === 'n' || trimmed === 'new') {
    return null;
  }

  const idx = parseInt(trimmed, 10);
  if (idx >= 1 && idx <= resumable.length) {
    return resumable[idx - 1]!.id;
  }

  // Invalid input — start new
  stdout.write(`  ${C.dim}Starting new conversation.${C.reset}\n`);
  return null;
}

export function formatAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Banner ────────────────────────────────────────────────────────────────────

function printBanner(opts: TuiOptions): void {
  const width = process.stdout.columns || 80;
  stdout.write('\n');
  stdout.write(`  ${C.bold}${C.cyan}Ved Chat${C.reset}  ${C.dim}—  The personal AI agent that remembers everything.${C.reset}\n`);

  const flags: string[] = [];
  if (opts.model) flags.push(`model: ${C.yellow}${opts.model}${C.reset}`);
  if (opts.noRag) flags.push(`${C.dim}RAG: off${C.reset}`);
  if (opts.noTools) flags.push(`${C.dim}tools: off${C.reset}`);
  if (opts.verbose) flags.push(`${C.dim}verbose${C.reset}`);
  if (flags.length > 0) {
    stdout.write(`  ${flags.join('  ')}\n`);
  }

  stdout.write(`  ${C.dim}Type ${C.yellow}/help${C.dim} for commands, ${C.yellow}/quit${C.dim} to exit.${C.reset}\n`);
  stdout.write(`  ${C.dim}${'─'.repeat(Math.max(0, width - 4))}${C.reset}\n`);
  stdout.write('\n');
}

// ── Slash command handler ─────────────────────────────────────────────────────

async function handleSlashCommand(
  input: string,
  app: VedApp,
  stats: TuiStats,
  _opts: TuiOptions,
): Promise<'continue' | 'exit' | 'passthrough'> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const rest = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case 'help':
      printTuiHelp();
      return 'continue';

    case 'search': {
      if (!rest) {
        stdout.write(`\n${C.red}Usage: /search <query>${C.reset}\n\n`);
        return 'continue';
      }
      try {
        const context = await app.search(rest, { vectorTopK: 5, ftsTopK: 5 });
        if (context.results.length === 0) {
          stdout.write(`\n${C.dim}No results for "${rest}"${C.reset}\n\n`);
          return 'continue';
        }
        stdout.write(`\n${C.bold}Search: "${rest}"${C.reset} (${context.results.length} results)\n\n`);
        for (const r of context.results) {
          const score = r.rrfScore.toFixed(3);
          const preview = r.content.replace(/\n/g, ' ').slice(0, 120);
          stdout.write(`  ${C.cyan}${r.filePath}${C.reset} ${C.dim}[${score}]${C.reset}\n`);
          stdout.write(`  ${C.dim}${preview}${C.reset}\n\n`);
        }
      } catch (err) {
        stdout.write(`\n${C.red}Search failed: ${err instanceof Error ? err.message : String(err)}${C.reset}\n\n`);
      }
      return 'continue';
    }

    case 'facts': {
      stdout.write(`\n${C.dim}Working memory facts are injected into the LLM prompt automatically.${C.reset}\n`);
      stdout.write(`${C.dim}Ask Ved "what do you know about me?" to see active context.${C.reset}\n\n`);
      return 'continue';
    }

    case 'memory':
    case 'mem': {
      try {
        const vault = app.memory?.vault;
        if (!vault) {
          stdout.write(`\n${C.dim}Vault not available.${C.reset}\n\n`);
          return 'continue';
        }

        if (rest) {
          const content = vault.readFile(rest);
          stdout.write(`\n${C.cyan}${rest}${C.reset}\n${C.dim}${'─'.repeat(40)}${C.reset}\n${content}\n\n`);
        } else {
          const files = vault.listFiles();
          if (files.length === 0) {
            stdout.write(`\n${C.dim}Vault is empty.${C.reset}\n\n`);
            return 'continue';
          }
          stdout.write(`\n${C.bold}Vault Files${C.reset} (${files.length})\n\n`);
          const grouped = new Map<string, string[]>();
          for (const f of files) {
            const folder = f.split('/')[0] ?? 'root';
            if (!grouped.has(folder)) grouped.set(folder, []);
            grouped.get(folder)!.push(f);
          }
          for (const [folder, paths] of grouped) {
            stdout.write(`  ${C.yellow}${folder}/${C.reset}\n`);
            for (const p of paths.slice(0, 10)) {
              stdout.write(`    ${p}\n`);
            }
            if (paths.length > 10) {
              stdout.write(`    ${C.dim}… and ${paths.length - 10} more${C.reset}\n`);
            }
          }
          stdout.write('\n');
        }
      } catch (err) {
        stdout.write(`\n${C.red}Memory error: ${err instanceof Error ? err.message : String(err)}${C.reset}\n\n`);
      }
      return 'continue';
    }

    case 'stats': {
      const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
      const mins = Math.floor(uptime / 60);
      const secs = uptime % 60;
      stdout.write(`\n${C.bold}Session Stats${C.reset}\n`);
      stdout.write(`  Messages:     ${stats.messageCount}\n`);
      stdout.write(`  Uptime:       ${mins}m ${secs}s\n`);
      stdout.write(`  Last reply:   ${stats.lastResponseMs}ms\n`);
      stdout.write(`  Model:        ${stats.model}\n`);
      stdout.write(`  Trust tier:   ${stats.trustTier}\n\n`);
      return 'continue';
    }

    case 'clear':
      stdout.write('\x1B[2J\x1B[H');
      return 'continue';

    case 'quit':
    case 'exit':
      return 'exit';

    case 'approve':
    case 'deny':
      // Pass through to pipeline as regular text
      return 'passthrough';

    default:
      stdout.write(`\n${C.dim}Unknown command: /${cmd}. Type /help for commands.${C.reset}\n\n`);
      return 'continue';
  }
}

// ── Send and stream display ───────────────────────────────────────────────────

async function sendAndStream(
  content: string,
  app: VedApp,
  stats: TuiStats,
  opts: TuiOptions,
  spinner: TuiSpinner,
  statusBar: StatusBar,
): Promise<void> {
  stats.messageCount++;

  const msg: VedMessage = {
    id: ulid(),
    channel: 'chat',
    author: 'owner',
    content,
    timestamp: Date.now(),
  };

  const startMs = Date.now();
  spinner.start('thinking');

  const termWidth = process.stdout.columns || 80;
  let firstToken = true;
  let tokenBuffer = '';

  try {
    const response = await app.processMessageStream(msg, (token) => {
      if (firstToken) {
        spinner.stop();
        stdout.write(`\n${C.cyan}ved>${C.reset}\n`);
        firstToken = false;
      }
      // Write tokens as they arrive — buffer for code block highlighting
      tokenBuffer += token;
      // Flush partial output inline (without code highlighting mid-stream)
      stdout.write(token);
    });

    // If we never received any token (spinner still active)
    spinner.stop();

    const elapsed = Date.now() - startMs;
    stats.lastResponseMs = elapsed;

    if (response.content) {
      if (firstToken) {
        // No tokens were streamed (no-LLM mode or empty response)
        const timing = opts.verbose ? ` ${C.dim}(${elapsed}ms)${C.reset}` : '';
        stdout.write(`\n${C.cyan}ved>${C.reset}${timing}\n`);
        const rendered = renderWithCodeHighlighting(response.content, termWidth - 4);
        const lines = rendered.split('\n');
        for (const line of lines) {
          stdout.write(`  ${line}\n`);
        }
        stdout.write('\n');
      } else {
        // Streamed — re-render with syntax highlighting if code blocks were present
        if (tokenBuffer.includes('```')) {
          // Erase the streamed output and re-render with highlighting
          // Count lines to erase
          const rawLines = tokenBuffer.split('\n');
          // Move cursor up rawLines.length + 1 (for the "ved>" header)
          const linesToErase = rawLines.length + 1;
          stdout.write(`\x1B[${linesToErase}A\x1B[J`);
          // Re-render with highlighting
          stdout.write(`\n${C.cyan}ved>${C.reset}\n`);
          const rendered = renderWithCodeHighlighting(tokenBuffer, termWidth - 4);
          const lines = rendered.split('\n');
          for (const line of lines) {
            stdout.write(`  ${line}\n`);
          }
        }
        stdout.write('\n');

        if (opts.verbose) {
          stdout.write(`  ${C.dim}(${elapsed}ms)${C.reset}\n\n`);
        }
      }

      // Show memory ops in verbose mode
      if (opts.verbose && response.memoryOps.length > 0) {
        for (const op of response.memoryOps) {
          stdout.write(`  ${C.dim}📝 memory: ${JSON.stringify(op)}${C.reset}\n`);
        }
        stdout.write('\n');
      }

      // Show pending approval work orders
      if (response.actions.length > 0) {
        for (const wo of response.actions) {
          const badge = riskBadge(wo.riskLevel);
          stdout.write(`  ${C.yellow}⚠️  Approval required:${C.reset} ${wo.tool}  ${badge}\n`);
          stdout.write(`  ${C.dim}   ID: ${wo.id}${C.reset}\n`);
          stdout.write(`  ${C.dim}   Reply: /approve ${wo.id} | /deny ${wo.id}${C.reset}\n`);
        }
        stdout.write('\n');
      }
    } else if (firstToken) {
      spinner.stop();
    }

    // Update status bar with current session info
    statusBar.update(stats);

  } catch (err) {
    spinner.stop();
    stdout.write(`\n${C.red}Error: ${err instanceof Error ? err.message : String(err)}${C.reset}\n\n`);
  }
}

// ── Main TUI loop ─────────────────────────────────────────────────────────────

/**
 * Run the interactive TUI chat loop with streaming and status bar.
 */
export async function runChatTui(app: VedApp, args: string[]): Promise<void> {
  const opts = parseTuiArgs(args);

  // --simple falls back to the original cli-chat.ts
  if (opts.simple) {
    const { runChat } = await import('./cli-chat.js');
    return runChat(app, args.filter(a => a !== '--simple' && a !== '-s'));
  }

  const stats: TuiStats = {
    messageCount: 0,
    startTime: Date.now(),
    lastResponseMs: 0,
    model: 'none',
    provider: 'none',
    trustTier: 'owner',
    sessionId: ulid(),
  };

  const spinner = new TuiSpinner();
  const statusBar = new StatusBar();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    spinner.stop();
    statusBar.destroy();
    stdout.write(`\n${C.dim}Goodbye.${C.reset}\n`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await app.init();
    await app.indexVaultOnStartup();

    // Populate model info in stats
    if (app.llm) {
      stats.model = app.llm.model;
      stats.provider = app.llm.provider;
    }

    const rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
    });

    // Session picker — let user resume or start fresh
    if (!opts.simple) {
      const selectedSession = await showSessionPicker(app, rl);
      if (selectedSession) {
        stats.sessionId = selectedSession;
        stdout.write(`  ${C.dim}Resuming session ${selectedSession.slice(0, 10)}…${C.reset}\n`);
      }
    }

    // Init status bar (sets scroll region)
    statusBar.init();
    statusBar.update(stats);

    printBanner(opts);

    let multiLineMode = false;
    let multiLineBuffer: string[] = [];
    const prompt = `${C.green}you>${C.reset} `;

    while (true) {
      try {
        const linePrompt = multiLineMode ? `${C.dim}…>${C.reset} ` : prompt;
        const input = await rl.question(linePrompt);
        const trimmed = input.trim();

        // Multi-line mode
        if (multiLineMode) {
          if (trimmed === '') {
            multiLineMode = false;
            const fullInput = multiLineBuffer.join('\n');
            multiLineBuffer = [];
            if (fullInput.trim()) {
              await sendAndStream(fullInput, app, stats, opts, spinner, statusBar);
            }
            continue;
          }
          multiLineBuffer.push(input);
          continue;
        }

        if (!trimmed) continue;

        // Multi-line entry
        if (trimmed === '/multi' || trimmed === '/m') {
          multiLineMode = true;
          multiLineBuffer = [];
          stdout.write(`${C.dim}  Multi-line mode. Enter empty line to send.${C.reset}\n`);
          continue;
        }

        // Slash commands
        if (trimmed.startsWith('/')) {
          const result = await handleSlashCommand(trimmed, app, stats, opts);
          if (result === 'exit') break;
          if (result === 'passthrough') {
            await sendAndStream(trimmed.slice(1), app, stats, opts, spinner, statusBar);
          }
          continue;
        }

        // Regular message
        await sendAndStream(trimmed, app, stats, opts, spinner, statusBar);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        break;
      }
    }

    spinner.stop();
    statusBar.destroy();
    rl.close();

    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    stdout.write(`\n${C.dim}Session: ${stats.messageCount} messages in ${mins}m ${secs}s. Goodbye.${C.reset}\n\n`);

    await app.stop();
  } catch (err) {
    spinner.stop();
    statusBar.destroy();
    console.error(`\nChat error: ${err instanceof Error ? err.message : String(err)}`);
    try { await app.stop(); } catch { /* best effort */ }
    process.exit(1);
  }
}
