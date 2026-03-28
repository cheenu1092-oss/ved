/**
 * Tests for VedApp.doctorFix() — auto-repair functionality for ved doctor --fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock getConfigDir so config path checks use our temp directory
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ved-doctorfix-cfg-'));

vi.mock('./core/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./core/config.js')>();
  return {
    ...orig,
    getConfigDir: () => TEST_CONFIG_DIR,
  };
});

import { VedApp } from './app.js';
import { getDefaults } from './core/config.js';
import type { VedConfig } from './types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(vaultPath: string, dbPath: string): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    dbPath,
    memory: {
      ...defaults.memory,
      vaultPath,
      gitEnabled: false,         // disable git to avoid needing actual git
      compressionThreshold: 999_999,
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['owner1'],
    },
  } as VedConfig;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let tmpBase: string;
let vaultDir: string;
let app: VedApp;

const origLog = console.log;
const origError = console.error;

beforeEach(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ved-doctorfix-'));
  vaultDir = join(tmpBase, 'vault');

  // Silence console during tests
  console.log = () => {};
  console.error = () => {};

  const dbPath = join(tmpBase, 'test.db');
  const config = makeConfig(vaultDir, dbPath);
  app = new VedApp(config);
  await app.init();
  // After init, vault dirs are created by VaultManager.init()
});

afterEach(async () => {
  console.log = origLog;
  console.error = origError;
  await app.stop();
  rmSync(tmpBase, { recursive: true, force: true });
  // Clean up config dir between tests
  if (existsSync(TEST_CONFIG_DIR)) {
    const { readdirSync, unlinkSync } = await import('node:fs');
    try {
      for (const f of readdirSync(TEST_CONFIG_DIR)) {
        unlinkSync(join(TEST_CONFIG_DIR, f));
      }
    } catch { /* ignore */ }
  }
});

// ── doctorFix() ───────────────────────────────────────────────────────────────

describe('VedApp.doctorFix()', () => {
  it('returns { fixed, manual } shape', async () => {
    const result = await app.doctorFix();
    expect(result).toHaveProperty('fixed');
    expect(result).toHaveProperty('manual');
    expect(Array.isArray(result.fixed)).toBe(true);
    expect(Array.isArray(result.manual)).toBe(true);
  });

  it('recreates vault subdirectories that were deleted', async () => {
    // Vault exists after init() — delete some subdirs to simulate partial corruption
    rmSync(join(vaultDir, 'daily'), { recursive: true, force: true });
    rmSync(join(vaultDir, 'entities'), { recursive: true, force: true });
    expect(existsSync(join(vaultDir, 'daily'))).toBe(false);
    expect(existsSync(join(vaultDir, 'entities'))).toBe(false);

    const result = await app.doctorFix();

    expect(existsSync(join(vaultDir, 'daily'))).toBe(true);
    expect(existsSync(join(vaultDir, 'entities'))).toBe(true);
    expect(result.fixed.some(m => m.includes('daily'))).toBe(true);
  });

  it('does not add to fixed list when all vault dirs already exist', async () => {
    // After init(), all vault dirs exist — nothing should be fixed
    const result = await app.doctorFix();
    // No vault creation messages in fixed list
    const vaultCreationMsgs = result.fixed.filter(m =>
      m.includes('Created vault directory') || m.includes('Created vault subdirectory')
    );
    expect(vaultCreationMsgs.length).toBe(0);
  });

  it('reports missing config file in manual list when config.yaml is absent', async () => {
    // TEST_CONFIG_DIR/config.yaml does not exist (we mocked getConfigDir)
    expect(existsSync(join(TEST_CONFIG_DIR, 'config.yaml'))).toBe(false);

    const result = await app.doctorFix();
    expect(result.manual.some(m => m.includes('ved init'))).toBe(true);
  });

  it('does not report config missing when config.yaml exists', async () => {
    // Create a fake config.yaml in the mocked config dir
    writeFileSync(join(TEST_CONFIG_DIR, 'config.yaml'), 'name: ved\n');

    const result = await app.doctorFix();
    // config.yaml now exists, should not be in manual
    const configManual = result.manual.filter(m => m.includes('ved init'));
    expect(configManual.length).toBe(0);
  });

  it('is idempotent — running twice does not throw', async () => {
    await app.doctorFix();
    const result2 = await app.doctorFix();
    expect(result2).toHaveProperty('fixed');
    expect(result2).toHaveProperty('manual');
  });

  it('reports fixed messages as strings', async () => {
    rmSync(join(vaultDir, 'daily'), { recursive: true, force: true });
    const result = await app.doctorFix();
    for (const msg of result.fixed) {
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('reports manual messages as strings', async () => {
    const result = await app.doctorFix();
    for (const msg of result.manual) {
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('WAL checkpoint completes without error', async () => {
    const result = await app.doctorFix();
    // WAL checkpoint should succeed (db exists)
    const walFixed = result.fixed.some(m => m.includes('WAL checkpoint'));
    const walManual = result.manual.some(m => m.includes('WAL checkpoint'));
    // Either fixed (success) or manual (failure) — but not both
    expect(walFixed || walManual).toBe(true);
    expect(walFixed && walManual).toBe(false);
  });

  it('creates config.local.yaml template when missing', async () => {
    const localConfigPath = join(TEST_CONFIG_DIR, 'config.local.yaml');
    expect(existsSync(localConfigPath)).toBe(false);

    const result = await app.doctorFix();

    expect(existsSync(localConfigPath)).toBe(true);
    expect(result.fixed.some(m => m.includes('config.local.yaml'))).toBe(true);
  });

  it('does not re-create config.local.yaml when it already exists', async () => {
    const localConfigPath = join(TEST_CONFIG_DIR, 'config.local.yaml');
    writeFileSync(localConfigPath, '# existing\n');

    const result = await app.doctorFix();

    const msgs = result.fixed.filter(m => m.includes('config.local.yaml'));
    expect(msgs.length).toBe(0);
  });

  it('config.local.yaml template contains comment about api key', async () => {
    const localConfigPath = join(TEST_CONFIG_DIR, 'config.local.yaml');

    await app.doctorFix();

    if (existsSync(localConfigPath)) {
      const content = readFileSync(localConfigPath, 'utf8');
      expect(content).toContain('apiKey');
    }
  });

  it('audit chain check: intact chain produces no manual entry about chain', async () => {
    const result = await app.doctorFix();
    const chainManual = result.manual.filter(m => m.includes('Audit chain broken'));
    expect(chainManual.length).toBe(0);
  });

  it('fixed list contains only strings', async () => {
    const result = await app.doctorFix();
    for (const m of result.fixed) {
      expect(typeof m).toBe('string');
      expect(m.length).toBeGreaterThan(0);
    }
  });

  it('manual list contains only strings', async () => {
    const result = await app.doctorFix();
    for (const m of result.manual) {
      expect(typeof m).toBe('string');
      expect(m.length).toBeGreaterThan(0);
    }
  });
});
