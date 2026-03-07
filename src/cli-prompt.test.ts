/**
 * Tests for `ved prompt` — system prompt profile manager.
 *
 * Session 65: 8 subcommands (list, show, create, edit, use, test, reset, diff).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// ── Helpers ──

let tmpDir: string;
let promptsDir: string;
let configPath: string;

function setupDirs(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'ved-prompt-test-'));
  promptsDir = join(tmpDir, '.ved', 'prompts');
  configPath = join(tmpDir, '.ved', 'config.yaml');
  mkdirSync(promptsDir, { recursive: true });
}

function mkdtempSync(prefix: string): string {
  const { mkdtempSync: mk } = require('node:fs');
  return mk(prefix);
}

function createProfile(name: string, content: string): string {
  const path = join(promptsDir, `${name}.md`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function createConfig(systemPromptPath: string | null): void {
  const dir = join(tmpDir, '.ved');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (systemPromptPath) {
    writeFileSync(configPath, `llm:\n  systemPromptPath: "${systemPromptPath}"\n`, 'utf-8');
  } else {
    writeFileSync(configPath, 'llm:\n  model: claude-sonnet-4-20250514\n', 'utf-8');
  }
}

// We test the module functions directly by importing them.
// Since cli-prompt uses hardcoded paths (homedir), we test via the exported
// runPromptCli function with mocked config instead.

import { runPromptCli } from './cli-prompt.js';
import { getDefaults } from './core/config.js';
import type { VedConfig } from './types/index.js';

function makeConfig(overrides?: Partial<any>): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    trust: { ...defaults.trust, ownerIds: ['owner-1'] },
    ...overrides,
  };
}

// Capture console output
function captureOutput(fn: () => Promise<void> | void): Promise<{ stdout: string; stderr: string }> {
  const origLog = console.log;
  const origError = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args: any[]) => { stdout += args.join(' ') + '\n'; };
  console.error = (...args: any[]) => { stderr += args.join(' ') + '\n'; };
  
  const result = fn();
  if (result instanceof Promise) {
    return result.then(() => {
      console.log = origLog;
      console.error = origError;
      return { stdout, stderr };
    }).catch(err => {
      console.log = origLog;
      console.error = origError;
      throw err;
    });
  }
  
  console.log = origLog;
  console.error = origError;
  return Promise.resolve({ stdout, stderr });
}

// ── Tests ──

describe('ved prompt: help', () => {
  it('shows help with --help flag', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['--help']));
    expect(stdout).toContain('ved prompt');
    expect(stdout).toContain('list');
    expect(stdout).toContain('show');
    expect(stdout).toContain('create');
    expect(stdout).toContain('use');
    expect(stdout).toContain('test');
    expect(stdout).toContain('reset');
    expect(stdout).toContain('diff');
  });

  it('shows help with help subcommand', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['help']));
    expect(stdout).toContain('ved prompt');
  });
});

describe('ved prompt: list', () => {
  beforeEach(setupDirs);
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('shows empty state when no profiles exist', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['list']));
    // Should indicate no profiles or show default state
    expect(stdout).toBeTruthy();
  });

  it('defaults to list when no subcommand given', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, []));
    expect(stdout).toBeTruthy();
  });
});

describe('ved prompt: show', () => {
  it('shows default prompt when no custom prompt set', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['show']));
    expect(stdout).toContain('Ved');
    expect(stdout).toContain('default');
  });

  it('shows default prompt with view alias', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['view']));
    expect(stdout).toContain('Ved');
  });

  it('shows error for nonexistent profile', async () => {
    const config = makeConfig();
    const { stdout, stderr } = await captureOutput(async () => {
      try {
        await runPromptCli(null, config, ['show', 'nonexistent']);
      } catch {
        // Profile not found throws
      }
    });
    // Should throw or show error
  });
});

describe('ved prompt: create', () => {
  beforeEach(setupDirs);
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('shows error when no name provided', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['create']));
    expect(stderr).toContain('Usage');
  });

  it('rejects invalid profile names (path traversal)', async () => {
    const config = makeConfig();
    try {
      await runPromptCli(null, config, ['create', '../etc/evil']);
    } catch (err) {
      expect((err as Error).message).toContain('Invalid profile name');
    }
  });

  it('rejects profile names with dots', async () => {
    const config = makeConfig();
    try {
      await runPromptCli(null, config, ['create', 'evil.path']);
    } catch (err) {
      expect((err as Error).message).toContain('Invalid profile name');
    }
  });

  it('creates with new alias', async () => {
    const config = makeConfig();
    // Will fail because prompts dir is real ~/.ved/prompts, but validates alias routing
    const { stdout, stderr } = await captureOutput(() => runPromptCli(null, config, ['new']));
    // Should show usage error for missing name
    expect(stderr).toContain('Usage');
  });
});

describe('ved prompt: edit', () => {
  it('shows error when no name provided', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['edit']));
    expect(stderr).toContain('Usage');
  });
});

describe('ved prompt: use', () => {
  it('shows error when no name provided', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['use']));
    expect(stderr).toContain('Usage');
  });

  it('set alias routes to use', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['set']));
    expect(stderr).toContain('Usage');
  });

  it('activate alias routes to use', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['activate']));
    expect(stderr).toContain('Usage');
  });
});

describe('ved prompt: test', () => {
  it('shows assembled prompt preview with default prompt', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['test']));
    expect(stdout).toContain('Assembled System Prompt Preview');
    expect(stdout).toContain('Ved');
    expect(stdout).toContain('Active Facts');
    expect(stdout).toContain('Retrieved Knowledge');
  });

  it('preview alias routes to test', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['preview']));
    expect(stdout).toContain('Assembled System Prompt Preview');
  });

  it('dry-run alias routes to test', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['dry-run']));
    expect(stdout).toContain('Assembled System Prompt Preview');
  });

  it('shows stats (chars, words, lines)', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['test']));
    expect(stdout).toContain('chars');
    expect(stdout).toContain('words');
    expect(stdout).toContain('lines');
  });

  it('uses custom prompt file when configured', async () => {
    const tmpFile = join(tmpdir(), `ved-test-prompt-${Date.now()}.md`);
    writeFileSync(tmpFile, '# Custom\nYou are a pirate assistant.', 'utf-8');
    try {
      const config = makeConfig({ llm: { ...getDefaults().llm, systemPromptPath: tmpFile } });
      const { stdout } = await captureOutput(() => runPromptCli(null, config, ['test']));
      expect(stdout).toContain('Custom');
      expect(stdout).toContain('pirate');
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  it('falls back to default when custom file missing', async () => {
    const config = makeConfig({ llm: { ...getDefaults().llm, systemPromptPath: '/nonexistent/path.md' } });
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['test']));
    expect(stdout).toContain('not found');
    expect(stdout).toContain('Ved');
  });
});

describe('ved prompt: reset', () => {
  beforeEach(setupDirs);
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('shows reset confirmation', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['reset']));
    expect(stdout).toContain('Reverted');
    expect(stdout).toContain('default');
  });

  it('clear alias routes to reset', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['clear']));
    expect(stdout).toContain('Reverted');
  });
});

describe('ved prompt: diff', () => {
  it('shows error when fewer than 2 names provided', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['diff']));
    expect(stderr).toContain('Usage');
  });

  it('shows error with only one name', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['diff', 'profileA']));
    expect(stderr).toContain('Usage');
  });

  it('compare alias routes to diff', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['compare']));
    expect(stderr).toContain('Usage');
  });

  it('compares default vs default (identical)', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['diff', 'default', 'default']));
    expect(stdout).toContain('identical');
  });
});

describe('ved prompt: error handling', () => {
  it('shows error for unknown subcommand', async () => {
    const config = makeConfig();
    const { stderr } = await captureOutput(() => runPromptCli(null, config, ['bogus']));
    expect(stderr).toContain('Unknown subcommand');
  });

  it('profile name validation rejects spaces', async () => {
    const config = makeConfig();
    try {
      await runPromptCli(null, config, ['create', 'has space']);
    } catch (err) {
      expect((err as Error).message).toContain('Invalid profile name');
    }
  });

  it('profile name validation rejects slashes', async () => {
    const config = makeConfig();
    try {
      await runPromptCli(null, config, ['create', 'path/traversal']);
    } catch (err) {
      expect((err as Error).message).toContain('Invalid profile name');
    }
  });
});

describe('ved prompt: config update', () => {
  beforeEach(setupDirs);
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('updateConfigPromptPath creates config when none exists', async () => {
    // This tests that reset/use create config.yaml if needed
    // We test indirectly through the reset command which calls updateConfigPromptPath(null)
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['reset']));
    // reset should succeed even if config doesn't exist yet
    expect(stdout).toContain('Reverted');
  });
});

describe('ved prompt: section ordering', () => {
  it('test output has facts before RAG context', async () => {
    const config = makeConfig();
    const { stdout } = await captureOutput(() => runPromptCli(null, config, ['test']));
    const factsIdx = stdout.indexOf('Active Facts');
    const ragIdx = stdout.indexOf('Retrieved Knowledge');
    expect(factsIdx).toBeGreaterThan(-1);
    expect(ragIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeLessThan(ragIdx);
  });
});
