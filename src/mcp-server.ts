/**
 * MCP Server — Expose Ved as an MCP tool server.
 *
 * Turns Ved into an MCP-compliant server that other agents can connect to.
 * Supports stdio and HTTP transports. Exposes 12 tools:
 *
 *   ved_search       — RAG search (FTS + vector + graph fusion)
 *   ved_memory_list  — List vault entities (with filters)
 *   ved_memory_read  — Read a vault file
 *   ved_memory_write — Write/update a vault entity
 *   ved_memory_graph — Walk wikilink graph
 *   ved_daily_read   — Read today's (or any) daily note
 *   ved_daily_write  — Append to a daily note
 *   ved_audit_query  — Query audit log (with type/date filters)
 *   ved_audit_verify — Verify hash chain integrity
 *   ved_stats        — System statistics
 *   ved_doctor       — Run diagnostics
 *   ved_task_list    — List tasks (with status/project filters)
 *
 * Protocol: JSON-RPC 2.0 over line-delimited stdio or HTTP.
 * Spec: MCP 2024-11-05
 *
 * @module mcp-server
 */

import { createInterface } from 'node:readline';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from './core/log.js';
import type { VedApp } from './app.js';

const log = createLogger('mcp-server');

const VED_VERSION = '0.6.0';
const PROTOCOL_VERSION = '2024-11-05';

// ── JSON-RPC Types ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP Tool Schema ──

interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Tool Definitions ──

const TOOLS: MCPToolSchema[] = [
  {
    name: 'ved_search',
    description: 'Search Ved\'s knowledge base using RAG (FTS + vector + graph fusion). Returns ranked results with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
        ftsOnly: { type: 'boolean', description: 'Use FTS only (skip vector search)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ved_memory_list',
    description: 'List entities in Ved\'s Obsidian knowledge vault. Filter by type (person/project/concept/decision/topic) or tag.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Entity type filter (person/project/concept/decision/topic)' },
        tag: { type: 'string', description: 'Tag filter' },
        folder: { type: 'string', description: 'Vault folder filter' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
    },
  },
  {
    name: 'ved_memory_read',
    description: 'Read a specific file from Ved\'s Obsidian vault. Returns content with YAML frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative file path (e.g., "entities/bob-friday.md")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ved_memory_write',
    description: 'Write or update an entity in Ved\'s Obsidian vault. Creates the file if it doesn\'t exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path (e.g., "entities/new-person.md")' },
        content: { type: 'string', description: 'Full Markdown content (with optional YAML frontmatter)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'ved_memory_graph',
    description: 'Walk the wikilink graph from a starting entity. Shows connections at specified depth.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Starting entity name (without [[]])' },
        depth: { type: 'number', description: 'Walk depth (default: 1, max: 3)' },
      },
      required: ['start'],
    },
  },
  {
    name: 'ved_daily_read',
    description: 'Read a daily note from Ved\'s Obsidian vault. Defaults to today.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
      },
    },
  },
  {
    name: 'ved_daily_write',
    description: 'Append content to a daily note. Creates the note if it doesn\'t exist.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to append' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'ved_audit_query',
    description: 'Query Ved\'s tamper-evident audit log. Filter by event type and date range.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Event type filter (e.g., "tool_call", "memory_write")' },
        since: { type: 'string', description: 'Start date (YYYY-MM-DD or ISO)' },
        until: { type: 'string', description: 'End date (YYYY-MM-DD or ISO)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
    },
  },
  {
    name: 'ved_audit_verify',
    description: 'Verify the integrity of Ved\'s hash-chained audit log. Returns chain status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of entries to verify (default: all)' },
      },
    },
  },
  {
    name: 'ved_stats',
    description: 'Get Ved system statistics: vault size, RAG index, audit entries, sessions, uptime.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ved_doctor',
    description: 'Run Ved self-diagnostics. Returns health status across 8 checks.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ved_task_list',
    description: 'List tasks from Ved\'s task management system. Filter by status or project.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (todo/in-progress/done/archived)' },
        project: { type: 'string', description: 'Filter by project name' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
    },
  },
];

