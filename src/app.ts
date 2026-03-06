/**
 * VedApp — Top-level application wiring.
 *
 * Creates, initializes, and wires all modules together.
 * Provides the main `start()` / `stop()` lifecycle.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './core/log.js';
import { loadConfig } from './core/config.js';
import { migrate } from './db/migrate.js';
import { EventLoop } from './core/event-loop.js';
import { LLMClient } from './llm/client.js';
import { MCPClient } from './mcp/client.js';
import { MemoryManager } from './memory/manager.js';
import { VaultManager } from './memory/vault.js';
import { RagPipeline } from './rag/pipeline.js';
import { ChannelManager } from './channel/manager.js';
import type { VedConfig, ModuleHealth, VaultFile } from './types/index.js';
import type { IndexStats, RetrieveOptions, RetrievalContext } from './rag/types.js';
import type { VaultExport, VaultExportFile, ExportOptions, ImportResult } from './export-types.js';

const log = createLogger('app');

export interface VedAppOptions {
  /** Override config (merged on top of files + env) */
  configOverrides?: Partial<VedConfig>;
  /** Skip config validation (for testing) */
  skipValidation?: boolean;
}

export class VedApp {
  readonly config: VedConfig;

  // Database
  private db: Database.Database | null = null;

  // Modules
  readonly eventLoop: EventLoop;
  readonly llm: LLMClient;
  readonly mcp: MCPClient;
  readonly memory: MemoryManager;
  readonly rag: RagPipeline;
  readonly channels: ChannelManager;

  private initialized = false;

