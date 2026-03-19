/**
 * `ved agent` — Sub-agent definition and execution manager.
 *
 * Define named agent profiles with custom system prompts, tool allowlists,
 * trust tiers, memory scopes, and model overrides. Run them one-shot or
 * interactively. Agents are YAML files in `~/.ved/agents/`.
 *
 * Subcommands:
 *   list              List defined agents
 *   show <name>       Show agent configuration
 *   create <name>     Create a new agent profile
 *   edit <name>       Open agent in $EDITOR
 *   delete <name>     Delete an agent profile
 *   run <name> <q>    Run agent one-shot with a query
 *   history <name>    Show past agent runs
 *   clone <src> <dst> Clone an existing agent
 *   export [name]     Export agents to JSON
 *   import <file>     Import agents from JSON
 *
 * Aliases: ved agents, ved persona, ved personas
 *
 * @module cli-agent
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// ── Constants ──

const AGENTS_DIR = join(homedir(), '.ved', 'agents');
const HISTORY_DIR = join(homedir(), '.ved', 'agent-history');

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
};

// ── Types ──

export interface AgentProfile {
  /** Agent name (filename sans extension) */
  name: string;
  /** Human-readable description */
  description: string;
  /** System prompt override (inline or prompt profile name) */
  systemPrompt?: string;
  /** Reference to a prompt profile in ~/.ved/prompts/ */
  promptProfile?: string;
  /** Allowed MCP tool names (empty = all tools allowed) */
  tools?: string[];
  /** Denied MCP tool names (takes precedence over tools) */
  toolsDeny?: string[];
  /** Trust tier the agent operates at (1-4) */
  trustTier?: 1 | 2 | 3 | 4;
  /** Vault folders the agent can access */
  memoryScope?: string[];
  /** LLM model override */
  model?: string;
  /** Max agentic loop turns */
  maxTurns?: number;
  /** Skip RAG enrichment */
  noRag?: boolean;
  /** Timeout in seconds per run */
  timeout?: number;
  /** Custom metadata tags */
  tags?: string[];
  /** Created timestamp */
  created?: string;
  /** Last modified timestamp */
  modified?: string;
}

export interface AgentRunRecord {
  /** ISO timestamp */
  timestamp: string;
  /** Agent name */
  agent: string;
  /** Input query */
  query: string;
  /** Response summary (first 200 chars) */
  responseSummary: string;
  /** Duration in ms */
  durationMs: number;
  /** Whether tools were invoked */
  toolsUsed: string[];
  /** Exit status */
  status: 'success' | 'error' | 'timeout';
  /** Error message if status=error */
  error?: string;
}

// ── YAML mini-serializer (no dependency) ──

function serializeYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;

    if (typeof val === 'string') {
      // Multi-line strings get block scalar
      if (val.includes('\n')) {
        lines.push(`${pad}${key}: |`);
        for (const line of val.split('\n')) {
          lines.push(`${pad}  ${line}`);
        }
      } else {
        // Quote if it contains special chars
        const needsQuote = /[:#{}[\],&*?|>!%@`"']/.test(val) || val === '' || val === 'true' || val === 'false';
        lines.push(`${pad}${key}: ${needsQuote ? JSON.stringify(val) : val}`);
      }
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`${pad}${key}: ${val}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (typeof val[0] === 'string' || typeof val[0] === 'number') {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          const needsQuote = typeof item === 'string' && (/[:#{}[\],&*?|>!%@`"']/.test(item) || item === '');
          lines.push(`${pad}  - ${needsQuote ? JSON.stringify(item) : item}`);
        }
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          lines.push(`${pad}  - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof val === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(serializeYaml(val as Record<string, unknown>, indent + 1));
    }
  }

  return lines.join('\n');
}

function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Skip comments and blank lines
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const match = line.match(/^(\s*)(\w[\w-]*):\s*(.*)/);
    if (!match) {
      i++;
      continue;
    }

    const indent = match[1].length;
    const key = match[2];
    let value = match[3].trim();

    // Block scalar (|)
    if (value === '|') {
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim() === '' || (nextLine.match(/^\s*/)?.[0].length ?? 0) > indent) {
          blockLines.push(nextLine.replace(new RegExp(`^\\s{${indent + 2}}`), ''));
          i++;
        } else {
          break;
        }
      }
      result[key] = blockLines.join('\n').replace(/\n+$/, '');
      continue;
    }

    // List
    if (value === '' || value === '[]') {
      // Check if next lines are list items
      if (value === '[]') {
        result[key] = [];
        i++;
        continue;
      }

      const items: unknown[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const listMatch = nextLine.match(/^\s+-\s+(.*)/);
        if (listMatch) {
          let item: unknown = listMatch[1].trim();
          // Unquote
          if (typeof item === 'string' && item.startsWith('"') && item.endsWith('"')) {
            item = JSON.parse(item);
          }
          items.push(item);
          i++;
        } else if (nextLine.trim() === '' || nextLine.trim().startsWith('#')) {
          i++;
        } else {
          break;
        }
      }

      if (items.length > 0) {
        result[key] = items;
      } else {
        result[key] = '';
      }
      continue;
    }

    // Scalar value
    // Remove quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    // Type coercion
    if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else {
      result[key] = value;
    }

    i++;
  }

  return result;
}

// ── File Operations ──

function ensureDirs(): void {
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

function agentPath(name: string): string {
  return join(AGENTS_DIR, `${name}.yaml`);
}

function historyPath(name: string): string {
  return join(HISTORY_DIR, `${name}.jsonl`);
}

/** Validate agent name (safe for filesystem) */
export function validateAgentName(name: string): string | null {
  if (!name) return 'Agent name is required';
  if (name.length > 64) return 'Agent name must be 64 characters or fewer';
  if (!/^[a-zA-Z]/.test(name)) return 'Agent name must start with a letter';
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) return 'Agent name must be alphanumeric (hyphens and underscores allowed)';
  // Reserved names
  const reserved = [
    'list', 'show', 'create', 'edit', 'delete', 'run', 'history',
    'clone', 'export', 'import', 'help', 'default', 'ved', 'system',
  ];
  if (reserved.includes(name.toLowerCase())) return `'${name}' is a reserved name`;
  // Path traversal
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return 'Agent name cannot contain path separators';
  }
  return null;
}

export function loadAgent(name: string): AgentProfile | null {
  const p = agentPath(name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = parseYaml(raw) as unknown as AgentProfile;
    parsed.name = name; // Ensure name matches filename
    return parsed;
  } catch {
    return null;
  }
}

export function saveAgent(agent: AgentProfile): void {
  ensureDirs();
  const { name, ...rest } = agent;
  rest.modified = new Date().toISOString();
  if (!rest.created) rest.created = rest.modified;
  const yaml = serializeYaml(rest as unknown as Record<string, unknown>);
  writeFileSync(agentPath(name), yaml + '\n', 'utf8');
}

export function listAgents(): AgentProfile[] {
  ensureDirs();
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.yaml'));
  const agents: AgentProfile[] = [];
  for (const file of files) {
    const name = basename(file, '.yaml');
    const agent = loadAgent(name);
    if (agent) agents.push(agent);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteAgent(name: string): boolean {
  const p = agentPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function loadHistory(name: string, limit = 50): AgentRunRecord[] {
  const p = historyPath(name);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  const records: AgentRunRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return records;
}

export function appendHistory(record: AgentRunRecord): void {
  ensureDirs();
  const p = historyPath(record.agent);
  const line = JSON.stringify(record) + '\n';
  const { appendFileSync } = require('node:fs');
  appendFileSync(p, line, 'utf8');
}

// ── Built-in Templates ──

const TEMPLATES: Record<string, Omit<AgentProfile, 'name'>> = {
  researcher: {
    description: 'Research assistant — searches vault and web, synthesizes findings',
    systemPrompt: 'You are a research assistant. Search for information, cross-reference sources, and synthesize clear, cited summaries. Always cite your sources.',
    tools: ['web_search', 'web_fetch', 'vault_search'],
    trustTier: 2,
    noRag: false,
    maxTurns: 10,
    tags: ['research', 'analysis'],
  },
  coder: {
    description: 'Coding assistant — writes, reviews, and refactors code',
    systemPrompt: 'You are a coding assistant. Write clean, well-tested code. Follow best practices. Explain your reasoning.',
    tools: ['file_read', 'file_write', 'shell_exec'],
    trustTier: 3,
    maxTurns: 15,
    tags: ['coding', 'development'],
  },
  writer: {
    description: 'Writing assistant — drafts, edits, and refines text',
    systemPrompt: 'You are a writing assistant. Help draft, edit, and refine text. Focus on clarity, tone, and structure. Ask clarifying questions when the brief is ambiguous.',
    tools: [],
    trustTier: 2,
    noRag: false,
    maxTurns: 5,
    tags: ['writing', 'content'],
  },
  analyst: {
    description: 'Data analyst — interprets data, generates insights, creates summaries',
    systemPrompt: 'You are a data analyst. Interpret data accurately, identify trends, and present findings clearly. Use numbers and evidence to support conclusions.',
    tools: ['vault_search', 'file_read'],
    trustTier: 2,
    maxTurns: 8,
    tags: ['analysis', 'data'],
  },
  guardian: {
    description: 'Security reviewer — audits code, configs, and permissions',
    systemPrompt: 'You are a security reviewer. Audit code, configurations, and access patterns for vulnerabilities. Be thorough and conservative. Flag risks by severity.',
    tools: ['file_read', 'vault_search'],
    trustTier: 4,
    maxTurns: 12,
    tags: ['security', 'audit'],
  },
};

// ── CLI Entry Point ──

export async function agentCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      return listCmd();
    case 'show':
    case 'cat':
    case 'view':
      return showCmd(args.slice(1));
    case 'create':
    case 'new':
    case 'add':
      return createCmd(args.slice(1));
    case 'edit':
      return editCmd(args.slice(1));
    case 'delete':
    case 'rm':
    case 'remove':
      return deleteCmd(args.slice(1));
    case 'run':
    case 'exec':
      return runCmd(args.slice(1));
    case 'history':
    case 'runs':
      return historyCmd(args.slice(1));
    case 'clone':
    case 'copy':
    case 'cp':
      return cloneCmd(args.slice(1));
    case 'export':
      return exportCmd(args.slice(1));
    case 'import':
      return importCmd(args.slice(1));
    default:
      // Check if it's an agent name (shortcut: `ved agent myagent "query"`)
      const agent = loadAgent(sub);
      if (agent && args[1]) {
        return runCmd([sub, ...args.slice(1)]);
      }
      console.error(`Unknown agent subcommand: ${sub}`);
      console.log('Usage: ved agent [list|show|create|edit|delete|run|history|clone|export|import]');
      process.exitCode = 1;
  }
}

// ── Subcommand Implementations ──

function listCmd(): void {
  const agents = listAgents();

  if (agents.length === 0) {
    console.log(`\n  ${C.dim}No agents defined.${C.reset}`);
    console.log(`  Create one with: ${C.cyan}ved agent create <name>${C.reset}`);
    console.log(`  Available templates: ${Object.keys(TEMPLATES).join(', ')}\n`);
    return;
  }

  console.log(`\n  ${C.bold}Agents${C.reset} (${agents.length})\n`);

  const maxName = Math.max(...agents.map(a => a.name.length), 4);

  for (const agent of agents) {
    const tier = agent.trustTier ? `T${agent.trustTier}` : '--';
    const model = agent.model ?? 'default';
    const tags = agent.tags?.length ? ` ${C.dim}[${agent.tags.join(', ')}]${C.reset}` : '';
    const desc = agent.description ? ` ${C.dim}${agent.description}${C.reset}` : '';
    console.log(`  ${C.cyan}${agent.name.padEnd(maxName)}${C.reset}  ${tier}  ${C.dim}${model}${C.reset}${tags}${desc}`);
  }

  console.log();
}

function showCmd(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved agent show <name>');
    process.exitCode = 1;
    return;
  }

  const agent = loadAgent(name);
  if (!agent) {
    console.error(`Agent not found: ${name}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${C.bold}${C.cyan}${agent.name}${C.reset}`);
  if (agent.description) console.log(`  ${agent.description}`);
  console.log();

  const field = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        console.log(`  ${C.dim}${label}:${C.reset} ${C.yellow}(all)${C.reset}`);
      } else {
        console.log(`  ${C.dim}${label}:${C.reset} ${value.join(', ')}`);
      }
    } else {
      console.log(`  ${C.dim}${label}:${C.reset} ${value}`);
    }
  };

  if (agent.systemPrompt) {
    const preview = agent.systemPrompt.length > 120
      ? agent.systemPrompt.slice(0, 120) + '...'
      : agent.systemPrompt;
    field('System prompt', preview);
  }
  if (agent.promptProfile) field('Prompt profile', agent.promptProfile);
  field('Trust tier', agent.trustTier);
  field('Model', agent.model ?? 'default');
  field('Max turns', agent.maxTurns);
  field('Timeout', agent.timeout ? `${agent.timeout}s` : undefined);
  field('RAG', agent.noRag ? 'disabled' : 'enabled');
  field('Tools (allow)', agent.tools);
  field('Tools (deny)', agent.toolsDeny);
  field('Memory scope', agent.memoryScope);
  field('Tags', agent.tags);
  field('Created', agent.created);
  field('Modified', agent.modified);

  // Show recent history
  const history = loadHistory(name, 5);
  if (history.length > 0) {
    console.log(`\n  ${C.dim}Recent runs:${C.reset}`);
    for (const run of history.slice(-3)) {
      const status = run.status === 'success' ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      const time = new Date(run.timestamp).toLocaleString();
      console.log(`    ${status} ${C.dim}${time}${C.reset} ${run.query.slice(0, 60)}`);
    }
  }

  console.log();
}

function createCmd(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved agent create <name> [--template <template>] [--description <desc>]');
    console.log(`\nAvailable templates: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const nameError = validateAgentName(name);
  if (nameError) {
    console.error(`Invalid agent name: ${nameError}`);
    process.exitCode = 1;
    return;
  }

  if (loadAgent(name)) {
    console.error(`Agent '${name}' already exists. Use 'ved agent edit ${name}' to modify.`);
    process.exitCode = 1;
    return;
  }

  // Parse flags
  let template: string | undefined;
  let description: string | undefined;
  let model: string | undefined;
  let trustTier: 1 | 2 | 3 | 4 | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--template' || arg === '-t') && args[i + 1]) {
      template = args[++i];
    } else if ((arg === '--description' || arg === '-d' || arg === '--desc') && args[i + 1]) {
      description = args[++i];
    } else if ((arg === '--model' || arg === '-m') && args[i + 1]) {
      model = args[++i];
    } else if (arg === '--tier' && args[i + 1]) {
      const t = parseInt(args[++i], 10);
      if (t >= 1 && t <= 4) trustTier = t as 1 | 2 | 3 | 4;
    }
  }

  let agent: AgentProfile;

  if (template) {
    const tpl = TEMPLATES[template];
    if (!tpl) {
      console.error(`Unknown template: ${template}`);
      console.log(`Available: ${Object.keys(TEMPLATES).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    agent = { name, ...tpl };
  } else {
    agent = {
      name,
      description: description ?? `Custom agent: ${name}`,
      systemPrompt: `You are ${name}, a specialized assistant.`,
      trustTier: trustTier ?? 2,
      maxTurns: 10,
      tags: [],
    };
  }

  // Apply overrides
  if (description) agent.description = description;
  if (model) agent.model = model;
  if (trustTier) agent.trustTier = trustTier;

  saveAgent(agent);
  console.log(`\n  ${C.green}✓${C.reset} Created agent: ${C.cyan}${name}${C.reset}`);
  if (template) console.log(`    Template: ${template}`);
  console.log(`    Config: ${agentPath(name)}`);
  console.log(`    Edit with: ${C.dim}ved agent edit ${name}${C.reset}\n`);
}

function editCmd(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved agent edit <name>');
    process.exitCode = 1;
    return;
  }

  const p = agentPath(name);
  if (!existsSync(p)) {
    console.error(`Agent not found: ${name}`);
    process.exitCode = 1;
    return;
  }

  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  try {
    execSync(`${editor} ${JSON.stringify(p)}`, { stdio: 'inherit' });
    // Validate after edit
    const updated = loadAgent(name);
    if (updated) {
      console.log(`\n  ${C.green}✓${C.reset} Updated agent: ${C.cyan}${name}${C.reset}\n`);
    } else {
      console.error(`\n  ${C.yellow}⚠${C.reset} Warning: Agent file may have YAML errors.\n`);
    }
  } catch {
    console.error('Editor exited with error');
    process.exitCode = 1;
  }
}

function deleteCmd(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved agent delete <name>');
    process.exitCode = 1;
    return;
  }

  if (!deleteAgent(name)) {
    console.error(`Agent not found: ${name}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${C.green}✓${C.reset} Deleted agent: ${C.cyan}${name}${C.reset}\n`);
}

async function runCmd(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved agent run <name> <query>');
    process.exitCode = 1;
    return;
  }

  const agent = loadAgent(name);
  if (!agent) {
    console.error(`Agent not found: ${name}`);
    process.exitCode = 1;
    return;
  }

  // Collect query from remaining args
  const queryParts: string[] = [];
  let format: 'text' | 'json' | 'raw' = 'text';
  let verbose = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      format = 'json';
    } else if (arg === '--raw') {
      format = 'raw';
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (!arg.startsWith('-')) {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error('No query provided');
    console.error('Usage: ved agent run <name> "your question"');
    process.exitCode = 1;
    return;
  }

  const startTime = Date.now();

  if (format === 'text') {
    console.log(`\n  ${C.dim}Running agent:${C.reset} ${C.cyan}${name}${C.reset}`);
    if (verbose) {
      console.log(`  ${C.dim}Model: ${agent.model ?? 'default'} | Trust: T${agent.trustTier ?? 2} | Max turns: ${agent.maxTurns ?? 10}${C.reset}`);
    }
    console.log();
  }

  // Build run configuration from agent profile
  const timeout = agent.timeout ?? 120;

  // Import and use processMessageDirect for execution
  try {
    const { createApp } = await import('./app.js');
    const { ulid } = await import('ulid');

    const app = createApp();
    await app.init();

    try {
      const msg = {
        id: ulid(),
        channel: 'run' as const,
        author: `agent-${name}-${Date.now()}`,
        content: query,
        timestamp: Date.now(),
      };

      const timeoutMs = timeout * 1000;

      const response = await Promise.race([
        app.processMessageDirect(msg),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)
        ),
      ]);

      const durationMs = Date.now() - startTime;

      if (format === 'json') {
        console.log(JSON.stringify({
          agent: name,
          query,
          response: response.content,
          durationMs,
          status: 'success',
        }, null, 2));
      } else if (format === 'raw') {
        console.log(response.content);
      } else {
        console.log(`  ${response.content}`);
        if (verbose) {
          console.log(`\n  ${C.dim}Duration: ${durationMs}ms${C.reset}`);
        }
        console.log();
      }

      // Record to history
      appendHistory({
        timestamp: new Date().toISOString(),
        agent: name,
        query,
        responseSummary: response.content.slice(0, 200),
        durationMs,
        toolsUsed: response.actions?.map((a: { tool: string }) => a.tool) ?? [],
        status: 'success',
      });
    } finally {
      await app.stop();
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (format === 'json') {
      console.log(JSON.stringify({
        agent: name,
        query,
        error: errorMsg,
        durationMs,
        status: 'error',
      }, null, 2));
    } else {
      console.error(`  ${C.red}Error:${C.reset} ${errorMsg}`);
    }

    // Record error to history
    appendHistory({
      timestamp: new Date().toISOString(),
      agent: name,
      query,
      responseSummary: '',
      durationMs,
      toolsUsed: [],
      status: 'error',
      error: errorMsg,
    });

    process.exitCode = 1;
  }
}

function historyCmd(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved agent history <name> [--limit <n>] [--json]');
    process.exitCode = 1;
    return;
  }

  let limit = 20;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      json = true;
    }
  }

  const records = loadHistory(name, limit);

  if (json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(`\n  ${C.dim}No run history for agent '${name}'.${C.reset}\n`);
    return;
  }

  console.log(`\n  ${C.bold}Run History: ${C.cyan}${name}${C.reset} (${records.length})\n`);

  for (const run of records) {
    const icon = run.status === 'success' ? `${C.green}✓${C.reset}` : run.status === 'timeout' ? `${C.yellow}⏱${C.reset}` : `${C.red}✗${C.reset}`;
    const time = new Date(run.timestamp).toLocaleString();
    const dur = run.durationMs < 1000 ? `${run.durationMs}ms` : `${(run.durationMs / 1000).toFixed(1)}s`;
    const tools = run.toolsUsed.length > 0 ? ` ${C.dim}[${run.toolsUsed.join(', ')}]${C.reset}` : '';
    console.log(`  ${icon} ${C.dim}${time}${C.reset} ${C.dim}(${dur})${C.reset} ${run.query.slice(0, 60)}${tools}`);
    if (run.error) {
      console.log(`    ${C.red}${run.error.slice(0, 80)}${C.reset}`);
    }
  }

  console.log();
}

function cloneCmd(args: string[]): void {
  const [src, dst] = args;
  if (!src || !dst) {
    console.error('Usage: ved agent clone <source> <destination>');
    process.exitCode = 1;
    return;
  }

  const nameError = validateAgentName(dst);
  if (nameError) {
    console.error(`Invalid destination name: ${nameError}`);
    process.exitCode = 1;
    return;
  }

  const source = loadAgent(src);
  if (!source) {
    console.error(`Source agent not found: ${src}`);
    process.exitCode = 1;
    return;
  }

  if (loadAgent(dst)) {
    console.error(`Destination agent '${dst}' already exists`);
    process.exitCode = 1;
    return;
  }

  const cloned: AgentProfile = {
    ...source,
    name: dst,
    description: `${source.description} (cloned from ${src})`,
    created: undefined,
    modified: undefined,
  };

  saveAgent(cloned);
  console.log(`\n  ${C.green}✓${C.reset} Cloned ${C.cyan}${src}${C.reset} → ${C.cyan}${dst}${C.reset}\n`);
}

function exportCmd(args: string[]): void {
  const name = args[0];

  if (name && !name.startsWith('-')) {
    // Export single agent
    const agent = loadAgent(name);
    if (!agent) {
      console.error(`Agent not found: ${name}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ agents: [agent] }, null, 2));
  } else {
    // Export all
    const agents = listAgents();
    if (agents.length === 0) {
      console.error('No agents to export');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ agents }, null, 2));
  }
}

