/**
 * VedApp — Top-level application wiring.
 *
 * Creates, initializes, and wires all modules together.
 * Provides the main `start()` / `stop()` lifecycle.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createLogger, initLogger } from './core/log.js';
import { loadConfig, validateConfig, getConfigDir } from './core/config.js';
import { migrate, currentVersion, verifyMigrations } from './db/migrate.js';
import { EventLoop } from './core/event-loop.js';
import { CronScheduler, type CronJob, type CronJobInput, type CronRunResult, type CronHistoryEntry } from './core/cron.js';
import { LLMClient } from './llm/client.js';
import { MCPClient } from './mcp/client.js';
import { MemoryManager } from './memory/manager.js';
import { VaultManager } from './memory/vault.js';
import { RagPipeline } from './rag/pipeline.js';
import { ChannelManager } from './channel/manager.js';
import { VedError } from './types/errors.js';
import type { VedConfig, ModuleHealth, VaultFile, AuditEntry, WorkOrder, VedMessage, VedResponse } from './types/index.js';
import type { IndexStats, RetrieveOptions, RetrievalContext } from './rag/types.js';
import type { VaultExport, VaultExportFile, ExportOptions, ImportResult } from './export-types.js';
import type { MCPServerConfig, MCPToolDefinition, ServerInfo } from './mcp/types.js';
import { EventBus } from './event-bus.js';
import { WebhookManager } from './webhook.js';
import type { Webhook, WebhookInput, WebhookDelivery, WebhookStats } from './webhook.js';
import { installCompletions, detectShell } from './completions-installer.js';

const log = createLogger('app');

export interface VedAppOptions {
  /** Override config (merged on top of files + env) */
  configOverrides?: Partial<VedConfig>;
  /** Skip config validation (for testing) */
  skipValidation?: boolean;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fixable?: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passed: number;
  warned: number;
  failed: number;
  infos: number;
}

export interface PluginTestResult {
  serverName: string;
  success: boolean;
  toolCount: number;
  tools: string[];
  durationMs: number;
  error?: string;
}

export interface GcStatus {
  staleSessions: number;
  staleSessionIds: string[];
  oldAuditEntries: number;
  oldAuditCutoff: number;
  auditWarning?: string;
}

export interface GcResult {
  sessionsClosed: number;
  auditEntriesDeleted: number;
  vacuumed: boolean;
  durationMs: number;
}

export class VedApp {
  readonly config: VedConfig;

  // Database
  private db: Database.Database | null = null;

  // Modules
  readonly eventLoop: EventLoop;
  readonly cron: CronScheduler;
  readonly llm: LLMClient;
  readonly mcp: MCPClient;
  readonly memory: MemoryManager;
  readonly rag: RagPipeline;
  readonly channels: ChannelManager;
  readonly eventBus: EventBus;
  readonly webhooks: WebhookManager;

