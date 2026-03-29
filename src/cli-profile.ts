/**
 * ved profile — Performance benchmarking and profiling.
 *
 * Measures execution time and throughput of key Ved subsystems:
 * audit, vault, RAG, trust, database, hash chain, and end-to-end pipeline.
 *
 * Subcommands:
 *   ved profile                          — Run all benchmarks (default)
 *   ved profile all                      — Run all benchmarks
 *   ved profile audit                    — Benchmark audit log operations
 *   ved profile vault                    — Benchmark vault I/O operations
 *   ved profile rag                      — Benchmark RAG pipeline operations
 *   ved profile trust                    — Benchmark trust engine operations
 *   ved profile db                       — Benchmark raw database operations
 *   ved profile hash                     — Benchmark hash chain verification
 *   ved profile memory                   — Benchmark memory tier operations
 *
 * Flags:
 *   --iterations <n>                     — Iterations per benchmark (default: 100)
 *   --warmup <n>                         — Warmup iterations (default: 5)
 *   --json                               — Output as JSON
 *   --verbose                            — Show individual iteration times
 *   --no-color                           — Disable ANSI colors
 *
 * Aliases: ved bench, ved benchmark
 *
 * @module cli-profile
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { AuditLog } from './audit/store.js';
import { VaultManager } from './memory/vault.js';
import { TrustEngine } from './trust/engine.js';
import type { TrustTier } from './types/index.js';
import { errHint } from './errors.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface BenchmarkResult {
  name: string;
  category: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  opsPerSec: number;
  times?: number[];
}

export interface ProfileReport {
  timestamp: string;
  platform: string;
  nodeVersion: string;
  categories: Record<string, BenchmarkResult[]>;
  totalMs: number;
  summary: {
    totalBenchmarks: number;
    totalIterations: number;
    fastestOp: string;
    slowestOp: string;
  };
}

export interface ProfileOptions {
  iterations: number;
  warmup: number;
  json: boolean;
  verbose: boolean;
  noColor: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_ITERATIONS = 100;
const DEFAULT_WARMUP = 5;

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── Helpers ────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms: number, noColor: boolean): string {
  const val = ms < 1 ? `${(ms * 1000).toFixed(1)}µs` : ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
  if (noColor) return val;
  if (ms < 1) return `${GREEN}${val}${RESET}`;
  if (ms < 10) return `${YELLOW}${val}${RESET}`;
  return `${RED}${val}${RESET}`;
}

function formatOps(ops: number, noColor: boolean): string {
  const val = ops >= 1000 ? `${(ops / 1000).toFixed(1)}K` : ops.toFixed(0);
  if (noColor) return `${val} ops/s`;
  return `${CYAN}${val} ops/s${RESET}`;
}

function progressBar(current: number, total: number, width = 20): string {
  const pct = current / total;
  const filled = Math.round(pct * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${Math.round(pct * 100)}%`;
}

/**
 * Run a benchmark: warmup + measured iterations.
 */
