/**
 * Tests for completions-installer.ts — shell completion auto-installer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installCompletions, detectShell, COMPLETIONS_MARKER } from './completions-installer.js';

const MOCK_SCRIPT = '# mock completion script\ncomplete -W "init help" ved';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpHome(): string {
  const dir = join(tmpdir(), `ved-completions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── detectShell ───────────────────────────────────────────────────────────────

describe('detectShell()', () => {
  const origShell = process.env.SHELL;

  afterEach(() => {
    if (origShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = origShell;
    }
  });

  it('detects bash', () => {
    process.env.SHELL = '/bin/bash';
    expect(detectShell()).toBe('bash');
  });

  it('detects zsh', () => {
    process.env.SHELL = '/usr/bin/zsh';
    expect(detectShell()).toBe('zsh');
  });

  it('detects fish', () => {
    process.env.SHELL = '/usr/local/bin/fish';
    expect(detectShell()).toBe('fish');
  });

  it('returns null for unsupported shell', () => {
    process.env.SHELL = '/bin/sh';
    expect(detectShell()).toBeNull();
  });

  it('returns null when SHELL is empty', () => {
    process.env.SHELL = '';
    expect(detectShell()).toBeNull();
  });

  it('returns null when SHELL is unset', () => {
    delete process.env.SHELL;
    expect(detectShell()).toBeNull();
  });
});

// ── installCompletions — bash ─────────────────────────────────────────────────

describe('installCompletions() — bash', () => {
  let home: string;

  beforeEach(() => { home = makeTmpHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('appends completions to .bashrc', () => {
    const result = installCompletions('bash', MOCK_SCRIPT, home);
    const rcPath = join(home, '.bashrc');
    expect(existsSync(rcPath)).toBe(true);
    const content = readFileSync(rcPath, 'utf8');
    expect(content).toContain(COMPLETIONS_MARKER);
    expect(content).toContain(MOCK_SCRIPT);
    expect(result.filesWritten).toContain(rcPath);
    expect(result.skipped).toBe(false);
  });

  it('is idempotent — skips if already installed', () => {
    installCompletions('bash', MOCK_SCRIPT, home);
    const result2 = installCompletions('bash', MOCK_SCRIPT, home);
    expect(result2.skipped).toBe(true);

    // Content should appear only once
    const content = readFileSync(join(home, '.bashrc'), 'utf8');
    const count = (content.match(new RegExp(COMPLETIONS_MARKER, 'g')) ?? []).length;
    expect(count).toBe(1);
  });

  it('returns a message about bash completions', () => {
    const result = installCompletions('bash', MOCK_SCRIPT, home);
    expect(result.messages.some(m => m.includes('.bashrc'))).toBe(true);
    expect(result.messages.some(m => m.includes('source'))).toBe(true);
  });

  it('preserves existing .bashrc content', () => {
    const rcPath = join(home, '.bashrc');
    writeFileSync(rcPath, '# existing content\nexport FOO=bar\n');
    installCompletions('bash', MOCK_SCRIPT, home);
    const content = readFileSync(rcPath, 'utf8');
    expect(content).toContain('existing content');
    expect(content).toContain('export FOO=bar');
    expect(content).toContain(MOCK_SCRIPT);
  });
});

// ── installCompletions — zsh ──────────────────────────────────────────────────

describe('installCompletions() — zsh', () => {
  let home: string;

  beforeEach(() => { home = makeTmpHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('writes _ved to ~/.zfunc/', () => {
    const result = installCompletions('zsh', MOCK_SCRIPT, home);
    const compFile = join(home, '.zfunc', '_ved');
    expect(existsSync(compFile)).toBe(true);
    const content = readFileSync(compFile, 'utf8');
    expect(content).toContain(MOCK_SCRIPT);
    expect(result.filesWritten).toContain(compFile);
  });

  it('adds fpath entry to ~/.zshrc', () => {
    const result = installCompletions('zsh', MOCK_SCRIPT, home);
    const zshrcPath = join(home, '.zshrc');
    expect(existsSync(zshrcPath)).toBe(true);
    const content = readFileSync(zshrcPath, 'utf8');
    expect(content).toContain('fpath=(~/.zfunc $fpath)');
    expect(content).toContain(COMPLETIONS_MARKER);
    expect(result.filesWritten).toContain(zshrcPath);
  });

  it('is idempotent — does not add fpath twice', () => {
    installCompletions('zsh', MOCK_SCRIPT, home);
    const result2 = installCompletions('zsh', MOCK_SCRIPT, home);

    const content = readFileSync(join(home, '.zshrc'), 'utf8');
    const count = (content.match(new RegExp(COMPLETIONS_MARKER, 'g')) ?? []).length;
    expect(count).toBe(1);
    // Second result should mention "already has"
    expect(result2.messages.some(m => m.includes('already'))).toBe(true);
  });

  it('returns messages about what was done', () => {
    const result = installCompletions('zsh', MOCK_SCRIPT, home);
    expect(result.messages.some(m => m.includes('_ved'))).toBe(true);
    expect(result.messages.some(m => m.includes('exec zsh'))).toBe(true);
  });
});

// ── installCompletions — fish ─────────────────────────────────────────────────

describe('installCompletions() — fish', () => {
  let home: string;

  beforeEach(() => { home = makeTmpHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('writes ved.fish to ~/.config/fish/completions/', () => {
    const result = installCompletions('fish', MOCK_SCRIPT, home);
    const compFile = join(home, '.config', 'fish', 'completions', 'ved.fish');
    expect(existsSync(compFile)).toBe(true);
    const content = readFileSync(compFile, 'utf8');
    expect(content).toContain(COMPLETIONS_MARKER);
    expect(content).toContain(MOCK_SCRIPT);
    expect(result.filesWritten).toContain(compFile);
  });

  it('is idempotent — skips if already installed', () => {
    installCompletions('fish', MOCK_SCRIPT, home);
    const result2 = installCompletions('fish', MOCK_SCRIPT, home);
    expect(result2.skipped).toBe(true);

    const compFile = join(home, '.config', 'fish', 'completions', 'ved.fish');
    const content = readFileSync(compFile, 'utf8');
    const count = (content.match(new RegExp(COMPLETIONS_MARKER, 'g')) ?? []).length;
    expect(count).toBe(1);
  });

  it('returns messages about what was done', () => {
    const result = installCompletions('fish', MOCK_SCRIPT, home);
    expect(result.messages.some(m => m.includes('ved.fish'))).toBe(true);
  });

  it('creates fish completions directory if it does not exist', () => {
    const fishDir = join(home, '.config', 'fish', 'completions');
    expect(existsSync(fishDir)).toBe(false);
    installCompletions('fish', MOCK_SCRIPT, home);
    expect(existsSync(fishDir)).toBe(true);
  });
});

// ── InstallResult shape ───────────────────────────────────────────────────────

describe('InstallResult structure', () => {
  let home: string;

  beforeEach(() => { home = makeTmpHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it.each(['bash', 'zsh', 'fish'] as const)('%s result has shell field', (shell) => {
    const result = installCompletions(shell, MOCK_SCRIPT, home);
    expect(result.shell).toBe(shell);
  });

  it.each(['bash', 'zsh', 'fish'] as const)('%s result has non-empty messages', (shell) => {
    const result = installCompletions(shell, MOCK_SCRIPT, home);
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
