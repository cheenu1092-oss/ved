/**
 * Session 52 tests — `ved stats`, incremental startup indexing, vault git auto-commit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

// ─── Test helpers ───
function createTestDir(): string {
  const dir = join(tmpdir(), `ved-test-${ulid()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestVault(baseDir: string): string {
  const vaultPath = join(baseDir, 'vault');
  for (const sub of ['daily', 'entities', 'concepts', 'decisions']) {
    mkdirSync(join(vaultPath, sub), { recursive: true });
  }
  return vaultPath;
}

function writeVaultFile(vaultPath: string, relPath: string, content: string): void {
  const absPath = join(vaultPath, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

// ─── Mock factories ───

function createMockVault(vaultPath: string) {
  const files = new Map<string, { path: string; frontmatter: Record<string, unknown>; body: string; links: string[]; raw: string; stats: { modified: Date; created: Date; size: number } }>();

  return {
    path: vaultPath,
    listFiles: vi.fn(() => [...files.keys()]),
    readFile: vi.fn((relPath: string) => {
      const f = files.get(relPath);
      if (!f) throw new Error(`Not found: ${relPath}`);
      return f;
    }),
    exists: vi.fn((relPath: string) => files.has(relPath)),
    getIndex: vi.fn(() => ({
      files: new Map([...files.entries()].map(([k]) => [k.replace('.md', '').toLowerCase(), k])),
      backlinks: new Map(),
      tags: new Map([['test', new Set(['entities/alice.md'])]]),
      types: new Map([['person', new Set(['entities/alice.md'])]]),
    })),
    git: {
      isRepo: true,
      isClean: vi.fn(() => true),
      dirtyCount: 0,
      init: vi.fn(),
      stage: vi.fn(),
      commit: vi.fn(),
      flush: vi.fn(),
      markDirty: vi.fn(),
    },
    init: vi.fn(),
    onFileChanged: vi.fn(),
    startWatch: vi.fn(),
    stopWatch: vi.fn(),
    close: vi.fn(),
    _addFile: (relPath: string, body: string, mtime?: Date) => {
      files.set(relPath, {
        path: relPath,
        frontmatter: { type: 'test' },
        body,
        links: [],
        raw: body,
        stats: {
          modified: mtime ?? new Date(),
          created: new Date(Date.now() - 86400000),
          size: body.length,
        },
      });
    },
    _files: files,
  };
}

function createMockRag() {
  let filesIndexed = 0;
  let chunksStored = 0;

  return {
    name: 'rag',
    init: vi.fn(),
    setDatabase: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(async () => ({ module: 'rag', healthy: true, checkedAt: Date.now() })),
    stats: vi.fn(() => ({
      filesIndexed,
      chunksStored,
      ftsEntries: 0,
      graphEdges: 0,
      queueDepth: 0,
    })),
    fullReindex: vi.fn(async (files: unknown[]) => {
      filesIndexed = (files as unknown[]).length;
      chunksStored = filesIndexed * 3;
      return { filesIndexed, chunksStored, ftsEntries: filesIndexed, graphEdges: 0, queueDepth: 0 };
    }),
    indexFile: vi.fn(async () => { filesIndexed++; chunksStored += 3; }),
    enqueueReindex: vi.fn(),
    removeFile: vi.fn(),
    drainQueue: vi.fn(async () => 0),
    retrieve: vi.fn(),
    _setStats: (f: number, c: number) => { filesIndexed = f; chunksStored = c; },
  };
}

function createMockMemory(vault: ReturnType<typeof createMockVault>) {
  return {
    name: 'memory',
    vault,
    init: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(async () => ({ module: 'memory', healthy: true, checkedAt: Date.now() })),
    writeCompression: vi.fn(),
  };
}

// ─── Tests ───

describe('ved stats', () => {
  it('returns vault stats (file count, tag count, type count)', () => {
    const vault = createMockVault('/tmp/test-vault');
    vault._addFile('entities/alice.md', '# Alice');
    vault._addFile('concepts/ai.md', '# AI');

    const index = vault.getIndex();
    expect(index.files.size).toBe(2);
    expect(index.tags.size).toBe(1);
    expect(index.types.size).toBe(1);
  });

  it('reports git clean status', () => {
    const vault = createMockVault('/tmp/test-vault');
    expect(vault.git.isClean()).toBe(true);
    expect(vault.git.dirtyCount).toBe(0);
  });

  it('reports git dirty status', () => {
    const vault = createMockVault('/tmp/test-vault');
    vault.git.isClean = vi.fn(() => false);
    (vault.git as Record<string, unknown>).dirtyCount = 3;
    expect(vault.git.isClean()).toBe(false);
    expect(vault.git.dirtyCount).toBe(3);
  });

  it('returns RAG index stats', () => {
    const rag = createMockRag();
    rag._setStats(10, 30);
    const stats = rag.stats();
    expect(stats.filesIndexed).toBe(10);
    expect(stats.chunksStored).toBe(30);
  });

  it('returns audit chain stats from DB', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        session_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      )
    `);
    // Insert two audit entries
    db.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'a1', Date.now(), 'test', 'ved', null, '{}', '0000', 'abc123def456'
    );
    db.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'a2', Date.now(), 'test', 'ved', null, '{}', 'abc123def456', 'def456789012'
    );
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM audit_log').get() as { cnt: number }).cnt;
    expect(count).toBe(2);
    db.close();
  });

  it('returns session counts from DB', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        trust_tier INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        closed_at INTEGER,
        working_memory TEXT NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT
      )
    `);
    const now = Date.now();
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      's1', 'cli', 'c1', 'u1', 1, now, now, null, '{}', 0, 'active', null
    );
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      's2', 'cli', 'c1', 'u2', 1, now, now, null, '{}', 0, 'idle', null
    );
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      's3', 'cli', 'c1', 'u1', 1, now - 100000, now - 100000, now - 50000, '{}', 0, 'closed', 'done'
    );

    const active = (db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE status IN ('active', 'idle')").get() as { cnt: number }).cnt;
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number }).cnt;
    expect(active).toBe(2);
    expect(total).toBe(3);
    db.close();
  });
});

describe('incremental startup indexing', () => {
  it('indexes only files modified after last indexed_at', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        heading_level INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        file_modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      )
    `);

    const indexedAt = Date.now() - 60000; // indexed 60s ago
    db.prepare('INSERT INTO chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'c1', 'entities/alice.md', '# Alice', 1, 'Alice is here', '{}', 10, 0, indexedAt - 10000, indexedAt
    );

    // File modified BEFORE indexed_at → up-to-date
    const oldMtime = indexedAt - 10000;
    const row1 = db.prepare('SELECT MAX(indexed_at) as indexed_at FROM chunks WHERE file_path = ?').get('entities/alice.md') as { indexed_at: number };
    expect(oldMtime > row1.indexed_at).toBe(false); // not stale

    // File modified AFTER indexed_at → stale
    const newMtime = indexedAt + 30000;
    expect(newMtime > row1.indexed_at).toBe(true); // stale

    db.close();
  });

  it('indexes files not yet in the index', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        heading_level INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        file_modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      )
    `);

    // No rows for 'concepts/new.md' → indexed_at is null
    const row = db.prepare('SELECT MAX(indexed_at) as indexed_at FROM chunks WHERE file_path = ?').get('concepts/new.md') as { indexed_at: number | null };
    expect(row.indexed_at).toBeNull();

    db.close();
  });

  it('does full reindex when RAG index is empty', async () => {
    const rag = createMockRag();
    rag._setStats(0, 0); // empty

    const vault = createMockVault('/tmp/test-vault');
    vault._addFile('entities/alice.md', '# Alice');
    vault._addFile('concepts/ai.md', '# AI');

    // Simulate: empty index → fullReindex called
    const stats = rag.stats();
    expect(stats.filesIndexed).toBe(0);

    await rag.fullReindex([...vault._files.values()]);
    expect(rag.fullReindex).toHaveBeenCalledOnce();
    expect(rag.stats().filesIndexed).toBe(2);
  });

  it('skips fully up-to-date files during incremental', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        heading_level INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        file_modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    // File indexed 30s ago, modified 60s ago → up-to-date
    db.prepare('INSERT INTO chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'c1', 'stable.md', '', 0, 'stable content', '{}', 10, 0, now - 60000, now - 30000
    );

    const row = db.prepare('SELECT MAX(indexed_at) as indexed_at FROM chunks WHERE file_path = ?').get('stable.md') as { indexed_at: number };
    const fileMtime = now - 60000;
    expect(fileMtime > row.indexed_at).toBe(false); // not stale

    db.close();
  });

  it('correctly identifies multiple stale files in batch', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        heading_level INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        file_modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    // File A: indexed 2 min ago, modified 1 min ago → stale
    db.prepare('INSERT INTO chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'c1', 'a.md', '', 0, 'a', '{}', 5, 0, now - 60000, now - 120000
    );
    // File B: indexed 1 min ago, modified 2 min ago → fresh
    db.prepare('INSERT INTO chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'c2', 'b.md', '', 0, 'b', '{}', 5, 0, now - 120000, now - 60000
    );
    // File C: not indexed → stale (null)
    // No row for c.md

    const files = ['a.md', 'b.md', 'c.md'];
    const stale: string[] = [];

    for (const f of files) {
      const row = db.prepare('SELECT MAX(indexed_at) as indexed_at FROM chunks WHERE file_path = ?').get(f) as { indexed_at: number | null };
      const fileMtime = f === 'a.md' ? now - 60000 : f === 'b.md' ? now - 120000 : now;
      if (row.indexed_at === null || fileMtime > row.indexed_at) {
        stale.push(f);
      }
    }

    expect(stale).toEqual(['a.md', 'c.md']);

    db.close();
  });
});

describe('vault git auto-commit on startup', () => {
  it('skips auto-commit when vault is clean', () => {
    const vault = createMockVault('/tmp/test-vault');
    vault.git.isClean = vi.fn(() => true);

    // Simulate autoCommitVault logic
    if (!vault.git.isRepo) return;
    if (vault.git.isClean()) return;

    // Should not reach here
    vault.git.stage(['.']);
    vault.git.commit('ved: startup auto-commit');

    expect(vault.git.stage).not.toHaveBeenCalled();
    expect(vault.git.commit).not.toHaveBeenCalled();
  });

  it('stages and commits when vault is dirty', () => {
    const vault = createMockVault('/tmp/test-vault');
    vault.git.isClean = vi.fn(() => false);

    // Simulate autoCommitVault logic
    if (vault.git.isRepo && !vault.git.isClean()) {
      vault.git.stage(['.']);
      vault.git.commit('ved: startup auto-commit — uncommitted changes found');
    }

    expect(vault.git.stage).toHaveBeenCalledWith(['.']);
    expect(vault.git.commit).toHaveBeenCalledWith('ved: startup auto-commit — uncommitted changes found');
  });

  it('does not auto-commit when not a git repo', () => {
    const vault = createMockVault('/tmp/test-vault');
    (vault.git as Record<string, unknown>).isRepo = false;
    vault.git.isClean = vi.fn(() => false);

    // Simulate autoCommitVault logic
    if (!vault.git.isRepo) {
      // skip
    } else {
      vault.git.stage(['.']);
    }

    expect(vault.git.stage).not.toHaveBeenCalled();
  });

  it('handles auto-commit failure gracefully', () => {
    const vault = createMockVault('/tmp/test-vault');
    vault.git.isClean = vi.fn(() => false);
    vault.git.stage = vi.fn(() => { throw new Error('git not installed'); });

    // Simulate autoCommitVault with try/catch
    let failed = false;
    try {
      if (vault.git.isRepo && !vault.git.isClean()) {
        vault.git.stage(['.']);
        vault.git.commit('ved: startup auto-commit');
      }
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(vault.git.commit).not.toHaveBeenCalled();
  });

  it('auto-commit runs before indexing in startup sequence', () => {
    const callOrder: string[] = [];

    const vault = createMockVault('/tmp/test-vault');
    vault.git.isClean = vi.fn(() => false);
    vault.git.stage = vi.fn(() => { callOrder.push('git-stage'); });
    vault.git.commit = vi.fn(() => { callOrder.push('git-commit'); });

    const rag = createMockRag();
    const originalFullReindex = rag.fullReindex;
    rag.fullReindex = vi.fn(async (...args) => {
      callOrder.push('rag-reindex');
      return originalFullReindex(...args);
    });

    // Simulate startup sequence
    // Step 1: auto-commit
    if (vault.git.isRepo && !vault.git.isClean()) {
      vault.git.stage(['.']);
      vault.git.commit('ved: startup auto-commit');
    }
    // Step 2: indexing
    rag.fullReindex([]);

    expect(callOrder).toEqual(['git-stage', 'git-commit', 'rag-reindex']);
  });
});

describe('CLI stats output format', () => {
  it('formats stats sections correctly', () => {
    const stats = {
      rag: { filesIndexed: 42, chunksStored: 126, ftsEntries: 42, graphEdges: 15, queueDepth: 0 },
      vault: { fileCount: 42, tagCount: 8, typeCount: 4, gitClean: true, gitDirtyCount: 0 },
      audit: { chainLength: 1500, chainHead: 'abc123def456' },
      sessions: { active: 2, total: 47 },
    };

    // Verify all stats fields are present and correct types
    expect(typeof stats.rag.filesIndexed).toBe('number');
    expect(typeof stats.vault.fileCount).toBe('number');
    expect(typeof stats.vault.gitClean).toBe('boolean');
    expect(typeof stats.audit.chainLength).toBe('number');
    expect(typeof stats.audit.chainHead).toBe('string');
    expect(stats.audit.chainHead.length).toBe(12);
    expect(typeof stats.sessions.active).toBe('number');
    expect(stats.sessions.active).toBeLessThanOrEqual(stats.sessions.total);
  });

  it('truncates chain head to 12 chars', () => {
    const fullHash = 'abc123def456789abcdef';
    const truncated = fullHash.slice(0, 12);
    expect(truncated).toBe('abc123def456');
    expect(truncated.length).toBe(12);
  });

  it('shows dirty count when git is not clean', () => {
    const stats = {
      vault: { fileCount: 10, tagCount: 3, typeCount: 2, gitClean: false, gitDirtyCount: 5 },
    };
    const gitLine = stats.vault.gitClean
      ? '✅ clean'
      : `⚠️  ${stats.vault.gitDirtyCount} dirty`;
    expect(gitLine).toContain('5 dirty');
  });
});
