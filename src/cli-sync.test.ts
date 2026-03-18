/**
 * Tests for ved sync — vault synchronization manager.
 *
 * Covers: SyncManager CRUD, validation, local adapter push/pull,
 * history tracking, security (path traversal, auth redaction, SQL injection),
 * and CLI subcommand wiring.
 *
 * @module cli-sync.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  SyncManager,
  validateRemoteName,
  validateRemoteUrl,
  getAdapter,
  LocalAdapter,
  REMOTE_TYPES,
  type RemoteType,
  type SyncRemote,
} from './sync.js';

// ── DB Helper ──────────────────────────────────────────────────────────

const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_remotes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK(type IN ('git', 's3', 'rsync', 'local')),
  url         TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  auth_data   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sync_history (
  id            TEXT PRIMARY KEY,
  remote_id     TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
  status        TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
  files_changed INTEGER,
  error         TEXT,
  timestamp     INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (remote_id) REFERENCES sync_remotes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_history_remote ON sync_history(remote_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_timestamp ON sync_history(timestamp DESC);
`;

let db: Database.Database;
let vaultDir: string;
let tmpBase: string;

function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(SYNC_SCHEMA);
  return testDb;
}

function createVaultDir(): string {
  const dir = join(tmpBase, 'vault-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Test Vault');
  return dir;
}

function createGitVaultDir(): string {
  const dir = createVaultDir();
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/** Create a unique dest dir for local adapter tests (avoids git object permission issues) */
function uniqueDest(label: string): string {
  return join(tmpBase, `${label}-${Math.random().toString(36).slice(2)}`);
}

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ved-sync-test-'));
  vaultDir = createVaultDir();
  db = createTestDb();
});

