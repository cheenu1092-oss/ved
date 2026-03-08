/**
 * ved alias — Command shortcut manager.
 *
 * Create, list, edit, remove, and run custom aliases for frequently used commands.
 * Aliases are stored in ~/.ved/aliases.yaml and expand at CLI dispatch time.
 *
 * Subcommands:
 *   ved alias                          — List all aliases (default)
 *   ved alias list                     — List all aliases
 *   ved alias add <name> <command...>  — Create a new alias
 *   ved alias remove <name>            — Remove an alias
 *   ved alias show <name>              — Show alias details
 *   ved alias edit <name> <command...> — Update an alias command
 *   ved alias run <name> [args...]     — Run an alias (also: ved @<name>)
 *   ved alias export [--json]          — Export aliases
 *   ved alias import <file|->          — Import aliases (merge)
 *
 * Aliases: ved aliases, ved shortcut, ved shortcuts
 *
 * @module cli-alias
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getConfigDir } from './core/config.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface AliasEntry {
  /** Alias name (alphanumeric + hyphens + underscores) */
  name: string;
  /** The full command string to expand to */
  command: string;
  /** Optional description */
  description?: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last modification */
  updatedAt: string;
}

export interface AliasStore {
  aliases: AliasEntry[];
}

// ── Constants ──────────────────────────────────────────────────────────

const ALIAS_FILE = 'aliases.yaml';
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Reserved command names that cannot be aliased */
const RESERVED_NAMES = new Set([
  'init', 'start', 'chat', 'run', 'ask', 'query', 'q', 'pipe', 'pipeline',
  'chain', 'serve', 'api', 'status', 'stats', 'search', 'memory', 'mem',
  'trust', 't', 'user', 'u', 'who', 'users', 'prompt', 'prompts', 'sp',
  'system-prompt', 'context', 'ctx', 'window', 'prompt-debug', 'template',
  'templates', 'tpl', 'reindex', 'config', 'export', 'import', 'history',
  'doctor', 'backup', 'cron', 'completions', 'upgrade', 'watch', 'webhook',
  'plugin', 'gc', 'version', 'alias', 'aliases', 'shortcut', 'shortcuts',
  'help', '--help', '-h', '--version', '-v',
]);

// ── YAML helpers (minimal, no dependency) ──────────────────────────────

function serializeAliases(store: AliasStore): string {
  const lines: string[] = ['# Ved aliases — command shortcuts', '# Managed by `ved alias`. Manual edits are OK.', '', 'aliases:'];

  if (store.aliases.length === 0) {
    lines.push('  []');
  } else {
    for (const a of store.aliases) {
      lines.push(`  - name: ${yamlQuote(a.name)}`);
      lines.push(`    command: ${yamlQuote(a.command)}`);
      if (a.description) {
        lines.push(`    description: ${yamlQuote(a.description)}`);
      }
      lines.push(`    createdAt: ${yamlQuote(a.createdAt)}`);
      lines.push(`    updatedAt: ${yamlQuote(a.updatedAt)}`);
    }
  }

  return lines.join('\n') + '\n';
}

