/**
 * `ved chat` — Interactive conversational REPL.
 *
 * Starts Ved with a direct message loop (bypasses channel adapters).
 * Sends messages through the full 7-step pipeline and captures responses.
 *
 * Features:
 *   - Typing indicator while waiting for LLM
 *   - Inline slash commands (/search, /facts, /stats, /approve, /deny)
 *   - Multi-line input (/multi)
 *   - Colored terminal output
 *   - Session timing and stats
 *
 * Usage: ved chat [--model <model>] [--no-rag] [--no-tools] [--verbose]
 *
 * Aliases: c, talk
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ulid } from 'ulid';
import type { VedApp } from './app.js';
import type { VedMessage } from './types/index.js';
import { errHint } from './errors.js';

// ── ANSI colors ──

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  cyan: '\x1B[36m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  magenta: '\x1B[35m',
  red: '\x1B[31m',
  gray: '\x1B[90m',
};

// ── Types ──

export interface ChatOptions {
  model?: string;
  noRag?: boolean;
  noTools?: boolean;
  verbose?: boolean;
}

export interface ChatStats {
  messageCount: number;
  startTime: number;
  lastResponseMs: number;
}

// ── Argument parsing ──

export function parseChatArgs(args: string[]): ChatOptions {
  const opts: ChatOptions = {};

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
      case '--help':
      case '-h':
        printChatHelp();
        process.exit(0);
        break;
      default:
        if (args[i]?.startsWith('-')) {
          errHint(`Unknown flag: ${args[i]}`, 'Run "ved help" to see available commands');
          printChatHelp();
          process.exit(1);
        }
    }
  }

  return opts;
}

export function printChatHelp(): void {
  stdout.write(`
${C.bold}ved chat${C.reset} — Interactive conversation with Ved

${C.bold}Usage:${C.reset}
  ved chat [options]

${C.bold}Options:${C.reset}
  --model, -m <model>    Override LLM model
  --no-rag               Disable RAG context retrieval
  --no-tools             Disable MCP tool calling
  --verbose, -v          Show timing details
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

// ── Typing indicator ──

export class TypingIndicator {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;

  start(label = 'thinking'): void {
    this.stop();
    this.frameIndex = 0;
    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length];
      stdout.write(`\r  ${C.dim}${frame} ${label}...${C.reset}  `);
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

// ── Banner ──

function printBanner(opts: ChatOptions): void {
  stdout.write('\n');
  stdout.write(`  ${C.bold}${C.cyan}Ved Chat${C.reset}\n`);
  stdout.write(`  ${C.dim}The personal AI agent that remembers everything.${C.reset}\n`);

  const flags: string[] = [];
  if (opts.model) flags.push(`model: ${opts.model}`);
  if (opts.noRag) flags.push('RAG: off');
  if (opts.noTools) flags.push('tools: off');
  if (opts.verbose) flags.push('verbose');
  if (flags.length > 0) {
    stdout.write(`  ${C.dim}[${flags.join(' | ')}]${C.reset}\n`);
  }

  stdout.write(`  ${C.dim}Type ${C.yellow}/help${C.dim} for commands, ${C.yellow}/quit${C.dim} to exit.${C.reset}\n`);
  stdout.write('\n');
}

// ── Inline command handlers ──

async function handleSlashCommand(
  input: string,
  app: VedApp,
  stats: ChatStats,
  _opts: ChatOptions,
): Promise<'continue' | 'exit' | 'passthrough'> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const rest = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case 'help':
      printChatHelp();
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
              stdout.write(`    ${C.dim}... and ${paths.length - 10} more${C.reset}\n`);
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
      stdout.write(`  Last reply:   ${stats.lastResponseMs}ms\n\n`);
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

// ── Main chat loop ──

/**
 * Run the interactive chat REPL.
 *
 * Bypasses the channel adapter system entirely — sends VedMessages directly
 * to the event loop and waits for responses via a promise-based callback.
 */
export async function runChat(app: VedApp, args: string[]): Promise<void> {
  const opts = parseChatArgs(args);

  const stats: ChatStats = {
    messageCount: 0,
    startTime: Date.now(),
    lastResponseMs: 0,
  };

  const typing = new TypingIndicator();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    typing.stop();
    stdout.write(`\n${C.dim}Goodbye.${C.reset}\n`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Init without starting channels — we'll talk to the event loop directly
    await app.init();

    // Index vault if needed
    await app.indexVaultOnStartup();

    printBanner(opts);

    const rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
    });

    let multiLineMode = false;
    let multiLineBuffer: string[] = [];
    const prompt = `${C.green}you>${C.reset} `;

    while (true) {
      try {
        const linePrompt = multiLineMode ? `${C.dim}...>${C.reset} ` : prompt;
        const input = await rl.question(linePrompt);
        const trimmed = input.trim();

        // Multi-line mode
        if (multiLineMode) {
          if (trimmed === '') {
            multiLineMode = false;
            const fullInput = multiLineBuffer.join('\n');
            multiLineBuffer = [];
            if (fullInput.trim()) {
              await sendAndDisplay(fullInput, app, stats, opts, typing);
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
            // Rewrite: /approve WO-123 → approve WO-123
            await sendAndDisplay(trimmed.slice(1), app, stats, opts, typing);
          }
          continue;
        }

        // Regular message
        await sendAndDisplay(trimmed, app, stats, opts, typing);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
        break;
      }
    }

    typing.stop();
    rl.close();

    // Farewell
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    stdout.write(`\n${C.dim}Session: ${stats.messageCount} messages in ${mins}m ${secs}s. Goodbye.${C.reset}\n\n`);

    await app.stop();
  } catch (err) {
    typing.stop();
    errHint(`Chat error: ${err instanceof Error ? err.message : String(err)}`);
    try { await app.stop(); } catch { /* best effort */ }
    process.exit(1);
  }
}

// ── Send message and display response ──

async function sendAndDisplay(
  content: string,
  app: VedApp,
  stats: ChatStats,
  opts: ChatOptions,
  typing: TypingIndicator,
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
  typing.start('thinking');

  try {
    // Use the event loop's processMessageDirect method
    // which runs the full 7-step pipeline and returns the response
    const response = await app.processMessageDirect(msg);

    typing.stop();

    const elapsed = Date.now() - startMs;
    stats.lastResponseMs = elapsed;

    if (response.content) {
      const timing = opts.verbose ? ` ${C.dim}(${elapsed}ms)${C.reset}` : '';
      stdout.write(`\n${C.cyan}ved>${C.reset}${timing}\n`);

      // Indent response for visual distinction
      const lines = response.content.split('\n');
      for (const line of lines) {
        stdout.write(`  ${line}\n`);
      }
      stdout.write('\n');
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
        stdout.write(`  ${C.yellow}⚠️  Approval required: ${wo.tool}${C.reset}\n`);
        stdout.write(`  ${C.dim}   Risk: ${wo.riskLevel} | ID: ${wo.id}${C.reset}\n`);
        stdout.write(`  ${C.dim}   Reply: /approve ${wo.id} | /deny ${wo.id}${C.reset}\n`);
      }
      stdout.write('\n');
    }
  } catch (err) {
    typing.stop();
    stdout.write(`\n${C.red}Error: ${err instanceof Error ? err.message : String(err)}${C.reset}\n\n`);
  }
}
