/**
 * ved env — Environment manager.
 *
 * Manage multiple configuration environments (dev, prod, test, staging, etc.).
 * Each environment is a YAML config overlay stored in ~/.ved/environments/.
 * When active, the environment config merges between config.yaml and config.local.yaml.
 *
 * Subcommands:
 *   ved env                          — Show current environment (default)
 *   ved env list                     — List all environments
 *   ved env current                  — Show current active environment
 *   ved env show <name>              — Display environment config
 *   ved env create <name> [--from <env>] [--from-current] — Create environment
 *   ved env use <name>               — Switch to environment
 *   ved env edit <name>              — Open environment config in $EDITOR
 *   ved env delete <name>            — Remove an environment
 *   ved env diff <a> <b>             — Compare two environments
 *   ved env reset                    — Deactivate environment (use defaults)
 *
 * Aliases: ved envs, ved environment, ved environments
 *
 * @module cli-env
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { getConfigDir } from './core/config.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface EnvMeta {
  /** Environment name */
  name: string;
  /** File path */
  path: string;
  /** File size in bytes */
  size: number;
  /** ISO creation/modification time */
  modifiedAt: string;
  /** Whether this is the active environment */
  active: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const ENVS_DIR = 'environments';
const ACTIVE_FILE = 'active-env';
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const RESERVED_NAMES = new Set([
  'default', 'config', 'local', 'config.yaml', 'config.local',
  'active', 'active-env', 'none', 'reset', 'list', 'show',
  'create', 'edit', 'delete', 'diff', 'use', 'current',
]);

const BUILT_IN_TEMPLATES: Record<string, Record<string, unknown>> = {
  dev: {
    logLevel: 'debug',
    logFormat: 'text',
    llm: {
      provider: 'ollama',
      model: 'llama3.2',
      temperature: 0.9,
      maxTokensPerMessage: 2048,
    },
    trust: {
      approvalTimeoutMs: 600_000,
    },
    audit: {
      anchorInterval: 10,
    },
  },
  prod: {
    logLevel: 'warn',
    logFormat: 'json',
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
    },
    trust: {
      approvalTimeoutMs: 300_000,
      maxToolCallsPerMessage: 5,
    },
  },
  test: {
    logLevel: 'error',
    logFormat: 'text',
    llm: {
      provider: 'ollama',
      model: 'llama3.2',
      temperature: 0.0,
      maxTokensPerMessage: 1024,
      maxTokensPerSession: 10_000,
    },
    memory: {
      gitEnabled: false,
      sessionIdleMinutes: 5,
    },
    trust: {
      approvalTimeoutMs: 5_000,
    },
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

function getEnvsDir(): string {
  return join(getConfigDir(), ENVS_DIR);
}

function getActiveFilePath(): string {
  return join(getConfigDir(), ACTIVE_FILE);
}

function ensureEnvsDir(): void {
  const dir = getEnvsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Validate environment name.
 */
export function validateEnvName(name: string): { valid: boolean; reason?: string } {
  if (!name || name.trim() === '') {
    return { valid: false, reason: 'Name cannot be empty' };
  }
  if (!NAME_REGEX.test(name)) {
    return { valid: false, reason: 'Name must start with a letter, contain only alphanumeric/hyphen/underscore, max 64 chars' };
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return { valid: false, reason: `"${name}" is a reserved name` };
  }
  return { valid: true };
}

/**
 * Get path to environment YAML file.
 */
function envPath(name: string): string {
  return join(getEnvsDir(), `${name}.yaml`);
}

/**
 * Get the currently active environment name, or null if none.
 */
export function getActiveEnv(): string | null {
  const p = getActiveFilePath();
  if (!existsSync(p)) return null;
  const name = readFileSync(p, 'utf8').trim();
  if (!name || !existsSync(envPath(name))) return null;
  return name;
}

/**
 * Set the active environment.
 */
export function setActiveEnv(name: string): void {
  writeFileSync(getActiveFilePath(), name + '\n', 'utf8');
}

/**
 * Clear the active environment.
 */
export function clearActiveEnv(): void {
  const p = getActiveFilePath();
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Deactivate the current environment (pure function, alias for clearActiveEnv).
 */
export function deactivateEnv(): void {
  clearActiveEnv();
}

/**
 * List all environments.
 */
export function listEnvs(): EnvMeta[] {
  ensureEnvsDir();
  const dir = getEnvsDir();
  const active = getActiveEnv();
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml')).sort();

  return files.map(f => {
    const name = basename(f, '.yaml');
    const fullPath = join(dir, f);
    const stat = statSync(fullPath);
    return {
      name,
      path: fullPath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      active: name === active,
    };
  });
}

/**
 * Read environment config as raw string.
 */
export function readEnvConfig(name: string): string {
  const p = envPath(name);
  if (!existsSync(p)) {
    throw new Error(`Environment "${name}" does not exist`);
  }
  return readFileSync(p, 'utf8');
}

/**
 * Write environment config.
 */
export function writeEnvConfig(name: string, content: string): void {
  ensureEnvsDir();
  writeFileSync(envPath(name), content, 'utf8');
}

/**
 * Check if environment exists.
 */
export function envExists(name: string): boolean {
  return existsSync(envPath(name));
}

/**
 * Delete an environment.
 */
export function deleteEnv(name: string): void {
  const p = envPath(name);
  if (!existsSync(p)) {
    throw new Error(`Environment "${name}" does not exist`);
  }
  // If this is the active env, clear it
  if (getActiveEnv() === name) {
    clearActiveEnv();
  }
  unlinkSync(p);
}

/**
 * Get active environment config path for config loader integration.
 * Returns null if no env is active, or the path to the active env YAML.
 */
export function getActiveEnvConfigPath(): string | null {
  const active = getActiveEnv();
  if (!active) return null;
  const p = envPath(active);
  return existsSync(p) ? p : null;
}

// ── YAML serialization (minimal, no dependency) ─────────────────────────

function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  let out = '';
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      out += `${pad}${key}: null\n`;
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      out += `${pad}${key}:\n`;
      out += toYaml(val as Record<string, unknown>, indent + 1);
    } else if (Array.isArray(val)) {
      out += `${pad}${key}:\n`;
      for (const item of val) {
        if (typeof item === 'object' && item !== null) {
          out += `${pad}  -\n`;
          out += toYaml(item as Record<string, unknown>, indent + 2);
        } else {
          out += `${pad}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else if (typeof val === 'string') {
      // Quote strings that might be ambiguous
      if (val === '' || val.includes(':') || val.includes('#') || val.includes('\n') ||
          val === 'true' || val === 'false' || val === 'null' || /^\d+$/.test(val)) {
        out += `${pad}${key}: "${val.replace(/"/g, '\\"')}"\n`;
      } else {
        out += `${pad}${key}: ${val}\n`;
      }
    } else {
      out += `${pad}${key}: ${val}\n`;
    }
  }
  return out;
}