  constructor(config: VedConfig) {
    this.config = config;

    // Open database
    const dbDir = dirname(config.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // Run migrations
    const applied = migrate(this.db);
    if (applied > 0) {
      log.info(`Applied ${applied} migration(s)`);
    }

    // Create modules
    this.llm = new LLMClient();
    this.mcp = new MCPClient();
    const vault = new VaultManager(config.memory.vaultPath, config.memory.gitEnabled);
    this.memory = new MemoryManager(vault);
    this.rag = new RagPipeline();
    this.channels = new ChannelManager();

    // Create event loop (owns audit, trust, sessions, queue)
    this.eventLoop = new EventLoop({
      config,
      db: this.db,
    });
  }

  /**
   * Initialize all modules. Must be called before start().
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    log.info('Initializing modules...');

    // Initialize independent modules in parallel
    await Promise.all([
      this.llm.init(this.config),
      this.mcp.init(this.config),
      this.memory.init(this.config),
      this.channels.init(this.config),
    ]);

    // RAG needs special init (database handle + embedder check)
    await this.rag.init(this.config);
    this.rag.setDatabase(this.db!);

    // Discover MCP tools
    const tools = await this.mcp.discoverTools();
    log.info(`Discovered ${tools.length} MCP tools`);

    // Wire modules into event loop
    this.eventLoop.setModules({
      llm: this.llm,
      mcp: this.mcp,
      memory: this.memory,
      rag: this.rag,
      channels: this.channels,
    });

    this.initialized = true;
    log.info('All modules initialized');
  }

  /**
   * Start Ved: init all modules, start channels, enter event loop.
   * Blocks until stop() is called.
   */
  async start(): Promise<void> {
    await this.init();

    // Auto-commit any dirty vault files before indexing
    this.autoCommitVault();

    // Index all existing vault files into RAG before entering event loop
    await this.indexVaultOnStartup();

    // Start channel adapters (Discord, CLI, etc.)
    await this.channels.startAll();

    // Wire channel messages → event loop
    this.channels.onMessage((msg) => {
      this.eventLoop.receive(msg);
    });

    // Start vault filesystem watcher → RAG re-index on changes
    this.startVaultWatcher();

    log.info('Ved is running');

    // Enter the main event loop (blocks)
    await this.eventLoop.run();
  }

  /**
   * Request graceful shutdown.
   */
  async stop(): Promise<void> {
    log.info('Stopping Ved...');

    // Stop vault watcher
    this.stopVaultWatcher();

    // Stop event loop (completes current message)
    this.eventLoop.requestShutdown();

    // Stop channels
    await this.channels.stopAll();

    // Shutdown modules
    await Promise.allSettled([
      this.llm.shutdown(),
      this.mcp.shutdown(),
      this.memory.shutdown(),
      this.rag.shutdown(),
      this.channels.shutdown(),
    ]);

    // Close database
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    log.info('Ved stopped');
  }

  /**
   * Health check across all modules.
   */
  async healthCheck(): Promise<{ healthy: boolean; modules: ModuleHealth[] }> {
    const results = await Promise.all([
      this.eventLoop.healthCheck(),
      this.llm.healthCheck(),
      this.mcp.healthCheck(),
      this.memory.healthCheck(),
      this.rag.healthCheck(),
      this.channels.healthCheck(),
    ]);

    const healthy = results.every(r => r.healthy);
    return { healthy, modules: results };
  }

  // ── Stats ──

  /**
   * Get comprehensive system stats for `ved stats` CLI.
   */
  getStats(): {
    rag: IndexStats;
    vault: { fileCount: number; tagCount: number; typeCount: number; gitClean: boolean; gitDirtyCount: number };
    audit: { chainLength: number; chainHead: string };
    sessions: { active: number; total: number };
  } {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    // RAG stats
    const rag = this.rag.stats();

    // Vault stats
    const vaultIndex = this.memory.vault.getIndex();
    const vault = {
      fileCount: vaultIndex.files.size,
      tagCount: vaultIndex.tags.size,
      typeCount: vaultIndex.types.size,
      gitClean: this.memory.vault.git.isClean(),
      gitDirtyCount: this.memory.vault.git.dirtyCount,
    };

    // Audit stats
    const chainHead = this.eventLoop.audit.getChainHead();
    const audit = {
      chainLength: chainHead.count,
      chainHead: chainHead.hash.slice(0, 12),
    };

    // Session stats
    const activeSessions = (this.db!.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE status IN ('active', 'idle')"
    ).get() as { cnt: number }).cnt;
    const totalSessions = (this.db!.prepare(
      'SELECT COUNT(*) as cnt FROM sessions'
    ).get() as { cnt: number }).cnt;
    const sessions = { active: activeSessions, total: totalSessions };

    return { rag, vault, audit, sessions };
  }