function yamlQuote(s: string): string {
  // Simple quoting: wrap in double quotes if it contains special chars
  if (/[:#\[\]{}&*!|>'"%@`,?]/.test(s) || s.includes('\n') || s.startsWith(' ') || s.endsWith(' ')) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function parseAliases(content: string): AliasStore {
  const store: AliasStore = { aliases: [] };
  const lines = content.split('\n');

  let currentAlias: Partial<AliasEntry> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '' || line.trim() === 'aliases:' || line.trim() === '[]') {
      continue;
    }

    // New alias entry
    if (line.match(/^\s+-\s+name:\s*/)) {
      if (currentAlias?.name && currentAlias?.command) {
        store.aliases.push(currentAlias as AliasEntry);
      }
      currentAlias = {
        name: extractYamlValue(line, 'name'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      continue;
    }

    if (currentAlias) {
      if (line.match(/^\s+command:\s*/)) {
        currentAlias.command = extractYamlValue(line, 'command');
      } else if (line.match(/^\s+description:\s*/)) {
        currentAlias.description = extractYamlValue(line, 'description');
      } else if (line.match(/^\s+createdAt:\s*/)) {
        currentAlias.createdAt = extractYamlValue(line, 'createdAt');
      } else if (line.match(/^\s+updatedAt:\s*/)) {
        currentAlias.updatedAt = extractYamlValue(line, 'updatedAt');
      }
    }
  }

  // Push last entry
  if (currentAlias?.name && currentAlias?.command) {
    store.aliases.push(currentAlias as AliasEntry);
  }

  return store;
}

function extractYamlValue(line: string, key: string): string {
  const match = line.match(new RegExp(`${key}:\\s*(.*)`));
  if (!match) return '';
  let value = match[1].trim();
  // Unquote
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

// ── Store I/O ──────────────────────────────────────────────────────────

function getAliasPath(): string {
  // Allow test override
  const dir = process.env.VED_CONFIG_DIR ?? getConfigDir();
  return join(dir, ALIAS_FILE);
}

function getAliasDir(): string {
  return process.env.VED_CONFIG_DIR ?? getConfigDir();
}

export function loadAliasStore(): AliasStore {
  const path = getAliasPath();
  if (!existsSync(path)) {
    return { aliases: [] };
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return parseAliases(content);
  } catch {
    return { aliases: [] };
  }
}

export function saveAliasStore(store: AliasStore): void {
  const dir = getAliasDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getAliasPath(), serializeAliases(store));
}

// ── Validation ─────────────────────────────────────────────────────────

export function validateAliasName(name: string): string | null {
  if (!name) return 'Alias name is required';
  if (!NAME_REGEX.test(name)) {
    return 'Alias name must start with a letter and contain only letters, numbers, hyphens, and underscores (max 64 chars)';
  }
  if (RESERVED_NAMES.has(name)) {
    return `"${name}" is a reserved Ved command and cannot be used as an alias`;
  }
  return null;
}

// ── Alias resolution (called from cli.ts) ──────────────────────────────

/**
 * Resolve an alias name to its command string. Returns null if not found.
 * Called before the main command switch to expand aliases.
 */
export function resolveAlias(name: string): AliasEntry | null {
  const store = loadAliasStore();
  return store.aliases.find(a => a.name === name) ?? null;
}

// ── CLI handler ────────────────────────────────────────────────────────

export async function vedAlias(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      return aliasList();

    case 'add':
    case 'create':
    case 'set':
      return aliasAdd(args.slice(1));

    case 'remove':
    case 'rm':
    case 'delete':
    case 'del':
      return aliasRemove(args.slice(1));

    case 'show':
    case 'get':
    case 'info':
      return aliasShow(args.slice(1));

    case 'edit':
    case 'update':
      return aliasEdit(args.slice(1));

    case 'run':
    case 'exec':
      return aliasRun(args.slice(1));

    case 'export':
      return aliasExport(args.slice(1));

    case 'import':
      return aliasImport(args.slice(1));

    case '--help':
    case '-h':
    case 'help':
      return aliasHelp();

    default:
      // Check if it's a direct alias run (ved alias myalias ...)
      const resolved = resolveAlias(sub);
      if (resolved) {
        return aliasRun([sub, ...args.slice(1)]);
      }
      console.error(`Unknown alias subcommand: ${sub}`);
      console.log('Usage: ved alias [list|add|remove|show|edit|run|export|import|help]');
      process.exit(1);
  }
}

// ── Subcommands ────────────────────────────────────────────────────────

function aliasList(): void {
  const store = loadAliasStore();

  if (store.aliases.length === 0) {
    console.log('\n  No aliases defined.\n');
    console.log('  Create one with: ved alias add <name> <command...>');
    console.log('  Example: ved alias add ss search --fts-only');
    console.log('  Then run: ved @ss "my query"\n');
    return;
  }

  console.log(`\n  Aliases (${store.aliases.length}):\n`);

  // Calculate padding for alignment
  const maxName = Math.max(...store.aliases.map(a => a.name.length));

  for (const a of store.aliases) {
    const pad = ' '.repeat(maxName - a.name.length);
    const desc = a.description ? `  # ${a.description}` : '';
    console.log(`  @${a.name}${pad}  →  ved ${a.command}${desc}`);
  }

  console.log(`\n  Run with: ved @<name> [extra-args...]\n`);
}

function aliasAdd(args: string[]): void {
  let name: string | undefined;
  let description: string | undefined;
  const commandParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-d' || args[i] === '--description' || args[i] === '--desc') && args[i + 1]) {
      description = args[i + 1];
      i++;
    } else if (!name) {
      name = args[i];
    } else {
      commandParts.push(args[i]);
    }
  }

  if (!name || commandParts.length === 0) {
    console.error('Usage: ved alias add <name> <command...> [-d "description"]');
    console.error('\nExamples:');
    console.error('  ved alias add ss search --fts-only');
    console.error('  ved alias add daily memory daily -d "View today\'s daily note"');
    console.error('  ved alias add health doctor');
    process.exit(1);
  }

  const nameError = validateAliasName(name);
  if (nameError) {
    console.error(`Error: ${nameError}`);
    process.exit(1);
  }

  const store = loadAliasStore();

  // Check for duplicates
  if (store.aliases.some(a => a.name === name)) {
    console.error(`Error: Alias "${name}" already exists. Use \`ved alias edit\` to update it.`);
    process.exit(1);
  }

  const command = commandParts.join(' ');
  const now = new Date().toISOString();

  store.aliases.push({
    name,
    command,
    description,
    createdAt: now,
    updatedAt: now,
  });

  // Sort alphabetically
  store.aliases.sort((a, b) => a.name.localeCompare(b.name));

  saveAliasStore(store);

  console.log(`\n  ✅ Alias created: @${name} → ved ${command}`);
  if (description) console.log(`     ${description}`);
  console.log(`\n  Run with: ved @${name}\n`);
}

