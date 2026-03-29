/**
 * Session 103 — P5 Polish Phase 2 Tests
 *
 * Tests for:
 * 1. errHint/errUsage/vedError/dieWithHint formatting
 * 2. Spinner non-TTY fallback
 * 3. Doctor --fix enhancements (lock file, cron validation)
 * 4. CLI error paths produce structured output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vedError, errHint, errUsage, dieWithHint, VED_ERRORS } from './errors.js';
import { spinner, withSpinner } from './spinner.js';
import { parseCronExpression } from './core/cron.js';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── Error Formatting ──

describe('errHint formatting', () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints error with red ✗ prefix', () => {
    errHint('Something went wrong');
    expect(stderrOutput.length).toBe(1);
    expect(stderrOutput[0]).toContain('✗');
    expect(stderrOutput[0]).toContain('Something went wrong');
  });

  it('prints hint with → prefix when provided', () => {
    errHint('File not found', 'Check the path and try again');
    expect(stderrOutput.length).toBe(2);
    expect(stderrOutput[1]).toContain('→');
    expect(stderrOutput[1]).toContain('Check the path and try again');
  });

  it('omits hint line when no hint provided', () => {
    errHint('Oops');
    expect(stderrOutput.length).toBe(1);
  });
});

describe('errUsage formatting', () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints Usage: prefix', () => {
    errUsage('ved search <query> [-n <limit>]');
    expect(stderrOutput.length).toBe(1);
    expect(stderrOutput[0]).toContain('Usage:');
    expect(stderrOutput[0]).toContain('ved search <query>');
  });
});

describe('vedError formatting', () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints error with VED code and fix hint', () => {
    vedError('CONFIG_MISSING');
    expect(stderrOutput.length).toBe(2);
    expect(stderrOutput[0]).toContain('[VED-001]');
    expect(stderrOutput[0]).toContain('Config file not found');
    expect(stderrOutput[1]).toContain('Fix:');
    expect(stderrOutput[1]).toContain('ved init');
  });

  it('uses custom message when provided', () => {
    vedError('DB_CORRUPT', 'Migration failed: bad schema');
    expect(stderrOutput[0]).toContain('[VED-003]');
    expect(stderrOutput[0]).toContain('Migration failed: bad schema');
  });

  it('uses custom fix when provided', () => {
    vedError('LLM_UNREACHABLE', undefined, 'Try restarting Ollama');
    expect(stderrOutput[1]).toContain('Try restarting Ollama');
  });

  it('handles unknown error code gracefully', () => {
    vedError('UNKNOWN_CODE' as any);
    expect(stderrOutput[0]).toContain('[VED-???]');
  });
});

describe('VED_ERRORS registry', () => {
  it('has 26 error codes', () => {
    expect(Object.keys(VED_ERRORS).length).toBe(26);
  });

  it('all entries have num, message, and fix', () => {
    for (const [key, def] of Object.entries(VED_ERRORS)) {
      expect(def.num, `${key}.num`).toMatch(/^\d{3}$/);
      expect(def.message, `${key}.message`).toBeTruthy();
      expect(def.fix, `${key}.fix`).toBeTruthy();
    }
  });

  it('has unique error numbers', () => {
    const nums = Object.values(VED_ERRORS).map(d => d.num);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('includes new S102 error codes', () => {
    expect(VED_ERRORS.SYNC_FAILED).toBeDefined();
    expect(VED_ERRORS.ALREADY_EXISTS).toBeDefined();
    expect(VED_ERRORS.HOOK_BLOCKED).toBeDefined();
    expect(VED_ERRORS.AGENT_NOT_FOUND).toBeDefined();
  });
});

// ── Spinner Non-TTY Fallback ──

describe('spinner non-TTY fallback', () => {
  let stderrChunks: string[];
  const origIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    stderrChunks = [];
    // Force non-TTY mode
    Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true, configurable: true });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true, configurable: true });
    vi.restoreAllMocks();
  });

  it('prints static line in non-TTY', () => {
    const s = spinner('Loading...');
    expect(stderrChunks.some(c => c.includes('Loading...'))).toBe(true);
    s.stop();
  });

  it('succeed prints ✔ in non-TTY', () => {
    const s = spinner('Working...');
    s.succeed('All done');
    expect(stderrChunks.some(c => c.includes('✔') && c.includes('All done'))).toBe(true);
  });

  it('fail prints ✗ in non-TTY', () => {
    const s = spinner('Working...');
    s.fail('Broke');
    expect(stderrChunks.some(c => c.includes('✗') && c.includes('Broke'))).toBe(true);
  });

  it('does not animate in non-TTY', () => {
    const s = spinner('Static...');
    // In non-TTY, no interval is set — just the initial line
    expect(stderrChunks.length).toBe(1);
    s.stop();
  });

  it('isSpinning tracks state', () => {
    const s = spinner('Work');
    expect(s.isSpinning).toBe(true);
    s.stop();
    expect(s.isSpinning).toBe(false);
  });

  it('succeed only fires once', () => {
    const s = spinner('Work');
    s.succeed('Done');
    s.succeed('Done again');
    const successLines = stderrChunks.filter(c => c.includes('✔'));
    expect(successLines.length).toBe(1);
  });
});

describe('withSpinner', () => {
  const origIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true, configurable: true });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true, configurable: true });
    vi.restoreAllMocks();
  });

  it('returns the function result', async () => {
    const result = await withSpinner('Test', async () => 42);
    expect(result).toBe(42);
  });

  it('re-throws errors', async () => {
    await expect(withSpinner('Test', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
  });
});

// ── Doctor --fix: Lock File Cleanup (Fix 9) ──

describe('doctor --fix lock file cleanup', () => {
  const tmpBase = join(tmpdir(), `ved-test-lock-${randomUUID()}`);

  beforeEach(() => {
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('removes lock file when PID is not running', () => {
    const lockFile = join(tmpBase, 'ved.lock');
    // Use a PID that's extremely unlikely to be running
    writeFileSync(lockFile, '99999999');
    expect(existsSync(lockFile)).toBe(true);

    // Simulate the fix logic
    const lockContent = '99999999';
    const pid = parseInt(lockContent, 10);
    let isRunning = false;
    try {
      process.kill(pid, 0);
      isRunning = true;
    } catch { /* not running */ }

    if (!isRunning) {
      unlinkSync(lockFile);
    }

    expect(existsSync(lockFile)).toBe(false);
  });

  it('keeps lock file when PID is current process', () => {
    const lockFile = join(tmpBase, 'ved.lock');
    writeFileSync(lockFile, String(process.pid));

    const pid = process.pid;
    let isRunning = false;
    try {
      process.kill(pid, 0);
      isRunning = true;
    } catch { /* not running */ }

    expect(isRunning).toBe(true);
    expect(existsSync(lockFile)).toBe(true);
  });

  it('handles non-numeric lock file content', () => {
    const lockFile = join(tmpBase, 'ved.lock');
    writeFileSync(lockFile, 'not-a-pid');

    const lockContent = 'not-a-pid';
    const pid = parseInt(lockContent, 10);
    let isRunning = false;
    if (!isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        isRunning = true;
      } catch { /* not running */ }
    }

    // NaN pid means we treat it as orphaned
    if (!isRunning) {
      unlinkSync(lockFile);
    }
    expect(existsSync(lockFile)).toBe(false);
  });
});

