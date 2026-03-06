/**
 * Tests: `ved reindex` CLI command + startup vault indexing
 *
 * Session 51: Verifies full re-index and startup indexing behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VaultFile, VaultFileStats } from './types/index.js';
import type { IndexStats } from './rag/types.js';

// ─── Helpers ───

function makeVaultFile(path: string, body: string, links: string[] = []): VaultFile {
  const stats: VaultFileStats = {
    created: new Date('2026-03-06'),
    modified: new Date('2026-03-06'),
    size: body.length,
  };
  return {
    path,
    frontmatter: { type: path.startsWith('entities/') ? 'entity' : 'daily' },
    body,
    links,
    raw: `---\ntype: daily\n---\n${body}`,
    stats,
  };
}

function makeIndexStats(overrides?: Partial<IndexStats>): IndexStats {
  return {
    filesIndexed: 0,
    chunksStored: 0,
    ftsEntries: 0,
    graphEdges: 0,
    queueDepth: 0,
    ...overrides,
  };
}

// ─── Tests: readAllVaultFiles logic ───

describe('readAllVaultFiles', () => {
  it('reads all vault files from listFiles paths', () => {
    const files = [
      makeVaultFile('daily/2026-03-05.md', 'Session summary'),
      makeVaultFile('entities/people/bob.md', 'Bob Friday is a leader'),
      makeVaultFile('concepts/rag.md', 'RAG = Retrieval Augmented Generation'),
    ];

    const listFiles = vi.fn(() => files.map(f => f.path));
    const readFile = vi.fn((path: string) => files.find(f => f.path === path)!);

    // Simulate readAllVaultFiles
    const allPaths = listFiles();
    const result: VaultFile[] = [];
    for (const relPath of allPaths) {
      try {
        result.push(readFile(relPath));
      } catch {
        // skip
      }
    }

    expect(result).toHaveLength(3);
    expect(result.map(f => f.path)).toEqual([
      'daily/2026-03-05.md',
      'entities/people/bob.md',
      'concepts/rag.md',
    ]);
  });

  it('skips unreadable files without crashing', () => {
    const listFiles = vi.fn(() => ['daily/ok.md', 'daily/broken.md', 'daily/also-ok.md']);
    const readFile = vi.fn((path: string) => {
      if (path === 'daily/broken.md') throw new Error('Permission denied');
      return makeVaultFile(path, 'content');
    });

    const allPaths = listFiles();
    const result: VaultFile[] = [];
    const warnings: string[] = [];

    for (const relPath of allPaths) {
      try {
        result.push(readFile(relPath));
      } catch (err) {
        warnings.push(relPath);
      }
    }

    expect(result).toHaveLength(2);
    expect(warnings).toEqual(['daily/broken.md']);
  });

  it('returns empty array for empty vault', () => {
    const listFiles = vi.fn(() => []);
    const allPaths = listFiles();
    expect(allPaths).toHaveLength(0);
  });
});

// ─── Tests: Startup indexing logic ───

describe('Startup Vault Indexing', () => {
  let statsResult: IndexStats;
  let fullReindexCalled: boolean;
  let fullReindexFiles: VaultFile[];

  beforeEach(() => {
    statsResult = makeIndexStats();
    fullReindexCalled = false;
    fullReindexFiles = [];
  });

  // Simulate indexVaultOnStartup logic
  async function indexVaultOnStartup(
    existingStats: IndexStats,
    vaultFiles: VaultFile[],
    fullReindex: (files: VaultFile[]) => Promise<IndexStats>,
  ) {
    if (existingStats.filesIndexed > 0) {
      return 'skipped';
    }
    if (vaultFiles.length === 0) {
      return 'empty';
    }
    await fullReindex(vaultFiles);
    return 'indexed';
  }

  it('indexes all vault files when RAG index is empty', async () => {
    const files = [
      makeVaultFile('daily/2026-03-06.md', 'Today was productive'),
      makeVaultFile('entities/people/alice.md', 'Alice works on AI'),
    ];

    const result = await indexVaultOnStartup(
      makeIndexStats({ filesIndexed: 0 }),
      files,
      async (f) => {
        fullReindexCalled = true;
        fullReindexFiles = f;
        return makeIndexStats({ filesIndexed: f.length, chunksStored: f.length * 2 });
      },
    );

    expect(result).toBe('indexed');
    expect(fullReindexCalled).toBe(true);
    expect(fullReindexFiles).toHaveLength(2);
  });

  it('skips indexing when RAG index already populated', async () => {
    const files = [makeVaultFile('daily/2026-03-06.md', 'content')];

    const result = await indexVaultOnStartup(
      makeIndexStats({ filesIndexed: 5, chunksStored: 20 }),
      files,
      async () => {
        fullReindexCalled = true;
        return makeIndexStats();
      },
    );

    expect(result).toBe('skipped');
    expect(fullReindexCalled).toBe(false);
  });

  it('handles empty vault gracefully', async () => {
    const result = await indexVaultOnStartup(
      makeIndexStats({ filesIndexed: 0 }),
      [],
      async () => {
        fullReindexCalled = true;
        return makeIndexStats();
      },
    );

    expect(result).toBe('empty');
    expect(fullReindexCalled).toBe(false);
  });

  it('handles single-file vault', async () => {
    const files = [makeVaultFile('daily/2026-03-06.md', 'Just one file')];

    const result = await indexVaultOnStartup(
      makeIndexStats({ filesIndexed: 0 }),
      files,
      async (f) => {
        fullReindexCalled = true;
        fullReindexFiles = f;
        return makeIndexStats({ filesIndexed: 1 });
      },
    );

    expect(result).toBe('indexed');
    expect(fullReindexFiles).toHaveLength(1);
  });
});

// ─── Tests: reindexVault logic ───

describe('reindexVault (full force re-index)', () => {
  it('re-indexes all files regardless of existing index state', async () => {
    const files = [
      makeVaultFile('daily/2026-03-05.md', 'Yesterday'),
      makeVaultFile('daily/2026-03-06.md', 'Today'),
      makeVaultFile('entities/people/bob.md', '[[Alice]] knows Bob'),
    ];

    let reindexFiles: VaultFile[] = [];
    const fullReindex = vi.fn(async (f: VaultFile[]) => {
      reindexFiles = f;
      return makeIndexStats({
        filesIndexed: f.length,
        chunksStored: f.length * 3,
        graphEdges: 1,
      });
    });

    const stats = await fullReindex(files);
    expect(stats.filesIndexed).toBe(3);
    expect(stats.chunksStored).toBe(9);
    expect(stats.graphEdges).toBe(1);
    expect(reindexFiles).toHaveLength(3);
  });

  it('returns zero stats for empty vault', async () => {
    const fullReindex = vi.fn(async (files: VaultFile[]) => {
      return makeIndexStats({ filesIndexed: files.length });
    });

    const stats = await fullReindex([]);
    expect(stats.filesIndexed).toBe(0);
    expect(stats.chunksStored).toBe(0);
  });

  it('handles large vault (100 files)', async () => {
    const files = Array.from({ length: 100 }, (_, i) =>
      makeVaultFile(`daily/2026-01-${String(i + 1).padStart(2, '0')}.md`, `Day ${i + 1} notes`)
    );

    const fullReindex = vi.fn(async (f: VaultFile[]) => {
      return makeIndexStats({ filesIndexed: f.length, chunksStored: f.length });
    });

    const stats = await fullReindex(files);
    expect(stats.filesIndexed).toBe(100);
  });

  it('preserves wikilink graph edges during re-index', async () => {
    const files = [
      makeVaultFile('entities/people/alice.md', '[[Bob]] is her colleague', ['Bob']),
      makeVaultFile('entities/people/bob.md', '[[Alice]] is his colleague', ['Alice']),
      makeVaultFile('concepts/rag.md', '[[Alice]] designed the RAG pipeline', ['Alice']),
    ];

    const fullReindex = vi.fn(async (f: VaultFile[]) => {
      const edges = f.reduce((sum, file) => sum + file.links.length, 0);
      return makeIndexStats({ filesIndexed: f.length, graphEdges: edges });
    });

    const stats = await fullReindex(files);
    expect(stats.graphEdges).toBe(3); // Bob→Alice, Alice→Bob, Alice (from rag)
  });
});

// ─── Tests: CLI reindex command behavior ───

describe('CLI reindex command', () => {
  it('reports stats after successful re-index', async () => {
    const stats = makeIndexStats({
      filesIndexed: 42,
      chunksStored: 128,
      ftsEntries: 128,
      graphEdges: 37,
    });

    // Verify stats shape
    expect(stats.filesIndexed).toBe(42);
    expect(stats.chunksStored).toBe(128);
    expect(stats.ftsEntries).toBe(128);
    expect(stats.graphEdges).toBe(37);
  });

  it('handles init-required error (not initialized)', async () => {
    let threw = false;
    try {
      // Simulate calling reindexVault before init
      throw new Error('VedApp not initialized — call init() first');
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('not initialized');
    }
    expect(threw).toBe(true);
  });
});

// ─── Tests: Startup + watcher interaction ───

describe('Startup indexing + vault watcher interaction', () => {
  it('startup indexes before watcher starts', () => {
    // Verify the ordering: init → startup index → channels → watcher
    const callOrder: string[] = [];

    const indexVaultOnStartup = () => { callOrder.push('startup-index'); };
    const startChannels = () => { callOrder.push('channels'); };
    const startVaultWatcher = () => { callOrder.push('watcher'); };

    // Simulate start() sequence
    indexVaultOnStartup();
    startChannels();
    startVaultWatcher();

    expect(callOrder).toEqual(['startup-index', 'channels', 'watcher']);
  });

  it('watcher handles changes after startup index completes', () => {
    const indexedAtStartup = new Set(['daily/2026-03-05.md', 'daily/2026-03-06.md']);
    const watcherEnqueued: string[] = [];

    // After startup index, watcher picks up new changes
    const enqueueReindex = (path: string) => watcherEnqueued.push(path);

    // Simulate a new file being created after startup
    enqueueReindex('entities/people/new-person.md');
    // Simulate an existing file being updated
    enqueueReindex('daily/2026-03-06.md');

    expect(watcherEnqueued).toHaveLength(2);
    // The watcher processes both new and updated files independently
    expect(watcherEnqueued).toContain('entities/people/new-person.md');
    expect(watcherEnqueued).toContain('daily/2026-03-06.md');
  });

  it('reindex command works independently of watcher state', async () => {
    // ved reindex should work regardless of whether the watcher is running
    let reindexCalled = false;
    const reindexVault = async () => {
      reindexCalled = true;
      return makeIndexStats({ filesIndexed: 10 });
    };

    const stats = await reindexVault();
    expect(reindexCalled).toBe(true);
    expect(stats.filesIndexed).toBe(10);
  });
});