function aliasRemove(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved alias remove <name>');
    process.exit(1);
  }

  const store = loadAliasStore();
  const index = store.aliases.findIndex(a => a.name === name);

  if (index === -1) {
    console.error(`Error: Alias "${name}" not found.`);
    process.exit(1);
  }

  const removed = store.aliases.splice(index, 1)[0];
  saveAliasStore(store);

  console.log(`\n  ✅ Alias removed: @${removed.name} → ved ${removed.command}\n`);
}

function aliasShow(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved alias show <name>');
    process.exit(1);
  }

  const store = loadAliasStore();
  const alias = store.aliases.find(a => a.name === name);

  if (!alias) {
    console.error(`Error: Alias "${name}" not found.`);
    process.exit(1);
  }

  console.log(`\n  Alias: @${alias.name}\n`);
  console.log(`  Command:     ved ${alias.command}`);
  if (alias.description) console.log(`  Description: ${alias.description}`);
  console.log(`  Created:     ${alias.createdAt.replace('T', ' ').slice(0, 19)}`);
  console.log(`  Updated:     ${alias.updatedAt.replace('T', ' ').slice(0, 19)}`);
  console.log(`\n  Run with: ved @${alias.name} [extra-args...]\n`);
}

function aliasEdit(args: string[]): void {
  let name: string | undefined;
  let description: string | undefined;
  let clearDescription = false;
  const commandParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-d' || args[i] === '--description' || args[i] === '--desc') && args[i + 1]) {
      description = args[i + 1];
      i++;
    } else if (args[i] === '--no-desc' || args[i] === '--no-description') {
      clearDescription = true;
    } else if (!name) {
      name = args[i];
    } else {
      commandParts.push(args[i]);
    }
  }

  if (!name) {
    console.error('Usage: ved alias edit <name> <new-command...> [-d "new description"]');
    process.exit(1);
  }

  const store = loadAliasStore();
  const alias = store.aliases.find(a => a.name === name);

  if (!alias) {
    console.error(`Error: Alias "${name}" not found.`);
    process.exit(1);
  }

  if (commandParts.length === 0 && description === undefined && !clearDescription) {
    console.error('Error: Provide a new command and/or description.');
    console.error('Usage: ved alias edit <name> <new-command...> [-d "description"]');
    process.exit(1);
  }

  const oldCommand = alias.command;

  if (commandParts.length > 0) {
    alias.command = commandParts.join(' ');
  }
  if (description !== undefined) {
    alias.description = description;
  }
  if (clearDescription) {
    alias.description = undefined;
  }
  alias.updatedAt = new Date().toISOString();

  saveAliasStore(store);

  if (commandParts.length > 0) {
    console.log(`\n  ✅ Alias updated: @${alias.name}`);
    console.log(`     Old: ved ${oldCommand}`);
    console.log(`     New: ved ${alias.command}\n`);
  } else {
    console.log(`\n  ✅ Alias updated: @${alias.name}\n`);
  }
}

function aliasRun(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved alias run <name> [extra-args...]');
    process.exit(1);
  }

  const store = loadAliasStore();
  const alias = store.aliases.find(a => a.name === name);

  if (!alias) {
    console.error(`Error: Alias "${name}" not found.`);
    process.exit(1);
  }

  // Expand: alias.command + extra args → full ved command
  const extraArgs = args.slice(1);
  const fullCommand = [alias.command, ...extraArgs].join(' ');

  // Re-exec ved with the expanded command
  try {
    const vedBin = process.argv[1] ?? 'ved';
    const cmd = `"${process.argv[0]}" "${vedBin}" ${fullCommand}`;
    execSync(cmd, { stdio: 'inherit' });
  } catch (err: any) {
    // execSync throws on non-zero exit — propagate
    process.exit(err.status ?? 1);
  }
}

