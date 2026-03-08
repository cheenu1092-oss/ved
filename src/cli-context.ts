/**
 * `ved context` — Context Window Inspector & Manager
 *
 * Inspect, manipulate, and simulate the LLM context window.
 * Most AI assistants hide what goes into the prompt. Ved exposes it.
 *
 * Subcommands:
 *   show [--session <id>]           Show full assembled context (system prompt + facts + RAG)
 *   tokens [--session <id>]         Token count breakdown by section
 *   facts [--session <id>]          List active working memory facts
 *   add <key> <value> [--session]   Add a fact to working memory
 *   remove <key> [--session]        Remove a fact from working memory
 *   clear [--session <id>]          Clear all working memory facts
 *   messages [--session <id>]       List conversation messages in working memory
 *   simulate <query>                Show what RAG would inject for a query (dry-run)
 *   sessions                        List active/idle sessions
 *
 * Aliases: ctx, window, prompt-debug
 */

import type { VedApp } from './app.js';
import type { VedConfig } from './types/index.js';
import { existsSync, readFileSync } from 'node:fs';

const VERSION = '0.1.0';

// ─── Token estimation (must match WorkingMemory heuristic) ───

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Session lookup helpers ───

interface SessionRow {
  id: string;
  channel: string;
  channel_id: string;
  author_id: string;
  trust_tier: number;
  started_at: number;
  last_active: number;
  working_memory: string;
  token_count: number;
  status: string;
  closed_at: number | null;
  summary: string | null;
}

interface ParsedWorkingMemory {
  messages: Array<{ role: string; content: string; name?: string; timestamp: number }>;
  facts: Record<string, string>;
}

function parseWorkingMemory(raw: string): ParsedWorkingMemory {
  try {
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
    };
  } catch {
    return { messages: [], facts: {} };
  }
}

function getSessionIdFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--session' || args[i] === '-s') && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

function getActiveSession(app: VedApp, sessionId?: string): SessionRow | null {
  const db = (app as any).db;
  if (!db) return null;

  if (sessionId) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | null;
  }

  // Get most recently active session
  return db.prepare(
    "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC LIMIT 1"
  ).get() as SessionRow | null;
}

function getAllActiveSessions(app: VedApp): SessionRow[] {
  const db = (app as any).db;
  if (!db) return [];
  return db.prepare(
    "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC"
  ).all() as SessionRow[];
}

// ─── System prompt assembly (mirrors EventLoop.buildSystemPrompt) ───

