/**
 * Tests for ved alias — command shortcut manager.
 *
 * @module cli-alias.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAliasStore,
  saveAliasStore,
  validateAliasName,
  resolveAlias,
  type AliasStore,
  type AliasEntry,
} from './cli-alias.js';

// ── Test helpers ───────────────────────────────────────────────────────

let testDir: string;

function setTestDir(): string {
  testDir = join(tmpdir(), `ved-alias-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  // Override config dir for testing
  process.env.VED_CONFIG_DIR = testDir;
  return testDir;
}

function cleanup(): void {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  delete process.env.VED_CONFIG_DIR;
}

function writeAliasFile(store: AliasStore): void {
  saveAliasStore(store);
}

function makeAlias(name: string, command: string, description?: string): AliasEntry {
  const now = new Date().toISOString();
  return { name, command, description, createdAt: now, updatedAt: now };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('cli-alias', () => {
  beforeEach(() => {
    setTestDir();
  });

  afterEach(() => {
    cleanup();
  });

  // ── validateAliasName ──────────────────────────────────────────────

  describe('validateAliasName', () => {
    it('accepts valid names', () => {
      expect(validateAliasName('ss')).toBeNull();
      expect(validateAliasName('my-alias')).toBeNull();
      expect(validateAliasName('search2')).toBeNull();
      expect(validateAliasName('myAlias_v2')).toBeNull();
      expect(validateAliasName('a')).toBeNull();
    });

    it('rejects empty name', () => {
      expect(validateAliasName('')).toBeTruthy();
    });

    it('rejects names starting with number', () => {
      expect(validateAliasName('2fast')).toBeTruthy();
    });

    it('rejects names starting with hyphen', () => {
      expect(validateAliasName('-bad')).toBeTruthy();
    });

    it('rejects names with special characters', () => {
      expect(validateAliasName('my alias')).toBeTruthy();
      expect(validateAliasName('alias!')).toBeTruthy();
      expect(validateAliasName('alias.name')).toBeTruthy();
      expect(validateAliasName('alias@name')).toBeTruthy();
    });

    it('rejects names over 64 characters', () => {
      const longName = 'a'.repeat(65);
      expect(validateAliasName(longName)).toBeTruthy();
    });

    it('accepts names at exactly 64 characters', () => {
      const name = 'a'.repeat(64);
      expect(validateAliasName(name)).toBeNull();
    });

    it('rejects reserved ved command names', () => {
      expect(validateAliasName('init')).toContain('reserved');
      expect(validateAliasName('start')).toContain('reserved');
      expect(validateAliasName('search')).toContain('reserved');
      expect(validateAliasName('memory')).toContain('reserved');
      expect(validateAliasName('trust')).toContain('reserved');
      expect(validateAliasName('config')).toContain('reserved');
      expect(validateAliasName('alias')).toContain('reserved');
      expect(validateAliasName('version')).toContain('reserved');
    });

    it('allows names similar to but not exactly reserved names', () => {
      expect(validateAliasName('search2')).toBeNull();
      expect(validateAliasName('my-config')).toBeNull();
      expect(validateAliasName('trusty')).toBeNull();
    });
  });

  // ── loadAliasStore + saveAliasStore ────────────────────────────────

  describe('store persistence', () => {
    it('returns empty store when no file exists', () => {
      const store = loadAliasStore();
      expect(store.aliases).toEqual([]);
    });

    it('round-trips aliases through save/load', () => {
      const store: AliasStore = {
        aliases: [
          makeAlias('ss', 'search --fts-only', 'Quick FTS search'),
          makeAlias('daily', 'memory daily'),
          makeAlias('health', 'doctor'),
        ],
      };

      saveAliasStore(store);
      const loaded = loadAliasStore();

      expect(loaded.aliases).toHaveLength(3);
      expect(loaded.aliases[0].name).toBe('ss');
      expect(loaded.aliases[0].command).toBe('search --fts-only');
      expect(loaded.aliases[0].description).toBe('Quick FTS search');
      expect(loaded.aliases[1].name).toBe('daily');
      expect(loaded.aliases[1].command).toBe('memory daily');
      expect(loaded.aliases[1].description).toBeUndefined();
      expect(loaded.aliases[2].name).toBe('health');
      expect(loaded.aliases[2].command).toBe('doctor');
    });

    it('handles commands with special characters', () => {
      const store: AliasStore = {
        aliases: [
          makeAlias('complex', 'search "my query" --verbose -n 10'),
          makeAlias('with-hash', 'run -q "count #tags"'),
        ],
      };

      saveAliasStore(store);
      const loaded = loadAliasStore();

      expect(loaded.aliases[0].command).toBe('search "my query" --verbose -n 10');
      expect(loaded.aliases[1].command).toBe('run -q "count #tags"');
    });

    it('handles empty alias list', () => {
      const store: AliasStore = { aliases: [] };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases).toEqual([]);
    });

    it('preserves timestamps', () => {
      const created = '2026-03-01T10:00:00.000Z';
      const updated = '2026-03-07T15:00:00.000Z';
      const store: AliasStore = {
        aliases: [{
          name: 'test',
          command: 'doctor',
          createdAt: created,
          updatedAt: updated,
        }],
      };

      saveAliasStore(store);
      const loaded = loadAliasStore();

      expect(loaded.aliases[0].createdAt).toBe(created);
      expect(loaded.aliases[0].updatedAt).toBe(updated);
    });

    it('creates config directory if missing', () => {
      const nestedDir = join(testDir, 'nested', 'dir');
      process.env.VED_CONFIG_DIR = nestedDir;

      const store: AliasStore = {
        aliases: [makeAlias('test', 'doctor')],
      };

      saveAliasStore(store);
      expect(existsSync(join(nestedDir, 'aliases.yaml'))).toBe(true);
    });

    it('handles corrupted file gracefully', () => {
      writeFileSync(join(testDir, 'aliases.yaml'), 'this is not valid yaml: [[[');
      const store = loadAliasStore();
      expect(store.aliases).toEqual([]);
    });
  });

  // ── resolveAlias ───────────────────────────────────────────────────

  describe('resolveAlias', () => {
    it('returns alias when found', () => {
      const store: AliasStore = {
        aliases: [
          makeAlias('ss', 'search --fts-only'),
          makeAlias('daily', 'memory daily'),
        ],
      };
      saveAliasStore(store);

      const result = resolveAlias('ss');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('ss');
      expect(result!.command).toBe('search --fts-only');
    });

    it('returns null for unknown alias', () => {
      const store: AliasStore = {
        aliases: [makeAlias('ss', 'search --fts-only')],
      };
      saveAliasStore(store);

      expect(resolveAlias('nonexistent')).toBeNull();
    });

    it('returns null when no aliases file exists', () => {
      expect(resolveAlias('anything')).toBeNull();
    });
  });

  // ── YAML serialization edge cases ─────────────────────────────────

  describe('YAML serialization', () => {
    it('quotes values with colons', () => {
      const store: AliasStore = {
        aliases: [makeAlias('timed', 'run -q "time: now"')],
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases[0].command).toBe('run -q "time: now"');
    });

    it('quotes values with hash characters', () => {
      const store: AliasStore = {
        aliases: [makeAlias('tagged', 'search "#important"')],
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases[0].command).toBe('search "#important"');
    });

    it('handles description with special characters', () => {
      const store: AliasStore = {
        aliases: [makeAlias('test', 'doctor', 'Check health: all systems & more!')],
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases[0].description).toBe('Check health: all systems & more!');
    });

    it('handles many aliases', () => {
      const store: AliasStore = {
        aliases: Array.from({ length: 50 }, (_, i) =>
          makeAlias(`alias${i}`, `command${i}`, `Description for alias ${i}`)
        ),
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases).toHaveLength(50);
      expect(loaded.aliases[49].name).toBe('alias49');
      expect(loaded.aliases[49].command).toBe('command49');
    });
  });

  // ── Reserved name completeness ────────────────────────────────────

  describe('reserved names', () => {
    const criticalReserved = [
      'init', 'start', 'run', 'pipe', 'serve', 'search', 'memory',
      'trust', 'config', 'doctor', 'backup', 'cron', 'alias',
    ];

    for (const name of criticalReserved) {
      it(`blocks reserved name: ${name}`, () => {
        const err = validateAliasName(name);
        expect(err).toContain('reserved');
      });
    }
  });

  // ── Store mutation patterns ───────────────────────────────────────

  describe('store mutations', () => {
    it('add → remove → verify empty', () => {
      const store: AliasStore = {
        aliases: [makeAlias('test', 'doctor')],
      };
      saveAliasStore(store);

      const loaded = loadAliasStore();
      expect(loaded.aliases).toHaveLength(1);

      loaded.aliases = loaded.aliases.filter(a => a.name !== 'test');
      saveAliasStore(loaded);

      const final = loadAliasStore();
      expect(final.aliases).toHaveLength(0);
    });

    it('add → edit → verify updated', () => {
      const store: AliasStore = {
        aliases: [makeAlias('test', 'doctor')],
      };
      saveAliasStore(store);

      const loaded = loadAliasStore();
      loaded.aliases[0].command = 'stats';
      loaded.aliases[0].updatedAt = new Date().toISOString();
      saveAliasStore(loaded);

      const final = loadAliasStore();
      expect(final.aliases[0].command).toBe('stats');
    });

    it('add multiple → remove one → verify others intact', () => {
      const store: AliasStore = {
        aliases: [
          makeAlias('a1', 'doctor'),
          makeAlias('a2', 'stats'),
          makeAlias('a3', 'status'),
        ],
      };
      saveAliasStore(store);

      const loaded = loadAliasStore();
      loaded.aliases = loaded.aliases.filter(a => a.name !== 'a2');
      saveAliasStore(loaded);

      const final = loadAliasStore();
      expect(final.aliases).toHaveLength(2);
      expect(final.aliases.map(a => a.name)).toEqual(['a1', 'a3']);
      expect(final.aliases[0].command).toBe('doctor');
      expect(final.aliases[1].command).toBe('status');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('alias name with max length (64 chars) round-trips', () => {
      const name = 'a' + 'b'.repeat(63);
      const store: AliasStore = {
        aliases: [makeAlias(name, 'doctor')],
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases[0].name).toBe(name);
    });

    it('single character alias name works', () => {
      expect(validateAliasName('x')).toBeNull();
      const store: AliasStore = {
        aliases: [makeAlias('x', 'status')],
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases[0].name).toBe('x');
    });

    it('alias with very long command round-trips', () => {
      const longCmd = 'search ' + 'a'.repeat(1000) + ' --verbose -n 50';
      const store: AliasStore = {
        aliases: [makeAlias('longcmd', longCmd)],
      };
      saveAliasStore(store);
      const loaded = loadAliasStore();
      expect(loaded.aliases[0].command).toBe(longCmd);
    });

    it('multiple saves are idempotent', () => {
      const store: AliasStore = {
        aliases: [makeAlias('test', 'doctor', 'A description')],
      };
      saveAliasStore(store);
      const content1 = readFileSync(join(testDir, 'aliases.yaml'), 'utf-8');

      saveAliasStore(store);
      const content2 = readFileSync(join(testDir, 'aliases.yaml'), 'utf-8');

      expect(content1).toBe(content2);
    });
  });
});