// ── Tool Handler ──

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function handleToolCall(app: VedApp, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'ved_search': {
        const query = String(args.query ?? '');
        if (!query) return errorResult('query is required');
        const topK = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
        const opts: Record<string, unknown> = { ftsTopK: topK, vectorTopK: topK };
        if (args.ftsOnly) {
          opts.sources = ['fts'];
        }
        const results = await app.search(query, opts as Parameters<typeof app.search>[1]);
        return textResult(JSON.stringify(results, null, 2));
      }

      case 'ved_memory_list': {
        const vault = app.memory.vault;
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
        let paths = vault.listFiles(args.folder ? String(args.folder) : undefined);

        if (args.type) {
          const typeFolder = getFolderForType(String(args.type));
          if (typeFolder) paths = paths.filter(p => p.startsWith(typeFolder));
        }

        const out: Array<{ path: string; type: string; title: string }> = [];
        for (const p of paths.slice(0, limit)) {
          try {
            const file = vault.readFile(p);
            const fm = file.frontmatter ?? {};
            out.push({
              path: p,
              type: (fm.type as string) ?? guessTypeFromPath(p),
              title: (fm.title as string) ?? p.split('/').pop()?.replace('.md', '') ?? p,
            });
          } catch {
            out.push({ path: p, type: guessTypeFromPath(p), title: p.split('/').pop()?.replace('.md', '') ?? p });
          }
        }
        return textResult(JSON.stringify(out, null, 2));
      }

      case 'ved_memory_read': {
        const path = String(args.path ?? '');
        if (!path) return errorResult('path is required');
        if (path.startsWith('/')) return errorResult('Absolute paths are not allowed');
        const vault = app.memory.vault;
        try {
          vault.assertPathSafe(path);
        } catch (e: any) {
          return errorResult(e.message ?? 'Invalid path');
        }
        if (!vault.exists(path)) return errorResult(`File not found: ${path}`);
        const file = vault.readFile(path);
        return textResult(file.raw);
      }

      case 'ved_memory_write': {
        const path = String(args.path ?? '');
        const content = String(args.content ?? '');
        if (!path) return errorResult('path is required');
        if (!content) return errorResult('content is required');
        // Block absolute paths before join() can neutralize them
        if (path.startsWith('/')) return errorResult('Absolute paths are not allowed');
        const vault = app.memory.vault;
        try {
          vault.assertPathSafe(path);
        } catch (e: any) {
          return errorResult(e.message ?? 'Invalid path');
        }
        if (vault.exists(path)) {
          vault.updateFile(path, { body: content });
        } else {
          vault.createFile(path, {}, content);
        }
        return textResult(`Written: ${path}`);
      }

      case 'ved_memory_graph': {
        const start = String(args.start ?? '');
        if (!start) return errorResult('start is required');
        const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);
        const graph = walkVaultGraph(app, start, depth);
        return textResult(JSON.stringify(graph, null, 2));
      }

      case 'ved_daily_read': {
        const date = String(args.date ?? todayStr());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResult('date must be YYYY-MM-DD');
        const path = `daily/${date}.md`;
        const vault = app.memory.vault;
        if (!vault.exists(path)) return textResult(`No daily note for ${date}`);
        const file = vault.readFile(path);
        return textResult(file.body ?? '');
      }

      case 'ved_daily_write': {
        const content = String(args.content ?? '');
        if (!content) return errorResult('content is required');
        const date = String(args.date ?? todayStr());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResult('date must be YYYY-MM-DD');
        const path = `daily/${date}.md`;
        const vault = app.memory.vault;
        if (vault.exists(path)) {
          const existing = vault.readFile(path);
          vault.updateFile(path, { body: (existing.body ?? '') + '\n\n' + content });
        } else {
          vault.createFile(path, { type: 'daily', date }, `# ${date}\n\n${content}`);
        }
        return textResult(`Appended to ${path}`);
      }

      case 'ved_audit_query': {
        const opts: {
          type?: string;
          from?: number;
          to?: number;
          limit?: number;
        } = {};
        if (args.type) opts.type = String(args.type);
        if (args.since) opts.from = new Date(String(args.since)).getTime();
        if (args.until) opts.to = new Date(String(args.until)).getTime();
        opts.limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        const entries = app.getHistory(opts);
        return textResult(JSON.stringify(entries, null, 2));
      }

      case 'ved_audit_verify': {
        const limit = args.limit ? Number(args.limit) : undefined;
        const result = app.verifyAuditChain(limit);
        return textResult(JSON.stringify(result, null, 2));
      }

      case 'ved_stats': {
        const stats = app.getStats();
        return textResult(JSON.stringify(stats, null, 2));
      }

      case 'ved_doctor': {
        const result = await app.doctor();
        return textResult(JSON.stringify(result, null, 2));
      }

      case 'ved_task_list': {
        // Tasks are vault files in a tasks/ folder with frontmatter
        const vault = app.memory.vault;
        const taskPaths = vault.listFiles('tasks/');
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        const tasks: Array<Record<string, unknown>> = [];
        for (const p of taskPaths.slice(0, limit)) {
          try {
            const file = vault.readFile(p);
            const fm = file.frontmatter ?? {};
            if (args.status && fm.status !== String(args.status)) continue;
            if (args.project && fm.project !== String(args.project)) continue;
            tasks.push({ path: p, ...fm, body: file.body?.slice(0, 200) });
          } catch { /* skip */ }
        }
        return textResult(JSON.stringify(tasks, null, 2));
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Tool execution error', { tool: name, error: msg });
    return errorResult(msg);
  }
}

