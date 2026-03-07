/**
 * `ved user` — CLI for managing and inspecting known users.
 *
 * Subcommands:
 *   list [--channel <ch>] [--tier <1-4>] [--limit N]
 *                              — List all known users across channels
 *   show <userId> [--channel <ch>]
 *                              — Show user profile (trust, sessions, messages, last active)
 *   sessions <userId> [--channel <ch>] [--status <status>] [--limit N]
 *                              — List sessions for a user
 *   activity <userId> [--channel <ch>] [--type <event_type>] [--limit N]
 *                              — Show recent audit events involving a user
 *   stats                      — Show aggregate user statistics
 *
 * Aliases: u, who, users
 */

import type { VedApp } from './app.js';

// === Types ===

export interface KnownUser {
  userId: string;
  userName: string;
  channel: string;
  trustTier: number;
  sessionCount: number;
  messageCount: number;
  lastActive: number; // unix ms
  firstSeen: number;  // unix ms
}

export interface UserSession {
  id: string;
  channel: string;
  channelId: string;
  status: string;
  trustTier: number;
  startedAt: number;
  lastActive: number;
  tokenCount: number;
  closedAt: number | null;
}

export interface UserActivity {
  id: string;
  timestamp: number;
  eventType: string;
  detail: string;
  sessionId: string | null;
}

export interface UserProfile {
  userId: string;
  userName: string;
  channels: string[];
  trustTiers: Record<string, number>; // channel → tier
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  totalTokens: number;
  firstSeen: number;
  lastActive: number;
  workOrders: { pending: number; approved: number; denied: number; expired: number };
}

export interface UserStats {
  totalUsers: number;
  byChannel: Record<string, number>;
  byTier: Record<number, number>;
  activeToday: number;
  activeThisWeek: number;
}

// === Helpers ===

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

function tierLabel(tier: number): string {
  switch (tier) {
    case 1: return 'stranger';
    case 2: return 'known';
    case 3: return 'tribe';
    case 4: return 'owner';
    default: return `tier-${tier}`;
  }
}

function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// === Data Access ===

