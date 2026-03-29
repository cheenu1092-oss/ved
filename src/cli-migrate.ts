/**
 * `ved migrate` — Data migration tool.
 *
 * Import data from external sources into Ved's vault and audit system.
 *
 * Subcommands:
 *   status                        Show migration status (pending/completed)
 *   markdown <dir>                Import markdown files into vault
 *   json <file>                   Import JSON data (ChatGPT, Claude exports)
 *   obsidian <vault-path>         Import from existing Obsidian vault
 *   csv <file>                    Import CSV as vault entities
 *   jsonl <file>                  Import JSONL (conversation logs)
 *   undo <migration-id>           Undo a completed migration
 *   history                       Show migration history
 *   validate <source> [path]      Dry-run validation without importing
 *
 * Aliases: migrations, import-data
 *
 * @module cli-migrate
 */

import type { VedApp } from './app.js';
import { checkHelp } from './cli-help.js';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, basename, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { errHint, errUsage } from './errors.js';

// ── Types ──────────────────────────────────────────────────────────────

interface MigrationRecord {
  id: string;
  source: string;
  sourcePath: string;
  filesImported: number;
  filesSkipped: number;
  filesErrored: number;
  startedAt: string;
  completedAt: string;
  undoneAt?: string;
  importedFiles: string[]; // relative vault paths
  options: Record<string, unknown>;
}

interface MigrationResult {
  imported: number;
  skipped: number;
  errored: number;
  files: string[];
  errors: string[];
}

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const MIGRATION_DIR = '.ved/migrations';

// ── Helpers ────────────────────────────────────────────────────────────

function ensureMigrationDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const dir = join(home, MIGRATION_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadMigrations(): MigrationRecord[] {
  const dir = ensureMigrationDir();
  const indexPath = join(dir, 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveMigrations(records: MigrationRecord[]): void {
  const dir = ensureMigrationDir();
  const indexPath = join(dir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(records, null, 2));
}

function addMigration(record: MigrationRecord): void {
  const records = loadMigrations();
  records.push(record);
  saveMigrations(records);
}

function parseMarkdownFile(content: string): ParsedMarkdown {
  const frontmatter: Record<string, unknown> = {};
  let body = content;

  if (content.startsWith('---\n')) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const yamlBlock = content.slice(4, endIdx);
      body = content.slice(endIdx + 5);

      // Simple YAML parser for common frontmatter
      for (const line of yamlBlock.split('\n')) {
        const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
        if (match) {
          const key = match[1];
          let value: unknown = match[2].trim();

          // Handle arrays (inline)
          if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
          }
          // Handle booleans
          else if (value === 'true') value = true;
          else if (value === 'false') value = false;
          // Handle numbers
          else if (!isNaN(Number(value)) && value !== '') value = Number(value);

          frontmatter[key] = value;
        }
        // Handle YAML array items
        const arrayMatch = line.match(/^\s+-\s+(.+)$/);
        if (arrayMatch) {
          // Find the last key that was a non-array value and convert
          const keys = Object.keys(frontmatter);
          if (keys.length > 0) {
            const lastKey = keys[keys.length - 1];
            const existing = frontmatter[lastKey];
            if (Array.isArray(existing)) {
              existing.push(arrayMatch[1].trim().replace(/^["']|["']$/g, ''));
            }
          }
        }
      }
    }
  }

  return { frontmatter, body: body.trim() };
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 100);
}

function resolveTargetFolder(frontmatter: Record<string, unknown>): string {
  const type = String(frontmatter['type'] || '').toLowerCase();
  if (type === 'person' || type === 'entity') return 'entities';
  if (type === 'decision') return 'decisions';
  if (type === 'concept' || type === 'idea') return 'concepts';
  if (type === 'daily' || frontmatter['date']) return 'daily';
  return 'entities'; // default
}

function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolved = resolve(basePath, targetPath);
  return resolved.startsWith(resolve(basePath));
}

// ── Subcommands ────────────────────────────────────────────────────────

async function migrateStatus(_app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const records = loadMigrations();
  const active = records.filter(r => !r.undoneAt);
  const undone = records.filter(r => r.undoneAt);

  console.log('\n  📦 Migration Status:\n');
  console.log(`    Total migrations:    ${records.length}`);
  console.log(`    Active:              ${active.length}`);
  console.log(`    Undone:              ${undone.length}`);
  console.log(`    Total files imported: ${active.reduce((s, r) => s + r.filesImported, 0)}`);

  if (active.length > 0) {
    console.log('\n  Recent migrations:\n');
    const recent = active.slice(-5);
    for (const r of recent) {
      const date = new Date(r.completedAt).toLocaleDateString();
      console.log(`    ${r.id.slice(0, 8)}  ${r.source.padEnd(10)} ${String(r.filesImported).padStart(4)} files  ${date}  ${r.sourcePath}`);
    }
  }
  console.log();
}

async function migrateMarkdown(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const dirPath = args[0];
  if (!dirPath) {
    errUsage('ved migrate markdown <directory>');
    return;
  }

  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    errHint(`Directory not found: ${dirPath}`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const recursive = args.includes('--recursive') || args.includes('-r');
  const targetFolder = args.find(a => a.startsWith('--folder='))?.split('=')[1];
  const addTag = args.find(a => a.startsWith('--tag='))?.split('=')[1];

  // Collect .md files
  const mdFiles: string[] = [];
  function collectFiles(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && recursive) {
        collectFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        mdFiles.push(fullPath);
      }
    }
  }
  collectFiles(dirPath);

  if (mdFiles.length === 0) {
    console.log('  ℹ No markdown files found.');
    return;
  }

  console.log(`\n  📂 Found ${mdFiles.length} markdown file${mdFiles.length === 1 ? '' : 's'} in ${dirPath}\n`);

  const result: MigrationResult = { imported: 0, skipped: 0, errored: 0, files: [], errors: [] };

  for (const filePath of mdFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseMarkdownFile(content);

      // Determine target vault path
      const folder = targetFolder || resolveTargetFolder(parsed.frontmatter);
      const fileName = basename(filePath);
      const vaultPath = `${folder}/${fileName}`;

      // Check for existing file
      let exists = false;
      try {
        app.memory.vault.readFile(vaultPath);
        exists = true;
      } catch { /* doesn't exist */ }

      if (exists && !force) {
        console.log(`    ⏭  ${vaultPath} (exists, use --force to overwrite)`);
        result.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`    📄 [DRY RUN] ${filePath} → ${vaultPath}`);
        result.imported++;
        result.files.push(vaultPath);
        continue;
      }

      // Build frontmatter
      const fm: Record<string, unknown> = {
        ...parsed.frontmatter,
        imported: true,
        importedFrom: filePath,
        importedAt: new Date().toISOString(),
      };
      if (addTag) {
        const tags = Array.isArray(fm['tags']) ? [...fm['tags'] as string[]] : [];
        if (!tags.includes(addTag)) tags.push(addTag);
        fm['tags'] = tags;
      }

      // Write to vault
      if (exists) {
        app.memory.vault.updateFile(vaultPath, { frontmatter: fm, body: parsed.body });
      } else {
        app.memory.vault.createFile(vaultPath, fm, parsed.body);
      }

      console.log(`    ✓ ${filePath} → ${vaultPath}`);
      result.imported++;
      result.files.push(vaultPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errHint(`${filePath}: ${msg}`);
      result.errored++;
      result.errors.push(`${filePath}: ${msg}`);
    }
  }

  // Log migration
  if (!dryRun && result.imported > 0) {
    const record: MigrationRecord = {
      id: randomUUID(),
      source: 'markdown',
      sourcePath: resolve(dirPath),
      filesImported: result.imported,
      filesSkipped: result.skipped,
      filesErrored: result.errored,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      importedFiles: result.files,
      options: { recursive, force, targetFolder, addTag },
    };
    addMigration(record);

    // Audit log
    app.eventLoop.audit.append({
      eventType: 'migration_completed',
      actor: 'system',
      detail: { message: `markdown import: ${result.imported} files from ${dirPath}` },
      sessionId: 'cli',
    });
  }

  console.log(`\n  Summary: ${result.imported} imported, ${result.skipped} skipped, ${result.errored} errors\n`);
}

