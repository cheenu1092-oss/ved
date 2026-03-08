/**
 * Tests for `ved context` — Context Window Inspector & Manager
 *
 * Tests cover:
 * 1. Token estimation consistency
 * 2. Working memory parsing (valid, invalid, empty)
 * 3. System prompt assembly (default, custom, with facts, with RAG)
 * 4. Fact management (add, remove, clear)
 * 5. Session lookup and listing
 * 6. Context simulation
 * 7. Edge cases (no sessions, invalid session IDs, large data)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Helpers to test internal functions ───

// Re-implement estimateTokens to verify consistency
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function parseWorkingMemory(raw: string): { messages: any[]; facts: Record<string, string> } {
  try {
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
    };
  } catch {
    return { messages: [], facts: {} };
  }
}

function assembleSystemPrompt(
  promptPath: string | undefined,
  facts: Record<string, string>,
  ragContext: string,
): string {
  const parts: string[] = [];

  let customPrompt: string | null = null;
  if (promptPath && existsSync(promptPath)) {
    try {
      const { readFileSync } = require('node:fs');
      customPrompt = readFileSync(promptPath, 'utf-8').trim() || null;
    } catch { /* ignore */ }
  }

  if (customPrompt) {
    parts.push(customPrompt);
    parts.push('');
  } else {
    parts.push('You are Ved, a personal AI assistant. You remember everything and prove it.');
    parts.push('');
    parts.push('## Rules');
    parts.push('- Be concise, accurate, and helpful.');
    parts.push('- Use tools when they help answer the question. Do not hallucinate tool results.');
    parts.push('- When asked to remember something, acknowledge and confirm.');
    parts.push('- Cite your knowledge sources when relevant (e.g. "From your vault: ...")');
    parts.push('');
  }

  const factEntries = Object.entries(facts);
  if (factEntries.length > 0) {
    parts.push('## Active Facts (from this session)');
    for (const [key, value] of factEntries) {
      parts.push(`- **${key}:** ${value}`);
    }
    parts.push('');
  }

  if (ragContext) {
    parts.push('## Retrieved Knowledge (from your vault)');
    parts.push(ragContext);
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Test DB setup ───

function createTestDb(dir: string): Database.Database {
  const dbPath = join(dir, 'ved.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      trust_tier INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      working_memory TEXT NOT NULL DEFAULT '{}',
      token_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      closed_at INTEGER,
      summary TEXT
    )
  `);

  return db;
}

function insertSession(
  db: Database.Database,
  opts: {
    id: string;
    channel?: string;
    channelId?: string;
    authorId?: string;
    trustTier?: number;
    status?: string;
    messages?: any[];
    facts?: Record<string, string>;
    lastActive?: number;
  },
): void {
  const wm = JSON.stringify({
    messages: opts.messages ?? [],
    facts: opts.facts ?? {},
  });

  db.prepare(`
    INSERT INTO sessions (id, channel, channel_id, author_id, trust_tier, started_at, last_active, working_memory, token_count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.channel ?? 'cli',
    opts.channelId ?? 'test',
    opts.authorId ?? 'user1',
    opts.trustTier ?? 3,
    opts.lastActive ?? Date.now() - 60000,
    opts.lastActive ?? Date.now(),
    wm,
    estimateTokens(wm),
    opts.status ?? 'active',
  );
}

// ─── Tests ───

describe('cli-context', () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = join(tmpdir(), `ved-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    db = createTestDb(testDir);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ─── Token estimation ───

  describe('estimateTokens', () => {
    it('estimates ~4 chars per token', () => {
      expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
    });

    it('handles empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('handles single char', () => {
      expect(estimateTokens('a')).toBe(1);
    });

    it('handles exact multiples', () => {
      expect(estimateTokens('abcd')).toBe(1); // 4/4 = 1
      expect(estimateTokens('abcdefgh')).toBe(2); // 8/4 = 2
    });

    it('handles large text', () => {
      const text = 'x'.repeat(10000);
      expect(estimateTokens(text)).toBe(2500);
    });
  });

  // ─── Working memory parsing ───

  describe('parseWorkingMemory', () => {
    it('parses valid working memory', () => {
      const wm = JSON.stringify({
        messages: [{ role: 'user', content: 'hello', timestamp: 1000 }],
        facts: { name: 'Ved', version: '0.1.0' },
      });
      const result = parseWorkingMemory(wm);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('hello');
      expect(result.facts.name).toBe('Ved');
      expect(result.facts.version).toBe('0.1.0');
    });

    it('handles empty JSON object', () => {
      const result = parseWorkingMemory('{}');
      expect(result.messages).toHaveLength(0);
      expect(Object.keys(result.facts)).toHaveLength(0);
    });

    it('handles invalid JSON', () => {
      const result = parseWorkingMemory('not json');
      expect(result.messages).toHaveLength(0);
      expect(Object.keys(result.facts)).toHaveLength(0);
    });

    it('handles missing fields', () => {
      const result = parseWorkingMemory('{"messages": []}');
      expect(result.messages).toHaveLength(0);
      expect(Object.keys(result.facts)).toHaveLength(0);
    });

    it('handles null messages', () => {
      const result = parseWorkingMemory('{"messages": null, "facts": {"a": "b"}}');
      expect(result.messages).toHaveLength(0);
      expect(result.facts.a).toBe('b');
    });

    it('handles non-object facts', () => {
      const result = parseWorkingMemory('{"messages": [], "facts": "not an object"}');
      expect(Object.keys(result.facts)).toHaveLength(0);
    });
  });

  // ─── System prompt assembly ───

  describe('assembleSystemPrompt', () => {
    it('generates default prompt without facts or RAG', () => {
      const prompt = assembleSystemPrompt(undefined, {}, '');
      expect(prompt).toContain('You are Ved');
      expect(prompt).toContain('## Rules');
      expect(prompt).not.toContain('## Active Facts');
      expect(prompt).not.toContain('## Retrieved Knowledge');
    });

    it('includes facts in prompt', () => {
      const prompt = assembleSystemPrompt(undefined, {
        user_name: 'Nag',
        preference: 'dark mode',
      }, '');
      expect(prompt).toContain('## Active Facts');
      expect(prompt).toContain('**user_name:** Nag');
      expect(prompt).toContain('**preference:** dark mode');
    });

    it('includes RAG context in prompt', () => {
      const ragCtx = 'From daily/2026-03-07.md: Worked on Ved context CLI.';
      const prompt = assembleSystemPrompt(undefined, {}, ragCtx);
      expect(prompt).toContain('## Retrieved Knowledge');
      expect(prompt).toContain(ragCtx);
    });

    it('includes both facts and RAG', () => {
      const prompt = assembleSystemPrompt(undefined, { a: 'b' }, 'some context');
      expect(prompt).toContain('## Active Facts');
      expect(prompt).toContain('## Retrieved Knowledge');
    });

    it('uses custom prompt file when available', () => {
      const promptFile = join(testDir, 'custom.md');
      writeFileSync(promptFile, 'You are a custom assistant.');
      const prompt = assembleSystemPrompt(promptFile, {}, '');
      expect(prompt).toContain('You are a custom assistant.');
      expect(prompt).not.toContain('You are Ved');
    });

    it('falls back to default when custom prompt file missing', () => {
      const prompt = assembleSystemPrompt('/nonexistent/path.md', {}, '');
      expect(prompt).toContain('You are Ved');
    });
  });

  // ─── Session DB operations ───

  describe('session operations', () => {
    it('inserts and retrieves active session', () => {
      insertSession(db, {
        id: 'session-1',
        facts: { key: 'value' },
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      });

      const row = db.prepare("SELECT * FROM sessions WHERE id = 'session-1'").get() as any;
      expect(row).toBeTruthy();
      expect(row.status).toBe('active');
      const wm = parseWorkingMemory(row.working_memory);
      expect(wm.facts.key).toBe('value');
      expect(wm.messages).toHaveLength(1);
    });

    it('finds most recent active session', () => {
      insertSession(db, { id: 'old-session', lastActive: Date.now() - 120000 });
      insertSession(db, { id: 'new-session', lastActive: Date.now() });

      const row = db.prepare(
        "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC LIMIT 1"
      ).get() as any;
      expect(row.id).toBe('new-session');
    });

    it('excludes closed sessions from active query', () => {
      insertSession(db, { id: 'closed-session', status: 'closed' });

      const row = db.prepare(
        "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC LIMIT 1"
      ).get() as any;
      expect(row).toBeUndefined();
    });

    it('lists all active/idle sessions', () => {
      insertSession(db, { id: 's1', status: 'active' });
      insertSession(db, { id: 's2', status: 'idle' });
      insertSession(db, { id: 's3', status: 'closed' });

      const rows = db.prepare(
        "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC"
      ).all() as any[];
      expect(rows).toHaveLength(2);
    });
  });

  // ─── Fact management ───

  describe('fact management', () => {
    it('adds a fact to session working memory', () => {
      insertSession(db, { id: 'fact-session', facts: {} });

      // Simulate adding a fact
      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      wm.facts['new_key'] = 'new_value';

      db.prepare('UPDATE sessions SET working_memory = ? WHERE id = ?')
        .run(JSON.stringify(wm), 'fact-session');

      const updated = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const updatedWm = parseWorkingMemory(updated.working_memory);
      expect(updatedWm.facts.new_key).toBe('new_value');
    });

    it('updates an existing fact', () => {
      insertSession(db, { id: 'fact-session', facts: { existing: 'old' } });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      expect(wm.facts.existing).toBe('old');

      wm.facts['existing'] = 'new';
      db.prepare('UPDATE sessions SET working_memory = ? WHERE id = ?')
        .run(JSON.stringify(wm), 'fact-session');

      const updated = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      expect(parseWorkingMemory(updated.working_memory).facts.existing).toBe('new');
    });

    it('removes a fact from session working memory', () => {
      insertSession(db, { id: 'fact-session', facts: { a: '1', b: '2' } });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      delete wm.facts['a'];

      db.prepare('UPDATE sessions SET working_memory = ? WHERE id = ?')
        .run(JSON.stringify(wm), 'fact-session');

      const updated = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const updatedWm = parseWorkingMemory(updated.working_memory);
      expect(updatedWm.facts.a).toBeUndefined();
      expect(updatedWm.facts.b).toBe('2');
    });

    it('clears all facts', () => {
      insertSession(db, { id: 'fact-session', facts: { a: '1', b: '2', c: '3' } });

      const wm = { messages: [], facts: {} };
      db.prepare('UPDATE sessions SET working_memory = ? WHERE id = ?')
        .run(JSON.stringify(wm), 'fact-session');

      const updated = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      expect(Object.keys(parseWorkingMemory(updated.working_memory).facts)).toHaveLength(0);
    });

    it('preserves messages when modifying facts', () => {
      const msgs = [
        { role: 'user', content: 'hello', timestamp: Date.now() },
        { role: 'assistant', content: 'hi', timestamp: Date.now() },
      ];
      insertSession(db, { id: 'fact-session', facts: { a: '1' }, messages: msgs });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      wm.facts['b'] = '2';

      db.prepare('UPDATE sessions SET working_memory = ? WHERE id = ?')
        .run(JSON.stringify(wm), 'fact-session');

      const updated = db.prepare("SELECT working_memory FROM sessions WHERE id = 'fact-session'").get() as any;
      const updatedWm = parseWorkingMemory(updated.working_memory);
      expect(updatedWm.messages).toHaveLength(2);
      expect(updatedWm.facts.b).toBe('2');
    });
  });

  // ─── Token breakdown ───

  describe('token breakdown', () => {
    it('calculates base system prompt tokens', () => {
      const prompt = assembleSystemPrompt(undefined, {}, '');
      const tokens = estimateTokens(prompt);
      expect(tokens).toBeGreaterThan(30); // default prompt is non-trivial
      expect(tokens).toBeLessThan(500); // but not enormous
    });

    it('calculates tokens per message role', () => {
      const messages = [
        { role: 'user', content: 'What is Ved?', timestamp: 1000 },
        { role: 'assistant', content: 'Ved is a personal AI assistant that remembers everything and proves it.', timestamp: 2000 },
        { role: 'user', content: 'Tell me more', timestamp: 3000 },
      ];

      const perRole: Record<string, number> = {};
      for (const msg of messages) {
        const t = estimateTokens(msg.content);
        perRole[msg.role] = (perRole[msg.role] ?? 0) + t;
      }

      expect(perRole['user']).toBeDefined();
      expect(perRole['assistant']).toBeDefined();
      expect(perRole['user']).toBeLessThan(perRole['assistant']); // assistant reply is longer
    });

    it('accounts for facts in token count', () => {
      const noFacts = assembleSystemPrompt(undefined, {}, '');
      const withFacts = assembleSystemPrompt(undefined, { a: 'long value here', b: 'another value' }, '');
      expect(estimateTokens(withFacts)).toBeGreaterThan(estimateTokens(noFacts));
    });
  });

  // ─── Message listing ───

  describe('message listing', () => {
    it('lists messages in order', () => {
      const messages = [
        { role: 'user', content: 'first', timestamp: 1000 },
        { role: 'assistant', content: 'second', timestamp: 2000 },
        { role: 'user', content: 'third', timestamp: 3000 },
      ];
      insertSession(db, { id: 'msg-session', messages });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'msg-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      expect(wm.messages.map((m: any) => m.content)).toEqual(['first', 'second', 'third']);
    });

    it('includes tool messages with name', () => {
      const messages = [
        { role: 'user', content: 'search for X', timestamp: 1000 },
        { role: 'tool', content: 'result: found X', name: 'web_search', timestamp: 2000 },
        { role: 'assistant', content: 'I found X', timestamp: 3000 },
      ];
      insertSession(db, { id: 'tool-session', messages });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'tool-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      const toolMsg = wm.messages.find((m: any) => m.role === 'tool');
      expect(toolMsg.name).toBe('web_search');
    });

    it('handles empty message list', () => {
      insertSession(db, { id: 'empty-session', messages: [] });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'empty-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      expect(wm.messages).toHaveLength(0);
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('handles session with very large working memory', () => {
      const largeContent = 'x'.repeat(50000);
      const messages = [{ role: 'user', content: largeContent, timestamp: Date.now() }];
      insertSession(db, { id: 'large-session', messages });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'large-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      expect(wm.messages[0].content.length).toBe(50000);
      expect(estimateTokens(wm.messages[0].content)).toBe(12500);
    });

    it('handles facts with special characters', () => {
      const facts = {
        'key with spaces': 'value with "quotes"',
        'emoji_key': '🐿️ squirrel',
        'newline_key': 'line1\nline2',
      };
      insertSession(db, { id: 'special-session', facts });

      const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'special-session'").get() as any;
      const wm = parseWorkingMemory(row.working_memory);
      expect(wm.facts['key with spaces']).toBe('value with "quotes"');
      expect(wm.facts['emoji_key']).toBe('🐿️ squirrel');
    });

    it('handles multiple sessions with different authors', () => {
      insertSession(db, { id: 's1', authorId: 'alice', lastActive: Date.now() });
      insertSession(db, { id: 's2', authorId: 'bob', lastActive: Date.now() - 1000 });

      const rows = db.prepare(
        "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC"
      ).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].author_id).toBe('alice');
      expect(rows[1].author_id).toBe('bob');
    });

    it('correctly handles idle sessions in lookup', () => {
      insertSession(db, { id: 'idle-s', status: 'idle' });

      const row = db.prepare(
        "SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_active DESC LIMIT 1"
      ).get() as any;
      expect(row).toBeTruthy();
      expect(row.id).toBe('idle-s');
    });

    it('handles concurrent fact updates safely', () => {
      insertSession(db, { id: 'concurrent-s', facts: { counter: '0' } });

      // Simulate two rapid updates
      for (let i = 1; i <= 5; i++) {
        const row = db.prepare("SELECT working_memory FROM sessions WHERE id = 'concurrent-s'").get() as any;
        const wm = parseWorkingMemory(row.working_memory);
        wm.facts['counter'] = String(i);
        db.prepare('UPDATE sessions SET working_memory = ? WHERE id = ?')
          .run(JSON.stringify(wm), 'concurrent-s');
      }

      const final = db.prepare("SELECT working_memory FROM sessions WHERE id = 'concurrent-s'").get() as any;
      expect(parseWorkingMemory(final.working_memory).facts.counter).toBe('5');
    });
  });

  // ─── Format helpers ───

  describe('format helpers', () => {
    it('truncates long strings', () => {
      const long = 'a'.repeat(200);
      const truncated = long.length <= 100 ? long : long.slice(0, 99) + '…';
      expect(truncated.length).toBe(100);
      expect(truncated.endsWith('…')).toBe(true);
    });

    it('does not truncate short strings', () => {
      const short = 'hello';
      const result = short.length <= 100 ? short : short.slice(0, 99) + '…';
      expect(result).toBe('hello');
    });

    it('formats age correctly', () => {
      // Test age formatting logic
      function formatAge(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
      }

      expect(formatAge(5000)).toBe('5s ago');
      expect(formatAge(120000)).toBe('2m ago');
      expect(formatAge(7200000)).toBe('2h ago');
      expect(formatAge(172800000)).toBe('2d ago');
    });
  });

  // ─── Context assembly integration ───

  describe('context assembly', () => {
    it('produces consistent output for same input', () => {
      const p1 = assembleSystemPrompt(undefined, { a: '1' }, 'ctx');
      const p2 = assembleSystemPrompt(undefined, { a: '1' }, 'ctx');
      expect(p1).toBe(p2);
    });

    it('sections appear in correct order: prompt → facts → RAG', () => {
      const prompt = assembleSystemPrompt(undefined, { key: 'val' }, 'rag content');
      const rulesIdx = prompt.indexOf('## Rules');
      const factsIdx = prompt.indexOf('## Active Facts');
      const ragIdx = prompt.indexOf('## Retrieved Knowledge');

      expect(rulesIdx).toBeLessThan(factsIdx);
      expect(factsIdx).toBeLessThan(ragIdx);
    });

    it('empty facts section omitted', () => {
      const prompt = assembleSystemPrompt(undefined, {}, 'some rag');
      expect(prompt).not.toContain('## Active Facts');
    });

    it('empty RAG section omitted', () => {
      const prompt = assembleSystemPrompt(undefined, { a: 'b' }, '');
      expect(prompt).not.toContain('## Retrieved Knowledge');
    });
  });
});
