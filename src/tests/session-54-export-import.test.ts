/**
 * Session 54 tests — `ved export` + `ved import` CLI commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VedApp } from '../app.js';
import { getDefaults } from '../core/config.js';
import type { VedConfig } from '../types/index.js';
import type { VaultExport } from '../export-types.js';

// ── Helpers ──

function createTestDir(): string {
  const dir = join(tmpdir(), `ved-test-s54-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestVault(baseDir: string): string {
  const vault = join(baseDir, 'vault');
  mkdirSync(join(vault, 'daily'), { recursive: true });
  mkdirSync(join(vault, 'entities'), { recursive: true });
  mkdirSync(join(vault, 'concepts'), { recursive: true });
  mkdirSync(join(vault, 'decisions'), { recursive: true });

  writeFileSync(join(vault, 'entities', 'alice.md'), `---
type: person
tags: [person, engineer]
confidence: 0.9
---
# Alice
Alice is a software engineer who works on distributed systems.
She is an expert in [[Rust]] and [[Go]].
`);

  writeFileSync(join(vault, 'entities', 'bob.md'), `---
type: person
tags: [person, manager]
confidence: 0.85
---
# Bob
Bob is a project manager who works with [[Alice]].
He specializes in agile methodologies.
`);

  writeFileSync(join(vault, 'concepts', 'rag-pipeline.md'), `---
type: concept
tags: [technology, ai, search]
confidence: 0.85
---
# RAG Pipeline
Retrieval-Augmented Generation combines search with LLM generation.
Uses vector embeddings, FTS, and graph walk for multi-signal retrieval.
`);

  writeFileSync(join(vault, 'decisions', '2026-03-01-use-sqlite.md'), `---
type: decision
tags: [decision, architecture]
date: 2026-03-01
---
# Use SQLite for Audit
Decision: Use SQLite with WAL mode for the audit chain.
Rationale: Single-file, ACID, zero-dependency, fast reads.
`);

  writeFileSync(join(vault, 'daily', '2026-03-06.md'), `---
date: 2026-03-06
---
# 2026-03-06

Worked on export/import functionality.
Talked to [[Alice]] about [[RAG Pipeline]].
`);

  return vault;
}

function createTestConfig(baseDir: string, vaultPath: string): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    dbPath: join(baseDir, 'ved.db'),
    logLevel: 'error',
    memory: {
      ...defaults.memory,
      vaultPath,
      gitEnabled: false,
      compressionThreshold: 999_999,
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['owner-1'],
    },
  } as VedConfig;
}

let testDir: string;
let vaultPath: string;
let config: VedConfig;

beforeEach(() => {
  testDir = createTestDir();
  vaultPath = createTestVault(testDir);
  config = createTestConfig(testDir, vaultPath);
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ══════════════════════════════════════════════════════════════
// EXPORT TESTS
// ══════════════════════════════════════════════════════════════

describe('VedApp.exportVault()', () => {
  it('exports all vault files with correct structure', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault();

    expect(result.vedVersion).toBe('0.1.0');
    expect(result.exportedAt).toBeTruthy();
    expect(result.vaultPath).toBe(vaultPath);
    expect(result.fileCount).toBe(5);
    expect(result.files).toHaveLength(5);

    // Should not include audit or stats by default
    expect(result.audit).toBeUndefined();
    expect(result.stats).toBeUndefined();

    await app.stop();
  });

  it('exports files with frontmatter, body, and links', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault();
    const alice = result.files.find(f => f.path.includes('alice'));

    expect(alice).toBeDefined();
    expect(alice!.frontmatter.type).toBe('person');
    expect(alice!.frontmatter.confidence).toBe(0.9);
    expect(alice!.body).toContain('software engineer');
    // Links are normalized to lowercase by extractLinkTargets
    expect(alice!.links).toContain('rust');
    expect(alice!.links).toContain('go');

    await app.stop();
  });

  it('exports only specified folder', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault({ folder: 'entities' });

    expect(result.fileCount).toBe(2);
    expect(result.files.every(f => f.path.startsWith('entities/'))).toBe(true);

    await app.stop();
  });

  it('exports with audit info when requested', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault({ includeAudit: true });

    expect(result.audit).toBeDefined();
    expect(typeof result.audit!.chainLength).toBe('number');
    expect(typeof result.audit!.chainHead).toBe('string');
    expect(typeof result.audit!.entries).toBe('number');

    await app.stop();
  });

  it('exports with stats when requested', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault({ includeStats: true });

    expect(result.stats).toBeDefined();
    expect(typeof result.stats!.rag.filesIndexed).toBe('number');
    expect(typeof result.stats!.vault.fileCount).toBe('number');
    expect(typeof result.stats!.sessions.active).toBe('number');

    await app.stop();
  });

  it('exports with both audit and stats', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault({ includeAudit: true, includeStats: true });

    expect(result.audit).toBeDefined();
    expect(result.stats).toBeDefined();

    await app.stop();
  });

  it('exports empty vault gracefully', async () => {
    // Create empty vault
    const emptyVault = join(testDir, 'empty-vault');
    mkdirSync(emptyVault, { recursive: true });
    const emptyConfig = { ...config, dbPath: join(testDir, 'ved-empty.db'), memory: { ...config.memory, vaultPath: emptyVault } };

    const app = new VedApp(emptyConfig);
    await app.init();

    const result = await app.exportVault();

    expect(result.fileCount).toBe(0);
    expect(result.files).toHaveLength(0);

    await app.stop();
  });

  it('exports non-existent folder returns empty', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault({ folder: 'nonexistent' });

    expect(result.fileCount).toBe(0);
    expect(result.files).toHaveLength(0);

    await app.stop();
  });

  it('exported JSON is valid and parseable', async () => {
    const app = new VedApp(config);
    await app.init();

    const result = await app.exportVault();
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as VaultExport;

    expect(parsed.vedVersion).toBe('0.1.0');
    expect(parsed.files).toHaveLength(5);
    expect(parsed.files[0].path).toBeTruthy();

    await app.stop();
  });

  it('throws when not initialized', async () => {
    const app = new VedApp(config);
    await expect(app.exportVault()).rejects.toThrow('not initialized');
  });
});

// ══════════════════════════════════════════════════════════════
// IMPORT TESTS
// ══════════════════════════════════════════════════════════════

describe('VedApp.importVault()', () => {
  function makeExport(files: Array<{ path: string; frontmatter: Record<string, unknown>; body: string; links: string[] }>): VaultExport {
    return {
      vedVersion: '0.1.0',
      exportedAt: new Date().toISOString(),
      vaultPath: '/tmp/test-vault',
      fileCount: files.length,
      files,
    };
  }

  it('imports new files into empty vault', async () => {
    const emptyVault = join(testDir, 'import-vault');
    mkdirSync(join(emptyVault, 'entities'), { recursive: true });
    const importConfig = { ...config, dbPath: join(testDir, 'ved-import.db'), memory: { ...config.memory, vaultPath: emptyVault } };

    const app = new VedApp(importConfig);
    await app.init();

    const data = makeExport([
      { path: 'entities/carol.md', frontmatter: { type: 'person' }, body: '# Carol\nNew person.', links: [] },
      { path: 'entities/dave.md', frontmatter: { type: 'person' }, body: '# Dave\nAnother person.', links: ['Carol'] },
    ]);

    const result = await app.importVault(data);

    expect(result.created).toBe(2);
    expect(result.overwritten).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.errorPaths).toHaveLength(0);

    // Verify files exist
    expect(existsSync(join(emptyVault, 'entities', 'carol.md'))).toBe(true);
    expect(existsSync(join(emptyVault, 'entities', 'dave.md'))).toBe(true);

    await app.stop();
  });

  it('merge mode skips existing files', async () => {
    const app = new VedApp(config);
    await app.init();

    const data = makeExport([
      { path: 'entities/alice.md', frontmatter: { type: 'person', confidence: 0.5 }, body: '# Alice\nModified.', links: [] },
      { path: 'entities/newperson.md', frontmatter: { type: 'person' }, body: '# New\nBrand new.', links: [] },
    ]);

    const result = await app.importVault(data, 'merge');

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.overwritten).toBe(0);

    // Original alice should be untouched
    const aliceContent = readFileSync(join(vaultPath, 'entities', 'alice.md'), 'utf-8');
    expect(aliceContent).toContain('software engineer');

    await app.stop();
  });

  it('overwrite mode replaces existing files', async () => {
    const app = new VedApp(config);
    await app.init();

    const data = makeExport([
      { path: 'entities/alice.md', frontmatter: { type: 'person', confidence: 0.99 }, body: '# Alice Updated\nCompletely rewritten.', links: [] },
    ]);

    const result = await app.importVault(data, 'overwrite');

    expect(result.overwritten).toBe(1);
    expect(result.created).toBe(0);

    // Alice should be updated
    const aliceContent = readFileSync(join(vaultPath, 'entities', 'alice.md'), 'utf-8');
    expect(aliceContent).toContain('Completely rewritten');

    await app.stop();
  });

  it('fail mode (default) skips existing files', async () => {
    const app = new VedApp(config);
    await app.init();

    const data = makeExport([
      { path: 'entities/alice.md', frontmatter: { type: 'person' }, body: '# Changed', links: [] },
      { path: 'entities/charlie.md', frontmatter: { type: 'person' }, body: '# Charlie', links: [] },
    ]);

    const result = await app.importVault(data);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.overwritten).toBe(0);

    await app.stop();
  });

  it('handles import errors gracefully', async () => {
    const app = new VedApp(config);
    await app.init();

    // Path traversal should be caught by vault's path containment
    // Use enough ../ to definitely escape any /tmp/... path
    const traversalPath = '../'.repeat(20) + 'etc/passwd';
    const data = makeExport([
      { path: traversalPath, frontmatter: {}, body: 'evil', links: [] },
      { path: 'entities/valid.md', frontmatter: { type: 'person' }, body: '# Valid', links: [] },
    ]);

    const result = await app.importVault(data);

    expect(result.errors).toBe(1);
    expect(result.errorPaths).toContain(traversalPath);
    expect(result.created).toBe(1); // valid file still imported

    await app.stop();
  });

  it('throws when not initialized', async () => {
    const app = new VedApp(config);
    const data = makeExport([]);
    await expect(app.importVault(data)).rejects.toThrow('not initialized');
  });

  it('imports empty export gracefully', async () => {
    const app = new VedApp(config);
    await app.init();

    const data = makeExport([]);
    const result = await app.importVault(data);

    expect(result.created).toBe(0);
    expect(result.overwritten).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    await app.stop();
  });
});

// ══════════════════════════════════════════════════════════════
// ROUND-TRIP TEST
// ══════════════════════════════════════════════════════════════

describe('Export → Import round-trip', () => {
  it('export then import into new vault preserves all data', async () => {
    // Export from populated vault
    const app1 = new VedApp(config);
    await app1.init();
    const exported = await app1.exportVault();
    await app1.stop();

    // Import into fresh vault
    const newVault = join(testDir, 'roundtrip-vault');
    mkdirSync(join(newVault, 'daily'), { recursive: true });
    mkdirSync(join(newVault, 'entities'), { recursive: true });
    mkdirSync(join(newVault, 'concepts'), { recursive: true });
    mkdirSync(join(newVault, 'decisions'), { recursive: true });

    const newConfig = { ...config, memory: { ...config.memory, vaultPath: newVault }, dbPath: join(testDir, 'ved2.db') };
    const app2 = new VedApp(newConfig);
    await app2.init();

    const result = await app2.importVault(exported);

    expect(result.created).toBe(5);
    expect(result.errors).toBe(0);

    // Re-export and compare
    const reExported = await app2.exportVault();

    expect(reExported.fileCount).toBe(exported.fileCount);

    // Compare file contents
    for (const origFile of exported.files) {
      const imported = reExported.files.find(f => f.path === origFile.path);
      expect(imported).toBeDefined();
      expect(imported!.frontmatter).toEqual(origFile.frontmatter);
      expect(imported!.body).toBe(origFile.body);
      expect(imported!.links).toEqual(origFile.links);
    }

    await app2.stop();
  });
});

// ══════════════════════════════════════════════════════════════
// vaultFileExists TESTS
// ══════════════════════════════════════════════════════════════

describe('VedApp.vaultFileExists()', () => {
  it('returns true for existing file', async () => {
    const app = new VedApp(config);
    await app.init();
    expect(app.vaultFileExists('entities/alice.md')).toBe(true);
    await app.stop();
  });

  it('returns false for non-existing file', async () => {
    const app = new VedApp(config);
    await app.init();
    expect(app.vaultFileExists('entities/nonexistent.md')).toBe(false);
    await app.stop();
  });
});

// ══════════════════════════════════════════════════════════════
// CLI ARG PARSING TESTS (unit-style, no app needed)
// ══════════════════════════════════════════════════════════════

describe('Export arg parsing', () => {
  // We test the flag parsing logic indirectly via the app methods
  // since the CLI functions are not exported. But we can verify
  // the options plumbing works.

  it('folder option filters correctly', async () => {
    const app = new VedApp(config);
    await app.init();

    const all = await app.exportVault();
    const entities = await app.exportVault({ folder: 'entities' });
    const daily = await app.exportVault({ folder: 'daily' });

    expect(all.fileCount).toBe(5);
    expect(entities.fileCount).toBe(2);
    expect(daily.fileCount).toBe(1);

    await app.stop();
  });

  it('concepts folder export', async () => {
    const app = new VedApp(config);
    await app.init();

    const concepts = await app.exportVault({ folder: 'concepts' });
    expect(concepts.fileCount).toBe(1);
    expect(concepts.files[0].path).toContain('rag-pipeline');

    await app.stop();
  });

  it('decisions folder export', async () => {
    const app = new VedApp(config);
    await app.init();

    const decisions = await app.exportVault({ folder: 'decisions' });
    expect(decisions.fileCount).toBe(1);
    expect(decisions.files[0].frontmatter.type).toBe('decision');

    await app.stop();
  });
});
