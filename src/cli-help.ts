/**
 * `ved help` — Unified help system for the Ved CLI.
 *
 * Provides:
 *   ved help                     — Show all commands with descriptions
 *   ved help <command>           — Show detailed help for a specific command
 *   ved help --categories        — Show commands grouped by category
 *   ved <command> --help         — Same as ved help <command>
 *   ved <command> -h             — Same as ved help <command>
 *
 * @module cli-help
 */

// ── Command Registry ───────────────────────────────────────────────────

export interface CommandInfo {
  name: string;
  aliases: string[];
  category: Category;
  summary: string;
  usage: string;
  subcommands?: string[];
  flags?: string[];
  examples?: string[];
}

export type Category =
  | 'core'
  | 'memory'
  | 'search'
  | 'trust'
  | 'tools'
  | 'monitoring'
  | 'data'
  | 'server'
  | 'config';

const CATEGORY_LABELS: Record<Category, string> = {
  core: '🏠 Core',
  memory: '🧠 Memory & Knowledge',
  search: '🔍 Search & RAG',
  trust: '🔐 Trust & Security',
  tools: '🛠️  Tools & Automation',
  monitoring: '📊 Monitoring & Logs',
  data: '💾 Data & Backup',
  server: '🌐 Server & API',
  config: '⚙️  Configuration',
};

const CATEGORY_ORDER: Category[] = [
  'core', 'memory', 'search', 'trust', 'tools',
  'monitoring', 'data', 'server', 'config',
];