afterEach(() => {
  try { db.close(); } catch {}
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── Validation Tests ───────────────────────────────────────────────────

describe('validateRemoteName', () => {
  it('accepts valid names', () => {
    expect(validateRemoteName('origin')).toBeNull();
    expect(validateRemoteName('my-backup')).toBeNull();
    expect(validateRemoteName('s3Backup01')).toBeNull();
    expect(validateRemoteName('a')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateRemoteName('')).toContain('required');
  });

  it('rejects names starting with hyphen', () => {
    expect(validateRemoteName('-bad')).toBeTruthy();
  });

  it('rejects names with special chars', () => {
    expect(validateRemoteName('my remote')).toBeTruthy();
    expect(validateRemoteName('my/remote')).toBeTruthy();
    expect(validateRemoteName('my.remote')).toBeTruthy();
  });

  it('rejects names longer than 63 chars', () => {
    expect(validateRemoteName('a'.repeat(64))).toBeTruthy();
  });

  it('accepts names up to 63 chars', () => {
    expect(validateRemoteName('a'.repeat(63))).toBeNull();
  });
});

describe('validateRemoteUrl', () => {
  it('rejects empty URL', () => {
    expect(validateRemoteUrl('git', '')).toContain('required');
  });

  it('accepts any URL for non-local types', () => {
    expect(validateRemoteUrl('git', 'https://github.com/user/repo.git')).toBeNull();
    expect(validateRemoteUrl('s3', 's3://bucket/prefix')).toBeNull();
    expect(validateRemoteUrl('rsync', 'user@host:/path')).toBeNull();
  });

  it('rejects relative paths for local type', () => {
    expect(validateRemoteUrl('local', 'relative/path')).toContain('absolute');
  });

  it('rejects path traversal for local type', () => {
    expect(validateRemoteUrl('local', '/some/../path')).toContain('traversal');
  });

  it('accepts absolute paths for local type', () => {
    expect(validateRemoteUrl('local', '/backups/vault')).toBeNull();
  });

  it('accepts tilde paths for local type', () => {
    expect(validateRemoteUrl('local', '~/backups/vault')).toBeNull();
  });
});

// ── SyncManager CRUD Tests ─────────────────────────────────────────────

describe('SyncManager', () => {
  let mgr: SyncManager;

  beforeEach(() => {
    mgr = new SyncManager(db, vaultDir);
  });

  describe('addRemote', () => {
    it('adds a remote and returns it', () => {
      const remote = mgr.addRemote('origin', 'git', 'https://github.com/user/vault.git');
      expect(remote.name).toBe('origin');
      expect(remote.type).toBe('git');
      expect(remote.url).toBe('https://github.com/user/vault.git');
      expect(remote.enabled).toBe(true);
      expect(remote.id).toBeTruthy();
      expect(remote.createdAt).toBeGreaterThan(0);
    });

    it('stores auth data when provided', () => {
      const remote = mgr.addRemote('s3-backup', 's3', 's3://my-bucket/vault', 'aws-profile-name');
      const fetched = mgr.getRemote('s3-backup', true);
      expect(fetched?.authData).toBe('aws-profile-name');
    });

    it('rejects duplicate names', () => {
      mgr.addRemote('origin', 'git', 'https://example.com/vault.git');
      expect(() => mgr.addRemote('origin', 'local', '/tmp/backup')).toThrow(/already exists/);
    });

    it('rejects invalid names', () => {
      expect(() => mgr.addRemote('', 'git', 'https://example.com')).toThrow();
      expect(() => mgr.addRemote('-bad', 'git', 'https://example.com')).toThrow();
    });

    it('rejects invalid types', () => {
      expect(() => mgr.addRemote('origin', 'ftp' as RemoteType, 'ftp://example.com')).toThrow(/Invalid remote type/);
    });

    it('rejects invalid URLs for local type', () => {
      expect(() => mgr.addRemote('backup', 'local', 'relative/path')).toThrow(/absolute/);
      expect(() => mgr.addRemote('backup', 'local', '/some/../path')).toThrow(/traversal/);
    });
  });

  describe('removeRemote', () => {
    it('removes an existing remote', () => {
      mgr.addRemote('origin', 'git', 'https://example.com/vault.git');
      expect(mgr.removeRemote('origin')).toBe(true);
      expect(mgr.getRemote('origin')).toBeNull();
    });

    it('returns false for non-existent remote', () => {
      expect(mgr.removeRemote('nonexistent')).toBe(false);
    });

    it('cascades history deletion when remote removed', () => {
      const remote = mgr.addRemote('backup', 'local', '/tmp/backup');
      // Manually insert history
      db.prepare(
        `INSERT INTO sync_history (id, remote_id, direction, status, timestamp)
         VALUES ('h1', ?, 'push', 'completed', ?)`
      ).run(remote.id, Math.floor(Date.now() / 1000));

      expect(mgr.getHistory({ remoteName: 'backup' })).toHaveLength(1);
      mgr.removeRemote('backup');
      // History should be gone (cascade)
      const remaining = db.prepare('SELECT COUNT(*) as c FROM sync_history WHERE remote_id = ?')
        .get(remote.id) as { c: number };
      expect(remaining.c).toBe(0);
    });
  });

  describe('listRemotes', () => {
    it('returns empty array when no remotes', () => {
      expect(mgr.listRemotes()).toEqual([]);
    });

    it('lists all remotes sorted by created_at', () => {
      mgr.addRemote('alpha', 'local', '/tmp/alpha');
      mgr.addRemote('beta', 'git', 'https://example.com');
      mgr.addRemote('gamma', 's3', 's3://bucket/prefix');
      const remotes = mgr.listRemotes();
      expect(remotes).toHaveLength(3);
      expect(remotes[0].name).toBe('alpha');
      expect(remotes[2].name).toBe('gamma');
    });

    it('hides auth data by default', () => {
      mgr.addRemote('secret', 's3', 's3://bucket', 'my-secret-key');
      const remotes = mgr.listRemotes(false);
      expect(remotes[0].authData).toBeUndefined();
    });

    it('shows auth data when requested', () => {
      mgr.addRemote('secret', 's3', 's3://bucket', 'my-secret-key');
      const remotes = mgr.listRemotes(true);
      expect(remotes[0].authData).toBe('my-secret-key');
    });
  });

  describe('getRemote', () => {
    it('returns null for non-existent remote', () => {
      expect(mgr.getRemote('nope')).toBeNull();
    });

    it('returns the correct remote', () => {
      mgr.addRemote('origin', 'git', 'https://example.com');
      const remote = mgr.getRemote('origin');
      expect(remote).not.toBeNull();
      expect(remote!.name).toBe('origin');
      expect(remote!.type).toBe('git');
    });
  });

  // ── Local Adapter Push/Pull ────────────────────────────────────────

  describe('push (local adapter)', () => {
    it('pushes vault to local directory', () => {
      const dest = uniqueDest('local-backup');
      mgr.addRemote('backup', 'local', dest);
      const hist = mgr.push('backup');
      expect(hist.status).toBe('completed');
      expect(hist.direction).toBe('push');
      expect(existsSync(join(dest, 'README.md'))).toBe(true);
    });

    it('creates destination directory if needed', () => {
      const dest = join(tmpBase, 'deeply', 'nested', 'backup-' + Math.random().toString(36).slice(2));
      mgr.addRemote('deep', 'local', dest);
      mgr.push('deep');
      expect(existsSync(dest)).toBe(true);
    });

    it('throws for non-existent remote', () => {
      expect(() => mgr.push('nope')).toThrow(/not found/);
    });

    it('throws for disabled remote', () => {
      mgr.addRemote('backup', 'local', join(tmpBase, 'backup'));
      db.prepare('UPDATE sync_remotes SET enabled = 0 WHERE name = ?').run('backup');
      expect(() => mgr.push('backup')).toThrow(/disabled/);
    });

    it('records failure in history on error', () => {
      // Use an invalid path that will fail
      mgr.addRemote('bad', 'local', '/dev/null/impossible');
      expect(() => mgr.push('bad')).toThrow();
      const hist = mgr.getHistory({ remoteName: 'bad' });
      expect(hist).toHaveLength(1);
      expect(hist[0].status).toBe('failed');
      expect(hist[0].error).toBeTruthy();
    });
  });

  describe('pull (local adapter)', () => {
    it('pulls from local directory to vault', () => {
      const src = join(tmpBase, 'local-source');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'note.md'), '# Pulled Note');
      mgr.addRemote('source', 'local', src);
      const hist = mgr.pull('source');
      expect(hist.status).toBe('completed');
      expect(readFileSync(join(vaultDir, 'note.md'), 'utf-8')).toContain('Pulled Note');
    });

    it('throws if source does not exist', () => {
      mgr.addRemote('ghost', 'local', join(tmpBase, 'nonexistent'));
      expect(() => mgr.pull('ghost')).toThrow(/does not exist/);
    });
  });

  // ── History Tests ──────────────────────────────────────────────────

  describe('history', () => {
    it('records completed syncs', () => {
      const dest = uniqueDest('hist-backup');
      mgr.addRemote('backup', 'local', dest);
      mgr.push('backup');
      mgr.push('backup');

      const hist = mgr.getHistory({ remoteName: 'backup' });
      expect(hist).toHaveLength(2);
      expect(hist.every(h => h.status === 'completed')).toBe(true);
      expect(hist[0].direction).toBe('push');
      expect(hist[0].remoteName).toBe('backup');
    });

    it('limits history results', () => {
      const dest = uniqueDest('limit-backup');
      mgr.addRemote('backup', 'local', dest);
      for (let i = 0; i < 5; i++) mgr.push('backup');

      const hist = mgr.getHistory({ remoteName: 'backup', limit: 2 });
      expect(hist).toHaveLength(2);
    });

    it('filters failed-only history', () => {
      const dest = uniqueDest('fail-backup');
      mgr.addRemote('backup', 'local', dest);
      mgr.push('backup'); // success
      mgr.addRemote('bad', 'local', '/dev/null/impossible');
      try { mgr.push('bad'); } catch {}

      const failedHist = mgr.getHistory({ failedOnly: true });
      expect(failedHist).toHaveLength(1);
      expect(failedHist[0].status).toBe('failed');
    });

    it('returns empty array with no history', () => {
      expect(mgr.getHistory()).toEqual([]);
    });

    it('clearHistory removes all entries', () => {
      const dest = uniqueDest('clear-backup');
      mgr.addRemote('backup', 'local', dest);
      mgr.push('backup');
      expect(mgr.getHistory()).toHaveLength(1);
      mgr.clearHistory();
      expect(mgr.getHistory()).toEqual([]);
    });

    it('clearHistory by remoteName is scoped', () => {
      const d1 = uniqueDest('scope1');
      const d2 = uniqueDest('scope2');
      mgr.addRemote('r1', 'local', d1);
      mgr.addRemote('r2', 'local', d2);
      mgr.push('r1');
      mgr.push('r2');
      mgr.clearHistory('r1');
      expect(mgr.getHistory({ remoteName: 'r1' })).toEqual([]);
      expect(mgr.getHistory({ remoteName: 'r2' })).toHaveLength(1);
    });
  });

  // ── Status Tests ───────────────────────────────────────────────────

  describe('status', () => {
    it('throws for non-existent remote', () => {
      expect(() => mgr.status('nope')).toThrow(/not found/);
    });

    it('returns unknown for local adapter', () => {
      mgr.addRemote('backup', 'local', join(tmpBase, 'backup'));
      expect(mgr.status('backup')).toBe('unknown');
    });
  });

  // ── Adapter Registry ───────────────────────────────────────────────

  describe('getAdapter', () => {
    it('returns adapter for each valid type', () => {
      for (const type of REMOTE_TYPES) {
        const adapter = getAdapter(type);
        expect(adapter).toBeDefined();
        expect(typeof adapter.push).toBe('function');
        expect(typeof adapter.pull).toBe('function');
        expect(typeof adapter.status).toBe('function');
      }
    });
  });
});

