/**
 * Tests for `ved snapshot` — vault point-in-time snapshots.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Test Helpers ────────────────────────────────────────────────────

function createTestVault(): string {
  const dir = join(tmpdir(), `ved-snap-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@ved.dev"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Ved Test"', { cwd: dir, stdio: 'pipe' });

  // Create initial vault structure
  for (const sub of ['daily', 'entities', 'concepts', 'decisions']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  writeFileSync(join(dir, 'README.md'), '# Test Vault\n');
  writeFileSync(join(dir, 'daily', '2026-03-08.md'), '# Daily Note\nSome events.\n');
  writeFileSync(join(dir, 'entities', 'alice.md'), '---\ntype: person\n---\n# Alice\nA test entity.\n');

  execSync('git add -A && git commit -m "Initial vault"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupVault(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function createSnapshot(dir: string, name: string, message?: string): void {
  const tag = `ved-snap/${name}`;
  const msg = message ?? `Snapshot: ${name}`;
  execSync(`git tag -a "${tag}" -m "${msg}"`, { cwd: dir, stdio: 'pipe' });
}

// ── Import the module under test ────────────────────────────────────
// We test through the exported function by mocking the config loader.
// Since snapshotCmd reads config for vault path, we'll test the git
// tag operations directly and validate the module's logic.

import { snapshotCmd } from './cli-snapshot.js';
import { checkHelp, COMMANDS } from './cli-help.js';
import { VedApp } from './app.js';

// Mock loadConfig to return our test vault
import * as configModule from './core/config.js';
import { vi } from 'vitest';

let testVault: string;

function mockConfig(vaultPath: string) {
  vi.spyOn(configModule, 'loadConfig').mockReturnValue({
    memory: { vaultPath: vaultPath },
  } as any);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ved snapshot', () => {
  beforeEach(() => {
    testVault = createTestVault();
    mockConfig(testVault);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupVault(testVault);
  });

  // ── List ──

  describe('list', () => {
    it('shows "no snapshots" when none exist', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['list']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('No snapshots'));
      spy.mockRestore();
    });

    it('lists existing snapshots', () => {
      createSnapshot(testVault, 'baseline', 'Initial state');
      createSnapshot(testVault, 'v2', 'After update');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['list']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('baseline');
      expect(output).toContain('v2');
      expect(output).toContain('2'); // count
      spy.mockRestore();
    });

    it('default subcommand is list', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd([]);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('No snapshots'));
      spy.mockRestore();
    });
  });

  // ── Create ──

  describe('create', () => {
    it('creates a snapshot with name and message', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['create', 'v1', '-m', 'First release']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('v1');
      expect(output).toContain('created');

      // Verify tag exists
      const tags = git(testVault, 'tag -l "ved-snap/*"');
      expect(tags).toContain('ved-snap/v1');
      spy.mockRestore();
    });

    it('creates snapshot with default message when -m omitted', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['create', 'quick']);

      const tagMsg = git(testVault, 'tag -l -n1 "ved-snap/quick"');
      expect(tagMsg).toContain('Snapshot: quick');
      spy.mockRestore();
    });

    it('commits uncommitted changes before snapshot', () => {
      writeFileSync(join(testVault, 'entities', 'bob.md'), '# Bob\n');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['create', 'with-bob']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Committed uncommitted');

      // Bob should be in the snapshot
      const files = git(testVault, 'ls-tree -r --name-only ved-snap/with-bob');
      expect(files).toContain('entities/bob.md');
      spy.mockRestore();
    });

    it('rejects duplicate snapshot names', () => {
      createSnapshot(testVault, 'existing');

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['create', 'existing'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('already exists'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('rejects invalid names (special chars)', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['create', 'bad/name'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Invalid'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('rejects path traversal attempts', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['create', '..escape'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Invalid'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('rejects names with spaces', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['create', 'has space'])).toThrow('exit');

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('allows hyphens and underscores in names', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['create', 'my-snap_v1']);

      const tags = git(testVault, 'tag -l "ved-snap/*"');
      expect(tags).toContain('ved-snap/my-snap_v1');
      spy.mockRestore();
    });
  });

  // ── Show ──

  describe('show', () => {
    it('shows snapshot details', () => {
      createSnapshot(testVault, 'detail-test', 'Detailed snapshot');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['show', 'detail-test']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Snapshot: detail-test');
      expect(output).toContain('Tag:');
      expect(output).toContain('Commit:');
      expect(output).toContain('markdown files');
      spy.mockRestore();
    });

    it('errors on non-existent snapshot', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['show', 'nope'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('shows drift from HEAD when changes exist', () => {
      createSnapshot(testVault, 'before-change');

      // Make changes after snapshot
      writeFileSync(join(testVault, 'concepts', 'new-idea.md'), '# New Idea\n');
      execSync('git add -A && git commit -m "Add idea"', { cwd: testVault, stdio: 'pipe' });

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['show', 'before-change']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Changes since snapshot');
      spy.mockRestore();
    });

    it('default subcommand when name matches existing snapshot', () => {
      createSnapshot(testVault, 'auto-show');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['auto-show']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Snapshot: auto-show');
      spy.mockRestore();
    });
  });

  // ── Diff ──

  describe('diff', () => {
    it('diffs snapshot against HEAD', () => {
      createSnapshot(testVault, 'snap-a');

      writeFileSync(join(testVault, 'entities', 'alice.md'), '# Alice\nUpdated content.\n');
      execSync('git add -A && git commit -m "Update alice"', { cwd: testVault, stdio: 'pipe' });

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['diff', 'snap-a']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Diff: snap-a');
      spy.mockRestore();
    });

    it('diffs two snapshots', () => {
      createSnapshot(testVault, 'first');

      writeFileSync(join(testVault, 'concepts', 'idea.md'), '# Idea\n');
      execSync('git add -A && git commit -m "Add idea"', { cwd: testVault, stdio: 'pipe' });
      createSnapshot(testVault, 'second');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['diff', 'first', 'second']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('first');
      expect(output).toContain('second');
      spy.mockRestore();
    });

    it('shows "no differences" when identical', () => {
      createSnapshot(testVault, 'same');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['diff', 'same']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('No differences');
      spy.mockRestore();
    });

    it('supports --stat flag', () => {
      createSnapshot(testVault, 'stat-test');

      writeFileSync(join(testVault, 'daily', '2026-03-09.md'), '# March 9\n');
      execSync('git add -A && git commit -m "Add daily"', { cwd: testVault, stdio: 'pipe' });

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['diff', 'stat-test', '--stat']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Changes:');
      spy.mockRestore();
    });

    it('errors on non-existent snapshot', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['diff', 'ghost'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  // ── Restore ──

  describe('restore', () => {
    it('restores vault to snapshot state', () => {
      createSnapshot(testVault, 'restore-point');

      // Make changes
      writeFileSync(join(testVault, 'entities', 'charlie.md'), '# Charlie\n');
      execSync('git add -A && git commit -m "Add charlie"', { cwd: testVault, stdio: 'pipe' });
      expect(existsSync(join(testVault, 'entities', 'charlie.md'))).toBe(true);

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['restore', 'restore-point']);

      // Charlie should be gone (not in snapshot)
      expect(existsSync(join(testVault, 'entities', 'charlie.md'))).toBe(false);
      expect(existsSync(join(testVault, 'entities', 'alice.md'))).toBe(true);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('restored');
      expect(output).toContain('To undo');
      spy.mockRestore();
    });

    it('creates safety snapshot before restore', () => {
      createSnapshot(testVault, 'safe-test');

      writeFileSync(join(testVault, 'entities', 'temp.md'), '# Temp\n');
      execSync('git add -A && git commit -m "Add temp"', { cwd: testVault, stdio: 'pipe' });

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['restore', 'safe-test']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Safety snapshot');

      // Safety tag should exist
      const tags = git(testVault, 'tag -l "ved-snap/pre-restore-*"');
      expect(tags).toContain('ved-snap/pre-restore-');
      spy.mockRestore();
    });

    it('rejects restore with uncommitted changes without --force', () => {
      createSnapshot(testVault, 'force-test');
      writeFileSync(join(testVault, 'dirty.md'), '# Dirty\n');

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['restore', 'force-test'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Uncommitted'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('allows restore with --force despite uncommitted changes', () => {
      createSnapshot(testVault, 'force-ok');
      writeFileSync(join(testVault, 'dirty.md'), '# Dirty\n');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['restore', 'force-ok', '--force']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('restored');
      spy.mockRestore();
    });
  });

  // ── Delete ──

  describe('delete', () => {
    it('deletes an existing snapshot', () => {
      createSnapshot(testVault, 'to-delete');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['delete', 'to-delete']);

      const tags = git(testVault, 'tag -l "ved-snap/to-delete"');
      expect(tags).toBe('');

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('deleted');
      spy.mockRestore();
    });

    it('errors on non-existent snapshot', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['delete', 'phantom'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('protects safety snapshots without --force', () => {
      createSnapshot(testVault, 'pre-restore-12345', 'Safety snapshot');

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['delete', 'pre-restore-12345'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('safety snapshot'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('allows deleting safety snapshots with --force', () => {
      createSnapshot(testVault, 'pre-restore-99999', 'Safety');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['delete', 'pre-restore-99999', '--force']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('deleted');
      spy.mockRestore();
    });
  });

  // ── Export ──

  describe('export', () => {
    it('exports snapshot as tar.gz', () => {
      createSnapshot(testVault, 'export-me');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['export', 'export-me']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Exported');
      expect(output).toContain('KB');

      // File should exist
      expect(existsSync(join(testVault, 'ved-snapshot-export-me.tar.gz'))).toBe(true);
      spy.mockRestore();
    });

    it('exports to custom path', () => {
      createSnapshot(testVault, 'custom-path');
      const outputFile = 'custom-export.tar.gz';

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['export', 'custom-path', outputFile]);

      expect(existsSync(join(testVault, outputFile))).toBe(true);
      spy.mockRestore();
    });

    it('errors on non-existent snapshot', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['export', 'nope'])).toThrow('exit');

      spy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  // ── Edge Cases ──

  describe('edge cases', () => {
    it('rejects names over 128 chars', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      const longName = 'a'.repeat(129);
      expect(() => snapshotCmd(['create', longName])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('128'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('rejects empty name', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => snapshotCmd(['create'])).toThrow('exit');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('required'));

      spy.mockRestore();
      exitSpy.mockRestore();
    });

    it('handles multiple snapshots over time', () => {
      createSnapshot(testVault, 'epoch-1');

      writeFileSync(join(testVault, 'concepts', 'c1.md'), '# C1\n');
      execSync('git add -A && git commit -m "Add c1"', { cwd: testVault, stdio: 'pipe' });
      createSnapshot(testVault, 'epoch-2');

      writeFileSync(join(testVault, 'concepts', 'c2.md'), '# C2\n');
      execSync('git add -A && git commit -m "Add c2"', { cwd: testVault, stdio: 'pipe' });
      createSnapshot(testVault, 'epoch-3');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      snapshotCmd(['list']);

      const output = spy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('epoch-1');
      expect(output).toContain('epoch-2');
      expect(output).toContain('epoch-3');
      expect(output).toContain('3');
      spy.mockRestore();
    });
  });

  // ── Help ──

  describe('help', () => {
    it('--help flag shows help', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = checkHelp('snapshot', ['--help']);
      expect(result).toBe(true);
      spy.mockRestore();
    });

    it('-h flag shows help', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = checkHelp('snapshot', ['-h']);
      expect(result).toBe(true);
      spy.mockRestore();
    });
  });

  // ── Shell Completions ──

  describe('completions', () => {
    it('bash completions include snapshot', () => {
      const bash = VedApp.generateCompletions('bash');
      expect(bash).toContain('snapshot');
      expect(bash).toContain('snap');
      expect(bash).toContain('checkpoint');
    });

    it('zsh completions include snapshot', () => {
      const zsh = VedApp.generateCompletions('zsh');
      expect(zsh).toContain('snapshot');
      expect(zsh).toContain('Vault snapshots');
    });

    it('fish completions include snapshot', () => {
      const fish = VedApp.generateCompletions('fish');
      expect(fish).toContain('snapshot');
      expect(fish).toContain('snap');
      expect(fish).toContain('checkpoint');
    });
  });

  // ── CLI Wiring ──

  describe('cli wiring', () => {
    it('snapshot command is wired in cli.ts', async () => {
      const cliSource = readFileSync(join(__dirname, 'cli.ts'), 'utf-8');
      expect(cliSource).toContain("case 'snapshot':");
      expect(cliSource).toContain("case 'snap':");
      expect(cliSource).toContain("case 'checkpoint':");
      expect(cliSource).toContain('snapshotCmd');
    });

    it('snapshot is in help registry', async () => {
      const snap = COMMANDS.find((c: any) => c.name === 'snapshot');
      expect(snap).toBeDefined();
      expect(snap!.category).toBe('data');
      expect(snap!.aliases).toContain('snap');
      expect(snap!.aliases).toContain('checkpoint');
      expect(snap!.subcommands).toContain('create');
      expect(snap!.subcommands).toContain('restore');
    });
  });
});