function runBench(
  name: string,
  category: string,
  fn: () => void,
  opts: ProfileOptions,
): BenchmarkResult {
  // Warmup
  for (let i = 0; i < opts.warmup; i++) {
    fn();
  }

  // Measured
  const times: number[] = [];
  for (let i = 0; i < opts.iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  const sorted = [...times].sort((a, b) => a - b);
  const totalMs = times.reduce((s, t) => s + t, 0);
  const avgMs = totalMs / times.length;

  return {
    name,
    category,
    iterations: opts.iterations,
    totalMs,
    avgMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    opsPerSec: times.length / (totalMs / 1000),
    ...(opts.verbose ? { times } : {}),
  };
}

// ── Benchmark Suites ───────────────────────────────────────────────────

function createTempDir(): string {
  const dir = join(tmpdir(), `ved-bench-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Benchmark audit log operations.
 */
export function benchAudit(opts: ProfileOptions): BenchmarkResult[] {
  const dir = createTempDir();
  const dbPath = join(dir, 'bench.db');
  const db = openDatabase({ path: dbPath });
  migrate(db);
  const audit = new AuditLog(db);
  const results: BenchmarkResult[] = [];

  // Audit append
  let counter = 0;
  results.push(runBench('audit.append', 'audit', () => {
    audit.append({
      eventType: 'message_received',
      sessionId: 'bench-session',
      actor: 'bench-user',
      detail: { content: `Benchmark message ${counter++}`, index: counter },
    });
  }, opts));

  // Audit verify chain (with existing entries)
  results.push(runBench('audit.verifyChain', 'audit', () => {
    audit.verifyChain(50);
  }, { ...opts, iterations: Math.min(opts.iterations, 20) }));

  // Audit getChainHead
  results.push(runBench('audit.getChainHead', 'audit', () => {
    audit.getChainHead();
  }, opts));

  closeDatabase(db);
  cleanTempDir(dir);
  return results;
}

/**
 * Benchmark vault I/O operations.
 */
export function benchVault(opts: ProfileOptions): BenchmarkResult[] {
  const dir = createTempDir();
  const vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'entities'), { recursive: true });
  mkdirSync(join(vaultDir, 'daily'), { recursive: true });
  mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
  mkdirSync(join(vaultDir, 'decisions'), { recursive: true });

  const vault = new VaultManager(vaultDir, false);
  const results: BenchmarkResult[] = [];

  // Create files
  let fileCounter = 0;
  results.push(runBench('vault.createFile', 'vault', () => {
    const name = `entities/bench-${fileCounter++}.md`;
    vault.createFile(name, {
      type: 'person',
      tags: ['benchmark', 'test'],
      confidence: 0.9,
      created: new Date().toISOString(),
    }, `# Benchmark Entity ${fileCounter}\n\nSome content about this entity.\n\n## Links\n- [[other-entity]]\n- [[concept-a]]`);
  }, opts));

  // Read files
  const existingFile = 'entities/bench-0.md';
  results.push(runBench('vault.readFile', 'vault', () => {
    vault.readFile(existingFile);
  }, opts));

  // List files
  results.push(runBench('vault.listFiles', 'vault', () => {
    vault.listFiles('entities');
  }, opts));

  // Path assertion
  results.push(runBench('vault.assertPathSafe', 'vault', () => {
    vault.assertPathSafe('entities/some-file.md');
  }, opts));

  // Exists check
  results.push(runBench('vault.exists', 'vault', () => {
    vault.exists(existingFile);
  }, opts));

  vault.close();
  cleanTempDir(dir);
  return results;
}

/**
 * Benchmark trust engine operations.
 */
export function benchTrust(opts: ProfileOptions): BenchmarkResult[] {
  const dir = createTempDir();
  const dbPath = join(dir, 'bench.db');
  const db = openDatabase({ path: dbPath });
  migrate(db);

  const trust = new TrustEngine(db, {
    ownerIds: ['owner-1'],
    tribeIds: ['tribe-1', 'tribe-2'],
    knownIds: [],
    defaultTier: 1 as TrustTier,
    approvalTimeoutMs: 300_000,
    maxToolCallsPerMessage: 10,
    maxAgenticLoops: 5,
  });

  const results: BenchmarkResult[] = [];

  // Resolve tier
  results.push(runBench('trust.resolveTier', 'trust', () => {
    trust.resolveTier('discord', 'owner-1');
  }, opts));

  results.push(runBench('trust.resolveTier(stranger)', 'trust', () => {
    trust.resolveTier('discord', 'unknown-user');
  }, opts));

  // Assess risk (mock tool call)
  results.push(runBench('trust.assessRisk', 'trust', () => {
    trust.assessRisk('file_read', { path: '/tmp/test.txt' });
  }, opts));

  // Should auto-approve
  results.push(runBench('trust.shouldAutoApprove', 'trust', () => {
    trust.shouldAutoApprove(4 as TrustTier, 'low');
  }, opts));

  results.push(runBench('trust.shouldAutoApprove(stranger+high)', 'trust', () => {
    trust.shouldAutoApprove(1 as TrustTier, 'high');
  }, opts));

  closeDatabase(db);
  cleanTempDir(dir);
  return results;
}

