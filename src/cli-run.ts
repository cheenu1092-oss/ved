/**
 * `ved run` — One-shot query mode.
 *
 * Sends a single message through the full Ved pipeline (RAG → LLM → tools)
 * and prints the response to stdout. Designed for scripting and piping.
 *
 * Usage:
 *   ved run "What is Ved?"                      — Direct query
 *   ved run -q "What is Ved?"                   — Explicit query flag
 *   echo "summarize this" | ved run -           — Read from stdin
 *   ved run -q "translate" -f input.txt          — Attach file context
 *   ved run -q "question" --json                — JSON output
 *   ved run -q "question" --raw                 — Response text only (no banner)
 *   ved run -q "question" --session mysession   — Use named session
 *   ved run -q "question" --model gpt-4o        — Override LLM model
 *   ved run -q "question" --no-rag              — Skip RAG enrichment
 *   ved run -q "question" --no-tools            — Disable tool execution
 *   ved run -q "question" --timeout 30          — Timeout in seconds
 *   ved run -q "question" --system "You are..." — Override system prompt
 *
 * Aliases: ved ask, ved query, ved q
 *
 * Exit codes:
 *   0 — Success
 *   1 — Error (config, LLM, etc.)
 *   2 — Timeout
 *   3 — No query provided
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { ulid } from 'ulid';
import { createApp, type VedApp } from './app.js';
import type { VedMessage, VedResponse } from './types/index.js';

const VERSION = '0.1.0';

export interface RunOptions {
  /** The query string */
  query: string;
  /** Read query from stdin */
  stdin: boolean;
  /** File to attach as context */
  filePath?: string;
  /** Output format */
  format: 'text' | 'json' | 'raw';
  /** Named session ID (for context persistence across runs) */
  sessionId?: string;
  /** LLM model override */
  model?: string;
  /** Skip RAG enrichment */
  noRag: boolean;
  /** Disable tool execution */
  noTools: boolean;
  /** Timeout in seconds */
  timeout: number;
  /** System prompt override */
  systemPrompt?: string;
  /** Show timing info */
  verbose: boolean;
}

/**
 * Parse CLI args for `ved run`.
 */
export function parseRunArgs(args: string[]): RunOptions {
  const opts: RunOptions = {
    query: '',
    stdin: false,
    format: 'text',
    noRag: false,
    noTools: false,
    timeout: 120,
    verbose: false,
  };

  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-' || arg === '--stdin') {
      opts.stdin = true;
    } else if ((arg === '-q' || arg === '--query') && args[i + 1]) {
      queryParts.push(args[++i]);
    } else if ((arg === '-f' || arg === '--file') && args[i + 1]) {
      opts.filePath = args[++i];
    } else if (arg === '--json') {
      opts.format = 'json';
    } else if (arg === '--raw') {
      opts.format = 'raw';
    } else if ((arg === '--session' || arg === '-s') && args[i + 1]) {
      opts.sessionId = args[++i];
    } else if ((arg === '--model' || arg === '-m') && args[i + 1]) {
      opts.model = args[++i];
    } else if (arg === '--no-rag') {
      opts.noRag = true;
    } else if (arg === '--no-tools') {
      opts.noTools = true;
    } else if ((arg === '--timeout' || arg === '-t') && args[i + 1]) {
      opts.timeout = parseInt(args[++i], 10);
      if (isNaN(opts.timeout) || opts.timeout <= 0) {
        console.error('Error: --timeout must be a positive integer (seconds)');
        process.exit(1);
      }
    } else if (arg === '--system' && args[i + 1]) {
      opts.systemPrompt = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printRunHelp();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`);
      console.error('Run `ved run --help` for usage.');
      process.exit(1);
    } else {
      // Positional argument = part of query
      queryParts.push(arg);
    }
  }

  opts.query = queryParts.join(' ').trim();
  return opts;
}

/**
 * Print help text for `ved run`.
 */
function printRunHelp(): void {
  console.log(`
ved run — One-shot query mode

USAGE
  ved run "your question here"
  ved run -q "your question" [options]
  echo "your question" | ved run -
  cat document.txt | ved run - -q "summarize this"

OPTIONS
  -q, --query <text>     Query text (also accepts positional args)
  -f, --file <path>      Attach file content as context
  -s, --session <id>     Use a named session (persists context across runs)
  -m, --model <name>     Override LLM model
  --system <prompt>      Override system prompt
  --json                 Output response as JSON
  --raw                  Output response text only (no headers/timing)
  --no-rag               Skip RAG retrieval
  --no-tools             Disable tool execution
  -t, --timeout <secs>   Timeout in seconds (default: 120)
  -v, --verbose          Show timing and usage info
  -h, --help             Show this help

ALIASES
  ved ask, ved query, ved q

EXIT CODES
  0  Success
  1  Error
  2  Timeout
  3  No query provided

EXAMPLES
  ved run "What files are in my vault?"
  ved run -q "translate to Spanish" -f letter.txt
  echo "explain quantum computing" | ved run - --raw
  ved run "project status" --session myproject --json
  ved run "summarize" -f notes.md --no-tools --raw | pbcopy
`.trim());
}

/**
 * Read all of stdin as a string.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Execute a one-shot query through the Ved pipeline.
 */
export async function runQuery(app: VedApp, opts: RunOptions): Promise<{
  response: VedResponse;
  durationMs: number;
}> {
  // Build the query content
  let content = opts.query;

  // Read stdin if requested
  if (opts.stdin) {
    const stdinContent = await readStdin();
    if (content) {
      // Query + stdin = query is instruction, stdin is context
      content = `${content}\n\n---\n\n${stdinContent}`;
    } else {
      content = stdinContent;
    }
  }

  // Attach file content if provided
  if (opts.filePath) {
    if (!existsSync(opts.filePath)) {
      throw new Error(`File not found: ${opts.filePath}`);
    }
    const stat = statSync(opts.filePath);
    if (stat.size > 1024 * 1024) {
      throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 1MB.`);
    }
    const fileContent = readFileSync(opts.filePath, 'utf-8');
    const fileName = opts.filePath.split('/').pop() ?? opts.filePath;
    content = content
      ? `${content}\n\n--- ${fileName} ---\n\n${fileContent}`
      : `--- ${fileName} ---\n\n${fileContent}`;
  }

  content = content.trim();
  if (!content) {
    throw new Error('No query provided. Pass a query as argument, via -q, or pipe to stdin.');
  }

  // Build the message
  const msg: VedMessage = {
    id: ulid(),
    channel: 'run' as const,
    author: opts.sessionId ?? `run-${ulid()}`,
    content,
    timestamp: Date.now(),
  };

  // Execute with timeout
  const startTime = Date.now();
  const timeoutMs = opts.timeout * 1000;

  const response = await Promise.race([
    app.processMessageDirect(msg),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)
    ),
  ]);

  const durationMs = Date.now() - startTime;
  return { response, durationMs };
}

