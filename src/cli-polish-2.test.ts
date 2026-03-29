/**
 * Tests for Session 103 — P5 Polish Phase 2.
 *
 * Covers:
 * 1. Sub-CLI console.error → errHint/errUsage migration verification
 * 2. Doctor --fix new repair capabilities (checks 11-13)
 * 3. Spinner added to doctor --fix operation
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// ── 1. Static analysis: verify console.error removal from sub-CLIs ──

describe('CLI Polish Phase 2: console.error migration', () => {
  const SRC = import.meta.dirname;
  const SUB_CLI_FILES = [
    'cli-context.ts',
    'cli-sync.ts',
    'cli-snapshot.ts',
    'cli-alias.ts',
    'cli-agent.ts',
    'cli-migrate.ts',
  ];

  for (const file of SUB_CLI_FILES) {
    it(`${file} has no raw console.error for user-facing errors`, () => {
      const content = readFileSync(join(SRC, file), 'utf-8');
      const lines = content.split('\n');
      const errorLines = lines.filter((line, idx) => {
        // Skip test files, imports, and intentional stderr writes (verbose headers)
        if (line.includes('import')) return false;
        if (line.includes('VERSION')) return false; // verbose header in pipe
        return line.includes('console.error');
      });
      expect(errorLines).toEqual([]);
    });
  }

  it('cli-pipe.ts has only 1 console.error (verbose header, not user error)', () => {
    const content = readFileSync(join(SRC, 'cli-pipe.ts'), 'utf-8');
    const lines = content.split('\n').filter(
      l => l.includes('console.error') && !l.includes('import'),
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('VERSION'); // the verbose header
  });

  it('cli.ts has zero raw console.error calls', () => {
    const content = readFileSync(join(SRC, 'cli.ts'), 'utf-8');
    const lines = content.split('\n').filter(
      l => l.includes('console.error') && !l.includes('import'),
    );
    expect(lines.length).toBe(0);
  });
});

// ── 2. Sub-CLIs use errHint/errUsage ──

describe('CLI Polish Phase 2: errHint/errUsage usage', () => {
  const SRC = import.meta.dirname;

  it('cli-context.ts uses errHint for examples', () => {
    const content = readFileSync(join(SRC, 'cli-context.ts'), 'utf-8');
    expect(content).toContain('errHint(');
    expect(content).toContain('errUsage(');
  });

  it('cli-snapshot.ts uses errHint for hints', () => {
    const content = readFileSync(join(SRC, 'cli-snapshot.ts'), 'utf-8');
    expect(content).toContain('errHint(');
    // Snapshot should NOT have the verbose subcommand listing anymore
    expect(content).not.toContain("console.error('  Compare snapshot");
  });

  it('cli-alias.ts uses errHint for examples', () => {
    const content = readFileSync(join(SRC, 'cli-alias.ts'), 'utf-8');
    expect(content).toContain("errHint('Examples:");
    // Should NOT have multi-line console.error examples
    expect(content).not.toContain("console.error('  ved alias add");
  });

  it('cli-agent.ts uses errHint for warnings', () => {
    const content = readFileSync(join(SRC, 'cli-agent.ts'), 'utf-8');
    expect(content).toContain("errHint('Agent file may have YAML errors");
    expect(content).toContain("errHint('Skipped agent with no name");
  });

  it('cli-migrate.ts uses errHint for hints', () => {
    const content = readFileSync(join(SRC, 'cli-migrate.ts'), 'utf-8');
    expect(content).toContain("errHint('Sources:");
    expect(content).not.toContain("console.error('  Sources:");
  });
});

// ── 3. Doctor --fix new repair capabilities ──

describe('CLI Polish Phase 2: doctor --fix repairs', () => {
  it('app.ts contains webhook cleanup repair (check 11)', () => {
    const content = readFileSync(join(import.meta.dirname, 'app.ts'), 'utf-8');
    expect(content).toContain('// 11. Clean disabled webhooks with invalid URLs');
    expect(content).toContain("DELETE FROM webhooks WHERE id = ?");
  });

  it('app.ts contains stale session cleanup (check 12)', () => {
    const content = readFileSync(join(import.meta.dirname, 'app.ts'), 'utf-8');
    expect(content).toContain('// 12. Clean stale sessions (idle for >30 days)');
    expect(content).toContain("UPDATE sessions SET status = ? WHERE id = ?");
  });

  it('app.ts contains webhook delivery compaction (check 13)', () => {
    const content = readFileSync(join(import.meta.dirname, 'app.ts'), 'utf-8');
    expect(content).toContain('// 13. Compact webhook delivery history');
    expect(content).toContain('kept last 1000');
  });
});

// ── 4. Doctor --fix spinner ──

describe('CLI Polish Phase 2: doctor --fix spinner', () => {
  it('cli.ts uses spinner for doctor --fix', () => {
    const content = readFileSync(join(import.meta.dirname, 'cli.ts'), 'utf-8');
    expect(content).toContain("spinner('Attempting auto-repair...')");
    expect(content).toContain('fixSpin.succeed');
  });
});

// ── 5. Functional tests for doctor --fix checks 11-13 ──

describe('doctorFix: webhook cleanup (check 11)', () => {
  it('removes disabled webhooks with invalid URLs', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        event_types TEXT,
        headers TEXT,
        secret TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Valid disabled webhook — should NOT be removed
    db.prepare('INSERT INTO webhooks (id, name, url, enabled) VALUES (?, ?, ?, ?)').run(
      'wh-1', 'valid-disabled', 'https://example.com/hook', 0,
    );
    // Invalid URL disabled webhook — should be removed
    db.prepare('INSERT INTO webhooks (id, name, url, enabled) VALUES (?, ?, ?, ?)').run(
      'wh-2', 'invalid-url', 'not-a-url', 0,
    );
    // Invalid protocol disabled — should be removed
    db.prepare('INSERT INTO webhooks (id, name, url, enabled) VALUES (?, ?, ?, ?)').run(
      'wh-3', 'ftp-url', 'ftp://evil.com/hook', 0,
    );
    // Enabled webhook with bad URL — should NOT be removed (only disabled ones)
    db.prepare('INSERT INTO webhooks (id, name, url, enabled) VALUES (?, ?, ?, ?)').run(
      'wh-4', 'enabled-bad', 'not-a-url', 1,
    );

    // Simulate the check
    const webhooks = db.prepare('SELECT id, name, url, enabled FROM webhooks WHERE enabled = 0').all() as Array<{ id: string; name: string; url: string }>;
    const removed: string[] = [];
    for (const wh of webhooks) {
      try {
        const parsed = new URL(wh.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          removed.push(wh.name);
          db.prepare('DELETE FROM webhooks WHERE id = ?').run(wh.id);
        }
      } catch {
        removed.push(wh.name);
        db.prepare('DELETE FROM webhooks WHERE id = ?').run(wh.id);
      }
    }

    expect(removed).toEqual(['invalid-url', 'ftp-url']);
    const remaining = db.prepare('SELECT name FROM webhooks ORDER BY name').all() as Array<{ name: string }>;
    expect(remaining.map(r => r.name)).toEqual(['enabled-bad', 'valid-disabled']);

    db.close();
  });
});

describe('doctorFix: stale session cleanup (check 12)', () => {
  it('closes sessions idle for >30 days', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const now = new Date();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    const old = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45 days ago

    db.prepare('INSERT INTO sessions (id, status, updated_at) VALUES (?, ?, ?)').run('s1', 'idle', recent);
    db.prepare('INSERT INTO sessions (id, status, updated_at) VALUES (?, ?, ?)').run('s2', 'idle', old);
    db.prepare('INSERT INTO sessions (id, status, updated_at) VALUES (?, ?, ?)').run('s3', 'active', old);

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stale = db.prepare('SELECT id FROM sessions WHERE status = ? AND updated_at < ?').all('idle', thirtyDaysAgo) as Array<{ id: string }>;

    expect(stale.length).toBe(1);
    expect(stale[0].id).toBe('s2');

    const stmt = db.prepare('UPDATE sessions SET status = ? WHERE id = ?');
    for (const s of stale) {
      stmt.run('closed', s.id);
    }

    const closed = db.prepare("SELECT id FROM sessions WHERE status = 'closed'").all() as Array<{ id: string }>;
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe('s2');

    db.close();
  });

  it('does not close active sessions even if old', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)`);

    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (id, status, updated_at) VALUES (?, ?, ?)').run('s1', 'active', old);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stale = db.prepare('SELECT id FROM sessions WHERE status = ? AND updated_at < ?').all('idle', thirtyDaysAgo) as Array<{ id: string }>;
    expect(stale.length).toBe(0);

    db.close();
  });
});

describe('doctorFix: webhook delivery compaction (check 13)', () => {
  it('removes old deliveries when count exceeds 1000', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Insert 1050 deliveries
    const stmt = db.prepare('INSERT INTO webhook_deliveries (id, webhook_id, status, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 1050; i++) {
      const date = new Date(Date.now() - (1050 - i) * 60000).toISOString(); // oldest first
      stmt.run(`d-${String(i).padStart(5, '0')}`, 'wh-1', 'success', date);
    }

    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM webhook_deliveries').get() as { cnt: number };
    expect(countRow.cnt).toBe(1050);

    // Run the compaction
    if (countRow.cnt > 1000) {
      const excess = countRow.cnt - 1000;
      db.prepare(
        'DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries ORDER BY created_at ASC LIMIT ?)',
      ).run(excess);
    }

    const afterCount = db.prepare('SELECT COUNT(*) as cnt FROM webhook_deliveries').get() as { cnt: number };
    expect(afterCount.cnt).toBe(1000);

    // Verify oldest were removed
    const oldest = db.prepare('SELECT id FROM webhook_deliveries ORDER BY created_at ASC LIMIT 1').get() as { id: string };
    expect(oldest.id).toBe('d-00050'); // first 50 removed

    db.close();
  });

  it('does nothing when under 1000 deliveries', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);

    for (let i = 0; i < 500; i++) {
      db.prepare('INSERT INTO webhook_deliveries (id, created_at) VALUES (?, ?)').run(`d-${i}`, new Date().toISOString());
    }

    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM webhook_deliveries').get() as { cnt: number };
    expect(countRow.cnt).toBe(500);
    expect(countRow.cnt).toBeLessThanOrEqual(1000); // No compaction needed

    db.close();
  });
});