/**
 * Benchmark raw database operations.
 */
export function benchDb(opts: ProfileOptions): BenchmarkResult[] {
  const dir = createTempDir();
  const dbPath = join(dir, 'bench.db');
  const db = openDatabase({ path: dbPath });
  migrate(db);
  const results: BenchmarkResult[] = [];

  // Insert
  const insertStmt = db.prepare(
    `INSERT INTO audit_log (id, timestamp, event_type, actor, session_id, detail, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let insertCounter = 0;
  results.push(runBench('db.insert', 'db', () => {
    const id = `bench-${insertCounter++}`;
    insertStmt.run(id, Date.now(), 'benchmark', 'bench', 'sess', '{}', `prev-${id}`, `hash-${id}`);
  }, opts));

  // Select by ID
  const selectStmt = db.prepare(`SELECT * FROM audit_log WHERE id = ?`);
  results.push(runBench('db.selectById', 'db', () => {
    selectStmt.get('bench-0');
  }, opts));

  // Select range
  const rangeStmt = db.prepare(`SELECT * FROM audit_log ORDER BY rowid DESC LIMIT ?`);
  results.push(runBench('db.selectRange(50)', 'db', () => {
    rangeStmt.all(50);
  }, opts));

  // Count
  const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM audit_log`);
  results.push(runBench('db.count', 'db', () => {
    countStmt.get();
  }, opts));

  // Transaction (batch insert)
  results.push(runBench('db.transaction(10)', 'db', () => {
    const tx = db.transaction(() => {
      for (let i = 0; i < 10; i++) {
        const id = `tx-${insertCounter++}`;
        insertStmt.run(id, Date.now(), 'benchmark', 'bench', 'sess', '{}', `prev-${id}`, `hash-${id}`);
      }
    });
    tx();
  }, opts));

  closeDatabase(db);
  cleanTempDir(dir);
  return results;
}

/**
 * Benchmark hash chain operations.
 */
export function benchHash(opts: ProfileOptions): BenchmarkResult[] {
  const dir = createTempDir();
  const dbPath = join(dir, 'bench.db');
  const db = openDatabase({ path: dbPath });
  migrate(db);
  const audit = new AuditLog(db);
  const results: BenchmarkResult[] = [];

  // Pre-populate chain
  for (let i = 0; i < 500; i++) {
    audit.append({
      eventType: 'message_received',
      sessionId: 'bench',
      actor: 'bench',
      detail: { i },
    });
  }

  // Verify full chain (500 entries)
  results.push(runBench('hash.verifyChain(500)', 'hash', () => {
    audit.verifyChain(500);
  }, { ...opts, iterations: Math.min(opts.iterations, 10) }));

  // Verify partial chain
  results.push(runBench('hash.verifyChain(50)', 'hash', () => {
    audit.verifyChain(50);
  }, { ...opts, iterations: Math.min(opts.iterations, 20) }));

  // Verify chain head
  results.push(runBench('hash.getChainHead', 'hash', () => {
    audit.getChainHead();
  }, opts));

  closeDatabase(db);
  cleanTempDir(dir);
  return results;
}

/**
 * Benchmark memory tier operations (vault-based).
 */