function aliasExport(args: string[]): void {
  const json = args.includes('--json');
  const store = loadAliasStore();

  if (json) {
    console.log(JSON.stringify(store, null, 2));
  } else {
    console.log(serializeAliases(store));
  }
}

function aliasImport(args: string[]): void {
  const inputPath = args.find(a => !a.startsWith('-'));
  const dryRun = args.includes('--dry-run') || args.includes('-n');

  if (!inputPath) {
    console.error('Usage: ved alias import <file|-|--stdin> [--dry-run]');
    process.exit(1);
  }

  let raw: string;
  if (inputPath === '-' || inputPath === '--stdin') {
    // Read from stdin synchronously
    const chunks: Buffer[] = [];
    const fd = require('fs').openSync('/dev/stdin', 'r');
    const buf = Buffer.alloc(4096);
    let n: number;
    while ((n = require('fs').readSync(fd, buf)) > 0) {
      chunks.push(buf.slice(0, n));
    }
    require('fs').closeSync(fd);
    raw = Buffer.concat(chunks).toString('utf-8');
  } else {
    if (!existsSync(inputPath)) {
      console.error(`File not found: ${inputPath}`);
      process.exit(1);
    }
    raw = readFileSync(inputPath, 'utf-8');
  }

  // Try JSON first, then YAML
  let imported: AliasStore;
  try {
    imported = JSON.parse(raw);
    if (!Array.isArray(imported.aliases)) {
      throw new Error('Missing aliases array');
    }
  } catch {
    imported = parseAliases(raw);
  }

  if (imported.aliases.length === 0) {
    console.log('\n  No aliases found in input.\n');
    return;
  }

  const store = loadAliasStore();
  let added = 0;
  let skipped = 0;
  let invalid = 0;

  console.log(`\n  Importing ${imported.aliases.length} alias(es)${dryRun ? ' (dry run)' : ''}:\n`);

  for (const a of imported.aliases) {
    const nameErr = validateAliasName(a.name);
    if (nameErr) {
      console.log(`  ❌ ${a.name}: ${nameErr}`);
      invalid++;
      continue;
    }

    if (store.aliases.some(existing => existing.name === a.name)) {
      console.log(`  ⏭️  ${a.name}: already exists (skipped)`);
      skipped++;
      continue;
    }

    if (!dryRun) {
      store.aliases.push({
        name: a.name,
        command: a.command,
        description: a.description,
        createdAt: a.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    console.log(`  ✅ ${a.name} → ved ${a.command}`);
    added++;
  }

  if (!dryRun && added > 0) {
    store.aliases.sort((a, b) => a.name.localeCompare(b.name));
    saveAliasStore(store);
  }

  console.log(`\n  Added: ${added}, Skipped: ${skipped}, Invalid: ${invalid}\n`);
}

function aliasHelp(): void {
  console.log(`
ved alias — Command shortcut manager

Create shortcuts for frequently used ved commands. Run them with @<name>.

Subcommands:
  list                          List all aliases (default)
  add <name> <command...>       Create a new alias
  remove <name>                 Remove an alias
  show <name>                   Show alias details
  edit <name> <command...>      Update an alias command
  run <name> [args...]          Run an alias explicitly
  export [--json]               Export aliases (YAML or JSON)
  import <file|-> [--dry-run]   Import aliases (merge, skip duplicates)

Flags:
  -d, --desc <text>    Set description (add/edit)
  --no-desc            Clear description (edit)
  --json               JSON output (export)
  --dry-run, -n        Preview import without saving

Examples:
  ved alias add ss search --fts-only           # Create alias
  ved alias add daily memory daily -d "Today"  # With description
  ved @ss "query text"                         # Run via @shortcut
  ved alias edit ss search --verbose            # Update command
  ved alias remove ss                           # Delete alias
  ved alias export > aliases.yaml               # Backup
  ved alias import aliases.yaml                 # Restore

Name Rules:
  - Must start with a letter
  - Only letters, numbers, hyphens, underscores
  - Max 64 characters
  - Cannot shadow built-in ved commands
`.trimStart());
}