export const COMMANDS: CommandInfo[] = [
  // ── Core ──
  {
    name: 'start',
    aliases: [],
    category: 'core',
    summary: 'Start Ved in interactive mode (default)',
    usage: 'ved [start]',
    examples: ['ved', 'ved start'],
  },
  {
    name: 'init',
    aliases: [],
    category: 'core',
    summary: 'Initialize ~/.ved/ directory with default config',
    usage: 'ved init',
    examples: ['ved init'],
  },
  {
    name: 'version',
    aliases: ['--version', '-v'],
    category: 'core',
    summary: 'Show Ved version',
    usage: 'ved version',
    examples: ['ved version', 'ved -v'],
  },
  {
    name: 'status',
    aliases: [],
    category: 'core',
    summary: 'Show health check and system status',
    usage: 'ved status',
    examples: ['ved status'],
  },
  {
    name: 'chat',
    aliases: ['c', 'talk'],
    category: 'core',
    summary: 'Start interactive conversation REPL',
    usage: 'ved chat',
    examples: ['ved chat', 'ved c'],
  },
  {
    name: 'run',
    aliases: ['ask', 'query', 'q'],
    category: 'core',
    summary: 'One-shot query mode — ask a question and get an answer',
    usage: 'ved run "<prompt>" [--model <m>] [--system <s>] [--no-rag] [--no-memory] [--json]',
    flags: ['--model <m>', '--system <s>', '--no-rag', '--no-memory', '--json', '--verbose'],
    examples: ['ved run "What is Ved?"', 'ved ask "summarize today" --no-rag', 'ved q "hello" --json'],
  },

  // ── Memory & Knowledge ──
  {
    name: 'memory',
    aliases: ['mem'],
    category: 'memory',
    summary: 'Browse and manage the Obsidian knowledge graph',
    usage: 'ved memory <subcommand> [options]',
    subcommands: ['list', 'show', 'graph', 'timeline', 'daily', 'forget', 'tags', 'types'],
    examples: ['ved memory list', 'ved mem show "John Doe"', 'ved memory graph "Project X" --depth 2', 'ved mem daily', 'ved memory tags'],
  },
  {
    name: 'template',
    aliases: ['templates', 'tpl'],
    category: 'memory',
    summary: 'Manage vault templates for creating entities, decisions, concepts',
    usage: 'ved template <subcommand> [options]',
    subcommands: ['list', 'show', 'create', 'edit', 'delete', 'use', 'vars'],
    examples: ['ved template list', 'ved tpl use person --var name="Jane Doe"', 'ved template show decision'],
  },
  {
    name: 'context',
    aliases: ['ctx', 'window', 'prompt-debug'],
    category: 'memory',
    summary: 'Inspect and manage the context window (tokens, facts, messages)',
    usage: 'ved context <subcommand> [--session <id>]',
    subcommands: ['show', 'tokens', 'facts', 'add', 'remove', 'clear', 'messages', 'simulate', 'sessions'],
    examples: ['ved ctx tokens', 'ved context facts', 'ved ctx add "User prefers dark mode"', 'ved context simulate "query"'],
  },

  // ── Search & RAG ──
  {
    name: 'search',
    aliases: [],
    category: 'search',
    summary: 'Search the knowledge base via RAG pipeline (FTS + vector + graph)',
    usage: 'ved search "<query>" [-n <limit>] [--verbose] [--fts-only] [--json]',
    flags: ['-n <limit>', '--verbose', '--fts-only', '--json'],
    examples: ['ved search "machine learning"', 'ved search "project status" -n 10 --verbose'],
  },
  {
    name: 'reindex',
    aliases: [],
    category: 'search',
    summary: 'Force rebuild of the entire RAG index from vault files',
    usage: 'ved reindex',
    examples: ['ved reindex'],
  },

  // ── Trust & Security ──
  {
    name: 'trust',
    aliases: ['t'],
    category: 'trust',
    summary: 'Manage trust tiers, the trust matrix, and work orders',
    usage: 'ved trust <subcommand> [options]',
    subcommands: ['matrix', 'resolve', 'assess', 'grant', 'revoke', 'ledger', 'pending', 'history', 'show', 'config'],
    examples: ['ved trust matrix', 'ved t resolve discord user123', 'ved trust pending', 'ved trust grant discord user123 3 --as owner1'],
  },
  {
    name: 'user',
    aliases: ['u', 'who', 'users'],
    category: 'trust',
    summary: 'Inspect known users, their sessions, and activity',
    usage: 'ved user <subcommand> [options]',
    subcommands: ['list', 'show', 'sessions', 'activity', 'stats'],
    examples: ['ved user list', 'ved u show user123', 'ved user sessions user123 --limit 5', 'ved user stats'],
  },

  // ── Tools & Automation ──
  {
    name: 'pipe',
    aliases: ['pipeline', 'chain'],
    category: 'tools',
    summary: 'Chain queries and shell commands into multi-step pipelines',
    usage: 'ved pipe "<step1>" "<step2>" ... | ved pipe -f <file.yaml> | ved pipe save/load/list/delete',
    subcommands: ['save', 'load', 'list', 'delete'],
    flags: ['-f <file>', '--dry-run', '--json', '--verbose'],
    examples: ['ved pipe "list recent decisions" "!sort"', 'ved pipe -f my-pipeline.yaml', 'ved pipe save my-flow "step1" "step2"'],
  },
  {
    name: 'alias',
    aliases: ['aliases', 'shortcut', 'shortcuts'],
    category: 'tools',
    summary: 'Manage command shortcuts (@-aliases)',
    usage: 'ved alias <subcommand> [options]',
    subcommands: ['list', 'add', 'remove', 'show', 'edit', 'run', 'export', 'import'],
    examples: ['ved alias list', 'ved alias add daily "memory daily"', 'ved @daily'],
  },
  {
    name: 'cron',
    aliases: [],
    category: 'tools',
    summary: 'Manage scheduled jobs (backup, reindex, doctor)',
    usage: 'ved cron <subcommand> [options]',
    subcommands: ['list', 'add', 'remove', 'enable', 'disable', 'run', 'history'],
    examples: ['ved cron list', 'ved cron add nightly-backup backup "0 2 * * *"', 'ved cron run nightly-backup'],
  },
  {
    name: 'plugin',
    aliases: [],
    category: 'tools',
    summary: 'Manage MCP tool plugins',
    usage: 'ved plugin <subcommand> [options]',
    subcommands: ['list', 'tools', 'add', 'remove', 'test'],
    examples: ['ved plugin list', 'ved plugin tools', 'ved plugin add my-server'],
  },
  {
    name: 'completions',
    aliases: [],
    category: 'tools',
    summary: 'Generate shell completions (bash/zsh/fish)',
    usage: 'ved completions <bash|zsh|fish>',
    examples: ['ved completions bash >> ~/.bashrc', 'ved completions zsh >> ~/.zshrc', 'ved completions fish > ~/.config/fish/completions/ved.fish'],
  },

  // ── Monitoring & Logs ──
  {
    name: 'stats',
    aliases: [],
    category: 'monitoring',
    summary: 'Show vault, RAG, audit, and session metrics',
    usage: 'ved stats',
    examples: ['ved stats'],
  },
  {
    name: 'history',
    aliases: [],
    category: 'monitoring',
    summary: 'View audit log with filters and chain verification',
    usage: 'ved history [--type <t>] [--since <date>] [--until <date>] [--limit <n>] [--verify] [--json]',
    flags: ['--type <t>', '--since <date>', '--until <date>', '--limit <n>', '--verify', '--types', '--json'],
    examples: ['ved history --limit 20', 'ved history --type tool_call --since 2026-03-01', 'ved history --verify'],
  },
  {
    name: 'doctor',
    aliases: [],
    category: 'monitoring',
    summary: 'Run 8-point self-diagnostics (config, DB, vault, audit, RAG, LLM, MCP)',
    usage: 'ved doctor',
    examples: ['ved doctor'],
  },
  {
    name: 'log',
    aliases: ['logs'],
    category: 'monitoring',
    summary: 'View, tail, search, and analyze structured log files',
    usage: 'ved log [subcommand] [options]',
    subcommands: ['show', 'tail', 'search', 'stats', 'levels', 'modules', 'clear', 'path'],
    flags: ['--level <l>', '--module <m>', '--since <t>', '--until <t>', '-n <limit>', '--json', '--no-color'],
    examples: ['ved log', 'ved log tail --level warn', 'ved log search "error" --since 1h', 'ved log stats'],
  },
  {
    name: 'profile',
    aliases: ['bench', 'benchmark'],
    category: 'monitoring',
    summary: 'Benchmark Ved subsystems (audit, vault, RAG, trust, DB, hash, memory)',
    usage: 'ved profile [category] [--iterations <n>] [--warmup <n>] [--json] [--verbose]',
    subcommands: ['all', 'audit', 'vault', 'rag', 'trust', 'db', 'hash', 'memory'],
    flags: ['--iterations <n>', '--warmup <n>', '--json', '--verbose', '--no-color'],
    examples: ['ved profile', 'ved bench audit --iterations 500', 'ved profile rag --json'],
  },

  {
    name: 'diff',
    aliases: ['changes', 'delta'],
    category: 'memory',
    summary: 'View vault changes, git history, blame, and knowledge evolution',
    usage: 'ved diff [subcommand|file] [options]',
    subcommands: ['log', 'show', 'stat', 'blame', 'between', 'files', 'summary'],
    flags: ['--limit <n>', '-n <n>', '--since <date>', '--days <n>', '--file <path>'],
    examples: [
      'ved diff',
      'ved diff entities/john.md',
      'ved diff log --limit 10',
      'ved diff show abc1234',
      'ved diff blame daily/2026-03-08.md',
      'ved diff between HEAD~5 HEAD',
      'ved diff files --since 2026-03-01',
      'ved diff summary --days 14',
    ],
  },

  // ── Data & Backup ──
  {
    name: 'export',
    aliases: [],
    category: 'data',
    summary: 'Export vault to portable JSON (with optional audit + stats)',
    usage: 'ved export [path] [--include-audit] [--include-stats]',
    flags: ['--include-audit', '--include-stats'],
    examples: ['ved export backup.json', 'ved export --include-audit'],
  },
  {
    name: 'import',
    aliases: [],
    category: 'data',
    summary: 'Import vault from JSON (merge/overwrite/fail modes)',
    usage: 'ved import <path|-> [--mode <merge|overwrite|fail>] [--dry-run]',
    flags: ['--mode <merge|overwrite|fail>', '--dry-run'],
    examples: ['ved import backup.json --mode merge', 'cat export.json | ved import - --dry-run'],
  },
  {
    name: 'backup',
    aliases: [],
    category: 'data',
    summary: 'Create, list, and restore vault+DB snapshot archives',
    usage: 'ved backup <subcommand> [options]',
    subcommands: ['create', 'list', 'restore'],
    flags: ['--keep <n>'],
    examples: ['ved backup create', 'ved backup list', 'ved backup restore latest'],
  },
  {
    name: 'gc',
    aliases: [],
    category: 'data',
    summary: 'Garbage collection — clean up old sessions, audit entries, temp files',
    usage: 'ved gc <status|run>',
    subcommands: ['status', 'run'],
    examples: ['ved gc status', 'ved gc run'],
  },
  {
    name: 'snapshot',
    aliases: ['snap', 'checkpoint'],
    category: 'data',
    summary: 'Lightweight vault point-in-time snapshots using git tags',
    usage: 'ved snapshot <subcommand> [options]',
    subcommands: ['list', 'create', 'show', 'diff', 'restore', 'delete', 'export'],
    flags: ['-m <message>', '--force', '--stat'],
    examples: [
      'ved snapshot',
      'ved snapshot create v1-baseline -m "Initial knowledge base"',
      'ved snapshot show v1-baseline',
      'ved snapshot diff v1-baseline',
      'ved snapshot diff v1-baseline v2-updated --stat',
      'ved snapshot restore v1-baseline',
      'ved snapshot delete old-snap',
      'ved snapshot export v1-baseline ./backup.tar.gz',
    ],
  },

  // ── Server & API ──
  {
    name: 'serve',
    aliases: ['api'],
    category: 'server',
    summary: 'Start HTTP API server with REST + SSE + dashboard',
    usage: 'ved serve [--port <n>] [--host <addr>] [--token <secret>] [--cors <origin>]',
    flags: ['--port <n>', '--host <addr>', '--token <secret>', '--cors <origin>'],
    examples: ['ved serve', 'ved serve --port 8080', 'ved api --token mysecret --cors "*"'],
  },
  {
    name: 'webhook',
    aliases: [],
    category: 'server',
    summary: 'Manage webhook event delivery with HMAC signing',
    usage: 'ved webhook <subcommand> [options]',
    subcommands: ['list', 'add', 'remove', 'enable', 'disable', 'deliveries', 'stats', 'test'],
    examples: ['ved webhook list', 'ved webhook add alerts https://example.com/hook --secret s3cret', 'ved webhook test alerts'],
  },
  {
    name: 'watch',
    aliases: [],
    category: 'server',
    summary: 'Standalone vault file watcher — indexes changes to RAG without full event loop',
    usage: 'ved watch',
    examples: ['ved watch'],
  },

  // ── Configuration ──
  {
    name: 'config',
    aliases: [],
    category: 'config',
    summary: 'Validate, show, or locate Ved configuration',
    usage: 'ved config <validate|show|path>',
    subcommands: ['validate', 'show', 'path'],
    examples: ['ved config validate', 'ved config show', 'ved config path'],
  },
  {
    name: 'env',
    aliases: ['envs', 'environment', 'environments'],
    category: 'config',
    summary: 'Manage configuration environments (dev/prod/test overlays)',
    usage: 'ved env <subcommand> [options]',
    subcommands: ['current', 'list', 'show', 'create', 'use', 'edit', 'delete', 'diff', 'reset'],
    flags: ['--from <env>', '--template <name>', '--from-current'],
    examples: ['ved env current', 'ved env list', 'ved env create staging --template prod', 'ved env use dev', 'ved env diff dev prod'],
  },
  {
    name: 'prompt',
    aliases: ['prompts', 'sp', 'system-prompt'],
    category: 'config',
    summary: 'Manage system prompt profiles',
    usage: 'ved prompt <subcommand> [options]',
    subcommands: ['list', 'show', 'create', 'edit', 'use', 'test', 'reset', 'diff'],
    examples: ['ved prompt list', 'ved sp show', 'ved prompt create research --template', 'ved prompt test'],
  },
  {
    name: 'upgrade',
    aliases: [],
    category: 'config',
    summary: 'Manage database migrations (status, run, verify, history)',
    usage: 'ved upgrade <status|run|verify|history>',
    subcommands: ['status', 'run', 'verify', 'history'],
    examples: ['ved upgrade status', 'ved upgrade run', 'ved upgrade verify'],
  },
  {
    name: 'help',
    aliases: ['-h', '--help'],
    category: 'core',
    summary: 'Show this help or detailed help for a command',
    usage: 'ved help [command]',
    examples: ['ved help', 'ved help search', 'ved help trust'],
  },
];