// ── Diff ────────────────────────────────────────────────────────────────

interface DiffLine {
  type: 'same' | 'added' | 'removed' | 'changed';
  lineA?: string;
  lineB?: string;
  line?: string;
}

function diffLines(textA: string, textB: string): DiffLine[] {
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');
  const maxLen = Math.max(linesA.length, linesB.length);
  const result: DiffLine[] = [];

  for (let i = 0; i < maxLen; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a === undefined && b !== undefined) {
      result.push({ type: 'added', lineB: b });
    } else if (b === undefined && a !== undefined) {
      result.push({ type: 'removed', lineA: a });
    } else if (a === b) {
      result.push({ type: 'same', line: a });
    } else {
      result.push({ type: 'changed', lineA: a, lineB: b });
    }
  }
  return result;
}

// ── CLI Entry ───────────────────────────────────────────────────────────

export async function vedEnv(args: string[]): Promise<void> {
  const sub = args[0] ?? 'current';

  switch (sub) {
    case 'current':
      return envCurrent();
    case 'list':
    case 'ls':
      return envList();
    case 'show':
    case 'cat':
      return envShow(args.slice(1));
    case 'create':
    case 'new':
      return envCreate(args.slice(1));
    case 'use':
    case 'switch':
    case 'activate':
      return envUse(args.slice(1));
    case 'edit':
      return envEdit(args.slice(1));
    case 'delete':
    case 'rm':
    case 'remove':
      return envDelete(args.slice(1));
    case 'diff':
    case 'compare':
      return envDiff(args.slice(1));
    case 'reset':
    case 'deactivate':
    case 'clear':
      return envReset();
    default:
      // If it looks like an env name, show it
      if (NAME_REGEX.test(sub) && envExists(sub)) {
        return envShow([sub]);
      }
      console.log(`Unknown subcommand: ${sub}`);
      printHelp();
  }
}

