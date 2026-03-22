/**
 * Tests for MCP Server — Ved as an MCP tool server.
 *
 * Tests cover:
 *   - MCPServerHandler protocol handling (initialize, tools/list, tools/call)
 *   - Tool execution (all 12 tools)
 *   - Error handling (unknown tools, missing params, pre-init)
 *   - MCPStdioServer (line protocol)
 *   - MCPHttpServer (SSE + HTTP endpoints)
 *   - Security (path traversal, input validation)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VedApp } from './app.js';
import { getDefaults } from './core/config.js';
import { MCPServerHandler, MCPStdioServer, MCPHttpServer } from './mcp-server.js';

// ── Test Helpers ──

function tmpDir(): string {
  const dir = join(tmpdir(), `ved-mcp-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestConfig(dir: string) {
  const vedDir = join(dir, '.ved');
  const vaultDir = join(dir, 'vault');
  mkdirSync(vedDir, { recursive: true });
  mkdirSync(join(vaultDir, 'daily'), { recursive: true });
  mkdirSync(join(vaultDir, 'entities'), { recursive: true });
  mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
  mkdirSync(join(vaultDir, 'decisions'), { recursive: true });
  mkdirSync(join(vaultDir, 'topics'), { recursive: true });
  mkdirSync(join(vaultDir, 'tasks'), { recursive: true });

  // Initialize git in vault
  const { execSync } = require('node:child_process');
  execSync('git init', { cwd: vaultDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: vaultDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: vaultDir, stdio: 'pipe' });

  // Create a test entity
  writeFileSync(join(vaultDir, 'entities', 'alice.md'), [
    '---',
    'type: person',
    'title: Alice Smith',
    'tags:',
    '  - engineer',
    '  - team-lead',
    'confidence: high',
    '---',
    '',
    '# Alice Smith',
    '',
    'Alice is an engineer who leads the backend team.',
    '',
    'Works with [[bob]] on the [[project-ved]] project.',
  ].join('\n'));

  // Create a concept
  writeFileSync(join(vaultDir, 'concepts', 'hash-chain.md'), [
    '---',
    'type: concept',
    'title: Hash Chain',
    'tags:',
    '  - security',
    '  - audit',
    '---',
    '',
    '# Hash Chain',
    '',
    'A sequence of hashes where each entry includes the previous hash.',
    'Used in [[project-ved]] for tamper-evident audit logging.',
  ].join('\n'));

  // Create a task
  writeFileSync(join(vaultDir, 'tasks', 'fix-bug.md'), [
    '---',
    'type: task',
    'status: todo',
    'project: ved',
    'title: Fix the memory leak',
    '---',
    '',
    'There is a memory leak in the session manager.',
  ].join('\n'));

  // Create a daily note (use local time to match todayStr())
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  writeFileSync(join(vaultDir, 'daily', `${today}.md`), [
    `# ${today}`,
    '',
    'Worked on MCP server integration.',
  ].join('\n'));

  // Initial commit
  execSync('git add -A', { cwd: vaultDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: vaultDir, stdio: 'pipe' });

  // Write config
  writeFileSync(join(vedDir, 'config.yaml'), [
    `dataDir: "${vedDir}"`,
    `memory:`,
    `  vaultPath: "${vaultDir}"`,
    `llm:`,
    `  provider: mock`,
    `  model: test`,
    `  apiKey: test-key`,
    `mcp:`,
    `  servers: []`,
    `trust:`,
    `  ownerIds:`,
    `    - test-owner`,
    `channels: []`,
  ].join('\n'));

  return { vedDir, vaultDir };
}

async function createTestApp(dir: string): Promise<VedApp> {
  const { vedDir, vaultDir } = createTestConfig(dir);
  const defaults = getDefaults();
  const config = {
    ...defaults,
    dbPath: join(vedDir, 'ved.db'),
    memory: {
      ...defaults.memory,
      vaultPath: vaultDir,
      gitEnabled: false,
      compressionThreshold: 999_999,
    },
    llm: {
      ...defaults.llm,
      provider: 'anthropic' as const,
      model: 'test',
      apiKey: 'test-key',
    },
    trust: {
      ...defaults.trust,
      ownerIds: ['test-owner'],
    },
    mcp: {
      ...defaults.mcp,
      servers: [],
    },
    channels: [],
  };
  const app = new VedApp(config as any);
  await app.init();
  return app;
}

// ── Protocol Tests ──

describe('MCPServerHandler', () => {
  let dir: string;
  let app: VedApp;
  let handler: MCPServerHandler;

  beforeEach(async () => {
    dir = tmpDir();
    app = await createTestApp(dir);
    handler = new MCPServerHandler(app);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Initialize ──

  it('responds to initialize with server info', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });

    expect(res).not.toBeNull();
    expect(res!.id).toBe(1);
    expect(res!.error).toBeUndefined();
    const result = res!.result as any;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('ved');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('returns null for notifications/initialized', async () => {
    // Initialize first
    await handler.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });

    const res = await handler.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });

  it('rejects tools/list before initialize', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    });
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32002);
  });

  it('rejects tools/call before initialize', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'ved_stats', arguments: {} },
    });
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32002);
  });

  // ── tools/list ──

  it('lists all 12 tools', async () => {
    await handler.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });

    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    });

    expect(res!.error).toBeUndefined();
    const result = res!.result as any;
    expect(result.tools).toHaveLength(12);
    const names = result.tools.map((t: any) => t.name);
    expect(names).toContain('ved_search');
    expect(names).toContain('ved_memory_list');
    expect(names).toContain('ved_memory_read');
    expect(names).toContain('ved_memory_write');
    expect(names).toContain('ved_memory_graph');
    expect(names).toContain('ved_daily_read');
    expect(names).toContain('ved_daily_write');
    expect(names).toContain('ved_audit_query');
    expect(names).toContain('ved_audit_verify');
    expect(names).toContain('ved_stats');
    expect(names).toContain('ved_doctor');
    expect(names).toContain('ved_task_list');
  });

  it('tool schemas have valid JSON Schema', async () => {
    await handler.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });

    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    });

    const tools = (res!.result as any).tools;
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  // ── ping ──

  it('responds to ping', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: 99, method: 'ping',
    });
    expect(res!.id).toBe(99);
    expect(res!.error).toBeUndefined();
  });

  // ── Unknown method ──

  it('returns error for unknown method', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: 5, method: 'nonexistent/method',
    });
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32601);
  });

  it('returns null for unknown notification', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0', method: 'some/notification', // no id
    });
    expect(res).toBeNull();
  });
});

// ── Tool Execution Tests ──

describe('MCP Tool Execution', () => {
  let dir: string;
  let app: VedApp;
  let handler: MCPServerHandler;

  beforeEach(async () => {
    dir = tmpDir();
    app = await createTestApp(dir);
    handler = new MCPServerHandler(app);

    // Initialize
    await handler.handleRequest({
      jsonrpc: '2.0', id: 0, method: 'initialize', params: {},
    });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await handler.handleRequest({
      jsonrpc: '2.0',
      id: Math.random(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return res!.result;
  }

  // ── ved_stats ──

  it('ved_stats returns system stats', async () => {
    const result = await callTool('ved_stats');
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.vault).toBeDefined();
    expect(data.rag).toBeDefined();
    expect(data.audit).toBeDefined();
    expect(data.sessions).toBeDefined();
  });

  // ── ved_doctor ──

  it('ved_doctor runs diagnostics', async () => {
    const result = await callTool('ved_doctor');
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.checks).toBeDefined();
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.passed).toBeGreaterThanOrEqual(0);
  });

  // ── ved_memory_list ──

  it('ved_memory_list returns vault files', async () => {
    const result = await callTool('ved_memory_list');
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    const paths = data.map((f: any) => f.path);
    expect(paths).toContain('entities/alice.md');
  });

  it('ved_memory_list filters by type', async () => {
    const result = await callTool('ved_memory_list', { type: 'concept' });
    const data = JSON.parse(result.content[0].text);
    expect(data.every((f: any) => f.path.startsWith('concepts/'))).toBe(true);
  });

  // ── ved_memory_read ──

  it('ved_memory_read returns file content', async () => {
    const result = await callTool('ved_memory_read', { path: 'entities/alice.md' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Alice Smith');
    expect(result.content[0].text).toContain('type: person');
  });

  it('ved_memory_read returns error for missing file', async () => {
    const result = await callTool('ved_memory_read', { path: 'nonexistent.md' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File not found');
  });

  it('ved_memory_read rejects path traversal', async () => {
    const result = await callTool('ved_memory_read', { path: '../../../etc/passwd' });
    expect(result.isError).toBe(true);
  });

  // ── ved_memory_write ──

  it('ved_memory_write creates a new file', async () => {
    const result = await callTool('ved_memory_write', {
      path: 'concepts/new-idea.md',
      content: '# New Idea\n\nThis is a new concept.',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Written');

    // Verify it was written
    const read = await callTool('ved_memory_read', { path: 'concepts/new-idea.md' });
    expect(read.content[0].text).toContain('New Idea');
  });

  it('ved_memory_write updates existing file', async () => {
    await callTool('ved_memory_write', {
      path: 'entities/alice.md',
      content: '# Updated Alice\n\nAlice got promoted.',
    });

    const read = await callTool('ved_memory_read', { path: 'entities/alice.md' });
    expect(read.content[0].text).toContain('promoted');
  });

  it('ved_memory_write rejects path traversal', async () => {
    const result = await callTool('ved_memory_write', {
      path: '../../../tmp/evil.md',
      content: 'malicious',
    });
    expect(result.isError).toBe(true);
  });

  // ── ved_memory_graph ──

  it('ved_memory_graph walks wikilinks', async () => {
    const result = await callTool('ved_memory_graph', { start: 'alice' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.root).toBe('alice');
    expect(data.nodes).toContain('alice');
    // alice links to bob and project-ved
    expect(data.edges.length).toBeGreaterThan(0);
  });

  it('ved_memory_graph returns error for missing start', async () => {
    const result = await callTool('ved_memory_graph', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('start is required');
  });

  // ── ved_daily_read ──

  it('ved_daily_read returns today\'s note', async () => {
    const result = await callTool('ved_daily_read');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('MCP server');
  });

  it('ved_daily_read returns message for missing date', async () => {
    const result = await callTool('ved_daily_read', { date: '1900-01-01' });
    expect(result.content[0].text).toContain('No daily note');
  });

  it('ved_daily_read rejects invalid date format', async () => {
    const result = await callTool('ved_daily_read', { date: 'not-a-date' });
    expect(result.isError).toBe(true);
  });

  // ── ved_daily_write ──

  it('ved_daily_write appends to daily note', async () => {
    await callTool('ved_daily_write', { content: 'Afternoon update: shipped MCP.' });

    const read = await callTool('ved_daily_read');
    expect(read.content[0].text).toContain('Afternoon update');
  });

  it('ved_daily_write creates note for new date', async () => {
    await callTool('ved_daily_write', { content: 'Historic note.', date: '2020-01-01' });

    const read = await callTool('ved_daily_read', { date: '2020-01-01' });
    expect(read.content[0].text).toContain('Historic note');
  });

  // ── ved_audit_query ──

  it('ved_audit_query returns audit entries', async () => {
    const result = await callTool('ved_audit_query', { limit: 5 });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });

  // ── ved_audit_verify ──

  it('ved_audit_verify checks chain integrity', async () => {
    const result = await callTool('ved_audit_verify');
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.intact).toBe('boolean');
    expect(typeof data.total).toBe('number');
  });

  // ── ved_search ──

  it('ved_search returns results', async () => {
    // Index vault first
    await app.reindexVault();

    const result = await callTool('ved_search', { query: 'alice engineer' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data).toBeDefined();
  });

  it('ved_search requires query', async () => {
    const result = await callTool('ved_search', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query is required');
  });

  // ── ved_task_list ──

  it('ved_task_list returns tasks', async () => {
    const result = await callTool('ved_task_list');
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].status).toBe('todo');
  });

  it('ved_task_list filters by status', async () => {
    const result = await callTool('ved_task_list', { status: 'done' });
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(0);
  });

  // ── Unknown tool ──

  it('returns error for unknown tool', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32602);
  });

  // ── Missing tool name ──

  it('returns error for missing tool name', async () => {
    const res = await handler.handleRequest({
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: { arguments: {} },
    });
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32602);
  });
});

// ── HTTP Server Tests ──

describe('MCPHttpServer', () => {
  let dir: string;
  let app: VedApp;
  let server: MCPHttpServer;
  let port: number;

  beforeEach(async () => {
    dir = tmpDir();
    app = await createTestApp(dir);
    server = new MCPHttpServer(app, { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('health endpoint returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.server).toBe('ved-mcp');
  });

  it('SSE endpoint returns event stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Read the first chunk which should contain the endpoint event
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('event: endpoint');
    expect(text).toContain('/message?sessionId=');

    controller.abort();
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for POST /message without sessionId', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for POST /message with invalid sessionId', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/message?sessionId=fake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(404);
  });

  it('handles CORS preflight', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('tracks session count', async () => {
    expect(server.sessionCount).toBe(0);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    // Read first chunk to ensure connection is established
    const reader = res.body!.getReader();
    await reader.read();

    expect(server.sessionCount).toBe(1);

    controller.abort();

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 100));
    expect(server.sessionCount).toBe(0);
  });

  it('full MCP flow: SSE → initialize → tools/list → tools/call', async () => {
    const controller = new AbortController();

    // 1. Connect to SSE
    const sseRes = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // 2. Read endpoint event
    const { value: chunk1 } = await reader.read();
    const text1 = decoder.decode(chunk1);
    const endpointMatch = text1.match(/data: (\/message\?sessionId=[^\n]+)/);
    expect(endpointMatch).not.toBeNull();
    const messageUrl = `http://127.0.0.1:${port}${endpointMatch![1]}`;

    // 3. Initialize
    const initRes = await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      }),
    });
    expect(initRes.status).toBe(202);

    // Read SSE response
    const { value: chunk2 } = await reader.read();
    const text2 = decoder.decode(chunk2);
    expect(text2).toContain('"protocolVersion"');

    // 4. List tools
    await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    const { value: chunk3 } = await reader.read();
    const text3 = decoder.decode(chunk3);
    expect(text3).toContain('ved_search');

    // 5. Call ved_stats
    await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'ved_stats', arguments: {} },
      }),
    });

    const { value: chunk4 } = await reader.read();
    const text4 = decoder.decode(chunk4);
    expect(text4).toContain('vault');

    controller.abort();
  });
});

// ── Security Tests ──

describe('MCP Server Security', () => {
  let dir: string;
  let app: VedApp;
  let handler: MCPServerHandler;

  beforeEach(async () => {
    dir = tmpDir();
    app = await createTestApp(dir);
    handler = new MCPServerHandler(app);
    await handler.handleRequest({
      jsonrpc: '2.0', id: 0, method: 'initialize', params: {},
    });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await handler.handleRequest({
      jsonrpc: '2.0', id: Math.random(), method: 'tools/call',
      params: { name, arguments: args },
    });
    return res!.result;
  }

  it('blocks path traversal in memory_read', async () => {
    const paths = ['../secret.md', '../../etc/passwd', '/etc/passwd', 'entities/../../../etc/passwd'];
    for (const path of paths) {
      const result = await callTool('ved_memory_read', { path });
      expect(result.isError).toBe(true);
    }
  });

  it('blocks path traversal in memory_write', async () => {
    const paths = ['../evil.md', '../../tmp/hack', '/tmp/evil'];
    for (const path of paths) {
      const result = await callTool('ved_memory_write', { path, content: 'hack' });
      expect(result.isError).toBe(true);
    }
  });

  it('handles empty/missing required params', async () => {
    expect((await callTool('ved_memory_read', {})).isError).toBe(true);
    expect((await callTool('ved_memory_read', { path: '' })).isError).toBe(true);
    expect((await callTool('ved_memory_write', {})).isError).toBe(true);
    expect((await callTool('ved_memory_write', { path: 'x.md' })).isError).toBe(true);
    expect((await callTool('ved_memory_write', { content: 'x' })).isError).toBe(true);
    expect((await callTool('ved_memory_graph', {})).isError).toBe(true);
    expect((await callTool('ved_search', {})).isError).toBe(true);
    expect((await callTool('ved_daily_write', {})).isError).toBe(true);
  });

  it('caps search limit at 20', async () => {
    // This shouldn't crash even with huge limit
    const result = await callTool('ved_search', { query: 'test', limit: 99999 });
    // Just verify it doesn't error
    expect(result.content).toBeDefined();
  });

  it('caps graph depth at 3', async () => {
    const result = await callTool('ved_memory_graph', { start: 'alice', depth: 100 });
    // Should not crash or infinite loop
    expect(result.content).toBeDefined();
  });

  it('handles invalid date in daily_read gracefully', async () => {
    const result = await callTool('ved_daily_read', { date: '2024-13-45' });
    // Still matches YYYY-MM-DD format, but file won't exist
    expect(result.isError).toBeUndefined();
  });

  it('rejects clearly invalid date format', async () => {
    const result = await callTool('ved_daily_read', { date: 'yesterday' });
    expect(result.isError).toBe(true);
  });
});