// ── Security Tests ─────────────────────────────────────────────────────

describe('Sync Security', () => {
  let mgr: SyncManager;

  beforeEach(() => {
    mgr = new SyncManager(db, vaultDir);
  });

  describe('path traversal protection', () => {
    it('blocks .. in local URL via validation', () => {
      expect(() => mgr.addRemote('evil', 'local', '/tmp/../etc/passwd')).toThrow(/traversal/);
    });

    it('blocks encoded .. in local URL', () => {
      // The URL must be absolute and not contain .. - straightforward check
      expect(() => mgr.addRemote('evil', 'local', '/tmp/..%2F..%2Fetc')).toThrow(/traversal/);
    });
  });

  describe('SQL injection in remote name', () => {
    it('parameterized queries prevent injection', () => {
      // The name validation should reject special chars, but even if bypassed:
      expect(() => mgr.addRemote("'; DROP TABLE sync_remotes; --", 'git', 'https://x.com')).toThrow();
      // Table should still exist
      const count = db.prepare('SELECT COUNT(*) as c FROM sync_remotes').get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  describe('auth data handling', () => {
    it('does not leak auth data in default listing', () => {
      mgr.addRemote('secure', 's3', 's3://bucket', 'AKIAIOSFODNN7EXAMPLE');
      const remotes = mgr.listRemotes(false);
      expect(remotes[0].authData).toBeUndefined();
    });

    it('does not leak auth data in getRemote default', () => {
      mgr.addRemote('secure', 's3', 's3://bucket', 'AKIAIOSFODNN7EXAMPLE');
      const remote = mgr.getRemote('secure');
      expect(remote?.authData).toBeUndefined();
    });

    it('auth data accessible when explicitly requested', () => {
      mgr.addRemote('secure', 's3', 's3://bucket', 'AKIAIOSFODNN7EXAMPLE');
      const remote = mgr.getRemote('secure', true);
      expect(remote?.authData).toBe('AKIAIOSFODNN7EXAMPLE');
    });
  });

  describe('disabled remote protection', () => {
    it('push rejects disabled remotes', () => {
      mgr.addRemote('backup', 'local', join(tmpBase, 'backup'));
      db.prepare('UPDATE sync_remotes SET enabled = 0 WHERE name = ?').run('backup');
      expect(() => mgr.push('backup')).toThrow(/disabled/);
    });

    it('pull rejects disabled remotes', () => {
      const src = join(tmpBase, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'test.md'), 'test');
      mgr.addRemote('source', 'local', src);
      db.prepare('UPDATE sync_remotes SET enabled = 0 WHERE name = ?').run('source');
      expect(() => mgr.pull('source')).toThrow(/disabled/);
    });
  });

  describe('type constraint enforcement', () => {
    it('DB enforces type CHECK constraint', () => {
      expect(() => {
        db.prepare(
          `INSERT INTO sync_remotes (id, name, type, url, enabled, created_at)
           VALUES ('x', 'bad', 'ftp', 'ftp://x', 1, 0)`
        ).run();
      }).toThrow();
    });

    it('DB enforces direction CHECK constraint', () => {
      const remote = mgr.addRemote('r', 'local', '/tmp/r');
      expect(() => {
        db.prepare(
          `INSERT INTO sync_history (id, remote_id, direction, status, timestamp)
           VALUES ('h', ?, 'download', 'completed', 0)`
        ).run(remote.id);
      }).toThrow();
    });

    it('DB enforces status CHECK constraint', () => {
      const remote = mgr.addRemote('r', 'local', '/tmp/r');
      expect(() => {
        db.prepare(
          `INSERT INTO sync_history (id, remote_id, direction, status, timestamp)
           VALUES ('h', ?, 'push', 'cancelled', 0)`
        ).run(remote.id);
      }).toThrow();
    });
  });
});

// ── LocalAdapter Direct Tests ──────────────────────────────────────────

describe('LocalAdapter', () => {
  it('push creates a faithful copy', () => {
    mkdirSync(join(vaultDir, 'entities'), { recursive: true });
    writeFileSync(join(vaultDir, 'entities', 'person.md'), '# Person');
    writeFileSync(join(vaultDir, 'config.yaml'), 'key: value');

    const dest = join(tmpBase, 'local-copy');
    LocalAdapter.push(vaultDir, dest, {});
    expect(readFileSync(join(dest, 'entities', 'person.md'), 'utf-8')).toContain('Person');
    expect(readFileSync(join(dest, 'config.yaml'), 'utf-8')).toContain('key: value');
  });

  it('pull overwrites vault files', () => {
    writeFileSync(join(vaultDir, 'README.md'), '# Original');
    const src = join(tmpBase, 'new-vault');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'README.md'), '# Updated');

    LocalAdapter.pull(vaultDir, src, {});
    expect(readFileSync(join(vaultDir, 'README.md'), 'utf-8')).toContain('Updated');
  });

  it('status always returns unknown for local', () => {
    expect(LocalAdapter.status(vaultDir, '/tmp')).toBe('unknown');
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  let mgr: SyncManager;

  beforeEach(() => {
    mgr = new SyncManager(db, vaultDir);
  });

  it('can add all 4 remote types', () => {
    mgr.addRemote('r-git', 'git', 'https://example.com');
    mgr.addRemote('r-local', 'local', '/tmp/backup');
    mgr.addRemote('r-s3', 's3', 's3://bucket/prefix');
    mgr.addRemote('r-rsync', 'rsync', 'user@host:/path');
    expect(mgr.listRemotes()).toHaveLength(4);
  });

  it('remote names are case-sensitive', () => {
    mgr.addRemote('Origin', 'git', 'https://example.com/a');
    mgr.addRemote('origin', 'git', 'https://example.com/b');
    expect(mgr.listRemotes()).toHaveLength(2);
  });

  it('history orders by timestamp descending', () => {
    const dest = uniqueDest('order-backup');
    mgr.addRemote('backup', 'local', dest);
    mgr.push('backup');
    mgr.push('backup');
    mgr.push('backup');

    const hist = mgr.getHistory();
    for (let i = 0; i < hist.length - 1; i++) {
      expect(hist[i].timestamp).toBeGreaterThanOrEqual(hist[i + 1].timestamp);
    }
  });

  it('clearHistory returns 0 for non-existent remote', () => {
    expect(mgr.clearHistory('nonexistent')).toBe(0);
  });

  it('push and pull record separate history entries', () => {
    const dir = uniqueDest('both-ways');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test.md'), 'test');
    mgr.addRemote('bidir', 'local', dir);

    mgr.push('bidir');
    mgr.pull('bidir');

    const hist = mgr.getHistory();
    const directions = hist.map(h => h.direction);
    expect(directions).toContain('push');
    expect(directions).toContain('pull');
  });

  it('multiple rapid syncs all recorded', () => {
    const dest = uniqueDest('rapid');
    mgr.addRemote('fast', 'local', dest);
    for (let i = 0; i < 10; i++) {
      mgr.push('fast');
    }
    expect(mgr.getHistory({ remoteName: 'fast' })).toHaveLength(10);
  });
});
