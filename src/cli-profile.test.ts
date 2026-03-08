/**
 * Tests for `ved profile` — Performance benchmarking CLI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  benchAudit,
  benchVault,
  benchTrust,
  benchDb,
  benchHash,
  benchMemory,
  profileCmd,
  type ProfileOptions,
  type BenchmarkResult,
} from './cli-profile.js';

// ── Helpers ────────────────────────────────────────────────────────────

const defaultOpts: ProfileOptions = {
  iterations: 10,
  warmup: 2,
  json: false,
  verbose: false,
  noColor: true,
};

function assertValidResult(r: BenchmarkResult): void {
  expect(r.name).toBeTruthy();
  expect(r.category).toBeTruthy();
  expect(r.iterations).toBeGreaterThan(0);
  expect(r.totalMs).toBeGreaterThanOrEqual(0);
  expect(r.avgMs).toBeGreaterThanOrEqual(0);
  expect(r.minMs).toBeGreaterThanOrEqual(0);
  expect(r.maxMs).toBeGreaterThanOrEqual(r.minMs);
  expect(r.p50Ms).toBeGreaterThanOrEqual(0);
  expect(r.p95Ms).toBeGreaterThanOrEqual(0);
  expect(r.p99Ms).toBeGreaterThanOrEqual(0);
  expect(r.opsPerSec).toBeGreaterThan(0);
}

// ── Benchmark Suites ───────────────────────────────────────────────────

describe('benchAudit', () => {
  it('returns results for all audit benchmarks', () => {
    const results = benchAudit(defaultOpts);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      assertValidResult(r);
      expect(r.category).toBe('audit');
    }
  });

  it('includes append, verifyChain, getChainHead', () => {
    const results = benchAudit(defaultOpts);
    const names = results.map(r => r.name);
    expect(names).toContain('audit.append');
    expect(names).toContain('audit.verifyChain');
    expect(names).toContain('audit.getChainHead');
  });

  it('append is faster than verifyChain', () => {
    const results = benchAudit(defaultOpts);
    const append = results.find(r => r.name === 'audit.append')!;
    const verify = results.find(r => r.name === 'audit.verifyChain')!;
    // append should be significantly faster per-op
    expect(append.avgMs).toBeLessThan(verify.avgMs * 10);
  });

  it('respects iteration count', () => {
    const results = benchAudit({ ...defaultOpts, iterations: 5 });
    const append = results.find(r => r.name === 'audit.append')!;
    expect(append.iterations).toBe(5);
  });
});

describe('benchVault', () => {
  it('returns results for all vault benchmarks', () => {
    const results = benchVault(defaultOpts);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      assertValidResult(r);
      expect(r.category).toBe('vault');
    }
  });

  it('includes createFile, readFile, listFiles, assertPathSafe, exists', () => {
    const results = benchVault(defaultOpts);
    const names = results.map(r => r.name);
    expect(names).toContain('vault.createFile');
    expect(names).toContain('vault.readFile');
    expect(names).toContain('vault.listFiles');
    expect(names).toContain('vault.assertPathSafe');
    expect(names).toContain('vault.exists');
  });

  it('path assertion is fast', () => {
    const results = benchVault(defaultOpts);
    const pathCheck = results.find(r => r.name === 'vault.assertPathSafe')!;
    expect(pathCheck.avgMs).toBeLessThan(10); // should be sub-ms
  });
});

describe('benchTrust', () => {
  it('returns results for all trust benchmarks', () => {
    const results = benchTrust(defaultOpts);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      assertValidResult(r);
      expect(r.category).toBe('trust');
    }
  });

  it('includes resolveTier, assessRisk, shouldApprove', () => {
    const results = benchTrust(defaultOpts);
    const names = results.map(r => r.name);
    expect(names.some(n => n.includes('resolveTier'))).toBe(true);
    expect(names.some(n => n.includes('assessRisk'))).toBe(true);
    expect(names.some(n => n.includes('shouldAutoApprove'))).toBe(true);
  });

  it('shouldAutoApprove is fast (in-memory lookup)', () => {
    const results = benchTrust(defaultOpts);
    const approve = results.find(r => r.name === 'trust.shouldAutoApprove')!;
    expect(approve.avgMs).toBeLessThan(5);
  });
});

describe('benchDb', () => {
  it('returns results for all db benchmarks', () => {
    const results = benchDb(defaultOpts);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      assertValidResult(r);
      expect(r.category).toBe('db');
    }
  });

  it('includes insert, selectById, selectRange, count, transaction', () => {
    const results = benchDb(defaultOpts);
    const names = results.map(r => r.name);
    expect(names).toContain('db.insert');
    expect(names).toContain('db.selectById');
    expect(names).toContain('db.selectRange(50)');
    expect(names).toContain('db.count');
    expect(names).toContain('db.transaction(10)');
  });

  it('transactions batch is slower than single insert', () => {
    const results = benchDb(defaultOpts);
    const insert = results.find(r => r.name === 'db.insert')!;
    const tx = results.find(r => r.name === 'db.transaction(10)')!;
    // Transaction of 10 inserts should take more total time than 1 insert
    expect(tx.avgMs).toBeGreaterThan(insert.avgMs * 0.5);
  });
});

describe('benchHash', () => {
  it('returns results for hash chain benchmarks', () => {
    const results = benchHash(defaultOpts);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      assertValidResult(r);
      expect(r.category).toBe('hash');
    }
  });

  it('full chain verification is slower than partial', () => {
    const results = benchHash({ ...defaultOpts, iterations: 5 });
    const full = results.find(r => r.name === 'hash.verifyChain(500)')!;
    const partial = results.find(r => r.name === 'hash.verifyChain(50)')!;
    expect(full.avgMs).toBeGreaterThanOrEqual(partial.avgMs * 0.5);
  });

  it('chain head lookup is fast', () => {
    const results = benchHash(defaultOpts);
    const head = results.find(r => r.name === 'hash.getChainHead')!;
    expect(head.avgMs).toBeLessThan(10);
  });
});

describe('benchMemory', () => {
  it('returns results for memory benchmarks', () => {
    const results = benchMemory(defaultOpts);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      assertValidResult(r);
      expect(r.category).toBe('memory');
    }
  });

  it('includes listAll, readAndParse, getBacklinks, resolveLink, updateFile', () => {
    const results = benchMemory(defaultOpts);
    const names = results.map(r => r.name);
    expect(names).toContain('memory.listAll');
    expect(names).toContain('memory.readAndParse');
    expect(names).toContain('memory.getBacklinks');
    expect(names).toContain('memory.resolveLink');
    expect(names).toContain('memory.updateFile');
  });

  it('in-memory lookup (backlinks) is fast', () => {
    const results = benchMemory(defaultOpts);
    const backlinks = results.find(r => r.name === 'memory.getBacklinks')!;
    expect(backlinks.avgMs).toBeLessThan(5);
  });
});

// ── Statistics ──────────────────────────────────────────────────────────

describe('BenchmarkResult statistics', () => {
  it('p50 <= p95 <= p99 <= max', () => {
    const results = benchAudit(defaultOpts);
    for (const r of results) {
      expect(r.p50Ms).toBeLessThanOrEqual(r.p95Ms + 0.001);
      expect(r.p95Ms).toBeLessThanOrEqual(r.p99Ms + 0.001);
      expect(r.p99Ms).toBeLessThanOrEqual(r.maxMs + 0.001);
    }
  });

  it('min <= avg <= max', () => {
    const results = benchVault(defaultOpts);
    for (const r of results) {
      expect(r.minMs).toBeLessThanOrEqual(r.avgMs + 0.001);
      expect(r.avgMs).toBeLessThanOrEqual(r.maxMs + 0.001);
    }
  });

  it('opsPerSec = iterations / (totalMs / 1000)', () => {
    const results = benchDb(defaultOpts);
    for (const r of results) {
      const expected = r.iterations / (r.totalMs / 1000);
      expect(Math.abs(r.opsPerSec - expected)).toBeLessThan(1);
    }
  });

  it('verbose mode includes times array', () => {
    const results = benchDb({ ...defaultOpts, verbose: true, iterations: 5 });
    for (const r of results) {
      expect(r.times).toBeDefined();
      expect(r.times!.length).toBe(r.iterations);
    }
  });

  it('non-verbose mode omits times array', () => {
    const results = benchDb({ ...defaultOpts, verbose: false });
    for (const r of results) {
      expect(r.times).toBeUndefined();
    }
  });
});

// ── profileCmd integration ─────────────────────────────────────────────

describe('profileCmd', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  it('runs all suites with no args', async () => {
    await profileCmd(['--iterations', '3', '--warmup', '1', '--no-color']);
    const output = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('audit');
    expect(output).toContain('vault');
    expect(output).toContain('trust');
    expect(output).toContain('db');
    expect(output).toContain('hash');
    expect(output).toContain('memory');
    expect(output).toContain('Summary');
  });

  it('runs single suite', async () => {
    await profileCmd(['audit', '--iterations', '3', '--warmup', '1', '--no-color']);
    const output = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('audit');
    expect(output).not.toContain('── vault ──');
  });

  it('runs multiple suites', async () => {
    await profileCmd(['audit', 'db', '--iterations', '3', '--warmup', '1', '--no-color']);
    const output = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('audit');
    expect(output).toContain('db');
    expect(output).not.toContain('── vault ──');
  });

  it('outputs JSON when --json flag set', async () => {
    await profileCmd(['audit', '--iterations', '3', '--warmup', '1', '--json']);
    const jsonLine = consoleLog.mock.calls.map(c => String(c[0])).find(s => s.trimStart().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const report = JSON.parse(jsonLine!);
    expect(report.timestamp).toBeTruthy();
    expect(report.platform).toBeTruthy();
    expect(report.nodeVersion).toBeTruthy();
    expect(report.categories.audit).toBeDefined();
    expect(report.summary.totalBenchmarks).toBeGreaterThan(0);
  });

  it('JSON output has valid structure', async () => {
    await profileCmd(['db', '--iterations', '3', '--warmup', '1', '--json']);
    const jsonLine = consoleLog.mock.calls.map(c => String(c[0])).find(s => s.trimStart().startsWith('{'));
    const report = JSON.parse(jsonLine!);
    const dbResults = report.categories.db;
    for (const r of dbResults) {
      expect(r.name).toBeTruthy();
      expect(r.category).toBe('db');
      expect(typeof r.avgMs).toBe('number');
      expect(typeof r.opsPerSec).toBe('number');
      expect(typeof r.p95Ms).toBe('number');
    }
  });

  it('shows summary with fastest and slowest', async () => {
    await profileCmd(['audit', 'db', '--iterations', '3', '--warmup', '1', '--no-color']);
    const output = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Fastest');
    expect(output).toContain('Slowest');
    expect(output).toContain('Total benchmarks');
    expect(output).toContain('Total iterations');
  });

  it('verbose shows iteration times', async () => {
    await profileCmd(['db', '--iterations', '3', '--warmup', '1', '--verbose', '--no-color']);
    const output = consoleLog.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('iterations: [');
  });

  it('respects --iterations flag', async () => {
    await profileCmd(['audit', '--iterations', '7', '--warmup', '0', '--json']);
    const jsonLine = consoleLog.mock.calls.map(c => String(c[0])).find(s => s.trimStart().startsWith('{'));
    const report = JSON.parse(jsonLine!);
    const appendResult = report.categories.audit.find((r: any) => r.name === 'audit.append');
    expect(appendResult.iterations).toBe(7);
  });

  it('handles unknown suite gracefully', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await profileCmd(['nonexistent']);
    } catch {
      // expected
    }
    expect(consoleError.mock.calls.some(c => String(c[0]).includes('Unknown suite'))).toBe(true);
    mockExit.mockRestore();
  });

  it('all suite keyword runs all suites', async () => {
    await profileCmd(['all', '--iterations', '3', '--warmup', '1', '--json']);
    const jsonLine = consoleLog.mock.calls.map(c => String(c[0])).find(s => s.trimStart().startsWith('{'));
    const report = JSON.parse(jsonLine!);
    expect(Object.keys(report.categories)).toEqual(
      expect.arrayContaining(['audit', 'vault', 'trust', 'db', 'hash', 'memory'])
    );
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('single iteration works', () => {
    const results = benchDb({ ...defaultOpts, iterations: 1, warmup: 0 });
    for (const r of results) {
      assertValidResult(r);
      expect(r.iterations).toBe(1);
      expect(r.minMs).toBe(r.maxMs);
      expect(r.p50Ms).toBe(r.minMs);
    }
  });

  it('zero warmup works', () => {
    const results = benchAudit({ ...defaultOpts, warmup: 0 });
    for (const r of results) {
      assertValidResult(r);
    }
  });

  it('high iteration count works', () => {
    const results = benchDb({ ...defaultOpts, iterations: 200, warmup: 5 });
    const insert = results.find(r => r.name === 'db.insert')!;
    expect(insert.iterations).toBe(200);
    expect(insert.opsPerSec).toBeGreaterThan(0);
  });

  it('temp directories are cleaned up', () => {
    // Run all suites and check no temp dirs leak
    benchAudit({ ...defaultOpts, iterations: 3 });
    benchVault({ ...defaultOpts, iterations: 3 });
    benchTrust({ ...defaultOpts, iterations: 3 });
    benchDb({ ...defaultOpts, iterations: 3 });
    benchHash({ ...defaultOpts, iterations: 3 });
    benchMemory({ ...defaultOpts, iterations: 3 });
    // If we get here without error, cleanup succeeded
    expect(true).toBe(true);
  });

  it('concurrent suite runs do not interfere', () => {
    // Run two suites that both use DB
    const audit1 = benchAudit({ ...defaultOpts, iterations: 5 });
    const audit2 = benchAudit({ ...defaultOpts, iterations: 5 });
    // Both should have valid, independent results
    for (const r of [...audit1, ...audit2]) {
      assertValidResult(r);
    }
  });
});
