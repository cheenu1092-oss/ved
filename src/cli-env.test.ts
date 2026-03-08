/**
 * Tests for ved env — environment manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock getConfigDir to use temp directory
const TEST_DIR = join(tmpdir(), `ved-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('./core/config.js', () => ({
  getConfigDir: () => TEST_DIR,
}));

import {
  validateEnvName,
  getActiveEnv,
  setActiveEnv,
  clearActiveEnv,
  listEnvs,
  readEnvConfig,
  writeEnvConfig,
  envExists,
  deleteEnv,
  getActiveEnvConfigPath,
  vedEnv,
} from './cli-env.js';

// ── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(join(TEST_DIR, 'environments'), { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ── validateEnvName ─────────────────────────────────────────────────────

describe('validateEnvName', () => {
  it('accepts valid names', () => {
    expect(validateEnvName('dev').valid).toBe(true);
    expect(validateEnvName('prod').valid).toBe(true);
    expect(validateEnvName('my-env').valid).toBe(true);
    expect(validateEnvName('test_2').valid).toBe(true);
    expect(validateEnvName('A123').valid).toBe(true);
  });

  it('rejects empty names', () => {
    expect(validateEnvName('').valid).toBe(false);
    expect(validateEnvName('  ').valid).toBe(false);
  });

  it('rejects names starting with non-letter', () => {
    expect(validateEnvName('123abc').valid).toBe(false);
    expect(validateEnvName('-dash').valid).toBe(false);
    expect(validateEnvName('_under').valid).toBe(false);
  });

  it('rejects names with special chars', () => {
    expect(validateEnvName('my env').valid).toBe(false);
    expect(validateEnvName('my.env').valid).toBe(false);
    expect(validateEnvName('my/env').valid).toBe(false);
    expect(validateEnvName('my@env').valid).toBe(false);
  });

  it('rejects reserved names', () => {
    expect(validateEnvName('default').valid).toBe(false);
    expect(validateEnvName('config').valid).toBe(false);
    expect(validateEnvName('local').valid).toBe(false);
    expect(validateEnvName('none').valid).toBe(false);
    expect(validateEnvName('reset').valid).toBe(false);
    expect(validateEnvName('list').valid).toBe(false);
  });

  it('reserved names are case-insensitive', () => {
    expect(validateEnvName('Default').valid).toBe(false);
    expect(validateEnvName('CONFIG').valid).toBe(false);
    expect(validateEnvName('None').valid).toBe(false);
  });

  it('rejects names longer than 64 chars', () => {
    const longName = 'a'.repeat(65);
    expect(validateEnvName(longName).valid).toBe(false);
    expect(validateEnvName('a'.repeat(64)).valid).toBe(true);
  });
});

// ── Active environment ──────────────────────────────────────────────────

describe('active environment', () => {
  it('returns null when no active env', () => {
    expect(getActiveEnv()).toBeNull();
  });

  it('sets and gets active env', () => {
    writeEnvConfig('staging', 'logLevel: info\n');
    setActiveEnv('staging');
    expect(getActiveEnv()).toBe('staging');
  });

  it('returns null if active env file missing', () => {
    setActiveEnv('nonexistent');
    expect(getActiveEnv()).toBeNull();
  });

  it('clears active env', () => {
    writeEnvConfig('dev', 'logLevel: debug\n');
    setActiveEnv('dev');
    expect(getActiveEnv()).toBe('dev');
    clearActiveEnv();
    expect(getActiveEnv()).toBeNull();
  });

  it('clearActiveEnv is idempotent', () => {
    clearActiveEnv();
    clearActiveEnv(); // should not throw
    expect(getActiveEnv()).toBeNull();
  });
});

// ── Environment CRUD ────────────────────────────────────────────────────

describe('environment CRUD', () => {
  it('creates and reads environment', () => {
    writeEnvConfig('dev', 'logLevel: debug\nllm:\n  provider: ollama\n');
    expect(envExists('dev')).toBe(true);
    const content = readEnvConfig('dev');
    expect(content).toContain('logLevel: debug');
    expect(content).toContain('provider: ollama');
  });

  it('overwrites existing environment', () => {
    writeEnvConfig('dev', 'logLevel: debug\n');
    writeEnvConfig('dev', 'logLevel: info\n');
    expect(readEnvConfig('dev')).toBe('logLevel: info\n');
  });

  it('throws reading nonexistent environment', () => {
    expect(() => readEnvConfig('nope')).toThrow('does not exist');
  });

  it('envExists returns false for nonexistent', () => {
    expect(envExists('nope')).toBe(false);
  });

  it('deletes environment', () => {
    writeEnvConfig('temp', 'logLevel: warn\n');
    expect(envExists('temp')).toBe(true);
    deleteEnv('temp');
    expect(envExists('temp')).toBe(false);
  });

  it('deleting active env clears active', () => {
    writeEnvConfig('staging', 'logLevel: info\n');
    setActiveEnv('staging');
    expect(getActiveEnv()).toBe('staging');
    deleteEnv('staging');
    expect(getActiveEnv()).toBeNull();
  });

  it('throws deleting nonexistent', () => {
    expect(() => deleteEnv('nope')).toThrow('does not exist');
  });
});

// ── listEnvs ────────────────────────────────────────────────────────────

describe('listEnvs', () => {
  it('returns empty array when no envs', () => {
    expect(listEnvs()).toEqual([]);
  });

  it('lists environments with metadata', () => {
    writeEnvConfig('dev', 'logLevel: debug\n');
    writeEnvConfig('prod', 'logLevel: warn\n');
    const envs = listEnvs();
    expect(envs).toHaveLength(2);
    expect(envs[0].name).toBe('dev');
    expect(envs[1].name).toBe('prod');
    expect(envs[0].size).toBeGreaterThan(0);
    expect(envs[0].modifiedAt).toBeTruthy();
    expect(envs[0].active).toBe(false);
  });

  it('marks active environment', () => {
    writeEnvConfig('dev', 'a\n');
    writeEnvConfig('prod', 'b\n');
    setActiveEnv('dev');
    const envs = listEnvs();
    expect(envs.find(e => e.name === 'dev')?.active).toBe(true);
    expect(envs.find(e => e.name === 'prod')?.active).toBe(false);
  });

  it('sorted alphabetically', () => {
    writeEnvConfig('zeta', 'a\n');
    writeEnvConfig('alpha', 'b\n');
    writeEnvConfig('mid', 'c\n');
    const names = listEnvs().map(e => e.name);
    expect(names).toEqual(['alpha', 'mid', 'zeta']);
  });
});

// ── getActiveEnvConfigPath ──────────────────────────────────────────────

describe('getActiveEnvConfigPath', () => {
  it('returns null when no active env', () => {
    expect(getActiveEnvConfigPath()).toBeNull();
  });

  it('returns path when active env exists', () => {
    writeEnvConfig('dev', 'logLevel: debug\n');
    setActiveEnv('dev');
    const p = getActiveEnvConfigPath();
    expect(p).not.toBeNull();
    expect(p!).toContain('dev.yaml');
  });

  it('returns null when active env file deleted', () => {
    writeEnvConfig('dev', 'logLevel: debug\n');
    setActiveEnv('dev');
    deleteEnv('dev');
    expect(getActiveEnvConfigPath()).toBeNull();
  });
});

// ── CLI subcommands (via vedEnv) ────────────────────────────────────────

describe('vedEnv CLI', () => {
  let output: string[];
  let errorOutput: string[];

  beforeEach(() => {
    output = [];
    errorOutput = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('current shows no active env', async () => {
    await vedEnv(['current']);
    expect(output.join('\n')).toContain('No active environment');
  });

  it('current shows active env', async () => {
    writeEnvConfig('staging', 'logLevel: info\n');
    setActiveEnv('staging');
    await vedEnv(['current']);
    expect(output.join('\n')).toContain('staging');
  });

  it('list shows empty state', async () => {
    await vedEnv(['list']);
    expect(output.join('\n')).toContain('No environments');
  });

  it('list shows environments', async () => {
    writeEnvConfig('dev', 'logLevel: debug\n');
    writeEnvConfig('prod', 'logLevel: warn\n');
    await vedEnv(['list']);
    const text = output.join('\n');
    expect(text).toContain('dev');
    expect(text).toContain('prod');
    expect(text).toContain('2 environment(s)');
  });

  it('show displays config', async () => {
    writeEnvConfig('dev', 'logLevel: debug\nllm:\n  model: llama3\n');
    await vedEnv(['show', 'dev']);
    const text = output.join('\n');
    expect(text).toContain('logLevel: debug');
    expect(text).toContain('model: llama3');
  });

  it('show rejects nonexistent', async () => {
    await vedEnv(['show', 'nope']);
    expect(errorOutput.join('\n')).toContain('does not exist');
  });

  it('create blank environment', async () => {
    await vedEnv(['create', 'staging']);
    expect(envExists('staging')).toBe(true);
    const content = readEnvConfig('staging');
    expect(content).toContain('# Ved environment: staging');
  });

  it('create from template', async () => {
    await vedEnv(['create', 'mydev', '--template', 'dev']);
    expect(envExists('mydev')).toBe(true);
    const content = readEnvConfig('mydev');
    expect(content).toContain('debug');
    expect(content).toContain('ollama');
  });

  it('create from existing env', async () => {
    writeEnvConfig('base', 'logLevel: info\ncustom: true\n');
    await vedEnv(['create', 'derived', '--from', 'base']);
    expect(envExists('derived')).toBe(true);
    expect(readEnvConfig('derived')).toContain('custom: true');
  });

  it('create rejects invalid name', async () => {
    await vedEnv(['create', '123bad']);
    expect(errorOutput.join('\n')).toContain('Invalid name');
    expect(envExists('123bad')).toBe(false);
  });

  it('create rejects reserved name', async () => {
    await vedEnv(['create', 'default']);
    expect(errorOutput.join('\n')).toContain('reserved');
    expect(envExists('default')).toBe(false);
  });

  it('create rejects duplicate name', async () => {
    writeEnvConfig('dev', 'a\n');
    await vedEnv(['create', 'dev']);
    expect(errorOutput.join('\n')).toContain('already exists');
  });

  it('use activates environment', async () => {
    writeEnvConfig('prod', 'logLevel: warn\n');
    await vedEnv(['use', 'prod']);
    expect(getActiveEnv()).toBe('prod');
    expect(output.join('\n')).toContain('Activated');
  });

  it('use switches environment', async () => {
    writeEnvConfig('dev', 'a\n');
    writeEnvConfig('prod', 'b\n');
    setActiveEnv('dev');
    await vedEnv(['use', 'prod']);
    expect(getActiveEnv()).toBe('prod');
    expect(output.join('\n')).toContain('Switched');
  });

  it('use rejects nonexistent', async () => {
    await vedEnv(['use', 'nope']);
    expect(errorOutput.join('\n')).toContain('does not exist');
  });

  it('delete removes environment', async () => {
    writeEnvConfig('temp', 'a\n');
    await vedEnv(['delete', 'temp']);
    expect(envExists('temp')).toBe(false);
    expect(output.join('\n')).toContain('Deleted');
  });

  it('delete clears active if deleted', async () => {
    writeEnvConfig('dev', 'a\n');
    setActiveEnv('dev');
    await vedEnv(['delete', 'dev']);
    expect(getActiveEnv()).toBeNull();
    expect(output.join('\n')).toContain('Active environment cleared');
  });

  it('reset clears active environment', async () => {
    writeEnvConfig('dev', 'a\n');
    setActiveEnv('dev');
    await vedEnv(['reset']);
    expect(getActiveEnv()).toBeNull();
    expect(output.join('\n')).toContain('Deactivated');
  });

  it('reset when no active env', async () => {
    await vedEnv(['reset']);
    expect(output.join('\n')).toContain('No active environment');
  });

  it('diff shows differences', async () => {
    writeEnvConfig('envA', 'logLevel: debug\nshared: true\n');
    writeEnvConfig('envB', 'logLevel: info\nshared: true\n');
    await vedEnv(['diff', 'envA', 'envB']);
    const text = output.join('\n');
    expect(text).toContain('--- envA');
    expect(text).toContain('+++ envB');
  });

  it('diff identical envs', async () => {
    writeEnvConfig('envA', 'same\n');
    writeEnvConfig('envB', 'same\n');
    await vedEnv(['diff', 'envA', 'envB']);
    expect(output.join('\n')).toContain('identical');
  });

  it('diff rejects nonexistent env', async () => {
    writeEnvConfig('envA', 'a\n');
    // envB doesn't exist — should error
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await vedEnv(['diff', 'envA', 'nope']);
    } catch {
      // expected
    }
    expect(errorOutput.join('\n')).toContain('does not exist');
    exitSpy.mockRestore();
  });

  it('default command is current', async () => {
    await vedEnv([]);
    expect(output.join('\n')).toContain('No active environment');
  });

  it('unknown subcommand shows help if not an env name', async () => {
    await vedEnv(['badcmd']);
    expect(output.join('\n')).toContain('Unknown subcommand');
  });

  it('passing env name directly shows it', async () => {
    writeEnvConfig('myenv', 'logLevel: debug\n');
    await vedEnv(['myenv']);
    expect(output.join('\n')).toContain('logLevel: debug');
  });

  it('create all built-in templates', async () => {
    for (const tpl of ['dev', 'prod', 'test']) {
      await vedEnv(['create', `from-${tpl}`, '--template', tpl]);
      expect(envExists(`from-${tpl}`)).toBe(true);
    }
  });

  it('create with unknown template errors', async () => {
    await vedEnv(['create', 'bad', '--template', 'unknown']);
    expect(errorOutput.join('\n')).toContain('Unknown template');
    expect(envExists('bad')).toBe(false);
  });

  it('create --from nonexistent errors', async () => {
    await vedEnv(['create', 'derived', '--from', 'nope']);
    expect(errorOutput.join('\n')).toContain('does not exist');
    expect(envExists('derived')).toBe(false);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('envs dir created automatically', () => {
    const envsDir = join(TEST_DIR, 'environments');
    if (existsSync(envsDir)) rmSync(envsDir, { recursive: true });
    writeEnvConfig('auto', 'test\n');
    expect(envExists('auto')).toBe(true);
  });

  it('handles YAML with special characters', () => {
    const content = 'name: "test: value"\npath: "/home/user/.ved"\n';
    writeEnvConfig('special', content);
    expect(readEnvConfig('special')).toBe(content);
  });

  it('concurrent writes last writer wins', () => {
    writeEnvConfig('race', 'first\n');
    writeEnvConfig('race', 'second\n');
    expect(readEnvConfig('race')).toBe('second\n');
  });

  it('active env file with whitespace/newlines', () => {
    writeEnvConfig('padded', 'test\n');
    // Write active-env with extra whitespace
    const activePath = join(TEST_DIR, 'active-env');
    writeFileSync(activePath, '  padded  \n\n', 'utf8');
    // getActiveEnv trims, should still find it
    expect(getActiveEnv()).toBe('padded');
  });
});