function importCmd(args: string[]): void {
  const filePath = args[0];
  const dryRun = args.includes('--dry-run');
  const merge = args.includes('--merge');

  if (!filePath) {
    console.error('Usage: ved agent import <file.json> [--dry-run] [--merge]');
    process.exitCode = 1;
    return;
  }

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  let data: { agents: AgentProfile[] };
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    console.error('Invalid JSON file');
    process.exitCode = 1;
    return;
  }

  if (!data.agents || !Array.isArray(data.agents)) {
    console.error('Invalid format: expected { agents: [...] }');
    process.exitCode = 1;
    return;
  }

  let imported = 0;
  let skipped = 0;

  for (const agent of data.agents) {
    if (!agent.name) {
      console.error('  Skipped agent with no name');
      skipped++;
      continue;
    }

    const nameError = validateAgentName(agent.name);
    if (nameError) {
      console.error(`  Skipped '${agent.name}': ${nameError}`);
      skipped++;
      continue;
    }

    const exists = loadAgent(agent.name);
    if (exists && !merge) {
      console.log(`  ${C.yellow}Skipped${C.reset} '${agent.name}' (already exists, use --merge to overwrite)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  ${C.dim}Would import:${C.reset} ${agent.name}`);
      imported++;
      continue;
    }

    saveAgent(agent);
    console.log(`  ${C.green}✓${C.reset} Imported: ${C.cyan}${agent.name}${C.reset}`);
    imported++;
  }

  console.log(`\n  ${imported} imported, ${skipped} skipped${dryRun ? ' (dry run)' : ''}\n`);
}

// ── Exports for testing ──

export {
  AGENTS_DIR,
  HISTORY_DIR,
  TEMPLATES,
  serializeYaml,
  parseYaml,
  ensureDirs,
  agentPath,
  historyPath,
  appendHistory as appendHistoryFn,
};
