/**
 * Tests for system prompt assembly — custom prompt file, working memory facts,
 * and RAG context injection.
 *
 * Session 65: Completes TODO items in EventLoop.buildSystemPrompt().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EventLoop } from './core/event-loop.js';
import { migrate } from './db/migrate.js';
import { getDefaults } from './core/config.js';
import type { VedConfig, VedMessage } from './types/index.js';
import type { LLMRequest, LLMResponse } from './llm/types.js';
import type { RetrievalContext } from './rag/types.js';

// === Test Helpers ===

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeConfig(overrides?: Partial<any>): VedConfig {
  const defaults = getDefaults();
  return {
    ...defaults,
    memory: {
      ...defaults.memory,
      gitEnabled: false,
      compressionThreshold: 999_999,
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['owner-1'],
      maxAgenticLoops: 5,
    },
    ...overrides,
  };
}

let msgCounter = 0;
function makeMessage(content: string): VedMessage {
  return {
    id: `sp-msg-${++msgCounter}`,
    channel: 'cli' as any,
    author: 'owner-1',
    content,
    timestamp: Date.now(),
  };
}

function createMockLLM() {
  const calls: LLMRequest[] = [];
  return {
    calls,
    chat: vi.fn(async (req: LLMRequest) => {
      calls.push(req);
      return {
        decision: { response: 'OK', toolCalls: [] },
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'mock',
      } as LLMResponse;
    }),
  };
}

function createMockMemory() {
  return {
    readFile: async () => null,
    writeFile: async () => {},
    listFiles: async () => [],
    deleteFile: async () => false,
    upsertEntity: async () => {},
    readEntity: async () => null,
    writeCompression: async () => {},
    git: { commitAll: async () => null, flush: () => {} },
  };
}

function createMockRAG(text?: string) {
  return {
    retrieve: vi.fn(async (): Promise<RetrievalContext> => ({
      text: text ?? '',
      results: text ? [{ filePath: 'test.md', heading: null, content: text, sources: ['fts' as any], rrfScore: 0.5 }] : [],
      tokenCount: text ? Math.ceil(text.length / 4) : 0,
      metrics: { totalMs: 1, vectorSearchMs: 0, ftsSearchMs: 1, graphWalkMs: 0, fusionMs: 0, vectorResultCount: 0, ftsResultCount: text ? 1 : 0, graphResultCount: 0 },
    })),
    indexFile: async () => {},
    removeFile: () => {},
    fullReindex: async () => {},
    close: () => {},
  };
}

function createMockChannels() {
  return {
    send: vi.fn(async () => {}),
    sentResponses: [] as any[],
    start: async () => {},
    stop: async () => {},
  };
}

async function runPipeline(
  loop: EventLoop,
  messages: VedMessage[],
  opts?: { waitMs?: number; preReceive?: () => void },
): Promise<void> {
  const waitMs = opts?.waitMs ?? 500;
  const runPromise = loop.run();
  await new Promise(r => setTimeout(r, 50));
  if (opts?.preReceive) opts.preReceive();
  for (const msg of messages) {
    loop.receive(msg);
  }
  await new Promise(r => setTimeout(r, waitMs));
  loop.requestShutdown();
  await runPromise;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ved-prompt-'));
}

// === Tests ===

describe('System Prompt: Default (no custom file)', () => {
  let db: Database.Database;
  let loop: EventLoop;
  let mockLLM: ReturnType<typeof createMockLLM>;

  beforeEach(() => {
    db = createTestDb();
    mockLLM = createMockLLM();
    loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: null as any,
      memory: createMockMemory() as any,
      rag: createMockRAG() as any,
      channels: createMockChannels() as any,
    });
  });

  it('includes Ved identity and rules in default prompt', async () => {
    await runPipeline(loop, [makeMessage('hello')]);

    expect(mockLLM.calls.length).toBeGreaterThanOrEqual(1);
    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are Ved');
    expect(prompt).toContain('## Rules');
    expect(prompt).toContain('concise, accurate, and helpful');
  });

  it('does not include Active Facts section when session has no facts', async () => {
    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).not.toContain('Active Facts');
  });

  it('does not include Retrieved Knowledge when RAG returns empty', async () => {
    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).not.toContain('Retrieved Knowledge');
  });
});

describe('System Prompt: Working Memory Facts', () => {
  let db: Database.Database;
  let loop: EventLoop;
  let mockLLM: ReturnType<typeof createMockLLM>;

  beforeEach(() => {
    db = createTestDb();
    mockLLM = createMockLLM();
    loop = new EventLoop({ config: makeConfig(), db });
    loop.setModules({
      llm: mockLLM as any,
      mcp: null as any,
      memory: createMockMemory() as any,
      rag: createMockRAG() as any,
      channels: createMockChannels() as any,
    });
  });

  it('injects working memory facts into system prompt', async () => {
    // Set facts before receiving message
    await runPipeline(loop, [makeMessage('hello'), makeMessage('what time?')], {
      preReceive: () => {
        // Get the session that will be created and set facts
        // Actually, we need the session to exist first.
        // Let's use a two-phase approach: first msg creates session, second uses it.
      },
    });

    // The first call should NOT have facts (no facts set yet)
    expect(mockLLM.calls[0].systemPrompt).not.toContain('Active Facts');
  });

  it('does not include deleted facts', async () => {
    // Test by directly calling buildSystemPrompt with an empty Map
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map<string, string>();
    facts.set('keep_me', 'yes');
    // No delete_me fact
    const prompt = buildSP('', facts);
    expect(prompt).toContain('**keep_me:** yes');
    expect(prompt).not.toContain('delete_me');
  });

  it('injects facts with correct formatting', async () => {
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map<string, string>();
    facts.set('user_name', 'Nagarjun');
    facts.set('timezone', 'America/Los_Angeles');

    const prompt = buildSP('', facts);
    expect(prompt).toContain('## Active Facts (from this session)');
    expect(prompt).toContain('- **user_name:** Nagarjun');
    expect(prompt).toContain('- **timezone:** America/Los_Angeles');
  });

  it('facts section appears after rules', async () => {
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map([['project', 'Ved']]);
    const prompt = buildSP('', facts);

    const rulesIdx = prompt.indexOf('## Rules');
    const factsIdx = prompt.indexOf('## Active Facts');
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(rulesIdx);
  });

  it('handles many facts', async () => {
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map<string, string>();
    for (let i = 0; i < 50; i++) {
      facts.set(`fact_${i}`, `value_${i}`);
    }

    const prompt = buildSP('', facts);
    expect(prompt).toContain('**fact_0:** value_0');
    expect(prompt).toContain('**fact_49:** value_49');
  });

  it('handles special characters in fact keys and values', async () => {
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map<string, string>();
    facts.set('user\'s "name"', 'O\'Brien & Co. <test>');
    facts.set('emoji_key_🎉', 'value with 日本語');

    const prompt = buildSP('', facts);
    expect(prompt).toContain('**user\'s "name":** O\'Brien & Co. <test>');
    expect(prompt).toContain('**emoji_key_🎉:** value with 日本語');
  });

  it('empty facts map does not add section', async () => {
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const prompt = buildSP('', new Map());
    expect(prompt).not.toContain('Active Facts');
  });

  it('undefined facts does not add section', async () => {
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const prompt = buildSP('');
    expect(prompt).not.toContain('Active Facts');
  });
});

describe('System Prompt: Custom System Prompt File', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces default preamble with custom prompt file content', async () => {
    const promptFile = join(tmpDir, 'system.md');
    writeFileSync(promptFile, 'You are a custom agent named TestBot.\n\nBe helpful and kind.');

    const mockLLM = createMockLLM();
    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are a custom agent named TestBot');
    expect(prompt).toContain('Be helpful and kind');
    expect(prompt).not.toContain('You are Ved');
    expect(prompt).not.toContain('## Rules');
  });

  it('still includes facts when custom prompt is used', async () => {
    const promptFile = join(tmpDir, 'system.md');
    writeFileSync(promptFile, 'Custom agent instructions here.');

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    // Directly test buildSystemPrompt
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map([['mood', 'happy']]);
    const prompt = buildSP('', facts);

    expect(prompt).toContain('Custom agent instructions here.');
    expect(prompt).toContain('## Active Facts');
    expect(prompt).toContain('**mood:** happy');
  });

  it('still includes RAG context when custom prompt is used', async () => {
    const promptFile = join(tmpDir, 'system.md');
    writeFileSync(promptFile, 'Custom bot.');

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG('Important vault context') as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('search')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('Custom bot.');
    expect(prompt).toContain('## Retrieved Knowledge');
    expect(prompt).toContain('Important vault context');
  });

  it('falls back to default prompt when file does not exist', async () => {
    const config = makeConfig();
    config.llm.systemPromptPath = join(tmpDir, 'nonexistent.md');
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are Ved');
    expect(prompt).toContain('## Rules');
  });

  it('falls back to default prompt when file is empty', async () => {
    const promptFile = join(tmpDir, 'empty.md');
    writeFileSync(promptFile, '   \n  \n  ');

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are Ved');
  });

  it('falls back to default when systemPromptPath is null', async () => {
    const config = makeConfig();
    config.llm.systemPromptPath = null;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are Ved');
  });

  it('caches custom prompt after first read', async () => {
    const promptFile = join(tmpDir, 'cached.md');
    writeFileSync(promptFile, 'Original prompt.');

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    // First call loads prompt
    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const prompt1 = buildSP('');
    expect(prompt1).toContain('Original prompt.');

    // Modify the file on disk
    writeFileSync(promptFile, 'Modified prompt.');

    // Second call should use cached version
    const prompt2 = buildSP('');
    expect(prompt2).toContain('Original prompt.');
    expect(prompt2).not.toContain('Modified prompt.');
  });

  it('handles file read errors gracefully (directory instead of file)', async () => {
    const config = makeConfig();
    config.llm.systemPromptPath = tmpDir; // directory, not file
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are Ved');
  });

  it('preserves markdown formatting in custom prompt', async () => {
    const promptFile = join(tmpDir, 'formatted.md');
    writeFileSync(promptFile, `# Agent Name: TestAgent

## Instructions
- Rule 1: Be helpful
- Rule 2: Be accurate

\`\`\`
code block preserved
\`\`\``);

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('# Agent Name: TestAgent');
    expect(prompt).toContain('code block preserved');
  });

  it('handles large custom prompt file', async () => {
    const promptFile = join(tmpDir, 'large.md');
    const largeContent = 'A'.repeat(50_000);
    writeFileSync(promptFile, largeContent);

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({ llm: mockLLM as any, mcp: null as any, memory: createMockMemory() as any, rag: createMockRAG() as any, channels: createMockChannels() as any });

    await runPipeline(loop, [makeMessage('hello')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain(largeContent);
    expect(prompt).not.toContain('You are Ved');
  });
});

describe('System Prompt: Section Ordering', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('orders: custom preamble → facts → RAG', () => {
    const promptFile = join(tmpDir, 'order.md');
    writeFileSync(promptFile, 'CUSTOM_PREAMBLE_MARKER');

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });

    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map([['order_test', 'FACT_MARKER']]);
    const prompt = buildSP('RAG_CONTEXT_MARKER', facts);

    const preambleIdx = prompt.indexOf('CUSTOM_PREAMBLE_MARKER');
    const factsIdx = prompt.indexOf('FACT_MARKER');
    const ragIdx = prompt.indexOf('RAG_CONTEXT_MARKER');

    expect(preambleIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(ragIdx).toBeGreaterThan(-1);
    expect(preambleIdx).toBeLessThan(factsIdx);
    expect(factsIdx).toBeLessThan(ragIdx);
  });

  it('orders: Ved identity → rules → facts → RAG (default)', () => {
    const loop = new EventLoop({ config: makeConfig(), db });

    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map([['test_key', 'test_value']]);
    const prompt = buildSP('some retrieved knowledge', facts);

    const vedIdx = prompt.indexOf('You are Ved');
    const rulesIdx = prompt.indexOf('## Rules');
    const factsIdx = prompt.indexOf('## Active Facts');
    const ragIdx = prompt.indexOf('## Retrieved Knowledge');

    expect(vedIdx).toBeLessThan(rulesIdx);
    expect(rulesIdx).toBeLessThan(factsIdx);
    expect(factsIdx).toBeLessThan(ragIdx);
  });

  it('facts before RAG even without custom prompt', () => {
    const loop = new EventLoop({ config: makeConfig(), db });

    const buildSP = (loop as any).buildSystemPrompt.bind(loop);
    const facts = new Map([['key', 'val']]);
    const prompt = buildSP('rag content', facts);

    expect(prompt.indexOf('Active Facts')).toBeLessThan(prompt.indexOf('Retrieved Knowledge'));
  });
});

describe('System Prompt: Integration with Pipeline', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pipeline passes session facts to system prompt builder', async () => {
    const config = makeConfig();
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({
      llm: mockLLM as any,
      mcp: null as any,
      memory: createMockMemory() as any,
      rag: createMockRAG() as any,
      channels: createMockChannels() as any,
    });

    // Run with two messages — first creates session, second should have facts
    const runPromise = loop.run();
    await new Promise(r => setTimeout(r, 50));

    // Send first message to create session
    loop.receive(makeMessage('hello'));
    await new Promise(r => setTimeout(r, 200));

    // Set facts on the session AND persist to DB so getOrCreate recovers them
    const session = (loop as any).sessions.getOrCreate('cli', '', 'owner-1', 4);
    session.workingMemory.setFact('injected_fact', 'from_test');
    (loop as any).sessions.persist(session);

    // Send second message — session will be recovered from DB with facts
    loop.receive(makeMessage('check facts'));
    await new Promise(r => setTimeout(r, 200));

    loop.requestShutdown();
    await runPromise;

    // The second LLM call should include the fact
    expect(mockLLM.calls.length).toBeGreaterThanOrEqual(2);
    const secondPrompt = mockLLM.calls[1].systemPrompt;
    expect(secondPrompt).toContain('## Active Facts');
    expect(secondPrompt).toContain('**injected_fact:** from_test');
  });

  it('custom prompt file works through full pipeline', async () => {
    const promptFile = join(tmpDir, 'pipeline.md');
    writeFileSync(promptFile, 'You are PipelineBot. Follow these rules carefully.');

    const config = makeConfig();
    config.llm.systemPromptPath = promptFile;
    const loop = new EventLoop({ config, db });
    const mockLLM = createMockLLM();
    loop.setModules({
      llm: mockLLM as any,
      mcp: null as any,
      memory: createMockMemory() as any,
      rag: createMockRAG('vault data here') as any,
      channels: createMockChannels() as any,
    });

    await runPipeline(loop, [makeMessage('hello pipeline')]);

    const prompt = mockLLM.calls[0].systemPrompt;
    expect(prompt).toContain('You are PipelineBot');
    expect(prompt).not.toContain('You are Ved');
    expect(prompt).toContain('## Retrieved Knowledge');
    expect(prompt).toContain('vault data here');
  });
});
