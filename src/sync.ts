/**
 * SyncManager — Vault synchronization engine for Ved.
 *
 * Manages remote sync endpoints (git, s3, rsync, local) and
 * tracks sync history in SQLite. CLI is in cli-sync.ts.
 *
 * @module sync
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { vedUlid } from './types/ulid.js';

// ── Types ──────────────────────────────────────────────────────────────

export type RemoteType = 'git' | 's3' | 'rsync' | 'local';
export type SyncDirection = 'push' | 'pull';
export type SyncStatus = 'started' | 'completed' | 'failed';
export type SyncState = 'ahead' | 'behind' | 'synced' | 'diverged' | 'unknown';

export const REMOTE_TYPES: RemoteType[] = ['git', 's3', 'rsync', 'local'];

export interface SyncRemote {
  id: string;
  name: string;
  type: RemoteType;
  url: string;
  enabled: boolean;
  authData?: string;
  createdAt: number;
}

export interface SyncHistory {
  id: string;
  remoteId: string;
  remoteName?: string;
  direction: SyncDirection;
  status: SyncStatus;
  filesChanged?: number;
  error?: string;
  timestamp: number;
}

export interface AdapterResult {
  filesChanged?: number;
}

export interface SyncAdapter {
  push(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult;
  pull(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult;
  status(vaultDir: string, url: string): SyncState;
}

// ── Validation ─────────────────────────────────────────────────────────

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

export function validateRemoteName(name: string): string | null {
  if (!name) return 'Remote name is required';
  if (!NAME_REGEX.test(name)) {
    return 'Remote name must be 1-64 chars, start with alphanumeric, contain only alphanumeric or hyphens';
  }
  return null;
}

export function validateRemoteUrl(type: RemoteType, url: string): string | null {
  if (!url) return 'URL is required';
  if (type === 'local') {
    if (url.includes('..')) return 'Local URL must not contain path traversal (..)';
    if (!isAbsolute(url) && !url.startsWith('~')) {
      return 'Local URL must be an absolute path or start with ~';
    }
  }
  return null;
}

// ── SyncManager ────────────────────────────────────────────────────────

export class SyncManager {
  constructor(
    private db: Database.Database,
    private vaultDir: string,
  ) {}

  addRemote(name: string, type: RemoteType, url: string, authData?: string): SyncRemote {
    const nameErr = validateRemoteName(name);
    if (nameErr) throw new Error(nameErr);

    if (!REMOTE_TYPES.includes(type)) {
      throw new Error(`Invalid remote type: ${type}. Must be one of: ${REMOTE_TYPES.join(', ')}`);
    }

    const urlErr = validateRemoteUrl(type, url);
    if (urlErr) throw new Error(urlErr);

    const existing = this.db.prepare('SELECT id FROM sync_remotes WHERE name = ?').get(name);
    if (existing) throw new Error(`Remote "${name}" already exists`);

    const id = vedUlid();
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(
      `INSERT INTO sync_remotes (id, name, type, url, enabled, auth_data, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).run(id, name, type, url, authData ?? null, now);

    return { id, name, type, url, enabled: true, authData, createdAt: now };
  }

  removeRemote(name: string): boolean {
    const remote = this.getRemote(name);
    if (!remote) return false;
    this.db.prepare('DELETE FROM sync_remotes WHERE name = ?').run(name);
    return true;
  }

  listRemotes(showAuth = false): SyncRemote[] {
    const rows = this.db.prepare('SELECT * FROM sync_remotes ORDER BY created_at').all() as RemoteRow[];
    return rows.map(r => this.rowToRemote(r, showAuth));
  }

  getRemote(name: string, showAuth = false): SyncRemote | null {
    const row = this.db.prepare('SELECT * FROM sync_remotes WHERE name = ?').get(name) as RemoteRow | undefined;
    return row ? this.rowToRemote(row, showAuth) : null;
  }

  push(remoteName: string, opts: { force?: boolean } = {}): SyncHistory {
    const remote = this.getRemote(remoteName, true);
    if (!remote) throw new Error(`Remote "${remoteName}" not found`);
    if (!remote.enabled) throw new Error(`Remote "${remoteName}" is disabled`);

    const histId = this.recordSync(remote.id, 'push', 'started');
    try {
      const adapter = getAdapter(remote.type);
      const result = adapter.push(this.vaultDir, remote.url, opts);
      this.updateSync(histId, 'completed', result.filesChanged);
      return this.getSyncById(histId)!;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateSync(histId, 'failed', undefined, errorMsg);
      throw err;
    }
  }

  pull(remoteName: string, opts: { force?: boolean } = {}): SyncHistory {
    const remote = this.getRemote(remoteName, true);
    if (!remote) throw new Error(`Remote "${remoteName}" not found`);
    if (!remote.enabled) throw new Error(`Remote "${remoteName}" is disabled`);

    const histId = this.recordSync(remote.id, 'pull', 'started');
    try {
      const adapter = getAdapter(remote.type);
      const result = adapter.pull(this.vaultDir, remote.url, opts);
      this.updateSync(histId, 'completed', result.filesChanged);
      return this.getSyncById(histId)!;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateSync(histId, 'failed', undefined, errorMsg);
      throw err;
    }
  }

  status(remoteName: string): SyncState {
    const remote = this.getRemote(remoteName, true);
    if (!remote) throw new Error(`Remote "${remoteName}" not found`);
    const adapter = getAdapter(remote.type);
    return adapter.status(this.vaultDir, remote.url);
  }

  getHistory(opts: { remoteName?: string; limit?: number; failedOnly?: boolean } = {}): SyncHistory[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.remoteName) {
      conditions.push('r.name = ?');
      params.push(opts.remoteName);
    }
    if (opts.failedOnly) {
      conditions.push("h.status = 'failed'");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts.limit ? `LIMIT ${opts.limit}` : '';

    const query = `
      SELECT h.*, r.name AS remote_name
      FROM sync_history h
      JOIN sync_remotes r ON r.id = h.remote_id
      ${where}
      ORDER BY h.timestamp DESC
      ${limitClause}
    `;

    const rows = this.db.prepare(query).all(...params) as HistoryRow[];
    return rows.map(r => this.rowToHistory(r));
  }

  clearHistory(remoteName?: string): number {
    if (remoteName) {
      const remote = this.getRemote(remoteName);
      if (!remote) return 0;
      const result = this.db.prepare('DELETE FROM sync_history WHERE remote_id = ?').run(remote.id);
      return result.changes;
    }
    const result = this.db.prepare('DELETE FROM sync_history').run();
    return result.changes;
  }

  // ── Private helpers ──

  private recordSync(remoteId: string, direction: SyncDirection, status: SyncStatus): string {
    const id = vedUlid();
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      `INSERT INTO sync_history (id, remote_id, direction, status, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, remoteId, direction, status, now);
    return id;
  }

  private updateSync(id: string, status: SyncStatus, filesChanged?: number, error?: string): void {
    this.db.prepare('UPDATE sync_history SET status = ?, files_changed = ?, error = ? WHERE id = ?')
      .run(status, filesChanged ?? null, error ?? null, id);
  }

  private getSyncById(id: string): SyncHistory | null {
    const row = this.db.prepare(
      `SELECT h.*, r.name AS remote_name
       FROM sync_history h JOIN sync_remotes r ON r.id = h.remote_id
       WHERE h.id = ?`
    ).get(id) as HistoryRow | undefined;
    return row ? this.rowToHistory(row) : null;
  }

  private rowToRemote(row: RemoteRow, showAuth: boolean): SyncRemote {
    return {
      id: row.id,
      name: row.name,
      type: row.type as RemoteType,
      url: row.url,
      enabled: row.enabled === 1,
      authData: showAuth ? (row.auth_data ?? undefined) : undefined,
      createdAt: row.created_at,
    };
  }

  private rowToHistory(row: HistoryRow): SyncHistory {
    return {
      id: row.id,
      remoteId: row.remote_id,
      remoteName: row.remote_name,
      direction: row.direction as SyncDirection,
      status: row.status as SyncStatus,
      filesChanged: row.files_changed ?? undefined,
      error: row.error ?? undefined,
      timestamp: row.timestamp,
    };
  }
}

// ── Row types ──────────────────────────────────────────────────────────

interface RemoteRow {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: number;
  auth_data: string | null;
  created_at: number;
}

interface HistoryRow {
  id: string;
  remote_id: string;
  remote_name: string;
  direction: string;
  status: string;
  files_changed: number | null;
  error: string | null;
  timestamp: number;
}

// ── Adapter registry ───────────────────────────────────────────────────

export function getAdapter(type: RemoteType): SyncAdapter {
  switch (type) {
    case 'git': return GitAdapter;
    case 'local': return LocalAdapter;
    case 's3': return S3Adapter;
    case 'rsync': return RsyncAdapter;
  }
}

// ── GitAdapter ─────────────────────────────────────────────────────────

const GIT_REMOTE_NAME = 'ved-sync';

export const GitAdapter: SyncAdapter = {
  push(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult {
    try {
      ensureGitRemote(vaultDir, url);
      const forceFlag = opts.force ? ' --force' : '';
      execSync(`git -C ${sq(vaultDir)} push ${GIT_REMOTE_NAME} HEAD:main${forceFlag}`, { stdio: 'pipe' });
      return {};
    } catch (err) {
      throw new Error(`Git push failed: ${errMsg(err)}`);
    }
  },

  pull(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult {
    try {
      ensureGitRemote(vaultDir, url);
      const forceFlag = opts.force ? ' --force' : '';
      execSync(`git -C ${sq(vaultDir)} pull ${GIT_REMOTE_NAME} main${forceFlag}`, { stdio: 'pipe' });
      return {};
    } catch (err) {
      throw new Error(`Git pull failed: ${errMsg(err)}`);
    }
  },

  status(vaultDir: string, url: string): SyncState {
    try {
      ensureGitRemote(vaultDir, url);
      try {
        execSync(`git -C ${sq(vaultDir)} fetch ${GIT_REMOTE_NAME} --quiet`, { stdio: 'pipe', timeout: 10000 });
      } catch {
        return 'unknown';
      }
      const ahead = execSync(
        `git -C ${sq(vaultDir)} rev-list HEAD..${GIT_REMOTE_NAME}/main --count`, { stdio: 'pipe' }
      ).toString().trim();
      const behind = execSync(
        `git -C ${sq(vaultDir)} rev-list ${GIT_REMOTE_NAME}/main..HEAD --count`, { stdio: 'pipe' }
      ).toString().trim();

      const aheadN = parseInt(ahead, 10) || 0;
      const behindN = parseInt(behind, 10) || 0;

      if (aheadN === 0 && behindN === 0) return 'synced';
      if (aheadN > 0 && behindN === 0) return 'behind';  // remote ahead, we need to pull
      if (aheadN === 0 && behindN > 0) return 'ahead';   // we're ahead, we need to push
      return 'diverged';
    } catch {
      return 'unknown';
    }
  },
};

function ensureGitRemote(vaultDir: string, url: string): void {
  try {
    execSync(`git -C ${sq(vaultDir)} remote get-url ${GIT_REMOTE_NAME}`, { stdio: 'pipe' });
  } catch {
    execSync(`git -C ${sq(vaultDir)} remote add ${GIT_REMOTE_NAME} ${sq(url)}`, { stdio: 'pipe' });
  }
}

// ── LocalAdapter ───────────────────────────────────────────────────────

export const LocalAdapter: SyncAdapter = {
  push(vaultDir: string, url: string, _opts: { force?: boolean }): AdapterResult {
    const dest = expandHome(url);
    try {
      mkdirSync(dest, { recursive: true });
      cpSync(vaultDir, dest, { recursive: true, force: true });
      return {};
    } catch (err) {
      throw new Error(`Local push failed: ${errMsg(err)}`);
    }
  },

  pull(vaultDir: string, url: string, _opts: { force?: boolean }): AdapterResult {
    const src = expandHome(url);
    if (!existsSync(src)) throw new Error(`Local source does not exist: ${src}`);
    try {
      mkdirSync(vaultDir, { recursive: true });
      cpSync(src, vaultDir, { recursive: true, force: true });
      return {};
    } catch (err) {
      throw new Error(`Local pull failed: ${errMsg(err)}`);
    }
  },

  status(_vaultDir: string, _url: string): SyncState {
    return 'unknown';
  },
};

// ── S3Adapter ──────────────────────────────────────────────────────────

export const S3Adapter: SyncAdapter = {
  push(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult {
    try {
      const deleteFlag = opts.force ? ' --delete' : '';
      const output = execSync(
        `aws s3 sync ${sq(vaultDir)} ${sq(url)}${deleteFlag}`,
        { stdio: 'pipe', timeout: 300000 }
      ).toString();
      const filesChanged = countLines(output, /^upload:|^copy:/m);
      return { filesChanged: filesChanged || undefined };
    } catch (err) {
      throw new Error(`S3 push failed: ${errMsg(err)}`);
    }
  },

  pull(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult {
    try {
      const deleteFlag = opts.force ? ' --delete' : '';
      const output = execSync(
        `aws s3 sync ${sq(url)} ${sq(vaultDir)}${deleteFlag}`,
        { stdio: 'pipe', timeout: 300000 }
      ).toString();
      const filesChanged = countLines(output, /^download:/m);
      return { filesChanged: filesChanged || undefined };
    } catch (err) {
      throw new Error(`S3 pull failed: ${errMsg(err)}`);
    }
  },

  status(_vaultDir: string, _url: string): SyncState {
    return 'unknown';
  },
};

// ── RsyncAdapter ───────────────────────────────────────────────────────

export const RsyncAdapter: SyncAdapter = {
  push(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult {
    try {
      const deleteFlag = opts.force ? ' --delete' : '';
      const src = trailingSlash(vaultDir);
      const output = execSync(
        `rsync -avz${deleteFlag} ${sq(src)} ${sq(url)}`,
        { stdio: 'pipe', timeout: 300000 }
      ).toString();
      return { filesChanged: countRsyncFiles(output) || undefined };
    } catch (err) {
      throw new Error(`Rsync push failed: ${errMsg(err)}`);
    }
  },

  pull(vaultDir: string, url: string, opts: { force?: boolean }): AdapterResult {
    try {
      const deleteFlag = opts.force ? ' --delete' : '';
      const src = trailingSlash(url);
      const output = execSync(
        `rsync -avz${deleteFlag} ${sq(src)} ${sq(vaultDir)}`,
        { stdio: 'pipe', timeout: 300000 }
      ).toString();
      return { filesChanged: countRsyncFiles(output) || undefined };
    } catch (err) {
      throw new Error(`Rsync pull failed: ${errMsg(err)}`);
    }
  },

  status(_vaultDir: string, _url: string): SyncState {
    return 'unknown';
  },
};

// ── Utilities ──────────────────────────────────────────────────────────

/** Shell-quote a string for use in execSync commands */
function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env['HOME'] ?? '');
}

function trailingSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countLines(output: string, pattern: RegExp): number {
  return (output.match(new RegExp(pattern.source, 'gm')) ?? []).length;
}

function countRsyncFiles(output: string): number {
  return output
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('sent ') && !l.startsWith('total size') && !l.startsWith('receiving') && l.includes('/'))
    .length;
}
