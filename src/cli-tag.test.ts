/**
 * Tests for `ved tag` — vault tagging CLI.
 *
 * @module cli-tag.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VedApp } from './app.js';
import { getDefaults, VedConfig } from './core/config.js';
import { tagCommand } from './cli-tag.js';
import { parseMarkdown } from './memory/markdown.js';

// ── Helpers ────────────────────────────────────────────────────────────

let app: VedApp;
let vaultDir: string;
let tmpBase: string;
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
  const content = `---\n${yaml}\n---\n\n${body}\n`;
  const absPath = join(vaultDir, relPath);
  const dir = absPath.substring(0, absPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

function readVaultFrontmatter(relPath: string): Record<string, unknown> {
  const raw = readFileSync(join(vaultDir, relPath), 'utf-8');
  const { frontmatter } = parseMarkdown(raw);
  return frontmatter;
}

beforeEach(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ved-tag-'));
  vaultDir = join(tmpBase, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(join(vaultDir, 'entities'), { recursive: true });
  mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
  mkdirSync(join(vaultDir, 'decisions'), { recursive: true });
  mkdirSync(join(vaultDir, 'daily'), { recursive: true });

  // Create sample vault files
  writeVaultFile('entities/alice.md', { type: 'person', tags: ['person', 'team'] }, 'Alice is a developer.');
  writeVaultFile('entities/bob.md', { type: 'person', tags: ['person', 'lead'] }, 'Bob is the team lead.');
  writeVaultFile('concepts/ml.md', { type: 'concept', tags: ['tech', 'ml'] }, 'Machine learning notes.');
  writeVaultFile('concepts/api.md', { type: 'concept', tags: ['tech'] }, 'API design patterns.');
  writeVaultFile('decisions/use-rust.md', { type: 'decision', tags: ['decision', 'tech'] }, 'Decided to use Rust.');
  writeVaultFile('entities/untagged.md', { type: 'person' }, 'No tags on this one.');
  writeVaultFile('daily/2026-03-10.md', {}, 'Daily note.');

  const dbPath = join(tmpBase, 'test.db');
  const config = makeConfig(vaultDir, dbPath);
  app = new VedApp(config);
  await app.init();

  // Capture console output
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  try { await app.stop(); } catch { /* ok */ }
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── LIST ───────────────────────────────────────────────────────────────

describe('ved tag list', () => {
  it('lists all tags with counts', async () => {
    await tagCommand(app, ['list']);
    const output = logs.join('\n');
    expect(output).toContain('Tags');
    expect(output).toContain('#person');
    expect(output).toContain('#tech');
    expect(output).toContain('#team');
  });

  it('sorts by count with --count flag', async () => {
    await tagCommand(app, ['list', '--count']);
    const output = logs.join('\n');
    // tech appears on 3 files, person on 2
    const techIdx = output.indexOf('#tech');
    const personIdx = output.indexOf('#person');
    expect(techIdx).toBeLessThan(personIdx);
  });

  it('shows empty message when no tags', async () => {
    const emptyVault = mkdtempSync(join(tmpdir(), 'ved-empty-'));
    mkdirSync(join(emptyVault, 'entities'), { recursive: true });
    const dbPath2 = join(emptyVault, 'test.db');
    const config2 = makeConfig(emptyVault, dbPath2);
    const emptyApp = new VedApp(config2);
    await tagCommand(emptyApp, ['list']);
    const output = logs.join('\n');
    expect(output).toContain('No tags found');
    rmSync(emptyVault, { recursive: true, force: true });
  });
});

// ── SHOW ───────────────────────────────────────────────────────────────

describe('ved tag show', () => {
  it('shows files for a specific tag', async () => {
    await tagCommand(app, ['show', 'person']);
    const output = logs.join('\n');
    expect(output).toContain('#person');
    expect(output).toContain('alice.md');
    expect(output).toContain('bob.md');
  });

  it('handles tag with leading #', async () => {
    await tagCommand(app, ['show', '#tech']);
    const output = logs.join('\n');
    expect(output).toContain('#tech');
    expect(output).toContain('ml.md');
  });

  it('shows empty message for nonexistent tag', async () => {
    await tagCommand(app, ['show', 'nonexistent']);
    const output = logs.join('\n');
    expect(output).toContain('No files tagged');
  });

  it('falls back to show for unknown subcommand that looks like a tag', async () => {
    await tagCommand(app, ['tech']);
    const output = logs.join('\n');
    expect(output).toContain('#tech');
  });
});

// ── ADD ────────────────────────────────────────────────────────────────