// ── Lookup ──────────────────────────────────────────────────────────────

const commandMap = new Map<string, CommandInfo>();
for (const cmd of COMMANDS) {
  commandMap.set(cmd.name, cmd);
  for (const alias of cmd.aliases) {
    commandMap.set(alias, cmd);
  }
}

export function findCommand(name: string): CommandInfo | undefined {
  return commandMap.get(name);
}

export function allCommands(): CommandInfo[] {
  return COMMANDS;
}

export function commandsByCategory(): Map<Category, CommandInfo[]> {
  const map = new Map<Category, CommandInfo[]>();
  for (const cat of CATEGORY_ORDER) {
    map.set(cat, []);
  }
  for (const cmd of COMMANDS) {
    const list = map.get(cmd.category);
    if (list) list.push(cmd);
  }
  return map;
}

// ── Formatting ──────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

export function formatOverview(useColor = true): string {
  const b = useColor ? BOLD : '';
  const d = useColor ? DIM : '';
  const c = useColor ? CYAN : '';
  const g = useColor ? GREEN : '';
  const r = useColor ? RESET : '';

  const lines: string[] = [];
  lines.push(`${b}Ved${r} — The personal AI agent that remembers everything and proves it.`);
  lines.push('');
  lines.push(`${b}USAGE${r}`);
  lines.push(`  ved <command> [options]`);
  lines.push('');

  const grouped = commandsByCategory();
  for (const cat of CATEGORY_ORDER) {
    const cmds = grouped.get(cat);
    if (!cmds || cmds.length === 0) continue;
    lines.push(`${b}${CATEGORY_LABELS[cat]}${r}`);
    for (const cmd of cmds) {
      const aliasStr = cmd.aliases.length > 0
        ? ` ${d}(${cmd.aliases.join(', ')})${r}`
        : '';
      lines.push(`  ${g}${pad(cmd.name, 14)}${r}${cmd.summary}${aliasStr}`);
    }
    lines.push('');
  }

  lines.push(`Run ${c}ved help <command>${r} for detailed help on any command.`);
  return lines.join('\n');
}

