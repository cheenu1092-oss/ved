/**
 * Tests for `ved user` CLI — user management and inspection.
 * Session 65.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleUserCommand,
  getKnownUsers,
  getUserProfile,
  getUserSessions,
  getUserActivity,
  getUserStats,
} from './cli-user.js';
import { VedApp } from './app.js';
import Database from 'better-sqlite3';

// === Test Helpers ===

/** Access the private db for test seeding (INSERT/UPDATE) */
function getDb(app: VedApp): Database.Database {
  return (app as any).db as Database.Database;
}

function createTestApp(): { app: VedApp; dir: string } {
  const dir = join(tmpdir(), `ved-user-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  const vaultPath = join(dir, 'vault');
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(join(vaultPath, 'daily'), { recursive: true });
  mkdirSync(join(vaultPath, 'entities'), { recursive: true });
  mkdirSync(join(vaultPath, 'concepts'), { recursive: true });
  mkdirSync(join(vaultPath, 'decisions'), { recursive: true });

  const app = new VedApp({
    dbPath: join(dir, 'ved.db'),
    memory: { vaultPath, gitEnabled: false },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'test-key' },
    trust: {
      ownerIds: ['owner1'],
      tribeIds: ['tribe1'],
      knownIds: ['known1'],
      defaultTier: 1,
      approvalTimeoutMs: 300000,
      maxAgenticLoops: 10,
    },
    channels: [{ type: 'cli', enabled: true, config: {} }],
    mcp: { servers: [] },
    rag: {
      embedding: { model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://localhost:11434', batchSize: 10 },
      search: { vectorTopK: 5, ftsTopK: 5, graphDepth: 1 },
    },
    log: { level: 'error', format: 'text' },
    audit: { hmacSecret: 'test-secret', anchorIntervalMs: 0 },
  } as any);

  return { app, dir };
}

function seedUsers(app: VedApp) {
  const now = Date.now();
  const day = 86_400_000;

  // Insert sessions for multiple users
  const sessions = [
    { id: 'sess-1', channel: 'discord', channelId: 'guild1#chan1', authorId: 'user-alice', trustTier: 3, startedAt: now - 7 * day, lastActive: now - 1000, tokenCount: 1500, status: 'active' },
    { id: 'sess-2', channel: 'discord', channelId: 'guild1#chan2', authorId: 'user-alice', trustTier: 3, startedAt: now - 3 * day, lastActive: now - 2 * day, tokenCount: 800, status: 'closed' },
    { id: 'sess-3', channel: 'cli', channelId: 'tty1', authorId: 'user-bob', trustTier: 1, startedAt: now - 5 * day, lastActive: now - 4 * day, tokenCount: 200, status: 'closed' },
    { id: 'sess-4', channel: 'discord', channelId: 'guild1#chan1', authorId: 'user-charlie', trustTier: 4, startedAt: now - 1 * day, lastActive: now - 500, tokenCount: 3000, status: 'active' },
    { id: 'sess-5', channel: 'cli', channelId: 'tty2', authorId: 'user-alice', trustTier: 2, startedAt: now - 10 * day, lastActive: now - 8 * day, tokenCount: 100, status: 'closed' },
  ];

  const db = getDb(app);

  for (const s of sessions) {
    db.prepare(
      `INSERT INTO sessions (id, channel, channel_id, author_id, trust_tier, started_at, last_active, token_count, status)
       VALUES (@id, @channel, @channelId, @authorId, @trustTier, @startedAt, @lastActive, @tokenCount, @status)`,
    ).run(s);
  }

  // Insert inbox messages
  const messages = [
    { id: 'msg-1', channel: 'discord', channelId: 'guild1#chan1', authorId: 'user-alice', authorName: 'Alice', content: 'hello', receivedAt: now - 7 * day, processed: 1, sessionId: 'sess-1' },
    { id: 'msg-2', channel: 'discord', channelId: 'guild1#chan1', authorId: 'user-alice', authorName: 'Alice', content: 'how are you', receivedAt: now - 6 * day, processed: 1, sessionId: 'sess-1' },
    { id: 'msg-3', channel: 'discord', channelId: 'guild1#chan2', authorId: 'user-alice', authorName: 'Alice', content: 'test', receivedAt: now - 3 * day, processed: 1, sessionId: 'sess-2' },
    { id: 'msg-4', channel: 'cli', channelId: 'tty1', authorId: 'user-bob', authorName: 'Bob', content: 'search something', receivedAt: now - 5 * day, processed: 1, sessionId: 'sess-3' },
    { id: 'msg-5', channel: 'discord', channelId: 'guild1#chan1', authorId: 'user-charlie', authorName: 'Charlie', content: 'approve 123', receivedAt: now - 1 * day, processed: 1, sessionId: 'sess-4' },
  ];

  for (const m of messages) {
    db.prepare(
      `INSERT INTO inbox (id, channel, channel_id, author_id, author_name, content, received_at, processed, session_id)
       VALUES (@id, @channel, @channelId, @authorId, @authorName, @content, @receivedAt, @processed, @sessionId)`,
    ).run(m);
  }

  // Insert work orders
  db.prepare(
    `INSERT INTO work_orders (id, session_id, message_id, tool_name, params, risk_level, trust_tier, status, created_at, expires_at)
     VALUES ('wo-1', 'sess-4', 'msg-5', 'fs.write', '{}', 'high', 4, 'approved', @now, @exp)`,
  ).run({ now: now - day, exp: now + day });
  db.prepare(
    `INSERT INTO work_orders (id, session_id, message_id, tool_name, params, risk_level, trust_tier, status, created_at, expires_at)
     VALUES ('wo-2', 'sess-4', 'msg-5', 'fs.delete', '{}', 'critical', 4, 'denied', @now, @exp)`,
  ).run({ now: now - day, exp: now + day });

  return { now, day };
}

// === Tests ===

describe('ved user', () => {
  let app: VedApp;
  let dir: string;

  beforeEach(async () => {
    const result = createTestApp();
    app = result.app;
    dir = result.dir;
    await app.init();
  });

  afterEach(async () => {
    await app.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // --- list ---

  describe('list', () => {
    it('returns empty message when no users', async () => {
      const output = await handleUserCommand(app, ['list']);
      expect(output).toContain('No known users');
    });

    it('lists all known users', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['list']);
      expect(output).toContain('user-alice');
      expect(output).toContain('user-bob');
      expect(output).toContain('user-charlie');
      expect(output).toContain('Known Users');
    });

    it('filters by channel', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['list', '--channel', 'cli']);
      expect(output).toContain('user-bob');
      expect(output).toContain('user-alice'); // alice has cli sessions too
      expect(output).not.toContain('user-charlie'); // charlie only on discord
    });

    it('filters by tier', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['list', '--tier', '4']);
      expect(output).toContain('user-charlie');
      expect(output).not.toContain('user-bob');
    });

    it('respects limit', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['list', '--limit', '1']);
      expect(output).toContain('Total: 1 user(s)');
    });

    it('shows trust tier label', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['list']);
      expect(output).toMatch(/trust: (stranger|known|tribe|owner)/);
    });
  });

  // --- show ---

  describe('show', () => {
    it('returns usage when no userId', async () => {
      const output = await handleUserCommand(app, ['show']);
      expect(output).toContain('Usage');
    });

    it('returns not found for unknown user', async () => {
      const output = await handleUserCommand(app, ['show', 'nonexistent']);
      expect(output).toContain('User not found');
    });

    it('shows user profile', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['show', 'user-alice']);
      expect(output).toContain('User Profile');
      expect(output).toContain('user-alice');
      expect(output).toContain('Alice');
      expect(output).toContain('discord');
      expect(output).toContain('Sessions:');
      expect(output).toContain('Messages:');
    });

    it('shows work order counts', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['show', 'user-charlie']);
      expect(output).toContain('Work Orders:');
      expect(output).toContain('Approved: 1');
      expect(output).toContain('Denied: 1');
    });

    it('filters by channel', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['show', 'user-alice', '--channel', 'cli']);
      expect(output).toContain('cli');
      // Should only show CLI channel data
    });
  });

  // --- sessions ---

  describe('sessions', () => {
    it('returns usage when no userId', async () => {
      const output = await handleUserCommand(app, ['sessions']);
      expect(output).toContain('Usage');
    });

    it('lists sessions for a user', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['sessions', 'user-alice']);
      expect(output).toContain('sess-1');
      expect(output).toContain('sess-2');
      expect(output).toContain('sess-5');
      expect(output).toContain('Total: 3 session(s)');
    });

    it('filters by status', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['sessions', 'user-alice', '--status', 'active']);
      expect(output).toContain('sess-1');
      expect(output).not.toContain('sess-2');
      expect(output).toContain('Total: 1 session(s)');
    });

    it('filters by channel', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['sessions', 'user-alice', '--channel', 'cli']);
      expect(output).toContain('sess-5');
      expect(output).not.toContain('sess-1');
    });

    it('shows status indicators', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['sessions', 'user-alice']);
      expect(output).toContain('●'); // active
      expect(output).toContain('○'); // closed
    });

    it('returns empty for unknown user', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['sessions', 'nobody']);
      expect(output).toContain('No sessions found');
    });
  });

  // --- activity ---

  describe('activity', () => {
    it('returns usage when no userId', async () => {
      const output = await handleUserCommand(app, ['activity']);
      expect(output).toContain('Usage');
    });

    it('shows activity for a user', async () => {
      seedUsers(app);
      // Manually insert some audit entries
      const now = Date.now();
      getDb(app).prepare(
        `INSERT INTO audit_log (id, timestamp, event_type, actor, session_id, detail, prev_hash, hash)
         VALUES ('aud-1', @ts, 'message_received', 'user:user-alice', 'sess-1', '{"content":"hello"}', 'genesis', 'hash1')`,
      ).run({ ts: now - 1000 });
      getDb(app).prepare(
        `INSERT INTO audit_log (id, timestamp, event_type, actor, session_id, detail, prev_hash, hash)
         VALUES ('aud-2', @ts, 'tool_requested', 'user:user-alice', 'sess-1', '{"tool":"search"}', 'hash1', 'hash2')`,
      ).run({ ts: now - 500 });

      const output = await handleUserCommand(app, ['activity', 'user-alice']);
      expect(output).toContain('Activity for user-alice');
      expect(output).toContain('message_received');
      expect(output).toContain('tool_requested');
    });

    it('filters by event type', async () => {
      seedUsers(app);
      const now = Date.now();
      getDb(app).prepare(
        `INSERT INTO audit_log (id, timestamp, event_type, actor, session_id, detail, prev_hash, hash)
         VALUES ('aud-3', @ts, 'message_received', 'user:user-bob', 'sess-3', '{}', 'g', 'h1')`,
      ).run({ ts: now - 1000 });
      getDb(app).prepare(
        `INSERT INTO audit_log (id, timestamp, event_type, actor, session_id, detail, prev_hash, hash)
         VALUES ('aud-4', @ts, 'tool_executed', 'user:user-bob', 'sess-3', '{}', 'h1', 'h2')`,
      ).run({ ts: now - 500 });

      const output = await handleUserCommand(app, ['activity', 'user-bob', '--type', 'tool_executed']);
      expect(output).toContain('tool_executed');
      expect(output).not.toContain('message_received');
    });

    it('returns empty for user with no activity', async () => {
      const output = await handleUserCommand(app, ['activity', 'ghost']);
      expect(output).toContain('No activity found');
    });
  });

  // --- stats ---

  describe('stats', () => {
    it('shows zero stats when empty', async () => {
      const output = await handleUserCommand(app, ['stats']);
      expect(output).toContain('User Statistics');
      expect(output).toContain('Total users:      0');
    });

    it('shows aggregate stats', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['stats']);
      expect(output).toContain('User Statistics');
      expect(output).toContain('Total users:');
      expect(output).toContain('By Channel:');
      expect(output).toContain('discord');
      expect(output).toContain('cli');
      expect(output).toContain('By Trust Tier:');
    });
  });

  // --- help ---

  describe('help', () => {
    it('shows help for unknown subcommand', async () => {
      const output = await handleUserCommand(app, ['unknown']);
      expect(output).toContain('Usage: ved user');
      expect(output).toContain('list');
      expect(output).toContain('show');
      expect(output).toContain('sessions');
      expect(output).toContain('activity');
      expect(output).toContain('stats');
    });

    it('shows help with no args (defaults to list)', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, []);
      // Default is 'list', should show users
      expect(output).toContain('Known Users');
    });
  });

  // --- aliases ---

  describe('aliases', () => {
    it('ls is alias for list', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['ls']);
      expect(output).toContain('Known Users');
    });

    it('info is alias for show', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['info', 'user-alice']);
      expect(output).toContain('User Profile');
    });

    it('sess is alias for sessions', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['sess', 'user-alice']);
      expect(output).toContain('Sessions for');
    });

    it('log is alias for activity', async () => {
      const output = await handleUserCommand(app, ['log', 'user-alice']);
      expect(output).toContain('No activity found');
    });

    it('profile is alias for show', async () => {
      seedUsers(app);
      const output = await handleUserCommand(app, ['profile', 'user-alice']);
      expect(output).toContain('User Profile');
    });
  });

  // --- data access functions ---

  describe('getKnownUsers', () => {
    it('returns empty array when no users', () => {
      const users = getKnownUsers(app);
      expect(users).toEqual([]);
    });

    it('returns typed user objects', () => {
      seedUsers(app);
      const users = getKnownUsers(app);
      expect(users.length).toBeGreaterThan(0);
      for (const u of users) {
        expect(u).toHaveProperty('userId');
        expect(u).toHaveProperty('channel');
        expect(u).toHaveProperty('trustTier');
        expect(u).toHaveProperty('sessionCount');
        expect(u).toHaveProperty('lastActive');
        expect(u).toHaveProperty('firstSeen');
      }
    });
  });

  describe('getUserProfile', () => {
    it('returns null for unknown user', () => {
      const profile = getUserProfile(app, 'nonexistent');
      expect(profile).toBeNull();
    });

    it('returns profile with all fields', () => {
      seedUsers(app);
      const profile = getUserProfile(app, 'user-alice');
      expect(profile).not.toBeNull();
      expect(profile!.userId).toBe('user-alice');
      expect(profile!.userName).toBe('Alice');
      expect(profile!.channels).toContain('discord');
      expect(profile!.channels).toContain('cli');
      expect(profile!.totalSessions).toBe(3);
      expect(profile!.activeSessions).toBe(1);
      expect(profile!.totalMessages).toBe(3);
      expect(profile!.totalTokens).toBe(2400); // 1500+800+100
    });
  });

  describe('getUserSessions', () => {
    it('returns sessions sorted by last_active desc', () => {
      seedUsers(app);
      const sessions = getUserSessions(app, 'user-alice');
      expect(sessions.length).toBe(3);
      // Most recent first
      expect(sessions[0].lastActive).toBeGreaterThanOrEqual(sessions[1].lastActive);
      expect(sessions[1].lastActive).toBeGreaterThanOrEqual(sessions[2].lastActive);
    });
  });

  describe('getUserActivity', () => {
    it('returns activities for actor prefix user:', () => {
      seedUsers(app);
      const now = Date.now();
      getDb(app).prepare(
        `INSERT INTO audit_log (id, timestamp, event_type, actor, detail, prev_hash, hash)
         VALUES ('a1', @ts, 'test_event', 'user:user-alice', '{}', 'g', 'h')`,
      ).run({ ts: now });
      const events = getUserActivity(app, 'user-alice');
      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('test_event');
    });
  });

  describe('getUserStats', () => {
    it('counts unique user-channel pairs', () => {
      seedUsers(app);
      const stats = getUserStats(app);
      // alice has discord + cli = 2, bob has cli = 1, charlie has discord = 1 → 4
      expect(stats.totalUsers).toBe(4);
    });

    it('breaks down by channel', () => {
      seedUsers(app);
      const stats = getUserStats(app);
      expect(stats.byChannel.discord).toBe(2); // alice + charlie
      expect(stats.byChannel.cli).toBe(2); // alice + bob
    });
  });
});