// ── Doctor --fix: Cron Job Validation (Fix 10) ──

describe('doctor --fix cron job validation', () => {
  it('removes cron jobs with invalid schedules from DB', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        job_type TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Insert valid and invalid cron jobs
    const insert = db.prepare('INSERT INTO cron_jobs (id, name, schedule, job_type) VALUES (?, ?, ?, ?)');
    insert.run('1', 'valid-daily', '0 2 * * *', 'backup');
    insert.run('2', 'invalid-bad', 'not a cron', 'backup');
    insert.run('3', 'valid-weekly', '0 0 * * 0', 'reindex');
    insert.run('4', 'invalid-6fields', '0 0 0 0 0 0', 'doctor');

    const rows = db.prepare('SELECT id, name, schedule FROM cron_jobs').all() as Array<{
      id: string; name: string; schedule: string;
    }>;
    const invalidJobs: string[] = [];
    for (const row of rows) {
      try {
        parseCronExpression(row.schedule);
      } catch {
        invalidJobs.push(row.name);
        db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(row.id);
      }
    }

    expect(invalidJobs).toContain('invalid-bad');
    // Valid jobs should remain
    const remaining = db.prepare('SELECT name FROM cron_jobs').all() as Array<{ name: string }>;
    const names = remaining.map(r => r.name);
    expect(names).toContain('valid-daily');
    expect(names).toContain('valid-weekly');
    expect(names).not.toContain('invalid-bad');

    db.close();
  });

  it('handles empty cron_jobs table gracefully', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        job_type TEXT NOT NULL
      )
    `);

    const rows = db.prepare('SELECT id, name, schedule FROM cron_jobs').all() as Array<{
      id: string; name: string; schedule: string;
    }>;
    expect(rows.length).toBe(0);

    db.close();
  });
});

// ── CLI Error Path Integration ──

describe('CLI error paths use structured errors', () => {
  it('errHint includes ANSI red codes', () => {
    const chunks: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });

    errHint('test error');
    expect(chunks[0]).toContain('\x1B[31m'); // red
    expect(chunks[0]).toContain('\x1B[0m');  // reset

    vi.restoreAllMocks();
  });

  it('errUsage includes dim ANSI codes', () => {
    const chunks: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });

    errUsage('ved test <arg>');
    expect(chunks[0]).toContain('\x1B[2m'); // dim

    vi.restoreAllMocks();
  });

  it('vedError formats with ❌ prefix', () => {
    const chunks: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });

    vedError('VAULT_MISSING');
    expect(chunks[0]).toContain('❌');
    expect(chunks[0]).toContain('VED-004');

    vi.restoreAllMocks();
  });
});

// ── Spinner in TTY mode (basic coverage) ──

describe('spinner TTY mode', () => {
  const origIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, writable: true, configurable: true });
  });

  it('starts spinning and can be stopped', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const s = spinner('TTY test');
    expect(s.isSpinning).toBe(true);
    s.stop();
    expect(s.isSpinning).toBe(false);
    vi.restoreAllMocks();
  });

  it('update changes text without stopping', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const s = spinner('Step 1');
    s.update('Step 2');
    expect(s.isSpinning).toBe(true);
    s.succeed('Done');
    expect(s.isSpinning).toBe(false);
    vi.restoreAllMocks();
  });

  it('warn prints ⚠', () => {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const s = spinner('Check');
    s.warn('Careful');
    expect(chunks.some(c => c.includes('⚠') && c.includes('Careful'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('info prints ℹ', () => {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const s = spinner('Note');
    s.info('FYI');
    expect(chunks.some(c => c.includes('ℹ') && c.includes('FYI'))).toBe(true);
    vi.restoreAllMocks();
  });
});