// ── Graph Walk Helper ──

function walkVaultGraph(app: VedApp, start: string, maxDepth: number): {
  root: string;
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
} {
  const vault = app.memory.vault;
  const visited = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const queue: Array<{ name: string; depth: number }> = [{ name: start, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.name)) continue;
    visited.add(current.name);

    if (current.depth >= maxDepth) continue;

    // Find files matching this entity name
    const allFiles = vault.listFiles();
    for (const filePath of allFiles) {
      const fileName = filePath.split('/').pop()?.replace('.md', '') ?? '';
      if (fileName.toLowerCase() !== current.name.toLowerCase()) continue;

      try {
        const file = vault.readFile(filePath);
        // Extract [[wikilinks]] from body
        const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        let match;
        while ((match = linkRegex.exec(file.body ?? '')) !== null) {
          const target = match[1].trim();
          edges.push({ from: current.name, to: target });
          if (!visited.has(target)) {
            queue.push({ name: target, depth: current.depth + 1 });
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return {
    root: start,
    nodes: [...visited],
    edges,
  };
}

// ── Helpers ──

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(msg: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getFolderForType(type: string): string | null {
  const map: Record<string, string> = {
    person: 'entities/', org: 'entities/', place: 'entities/',
    project: 'projects/', concept: 'concepts/',
    decision: 'decisions/', topic: 'topics/',
  };
  return map[type] ?? null;
}

function guessTypeFromPath(path: string): string {
  if (path.startsWith('entities/')) return 'entity';
  if (path.startsWith('projects/')) return 'project';
  if (path.startsWith('concepts/')) return 'concept';
  if (path.startsWith('decisions/')) return 'decision';
  if (path.startsWith('topics/')) return 'topic';
  if (path.startsWith('daily/')) return 'daily';
  return 'unknown';
}

// ── MCP Protocol Handler ──

export class MCPServerHandler {
  private initialized = false;
  private readonly app: VedApp;

  constructor(app: VedApp) {
    this.app = app;
  }

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Notifications (no id) don't get responses
    const isNotification = req.id === undefined || req.id === null;

    switch (req.method) {
      case 'initialize': {
        this.initialized = true;
        return this.respond(req.id ?? null, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'ved',
            version: VED_VERSION,
          },
        });
      }

      case 'notifications/initialized': {
        // Client ack — no response needed
        return null;
      }

      case 'tools/list': {
        if (!this.initialized) return this.error(req.id ?? null, -32002, 'Not initialized');
        return this.respond(req.id ?? null, { tools: TOOLS });
      }

      case 'tools/call': {
        if (!this.initialized) return this.error(req.id ?? null, -32002, 'Not initialized');
        const params = req.params ?? {};
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;

        if (!name) return this.error(req.id ?? null, -32602, 'Missing tool name');
        if (!TOOLS.find(t => t.name === name)) {
          return this.error(req.id ?? null, -32602, `Unknown tool: ${name}`);
        }

        const result = await handleToolCall(this.app, name, args);
        return this.respond(req.id ?? null, result);
      }

      case 'ping': {
        return this.respond(req.id ?? null, {});
      }

      default: {
        if (isNotification) return null;
        return this.error(req.id ?? null, -32601, `Method not found: ${req.method}`);
      }
    }
  }

  private respond(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: number | string | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// ── Stdio Transport ──

export class MCPStdioServer {
  private handler: MCPServerHandler;
  private running = false;

  constructor(app: VedApp) {
    this.handler = new MCPServerHandler(app);
  }

  async start(): Promise<void> {
    this.running = true;
    log.info('MCP stdio server started');

    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on('line', async (line: string) => {
      if (!this.running) return;
      if (!line.trim()) return;

      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        if (req.jsonrpc !== '2.0') {
          this.writeLine(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: { code: -32600, message: 'Invalid JSON-RPC version' },
          }));
          return;
        }

        const response = await this.handler.handleRequest(req);
        if (response) {
          this.writeLine(JSON.stringify(response));
        }
      } catch (err) {
        // Parse error
        this.writeLine(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }));
      }
    });

    rl.on('close', () => {
      this.running = false;
      log.info('MCP stdio server: stdin closed');
    });
  }

  stop(): void {
    this.running = false;
    log.info('MCP stdio server stopped');
  }

  private writeLine(line: string): void {
    try {
      process.stdout.write(line + '\n');
    } catch {
      // stdout closed — ignore
    }
  }
}

