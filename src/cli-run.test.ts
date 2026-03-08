/**
 * Tests for `ved run` — one-shot query mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRunArgs, formatOutput, runQuery } from './cli-run.js';
import type { VedResponse, WorkOrder } from './types/index.js';

// ─── parseRunArgs ───

describe('parseRunArgs', () => {
  it('parses positional query', () => {
    const opts = parseRunArgs(['What', 'is', 'Ved?']);
    expect(opts.query).toBe('What is Ved?');
    expect(opts.stdin).toBe(false);
    expect(opts.format).toBe('text');
    expect(opts.noRag).toBe(false);
    expect(opts.noTools).toBe(false);
    expect(opts.timeout).toBe(120);
  });

  it('parses -q flag', () => {
    const opts = parseRunArgs(['-q', 'translate this']);
    expect(opts.query).toBe('translate this');
  });

  it('parses --query flag', () => {
    const opts = parseRunArgs(['--query', 'hello world']);
    expect(opts.query).toBe('hello world');
  });

  it('parses stdin flag -', () => {
    const opts = parseRunArgs(['-']);
    expect(opts.stdin).toBe(true);
  });

  it('parses --stdin flag', () => {
    const opts = parseRunArgs(['--stdin']);
    expect(opts.stdin).toBe(true);
  });

  it('parses -f / --file', () => {
    const opts = parseRunArgs(['-q', 'summarize', '-f', 'notes.txt']);
    expect(opts.filePath).toBe('notes.txt');
    expect(opts.query).toBe('summarize');
  });

  it('parses --json format', () => {
    const opts = parseRunArgs(['--json', 'test']);
    expect(opts.format).toBe('json');
  });

  it('parses --raw format', () => {
    const opts = parseRunArgs(['--raw', 'test']);
    expect(opts.format).toBe('raw');
  });

  it('parses --session flag', () => {
    const opts = parseRunArgs(['-s', 'myproject', 'test']);
    expect(opts.sessionId).toBe('myproject');
  });

  it('parses --model flag', () => {
    const opts = parseRunArgs(['-m', 'gpt-4o', 'test']);
    expect(opts.model).toBe('gpt-4o');
  });

  it('parses --no-rag flag', () => {
    const opts = parseRunArgs(['--no-rag', 'test']);
    expect(opts.noRag).toBe(true);
  });

  it('parses --no-tools flag', () => {
    const opts = parseRunArgs(['--no-tools', 'test']);
    expect(opts.noTools).toBe(true);
  });

  it('parses --timeout flag', () => {
    const opts = parseRunArgs(['-t', '30', 'test']);
    expect(opts.timeout).toBe(30);
  });

  it('parses --system flag', () => {
    const opts = parseRunArgs(['--system', 'You are a translator', 'hello']);
    expect(opts.systemPrompt).toBe('You are a translator');
    expect(opts.query).toBe('hello');
  });

  it('parses --verbose flag', () => {
    const opts = parseRunArgs(['-v', 'test']);
    expect(opts.verbose).toBe(true);
  });

  it('combines positional and -q args', () => {
    const opts = parseRunArgs(['-q', 'translate', 'this', 'text']);
    expect(opts.query).toBe('translate this text');
  });

  it('parses all flags together', () => {
    const opts = parseRunArgs([
      '-q', 'translate',
      '-f', 'doc.txt',
      '-s', 'session1',
      '-m', 'claude-3',
      '--no-rag',
      '--no-tools',
      '-t', '60',
      '--json',
      '-v',
      '--system', 'Be concise',
    ]);
    expect(opts.query).toBe('translate');
    expect(opts.filePath).toBe('doc.txt');
    expect(opts.sessionId).toBe('session1');
    expect(opts.model).toBe('claude-3');
    expect(opts.noRag).toBe(true);
    expect(opts.noTools).toBe(true);
    expect(opts.timeout).toBe(60);
    expect(opts.format).toBe('json');
    expect(opts.verbose).toBe(true);
    expect(opts.systemPrompt).toBe('Be concise');
  });

  it('returns empty query when no args', () => {
    const opts = parseRunArgs([]);
    expect(opts.query).toBe('');
    expect(opts.stdin).toBe(false);
  });

  it('handles unknown flag by exiting', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseRunArgs(['--unknown'])).toThrow('exit');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Unknown flag'));
    exit.mockRestore();
    err.mockRestore();
  });

  it('handles invalid timeout by exiting', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseRunArgs(['-t', 'abc', 'test'])).toThrow('exit');
    exit.mockRestore();
    err.mockRestore();
  });

  it('handles negative timeout by exiting', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseRunArgs(['-t', '-5', 'test'])).toThrow('exit');
    exit.mockRestore();
    err.mockRestore();
  });
});

// ─── formatOutput ───

function makeResponse(overrides: Partial<VedResponse> = {}): VedResponse {
  return {
    id: 'test-response-id',
    inReplyTo: 'test-msg-id',
    content: 'This is the answer.',
    actions: [],
    memoryOps: [],
    channelRef: '',
    ...overrides,
  };
}

function makeOpts(overrides: Partial<ReturnType<typeof parseRunArgs>> = {}): ReturnType<typeof parseRunArgs> {
  return {
    query: 'test query',
    stdin: false,
    format: 'text' as const,
    noRag: false,
    noTools: false,
    timeout: 120,
    verbose: false,
    ...overrides,
  };
}

describe('formatOutput', () => {
  it('text format shows content', () => {
    const output = formatOutput(makeResponse(), makeOpts(), 150);
    expect(output).toBe('This is the answer.');
  });

  it('raw format shows content only', () => {
    const output = formatOutput(makeResponse(), makeOpts({ format: 'raw' }), 150);
    expect(output).toBe('This is the answer.');
  });

  it('json format includes structured data', () => {
    const output = formatOutput(makeResponse(), makeOpts({ format: 'json' }), 250);
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('test-response-id');
    expect(parsed.content).toBe('This is the answer.');
    expect(parsed.durationMs).toBe(250);
    expect(parsed.actions).toEqual([]);
    expect(parsed.memoryOps).toEqual([]);
  });

  it('verbose text shows metadata', () => {
    const output = formatOutput(
      makeResponse(),
      makeOpts({ verbose: true, sessionId: 'mysess', model: 'gpt-4o', noRag: true }),
      350,
    );
    expect(output).toContain('Ved v');
    expect(output).toContain('Duration: 350ms');
    expect(output).toContain('Session:  mysess');
    expect(output).toContain('Model:    gpt-4o');
    expect(output).toContain('RAG:      disabled');
    expect(output).toContain('This is the answer.');
  });

  it('verbose shows memory ops count', () => {
    const output = formatOutput(
      makeResponse({
        memoryOps: [
          { type: 'working_set', action: 'add', key: 'k', value: 'v' },
        ],
      }),
      makeOpts({ verbose: true }),
      100,
    );
    expect(output).toContain('Memory ops: 1');
  });

  it('shows pending actions', () => {
    const output = formatOutput(
      makeResponse({
        actions: [
          {
            id: 'wo-1',
            tool: 'file_write',
            status: 'pending',
            riskLevel: 'high',
            riskReasons: ['write op'],
          } as unknown as WorkOrder,
        ],
      }),
      makeOpts(),
      100,
    );
    expect(output).toContain('awaiting approval');
    expect(output).toContain('file_write');
    expect(output).toContain('wo-1');
  });

  it('truncates long query in verbose mode', () => {
    const longQuery = 'a'.repeat(80);
    const output = formatOutput(makeResponse(), makeOpts({ verbose: true, query: longQuery }), 100);
    expect(output).toContain('…');
    expect(output).not.toContain(longQuery);
  });

  it('shows no-tools disabled in verbose', () => {
    const output = formatOutput(
      makeResponse(),
      makeOpts({ verbose: true, noTools: true }),
      100,
    );
    expect(output).toContain('Tools:    disabled');
  });

  it('json format includes actions', () => {
    const output = formatOutput(
      makeResponse({
        actions: [
          {
            id: 'wo-2',
            tool: 'shell_exec',
            status: 'approved',
            riskLevel: 'critical',
            riskReasons: ['shell'],
          } as unknown as WorkOrder,
        ],
      }),
      makeOpts({ format: 'json' }),
      100,
    );
    const parsed = JSON.parse(output);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].tool).toBe('shell_exec');
    expect(parsed.actions[0].status).toBe('approved');
  });
});

// ─── runQuery error handling ───

describe('runQuery', () => {
  it('throws on empty query with no stdin', async () => {
    const mockApp = {
      processMessageDirect: vi.fn(),
      stop: vi.fn(),
    } as unknown as any;

    await expect(runQuery(mockApp, makeOpts({ query: '' }))).rejects.toThrow('No query provided');
  });

  it('throws on file not found', async () => {
    const mockApp = {
      processMessageDirect: vi.fn(),
      stop: vi.fn(),
    } as unknown as any;

    await expect(
      runQuery(mockApp, makeOpts({ query: 'test', filePath: '/nonexistent/file.txt' }))
    ).rejects.toThrow('File not found');
  });

  it('calls processMessageDirect with correct message shape', async () => {
    const mockResponse: VedResponse = makeResponse();
    const mockApp = {
      processMessageDirect: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as any;

    const result = await runQuery(mockApp, makeOpts({ query: 'hello world' }));

    expect(mockApp.processMessageDirect).toHaveBeenCalledOnce();
    const msg = mockApp.processMessageDirect.mock.calls[0][0];
    expect(msg.content).toBe('hello world');
    expect(msg.channel).toBe('run');
    expect(msg.author).toMatch(/^run-/);
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(result.response).toBe(mockResponse);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses named session channel when --session provided', async () => {
    const mockApp = {
      processMessageDirect: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as any;

    await runQuery(mockApp, makeOpts({ query: 'test', sessionId: 'myproject' }));

    const msg = mockApp.processMessageDirect.mock.calls[0][0];
    expect(msg.channel).toBe('run');
    expect(msg.author).toBe('myproject');
  });

  it('uses unique channel when no session', async () => {
    const mockApp = {
      processMessageDirect: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as any;

    await runQuery(mockApp, makeOpts({ query: 'test' }));
    await runQuery(mockApp, makeOpts({ query: 'test2' }));

    const author1 = mockApp.processMessageDirect.mock.calls[0][0].author;
    const author2 = mockApp.processMessageDirect.mock.calls[1][0].author;
    expect(author1).toMatch(/^run-/);
    expect(author2).toMatch(/^run-/);
    expect(author1).not.toBe(author2); // Different ULIDs
  });

  it('times out and throws TIMEOUT', async () => {
    const mockApp = {
      processMessageDirect: vi.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 5000))
      ),
    } as unknown as any;

    await expect(
      runQuery(mockApp, makeOpts({ query: 'slow', timeout: 0.1 }))
    ).rejects.toThrow('TIMEOUT');
  });

  it('attaches file content to query', async () => {
    // Create a temp file
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `ved-run-test-${Date.now()}.txt`);
    writeFileSync(tmpFile, 'File content here');

    const mockApp = {
      processMessageDirect: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as any;

    try {
      await runQuery(mockApp, makeOpts({ query: 'summarize', filePath: tmpFile }));
      const msg = mockApp.processMessageDirect.mock.calls[0][0];
      expect(msg.content).toContain('summarize');
      expect(msg.content).toContain('File content here');
      expect(msg.content).toContain('---');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('throws on file too large', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `ved-run-test-large-${Date.now()}.txt`);
    // Create 1.1 MB file
    writeFileSync(tmpFile, 'x'.repeat(1024 * 1024 + 100));

    const mockApp = {
      processMessageDirect: vi.fn(),
    } as unknown as any;

    try {
      await expect(
        runQuery(mockApp, makeOpts({ query: 'test', filePath: tmpFile }))
      ).rejects.toThrow('File too large');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('uses file content as query when no explicit query', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpFile = join(tmpdir(), `ved-run-test-no-query-${Date.now()}.txt`);
    writeFileSync(tmpFile, 'This is the document content');

    const mockApp = {
      processMessageDirect: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as any;

    try {
      await runQuery(mockApp, makeOpts({ query: '', filePath: tmpFile }));
      const msg = mockApp.processMessageDirect.mock.calls[0][0];
      expect(msg.content).toContain('This is the document content');
    } finally {
      unlinkSync(tmpFile);
    }
  });
});