/**
 * Format and print the response.
 */
export function formatOutput(
  response: VedResponse,
  opts: RunOptions,
  durationMs: number,
): string {
  if (opts.format === 'json') {
    return JSON.stringify({
      id: response.id,
      content: response.content,
      actions: response.actions.map(a => ({
        id: a.id,
        tool: a.tool,
        status: a.status,
        riskLevel: a.riskLevel,
      })),
      memoryOps: response.memoryOps.map(m => ({
        type: m.type,
      })),
      durationMs,
    }, null, 2);
  }

  if (opts.format === 'raw') {
    return response.content;
  }

  // Text format (default)
  const lines: string[] = [];

  if (opts.verbose) {
    lines.push(`Ved v${VERSION} — Run\n`);
    lines.push(`  Query:    "${opts.query.length > 60 ? opts.query.slice(0, 57) + '…' : opts.query}"`);
    if (opts.sessionId) lines.push(`  Session:  ${opts.sessionId}`);
    if (opts.model) lines.push(`  Model:    ${opts.model}`);
    if (opts.noRag) lines.push(`  RAG:      disabled`);
    if (opts.noTools) lines.push(`  Tools:    disabled`);
    lines.push(`  Duration: ${durationMs}ms`);
    lines.push('');
  }

  lines.push(response.content);

  // Show pending actions if any
  const pendingActions = response.actions.filter(a => a.status === 'pending');
  if (pendingActions.length > 0) {
    lines.push('');
    lines.push(`⏳ ${pendingActions.length} action(s) awaiting approval:`);
    for (const a of pendingActions) {
      lines.push(`  • ${a.tool} (${a.id})`);
    }
  }

  if (opts.verbose && response.memoryOps.length > 0) {
    lines.push('');
    lines.push(`Memory ops: ${response.memoryOps.length}`);
  }

  return lines.join('\n');
}

/**
 * Entry point for `ved run` command.
 */
export async function vedRun(args: string[]): Promise<void> {
  const opts = parseRunArgs(args);

  // Validate we have a query (or stdin)
  if (!opts.query && !opts.stdin) {
    if (args.length === 0) {
      printRunHelp();
      process.exit(3);
    }
    console.error('Error: No query provided.');
    console.error('Run `ved run --help` for usage.');
    process.exit(3);
  }

  let app: VedApp | undefined;

  try {
    app = createApp();
    await app.init();

    const { response, durationMs } = await runQuery(app, opts);
    const output = formatOutput(response, opts, durationMs);
    console.log(output);
  } catch (err) {
    if (err instanceof Error && err.message === 'TIMEOUT') {
      console.error(`Error: Query timed out after ${opts.timeout}s`);
      process.exit(2);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    if (app) {
      await app.stop();
    }
  }
}