describe('ved tag add', () => {
  it('adds a tag to a file', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', 'engineer']);
    const output = logs.join('\n');
    expect(output).toContain('Added');
    expect(output).toContain('#engineer');

    const fm = readVaultFrontmatter('entities/alice.md');
    expect(fm.tags).toContain('engineer');
  });

  it('adds multiple tags at once', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', 'senior', 'remote']);
    const output = logs.join('\n');
    expect(output).toContain('#senior');
    expect(output).toContain('#remote');
  });

  it('skips already-present tags', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', 'person']);
    const output = logs.join('\n');
    expect(output).toContain('already present');
  });

  it('resolves file by name without extension', async () => {
    await tagCommand(app, ['add', 'entities/alice', 'newbie']);
    const output = logs.join('\n');
    expect(output).toContain('Added');
  });

  it('rejects invalid tag names', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', 'bad tag']);
    const output = errors.join('\n');
    expect(output).toContain('Invalid tag');
    expect(output).toContain('whitespace');
  });

  it('errors on missing file', async () => {
    await tagCommand(app, ['add', 'nonexistent.md', 'tag1']);
    const output = errors.join('\n');
    expect(output).toContain('File not found');
  });

  it('errors on missing arguments', async () => {
    await tagCommand(app, ['add', 'entities/alice.md']);
    const output = errors.join('\n');
    expect(output).toContain('Usage');
  });
});

// ── REMOVE ─────────────────────────────────────────────────────────────

describe('ved tag remove', () => {
  it('removes a tag from a file', async () => {
    await tagCommand(app, ['remove', 'entities/alice.md', 'team']);
    const output = logs.join('\n');
    expect(output).toContain('Removed');
    expect(output).toContain('#team');

    const fm = readVaultFrontmatter('entities/alice.md');
    const tags = fm.tags as string[];
    expect(tags).not.toContain('team');
    expect(tags).toContain('person');
  });

  it('handles removing nonexistent tag gracefully', async () => {
    await tagCommand(app, ['remove', 'entities/alice.md', 'nonexistent']);
    const output = logs.join('\n');
    expect(output).toContain('None of the specified tags');
  });
});

// ── RENAME ─────────────────────────────────────────────────────────────

describe('ved tag rename', () => {
  it('renames a tag across all files', async () => {
    await tagCommand(app, ['rename', 'tech', 'technology']);
    const output = logs.join('\n');
    expect(output).toContain('Renamed');
    expect(output).toContain('#tech');
    expect(output).toContain('#technology');
    expect(output).toContain('3 files');
  });

  it('supports --dry-run', async () => {
    await tagCommand(app, ['rename', 'tech', 'technology', '--dry-run']);
    const output = logs.join('\n');
    expect(output).toContain('DRY RUN');
    expect(output).toContain('3 files');

    // Verify no actual change
    const fm = readVaultFrontmatter('concepts/ml.md');
    expect(fm.tags).toContain('tech');
  });

  it('handles renaming nonexistent tag', async () => {
    await tagCommand(app, ['rename', 'nonexistent', 'something']);
    const output = logs.join('\n');
    expect(output).toContain('No files tagged');
  });

  it('handles same old/new tag', async () => {
    await tagCommand(app, ['rename', 'tech', 'tech']);
    const output = logs.join('\n');
    expect(output).toContain('same');
  });

  it('deduplicates when target tag already exists on file', async () => {
    // ml.md has [tech, ml]. Rename tech to ml → should get [ml] not [ml, ml]
    await tagCommand(app, ['rename', 'tech', 'ml']);
    const fm = readVaultFrontmatter('concepts/ml.md');
    const tags = fm.tags as string[];
    const mlCount = tags.filter(t => t === 'ml').length;
    expect(mlCount).toBe(1);
  });
});

// ── SET ────────────────────────────────────────────────────────────────

describe('ved tag set', () => {
  it('replaces all tags on a file', async () => {
    await tagCommand(app, ['set', 'entities/alice.md', 'new1', 'new2']);
    const output = logs.join('\n');
    expect(output).toContain('Set tags');
    expect(output).toContain('#new1');
    expect(output).toContain('#new2');

    const fm = readVaultFrontmatter('entities/alice.md');
    const tags = fm.tags as string[];
    expect(tags).toEqual(['new1', 'new2']);
  });

  it('deduplicates input tags', async () => {
    await tagCommand(app, ['set', 'entities/alice.md', 'x', 'x', 'y']);
    const fm = readVaultFrontmatter('entities/alice.md');
    const tags = fm.tags as string[];
    expect(tags).toEqual(['x', 'y']);
  });
});