  private initialized = false;
  private cronTickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: VedConfig) {
    this.config = config;

    // Initialize logger from config
    initLogger({
      level: config.logLevel,
      format: config.logFormat,
    });

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

    // Create event bus (real-time event stream for SSE/webhooks)
    this.eventBus = new EventBus();

    // Wire audit → event bus (every audit append triggers bus emit)
    this.eventLoop.audit.onAppend = (entry) => this.eventBus.emitFromAudit(entry);

    // Create webhook manager (delivers events to registered HTTP endpoints)
    this.webhooks = new WebhookManager(this.db, this.eventBus);

    // Create cron scheduler
    this.cron = new CronScheduler(this.db);
    this.cron.setAudit((input) => this.eventLoop.audit.append(input));
    this.cron.setExecutor((job) => this.executeCronJob(job));
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

    // Start cron tick (check for due jobs every 30s)
    this.startCronTick();

    // Recalculate next_run for all jobs on startup (handles clock drift)
    this.cron.recalculateAll();

    // Start webhook delivery (subscribes to EventBus)
    this.webhooks.start();

    log.info('Ved is running');

    // Enter the main event loop (blocks)
    await this.eventLoop.run();
  }

  /**
   * Request graceful shutdown.
   */
  async stop(): Promise<void> {
    log.info('Stopping Ved...');

    // Stop webhook delivery
    this.webhooks.stop();

    // Stop cron tick
    this.stopCronTick();

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
   * List recent sessions, ordered by last activity descending.
   * Used by `ved chat` TUI for session picker on startup.
   */
  listRecentSessions(limit = 10): import('./core/session.js').Session[] {
    if (!this.initialized) return [];
    return this.eventLoop.sessions.listRecent(limit);
  }

  /**
   * Process a message through the full 7-step pipeline and return the response.
   * Used by `ved chat` REPL — bypasses channel adapters entirely.
   */
  async processMessageDirect(msg: VedMessage): Promise<VedResponse> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }
    return this.eventLoop.processMessageDirect(msg);
  }

  /**
   * Process a message with token streaming.
   * Calls `onToken` for each text token as it arrives from the LLM.
   * Used by `ved chat` TUI for real-time streaming output.
   */
  async processMessageStream(
    msg: VedMessage,
    onToken: (token: string) => void,
  ): Promise<VedResponse> {
    if (!this.initialized) {
      throw new Error('VedApp not initialized — call init() first');
    }
    return this.eventLoop.processMessageStream(msg, onToken);
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

  // ── Webhooks ──

  webhookAdd(input: WebhookInput): Webhook {
    return this.webhooks.add(input);
  }

  webhookRemove(idOrName: string): boolean {
    return this.webhooks.remove(idOrName);
  }

  webhookGet(idOrName: string): Webhook | null {
    return this.webhooks.get(idOrName);
  }

  webhookList(): Webhook[] {
    return this.webhooks.list();
  }

  webhookToggle(idOrName: string, enabled: boolean): Webhook | null {
    return this.webhooks.toggle(idOrName, enabled);
  }

  webhookDeliveries(webhookIdOrName?: string, limit?: number): WebhookDelivery[] {
    return this.webhooks.deliveries(webhookIdOrName, limit);
  }

  webhookStats(): WebhookStats {
    return this.webhooks.stats();
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

  // ── History ──

  /**
   * Get audit history entries for `ved history` CLI.
   */
  getHistory(options?: { type?: string; from?: number; to?: number; limit?: number }): AuditEntry[] {
    return this.eventLoop.audit.getFiltered({
      type: options?.type,
      from: options?.from,
      to: options?.to,
      limit: options?.limit ?? 20,
    });
  }

  /**
   * Verify audit chain integrity for `ved history --verify`.
   */
  verifyAuditChain(limit?: number): { intact: boolean; brokenAt?: number; total: number } {
    return this.eventLoop.audit.verifyChain(limit);
  }

  /**
   * Query audit log rows (for `ved replay` CLI).
   */
  queryAudit(sql: string, ...params: unknown[]): unknown[] {
    if (!this.db) return [];
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Query single audit log row (for `ved replay` CLI).
   */
  queryAuditOne(sql: string, ...params: unknown[]): unknown | undefined {
    if (!this.db) return undefined;
    return this.db.prepare(sql).get(...params);
  }

  /**
   * Get all unique event types present in the audit log.
   */
  getAuditEventTypes(): string[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT DISTINCT event_type FROM audit_log ORDER BY event_type'
    ).all() as { event_type: string }[];
    return rows.map(r => r.event_type);
  }

  // ── Doctor ──

  /**
   * Run self-diagnostics. Returns structured results for `ved doctor` CLI.
   */
  async doctor(): Promise<DoctorResult> {
    const checks: DoctorCheck[] = [];

    // 1. Config validity
    try {
      const errors = validateConfig(this.config);
      if (errors.length === 0) {
        checks.push({ name: 'Config', status: 'ok', message: 'Valid configuration' });
      } else {
        const required = errors.filter(e => e.code === 'REQUIRED');
        const warnings = errors.filter(e => e.code !== 'REQUIRED');
        if (required.length > 0) {
          checks.push({
            name: 'Config',
            status: 'fail',
            message: `${required.length} required field(s) missing: ${required.map(e => e.path).join(', ')}`,
            fixable: true,
          });
        } else {
          checks.push({
            name: 'Config',
            status: 'warn',
            message: `${warnings.length} warning(s): ${warnings.map(e => e.path).join(', ')}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: 'Config',
        status: 'fail',
        message: `Config load error: ${err instanceof Error ? err.message : String(err)}`,
        fixable: true,
      });
    }

    // 2. Database health
    if (this.db) {
      try {
        const integrity = this.db.pragma('integrity_check') as { integrity_check: string }[];
        const isOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
        if (isOk) {
          checks.push({ name: 'Database', status: 'ok', message: `SQLite OK (${this.config.dbPath})` });
        } else {
          checks.push({
            name: 'Database',
            status: 'fail',
            message: `Integrity check failed: ${integrity.map(r => r.integrity_check).join('; ')}`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'Database',
          status: 'fail',
          message: `Database error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      checks.push({ name: 'Database', status: 'fail', message: 'No database connection' });
    }

    // 3. Vault directory structure
    const vaultPath = this.config.memory.vaultPath;
    const expectedDirs = ['daily', 'entities', 'concepts', 'decisions'];
    const missingDirs: string[] = [];
    if (existsSync(vaultPath)) {
      for (const dir of expectedDirs) {
        if (!existsSync(join(vaultPath, dir))) {
          missingDirs.push(dir);
        }
      }
      if (missingDirs.length === 0) {
        checks.push({ name: 'Vault structure', status: 'ok', message: `All 4 folders present (${vaultPath})` });
      } else {
        checks.push({
          name: 'Vault structure',
          status: 'warn',
          message: `Missing folders: ${missingDirs.join(', ')}`,
          fixable: true,
        });
      }
    } else {
      checks.push({
        name: 'Vault structure',
        status: 'fail',
        message: `Vault path does not exist: ${vaultPath}`,
        fixable: true,
      });
    }

    // 4. Vault git status
    try {
      const git = this.memory.vault.git;
      if (!git.isRepo) {
        if (this.config.memory.gitEnabled) {
          checks.push({
            name: 'Vault git',
            status: 'warn',
            message: 'Git enabled in config but vault is not a git repo',
            fixable: true,
          });
        } else {
          checks.push({ name: 'Vault git', status: 'info', message: 'Git tracking disabled' });
        }
      } else if (git.isClean()) {
        checks.push({ name: 'Vault git', status: 'ok', message: 'Clean working tree' });
      } else {
        checks.push({
          name: 'Vault git',
          status: 'warn',
          message: `${git.dirtyCount} uncommitted file(s)`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'Vault git',
        status: 'warn',
        message: `Git check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 5. Audit chain integrity
    try {
      const chainHead = this.eventLoop.audit.getChainHead();
      if (chainHead.count === 0) {
        checks.push({ name: 'Audit chain', status: 'info', message: 'Empty chain (no entries yet)' });
      } else {
        // Verify last 100 entries for speed (full verify would be slow on large chains)
        const verifyLimit = Math.min(chainHead.count, 100);
        const result = this.eventLoop.audit.verifyChain(verifyLimit);
        if (result.intact) {
          checks.push({
            name: 'Audit chain',
            status: 'ok',
            message: `${chainHead.count} entries, chain intact (verified last ${verifyLimit})`,
          });
        } else {
          checks.push({
            name: 'Audit chain',
            status: 'fail',
            message: `Chain broken at entry ${result.brokenAt} of ${result.total}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: 'Audit chain',
        status: 'fail',
        message: `Audit check error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 6. RAG index health
    try {
      const ragStats = this.rag.stats();
      const vaultFiles = this.memory.vault.listFiles();
      const indexedCount = ragStats.filesIndexed;
      const totalFiles = vaultFiles.length;

      if (totalFiles === 0) {
        checks.push({ name: 'RAG index', status: 'info', message: 'No vault files to index' });
      } else if (indexedCount >= totalFiles) {
        checks.push({
          name: 'RAG index',
          status: 'ok',
          message: `${indexedCount}/${totalFiles} files indexed, ${ragStats.chunksStored} chunks`,
        });
      } else if (indexedCount > 0) {
        checks.push({
          name: 'RAG index',
          status: 'warn',
          message: `${indexedCount}/${totalFiles} files indexed (${totalFiles - indexedCount} stale). Run 'ved reindex'`,
          fixable: true,
        });
      } else {
        checks.push({
          name: 'RAG index',
          status: 'warn',
          message: `Index empty with ${totalFiles} vault files. Run 'ved reindex'`,
          fixable: true,
        });
      }
    } catch (err) {
      checks.push({
        name: 'RAG index',
        status: 'warn',
        message: `RAG check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 7. LLM connectivity (live ping)
    try {
      const llmHealth = await this.llm.healthCheck();
      if (!llmHealth.healthy) {
        checks.push({
          name: 'LLM',
          status: 'warn',
          message: llmHealth.details ?? 'LLM not initialized',
        });
      } else {
        // Adapter is initialized — try a live ping
        const ping = await this.llm.ping();
        if (ping.reachable) {
          checks.push({
            name: 'LLM',
            status: 'ok',
            message: `${llmHealth.details} — reachable (${ping.latencyMs}ms)`,
          });
        } else {
          checks.push({
            name: 'LLM',
            status: 'warn',
            message: `${llmHealth.details} — unreachable: ${ping.error ?? 'unknown error'}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: 'LLM',
        status: 'warn',
        message: `LLM check error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 8. MCP tools
    try {
      const mcpHealth = await this.mcp.healthCheck();
      if (mcpHealth.healthy) {
        checks.push({ name: 'MCP tools', status: 'ok', message: mcpHealth.details ?? 'Connected' });
      } else {
        checks.push({
          name: 'MCP tools',
          status: 'info',
          message: mcpHealth.details ?? 'No MCP servers configured',
        });
      }
    } catch (err) {
      checks.push({
        name: 'MCP tools',
        status: 'info',
        message: `MCP check: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Tally
    const passed = checks.filter(c => c.status === 'ok').length;
    const warned = checks.filter(c => c.status === 'warn').length;
    const failed = checks.filter(c => c.status === 'fail').length;
    const infos = checks.filter(c => c.status === 'info').length;

    return { checks, passed, warned, failed, infos };
  }

  /**
   * Attempt to auto-repair issues found by `ved doctor --fix`.
   * Returns lists of what was fixed and what still needs manual attention.
   */
  async doctorFix(): Promise<{ fixed: string[]; manual: string[] }> {
    const fixed: string[] = [];
    const manual: string[] = [];

    // 1. Missing vault directories
    const vaultPath = this.config.memory.vaultPath;
    const expectedDirs = ['daily', 'entities', 'concepts', 'decisions'];

    if (!existsSync(vaultPath)) {
      try {
        mkdirSync(vaultPath, { recursive: true });
        fixed.push(`Created vault directory: ${vaultPath}`);
      } catch (err) {
        manual.push(`Cannot create vault directory ${vaultPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const dir of expectedDirs) {
      const dirPath = join(vaultPath, dir);
      if (!existsSync(dirPath)) {
        try {
          mkdirSync(dirPath, { recursive: true });
          fixed.push(`Created vault subdirectory: ${dir}/`);
        } catch (err) {
          manual.push(`Cannot create ${dir}/: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 2. Missing git repo in vault (when git is enabled)
    try {
      const git = this.memory.vault.git;
      if (!git.isRepo && this.config.memory.gitEnabled) {
        try {
          execSync('git init', { cwd: vaultPath, stdio: 'pipe' });
          fixed.push(`Initialized git repository in vault: ${vaultPath}`);
        } catch (err) {
          manual.push(`Cannot initialize git repo: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (_err) {
      // vault.git may not be accessible if vault was just created — skip
    }

    // 3. Stale RAG index — trigger reindex
    try {
      const ragStats = this.rag.stats();
      const vaultFiles = this.memory.vault.listFiles();
      const indexedCount = ragStats.filesIndexed;
      const totalFiles = vaultFiles.length;

      if (totalFiles > 0 && indexedCount < totalFiles) {
        try {
          await this.reindexVault();
          fixed.push(`Rebuilt RAG index (${totalFiles} file(s))`);
        } catch (err) {
          manual.push(`Cannot reindex vault: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (_err) {
      // skip RAG check if not available
    }

    // 4. Missing config file — cannot auto-fix, advise the user
    const configPath = join(getConfigDir(), 'config.yaml');
    if (!existsSync(configPath)) {
      manual.push('Config file missing — run "ved init" to create it');
    }

    // 5. WAL checkpoint — compact the write-ahead log
    if (this.db) {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        fixed.push('Database WAL checkpoint completed');
      } catch (err) {
        manual.push(`WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 6. Missing config.local.yaml — create template so users have a place to put secrets
    const localConfigPath = join(getConfigDir(), 'config.local.yaml');
    if (!existsSync(localConfigPath)) {
      try {
        writeFileSync(
          localConfigPath,
          '# Local config overrides — not committed to git\n# llm:\n#   apiKey: your-api-key\n',
          'utf8',
        );
        fixed.push(`Created config.local.yaml template: ${localConfigPath}`);
      } catch (err) {
        manual.push(`Cannot create config.local.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 7. Shell completions — auto-install for detected shell
    try {
      const shell = detectShell();
      if (shell) {
        const script = VedApp.generateCompletions(shell);
        const result = installCompletions(shell, script);
        if (!result.skipped) {
          for (const f of result.filesWritten) {
            fixed.push(`Installed shell completions (${shell}) → ${f}`);
          }
        }
      }
    } catch (err) {
      manual.push(`Cannot install shell completions: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 8. Audit chain integrity check — report broken chain (cannot auto-fix without data loss)
    try {
      const chainResult = this.verifyAuditChain();
      if (!chainResult.intact && chainResult.total > 0) {
        manual.push(
          `Audit chain broken at entry ${chainResult.brokenAt} of ${chainResult.total}. ` +
          'Restore from backup: "ved backup restore <file>"',
        );
      }
    } catch (_err) {
      // skip if audit log unavailable
    }

    // 9. Remove orphaned lock files
    try {
      const configDir = getConfigDir();
      const lockFile = join(configDir, 'ved.lock');
      if (existsSync(lockFile)) {
        try {
          const lockContent = readFileSync(lockFile, 'utf-8').trim();
          const pid = parseInt(lockContent, 10);
          let isRunning = false;
          if (!isNaN(pid) && pid > 0) {
            try {
              process.kill(pid, 0); // signal 0 = check if alive
              isRunning = true;
            } catch { /* process not running */ }
          }
          if (!isRunning) {
            unlinkSync(lockFile);
            fixed.push('Removed orphaned lock file (no running ved process)');
          }
        } catch (err) {
          manual.push(`Cannot check/remove lock file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (_err) {
      // skip lock file check if config dir not accessible
    }

    // 10. Validate cron jobs — remove entries with invalid cron expressions
    if (this.db) {
      try {
        const { parseCronExpression } = await import('./core/cron.js');
        const rows = this.db.prepare('SELECT id, name, schedule FROM cron_jobs').all() as Array<{ id: string; name: string; schedule: string }>;
        const invalidJobs: string[] = [];
        for (const row of rows) {
          try {
            parseCronExpression(row.schedule);
          } catch {
            invalidJobs.push(row.name);
            this.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(row.id);
          }
        }
        if (invalidJobs.length > 0) {
          fixed.push(`Removed ${invalidJobs.length} cron job(s) with invalid schedules: ${invalidJobs.join(', ')}`);
        }
      } catch (_err) {
        // cron_jobs table may not exist yet — skip
      }
    }

    // 11. Clean disabled webhooks with invalid URLs
    if (this.db) {
      try {
        const webhooks = this.db.prepare('SELECT id, name, url, enabled FROM webhooks WHERE enabled = 0').all() as Array<{ id: string; name: string; url: string; enabled: number }>;
        const invalidWebhooks: string[] = [];
        for (const wh of webhooks) {
          try {
            const parsed = new URL(wh.url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              invalidWebhooks.push(wh.name);
              this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(wh.id);
            }
          } catch {
            invalidWebhooks.push(wh.name);
            this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(wh.id);
          }
        }
        if (invalidWebhooks.length > 0) {
          fixed.push(`Removed ${invalidWebhooks.length} disabled webhook(s) with invalid URLs: ${invalidWebhooks.join(', ')}`);
        }
      } catch (_err) {
        // webhooks table may not exist yet — skip
      }
    }

    // 12. Clean stale sessions (idle for >30 days)
    if (this.db) {
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const stale = this.db.prepare(
          'SELECT id FROM sessions WHERE status = ? AND updated_at < ?',
        ).all('idle', thirtyDaysAgo) as Array<{ id: string }>;
        if (stale.length > 0) {
          const stmt = this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?');
          for (const s of stale) {
            stmt.run('closed', s.id);
          }
          fixed.push(`Closed ${stale.length} stale session(s) idle for >30 days`);
        }
      } catch (_err) {
        // sessions table may not exist yet — skip
      }
    }

    // 13. Compact webhook delivery history (keep last 1000)
    if (this.db) {
      try {
        const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM webhook_deliveries').get() as { cnt: number } | undefined;
        if (countRow && countRow.cnt > 1000) {
          const excess = countRow.cnt - 1000;
          this.db.prepare(
            'DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries ORDER BY created_at ASC LIMIT ?)',
          ).run(excess);
          fixed.push(`Cleaned ${excess} old webhook delivery record(s) (kept last 1000)`);
        }
      } catch (_err) {
        // webhook_deliveries table may not exist yet — skip
      }
    }

    return { fixed, manual };
  }

  // ── Plugin (MCP Server Manager) ──

  /**
   * List all configured MCP servers with state/tool count.
   */
  pluginList(): ServerInfo[] {
    return this.mcp.getServers();
  }

  /**
   * List all discovered MCP tools. If serverName given, filter to that server.
   */
  pluginTools(serverName?: string): MCPToolDefinition[] {
    const tools = this.mcp.tools;
    if (!serverName) return tools;
    return tools.filter(t => t.serverName === serverName);
  }

  /**
   * Test a server: connect, list tools, return results.
   */
  async pluginTest(serverName: string): Promise<PluginTestResult> {
    const startMs = Date.now();
    const servers = this.mcp.getServers();
    const info = servers.find(s => s.name === serverName);
    if (!info) {
      return {
        serverName,
        success: false,
        toolCount: 0,
        tools: [],
        durationMs: 0,
        error: `Server "${serverName}" not registered`,
      };
    }

    try {
      const result = await this.mcp.testServer(serverName);
      return {
        serverName,
        success: true,
        toolCount: result.tools.length,
        tools: result.tools.map(t => t.originalName),
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        serverName,
        success: false,
        toolCount: 0,
        tools: [],
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Add a server to the MCP client at runtime.
   * Note: not persisted to config.yaml — session only.
   */
  async pluginAdd(config: MCPServerConfig): Promise<void> {
    await this.mcp.addServer(config);
  }

  /**
   * Remove a server from the MCP client at runtime.
   * Returns true if removed, false if not found.
   */
  async pluginRemove(name: string): Promise<boolean> {
    return this.mcp.removeServer(name);
  }

  // ── GC (Garbage Collection) ──

  /**
   * Report what GC would clean without acting.
   */
  gcStatus(options?: { sessionsDays?: number; auditDays?: number }): GcStatus {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');

    const sessionsDays = options?.sessionsDays ?? 30;
    const auditDays = options?.auditDays ?? 90;
    const sessionsCutoff = Date.now() - sessionsDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditDays * 24 * 60 * 60 * 1000;

    const staleSessions = this.db.prepare(
      `SELECT id FROM sessions WHERE status IN ('active', 'idle') AND last_active < ?`
    ).all(sessionsCutoff) as { id: string }[];

    const oldAuditCount = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE timestamp < ?`
    ).get(auditCutoff) as { cnt: number }).cnt;

    return {
      staleSessions: staleSessions.length,
      staleSessionIds: staleSessions.map(s => s.id),
      oldAuditEntries: oldAuditCount,
      oldAuditCutoff: auditCutoff,
      auditWarning: oldAuditCount > 0
        ? 'Deleting audit entries breaks the hash chain. Use --force to proceed.'
        : undefined,
    };
  }

  /**
   * Run garbage collection: close stale sessions, optionally purge old audit entries, VACUUM.
   */
  gcRun(options?: { sessionsDays?: number; auditDays?: number; auditForce?: boolean }): GcResult {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');

    const startMs = Date.now();
    const sessionsDays = options?.sessionsDays ?? 30;
    const auditDays = options?.auditDays ?? 90;
    const sessionsCutoff = Date.now() - sessionsDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditDays * 24 * 60 * 60 * 1000;

    // Close stale sessions
    const sessionResult = this.db.prepare(
      `UPDATE sessions SET status = 'closed', closed_at = ? WHERE status IN ('active', 'idle') AND last_active < ?`
    ).run(Date.now(), sessionsCutoff);
    const sessionsClosed = sessionResult.changes;

    if (sessionsClosed > 0 && this.initialized) {
      this.eventLoop.audit.append({
        eventType: 'gc_sessions_cleaned',
        actor: 'ved',
        detail: { count: sessionsClosed, cutoffDays: sessionsDays },
      });
    }

    // Delete old audit entries only with explicit --force
    let auditEntriesDeleted = 0;
    if (options?.auditForce) {
      const auditResult = this.db.prepare(
        `DELETE FROM audit_log WHERE timestamp < ?`
      ).run(auditCutoff);
      auditEntriesDeleted = auditResult.changes;
    }

    // VACUUM SQLite to reclaim space
    this.db.exec('VACUUM');

    if (this.initialized) {
      this.eventLoop.audit.append({
        eventType: 'gc_vacuum',
        actor: 'ved',
        detail: { sessionsClosed, auditEntriesDeleted },
      });
    }

    return {
      sessionsClosed,
      auditEntriesDeleted,
      vacuumed: true,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Backup ──

  /**
   * Create a backup of the vault + database.
   * Returns the backup filename and path.
   */
  createBackup(options?: { backupDir?: string; maxBackups?: number }): {
    filename: string;
    path: string;
    vaultFiles: number;
    sizeBytes: number;
  } {
    const backupDir = options?.backupDir ?? join(dirname(this.config.dbPath), 'backups');
    const maxBackups = options?.maxBackups ?? 10;

    mkdirSync(backupDir, { recursive: true });

    // Generate timestamped filename
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `ved-backup-${ts}.tar.gz`;
    const backupPath = join(backupDir, filename);

    // Create temp staging directory
    const stagingDir = join(backupDir, `.staging-${Date.now()}`);
    mkdirSync(join(stagingDir, 'vault'), { recursive: true });

    try {
      // Copy vault files
      const vaultFiles = this._copyDir(this.config.memory.vaultPath, join(stagingDir, 'vault'));

      // Copy database (safe: WAL checkpoint first)
      if (this.db) {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      }
      copyFileSync(this.config.dbPath, join(stagingDir, 'ved.db'));

      // Create tar.gz
      execSync(`tar -czf "${backupPath}" -C "${stagingDir}" .`, { stdio: 'pipe' });

      // Get size
      const sizeBytes = statSync(backupPath).size;

      // Audit log
      if (this.initialized) {
        this.eventLoop.audit.append({
          eventType: 'backup_created',
          actor: 'ved',
          detail: { filename, vaultFiles, sizeBytes, backupDir },
        });
      }

      // Rotate old backups
      this._rotateBackups(backupDir, maxBackups);

      return { filename, path: backupPath, vaultFiles, sizeBytes };
    } finally {
      // Clean up staging
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * List existing backups.
   */
  listBackups(backupDir?: string): {
    filename: string;
    path: string;
    sizeBytes: number;
    createdAt: Date;
  }[] {
    const dir = backupDir ?? join(dirname(this.config.dbPath), 'backups');
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter(f => f.startsWith('ved-backup-') && f.endsWith('.tar.gz'))
      .map(f => {
        const fullPath = join(dir, f);
        const stat = statSync(fullPath);
        return {
          filename: f,
          path: fullPath,
          sizeBytes: stat.size,
          createdAt: stat.mtime,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Restore vault + database from a backup archive.
   * WARNING: This overwrites the current vault and database.
   */
  restoreBackup(backupPath: string, options?: { dryRun?: boolean }): {
    vaultFiles: number;
    dbRestored: boolean;
  } {
    if (!existsSync(backupPath)) {
      throw new VedError('BACKUP_NOT_FOUND', `Backup not found: ${backupPath}`);
    }

    // Extract to temp dir to inspect
    const extractDir = join(dirname(backupPath), `.restore-${Date.now()}`);
    mkdirSync(extractDir, { recursive: true });

    try {
      execSync(`tar -xzf "${backupPath}" -C "${extractDir}"`, { stdio: 'pipe' });

      // Validate contents
      const hasVault = existsSync(join(extractDir, 'vault'));
      const hasDb = existsSync(join(extractDir, 'ved.db'));

      if (!hasVault && !hasDb) {
        throw new VedError('BACKUP_INVALID', 'Backup archive contains neither vault nor database');
      }

      // Count vault files
      let vaultFiles = 0;
      if (hasVault) {
        vaultFiles = this._countFiles(join(extractDir, 'vault'));
      }

      if (options?.dryRun) {
        return { vaultFiles, dbRestored: hasDb };
      }

      // Restore vault
      if (hasVault) {
        // Clear existing vault contents (keep the directory)
        const vaultPath = this.config.memory.vaultPath;
        if (existsSync(vaultPath)) {
          for (const entry of readdirSync(vaultPath)) {
            if (entry === '.git') continue; // Preserve git history
            rmSync(join(vaultPath, entry), { recursive: true, force: true });
          }
        } else {
          mkdirSync(vaultPath, { recursive: true });
        }
        // Copy restored files
        this._copyDir(join(extractDir, 'vault'), vaultPath);
      }

      // Restore database
      if (hasDb) {
        // Close current DB connection
        if (this.db) {
          this.db.close();
          this.db = null;
        }
        copyFileSync(join(extractDir, 'ved.db'), this.config.dbPath);
      }

      // Audit log (re-open DB for this)
      if (hasDb) {
        this.db = new Database(this.config.dbPath);
        this.db.pragma('journal_mode = WAL');
      }

      if (this.db) {
        // Re-create audit with new DB
        this.eventLoop.audit.reload(this.db);
        this.eventLoop.audit.append({
          eventType: 'backup_restored',
          actor: 'ved',
          detail: { source: basename(backupPath), vaultFiles, dbRestored: hasDb },
        });
      }

      return { vaultFiles, dbRestored: hasDb };
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }

  /**
   * Recursively copy a directory. Returns file count.
   */
  private _copyDir(src: string, dest: string): number {
    if (!existsSync(src)) return 0;
    mkdirSync(dest, { recursive: true });
    let count = 0;

    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.name === '.git') continue; // Skip .git dirs

      if (entry.isDirectory()) {
        count += this._copyDir(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
        count++;
      }
    }
    return count;
  }

  /**
   * Count files recursively in a directory.
   */
  private _countFiles(dir: string): number {
    if (!existsSync(dir)) return 0;
    let count = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += this._countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Rotate backups: keep only the most recent maxBackups.
   */
  private _rotateBackups(backupDir: string, maxBackups: number): void {
    const backups = this.listBackups(backupDir);
    if (backups.length <= maxBackups) return;

    // Delete oldest backups
    const toDelete = backups.slice(maxBackups);
    for (const b of toDelete) {
      rmSync(b.path, { force: true });
      log.info('Rotated old backup', { filename: b.filename });
    }
  }

  // ── Cron ──

  /**
   * List all cron jobs.
   */
  cronList(): CronJob[] {
    return this.cron.list();
  }

  /**
   * Get a cron job by ID or name.
   */
  cronGet(idOrName: string): CronJob | null {
    return this.cron.get(idOrName);
  }

  /**
   * Add a new cron job.
   */
  cronAdd(input: CronJobInput): CronJob {
    return this.cron.add(input);
  }

  /**
   * Remove a cron job.
   */
  cronRemove(idOrName: string): boolean {
    return this.cron.remove(idOrName);
  }

  /**
   * Enable/disable a cron job.
   */
  cronToggle(idOrName: string, enabled: boolean): CronJob | null {
    return this.cron.toggle(idOrName, enabled);
  }

  /**
   * Manually run a cron job.
   */
  async cronRun(idOrName: string): Promise<CronRunResult> {
    return this.cron.runNow(idOrName);
  }

  /**
   * Get cron execution history.
   */
  cronHistory(jobName?: string, limit?: number): CronHistoryEntry[] {
    return this.cron.history(jobName, limit);
  }

  /**
   * Execute a cron job by type.
   * Built-in types: backup, reindex, doctor.
   */
  private async executeCronJob(job: CronJob): Promise<CronRunResult> {
    const startTime = Date.now();
    const config = JSON.parse(job.jobConfig || '{}');

    try {
      switch (job.jobType) {
        case 'backup': {
          const result = this.createBackup({
            backupDir: config.backupDir,
            maxBackups: config.maxBackups,
          });
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: true,
            message: `Backup created: ${result.filename} (${result.vaultFiles} files, ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
            durationMs: Date.now() - startTime,
          };
        }

        case 'reindex': {
          const stats = await this.reindexVault();
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: true,
            message: `Re-indexed: ${stats.filesIndexed} files, ${stats.chunksStored} chunks, ${stats.graphEdges} edges`,
            durationMs: Date.now() - startTime,
          };
        }

        case 'doctor': {
          const result = await this.doctor();
          const ok = result.failed === 0;
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: ok,
            message: `Doctor: ${result.passed} passed, ${result.warned} warnings, ${result.failed} failed`,
            durationMs: Date.now() - startTime,
            error: ok ? undefined : `${result.failed} check(s) failed`,
          };
        }

        default:
          return {
            jobId: job.id,
            jobName: job.name,
            jobType: job.jobType,
            success: false,
            message: `Unknown job type: ${job.jobType}`,
            durationMs: Date.now() - startTime,
            error: `Unsupported job type: ${job.jobType}`,
          };
      }
    } catch (err) {
      return {
        jobId: job.id,
        jobName: job.name,
        jobType: job.jobType,
        success: false,
        message: `Job failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Start the cron tick interval (checks for due jobs every 30s).
   */
  private startCronTick(): void {
    this.cronTickInterval = setInterval(async () => {
      try {
        const executed = await this.cron.tick();
        if (executed > 0) {
          log.info('Cron tick executed jobs', { count: executed });
        }
      } catch (err) {
        log.warn('Cron tick error', { error: err instanceof Error ? err.message : String(err) });
      }
    }, 30_000);
    this.cronTickInterval.unref();
    log.info('Cron tick started (30s interval)');
  }

  /**
   * Stop the cron tick interval.
   */
  private stopCronTick(): void {
    if (this.cronTickInterval) {
      clearInterval(this.cronTickInterval);
      this.cronTickInterval = null;
    }
  }

  // ── Upgrade (Version Migration Management) ──

  /**
   * Get current schema version and available migration info.
   */
  getUpgradeStatus(): {
    currentVersion: number;
    availableVersions: number;
    pendingCount: number;
    dbPath: string;
  } {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    const current = currentVersion(this.db);
    // Count available migration files
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter(f => /^v\d{3}_.*\.sql$/.test(f));
    const available = files.length;
    return {
      currentVersion: current,
      availableVersions: available,
      pendingCount: Math.max(0, available - current),
      dbPath: this.config.dbPath,
    };
  }

  /**
   * Verify migration integrity (checksums of applied vs on-disk).
   */
  verifyMigrations(): string[] {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    return verifyMigrations(this.db);
  }

  /**
   * Run pending migrations. Returns count applied.
   * Migrations are already run on VedApp construction, so this is mainly
   * for explicit CLI invocation after adding new migration files.
   */
  runMigrations(): number {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    return migrate(this.db);
  }

  /**
   * Get details of all applied migrations from schema_version table.
   */
  getAppliedMigrations(): Array<{
    version: number;
    filename: string;
    checksum: string;
    appliedAt: number;
    description: string;
  }> {
    if (!this.db) throw new VedError('DB_OPEN_FAILED', 'Database not initialized');
    const tableExists = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'
    `).get();
    if (!tableExists) return [];

    return this.db.prepare(`
      SELECT version, filename, checksum, applied_at as appliedAt, description
      FROM schema_version ORDER BY version
    `).all() as Array<{
      version: number;
      filename: string;
      checksum: string;
      appliedAt: number;
      description: string;
    }>;
  }

  // ── Watch (Standalone Vault Watcher) ──

  /**
   * Run vault watcher in standalone mode (no event loop, no channels).
   * Watches vault files for changes and triggers RAG re-indexing.
   * Blocks until stopped via signal.
   */
  async runWatch(): Promise<void> {
    await this.init();

    // Auto-commit dirty vault files
    this.autoCommitVault();

    // Index existing vault files
    await this.indexVaultOnStartup();

    // Start watcher
    this.startVaultWatcher();

    log.info('Vault watcher running in standalone mode (Ctrl+C to stop)');

    // Block until shutdown signal
    return new Promise<void>((resolve) => {
      const shutdown = () => {
        this.stopVaultWatcher();
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

  // ── Trust ──

  /**
   * Resolve trust tier for a user on a channel.
   */
  trustResolve(channel: string, userId: string): number {
    return this.eventLoop.trust.resolveTier(channel, userId);
  }

  /**
   * Assess risk level of a tool call.
   */
  trustAssess(toolName: string, params: Record<string, unknown> = {}): { level: string; reasons: string[] } {
    return this.eventLoop.trust.assessRisk(toolName, params);
  }

  /**
   * Grant a trust tier to a user.
   */
  trustGrant(channel: string, userId: string, tier: 1 | 2 | 3 | 4, grantedBy: string, reason = ''): void {
    this.eventLoop.trust.grantTrust(channel, userId, tier, grantedBy, reason);
  }

  /**
   * Revoke trust for a user on a channel.
   */
  trustRevoke(channel: string, userId: string, revokedBy: string, reason = ''): void {
    this.eventLoop.trust.revokeTrust(channel, userId, revokedBy, reason);
  }

  /**
   * Get pending work orders, optionally filtered by session.
   */
  workOrdersPending(sessionId?: string): WorkOrder[] {
    return this.eventLoop.workOrders.getPending(sessionId);
  }

  /**
   * Get a work order by ID.
   */
  workOrderGet(id: string): WorkOrder | null {
    return this.eventLoop.workOrders.getById(id);
  }

  /**
   * Query the database directly (for trust ledger and work order history).
   * Returns raw rows.
   */
  queryDb(sql: string, params: Record<string, string | number> = {}): unknown[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).all(params);
  }

  /**
   * Get trust config.
   */
  get trustConfig(): { ownerIds: string[]; tribeIds: string[]; knownIds: string[]; defaultTier: number; approvalTimeoutMs?: number; maxAgenticLoops?: number } {
    const cfg = this.config;
    if (!cfg) throw new Error('Config not loaded');
    return cfg.trust;
  }

  // ── Completions ──

  /**
   * Generate shell completions for bash, zsh, or fish.
   */
  static generateCompletions(shell: 'bash' | 'zsh' | 'fish'): string {
    const commands = [
      'init', 'start', 'chat', 'c', 'talk', 'run', 'ask', 'query', 'q', 'pipe', 'pipeline', 'chain', 'serve', 'status', 'stats', 'search', 'memory', 'trust', 'user', 'prompt', 'context', 'reindex',
      'config', 'export', 'import', 'history', 'doctor', 'backup', 'cron',
      'completions', 'upgrade', 'watch', 'webhook', 'hook', 'notify', 'plugin', 'gc', 'sync', 'remote', 'remotes', 'template', 'alias', 'env', 'log', 'profile', 'diff', 'snapshot', 'migrate', 'tag',
      'agent', 'agents', 'persona', 'personas', 'replay', 'replays', 'playback',
      'graph', 'links', 'kg', 'task', 'tasks', 'todo', 'todos',
      'mcp-serve', 'help', 'version',
    ];
    const diffSubs = ['log', 'show', 'stat', 'stats', 'blame', 'between', 'files', 'summary', 'evolution', 'overview', 'history', 'changed', 'annotate', 'commit', 'compare'];
    const diffFlags = ['--limit', '-n', '--since', '--days', '--file'];
    const chatFlags = ['--model', '--no-rag', '--no-tools', '--verbose', '--help'];
    const runFlags = ['-q', '--query', '-f', '--file', '-s', '--session', '-m', '--model', '--system', '--json', '--raw', '--no-rag', '--no-tools', '-t', '--timeout', '-v', '--verbose', '--help'];
    const configSubs = ['validate', 'show', 'path'];
    const backupSubs = ['create', 'list', 'restore'];
    const cronSubs = ['list', 'add', 'remove', 'enable', 'disable', 'run', 'history'];
    const upgradeSubs = ['status', 'run', 'verify', 'history'];
    const pluginSubs = ['list', 'tools', 'test', 'add', 'remove'];
    const webhookSubs = ['list', 'add', 'remove', 'enable', 'disable', 'deliveries', 'stats', 'test'];
    const gcSubs = ['run', 'status'];
    const memorySubs = ['list', 'show', 'graph', 'timeline', 'daily', 'forget', 'tags', 'types'];
    const trustSubs = ['matrix', 'resolve', 'assess', 'grant', 'revoke', 'ledger', 'pending', 'history', 'show', 'config'];
    const userSubs = ['list', 'show', 'sessions', 'activity', 'stats'];
    const promptSubs = ['list', 'show', 'create', 'edit', 'use', 'test', 'reset', 'diff'];
    const templateSubs = ['list', 'show', 'create', 'edit', 'delete', 'use', 'vars'];
    const contextSubs = ['show', 'tokens', 'facts', 'add', 'remove', 'clear', 'messages', 'simulate', 'sessions'];
    const pipeSubs = ['list', 'ls', 'show', 'save', 'delete', 'rm', 'run'];
    const pipeFlags = ['-f', '--file', '--json', '--raw', '-v', '--verbose', '-n', '--dry-run', '--help'];
    const aliasSubs = ['list', 'ls', 'add', 'create', 'remove', 'rm', 'show', 'edit', 'run', 'export', 'import', 'help'];
    const envSubs = ['current', 'list', 'ls', 'show', 'cat', 'create', 'new', 'use', 'switch', 'activate', 'edit', 'delete', 'rm', 'remove', 'diff', 'compare', 'reset', 'deactivate', 'clear'];
    const logSubs = ['show', 'tail', 'follow', 'search', 'grep', 'find', 'stats', 'info', 'levels', 'modules', 'mods', 'clear', 'truncate', 'path'];
    const logFlags = ['--level', '--module', '--since', '--until', '--limit', '-n', '--json', '--no-color'];
    const profileSubs = ['all', 'audit', 'vault', 'trust', 'db', 'hash', 'memory'];
    const profileFlags = ['--iterations', '-i', '--warmup', '-w', '--json', '--verbose', '-v', '--no-color'];
    const snapshotSubs = ['list', 'ls', 'create', 'new', 'take', 'show', 'info', 'diff', 'compare', 'restore', 'checkout', 'delete', 'rm', 'remove', 'export', 'archive'];
    const hookSubs = ['list', 'ls', 'add', 'create', 'remove', 'rm', 'delete', 'show', 'info', 'edit', 'update', 'enable', 'disable', 'test', 'dry-run', 'history', 'log', 'types', 'events'];
    const hookFlags = ['--desc', '--description', '--timeout', '--concurrency', '--max-concurrent', '--events', '--command', '--cmd', '--limit', '-n'];
    const notifySubs = ['list', 'ls', 'add', 'create', 'remove', 'rm', 'delete', 'show', 'info', 'edit', 'update', 'enable', 'disable', 'test', 'history', 'channels', 'mute', 'unmute'];
    const notifyFlags = ['--events', '--channel', '--desc', '--description', '--command', '--cmd', '--log-path', '--title', '--body', '--throttle', '--quiet-start', '--quiet-end', '--limit', '-n'];

    const tagSubs = ['list', 'ls', 'show', 'get', 'info', 'add', 'remove', 'rm', 'delete', 'del', 'rename', 'mv', 'move', 'set', 'replace', 'clear', 'orphans', 'untagged', 'stats', 'statistics', 'find', 'search', 'filter'];
    const tagFlags = ['--count', '-c', '--any', '--dry-run', '--include-daily'];

    const migrateSubs = ['status', 'markdown', 'md', 'json', 'obsidian', 'obs', 'csv', 'jsonl', 'undo', 'rollback', 'revert', 'history', 'log', 'validate', 'check', 'verify'];
    const migrateFlags = ['--dry-run', '--force', '-r', '--recursive', '--tag=', '--folder=', '--name-col=', '--include-hidden', '--limit='];

    const syncSubs = ['list', 'ls', 'add', 'create', 'remove', 'rm', 'delete', 'push', 'pull', 'status', 'state', 'history', 'log'];
    const syncFlags = ['--force', '-f', '--limit', '-n', '--failed-only', '--show-auth', '--auth'];

    const agentSubs = ['list', 'ls', 'show', 'cat', 'view', 'create', 'new', 'add', 'edit', 'delete', 'rm', 'remove', 'run', 'exec', 'history', 'runs', 'clone', 'copy', 'cp', 'export', 'import'];
    const agentFlags = ['--template', '-t', '--description', '-d', '--desc', '--model', '-m', '--tier', '--json', '--raw', '--verbose', '-v', '--limit', '-n', '--dry-run', '--merge'];

    const replaySubs = ['list', 'ls', 'sessions', 'show', 'replay', 'play', 'trace', 'chain', 'timeline', 'waterfall', 'stats', 'summary', 'compare', 'cmp', 'diff', 'export', 'search', 'find', 'grep'];
    const replayFlags = ['--limit', '-n', '--verbose', '-v', '--json', '--depth', '-d', '--format', '-f', '--output', '-o', '--markdown', '--md'];

    const graphSubs = ['hubs', 'hub', 'orphans', 'orphan', 'islands', 'island', 'clusters', 'cluster', 'path', 'shortest', 'neighbors', 'neighbor', 'nb', 'broken', 'dead', 'dot', 'graphviz', 'summary', 'folders'];
    const graphFlags = ['--limit', '-n', '--min-links', '--format', '--depth', '-d', '--verbose', '-v'];

    const taskSubs = ['list', 'ls', 'add', 'new', 'create', 'show', 'view', 'get', 'edit', 'update', 'set', 'done', 'complete', 'close', 'archive', 'board', 'kanban', 'stats', 'summary', 'projects', 'search', 'find'];
    const taskFlags = ['--status', '--project', '--priority', '--tag', '--limit', '-n', '--verbose', '-v', '--json'];

    switch (shell) {
      case 'bash':
        return `# Ved bash completions — add to ~/.bashrc or ~/.bash_completion
_ved_completions() {
  local cur prev cmds
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmds="${commands.join(' ')}"

  case "\${prev}" in
    config)
      COMPREPLY=( $(compgen -W "${configSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    backup)
      COMPREPLY=( $(compgen -W "${backupSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    cron)
      COMPREPLY=( $(compgen -W "${cronSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    upgrade)
      COMPREPLY=( $(compgen -W "${upgradeSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    plugin)
      COMPREPLY=( $(compgen -W "${pluginSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    gc)
      COMPREPLY=( $(compgen -W "${gcSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    webhook)
      COMPREPLY=( $(compgen -W "${webhookSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    hook|hooks|on|trigger)
      COMPREPLY=( $(compgen -W "${hookSubs.join(' ')} ${hookFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    notify|notifications|alert|alerts)
      COMPREPLY=( $(compgen -W "${notifySubs.join(' ')} ${notifyFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    tag|tags|label|labels)
      COMPREPLY=( $(compgen -W "${tagSubs.join(' ')} ${tagFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    migrate|migrations|import-data)
      COMPREPLY=( $(compgen -W "${migrateSubs.join(' ')} ${migrateFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    sync|remote|remotes)
      COMPREPLY=( $(compgen -W "${syncSubs.join(' ')} ${syncFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    agent|agents|persona|personas)
      COMPREPLY=( $(compgen -W "${agentSubs.join(' ')} ${agentFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    replay|replays|playback)
      COMPREPLY=( $(compgen -W "${replaySubs.join(' ')} ${replayFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    memory|mem)
      COMPREPLY=( $(compgen -W "${memorySubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    trust|t)
      COMPREPLY=( $(compgen -W "${trustSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    user|u|who|users)
      COMPREPLY=( $(compgen -W "${userSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    prompt|prompts|sp|system-prompt)
      COMPREPLY=( $(compgen -W "${promptSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    template|templates|tpl)
      COMPREPLY=( $(compgen -W "${templateSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    context|ctx|window|prompt-debug)
      COMPREPLY=( $(compgen -W "${contextSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    chat|c|talk)
      COMPREPLY=( $(compgen -W "${chatFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    run|ask|query|q)
      COMPREPLY=( $(compgen -W "${runFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    pipe|pipeline|chain)
      COMPREPLY=( $(compgen -W "${pipeSubs.join(' ')} ${pipeFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    alias|aliases|shortcut|shortcuts)
      COMPREPLY=( $(compgen -W "${aliasSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    env|envs|environment|environments)
      COMPREPLY=( $(compgen -W "${envSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    log|logs)
      COMPREPLY=( $(compgen -W "${logSubs.join(' ')} ${logFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    profile|bench|benchmark)
      COMPREPLY=( $(compgen -W "${profileSubs.join(' ')} ${profileFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    diff|changes|delta)
      COMPREPLY=( $(compgen -W "${diffSubs.join(' ')} ${diffFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    snapshot|snap|checkpoint)
      COMPREPLY=( $(compgen -W "${snapshotSubs.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    graph|links|kg)
      COMPREPLY=( $(compgen -W "${graphSubs.join(' ')} ${graphFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    task|tasks|todo|todos)
      COMPREPLY=( $(compgen -W "${taskSubs.join(' ')} ${taskFlags.join(' ')}" -- "\${cur}") )
      return 0
      ;;
    restore)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
    search)
      COMPREPLY=( $(compgen -W "-n --limit --fts-only --verbose" -- "\${cur}") )
      return 0
      ;;
    history)
      COMPREPLY=( $(compgen -W "-n --limit --type --from --to --verify --types --json" -- "\${cur}") )
      return 0
      ;;
    export)
      COMPREPLY=( $(compgen -W "-o --output --pretty --include-audit --include-stats --folder" -- "\${cur}") )
      return 0
      ;;
    import)
      COMPREPLY=( $(compgen -f -W "--dry-run --merge --overwrite" -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${cmds}" -- "\${cur}") )
  fi

  return 0
}
complete -F _ved_completions ved
`;

      case 'zsh':
        return `#compdef ved
# Ved zsh completions — add to fpath or source in ~/.zshrc

_ved() {
  local -a commands
  commands=(
    'init:Create ~/.ved/ with default config'
    'start:Start Ved in interactive mode'
    'run:One-shot query mode'
    'ask:One-shot query (alias for run)'
    'query:One-shot query (alias for run)'
    'q:One-shot query (alias for run)'
    'serve:Start HTTP API server'
    'status:Show health check'
    'stats:Show vault/RAG/audit/session metrics'
    'search:Search vault via RAG pipeline'
    'reindex:Force full RAG re-index'
    'config:Manage configuration'
    'export:Export vault to JSON'
    'import:Import vault from JSON'
    'history:View audit history'
    'doctor:Run self-diagnostics'
    'backup:Vault + database snapshots'
    'cron:Manage scheduled jobs'
    'upgrade:Manage database migrations'
    'watch:Watch vault for changes (standalone)'
    'webhook:Manage webhook event delivery'
    'hook:Lifecycle hooks — run commands on events'
    'memory:Browse and manage Obsidian knowledge graph'
    'trust:Manage trust tiers and work orders'
    'user:Manage and inspect known users'
    'prompt:Manage system prompt profiles'
    'template:Vault template manager'
    'context:Inspect and manage LLM context window'
    'pipe:Multi-step pipeline execution'
    'pipeline:Multi-step pipeline (alias for pipe)'
    'chain:Multi-step pipeline (alias for pipe)'
    'alias:Manage command shortcuts'
    'aliases:Manage command shortcuts (alias for alias)'
    'shortcut:Manage command shortcuts (alias for alias)'
    'env:Manage configuration environments'
    'envs:Manage environments (alias for env)'
    'environment:Manage environments (alias for env)'
    'log:View and analyze structured logs'
    'logs:View and analyze logs (alias for log)'
    'profile:Performance benchmarking'
    'bench:Performance benchmarking (alias for profile)'
    'benchmark:Performance benchmarking (alias for profile)'
    'diff:View vault changes, git history, and knowledge evolution'
    'changes:View vault changes (alias for diff)'
    'delta:View vault changes (alias for diff)'
    'notify:Notification rules — get alerted on events'
    'notifications:Notification rules (alias for notify)'
    'alert:Notification rules (alias for notify)'
    'alerts:Notification rules (alias for notify)'
    'tag:Manage vault tags'
    'tags:Manage vault tags (alias for tag)'
    'label:Manage vault tags (alias for tag)'
    'labels:Manage vault tags (alias for tag)'
    'migrate:Import data from external sources'
    'migrations:Import data (alias for migrate)'
    'import-data:Import data (alias for migrate)'
    'sync:Sync vault to/from remote endpoints'
    'remote:Sync remotes (alias for sync)'
    'remotes:Sync remotes (alias for sync)'
    'snapshot:Lightweight vault point-in-time snapshots'
    'snap:Vault snapshots (alias for snapshot)'
    'checkpoint:Vault snapshots (alias for snapshot)'
    'graph:Explore knowledge graph connections'
    'links:Knowledge graph (alias for graph)'
    'kg:Knowledge graph (alias for graph)'
    'task:Manage tasks and todos'
    'tasks:Manage tasks (alias for task)'
    'todo:Manage tasks (alias for task)'
    'todos:Manage tasks (alias for task)'
    'chat:Interactive conversation'
    'c:Interactive conversation (alias for chat)'
    'talk:Interactive conversation (alias for chat)'
    'mcp-serve:Start MCP server mode'
    'completions:Generate shell completions'
    'version:Show version'
  )

  _arguments -C \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case \$state in
    cmd)
      _describe 'ved commands' commands
      ;;
    args)
      case \$words[1] in
        config)
          _values 'subcommand' 'validate[Check config for errors]' 'show[Print resolved config]' 'path[Print config directory]'
          ;;
        backup)
          _values 'subcommand' 'create[Create a new backup]' 'list[List existing backups]' 'restore[Restore from backup]'
          ;;
        cron)
          _values 'subcommand' 'list[List scheduled jobs]' 'add[Add a job]' 'remove[Remove a job]' 'enable[Enable a job]' 'disable[Disable a job]' 'run[Manually trigger a job]' 'history[Show execution history]'
          ;;
        upgrade)
          _values 'subcommand' 'status[Show migration status]' 'run[Apply pending migrations]' 'verify[Check migration integrity]' 'history[Show applied migrations]'
          ;;
        webhook)
          _values 'subcommand' 'list[List webhooks]' 'add[Register a webhook]' 'remove[Remove a webhook]' 'enable[Enable a webhook]' 'disable[Disable a webhook]' 'deliveries[View delivery history]' 'stats[Delivery statistics]' 'test[Send a test event]'
          ;;
        hook|hooks|on|trigger)
          _values 'subcommand' 'list[List hooks]' 'add[Create a hook]' 'remove[Remove a hook]' 'show[Show hook details]' 'edit[Update a hook]' 'enable[Enable a hook]' 'disable[Disable a hook]' 'test[Test-run a hook]' 'history[Execution history]' 'types[List event types]'
          ;;
        notify|notifications|alert|alerts)
          _values 'subcommand' 'list[List rules]' 'add[Create a rule]' 'remove[Remove a rule]' 'show[Show rule details]' 'edit[Update a rule]' 'enable[Enable a rule]' 'disable[Disable a rule]' 'test[Test-fire a rule]' 'history[Delivery history]' 'channels[List channels]' 'mute[Mute notifications]' 'unmute[Unmute notifications]'
          ;;
        tag|tags|label|labels)
          _values 'subcommand' 'list[List all tags]' 'show[Files with tag]' 'add[Add tags to file]' 'remove[Remove tags]' 'rename[Rename across vault]' 'set[Replace all tags]' 'clear[Remove all tags]' 'orphans[Untagged files]' 'stats[Tag statistics]' 'find[Multi-tag search]'
          ;;
        migrate|migrations|import-data)
          _values 'subcommand' 'status[Migration status]' 'markdown[Import markdown files]' 'json[Import JSON data]' 'obsidian[Import Obsidian vault]' 'csv[Import CSV as entities]' 'jsonl[Import JSONL logs]' 'undo[Undo a migration]' 'history[Migration history]' 'validate[Dry-run validation]'
          ;;
        sync|remote|remotes)
          _values 'subcommand' 'list[List remotes]' 'add[Add a remote]' 'remove[Remove a remote]' 'push[Push vault to remote]' 'pull[Pull from remote]' 'status[Check sync state]' 'history[Sync history]'
          ;;
        agent|agents|persona|personas)
          _values 'subcommand' 'list[List agents]' 'show[Show agent config]' 'create[Create new agent]' 'edit[Edit agent config]' 'delete[Delete agent]' 'run[Run agent one-shot]' 'history[Show run history]' 'clone[Clone an agent]' 'export[Export agents to JSON]' 'import[Import agents from JSON]'
          ;;
        replay|replays|playback)
          _values 'subcommand' 'list[List sessions]' 'show[Replay session flow]' 'trace[Trace event chain]' 'timeline[Timing waterfall]' 'stats[Session statistics]' 'compare[Compare two sessions]' 'export[Export to JSON/markdown]' 'search[Search events]'
          ;;
        memory|mem)
          _values 'subcommand' 'list[List entities]' 'show[Display entity details]' 'graph[Show wikilink connections]' 'timeline[Recent memory activity]' 'daily[Show/create daily note]' 'forget[Soft-delete to archive]' 'tags[List all tags]' 'types[List entity types]'
          ;;
        trust|t)
          _values 'subcommand' 'matrix[Show trust×risk matrix]' 'resolve[Resolve user trust tier]' 'assess[Assess tool risk level]' 'grant[Grant trust tier]' 'revoke[Revoke trust grant]' 'ledger[Show trust ledger]' 'pending[List pending work orders]' 'history[Work order history]' 'show[Work order details]' 'config[Show trust config]'
          ;;
        user|u|who|users)
          _values 'subcommand' 'list[List known users]' 'show[User profile]' 'sessions[User sessions]' 'activity[User activity log]' 'stats[Aggregate statistics]'
          ;;
        prompt|prompts|sp|system-prompt)
          _values 'subcommand' 'list[List prompt profiles]' 'show[Display prompt contents]' 'create[Create new profile]' 'edit[Open in editor]' 'use[Set as active prompt]' 'test[Preview assembled prompt]' 'reset[Revert to default]' 'diff[Compare two profiles]'
          ;;
        template|templates|tpl)
          _values 'subcommand' 'list[List templates]' 'show[Display template contents]' 'create[Create a template]' 'edit[Open in editor]' 'delete[Remove a template]' 'use[Instantiate template]' 'vars[Show template variables]'
          ;;
        context|ctx|window|prompt-debug)
          _values 'subcommand' 'show[Show full assembled context]' 'tokens[Token count breakdown]' 'facts[List working memory facts]' 'add[Add a fact]' 'remove[Remove a fact]' 'clear[Clear all facts]' 'messages[List conversation messages]' 'simulate[Preview RAG context injection]' 'sessions[List active sessions]'
          ;;
        pipe|pipeline|chain)
          _values 'subcommand' 'list[List saved pipelines]' 'show[Display pipeline definition]' 'save[Save a pipeline]' 'delete[Delete a saved pipeline]' 'run[Run a saved pipeline]'
          ;;
        alias|aliases|shortcut|shortcuts)
          _values 'subcommand' 'list[List all aliases]' 'add[Create a new alias]' 'remove[Remove an alias]' 'show[Show alias details]' 'edit[Update an alias]' 'run[Run an alias]' 'export[Export aliases]' 'import[Import aliases]'
          ;;
        env|envs|environment|environments)
          _values 'subcommand' 'current[Show active environment]' 'list[List all environments]' 'show[Display environment config]' 'create[Create a new environment]' 'use[Switch to environment]' 'edit[Open in editor]' 'delete[Remove an environment]' 'diff[Compare two environments]' 'reset[Deactivate environment]'
          ;;
        log|logs)
          _values 'subcommand' 'show[Show log entries with filters]' 'tail[Live-follow the log file]' 'search[Full-text search logs]' 'stats[Log file statistics]' 'levels[Log level breakdown]' 'modules[Module breakdown]' 'clear[Truncate log file]' 'path[Print log file path]'
          ;;
        profile|bench|benchmark)
          _values 'suite' 'all[Run all benchmarks]' 'audit[Audit log operations]' 'vault[Vault I/O operations]' 'trust[Trust engine operations]' 'db[Raw database operations]' 'hash[Hash chain verification]' 'memory[Memory tier operations]'
          ;;
        diff|changes|delta)
          _values 'subcommand' 'log[Show vault commit history]' 'show[Show a specific commit]' 'stat[File change statistics]' 'blame[Line-by-line blame]' 'between[Diff between two commits]' 'files[List changed files]' 'summary[Vault evolution summary]'
          ;;
        snapshot|snap|checkpoint)
          _values 'subcommand' 'list[List all snapshots]' 'create[Create a named snapshot]' 'show[Show snapshot details]' 'diff[Diff snapshot vs HEAD or another]' 'restore[Restore vault to a snapshot]' 'delete[Delete a snapshot]' 'export[Export snapshot as tar.gz]'
          ;;
        graph|links|kg)
          _values 'subcommand' 'hubs[Top connected entities]' 'orphans[Entities with no links]' 'islands[Disconnected clusters]' 'path[Shortest path between two entities]' 'neighbors[Direct connections for entity]' 'broken[Broken wikilinks]' 'dot[Export as Graphviz DOT]' 'summary[Graph overview statistics]'
          ;;
        task|tasks|todo|todos)
          _values 'subcommand' 'list[List tasks]' 'add[Create a task]' 'show[Show task details]' 'edit[Edit a task]' 'done[Mark task complete]' 'archive[Archive completed tasks]' 'board[Kanban board view]' 'stats[Task statistics]' 'projects[List projects]' 'search[Search tasks]'
          ;;
        run|ask|query|q)
          _arguments \\
            '-q[Query text]:query' \\
            '--query[Query text]:query' \\
            '-f[File to attach]:file:_files' \\
            '--file[File to attach]:file:_files' \\
            '-s[Session ID]:session' \\
            '--session[Session ID]:session' \\
            '-m[Model override]:model' \\
            '--model[Model override]:model' \\
            '--system[System prompt override]:prompt' \\
            '--json[JSON output]' \\
            '--raw[Raw text output]' \\
            '--no-rag[Skip RAG retrieval]' \\
            '--no-tools[Disable tool execution]' \\
            '-t[Timeout in seconds]:seconds' \\
            '--timeout[Timeout in seconds]:seconds' \\
            '-v[Verbose output]' \\
            '--verbose[Verbose output]' \\
            '*:query'
          ;;
        serve)
          _arguments \\
            '-p[Port]:port' \\
            '--port[Port]:port' \\
            '-h[Host]:host' \\
            '--host[Host]:host' \\
            '-t[API token]:token' \\
            '--token[API token]:token' \\
            '--cors[CORS origin]:origin'
          ;;
        search)
          _arguments \\
            '-n[Max results]:number' \\
            '--limit[Max results]:number' \\
            '--fts-only[FTS search only]' \\
            '--verbose[Show search metrics]' \\
            '*:query'
          ;;
        history)
          _arguments \\
            '-n[Max entries]:number' \\
            '--type[Filter by event type]:type' \\
            '--from[Filter from date]:date' \\
            '--to[Filter to date]:date' \\
            '--verify[Verify hash chain]' \\
            '--types[List event types]' \\
            '--json[JSON output]'
          ;;
        export)
          _arguments \\
            '-o[Output file]:file:_files' \\
            '--pretty[Pretty-print JSON]' \\
            '--include-audit[Include audit entries]' \\
            '--include-stats[Include stats]' \\
            '--folder[Export single folder]:folder'
          ;;
        import)
          _arguments \\
            '--dry-run[Preview without writing]' \\
            '--merge[Skip existing files]' \\
            '--overwrite[Overwrite existing files]' \\
            '*:file:_files'
          ;;
        restore)
          _files -g '*.tar.gz'
          ;;
      esac
      ;;
  esac
}

_ved
`;

      case 'fish':
        return `# Ved fish completions — save to ~/.config/fish/completions/ved.fish

# Disable file completions by default
complete -c ved -f

# Top-level commands
${commands.map(c => `complete -c ved -n '__fish_use_subcommand' -a '${c}'`).join('\n')}

# config subcommands
${configSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from config' -a '${s}'`).join('\n')}

# backup subcommands
${backupSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from backup' -a '${s}'`).join('\n')}

# cron subcommands
${cronSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from cron' -a '${s}'`).join('\n')}

# upgrade subcommands
${upgradeSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from upgrade' -a '${s}'`).join('\n')}

# webhook subcommands
${webhookSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from webhook' -a '${s}'`).join('\n')}

# hook subcommands
${hookSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from hook' -a '${s}'`).join('\n')}

# notify subcommands
${notifySubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from notify' -a '${s}'`).join('\n')}

# tag subcommands
${tagSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from tag' -a '${s}'`).join('\n')}

# migrate subcommands
${migrateSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from migrate' -a '${s}'`).join('\n')}

# sync subcommands
${syncSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from sync remote remotes' -a '${s}'`).join('\n')}
complete -c ved -n '__fish_seen_subcommand_from sync remote remotes' -l force -d 'Force overwrite'
complete -c ved -n '__fish_seen_subcommand_from sync remote remotes' -l limit -d 'History limit'
complete -c ved -n '__fish_seen_subcommand_from sync remote remotes' -l failed-only -d 'Show only failures'
complete -c ved -n '__fish_seen_subcommand_from sync remote remotes' -l show-auth -d 'Show auth data'

# agent subcommands
${agentSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -a '${s}'`).join('\n')}
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l template -s t -d 'Use built-in template'
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l description -s d -d 'Agent description'
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l model -s m -d 'LLM model override'
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l tier -d 'Trust tier (1-4)'
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l json -d 'JSON output'
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l dry-run -d 'Dry run'
complete -c ved -n '__fish_seen_subcommand_from agent agents persona personas' -l merge -d 'Merge on import'

# replay subcommands
${replaySubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -a '${s}'`).join('\n')}
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l limit -s n -d 'Max results'
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l verbose -s v -d 'Verbose output'
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l json -d 'JSON output'
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l depth -s d -d 'Chain depth'
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l format -s f -d 'Export format'
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l output -s o -d 'Output file'
complete -c ved -n '__fish_seen_subcommand_from replay replays playback' -l markdown -d 'Markdown format'

# memory subcommands
${memorySubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from memory' -a '${s}'`).join('\n')}

# trust subcommands
${trustSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from trust' -a '${s}'`).join('\n')}

# user subcommands
${userSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from user' -a '${s}'`).join('\n')}

# prompt subcommands
${promptSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from prompt' -a '${s}'`).join('\n')}

# template subcommands
${templateSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from template' -a '${s}'`).join('\n')}

# context subcommands
${contextSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from context' -a '${s}'`).join('\n')}

# pipe subcommands
${pipeSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from pipe pipeline chain' -a '${s}'`).join('\n')}

# pipe flags
complete -c ved -n '__fish_seen_subcommand_from pipe pipeline chain' -s f -l file -d 'Pipeline YAML file' -F
complete -c ved -n '__fish_seen_subcommand_from pipe pipeline chain' -l json -d 'JSON output'
complete -c ved -n '__fish_seen_subcommand_from pipe pipeline chain' -l raw -d 'Raw output'
complete -c ved -n '__fish_seen_subcommand_from pipe pipeline chain' -s v -l verbose -d 'Verbose output'
complete -c ved -n '__fish_seen_subcommand_from pipe pipeline chain' -s n -l dry-run -d 'Dry run'

# alias subcommands
${aliasSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from alias aliases shortcut shortcuts' -a '${s}'`).join('\n')}

# env subcommands
${envSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from env envs environment environments' -a '${s}'`).join('\n')}

# log subcommands
${logSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from log logs' -a '${s}'`).join('\n')}

# log flags
complete -c ved -n '__fish_seen_subcommand_from log logs' -l level -d 'Minimum log level'
complete -c ved -n '__fish_seen_subcommand_from log logs' -l module -d 'Filter by module'
complete -c ved -n '__fish_seen_subcommand_from log logs' -l since -d 'Entries after time'
complete -c ved -n '__fish_seen_subcommand_from log logs' -l until -d 'Entries before time'
complete -c ved -n '__fish_seen_subcommand_from log logs' -s n -l limit -d 'Max entries'
complete -c ved -n '__fish_seen_subcommand_from log logs' -l json -d 'Raw JSON output'
complete -c ved -n '__fish_seen_subcommand_from log logs' -l no-color -d 'Disable colors'

# profile
complete -c ved -n '__fish_use_subcommand' -a profile -d 'Performance benchmarking'
complete -c ved -n '__fish_use_subcommand' -a bench -d 'Performance benchmarking (alias)'
complete -c ved -n '__fish_use_subcommand' -a benchmark -d 'Performance benchmarking (alias)'
complete -c ved -n '__fish_use_subcommand' -a snapshot -d 'Vault point-in-time snapshots'
complete -c ved -n '__fish_use_subcommand' -a snap -d 'Vault snapshots (alias)'
complete -c ved -n '__fish_use_subcommand' -a checkpoint -d 'Vault snapshots (alias)'
complete -c ved -n '__fish_seen_subcommand_from profile bench benchmark' -a 'all audit vault trust db hash memory' -d 'Benchmark suite'
complete -c ved -n '__fish_seen_subcommand_from profile bench benchmark' -s i -l iterations -d 'Iterations per benchmark'
complete -c ved -n '__fish_seen_subcommand_from profile bench benchmark' -s w -l warmup -d 'Warmup iterations'
complete -c ved -n '__fish_seen_subcommand_from profile bench benchmark' -l json -d 'JSON output'
complete -c ved -n '__fish_seen_subcommand_from profile bench benchmark' -s v -l verbose -d 'Show iteration times'
complete -c ved -n '__fish_seen_subcommand_from profile bench benchmark' -l no-color -d 'Disable colors'

# diff subcommands
${diffSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from diff changes delta' -a '${s}'`).join('\n')}

# diff flags
complete -c ved -n '__fish_seen_subcommand_from diff changes delta' -l limit -d 'Max entries'
complete -c ved -n '__fish_seen_subcommand_from diff changes delta' -s n -d 'Max entries'
complete -c ved -n '__fish_seen_subcommand_from diff changes delta' -l since -d 'Filter by date'
complete -c ved -n '__fish_seen_subcommand_from diff changes delta' -l days -d 'Days to look back'
complete -c ved -n '__fish_seen_subcommand_from diff changes delta' -l file -d 'Specific file'

# snapshot subcommands
${snapshotSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from snapshot snap checkpoint' -a '${s}'`).join('\n')}
complete -c ved -n '__fish_seen_subcommand_from snapshot snap checkpoint; and __fish_seen_subcommand_from create' -s m -d 'Snapshot message'
complete -c ved -n '__fish_seen_subcommand_from snapshot snap checkpoint; and __fish_seen_subcommand_from restore' -l force -d 'Force restore discarding changes'
complete -c ved -n '__fish_seen_subcommand_from snapshot snap checkpoint; and __fish_seen_subcommand_from diff' -l stat -d 'Show stat summary only'
complete -c ved -n '__fish_seen_subcommand_from snapshot snap checkpoint; and __fish_seen_subcommand_from delete' -l force -d 'Force delete safety snapshots'

# env flags
complete -c ved -n '__fish_seen_subcommand_from env; and __fish_seen_subcommand_from create' -l from -d 'Copy from existing environment'
complete -c ved -n '__fish_seen_subcommand_from env; and __fish_seen_subcommand_from create' -l from-current -d 'Snapshot current config'
complete -c ved -n '__fish_seen_subcommand_from env; and __fish_seen_subcommand_from create' -l template -d 'Built-in template (dev/prod/test)'

# run flags
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -s q -l query -d 'Query text'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -s f -l file -d 'Attach file' -F
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -s s -l session -d 'Session ID'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -s m -l model -d 'Model override'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -l system -d 'System prompt override'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -l json -d 'JSON output'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -l raw -d 'Raw text output'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -l no-rag -d 'Skip RAG retrieval'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -l no-tools -d 'Disable tools'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -s t -l timeout -d 'Timeout seconds'
complete -c ved -n '__fish_seen_subcommand_from run ask query q' -s v -l verbose -d 'Verbose output'

# serve flags
complete -c ved -n '__fish_seen_subcommand_from serve' -s p -l port -d 'Port'
complete -c ved -n '__fish_seen_subcommand_from serve' -s h -l host -d 'Host'
complete -c ved -n '__fish_seen_subcommand_from serve' -s t -l token -d 'API token'
complete -c ved -n '__fish_seen_subcommand_from serve' -l cors -d 'CORS origin'

# search flags
complete -c ved -n '__fish_seen_subcommand_from search' -s n -l limit -d 'Max results'
complete -c ved -n '__fish_seen_subcommand_from search' -l fts-only -d 'FTS search only'
complete -c ved -n '__fish_seen_subcommand_from search' -s v -l verbose -d 'Show metrics'

# history flags
complete -c ved -n '__fish_seen_subcommand_from history' -s n -l limit -d 'Max entries'
complete -c ved -n '__fish_seen_subcommand_from history' -s t -l type -d 'Filter by event type'
complete -c ved -n '__fish_seen_subcommand_from history' -l from -d 'From date'
complete -c ved -n '__fish_seen_subcommand_from history' -l to -d 'To date'
complete -c ved -n '__fish_seen_subcommand_from history' -l verify -d 'Verify chain'
complete -c ved -n '__fish_seen_subcommand_from history' -l types -d 'List event types'
complete -c ved -n '__fish_seen_subcommand_from history' -l json -d 'JSON output'

# export flags
complete -c ved -n '__fish_seen_subcommand_from export' -s o -l output -d 'Output file' -F
complete -c ved -n '__fish_seen_subcommand_from export' -l pretty -d 'Pretty-print'
complete -c ved -n '__fish_seen_subcommand_from export' -l include-audit -d 'Include audit'
complete -c ved -n '__fish_seen_subcommand_from export' -l include-stats -d 'Include stats'
complete -c ved -n '__fish_seen_subcommand_from export' -l folder -d 'Single folder'

# import flags
complete -c ved -n '__fish_seen_subcommand_from import' -l dry-run -d 'Preview only'
complete -c ved -n '__fish_seen_subcommand_from import' -l merge -d 'Skip existing'
complete -c ved -n '__fish_seen_subcommand_from import' -l overwrite -d 'Overwrite existing'

# backup flags
complete -c ved -n '__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from create' -s d -l dir -d 'Backup directory'
complete -c ved -n '__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from create' -s n -l max -d 'Max backups to keep'
complete -c ved -n '__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from restore' -F

# graph subcommands
${graphSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from graph links kg' -a '${s}'`).join('\n')}
complete -c ved -n '__fish_seen_subcommand_from graph links kg' -s n -l limit -d 'Max results'
complete -c ved -n '__fish_seen_subcommand_from graph links kg' -l min-links -d 'Minimum link count'
complete -c ved -n '__fish_seen_subcommand_from graph links kg' -s d -l depth -d 'Traversal depth'
complete -c ved -n '__fish_seen_subcommand_from graph links kg' -s v -l verbose -d 'Verbose output'

# task subcommands
${taskSubs.map(s => `complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -a '${s}'`).join('\n')}
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -l status -d 'Filter by status'
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -l project -d 'Filter by project'
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -l priority -d 'Filter by priority'
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -l tag -d 'Filter by tag'
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -s n -l limit -d 'Max results'
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -s v -l verbose -d 'Verbose output'
complete -c ved -n '__fish_seen_subcommand_from task tasks todo todos' -l json -d 'JSON output'
`;

      default:
        throw new Error(`Unknown shell: ${shell}`);
    }
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
  async indexVaultOnStartup(): Promise<void> {
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