function assembleSystemPrompt(config: VedConfig, facts: Record<string, string>, ragContext: string): string {
  const parts: string[] = [];

  // Custom prompt or default
  const promptPath = config.llm.systemPromptPath;
  let customPrompt: string | null = null;
  if (promptPath && existsSync(promptPath)) {
    try {
      customPrompt = readFileSync(promptPath, 'utf-8').trim() || null;
    } catch { /* ignore */ }
  }

  if (customPrompt) {
    parts.push(customPrompt);
    parts.push('');
  } else {
    parts.push('You are Ved, a personal AI assistant. You remember everything and prove it.');
    parts.push('');
    parts.push('## Rules');
    parts.push('- Be concise, accurate, and helpful.');
    parts.push('- Use tools when they help answer the question. Do not hallucinate tool results.');
    parts.push('- When asked to remember something, acknowledge and confirm.');
    parts.push('- Cite your knowledge sources when relevant (e.g. "From your vault: ...")');
    parts.push('');
  }

  // Working memory facts
  const factEntries = Object.entries(facts);
  if (factEntries.length > 0) {
    parts.push('## Active Facts (from this session)');
    for (const [key, value] of factEntries) {
      parts.push(`- **${key}:** ${value}`);
    }
    parts.push('');
  }

  // RAG context
  if (ragContext) {
    parts.push('## Retrieved Knowledge (from your vault)');
    parts.push(ragContext);
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Format helpers ───

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

// ─── Subcommands ───

async function showContext(app: VedApp, config: VedConfig, args: string[]): Promise<void> {
  const sessionId = getSessionIdFlag(args);
  const session = getActiveSession(app, sessionId);

  console.log(`\nVed v${VERSION} — Context Window Inspector\n`);

  if (!session) {
    console.log('  No active session found.');
    if (sessionId) {
      console.log(`  Session "${sessionId}" not found or not active.`);
    }
    console.log('  Start a conversation with `ved chat` first, or use `ved context simulate <query>`.\n');
    return;
  }

  const wm = parseWorkingMemory(session.working_memory);

  // Assemble the full context as the LLM would see it
  const systemPrompt = assembleSystemPrompt(config, wm.facts, '');
  const totalTokens = estimateTokens(systemPrompt) +
    wm.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  console.log(`  Session: ${session.id}`);
  console.log(`  Channel: ${session.channel} (${session.channel_id})`);
  console.log(`  Author:  ${session.author_id}`);
  console.log(`  Status:  ${session.status}`);
  console.log(`  Active:  ${formatAge(Date.now() - session.last_active)}`);
  console.log(`  Tokens:  ~${totalTokens.toLocaleString()} / ${config.memory.workingMemoryMaxTokens.toLocaleString()}`);
  console.log('');

  console.log('─'.repeat(60));
  console.log('  SYSTEM PROMPT');
  console.log('─'.repeat(60));
  console.log(systemPrompt);

  if (wm.messages.length > 0) {
    console.log('─'.repeat(60));
    console.log('  CONVERSATION HISTORY');
    console.log('─'.repeat(60));
    for (const msg of wm.messages) {
      const prefix = msg.name ? `[${msg.role}:${msg.name}]` : `[${msg.role}]`;
      const time = new Date(msg.timestamp).toISOString().slice(11, 19);
      console.log(`  ${time} ${prefix} ${truncate(msg.content, 200)}`);
    }
    console.log('');
  }

  console.log('─'.repeat(60));
  console.log(`  Total: ~${totalTokens.toLocaleString()} tokens | ${wm.messages.length} messages | ${Object.keys(wm.facts).length} facts`);
  console.log('');
}

async function showTokens(app: VedApp, config: VedConfig, args: string[]): Promise<void> {
  const sessionId = getSessionIdFlag(args);
  const session = getActiveSession(app, sessionId);

  console.log(`\nVed v${VERSION} — Token Breakdown\n`);

  if (!session) {
    // Show base system prompt token count even without a session
    const basePrompt = assembleSystemPrompt(config, {}, '');
    const baseTokens = estimateTokens(basePrompt);
    console.log('  No active session. Showing base system prompt cost:\n');
    console.log(`  System prompt (base):   ~${baseTokens.toLocaleString()} tokens`);
    console.log(`  Working memory facts:    0 tokens`);
    console.log(`  Conversation messages:   0 tokens`);
    console.log(`  RAG context:             0 tokens (query-dependent)`);
    console.log(`  ────────────────────────────────`);
    console.log(`  Total (base):           ~${baseTokens.toLocaleString()} tokens`);
    console.log(`  Budget:                  ${config.memory.workingMemoryMaxTokens.toLocaleString()} tokens`);
    console.log(`  Available:              ~${(config.memory.workingMemoryMaxTokens - baseTokens).toLocaleString()} tokens\n`);
    return;
  }

  const wm = parseWorkingMemory(session.working_memory);

  // Calculate per-section token counts
  const customPrompt = assembleSystemPrompt(config, {}, '');
  const systemTokens = estimateTokens(customPrompt);

  let factTokens = 0;
  const factEntries = Object.entries(wm.facts);
  if (factEntries.length > 0) {
    const factSection = factEntries.map(([k, v]) => `- **${k}:** ${v}`).join('\n');
    factTokens = estimateTokens('## Active Facts (from this session)\n' + factSection + '\n');
  }

  let messageTokens = 0;
  const perRole: Record<string, number> = {};
  for (const msg of wm.messages) {
    const t = estimateTokens(msg.content);
    messageTokens += t;
    const role = msg.role;
    perRole[role] = (perRole[role] ?? 0) + t;
  }

  const total = systemTokens + factTokens + messageTokens;
  const budget = config.memory.workingMemoryMaxTokens;
  const pct = budget > 0 ? Math.round((total / budget) * 100) : 0;

  console.log(`  Session: ${session.id}\n`);
  console.log(`  System prompt:           ~${systemTokens.toLocaleString()} tokens`);
  console.log(`  Working memory facts:    ~${factTokens.toLocaleString()} tokens (${factEntries.length} facts)`);
  console.log(`  Conversation messages:   ~${messageTokens.toLocaleString()} tokens (${wm.messages.length} messages)`);

  // Per-role breakdown
  for (const [role, tokens] of Object.entries(perRole).sort((a, b) => b[1] - a[1])) {
    const count = wm.messages.filter(m => m.role === role).length;
    console.log(`    └─ ${role}:              ~${tokens.toLocaleString()} tokens (${count} msgs)`);
  }

  console.log(`  RAG context:             (query-dependent, use 'ved context simulate')`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Total:                   ~${total.toLocaleString()} tokens`);
  console.log(`  Budget:                   ${budget.toLocaleString()} tokens`);
  console.log(`  Used:                     ${pct}%`);

  const bar = '█'.repeat(Math.round(pct / 2.5)) + '░'.repeat(40 - Math.round(pct / 2.5));
  console.log(`  [${bar}]`);

  console.log(`  Available:               ~${(budget - total).toLocaleString()} tokens`);

  if (pct > 80) {
    console.log(`\n  ⚠️  Context window is ${pct}% full. Compression may trigger soon.`);
  }
  console.log('');
}

async function listFacts(app: VedApp, _config: VedConfig, args: string[]): Promise<void> {
  const sessionId = getSessionIdFlag(args);
  const session = getActiveSession(app, sessionId);

  console.log(`\nVed v${VERSION} — Working Memory Facts\n`);

  if (!session) {
    console.log('  No active session found.\n');
    return;
  }

  const wm = parseWorkingMemory(session.working_memory);
  const entries = Object.entries(wm.facts);

  console.log(`  Session: ${session.id}`);
  console.log(`  Status:  ${session.status}`);
  console.log('');

  if (entries.length === 0) {
    console.log('  No active facts in working memory.\n');
    console.log('  Facts are set during conversations when you say "remember that..."');
    console.log('  Or add one: ved context add <key> <value>\n');
    return;
  }

  for (const [key, value] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    const tokens = estimateTokens(key) + estimateTokens(value);
    console.log(`  ${key}`);
    console.log(`    Value:  ${truncate(value, 120)}`);
    console.log(`    Tokens: ~${tokens}`);
    console.log('');
  }

  const totalTokens = entries.reduce((sum, [k, v]) =>
    sum + estimateTokens(k) + estimateTokens(v), 0);
  console.log(`  ${entries.length} fact(s), ~${totalTokens} tokens total.\n`);
}

async function addFact(app: VedApp, _config: VedConfig, args: string[]): Promise<void> {
  // Parse: ved context add <key> <value...> [--session <id>]
  const sessionId = getSessionIdFlag(args);

  // Filter out --session flag from args
  const cleanArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--session' || args[i] === '-s') && args[i + 1]) {
      i++; // skip value
      continue;
    }
    cleanArgs.push(args[i]);
  }

  const key = cleanArgs[0];
  const value = cleanArgs.slice(1).join(' ');

  if (!key || !value) {
    console.error('Usage: ved context add <key> <value...> [--session <id>]');
    console.error('\nExample: ved context add user_preference "prefers dark mode"');
    process.exit(1);
  }

  // Validate key
  if (key.length > 100) {
    console.error('Error: Key must be 100 characters or less.');
    process.exit(1);
  }

  const session = getActiveSession(app, sessionId);
  if (!session) {
    console.error('Error: No active session found. Start a conversation first with `ved chat`.');
    process.exit(1);
  }

  // Modify working memory in DB
  const wm = parseWorkingMemory(session.working_memory);
  const existed = key in wm.facts;
  wm.facts[key] = value;

  const db = (app as any).db;
  db.prepare('UPDATE sessions SET working_memory = ?, last_active = ? WHERE id = ?')
    .run(JSON.stringify(wm), Date.now(), session.id);

  // Audit
  const eventLoop = (app as any).eventLoop;
  if (eventLoop?.audit) {
    eventLoop.audit.append({
      eventType: 'memory_write' as any,
      actor: 'cli',
      sessionId: session.id,
      detail: { action: existed ? 'update' : 'add', key, value, source: 'ved context add' },
    });
  }

  console.log(`\n  ✅ ${existed ? 'Updated' : 'Added'} fact: ${key} = ${truncate(value, 80)}`);
  console.log(`  Session: ${session.id}\n`);
}

async function removeFact(app: VedApp, _config: VedConfig, args: string[]): Promise<void> {
  const sessionId = getSessionIdFlag(args);

  // Filter out --session flag
  const cleanArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--session' || args[i] === '-s') && args[i + 1]) {
      i++;
      continue;
    }
    cleanArgs.push(args[i]);
  }

  const key = cleanArgs[0];
  if (!key) {
    console.error('Usage: ved context remove <key> [--session <id>]');
    process.exit(1);
  }

  const session = getActiveSession(app, sessionId);
  if (!session) {
    console.error('Error: No active session found.');
    process.exit(1);
  }

  const wm = parseWorkingMemory(session.working_memory);
  if (!(key in wm.facts)) {
    console.error(`Error: Fact "${key}" not found in working memory.`);
    process.exit(1);
  }

  delete wm.facts[key];

  const db = (app as any).db;
  db.prepare('UPDATE sessions SET working_memory = ?, last_active = ? WHERE id = ?')
    .run(JSON.stringify(wm), Date.now(), session.id);

  const eventLoop = (app as any).eventLoop;
  if (eventLoop?.audit) {
    eventLoop.audit.append({
      eventType: 'memory_write' as any,
      actor: 'cli',
      sessionId: session.id,
      detail: { action: 'remove', key, source: 'ved context remove' },
    });
  }

  console.log(`\n  ✅ Removed fact: ${key}`);
  console.log(`  Session: ${session.id}\n`);
}

async function clearFacts(app: VedApp, _config: VedConfig, args: string[]): Promise<void> {
  const sessionId = getSessionIdFlag(args);
  const session = getActiveSession(app, sessionId);

  if (!session) {
    console.error('Error: No active session found.');
    process.exit(1);
  }

  const wm = parseWorkingMemory(session.working_memory);
  const count = Object.keys(wm.facts).length;

  if (count === 0) {
    console.log('\n  Working memory facts already empty.\n');
    return;
  }

  wm.facts = {};

  const db = (app as any).db;
  db.prepare('UPDATE sessions SET working_memory = ?, last_active = ? WHERE id = ?')
    .run(JSON.stringify(wm), Date.now(), session.id);

  const eventLoop = (app as any).eventLoop;
  if (eventLoop?.audit) {
    eventLoop.audit.append({
      eventType: 'memory_write' as any,
      actor: 'cli',
      sessionId: session.id,
      detail: { action: 'clear', factsCleared: count, source: 'ved context clear' },
    });
  }

  console.log(`\n  ✅ Cleared ${count} fact(s) from working memory.`);
  console.log(`  Session: ${session.id}\n`);
}

async function listMessages(app: VedApp, _config: VedConfig, args: string[]): Promise<void> {
  const sessionId = getSessionIdFlag(args);
  const session = getActiveSession(app, sessionId);
  const verbose = args.includes('--verbose') || args.includes('-v');

  console.log(`\nVed v${VERSION} — Conversation History\n`);

  if (!session) {
    console.log('  No active session found.\n');
    return;
  }

  const wm = parseWorkingMemory(session.working_memory);

  console.log(`  Session: ${session.id}`);
  console.log(`  Started: ${new Date(session.started_at).toISOString().replace('T', ' ').slice(0, 19)}`);
  console.log(`  Messages: ${wm.messages.length}`);
  console.log('');

  if (wm.messages.length === 0) {
    console.log('  No messages in working memory.\n');
    return;
  }

  for (let i = 0; i < wm.messages.length; i++) {
    const msg = wm.messages[i];
    const time = new Date(msg.timestamp).toISOString().slice(11, 19);
    const prefix = msg.name ? `${msg.role}:${msg.name}` : msg.role;
    const tokens = estimateTokens(msg.content);
    const roleIcon = msg.role === 'user' ? '👤'
      : msg.role === 'assistant' ? '🤖'
      : msg.role === 'tool' ? '🔧'
      : '📋';

    if (verbose) {
      console.log(`  ${roleIcon} [${i + 1}] ${time} ${prefix} (~${tokens} tokens)`);
      console.log(`  ${msg.content}`);
      console.log('');
    } else {
      console.log(`  ${roleIcon} ${time} [${prefix}] ${truncate(msg.content, 120)} (~${tokens}t)`);
    }
  }

  const totalTokens = wm.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  console.log(`\n  ${wm.messages.length} message(s), ~${totalTokens.toLocaleString()} tokens.\n`);
}

async function simulate(app: VedApp, config: VedConfig, args: string[]): Promise<void> {
  // Parse: ved context simulate <query...>
  const query = args.filter(a => !a.startsWith('-')).join(' ');

  if (!query) {
    console.error('Usage: ved context simulate <query...>');
    console.error('\nSimulate what RAG would inject into the context for a given query.');
    console.error('\nExample: ved context simulate "what projects am I working on?"');
    process.exit(1);
  }

  console.log(`\nVed v${VERSION} — Context Simulation\n`);
  console.log(`  Query: "${query}"\n`);

  try {
    // Use RAG pipeline to retrieve context
    const result = await app.search(query);

    const hasResults = result.results && result.results.length > 0;
    const ragContext = result.text || '';
    const ragTokens = result.tokenCount || estimateTokens(ragContext);

    // Show what would be injected
    console.log('─'.repeat(60));
    console.log('  RAG RESULTS');
    console.log('─'.repeat(60));

    if (!hasResults) {
      console.log('  No relevant results found in vault.\n');
    } else {
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        const score = r.rrfScore.toFixed(3);
        const sources = r.sources.join(', ') || 'unknown';
        console.log(`  [${i + 1}] ${r.filePath} (score: ${score}, via: ${sources})`);
        if (r.content) {
          console.log(`      ${truncate(r.content, 150)}`);
        }
        console.log('');
      }
    }

    // Show the formatted context that would be injected
    if (ragContext) {
      console.log('─'.repeat(60));
      console.log('  CONTEXT INJECTION (what the LLM would see)');
      console.log('─'.repeat(60));
      console.log(ragContext);
      console.log('');
    }

    // Token impact
    const basePrompt = assembleSystemPrompt(config, {}, '');
    const baseTokens = estimateTokens(basePrompt);
    const withRag = baseTokens + ragTokens;

    console.log('─'.repeat(60));
    console.log('  TOKEN IMPACT');
    console.log('─'.repeat(60));
    console.log(`  Base system prompt: ~${baseTokens.toLocaleString()} tokens`);
    console.log(`  RAG context:        ~${ragTokens.toLocaleString()} tokens (${result.results?.length ?? 0} results)`);
    console.log(`  Total (pre-conv):   ~${withRag.toLocaleString()} tokens`);
    console.log(`  Budget:              ${config.memory.workingMemoryMaxTokens.toLocaleString()} tokens`);
    console.log(`  Remaining:          ~${(config.memory.workingMemoryMaxTokens - withRag).toLocaleString()} tokens for conversation\n`);

  } catch (err) {
    console.error(`Error during simulation: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function listSessions(app: VedApp, _config: VedConfig, _args: string[]): Promise<void> {
  console.log(`\nVed v${VERSION} — Active Sessions\n`);

  const sessions = getAllActiveSessions(app);

  if (sessions.length === 0) {
    console.log('  No active or idle sessions.\n');
    console.log('  Start a conversation: ved chat\n');
    return;
  }

  for (const s of sessions) {
    const wm = parseWorkingMemory(s.working_memory);
    const statusIcon = s.status === 'active' ? '🟢' : '🟡';
    const age = formatAge(Date.now() - s.last_active);
    const tokens = s.token_count || 0;

    console.log(`  ${statusIcon} ${s.id}`);
    console.log(`     Channel:  ${s.channel} (${s.channel_id})`);
    console.log(`     Author:   ${s.author_id}`);
    console.log(`     Trust:    Tier ${s.trust_tier}`);
    console.log(`     Messages: ${wm.messages.length}`);
    console.log(`     Facts:    ${Object.keys(wm.facts).length}`);
    console.log(`     Tokens:   ~${tokens.toLocaleString()}`);
    console.log(`     Active:   ${age}`);
    console.log(`     Started:  ${new Date(s.started_at).toISOString().replace('T', ' ').slice(0, 19)}`);
    console.log('');
  }

  console.log(`  ${sessions.length} session(s) total.\n`);
}

// ─── Main CLI entry ───

export async function runContextCli(app: VedApp, config: VedConfig, args: string[]): Promise<void> {
  const sub = args[0] ?? 'show';
  const subArgs = args.slice(1);

  switch (sub) {
    case 'show':
    case 'view':
    case 'inspect':
      return showContext(app, config, subArgs);

    case 'tokens':
    case 'budget':
    case 'usage':
      return showTokens(app, config, subArgs);

    case 'facts':
    case 'fact':
      return listFacts(app, config, subArgs);

    case 'add':
    case 'set':
      return addFact(app, config, subArgs);

    case 'remove':
    case 'rm':
    case 'delete':
    case 'del':
      return removeFact(app, config, subArgs);

    case 'clear':
    case 'reset':
      return clearFacts(app, config, subArgs);

    case 'messages':
    case 'msgs':
    case 'history':
    case 'conversation':
      return listMessages(app, config, subArgs);

    case 'simulate':
    case 'sim':
    case 'dry-run':
    case 'preview':
      return simulate(app, config, subArgs);

    case 'sessions':
    case 'list':
    case 'ls':
      return listSessions(app, config, subArgs);

    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error('\nUsage: ved context <subcommand>');
      console.error('\nSubcommands:');
      console.error('  show [--session <id>]           Show full assembled context');
      console.error('  tokens [--session <id>]         Token count breakdown');
      console.error('  facts [--session <id>]          List working memory facts');
      console.error('  add <key> <value>               Add a fact to working memory');
      console.error('  remove <key>                    Remove a fact');
      console.error('  clear                           Clear all facts');
      console.error('  messages [--session <id>]        List conversation messages');
      console.error('  simulate <query>                Preview RAG context injection');
      console.error('  sessions                        List active/idle sessions');
      console.error('\nAliases: ctx, window, prompt-debug');
      process.exit(1);
  }
}