export function benchMemory(opts: ProfileOptions): BenchmarkResult[] {
  const dir = createTempDir();
  const vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'entities'), { recursive: true });
  mkdirSync(join(vaultDir, 'daily'), { recursive: true });
  mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
  mkdirSync(join(vaultDir, 'decisions'), { recursive: true });

  const vault = new VaultManager(vaultDir, false);
  const results: BenchmarkResult[] = [];

  // Pre-populate vault
  for (let i = 0; i < 50; i++) {
    vault.createFile(`entities/entity-${i}.md`, {
      type: 'person',
      tags: ['test', i % 2 === 0 ? 'even' : 'odd'],
      confidence: 0.8,
    }, `# Entity ${i}\n\nSome content about entity ${i}.\n\n## Links\n- [[entity-${(i + 1) % 50}]]\n- [[concept-${i % 10}]]`);
  }
  for (let i = 0; i < 10; i++) {
    vault.createFile(`concepts/concept-${i}.md`, {
      type: 'concept',
      tags: ['concept'],
    }, `# Concept ${i}\n\nAbout concept ${i}.`);
  }

  // List all files
  results.push(runBench('memory.listAll', 'memory', () => {
    vault.listFiles();
  }, opts));

  // Read + parse frontmatter
  results.push(runBench('memory.readAndParse', 'memory', () => {
    vault.readFile('entities/entity-0.md');
  }, opts));

  // Get backlinks
  results.push(runBench('memory.getBacklinks', 'memory', () => {
    vault.getBacklinks('entity-0');
  }, opts));

  // Resolve wikilink
  results.push(runBench('memory.resolveLink', 'memory', () => {
    vault.resolveLink('entity-25');
  }, opts));

  // Update file
  let updateCounter = 0;
  results.push(runBench('memory.updateFile', 'memory', () => {
    vault.updateFile('entities/entity-0.md', {
      frontmatter: { updated: new Date().toISOString(), revision: updateCounter++ },
    });
  }, opts));

  vault.close();
  cleanTempDir(dir);
  return results;
}

// ── Report Formatting ──────────────────────────────────────────────────

function printResult(r: BenchmarkResult, opts: ProfileOptions): void {
  const nc = opts.noColor;
  const name = nc ? r.name : `${BOLD}${r.name}${RESET}`;
  const avg = formatMs(r.avgMs, nc);
  const ops = formatOps(r.opsPerSec, nc);
  const p95 = formatMs(r.p95Ms, nc);
  const min = formatMs(r.minMs, nc);
  const max = formatMs(r.maxMs, nc);

  console.log(`  ${name}`);
  console.log(`    avg: ${avg}  |  ${ops}  |  p95: ${p95}  |  min: ${min}  |  max: ${max}`);

  if (opts.verbose && r.times) {
    const dim = nc ? '' : DIM;
    const rst = nc ? '' : RESET;
    console.log(`    ${dim}iterations: [${r.times.map(t => t.toFixed(3)).join(', ')}]${rst}`);
  }
}

function printCategory(name: string, results: BenchmarkResult[], opts: ProfileOptions): void {
  const nc = opts.noColor;
  const header = nc ? `── ${name} ──` : `${CYAN}${BOLD}── ${name} ──${RESET}`;
  console.log(`\n${header}`);
  for (const r of results) {
    printResult(r, opts);
  }
}

function printSummary(report: ProfileReport, opts: ProfileOptions): void {
  const nc = opts.noColor;
  const header = nc ? '═══ Summary ═══' : `${BOLD}═══ Summary ═══${RESET}`;
  console.log(`\n${header}`);
  console.log(`  Total benchmarks: ${report.summary.totalBenchmarks}`);
  console.log(`  Total iterations: ${report.summary.totalIterations}`);
  console.log(`  Total time: ${formatMs(report.totalMs, nc)}`);
  console.log(`  Fastest: ${nc ? report.summary.fastestOp : `${GREEN}${report.summary.fastestOp}${RESET}`}`);
  console.log(`  Slowest: ${nc ? report.summary.slowestOp : `${RED}${report.summary.slowestOp}${RESET}`}`);
}

function buildReport(categories: Record<string, BenchmarkResult[]>): ProfileReport {
  const allResults = Object.values(categories).flat();
  const fastest = allResults.reduce((a, b) => a.avgMs < b.avgMs ? a : b);
  const slowest = allResults.reduce((a, b) => a.avgMs > b.avgMs ? a : b);

  return {
    timestamp: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    categories,
    totalMs: allResults.reduce((s, r) => s + r.totalMs, 0),
    summary: {
      totalBenchmarks: allResults.length,
      totalIterations: allResults.reduce((s, r) => s + r.iterations, 0),
      fastestOp: `${fastest.name} (${fastest.avgMs.toFixed(3)}ms)`,
      slowestOp: `${slowest.name} (${slowest.avgMs.toFixed(3)}ms)`,
    },
  };
}

