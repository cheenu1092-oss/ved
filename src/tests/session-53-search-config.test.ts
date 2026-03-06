/**
 * Session 53 tests — `ved search` CLI + `ved config` CLI + app.search() method.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VedApp } from '../app.js';
import { validateConfig, getDefaults, getConfigDir } from '../core/config.js';
import type { VedConfig } from '../types/index.js';
import type { MergedResult } from '../rag/types.js';

// ── Helpers ──

function createTestDir(): string {
  const dir = join(tmpdir(), `ved-test-s53-${randomUUID().slice(0, 8)}`);
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
She is an expert in Rust and Go.
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

  return vault;
}

function makeConfig(baseDir: string, vaultPath: string): VedConfig {
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
      ownerIds: ['test-owner-1'],
      tribeIds: ['tribe-1'],
    },
  } as VedConfig;
}

// ── VedApp.search() Tests ──

describe('VedApp.search()', () => {
  let baseDir: string;
  let vaultPath: string;
  let app: VedApp;

  beforeEach(async () => {
    baseDir = createTestDir();
    vaultPath = createTestVault(baseDir);
    const config = makeConfig(baseDir, vaultPath);
    app = new VedApp(config);
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.stop();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns results for a matching FTS query', async () => {
    await app.reindexVault();
    const result = await app.search('software engineer', { sources: ['fts'] });
    expect(result).toBeDefined();
    expect(result.results).toBeDefined();
    expect(result.text).toBeDefined();
    expect(result.metrics).toBeDefined();
    expect(result.tokenCount).toBeGreaterThanOrEqual(0);
    // Should find alice.md
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('returns empty results for non-matching query', async () => {
    await app.reindexVault();
    const result = await app.search('xyzzy_nonexistent_gibberish_12345', { sources: ['fts'] });
    expect(result.results.length).toBe(0);
    expect(result.text).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  it('respects FTS-only source filter', async () => {
    await app.reindexVault();
    const result = await app.search('SQLite', { sources: ['fts'] });
    expect(result.metrics.vectorResultCount).toBe(0);
    expect(result.metrics.graphResultCount).toBe(0);
  });

  it('includes retrieval metrics', async () => {
    await app.reindexVault();
    const result = await app.search('distributed systems', { sources: ['fts'] });
    const m = result.metrics;
    expect(typeof m.vectorSearchMs).toBe('number');
    expect(typeof m.ftsSearchMs).toBe('number');
    expect(typeof m.graphWalkMs).toBe('number');
    expect(typeof m.fusionMs).toBe('number');
    expect(typeof m.totalMs).toBe('number');
    expect(m.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('throws if app not initialized', async () => {
    const baseDir2 = createTestDir();
    const config2 = makeConfig(baseDir2, vaultPath);
    const uninitApp = new VedApp(config2);
    // Don't call init
    await expect(uninitApp.search('test')).rejects.toThrow('not initialized');
    rmSync(baseDir2, { recursive: true, force: true });
  });

  it('results contain filePath, content, rrfScore, and sources', async () => {
    await app.reindexVault();
    const result = await app.search('RAG Pipeline', { sources: ['fts'] });
    if (result.results.length > 0) {
      const first: MergedResult = result.results[0];
      expect(typeof first.filePath).toBe('string');
      expect(first.filePath.length).toBeGreaterThan(0);
      expect(typeof first.content).toBe('string');
      expect(first.content.length).toBeGreaterThan(0);
      expect(first.rrfScore).toBeGreaterThan(0);
      expect(Array.isArray(first.sources)).toBe(true);
      expect(first.sources.length).toBeGreaterThan(0);
    }
  });

  it('FTS finds content across multiple vault files', async () => {
    await app.reindexVault();
    // "SQLite" appears in decisions file, search should find it
    const result = await app.search('SQLite WAL mode', { sources: ['fts'] });
    const filePaths = result.results.map(r => r.filePath);
    // Should find the decisions file
    expect(filePaths.some(p => p.includes('use-sqlite'))).toBe(true);
  });
});

// ── Config Validation Tests (using validateConfig directly, NOT loadConfig) ──

describe('ved config validate', () => {
  function validConfig(): VedConfig {
    const defaults = getDefaults();
    return {
      ...defaults,
      trust: {
        ...defaults.trust,
        ownerIds: ['test-owner'],
      },
    } as VedConfig;
  }

  it('reports no errors for valid config', () => {
    const cfg = validConfig();
    const errors = validateConfig(cfg);
    expect(errors.length).toBe(0);
  });

  it('reports missing ownerIds', () => {
    const cfg = validConfig();
    cfg.trust.ownerIds = [];
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'trust.ownerIds');
    expect(err).toBeDefined();
    expect(err!.code).toBe('REQUIRED');
  });

  it('reports invalid LLM provider', () => {
    const cfg = validConfig();
    (cfg.llm as any).provider = 'invalid-provider';
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'llm.provider');
    expect(err).toBeDefined();
    expect(err!.code).toBe('INVALID_VALUE');
  });

  it('reports empty model', () => {
    const cfg = validConfig();
    cfg.llm.model = '';
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'llm.model');
    expect(err).toBeDefined();
  });

  it('reports temperature out of range', () => {
    const cfg = validConfig();
    cfg.llm.temperature = 3.0;
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'llm.temperature');
    expect(err).toBeDefined();
    expect(err!.code).toBe('OUT_OF_RANGE');
  });

  it('reports no channels enabled', () => {
    const cfg = validConfig();
    cfg.channels = [{ type: 'cli', enabled: false } as any];
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'channels');
    expect(err).toBeDefined();
  });

  it('validates compression threshold < working memory', () => {
    const cfg = validConfig();
    cfg.memory.compressionThreshold = 9000;
    cfg.memory.workingMemoryMaxTokens = 8000;
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'memory.compressionThreshold');
    expect(err).toBeDefined();
  });

  it('reports empty dbPath', () => {
    const cfg = validConfig();
    cfg.dbPath = '';
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'dbPath');
    expect(err).toBeDefined();
    expect(err!.code).toBe('REQUIRED');
  });

  it('reports negative maxTokensPerMessage', () => {
    const cfg = validConfig();
    cfg.llm.maxTokensPerMessage = -1;
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'llm.maxTokensPerMessage');
    expect(err).toBeDefined();
  });

  it('reports maxTokensPerSession <= maxTokensPerMessage', () => {
    const cfg = validConfig();
    cfg.llm.maxTokensPerSession = cfg.llm.maxTokensPerMessage;
    const errors = validateConfig(cfg);
    const err = errors.find(e => e.path === 'llm.maxTokensPerSession');
    expect(err).toBeDefined();
  });
});

describe('ved config show (redaction logic)', () => {
  it('redacts API keys in serialized config', () => {
    const cfg = getDefaults();
    (cfg.llm as any).apiKey = 'sk-secret-key-12345';
    const redacted = JSON.parse(JSON.stringify(cfg));
    if (redacted.llm?.apiKey) redacted.llm.apiKey = '***REDACTED***';
    expect(redacted.llm.apiKey).toBe('***REDACTED***');
    expect(cfg.llm.apiKey).toBe('sk-secret-key-12345');
  });

  it('redacts channel tokens', () => {
    const cfg = getDefaults();
    cfg.channels = [{ type: 'discord', enabled: true, token: 'bot-token-secret' } as any];
    const redacted = JSON.parse(JSON.stringify(cfg));
    for (const ch of redacted.channels) {
      if (ch.token) ch.token = '***REDACTED***';
    }
    expect(redacted.channels[0].token).toBe('***REDACTED***');
  });

  it('handles config with null apiKey (no redaction needed)', () => {
    const cfg = getDefaults();
    cfg.llm.apiKey = null;
    const redacted = JSON.parse(JSON.stringify(cfg));
    if (redacted.llm?.apiKey) redacted.llm.apiKey = '***REDACTED***';
    expect(redacted.llm.apiKey).toBeNull();
  });
});

describe('ved config path', () => {
  it('returns a string path containing .ved', () => {
    const path = getConfigDir();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain('.ved');
  });
});

// ── Search CLI Arg Parsing Tests ──

describe('search CLI arg parsing', () => {
  function parseSearchArgs(args: string[]): {
    query: string; topK: number; verbose: boolean; ftsOnly: boolean;
  } {
    let topK = 5;
    let verbose = false;
    let ftsOnly = false;
    const queryParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
        topK = parseInt(args[i + 1], 10);
        i++;
      } else if (args[i] === '--verbose' || args[i] === '-v') {
        verbose = true;
      } else if (args[i] === '--fts-only' || args[i] === '--fts') {
        ftsOnly = true;
      } else {
        queryParts.push(args[i]);
      }
    }
    return { query: queryParts.join(' ').trim(), topK, verbose, ftsOnly };
  }

  it('parses simple query', () => {
    const r = parseSearchArgs(['hello', 'world']);
    expect(r.query).toBe('hello world');
    expect(r.topK).toBe(5);
    expect(r.verbose).toBe(false);
    expect(r.ftsOnly).toBe(false);
  });

  it('parses -n flag', () => {
    const r = parseSearchArgs(['test', '-n', '10']);
    expect(r.query).toBe('test');
    expect(r.topK).toBe(10);
  });

  it('parses --limit flag', () => {
    const r = parseSearchArgs(['--limit', '3', 'test', 'query']);
    expect(r.query).toBe('test query');
    expect(r.topK).toBe(3);
  });

  it('parses --verbose flag', () => {
    const r = parseSearchArgs(['test', '--verbose']);
    expect(r.verbose).toBe(true);
  });

  it('parses -v flag', () => {
    const r = parseSearchArgs(['-v', 'test']);
    expect(r.verbose).toBe(true);
  });

  it('parses --fts-only flag', () => {
    const r = parseSearchArgs(['test', '--fts-only']);
    expect(r.ftsOnly).toBe(true);
  });

  it('parses --fts shorthand', () => {
    const r = parseSearchArgs(['--fts', 'test']);
    expect(r.ftsOnly).toBe(true);
  });

  it('parses all flags combined', () => {
    const r = parseSearchArgs(['-n', '20', '--verbose', '--fts-only', 'multi', 'word', 'query']);
    expect(r.query).toBe('multi word query');
    expect(r.topK).toBe(20);
    expect(r.verbose).toBe(true);
    expect(r.ftsOnly).toBe(true);
  });

  it('handles empty args', () => {
    const r = parseSearchArgs([]);
    expect(r.query).toBe('');
  });
});