  /**
   * Search the vault via RAG pipeline (vector + FTS + graph fusion).
   * Used by `ved search` CLI command.
   */
  async search(query: string, options?: RetrieveOptions): Promise<RetrievalContext> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }
    return this.rag.retrieve(query, options);
  }

  // ── Export / Import ──

  /**
   * Export the vault to a portable JSON object.
   * Used by `ved export` CLI command.
   */
  async exportVault(options?: ExportOptions): Promise<VaultExport> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    const files = this.readAllVaultFiles(options?.folder);
    const exportFiles: VaultExportFile[] = files.map(f => ({
      path: f.path,
      frontmatter: f.frontmatter,
      body: f.body,
      links: f.links,
    }));

    const result: VaultExport = {
      vedVersion: '0.1.0',
      exportedAt: new Date().toISOString(),
      vaultPath: this.config.memory.vaultPath,
      fileCount: exportFiles.length,
      files: exportFiles,
    };

    if (options?.includeAudit) {
      const chainHead = this.eventLoop.audit.getChainHead();
      result.audit = {
        chainLength: chainHead.count,
        chainHead: chainHead.hash,
        entries: chainHead.count,
      };
    }

    if (options?.includeStats) {
      const s = this.getStats();
      result.stats = {
        rag: {
          filesIndexed: s.rag.filesIndexed,
          chunksStored: s.rag.chunksStored,
          ftsEntries: s.rag.ftsEntries,
          graphEdges: s.rag.graphEdges,
        },
        vault: {
          fileCount: s.vault.fileCount,
          tagCount: s.vault.tagCount,
          typeCount: s.vault.typeCount,
        },
        sessions: {
          active: s.sessions.active,
          total: s.sessions.total,
        },
      };
    }

    return result;
  }

  /**
   * Import vault files from a JSON export.
   * Used by `ved import` CLI command.
   */
  async importVault(data: VaultExport, mode: 'merge' | 'overwrite' | 'fail' = 'fail'): Promise<ImportResult> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    const result: ImportResult = { created: 0, overwritten: 0, skipped: 0, errors: 0, errorPaths: [] };
    const vault = this.memory.vault;

    for (const f of data.files) {
      try {
        // Validate path containment BEFORE any filesystem operations
        vault.assertPathSafe(f.path);

        const exists = vault.exists(f.path);

        if (exists) {
          if (mode === 'merge') {
            result.skipped++;
            continue;
          } else if (mode === 'overwrite') {
            vault.updateFile(f.path, { frontmatter: f.frontmatter, body: f.body });
            result.overwritten++;
          } else {
            // mode === 'fail'
            result.skipped++;
            continue;
          }
        } else {
          vault.createFile(f.path, f.frontmatter, f.body);
          result.created++;
        }
      } catch (err) {
        result.errors++;
        result.errorPaths.push(f.path);
        log.warn('Failed to import vault file', {
          path: f.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Check if a vault file exists. Used by dry-run import.
   */
  vaultFileExists(path: string): boolean {
    return this.memory.vault.exists(path);
  }

  // ── Vault Indexing ──

  /**
   * Read all vault files and return them as VaultFile objects.
   */
  private readAllVaultFiles(folder?: string): VaultFile[] {
    const vault = this.memory.vault;
    const allPaths = vault.listFiles(folder);
    const files: VaultFile[] = [];

    for (const relPath of allPaths) {
      try {
        const file = vault.readFile(relPath);
        files.push(file);
      } catch (err) {
        log.warn('Failed to read vault file for indexing', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return files;
  }

  /**
   * Index vault files into RAG on startup.
   * - If index is empty → full reindex.
   * - If index is populated → incremental (only files modified since last indexed_at).
   */
  private async indexVaultOnStartup(): Promise<void> {
    const existingStats = this.rag.stats();

    const files = this.readAllVaultFiles();
    if (files.length === 0) {
      log.info('No vault files found, skipping startup indexing');
      return;
    }

    if (existingStats.filesIndexed === 0) {
      // Empty index → full reindex
      log.info('RAG index empty, performing full startup indexing...', { fileCount: files.length });
      const startTime = Date.now();
      const stats = await this.rag.fullReindex(files);
      const elapsed = Date.now() - startTime;

      log.info('Full startup indexing complete', {
        filesIndexed: stats.filesIndexed,
        chunksStored: stats.chunksStored,
        graphEdges: stats.graphEdges,
        elapsedMs: elapsed,
      });
      return;
    }

    // Populated index → incremental: only re-index files modified since their last indexed_at
    const staleFiles = this.findStaleFiles(files);

    if (staleFiles.length === 0) {
      log.info('All vault files up-to-date in RAG index', {
        filesIndexed: existingStats.filesIndexed,
      });
      return;
    }

    log.info('Incremental startup indexing...', {
      staleFiles: staleFiles.length,
      totalFiles: files.length,
    });

    const startTime = Date.now();
    for (const file of staleFiles) {
      await this.rag.indexFile(file);
    }
    const elapsed = Date.now() - startTime;

    log.info('Incremental startup indexing complete', {
      reindexed: staleFiles.length,
      elapsedMs: elapsed,
    });
  }

  /**
   * Find vault files that have been modified since they were last indexed.
   * Also returns files not yet in the index.
   */
  private findStaleFiles(files: VaultFile[]): VaultFile[] {
    const stale: VaultFile[] = [];

    for (const file of files) {
      const fileMtime = file.stats.modified.getTime();
      const indexedAt = this.getFileIndexedAt(file.path);

      if (indexedAt === null || fileMtime > indexedAt) {
        stale.push(file);
      }
    }

    return stale;
  }

  /**
   * Get the indexed_at timestamp for a file from the RAG chunks table.
   * Returns null if file is not indexed.
   */
  private getFileIndexedAt(filePath: string): number | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      'SELECT MAX(indexed_at) as indexed_at FROM chunks WHERE file_path = ?'
    ).get(filePath) as { indexed_at: number | null } | undefined;
    return row?.indexed_at ?? null;
  }

  /**
   * Force full RAG re-index of all vault files.
   * Used by `ved reindex` CLI command.
   */
  async reindexVault(): Promise<IndexStats> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }

    const files = this.readAllVaultFiles();
    log.info('Starting full vault re-index...', { fileCount: files.length });

    const startTime = Date.now();
    const stats = await this.rag.fullReindex(files);
    const elapsed = Date.now() - startTime;

    log.info('Full vault re-index complete', {
      filesIndexed: stats.filesIndexed,
      chunksStored: stats.chunksStored,
      graphEdges: stats.graphEdges,
      elapsedMs: elapsed,
    });

    return stats;
  }

  // ── Vault Git ──

  /**
   * Auto-commit any untracked/modified vault files on startup.
   * Ensures git state is clean before indexing begins.
   */
  private autoCommitVault(): void {
    const git = this.memory.vault.git;
    if (!git.isRepo) return;

    if (git.isClean()) {
      log.debug('Vault git is clean, no auto-commit needed');
      return;
    }

    // Stage all untracked/modified files and commit
    try {
      git.stage(['.']);
      git.commit('ved: startup auto-commit — uncommitted changes found');
      log.info('Auto-committed dirty vault files on startup');
    } catch (err) {
      log.warn('Vault auto-commit failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Vault Watcher ──

  private vaultDrainInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Wire vault file changes → RAG re-index queue.
   * Starts the vault filesystem watcher and a periodic drain loop.
   */
  private startVaultWatcher(): void {
    const vault = this.memory.vault;

    // Register handler: enqueue changed files for RAG re-index
    vault.onFileChanged((path: string, changeType: 'create' | 'update' | 'delete') => {
      if (changeType === 'delete') {
        this.rag.removeFile(path);
        log.debug('Vault file removed from RAG index', { path });
      } else {
        this.rag.enqueueReindex(path);
        log.debug('Vault file queued for RAG re-index', { path, changeType });
      }
    });

    // Start filesystem watch
    vault.startWatch();

    // Drain re-index queue every 10 seconds
    this.vaultDrainInterval = setInterval(async () => {
      try {
        const processed = await this.rag.drainQueue(async (p: string) => {
          try {
            return vault.readFile(p);
          } catch {
            return null;
          }
        });
        if (processed > 0) {
          log.info('RAG re-index drained', { processed });
        }
      } catch (err) {
        log.warn('RAG drain failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }, 10_000);

    // Unref so timer doesn't prevent process exit
    this.vaultDrainInterval.unref();

    log.info('Vault watcher started — file changes will trigger RAG re-indexing');
  }

  /**
   * Stop the vault watcher and drain timer.
   */
  private stopVaultWatcher(): void {
    if (this.vaultDrainInterval) {
      clearInterval(this.vaultDrainInterval);
      this.vaultDrainInterval = null;
    }

    this.memory.vault.stopWatch();
    log.info('Vault watcher stopped');
  }
}

/**
 * Create a VedApp with config loaded from files + env + overrides.
 */
export function createApp(options?: VedAppOptions): VedApp {
  const config = loadConfig(options?.configOverrides);
  return new VedApp(config);
}