async function migrateJson(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const filePath = args[0];
  if (!filePath) {
    errUsage('ved migrate json <file>');
    return;
  }

  if (!existsSync(filePath)) {
    errHint(`File not found: ${filePath}`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const addTag = args.find(a => a.startsWith('--tag='))?.split('=')[1];

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    errHint(`Invalid JSON: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Detect format
  const result: MigrationResult = { imported: 0, skipped: 0, errored: 0, files: [], errors: [] };

  if (Array.isArray(data)) {
    // ChatGPT export format: array of conversations
    // Or generic array of objects
    console.log(`\n  📦 Detected array with ${data.length} items\n`);

    for (let i = 0; i < data.length; i++) {
      const item = data[i] as Record<string, unknown>;
      try {
        // ChatGPT format detection
        if (item['title'] && item['mapping']) {
          const title = String(item['title']);
          const created = item['create_time']
            ? new Date(Number(item['create_time']) * 1000).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10);
          const fileName = `${created}-${sanitizeFileName(title)}.md`;
          const vaultPath = `daily/${fileName}`;

          // Extract messages from ChatGPT mapping
          const mapping = item['mapping'] as Record<string, { message?: { content?: { parts?: string[] }; author?: { role?: string } } }>;
          const messages: string[] = [];
          for (const node of Object.values(mapping)) {
            if (node?.message?.content?.parts) {
              const role = node.message.author?.role || 'unknown';
              const text = node.message.content.parts.join('\n');
              if (text.trim()) {
                messages.push(`**${role}:** ${text}`);
              }
            }
          }

          if (!dryRun) {
            const fm: Record<string, unknown> = {
              title,
              type: 'conversation',
              source: 'chatgpt',
              imported: true,
              importedAt: new Date().toISOString(),
              date: created,
              tags: addTag ? ['conversation', 'chatgpt', addTag] : ['conversation', 'chatgpt'],
            };

            let exists = false;
            try { app.memory.vault.readFile(vaultPath); exists = true; } catch { /* */ }

            if (exists && !force) {
              console.log(`    ⏭  ${vaultPath} (exists)`);
              result.skipped++;
              continue;
            }

            const body = messages.join('\n\n---\n\n');
            if (exists) {
              app.memory.vault.updateFile(vaultPath, { frontmatter: fm, body });
            } else {
              app.memory.vault.createFile(vaultPath, fm, body);
            }
          }

          console.log(`    ${dryRun ? '[DRY RUN] ' : '✓ '}${title} → ${vaultPath}`);
          result.imported++;
          result.files.push(vaultPath);
        }
        // Claude export format: { uuid, name, chat_messages: [...] }
        else if (item['chat_messages'] || item['uuid']) {
          const title = String(item['name'] || item['title'] || `conversation-${i}`);
          const created = item['created_at']
            ? new Date(String(item['created_at'])).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10);
          const fileName = `${created}-${sanitizeFileName(title)}.md`;
          const vaultPath = `daily/${fileName}`;

          const messages: string[] = [];
          const chatMessages = (item['chat_messages'] || []) as Array<{ sender?: string; text?: string; content?: Array<{ text?: string }> }>;
          for (const msg of chatMessages) {
            const sender = msg.sender || 'unknown';
            const text = msg.text || (msg.content ? msg.content.map(c => c.text || '').join('\n') : '');
            if (text.trim()) {
              messages.push(`**${sender}:** ${text}`);
            }
          }

          if (!dryRun) {
            const fm: Record<string, unknown> = {
              title,
              type: 'conversation',
              source: 'claude',
              imported: true,
              importedAt: new Date().toISOString(),
              date: created,
              tags: addTag ? ['conversation', 'claude', addTag] : ['conversation', 'claude'],
            };

            let exists = false;
            try { app.memory.vault.readFile(vaultPath); exists = true; } catch { /* */ }

            if (exists && !force) {
              console.log(`    ⏭  ${vaultPath} (exists)`);
              result.skipped++;
              continue;
            }

            const body = messages.join('\n\n---\n\n');
            if (exists) {
              app.memory.vault.updateFile(vaultPath, { frontmatter: fm, body });
            } else {
              app.memory.vault.createFile(vaultPath, fm, body);
            }
          }

          console.log(`    ${dryRun ? '[DRY RUN] ' : '✓ '}${title} → ${vaultPath}`);
          result.imported++;
          result.files.push(vaultPath);
        }
        // Generic object: convert to entity
        else {
          const name = String(item['name'] || item['title'] || item['id'] || `item-${i}`);
          const fileName = `${sanitizeFileName(name)}.md`;
          const vaultPath = `entities/${fileName}`;

          if (!dryRun) {
            const fm: Record<string, unknown> = {
              ...item,
              imported: true,
              importedAt: new Date().toISOString(),
              tags: addTag ? ['imported', addTag] : ['imported'],
            };

            // Remove large nested objects from frontmatter
            for (const key of Object.keys(fm)) {
              if (typeof fm[key] === 'object' && fm[key] !== null && !Array.isArray(fm[key])) {
                delete fm[key];
              }
            }

            let exists = false;
            try { app.memory.vault.readFile(vaultPath); exists = true; } catch { /* */ }

            if (exists && !force) {
              console.log(`    ⏭  ${vaultPath} (exists)`);
              result.skipped++;
              continue;
            }

            const body = JSON.stringify(item, null, 2);
            if (exists) {
              app.memory.vault.updateFile(vaultPath, { frontmatter: fm, body });
            } else {
              app.memory.vault.createFile(vaultPath, fm, body);
            }
          }

          console.log(`    ${dryRun ? '[DRY RUN] ' : '✓ '}${name} → ${vaultPath}`);
          result.imported++;
          result.files.push(vaultPath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errHint(`item ${i}: ${msg}`);
        result.errored++;
        result.errors.push(`item ${i}: ${msg}`);
      }
    }
  } else {
    errHint('Unsupported JSON format (expected array of conversations or objects)');
    return;
  }

  if (!dryRun && result.imported > 0) {
    const record: MigrationRecord = {
      id: randomUUID(),
      source: 'json',
      sourcePath: resolve(filePath),
      filesImported: result.imported,
      filesSkipped: result.skipped,
      filesErrored: result.errored,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      importedFiles: result.files,
      options: { force, addTag },
    };
    addMigration(record);

    app.eventLoop.audit.append({
      eventType: 'migration_completed',
      actor: 'system',
      detail: { message: `json import: ${result.imported} files from ${filePath}` },
      sessionId: 'cli',
    });
  }

  console.log(`\n  Summary: ${result.imported} imported, ${result.skipped} skipped, ${result.errored} errors\n`);
}

async function migrateObsidian(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const vaultPath = args[0];
  if (!vaultPath) {
    errUsage('ved migrate obsidian <vault-path>');
    return;
  }

  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    errHint(`Vault not found: ${vaultPath}`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const addTag = args.find(a => a.startsWith('--tag='))?.split('=')[1];
  const excludeDotFolders = !args.includes('--include-hidden');

  // Collect all .md files recursively
  const mdFiles: string[] = [];
  function collectFiles(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (excludeDotFolders && entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        mdFiles.push(fullPath);
      }
    }
  }
  collectFiles(vaultPath);

  if (mdFiles.length === 0) {
    console.log('  ℹ No markdown files found in vault.');
    return;
  }

  console.log(`\n  🗃️  Found ${mdFiles.length} files in Obsidian vault\n`);

  const result: MigrationResult = { imported: 0, skipped: 0, errored: 0, files: [], errors: [] };

  for (const filePath of mdFiles) {
    try {
      const relFromSource = relative(vaultPath, filePath);

      // Path safety check
      if (!isPathSafe(vaultPath, relFromSource)) {
        errHint(`Path traversal detected: ${relFromSource}`);
        result.errored++;
        result.errors.push(`path traversal: ${relFromSource}`);
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseMarkdownFile(content);

      // Preserve original directory structure
      const vaultRelPath = relFromSource;

      let exists = false;
      try { app.memory.vault.readFile(vaultRelPath); exists = true; } catch { /* */ }

      if (exists && !force) {
        console.log(`    ⏭  ${vaultRelPath} (exists)`);
        result.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`    📄 [DRY RUN] ${relFromSource} → ${vaultRelPath}`);
        result.imported++;
        result.files.push(vaultRelPath);
        continue;
      }

      const fm: Record<string, unknown> = {
        ...parsed.frontmatter,
        imported: true,
        importedFrom: 'obsidian',
        importedAt: new Date().toISOString(),
      };
      if (addTag) {
        const tags = Array.isArray(fm['tags']) ? [...fm['tags'] as string[]] : [];
        if (!tags.includes(addTag)) tags.push(addTag);
        fm['tags'] = tags;
      }

      if (exists) {
        app.memory.vault.updateFile(vaultRelPath, { frontmatter: fm, body: parsed.body });
      } else {
        app.memory.vault.createFile(vaultRelPath, fm, parsed.body);
      }

      console.log(`    ✓ ${relFromSource}`);
      result.imported++;
      result.files.push(vaultRelPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errHint(`${filePath}: ${msg}`);
      result.errored++;
      result.errors.push(`${filePath}: ${msg}`);
    }
  }

  if (!dryRun && result.imported > 0) {
    const record: MigrationRecord = {
      id: randomUUID(),
      source: 'obsidian',
      sourcePath: resolve(vaultPath),
      filesImported: result.imported,
      filesSkipped: result.skipped,
      filesErrored: result.errored,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      importedFiles: result.files,
      options: { force, addTag, excludeDotFolders },
    };
    addMigration(record);

    app.eventLoop.audit.append({
      eventType: 'migration_completed',
      actor: 'system',
      detail: { message: `obsidian import: ${result.imported} files from ${vaultPath}` },
      sessionId: 'cli',
    });
  }

  console.log(`\n  Summary: ${result.imported} imported, ${result.skipped} skipped, ${result.errored} errors\n`);
}

async function migrateCsv(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const filePath = args[0];
  if (!filePath) {
    errUsage('ved migrate csv <file>');
    return;
  }

  if (!existsSync(filePath)) {
    errHint(`File not found: ${filePath}`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const addTag = args.find(a => a.startsWith('--tag='))?.split('=')[1];
  const nameCol = args.find(a => a.startsWith('--name-col='))?.split('=')[1] || 'name';
  const targetFolder = args.find(a => a.startsWith('--folder='))?.split('=')[1] || 'entities';

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    errHint('CSV must have a header row and at least one data row');
    return;
  }

  // Simple CSV parser (handles quoted fields)
  function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseCsvLine(lines[0]);
  const nameIdx = headers.indexOf(nameCol);

  if (nameIdx === -1) {
    errHint(`Name column "${nameCol}" not found. Available: ${headers.join(', ')}`, 'Use --name-col=<column> to specify');
    return;
  }

  console.log(`\n  📊 CSV: ${lines.length - 1} rows, ${headers.length} columns\n`);

  const result: MigrationResult = { imported: 0, skipped: 0, errored: 0, files: [], errors: [] };

  for (let i = 1; i < lines.length; i++) {
    try {
      const fields = parseCsvLine(lines[i]);
      if (fields.length === 0 || fields.every(f => !f)) continue;

      const name = fields[nameIdx] || `row-${i}`;
      const fileName = `${sanitizeFileName(name)}.md`;
      const vaultPath = `${targetFolder}/${fileName}`;

      let exists = false;
      try { app.memory.vault.readFile(vaultPath); exists = true; } catch { /* */ }

      if (exists && !force) {
        result.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`    📄 [DRY RUN] row ${i}: ${name} → ${vaultPath}`);
        result.imported++;
        result.files.push(vaultPath);
        continue;
      }

      // Build frontmatter from CSV columns
      const fm: Record<string, unknown> = {
        imported: true,
        importedFrom: filePath,
        importedAt: new Date().toISOString(),
        tags: addTag ? ['imported', addTag] : ['imported'],
      };

      for (let j = 0; j < headers.length; j++) {
        if (j < fields.length && fields[j]) {
          fm[headers[j].toLowerCase().replace(/\s+/g, '_')] = fields[j];
        }
      }

      // Build body as key-value list
      const bodyLines: string[] = [`# ${name}`, ''];
      for (let j = 0; j < headers.length; j++) {
        if (j < fields.length && fields[j] && j !== nameIdx) {
          bodyLines.push(`**${headers[j]}:** ${fields[j]}`);
        }
      }

      if (exists) {
        app.memory.vault.updateFile(vaultPath, { frontmatter: fm, body: bodyLines.join('\n') });
      } else {
        app.memory.vault.createFile(vaultPath, fm, bodyLines.join('\n'));
      }

      result.imported++;
      result.files.push(vaultPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errored++;
      result.errors.push(`row ${i}: ${msg}`);
    }
  }

  if (!dryRun && result.imported > 0) {
    const record: MigrationRecord = {
      id: randomUUID(),
      source: 'csv',
      sourcePath: resolve(filePath),
      filesImported: result.imported,
      filesSkipped: result.skipped,
      filesErrored: result.errored,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      importedFiles: result.files,
      options: { force, addTag, nameCol, targetFolder },
    };
    addMigration(record);

    app.eventLoop.audit.append({
      eventType: 'migration_completed',
      actor: 'system',
      detail: { message: `csv import: ${result.imported} rows from ${filePath}` },
      sessionId: 'cli',
    });
  }

  console.log(`\n  Summary: ${result.imported} imported, ${result.skipped} skipped, ${result.errored} errors\n`);
}

async function migrateJsonl(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const filePath = args[0];
  if (!filePath) {
    errUsage('ved migrate jsonl <file>');
    return;
  }

  if (!existsSync(filePath)) {
    errHint(`File not found: ${filePath}`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const addTag = args.find(a => a.startsWith('--tag='))?.split('=')[1];

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  console.log(`\n  📝 JSONL: ${lines.length} lines\n`);

  // Group by session/date for daily notes
  const byDate = new Map<string, Array<{ role: string; content: string; timestamp?: string }>>();

  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>;
      const role = String(obj['role'] || obj['sender'] || obj['author'] || 'unknown');
      const content = String(obj['content'] || obj['text'] || obj['message'] || '');
      const ts = obj['timestamp'] || obj['created_at'] || obj['time'];
      const date = ts
        ? new Date(String(ts)).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push({ role, content, timestamp: ts ? String(ts) : undefined });
    } catch {
      // Skip invalid lines
    }
  }

  const result: MigrationResult = { imported: 0, skipped: 0, errored: 0, files: [], errors: [] };

  for (const [date, messages] of byDate) {
    try {
      const fileName = `${date}-conversation-log.md`;
      const vaultPath = `daily/${fileName}`;

      let exists = false;
      try { app.memory.vault.readFile(vaultPath); exists = true; } catch { /* */ }

      if (exists && !force) {
        console.log(`    ⏭  ${vaultPath} (exists)`);
        result.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`    📄 [DRY RUN] ${date}: ${messages.length} messages → ${vaultPath}`);
        result.imported++;
        result.files.push(vaultPath);
        continue;
      }

      const fm: Record<string, unknown> = {
        type: 'conversation',
        date,
        messages: messages.length,
        imported: true,
        importedFrom: filePath,
        importedAt: new Date().toISOString(),
        tags: addTag ? ['conversation', 'imported', addTag] : ['conversation', 'imported'],
      };

      const body = messages
        .map(m => {
          const ts = m.timestamp ? ` _(${new Date(m.timestamp).toLocaleTimeString()})_` : '';
          return `**${m.role}:**${ts}\n${m.content}`;
        })
        .join('\n\n---\n\n');

      if (exists) {
        app.memory.vault.updateFile(vaultPath, { frontmatter: fm, body });
      } else {
        app.memory.vault.createFile(vaultPath, fm, body);
      }

      console.log(`    ✓ ${date}: ${messages.length} messages → ${vaultPath}`);
      result.imported++;
      result.files.push(vaultPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errored++;
      result.errors.push(`${date}: ${msg}`);
    }
  }

  if (!dryRun && result.imported > 0) {
    const record: MigrationRecord = {
      id: randomUUID(),
      source: 'jsonl',
      sourcePath: resolve(filePath),
      filesImported: result.imported,
      filesSkipped: result.skipped,
      filesErrored: result.errored,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      importedFiles: result.files,
      options: { force, addTag },
    };
    addMigration(record);

    app.eventLoop.audit.append({
      eventType: 'migration_completed',
      actor: 'system',
      detail: { message: `jsonl import: ${result.imported} daily notes from ${filePath}` },
      sessionId: 'cli',
    });
  }

  console.log(`\n  Summary: ${result.imported} imported, ${result.skipped} skipped, ${result.errored} errors\n`);
}

async function migrateUndo(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const migrationId = args[0];
  if (!migrationId) {
    errUsage('ved migrate undo <migration-id>');
    return;
  }

  const records = loadMigrations();
  const record = records.find(r => r.id.startsWith(migrationId));

  if (!record) {
    errHint(`Migration not found: ${migrationId}`);
    return;
  }

  if (record.undoneAt) {
    errHint(`Migration already undone at ${record.undoneAt}`);
    return;
  }

  const dryRun = args.includes('--dry-run');

  console.log(`\n  🔄 Undoing migration ${record.id.slice(0, 8)} (${record.source}, ${record.filesImported} files)\n`);

  let removed = 0;
  let failed = 0;

  for (const vaultPath of record.importedFiles) {
    try {
      // Verify file still has imported marker
      const file = app.memory.vault.readFile(vaultPath);
      if (file.frontmatter?.['imported'] !== true) {
        console.log(`    ⏭  ${vaultPath} (modified, skipping)`);
        continue;
      }

      if (dryRun) {
        console.log(`    📄 [DRY RUN] would remove ${vaultPath}`);
      } else {
        app.memory.vault.deleteFile(vaultPath);
        console.log(`    ✓ Removed ${vaultPath}`);
      }
      removed++;
    } catch {
      // File may already be gone
      failed++;
    }
  }

  if (!dryRun) {
    record.undoneAt = new Date().toISOString();
    saveMigrations(records);

    app.eventLoop.audit.append({
      eventType: 'migration_undone',
      actor: 'system',
      detail: { message: `undone migration ${record.id.slice(0, 8)}: removed ${removed} files` },
      sessionId: 'cli',
    });
  }

  console.log(`\n  ${dryRun ? '[DRY RUN] ' : ''}Removed ${removed} files, ${failed} already gone\n`);
}

async function migrateHistory(_app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const records = loadMigrations();

  if (records.length === 0) {
    console.log('\n  No migrations recorded.\n');
    return;
  }

  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '20');
  const shown = records.slice(-limit);

  console.log(`\n  📜 Migration History (${shown.length}/${records.length}):\n`);

  for (const r of shown) {
    const date = new Date(r.completedAt).toLocaleDateString();
    const status = r.undoneAt ? '⏪' : '✅';
    const undone = r.undoneAt ? ` (undone ${new Date(r.undoneAt).toLocaleDateString()})` : '';

    console.log(`    ${status} ${r.id.slice(0, 8)}  ${r.source.padEnd(10)} ${String(r.filesImported).padStart(4)} files  ${date}${undone}`);
    console.log(`       ${r.sourcePath}`);
  }
  console.log();
}

async function migrateValidate(_app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('migrate', args)) return;

  const source = args[0];
  const path = args[1];

  if (!source) {
    errUsage('ved migrate validate <source> [path]');
    errHint('Sources: markdown, json, obsidian, csv, jsonl');
    return;
  }

  if (!path) {
    errHint(`Path required for ${source} validation`);
    return;
  }

  if (!existsSync(path)) {
    errHint(`Not found: ${path}`);
    return;
  }

  console.log(`\n  🔍 Validating ${source} source: ${path}\n`);

  switch (source) {
    case 'markdown': {
      const stat = statSync(path);
      if (!stat.isDirectory()) {
        errHint('Expected a directory');
        return;
      }
      let count = 0;
      function countMd(dir: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) countMd(join(dir, entry.name));
          else if (entry.name.endsWith('.md')) count++;
        }
      }
      countMd(path);
      console.log(`    ✓ Directory exists`);
      console.log(`    ✓ ${count} markdown files found`);
      break;
    }
    case 'json': {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        if (Array.isArray(data)) {
          console.log(`    ✓ Valid JSON`);
          console.log(`    ✓ ${data.length} items in array`);
          if (data.length > 0) {
            const first = data[0] as Record<string, unknown>;
            if (first['title'] && first['mapping']) {
              console.log(`    ✓ Detected: ChatGPT export format`);
            } else if (first['chat_messages'] || first['uuid']) {
              console.log(`    ✓ Detected: Claude export format`);
            } else {
              console.log(`    ℹ  Format: generic object array`);
              console.log(`    ℹ  Keys: ${Object.keys(first).slice(0, 10).join(', ')}`);
            }
          }
        } else {
          console.log('    ✗ Expected array at top level');
        }
      } catch (err) {
        errHint(`Invalid JSON: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case 'obsidian': {
      const stat = statSync(path);
      if (!stat.isDirectory()) {
        errHint('Expected a directory');
        return;
      }
      const hasObsidian = existsSync(join(path, '.obsidian'));
      console.log(`    ${hasObsidian ? '✓' : '⚠️'} .obsidian directory ${hasObsidian ? 'found' : 'not found (may still work)'}`);
      let count = 0;
      function countAll(dir: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) countAll(join(dir, entry.name));
          else if (entry.name.endsWith('.md')) count++;
        }
      }
      countAll(path);
      console.log(`    ✓ ${count} markdown files found`);
      break;
    }
    case 'csv': {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      console.log(`    ✓ ${lines.length - 1} data rows`);
      if (lines.length > 0) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        console.log(`    ✓ Columns: ${headers.join(', ')}`);
      }
      break;
    }
    case 'jsonl': {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let valid = 0;
      let invalid = 0;
      for (const line of lines) {
        try { JSON.parse(line); valid++; } catch { invalid++; }
      }
      console.log(`    ✓ ${valid} valid JSON lines`);
      if (invalid > 0) console.log(`    ⚠️  ${invalid} invalid lines`);
      break;
    }
    default:
      errHint(`Unknown source: ${source}`);
  }

  console.log();
}

// ── Main Entry ─────────────────────────────────────────────────────────

export async function migrateCommand(app: VedApp, args: string[]): Promise<void> {
  const sub = args[0] || 'status';
  const rest = args.slice(1);

  switch (sub) {
    case 'status':
      return migrateStatus(app, rest);
    case 'markdown':
    case 'md':
      return migrateMarkdown(app, rest);
    case 'json':
      return migrateJson(app, rest);
    case 'obsidian':
    case 'obs':
      return migrateObsidian(app, rest);
    case 'csv':
      return migrateCsv(app, rest);
    case 'jsonl':
      return migrateJsonl(app, rest);
    case 'undo':
    case 'rollback':
    case 'revert':
      return migrateUndo(app, rest);
    case 'history':
    case 'log':
      return migrateHistory(app, rest);
    case 'validate':
    case 'check':
    case 'verify':
      return migrateValidate(app, rest);
    case '--help':
    case '-h':
      checkHelp('migrate', ['--help']);
      return;
    default:
      errHint(`Unknown subcommand: ${sub}`);
      errUsage('ved migrate <subcommand> — run "ved migrate --help" for usage');
  }
}