export function formatCommandHelp(cmd: CommandInfo, useColor = true): string {
  const b = useColor ? BOLD : '';
  const d = useColor ? DIM : '';
  const c = useColor ? CYAN : '';
  const g = useColor ? GREEN : '';
  const y = useColor ? YELLOW : '';
  const r = useColor ? RESET : '';

  const lines: string[] = [];
  lines.push(`${b}ved ${cmd.name}${r} — ${cmd.summary}`);
  lines.push('');

  if (cmd.aliases.length > 0) {
    lines.push(`${b}ALIASES${r}`);
    lines.push(`  ${cmd.aliases.join(', ')}`);
    lines.push('');
  }

  lines.push(`${b}USAGE${r}`);
  lines.push(`  ${cmd.usage}`);
  lines.push('');

  if (cmd.subcommands && cmd.subcommands.length > 0) {
    lines.push(`${b}SUBCOMMANDS${r}`);
    for (const sub of cmd.subcommands) {
      lines.push(`  ${g}${sub}${r}`);
    }
    lines.push('');
  }

  if (cmd.flags && cmd.flags.length > 0) {
    lines.push(`${b}FLAGS${r}`);
    for (const flag of cmd.flags) {
      lines.push(`  ${y}${flag}${r}`);
    }
    lines.push('');
  }

  if (cmd.examples && cmd.examples.length > 0) {
    lines.push(`${b}EXAMPLES${r}`);
    for (const ex of cmd.examples) {
      lines.push(`  ${d}$${r} ${c}${ex}${r}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── CLI Handler ─────────────────────────────────────────────────────────

export function helpCmd(args: string[]): void {
  const noColor = args.includes('--no-color');
  const useColor = !noColor && process.stdout.isTTY !== false;
  const categories = args.includes('--categories') || args.includes('-c');

  // Filter out flags
  const positional = args.filter(a => !a.startsWith('-'));
  const topic = positional[0];

  if (!topic || categories) {
    console.log(formatOverview(useColor));
    return;
  }

  const cmd = findCommand(topic);
  if (!cmd) {
    console.error(`Unknown command: ${topic}`);
    console.log(`Run 'ved help' to see all available commands.`);
    process.exit(1);
  }

  console.log(formatCommandHelp(cmd, useColor));
}

/**
 * Check if args contain --help or -h. Returns true if help was shown.
 * Use at the top of each command handler for consistent --help support.
 */
export function checkHelp(commandName: string, args: string[]): boolean {
  if (args.includes('--help') || args.includes('-h')) {
    const cmd = findCommand(commandName);
    if (cmd) {
      const useColor = process.stdout.isTTY !== false;
      console.log(formatCommandHelp(cmd, useColor));
    } else {
      console.log(`No help available for '${commandName}'.`);
    }
    return true;
  }
  return false;
}