export function getKnownUsers(app: VedApp, options?: { channel?: string; tier?: number; limit?: number }): KnownUser[] {
  const limit = options?.limit ?? 50;
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (options?.channel) {
    conditions.push('s.channel = @channel');
    params.channel = options.channel;
  }
  if (options?.tier) {
    conditions.push('s.trust_tier = @tier');
    params.tier = options.tier;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      s.author_id AS userId,
      COALESCE(MAX(i.author_name), '') AS userName,
      s.channel,
      MAX(s.trust_tier) AS trustTier,
      COUNT(DISTINCT s.id) AS sessionCount,
      COALESCE(msgCounts.messageCount, 0) AS messageCount,
      MAX(s.last_active) AS lastActive,
      MIN(s.started_at) AS firstSeen
    FROM sessions s
    LEFT JOIN inbox i ON i.author_id = s.author_id AND i.channel_id LIKE (s.channel || '%')
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS messageCount
      FROM inbox
      WHERE processed = 1
      GROUP BY session_id
    ) msgCounts ON msgCounts.session_id = s.id
    ${where}
    GROUP BY s.author_id, s.channel
    ORDER BY lastActive DESC
    LIMIT @limit
  `;
  params.limit = limit;

  const rows = app.queryDb(sql, params) as Array<{
    userId: string; userName: string; channel: string; trustTier: number;
    sessionCount: number; messageCount: number; lastActive: number; firstSeen: number;
  }>;

  return rows.map(r => ({
    userId: r.userId,
    userName: r.userName,
    channel: r.channel,
    trustTier: r.trustTier,
    sessionCount: r.sessionCount,
    messageCount: r.messageCount,
    lastActive: r.lastActive,
    firstSeen: r.firstSeen,
  }));
}

export function getUserProfile(app: VedApp, userId: string, channel?: string): UserProfile | null {
  // Get sessions
  const sessionConditions = ['s.author_id = @userId'];
  const params: Record<string, string | number> = { userId };
  if (channel) {
    sessionConditions.push('s.channel = @channel');
    params.channel = channel;
  }

  const sessions = app.queryDb(`
    SELECT channel, trust_tier, status, started_at, last_active, token_count
    FROM sessions s
    WHERE ${sessionConditions.join(' AND ')}
    ORDER BY last_active DESC
  `, params) as Array<{
    channel: string; trust_tier: number; status: string;
    started_at: number; last_active: number; token_count: number;
  }>;

  if (sessions.length === 0) return null;

  // Get user name from inbox
  const nameRow = app.queryDb(`
    SELECT author_name FROM inbox WHERE author_id = @userId AND author_name != '' LIMIT 1
  `, { userId }) as Array<{ author_name: string }>;

  // Get trust tiers by channel
  const trustTiers: Record<string, number> = {};
  const channels = new Set<string>();
  let totalTokens = 0;
  let activeSessions = 0;
  let firstSeen = Infinity;
  let lastActive = 0;

  for (const s of sessions) {
    channels.add(s.channel);
    if (!trustTiers[s.channel] || s.trust_tier > trustTiers[s.channel]) {
      trustTiers[s.channel] = s.trust_tier;
    }
    totalTokens += s.token_count;
    if (s.status === 'active' || s.status === 'idle') activeSessions++;
    if (s.started_at < firstSeen) firstSeen = s.started_at;
    if (s.last_active > lastActive) lastActive = s.last_active;
  }

  // Count messages
  const msgRow = app.queryDb(`
    SELECT COUNT(*) AS cnt FROM inbox WHERE author_id = @userId
  `, { userId }) as Array<{ cnt: number }>;

  // Count work orders
  const woRows = app.queryDb(`
    SELECT wo.status AS status, COUNT(*) AS cnt FROM work_orders wo
    JOIN sessions s ON wo.session_id = s.id
    WHERE s.author_id = @userId
    GROUP BY wo.status
  `, { userId }) as Array<{ status: string; cnt: number }>;

  const workOrders = { pending: 0, approved: 0, denied: 0, expired: 0 };
  for (const wo of woRows) {
    if (wo.status in workOrders) {
      workOrders[wo.status as keyof typeof workOrders] = wo.cnt;
    }
  }

  return {
    userId,
    userName: nameRow[0]?.author_name ?? '',
    channels: [...channels],
    trustTiers,
    totalSessions: sessions.length,
    activeSessions,
    totalMessages: msgRow[0]?.cnt ?? 0,
    totalTokens,
    firstSeen,
    lastActive,
    workOrders,
  };
}

export function getUserSessions(app: VedApp, userId: string, options?: { channel?: string; status?: string; limit?: number }): UserSession[] {
  const conditions = ['author_id = @userId'];
  const params: Record<string, string | number> = { userId };

  if (options?.channel) {
    conditions.push('channel = @channel');
    params.channel = options.channel;
  }
  if (options?.status) {
    conditions.push('status = @status');
    params.status = options.status;
  }

  const limit = options?.limit ?? 20;
  params.limit = limit;

  const rows = app.queryDb(`
    SELECT id, channel, channel_id, status, trust_tier, started_at, last_active, token_count, closed_at
    FROM sessions
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_active DESC
    LIMIT @limit
  `, params) as Array<{
    id: string; channel: string; channel_id: string; status: string;
    trust_tier: number; started_at: number; last_active: number;
    token_count: number; closed_at: number | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    channel: r.channel,
    channelId: r.channel_id,
    status: r.status,
    trustTier: r.trust_tier,
    startedAt: r.started_at,
    lastActive: r.last_active,
    tokenCount: r.token_count,
    closedAt: r.closed_at,
  }));
}

export function getUserActivity(app: VedApp, userId: string, options?: { channel?: string; type?: string; limit?: number }): UserActivity[] {
  const conditions = ['a.actor = @actor'];
  const params: Record<string, string | number> = { actor: `user:${userId}` };

  if (options?.type) {
    conditions.push('a.event_type = @type');
    params.type = options.type;
  }
  if (options?.channel) {
    conditions.push(`a.session_id IN (SELECT id FROM sessions WHERE author_id = @userId AND channel = @channel)`);
    params.userId = userId;
    params.channel = options.channel;
  }

  const limit = options?.limit ?? 20;
  params.limit = limit;

  const rows = app.queryDb(`
    SELECT a.id, a.timestamp, a.event_type, a.detail, a.session_id
    FROM audit_log a
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.timestamp DESC
    LIMIT @limit
  `, params) as Array<{
    id: string; timestamp: number; event_type: string;
    detail: string; session_id: string | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    eventType: r.event_type,
    detail: r.detail,
    sessionId: r.session_id,
  }));
}

export function getUserStats(app: VedApp): UserStats {
  const now = Date.now();
  const todayStart = now - 86_400_000;
  const weekStart = now - 7 * 86_400_000;

  // Total unique users
  const totalRow = app.queryDb(`
    SELECT COUNT(DISTINCT author_id || '::' || channel) AS cnt FROM sessions
  `) as Array<{ cnt: number }>;

  // By channel
  const channelRows = app.queryDb(`
    SELECT channel, COUNT(DISTINCT author_id) AS cnt FROM sessions GROUP BY channel ORDER BY cnt DESC
  `) as Array<{ channel: string; cnt: number }>;

  // By tier (max tier per user)
  const tierRows = app.queryDb(`
    SELECT maxTier, COUNT(*) AS cnt FROM (
      SELECT author_id, channel, MAX(trust_tier) AS maxTier FROM sessions GROUP BY author_id, channel
    ) GROUP BY maxTier ORDER BY maxTier
  `) as Array<{ maxTier: number; cnt: number }>;

  // Active today
  const todayRow = app.queryDb(`
    SELECT COUNT(DISTINCT author_id || '::' || channel) AS cnt FROM sessions WHERE last_active > @since
  `, { since: todayStart }) as Array<{ cnt: number }>;

  // Active this week
  const weekRow = app.queryDb(`
    SELECT COUNT(DISTINCT author_id || '::' || channel) AS cnt FROM sessions WHERE last_active > @since
  `, { since: weekStart }) as Array<{ cnt: number }>;

  const byChannel: Record<string, number> = {};
  for (const r of channelRows) byChannel[r.channel] = r.cnt;

  const byTier: Record<number, number> = {};
  for (const r of tierRows) byTier[r.maxTier] = r.cnt;

  return {
    totalUsers: totalRow[0]?.cnt ?? 0,
    byChannel,
    byTier,
    activeToday: todayRow[0]?.cnt ?? 0,
    activeThisWeek: weekRow[0]?.cnt ?? 0,
  };
}

// === CLI Handler ===

export async function handleUserCommand(app: VedApp, args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0] ?? 'list';

  switch (sub) {
    case 'list':
    case 'ls': {
      const users = getKnownUsers(app, {
        channel: flags.channel,
        tier: flags.tier ? parseInt(flags.tier, 10) : undefined,
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
      });

      if (users.length === 0) return 'No known users found.';

      const lines = ['Known Users', '═'.repeat(60)];
      for (const u of users) {
        const name = u.userName ? ` (${u.userName})` : '';
        const tier = tierLabel(u.trustTier);
        const active = relativeTime(u.lastActive);
        lines.push(`  ${u.userId}${name}`);
        lines.push(`    channel: ${u.channel}  trust: ${tier}  sessions: ${u.sessionCount}  msgs: ${u.messageCount}`);
        lines.push(`    first: ${formatDate(u.firstSeen)}  last: ${active}`);
        lines.push('');
      }
      lines.push(`Total: ${users.length} user(s)`);
      return lines.join('\n');
    }

    case 'show':
    case 'info':
    case 'profile': {
      const userId = positional[1];
      if (!userId) return 'Usage: ved user show <userId> [--channel <ch>]';

      const profile = getUserProfile(app, userId, flags.channel);
      if (!profile) return `User not found: ${userId}`;

      const lines = ['User Profile', '═'.repeat(60)];
      lines.push(`  ID:       ${profile.userId}`);
      if (profile.userName) lines.push(`  Name:     ${profile.userName}`);
      lines.push(`  Channels: ${profile.channels.join(', ')}`);
      lines.push('');

      // Trust tiers by channel
      lines.push('  Trust Tiers:');
      for (const [ch, tier] of Object.entries(profile.trustTiers)) {
        lines.push(`    ${ch}: ${tierLabel(tier)} (${tier})`);
      }
      lines.push('');

      // Stats
      lines.push('  Sessions:');
      lines.push(`    Total:  ${profile.totalSessions}  Active: ${profile.activeSessions}`);
      lines.push(`    Tokens: ${profile.totalTokens.toLocaleString()}`);
      lines.push('');
      lines.push(`  Messages: ${profile.totalMessages}`);
      lines.push(`  First:    ${formatDate(profile.firstSeen)}`);
      lines.push(`  Last:     ${formatDate(profile.lastActive)} (${relativeTime(profile.lastActive)})`);

      // Work orders
      const wo = profile.workOrders;
      const woTotal = wo.pending + wo.approved + wo.denied + wo.expired;
      if (woTotal > 0) {
        lines.push('');
        lines.push('  Work Orders:');
        lines.push(`    Pending: ${wo.pending}  Approved: ${wo.approved}  Denied: ${wo.denied}  Expired: ${wo.expired}`);
      }

      return lines.join('\n');
    }

    case 'sessions':
    case 'sess': {
      const userId = positional[1];
      if (!userId) return 'Usage: ved user sessions <userId> [--channel <ch>] [--status <status>] [--limit N]';

      const sessions = getUserSessions(app, userId, {
        channel: flags.channel,
        status: flags.status,
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
      });

      if (sessions.length === 0) return `No sessions found for user: ${userId}`;

      const lines = [`Sessions for ${userId}`, '═'.repeat(60)];
      for (const s of sessions) {
        const status = s.status === 'active' ? '●' : s.status === 'idle' ? '◐' : '○';
        const tier = tierLabel(s.trustTier);
        lines.push(`  ${status} ${s.id.slice(0, 10)}  ${s.channel}/${s.channelId}`);
        lines.push(`    status: ${s.status}  trust: ${tier}  tokens: ${s.tokenCount.toLocaleString()}`);
        lines.push(`    started: ${formatDate(s.startedAt)}  last: ${relativeTime(s.lastActive)}`);
        if (s.closedAt) lines.push(`    closed: ${formatDate(s.closedAt)}`);
        lines.push('');
      }
      lines.push(`Total: ${sessions.length} session(s)`);
      return lines.join('\n');
    }

    case 'activity':
    case 'log': {
      const userId = positional[1];
      if (!userId) return 'Usage: ved user activity <userId> [--channel <ch>] [--type <event_type>] [--limit N]';

      const events = getUserActivity(app, userId, {
        channel: flags.channel,
        type: flags.type,
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
      });

      if (events.length === 0) return `No activity found for user: ${userId}`;

      const lines = [`Activity for ${userId}`, '═'.repeat(60)];
      for (const e of events) {
        const time = formatDate(e.timestamp);
        const session = e.sessionId ? ` [${e.sessionId.slice(0, 8)}]` : '';
        // Parse detail JSON for display, truncate if needed
        let detailStr = '';
        try {
          const detail = JSON.parse(e.detail);
          const keys = Object.keys(detail);
          if (keys.length > 0) {
            const summary = keys.slice(0, 3).map(k => {
              const v = detail[k];
              const vs = typeof v === 'string' ? v : JSON.stringify(v);
              return `${k}=${vs.length > 40 ? vs.slice(0, 37) + '...' : vs}`;
            }).join(', ');
            detailStr = ` — ${summary}`;
          }
        } catch {
          // non-JSON detail
        }
        lines.push(`  ${time}  ${e.eventType}${session}${detailStr}`);
      }
      lines.push('');
      lines.push(`Total: ${events.length} event(s)`);
      return lines.join('\n');
    }

    case 'stats': {
      const stats = getUserStats(app);
      const lines = ['User Statistics', '═'.repeat(60)];
      lines.push(`  Total users:      ${stats.totalUsers}`);
      lines.push(`  Active today:     ${stats.activeToday}`);
      lines.push(`  Active this week: ${stats.activeThisWeek}`);
      lines.push('');

      if (Object.keys(stats.byChannel).length > 0) {
        lines.push('  By Channel:');
        for (const [ch, cnt] of Object.entries(stats.byChannel)) {
          lines.push(`    ${ch}: ${cnt}`);
        }
        lines.push('');
      }

      if (Object.keys(stats.byTier).length > 0) {
        lines.push('  By Trust Tier:');
        for (const [tier, cnt] of Object.entries(stats.byTier)) {
          lines.push(`    ${tierLabel(Number(tier))}: ${cnt}`);
        }
      }

      return lines.join('\n');
    }

    default:
      return [
        'Usage: ved user <subcommand> [options]',
        '',
        'Subcommands:',
        '  list [--channel <ch>] [--tier <1-4>] [--limit N]     List known users',
        '  show <userId> [--channel <ch>]                       User profile',
        '  sessions <userId> [--channel <ch>] [--status <s>]    User sessions',
        '  activity <userId> [--channel <ch>] [--type <type>]   User activity log',
        '  stats                                                Aggregate statistics',
        '',
        'Aliases: u, who, users',
      ].join('\n');
  }
}