// ── HTTP Transport ──

interface MCPHttpSession {
  id: string;
  created: number;
  sseRes: ServerResponse | null;
  pendingMessages: string[];
}

export interface MCPHttpServerConfig {
  port: number;
  host: string;
}

export class MCPHttpServer {
  private server: Server | null = null;
  private handler: MCPServerHandler;
  private sessions = new Map<string, MCPHttpSession>();
  private readonly config: MCPHttpServerConfig;

  constructor(app: VedApp, config: MCPHttpServerConfig) {
    this.handler = new MCPServerHandler(app);
    this.config = config;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleHttp(req, res));

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server!.address();
        const port = typeof addr === 'object' ? addr!.port : this.config.port;
        log.info('MCP HTTP server started', { port, host: this.config.host });
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    // Close all SSE connections
    for (const [, session] of this.sessions) {
      if (session.sseRes) {
        try { session.sseRes.end(); } catch { /* ignore */ }
      }
    }
    this.sessions.clear();

    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => {
        this.server = null;
        log.info('MCP HTTP server stopped');
        resolve();
      });
    });
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE endpoint — client connects here first
    if (path === '/sse' && req.method === 'GET') {
      const sessionId = randomUUID();
      const session: MCPHttpSession = {
        id: sessionId,
        created: Date.now(),
        sseRes: res,
        pendingMessages: [],
      };
      this.sessions.set(sessionId, session);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send endpoint event
      const endpoint = `/message?sessionId=${sessionId}`;
      res.write(`event: endpoint\ndata: ${endpoint}\n\n`);

      // Keepalive
      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
      }, 30_000);

      // Cleanup on close
      req.on('close', () => {
        clearInterval(keepalive);
        this.sessions.delete(sessionId);
        log.info('SSE session closed', { sessionId });
      });

      return;
    }

    // Message endpoint — client sends JSON-RPC here
    if (path === '/message' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId' }));
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const body = await readBody(req);
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty body' }));
        return;
      }

      try {
        const rpcReq = JSON.parse(body) as JsonRpcRequest;
        const response = await this.handler.handleRequest(rpcReq);

        // Send response via SSE
        if (response && session.sseRes) {
          try {
            session.sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          } catch {
            // SSE connection died
          }
        }

        // HTTP response is just an ack
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      return;
    }

    // Health
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: 'ved-mcp',
        version: VED_VERSION,
        sessions: this.sessions.size,
      }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// ── Utility ──

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1_048_576; // 1MB

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
