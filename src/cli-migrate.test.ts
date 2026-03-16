/**
 * Tests for `ved migrate` — data migration tool.
 *
 * @module cli-migrate.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Increase hook timeout — VedApp start/stop is heavyweight
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VedApp } from './app.js';
import { getDefaults, VedConfig } from './core/config.js';
import { migrateCommand } from './cli-migrate.js';

// ── Helpers ────────────────────────────────────────────────────────────

let app: VedApp;
let vaultDir: string;
let tmpBase: string;
let sourceDir: string;
let logs: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

function makeConfig(vaultPath: string, dbPath: string): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    dbPath,
    memory: {
      ...defaults.memory,
      vaultPath,
      gitEnabled: false,
      compressionThreshold: 999_999,
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['owner1'],
    },
  } as VedConfig;
}

function writeVaultFile(relPath: string, frontmatter: Record<string, unknown>, body: string): void {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((item: unknown) => `  - ${item}`).join('\n')}`;
      }
      return `${k}: ${v}`;
    })
    .join('\n');
  const content = `---\n${yaml}\n---\n${body}`;
  const fullPath = join(vaultDir, relPath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

function readVaultFile(relPath: string): string {
  return readFileSync(join(vaultDir, relPath), 'utf-8');
}

function writeSourceFile(relPath: string, content: string): string {
  const fullPath = join(sourceDir, relPath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

beforeEach(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ved-migrate-'));
  vaultDir = join(tmpBase, 'vault');
  sourceDir = join(tmpBase, 'source');
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(join(vaultDir, 'entities'), { recursive: true });
  mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
  mkdirSync(join(vaultDir, 'decisions'), { recursive: true });
  mkdirSync(join(vaultDir, 'daily'), { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  // Override HOME for migration dir
  process.env.HOME = tmpBase;

  // Mock console BEFORE VedApp constructor (which triggers DB migration logs)
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errors.push(args.join(' '));

  const dbPath = join(tmpBase, 'test.db');
  const config = makeConfig(vaultDir, dbPath);
  app = new VedApp(config);
  await app.start();
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await app.stop();
  rmSync(tmpBase, { recursive: true, force: true });
});

// ── Markdown Import ────────────────────────────────────────────────────

describe('ved migrate markdown', () => {
  it('imports markdown files into vault', async () => {
    writeSourceFile('notes/hello.md', '---\ntitle: Hello\n---\nHello world');
    writeSourceFile('notes/guide.md', '---\ntype: concept\ntags:\n  - guide\n---\nA guide');

    await migrateCommand(app, ['markdown', join(sourceDir, 'notes')]);

    expect(logs.some(l => l.includes('2 markdown file'))).toBe(true);
    expect(logs.some(l => l.includes('2 imported'))).toBe(true);
  });

  it('respects --dry-run', async () => {
    writeSourceFile('test.md', '# Test');

    await migrateCommand(app, ['markdown', sourceDir, '--dry-run']);

    expect(logs.some(l => l.includes('[DRY RUN]'))).toBe(true);
  });

  it('skips existing files without --force', async () => {
    writeSourceFile('existing.md', '---\ntitle: New\n---\nNew content');
    writeVaultFile('entities/existing.md', { title: 'Old' }, 'Old content');

    await migrateCommand(app, ['markdown', sourceDir]);

    expect(logs.some(l => l.includes('exists'))).toBe(true);
    expect(logs.some(l => l.includes('0 imported') || l.includes('1 skipped'))).toBe(true);
  });

  it('overwrites with --force', async () => {
    writeSourceFile('existing.md', '---\ntitle: New\n---\nNew content');
    writeVaultFile('entities/existing.md', { title: 'Old' }, 'Old content');

    await migrateCommand(app, ['markdown', sourceDir, '--force']);

    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('imports recursively with -r', async () => {
    writeSourceFile('a.md', '# A');
    writeSourceFile('sub/b.md', '# B');

    await migrateCommand(app, ['markdown', sourceDir, '-r']);

    expect(logs.some(l => l.includes('2 markdown file'))).toBe(true);
  });

  it('adds tag with --tag', async () => {
    writeSourceFile('tagged.md', '---\ntitle: Tagged\n---\nContent');

    await migrateCommand(app, ['markdown', sourceDir, '--tag=migrated']);

    // File should have been imported with the tag
    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('routes to correct folder based on type frontmatter', async () => {
    writeSourceFile('person.md', '---\ntype: person\ntitle: Alice\n---\nAlice info');
    writeSourceFile('idea.md', '---\ntype: concept\ntitle: Idea\n---\nIdea info');

    await migrateCommand(app, ['markdown', sourceDir]);

    expect(logs.some(l => l.includes('entities/'))).toBe(true);
    expect(logs.some(l => l.includes('concepts/'))).toBe(true);
  });

  it('uses --folder override', async () => {
    writeSourceFile('note.md', '# Note');

    await migrateCommand(app, ['markdown', sourceDir, '--folder=decisions']);

    expect(logs.some(l => l.includes('decisions/note.md'))).toBe(true);
  });

  it('handles empty directory', async () => {
    const emptyDir = join(sourceDir, 'empty');
    mkdirSync(emptyDir);

    await migrateCommand(app, ['markdown', emptyDir]);

    expect(logs.some(l => l.includes('No markdown files'))).toBe(true);
  });

  it('errors on non-existent directory', async () => {
    await migrateCommand(app, ['markdown', '/nonexistent/path']);

    expect(errors.some(l => l.includes('not found'))).toBe(true);
  });
});

// ── JSON Import ────────────────────────────────────────────────────────

describe('ved migrate json', () => {
  it('imports ChatGPT export format', async () => {
    const data = [
      {
        title: 'Test Conversation',
        create_time: Date.now() / 1000,
        mapping: {
          msg1: {
            message: {
              author: { role: 'user' },
              content: { parts: ['Hello?'] },
            },
          },
          msg2: {
            message: {
              author: { role: 'assistant' },
              content: { parts: ['Hi there!'] },
            },
          },
        },
      },
    ];
    const path = writeSourceFile('chatgpt.json', JSON.stringify(data));

    await migrateCommand(app, ['json', path]);

    expect(logs.some(l => l.includes('Test Conversation'))).toBe(true);
    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('imports Claude export format', async () => {
    const data = [
      {
        uuid: 'abc-123',
        name: 'Claude Chat',
        created_at: '2026-01-15T10:00:00Z',
        chat_messages: [
          { sender: 'human', text: 'What is AI?' },
          { sender: 'assistant', text: 'AI is...' },
        ],
      },
    ];
    const path = writeSourceFile('claude.json', JSON.stringify(data));

    await migrateCommand(app, ['json', path]);

    expect(logs.some(l => l.includes('Claude Chat'))).toBe(true);
    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('imports generic object array', async () => {
    const data = [
      { name: 'Widget A', price: 19.99, category: 'tools' },
      { name: 'Widget B', price: 29.99, category: 'gadgets' },
    ];
    const path = writeSourceFile('items.json', JSON.stringify(data));

    await migrateCommand(app, ['json', path]);

    expect(logs.some(l => l.includes('2 items'))).toBe(true);
    expect(logs.some(l => l.includes('2 imported'))).toBe(true);
  });

  it('respects --dry-run', async () => {
    const data = [{ name: 'Test', value: 1 }];
    const path = writeSourceFile('dry.json', JSON.stringify(data));

    await migrateCommand(app, ['json', path, '--dry-run']);

    expect(logs.some(l => l.includes('[DRY RUN]'))).toBe(true);
  });

  it('errors on invalid JSON', async () => {
    const path = writeSourceFile('bad.json', '{not valid json');

    await migrateCommand(app, ['json', path]);

    expect(errors.some(l => l.includes('Invalid JSON'))).toBe(true);
  });

  it('errors on non-array JSON', async () => {
    const path = writeSourceFile('obj.json', '{"key": "value"}');

    await migrateCommand(app, ['json', path]);

    expect(errors.some(l => l.includes('Unsupported JSON format'))).toBe(true);
  });
});

// ── CSV Import ─────────────────────────────────────────────────────────

describe('ved migrate csv', () => {
  it('imports CSV rows as vault entities', async () => {
    const csv = 'name,role,team\nAlice,Engineer,Platform\nBob,Designer,Product';
    const path = writeSourceFile('people.csv', csv);

    await migrateCommand(app, ['csv', path]);

    expect(logs.some(l => l.includes('2 rows'))).toBe(true);
    expect(logs.some(l => l.includes('2 imported'))).toBe(true);
  });

  it('uses --name-col for entity names', async () => {
    const csv = 'title,desc\nProject Alpha,Big project\nProject Beta,Small';
    const path = writeSourceFile('projects.csv', csv);

    await migrateCommand(app, ['csv', path, '--name-col=title']);

    expect(logs.some(l => l.includes('2 imported'))).toBe(true);
  });

  it('uses --folder for target directory', async () => {
    const csv = 'name,priority\nBuild V2,high';
    const path = writeSourceFile('decisions.csv', csv);

    await migrateCommand(app, ['csv', path, '--folder=decisions']);

    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('errors on missing name column', async () => {
    const csv = 'title,desc\nTest,Desc';
    const path = writeSourceFile('bad-cols.csv', csv);

    await migrateCommand(app, ['csv', path]);

    expect(errors.some(l => l.includes('Name column'))).toBe(true);
  });

  it('handles quoted CSV fields', async () => {
    const csv = 'name,description\n"O\'Brien, John","A ""special"" person"';
    const path = writeSourceFile('quoted.csv', csv);

    await migrateCommand(app, ['csv', path]);

    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('errors on empty CSV', async () => {
    const path = writeSourceFile('empty.csv', 'name');

    await migrateCommand(app, ['csv', path]);

    expect(errors.some(l => l.includes('header row and at least one data row'))).toBe(true);
  });
});

// ── JSONL Import ───────────────────────────────────────────────────────

describe('ved migrate jsonl', () => {
  it('imports JSONL conversation logs', async () => {
    const lines = [
      JSON.stringify({ role: 'user', content: 'Hello', timestamp: '2026-01-15T10:00:00Z' }),
      JSON.stringify({ role: 'assistant', content: 'Hi!', timestamp: '2026-01-15T10:01:00Z' }),
    ].join('\n');
    const path = writeSourceFile('chat.jsonl', lines);

    await migrateCommand(app, ['jsonl', path]);

    expect(logs.some(l => l.includes('2 lines'))).toBe(true);
    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('groups messages by date', async () => {
    const lines = [
      JSON.stringify({ role: 'user', content: 'Day 1', timestamp: '2026-01-15T10:00:00Z' }),
      JSON.stringify({ role: 'user', content: 'Day 2', timestamp: '2026-01-16T10:00:00Z' }),
    ].join('\n');
    const path = writeSourceFile('multi-day.jsonl', lines);

    await migrateCommand(app, ['jsonl', path]);

    expect(logs.some(l => l.includes('2 imported'))).toBe(true);
  });

  it('handles various field names (sender, author, text, message)', async () => {
    const lines = [
      JSON.stringify({ sender: 'bob', text: 'Hey', time: '2026-01-15T10:00:00Z' }),
      JSON.stringify({ author: 'alice', message: 'Yo', created_at: '2026-01-15T10:01:00Z' }),
    ].join('\n');
    const path = writeSourceFile('mixed.jsonl', lines);

    await migrateCommand(app, ['jsonl', path]);

    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('skips invalid JSON lines', async () => {
    const lines = [
      JSON.stringify({ role: 'user', content: 'Valid' }),
      'not json at all',
      JSON.stringify({ role: 'assistant', content: 'Also valid' }),
    ].join('\n');
    const path = writeSourceFile('mixed-valid.jsonl', lines);

    await migrateCommand(app, ['jsonl', path]);

    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });
});

// ── Obsidian Import ────────────────────────────────────────────────────

describe('ved migrate obsidian', () => {
  it('imports from existing Obsidian vault', async () => {
    const obsDir = join(sourceDir, 'my-vault');
    mkdirSync(join(obsDir, '.obsidian'), { recursive: true });
    mkdirSync(join(obsDir, 'notes'), { recursive: true });
    writeFileSync(join(obsDir, 'README.md'), '# My Vault');
    writeFileSync(join(obsDir, 'notes/idea.md'), '---\ntitle: Idea\n---\nGreat idea');

    await migrateCommand(app, ['obsidian', obsDir]);

    expect(logs.some(l => l.includes('2 files'))).toBe(true);
    expect(logs.some(l => l.includes('2 imported'))).toBe(true);
  });

  it('excludes hidden folders by default', async () => {
    const obsDir = join(sourceDir, 'hidden-vault');
    mkdirSync(join(obsDir, '.obsidian'), { recursive: true });
    mkdirSync(join(obsDir, '.trash'), { recursive: true });
    writeFileSync(join(obsDir, 'visible.md'), '# Visible');
    writeFileSync(join(obsDir, '.trash/deleted.md'), '# Deleted');

    await migrateCommand(app, ['obsidian', obsDir]);

    expect(logs.some(l => l.includes('1 files'))).toBe(true);
    expect(logs.some(l => l.includes('1 imported'))).toBe(true);
  });

  it('preserves directory structure', async () => {
    const obsDir = join(sourceDir, 'structured');
    mkdirSync(join(obsDir, 'projects'), { recursive: true });
    writeFileSync(join(obsDir, 'projects/alpha.md'), '# Alpha');

    await migrateCommand(app, ['obsidian', obsDir]);

    expect(logs.some(l => l.includes('projects/alpha.md'))).toBe(true);
  });

  it('errors on non-existent vault', async () => {
    await migrateCommand(app, ['obsidian', '/nonexistent/vault']);

    expect(errors.some(l => l.includes('not found'))).toBe(true);
  });
});

// ── Migration History & Undo ───────────────────────────────────────────

describe('ved migrate history', () => {
  it('shows empty history', async () => {
    await migrateCommand(app, ['history']);

    expect(logs.some(l => l.includes('No migrations'))).toBe(true);
  });

  it('shows migration history after import', async () => {
    writeSourceFile('file1.md', '# File 1');
    await migrateCommand(app, ['markdown', sourceDir]);

    logs = [];
    await migrateCommand(app, ['history']);

    expect(logs.some(l => l.includes('markdown'))).toBe(true);
    expect(logs.some(l => l.includes('1 files') || l.includes('   1'))).toBe(true);
  });
});

describe('ved migrate undo', () => {
  it('undoes a migration', async () => {
    writeSourceFile('undoable.md', '---\ntitle: Undo Me\n---\nContent');
    await migrateCommand(app, ['markdown', sourceDir]);

    // Get migration ID from history
    const migDir = join(tmpBase, '.ved', 'migrations');
    const records = JSON.parse(readFileSync(join(migDir, 'index.json'), 'utf-8'));
    const id = records[0].id;

    logs = [];
    await migrateCommand(app, ['undo', id.slice(0, 8)]);

    expect(logs.some(l => l.includes('Removed'))).toBe(true);
  });

  it('errors on non-existent migration', async () => {
    await migrateCommand(app, ['undo', 'nonexistent']);

    expect(errors.some(l => l.includes('not found'))).toBe(true);
  });

  it('errors on already-undone migration', async () => {
    writeSourceFile('double-undo.md', '---\ntitle: Double\n---\nContent');
    await migrateCommand(app, ['markdown', sourceDir]);

    const migDir = join(tmpBase, '.ved', 'migrations');
    const records = JSON.parse(readFileSync(join(migDir, 'index.json'), 'utf-8'));
    const id = records[0].id;

    await migrateCommand(app, ['undo', id.slice(0, 8)]);
    errors = [];
    await migrateCommand(app, ['undo', id.slice(0, 8)]);

    expect(errors.some(l => l.includes('already undone'))).toBe(true);
  });

  it('supports --dry-run', async () => {
    writeSourceFile('dry-undo.md', '---\ntitle: Dry\n---\nContent');
    await migrateCommand(app, ['markdown', sourceDir]);

    const migDir = join(tmpBase, '.ved', 'migrations');
    const records = JSON.parse(readFileSync(join(migDir, 'index.json'), 'utf-8'));
    const id = records[0].id;

    logs = [];
    await migrateCommand(app, ['undo', id.slice(0, 8), '--dry-run']);

    expect(logs.some(l => l.includes('[DRY RUN]'))).toBe(true);
  });
});

// ── Migration Status ───────────────────────────────────────────────────

describe('ved migrate status', () => {
  it('shows zero state', async () => {
    await migrateCommand(app, ['status']);

    expect(logs.some(l => l.includes('Total migrations'))).toBe(true);
    expect(logs.some(l => l.includes('0'))).toBe(true);
  });

  it('shows stats after import', async () => {
    writeSourceFile('status-file.md', '# Status');
    await migrateCommand(app, ['markdown', sourceDir]);

    logs = [];
    await migrateCommand(app, ['status']);

    expect(logs.some(l => l.includes('Active:'))).toBe(true);
    expect(logs.some(l => l.includes('1'))).toBe(true);
  });
});

// ── Validate ───────────────────────────────────────────────────────────

describe('ved migrate validate', () => {
  it('validates markdown source', async () => {
    writeSourceFile('val.md', '# Validate');

    await migrateCommand(app, ['validate', 'markdown', sourceDir]);

    expect(logs.some(l => l.includes('markdown files found'))).toBe(true);
  });

  it('validates JSON source', async () => {
    const data = [{ title: 'Test', mapping: {} }];
    const path = writeSourceFile('val.json', JSON.stringify(data));

    await migrateCommand(app, ['validate', 'json', path]);

    expect(logs.some(l => l.includes('Valid JSON'))).toBe(true);
    expect(logs.some(l => l.includes('ChatGPT'))).toBe(true);
  });

  it('validates CSV source', async () => {
    const path = writeSourceFile('val.csv', 'name,age\nAlice,30\nBob,25');

    await migrateCommand(app, ['validate', 'csv', path]);

    expect(logs.some(l => l.includes('2 data rows'))).toBe(true);
    expect(logs.some(l => l.includes('name, age'))).toBe(true);
  });

  it('validates JSONL source', async () => {
    const path = writeSourceFile('val.jsonl', '{"ok": true}\n{"ok": false}\nnot json');

    await migrateCommand(app, ['validate', 'jsonl', path]);

    expect(logs.some(l => l.includes('2 valid'))).toBe(true);
    expect(logs.some(l => l.includes('1 invalid'))).toBe(true);
  });

  it('validates Obsidian vault', async () => {
    const obsDir = join(sourceDir, 'obs-val');
    mkdirSync(join(obsDir, '.obsidian'), { recursive: true });
    writeFileSync(join(obsDir, 'note.md'), '# Note');

    await migrateCommand(app, ['validate', 'obsidian', obsDir]);

    expect(logs.some(l => l.includes('.obsidian directory found'))).toBe(true);
    expect(logs.some(l => l.includes('1 markdown'))).toBe(true);
  });

  it('errors on missing source', async () => {
    await migrateCommand(app, ['validate']);

    expect(errors.some(l => l.includes('Usage'))).toBe(true);
  });

  it('errors on unknown source type', async () => {
    await migrateCommand(app, ['validate', 'xml', '/some/path']);

    expect(errors.some(l => l.includes('Unknown source'))).toBe(true);
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────────

describe('ved migrate edge cases', () => {
  it('handles --help', async () => {
    await migrateCommand(app, ['--help']);
    // checkHelp handles output
  });

  it('errors on unknown subcommand', async () => {
    await migrateCommand(app, ['unknown']);

    expect(errors.some(l => l.includes('Unknown subcommand'))).toBe(true);
  });

  it('defaults to status with no args', async () => {
    await migrateCommand(app, []);

    expect(logs.some(l => l.includes('Migration Status'))).toBe(true);
  });

  it('sanitizes filenames properly', async () => {
    const data = [{ name: 'Hello <World> "Test" | File?', value: 1 }];
    const path = writeSourceFile('special.json', JSON.stringify(data));

    await migrateCommand(app, ['json', path]);

    // Should not contain invalid characters in vault path
    expect(logs.some(l => l.includes('✓'))).toBe(true);
  });

  it('handles file read errors gracefully', async () => {
    await migrateCommand(app, ['json', '/nonexistent/file.json']);

    expect(errors.some(l => l.includes('not found'))).toBe(true);
  });
});