// ── CLEAR ──────────────────────────────────────────────────────────────

describe('ved tag clear', () => {
  it('clears all tags from a file', async () => {
    await tagCommand(app, ['clear', 'entities/alice.md']);
    const output = logs.join('\n');
    expect(output).toContain('Cleared');
    expect(output).toContain('2 tags');

    const fm = readVaultFrontmatter('entities/alice.md');
    const tags = fm.tags as string[];
    expect(tags).toEqual([]);
  });

  it('handles file with no tags', async () => {
    await tagCommand(app, ['clear', 'entities/untagged.md']);
    const output = logs.join('\n');
    expect(output).toContain('has no tags');
  });
});

// ── ORPHANS ────────────────────────────────────────────────────────────

describe('ved tag orphans', () => {
  it('finds files without tags', async () => {
    await tagCommand(app, ['orphans']);
    const output = logs.join('\n');
    expect(output).toContain('Untagged files');
    expect(output).toContain('untagged.md');
    // Daily notes should be excluded by default
    expect(output).not.toContain('2026-03-10.md');
  });

  it('includes daily notes with --include-daily', async () => {
    await tagCommand(app, ['orphans', '--include-daily']);
    const output = logs.join('\n');
    expect(output).toContain('2026-03-10.md');
  });
});

// ── STATS ──────────────────────────────────────────────────────────────

describe('ved tag stats', () => {
  it('shows tag statistics', async () => {
    await tagCommand(app, ['stats']);
    const output = logs.join('\n');
    expect(output).toContain('Tag Statistics');
    expect(output).toContain('Total tags');
    expect(output).toContain('Tagged files');
    expect(output).toContain('Untagged files');
    expect(output).toContain('Avg tags/file');
    expect(output).toContain('Top tags');
  });
});

// ── FIND ───────────────────────────────────────────────────────────────

describe('ved tag find', () => {
  it('finds files matching all given tags (intersection)', async () => {
    await tagCommand(app, ['find', 'person', 'team']);
    const output = logs.join('\n');
    expect(output).toContain('alice.md');
    expect(output).not.toContain('bob.md');
  });

  it('finds files matching any tag with --any (union)', async () => {
    await tagCommand(app, ['find', 'team', 'lead', '--any']);
    const output = logs.join('\n');
    expect(output).toContain('alice.md');
    expect(output).toContain('bob.md');
  });

  it('handles no matches', async () => {
    await tagCommand(app, ['find', 'person', 'ml']);
    const output = logs.join('\n');
    expect(output).toContain('No files matching');
  });

  it('shows file tags in output', async () => {
    await tagCommand(app, ['find', 'tech']);
    const output = logs.join('\n');
    expect(output).toContain('[#');
  });
});

// ── VALIDATION ─────────────────────────────────────────────────────────

describe('ved tag validation', () => {
  it('rejects tags with brackets', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', 'bad[tag']);
    const output = errors.join('\n');
    expect(output).toContain('Invalid tag');
  });

  it('rejects tags longer than 64 chars', async () => {
    const longTag = 'a'.repeat(65);
    await tagCommand(app, ['add', 'entities/alice.md', longTag]);
    const output = errors.join('\n');
    expect(output).toContain('Invalid tag');
    expect(output).toContain('64');
  });

  it('normalizes tags to lowercase', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', 'CamelCase']);
    const fm = readVaultFrontmatter('entities/alice.md');
    const tags = fm.tags as string[];
    expect(tags).toContain('camelcase');
    expect(tags).not.toContain('CamelCase');
  });

  it('strips leading # from tag input', async () => {
    await tagCommand(app, ['add', 'entities/alice.md', '#newtag']);
    const fm = readVaultFrontmatter('entities/alice.md');
    const tags = fm.tags as string[];
    expect(tags).toContain('newtag');
  });
});

// ── EDGE CASES ─────────────────────────────────────────────────────────

describe('ved tag edge cases', () => {
  it('handles unknown subcommand', async () => {
    await tagCommand(app, ['--bogus']);
    const output = errors.join('\n');
    expect(output).toContain('Unknown subcommand');
  });

  it('defaults to list when no subcommand', async () => {
    await tagCommand(app, []);
    const output = logs.join('\n');
    expect(output).toContain('Tags');
  });

  it('resolves file in vault subdirectories', async () => {
    await tagCommand(app, ['add', 'entities/alice', 'found']);
    const output = logs.join('\n');
    expect(output).toContain('Added');
  });
});