// ── Suite Registry ─────────────────────────────────────────────────────

type SuiteRunner = (opts: ProfileOptions) => BenchmarkResult[];

const SUITES: Record<string, SuiteRunner> = {
  audit: benchAudit,
  vault: benchVault,
  trust: benchTrust,
  db: benchDb,
  hash: benchHash,
  memory: benchMemory,
};

const SUITE_NAMES = Object.keys(SUITES);

// ── CLI Entry ──────────────────────────────────────────────────────────

function parseProfileArgs(args: string[]): { suites: string[]; opts: ProfileOptions } {
  const opts: ProfileOptions = {
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    json: false,
    verbose: false,
    noColor: false,
  };

  const suites: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--iterations':
      case '-i':
        opts.iterations = Math.max(1, parseInt(args[++i] || '100', 10));
        break;
      case '--warmup':
      case '-w':
        opts.warmup = Math.max(0, parseInt(args[++i] || '5', 10));
        break;
      case '--json':
        opts.json = true;
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--no-color':
        opts.noColor = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('-') && SUITE_NAMES.includes(arg)) {
          suites.push(arg);
        } else if (arg === 'all') {
          // explicit all — same as no suite args
        } else if (!arg.startsWith('-')) {
          errHint(`Unknown suite: ${arg}. Available: ${SUITE_NAMES.join(', ')}`, 'Run "ved help" to see available commands');
          process.exit(1);
        }
    }
    i++;
  }

  return { suites: suites.length > 0 ? suites : SUITE_NAMES, opts };
}

function printHelp(): void {
  console.log(`ved profile — Performance benchmarking

Usage:
  ved profile                       Run all benchmarks
  ved profile <suite> [<suite>...]  Run specific suites
  ved profile audit vault           Run audit + vault benchmarks

Suites:
  audit    Audit log operations (append, verify, chain head)
  vault    Vault I/O (create, read, list, exists, path check)
  trust    Trust engine (resolve tier, assess risk, approve)
  db       Raw database (insert, select, range, count, transaction)
  hash     Hash chain verification (full chain, partial, head)
  memory   Memory tier operations (list, read, backlinks, update)

Flags:
  --iterations, -i <n>   Iterations per benchmark (default: 100)
  --warmup, -w <n>       Warmup iterations (default: 5)
  --json                 Output as JSON
  --verbose, -v          Show individual iteration times
  --no-color             Disable ANSI colors
  --help, -h             Show this help`);
}

/**
 * Main entry point for `ved profile`.
 */
export async function profileCmd(args: string[]): Promise<void> {
  const { suites, opts } = parseProfileArgs(args);

  if (!opts.json) {
    const nc = opts.noColor;
    const title = nc ? 'Ved Performance Profile' : `${BOLD}${CYAN}Ved Performance Profile${RESET}`;
    console.log(`\n${title}`);
    console.log(`  iterations: ${opts.iterations}  warmup: ${opts.warmup}  suites: ${suites.join(', ')}`);
    console.log(`  platform: ${process.platform} ${process.arch}  node: ${process.version}`);
  }

  const categories: Record<string, BenchmarkResult[]> = {};
  const totalSuites = suites.length;

  for (let s = 0; s < totalSuites; s++) {
    const suiteName = suites[s];
    const runner = SUITES[suiteName];

    if (!opts.json) {
      const progress = progressBar(s, totalSuites);
      process.stdout.write(`\r  ${progress} ${suiteName}...`);
    }

    try {
      categories[suiteName] = runner(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      categories[suiteName] = [{
        name: `${suiteName}.ERROR`,
        category: suiteName,
        iterations: 0,
        totalMs: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        opsPerSec: 0,
      }];
      if (!opts.json) {
        errHint(`Error in ${suiteName}: ${msg}`);
      }
    }
  }

  if (!opts.json) {
    // Clear progress line
    process.stdout.write(`\r${' '.repeat(60)}\r`);
  }

  const report = buildReport(categories);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [name, results] of Object.entries(categories)) {
      printCategory(name, results, opts);
    }
    printSummary(report, opts);
    console.log('');
  }
}