function printHelp(): void {
  console.log(`
Usage: ved env <command> [args...]

Commands:
  current                  Show active environment (default)
  list                     List all environments
  show <name>              Display environment config
  create <name> [options]  Create a new environment
    --from <env>           Copy from existing environment
    --from-current         Snapshot current merged config
    --template <name>      Use built-in template (dev/prod/test)
  use <name>               Switch to environment
  edit <name>              Open in $EDITOR
  delete <name>            Remove environment
  diff <a> <b>             Compare two environments
  reset                    Deactivate (use defaults)

Aliases: ved envs, ved environment, ved environments
`.trim());
}

// ── Subcommands ─────────────────────────────────────────────────────────

function envCurrent(): void {
  const active = getActiveEnv();
  if (!active) {
    console.log('No active environment (using defaults)');
  } else {
    console.log(`Active environment: ${active}`);
    const p = envPath(active);
    console.log(`Config: ${p}`);
  }
}

function envList(): void {
  const envs = listEnvs();
  if (envs.length === 0) {
    console.log('No environments defined.');
    console.log('Create one: ved env create <name>');
    return;
  }

  console.log('Environments:\n');
  const nameWidth = Math.max(6, ...envs.map(e => e.name.length));
  console.log(`  ${'NAME'.padEnd(nameWidth)}  ${'SIZE'.padStart(6)}  ${'MODIFIED'.padEnd(20)}  ACTIVE`);
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(6)}  ${'─'.repeat(20)}  ──────`);

  for (const env of envs) {
    const sizeStr = env.size < 1024 ? `${env.size}B` : `${(env.size / 1024).toFixed(1)}K`;
    const dateStr = env.modifiedAt.slice(0, 19).replace('T', ' ');
    const marker = env.active ? '  ✓' : '';
    console.log(`  ${env.name.padEnd(nameWidth)}  ${sizeStr.padStart(6)}  ${dateStr}  ${marker}`);
  }
  console.log(`\n  ${envs.length} environment(s)`);
}

function envShow(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved env show <name>');
    return;
  }
  if (!envExists(name)) {
    console.error(`Environment "${name}" does not exist`);
    return;
  }
  const content = readEnvConfig(name);
  const active = getActiveEnv() === name;
  console.log(`# Environment: ${name}${active ? ' (active)' : ''}`);
  console.log(`# Path: ${envPath(name)}\n`);
  console.log(content);
}

function envCreate(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved env create <name> [--from <env>] [--template <t>] [--from-current]');
    return;
  }

  const validation = validateEnvName(name);
  if (!validation.valid) {
    console.error(`Invalid name: ${validation.reason}`);
    return;
  }

  if (envExists(name)) {
    console.error(`Environment "${name}" already exists. Use "ved env edit ${name}" to modify.`);
    return;
  }

  let content = '';
  const fromIdx = args.indexOf('--from');
  const templateIdx = args.indexOf('--template');
  const fromCurrent = args.includes('--from-current');

  if (fromIdx !== -1 && args[fromIdx + 1]) {
    // Copy from existing environment
    const source = args[fromIdx + 1];
    if (!envExists(source)) {
      console.error(`Source environment "${source}" does not exist`);
      return;
    }
    content = readEnvConfig(source);
    console.log(`Created environment "${name}" from "${source}"`);
  } else if (templateIdx !== -1 && args[templateIdx + 1]) {
    // Use built-in template
    const tpl = args[templateIdx + 1];
    if (!BUILT_IN_TEMPLATES[tpl]) {
      console.error(`Unknown template: ${tpl}. Available: ${Object.keys(BUILT_IN_TEMPLATES).join(', ')}`);
      return;
    }
    content = `# Ved environment: ${name}\n# Template: ${tpl}\n# Created: ${new Date().toISOString()}\n\n`;
    content += toYaml(BUILT_IN_TEMPLATES[tpl]);
    console.log(`Created environment "${name}" from template "${tpl}"`);
  } else if (fromCurrent) {
    // Snapshot current merged config (read config.yaml + config.local.yaml)
    const configDir = getConfigDir();
    const mainPath = join(configDir, 'config.yaml');
    const localPath = join(configDir, 'config.local.yaml');
    content = `# Ved environment: ${name}\n# Snapshot of current config\n# Created: ${new Date().toISOString()}\n\n`;
    if (existsSync(mainPath)) {
      content += `# --- from config.yaml ---\n`;
      content += readFileSync(mainPath, 'utf8');
    }
    if (existsSync(localPath)) {
      content += `\n# --- from config.local.yaml (secrets redacted) ---\n`;
      let localContent = readFileSync(localPath, 'utf8');
      // Redact obvious secrets
      localContent = localContent.replace(/(apiKey|hmacSecret|secret|password|token):\s*.+/gi,
        (match) => {
          const key = match.split(':')[0];
          return `${key}: <REDACTED>`;
        });
      content += localContent;
    }
    console.log(`Created environment "${name}" from current config`);
  } else {
    // Blank template
    content = `# Ved environment: ${name}\n# Created: ${new Date().toISOString()}\n#\n# This config is merged on top of config.yaml when active.\n# Only include the settings you want to override.\n\n`;
    content += `# Example overrides:\n`;
    content += `# logLevel: debug\n`;
    content += `# llm:\n`;
    content += `#   provider: ollama\n`;
    content += `#   model: llama3.2\n`;
    console.log(`Created blank environment "${name}"`);
  }

  writeEnvConfig(name, content);
  console.log(`  Path: ${envPath(name)}`);
  console.log(`  Activate: ved env use ${name}`);
}

function envUse(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved env use <name>');
    return;
  }
  if (!envExists(name)) {
    console.error(`Environment "${name}" does not exist`);
    const envs = listEnvs();
    if (envs.length > 0) {
      console.error(`Available: ${envs.map(e => e.name).join(', ')}`);
    }
    return;
  }
  const prev = getActiveEnv();
  setActiveEnv(name);
  if (prev && prev !== name) {
    console.log(`Switched from "${prev}" to "${name}"`);
  } else if (prev === name) {
    console.log(`Already on "${name}"`);
  } else {
    console.log(`Activated environment "${name}"`);
  }
  console.log('Note: Restart Ved for changes to take effect.');
}

function envEdit(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved env edit <name>');
    return;
  }
  if (!envExists(name)) {
    console.error(`Environment "${name}" does not exist`);
    return;
  }
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const p = envPath(name);
  try {
    execSync(`${editor} "${p}"`, { stdio: 'inherit' });
    console.log(`Environment "${name}" updated.`);
  } catch {
    console.error(`Failed to open editor: ${editor}`);
  }
}

function envDelete(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved env delete <name>');
    return;
  }
  if (!envExists(name)) {
    console.error(`Environment "${name}" does not exist`);
    return;
  }
  const wasActive = getActiveEnv() === name;
  deleteEnv(name);
  console.log(`Deleted environment "${name}"`);
  if (wasActive) {
    console.log('Active environment cleared (using defaults).');
  }
}

function envDiff(args: string[]): void {
  const nameA = args[0];
  const nameB = args[1];
  if (!nameA || !nameB) {
    console.error('Usage: ved env diff <envA> <envB>');
    return;
  }

  // Allow "default" as pseudo-name for no-env
  const getContent = (name: string): string => {
    if (name === 'default') {
      return `# Default config (no environment overlay)\n`;
    }
    if (!envExists(name)) {
      console.error(`Environment "${name}" does not exist`);
      process.exit(1);
    }
    return readEnvConfig(name);
  };

  const contentA = getContent(nameA);
  const contentB = getContent(nameB);

  if (contentA === contentB) {
    console.log(`Environments "${nameA}" and "${nameB}" are identical.`);
    return;
  }

  console.log(`--- ${nameA}`);
  console.log(`+++ ${nameB}`);
  console.log('');

  const diffs = diffLines(contentA, contentB);
  let hasDiff = false;
  for (const d of diffs) {
    switch (d.type) {
      case 'same':
        console.log(`  ${d.line}`);
        break;
      case 'added':
        console.log(`\x1b[32m+ ${d.lineB}\x1b[0m`);
        hasDiff = true;
        break;
      case 'removed':
        console.log(`\x1b[31m- ${d.lineA}\x1b[0m`);
        hasDiff = true;
        break;
      case 'changed':
        console.log(`\x1b[31m- ${d.lineA}\x1b[0m`);
        console.log(`\x1b[32m+ ${d.lineB}\x1b[0m`);
        hasDiff = true;
        break;
    }
  }
  if (!hasDiff) {
    console.log('(no differences)');
  }
}

function envReset(): void {
  const active = getActiveEnv();
  if (!active) {
    console.log('No active environment to reset.');
    return;
  }
  clearActiveEnv();
  console.log(`Deactivated environment "${active}". Using defaults.`);
  console.log('Note: Restart Ved for changes to take effect.');
}
