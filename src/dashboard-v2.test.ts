/**
 * Dashboard v2 Tests — Session 99 Phase 2
 *
 * Tests for:
 *   - Config write endpoint (POST /api/config)
 *   - Environment endpoints (GET /api/envs, GET /api/envs/current, POST /api/envs/use, POST /api/envs/reset)
 *   - Dashboard HTML: config editor elements, env selector, session detail modal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { VedHttpServer } from './http.js';
import { EventBus } from './event-bus.js';
import { getDashboardHtml } from './dashboard.js';

// ── Module Mocks ──

vi.mock('./cli-env.js', () => ({
  listEnvs: vi.fn().mockReturnValue([]),
  getActiveEnv: vi.fn().mockReturnValue(null),
  setActiveEnv: vi.fn(),
  deactivateEnv: vi.fn(),
  envExists: vi.fn().mockReturnValue(false),
  validateEnvName: vi.fn().mockReturnValue({ valid: true }),
  clearActiveEnv: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn() };
});

vi.mock('./core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/config.js')>();
  return { ...actual, getConfigDir: vi.fn().mockReturnValue('/tmp/test-config-dir') };
});

// ── Helpers ──

function createMockApp(overrides: Record<string, unknown> = {}): any {
  return {
    eventBus: new EventBus(),
    config: {
      trust: { ownerIds: ['owner-1'], tribeIds: [], knownIds: [], defaultTier: 2 },
      memory: { vaultPath: '/tmp/vault', gitEnabled: false },
      llm: { provider: 'anthropic', apiKey: 'sk-secret', model: 'claude-opus-4-6' },
      dbPath: '/tmp/test.db',
      ...((overrides.config as object) ?? {}),
    },
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, modules: [] }),
    getStats: vi.fn().mockReturnValue({}),
    search: vi.fn().mockResolvedValue({ results: [], tokenCount: 0, metrics: {} }),
    getHistory: vi.fn().mockReturnValue([]),
    verifyAuditChain: vi.fn().mockReturnValue({ intact: true, total: 0 }),
    doctor: vi.fn().mockResolvedValue({ checks: [], passed: 0, warned: 0, failed: 0, infos: 0 }),
    listRecentSessions: vi.fn().mockReturnValue([
      { id: 'sess-001', createdAt: Date.now(), persona: 'default', model: 'claude-opus-4-6' },
    ]),
    workOrdersPending: vi.fn().mockReturnValue([]),
    workOrderGet: vi.fn().mockReturnValue(null),
    get trustConfig() { return { ownerIds: ['owner-1'], tribeIds: [], knownIds: [], defaultTier: 2, approvalTimeoutMs: 300000 }; },
    cronList: vi.fn().mockReturnValue([]),
    cronRun: vi.fn().mockResolvedValue({ success: true }),
    cronToggle: vi.fn().mockReturnValue(null),
    cronHistory: vi.fn().mockReturnValue([]),
    pluginList: vi.fn().mockReturnValue([]),
    pluginTools: vi.fn().mockReturnValue([]),
    memory: {
      vault: {
        listFiles: vi.fn().mockReturnValue([]),
        getAllBacklinks: vi.fn().mockReturnValue(new Map()),
        getLinks: vi.fn().mockReturnValue([]),
        readFile: vi.fn().mockImplementation((path: string) => {
          throw new Error('ENOENT: file not found');
        }),
        assertPathSafe: vi.fn(),
      },
    },
    eventLoop: {
      workOrders: {
        approve: vi.fn().mockReturnValue(null),
        deny: vi.fn().mockReturnValue(null),
      },
    },
    ...overrides,
  };
}

function httpGet(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port: number, path: string, data?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : '';
    const req = request(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ── Dashboard HTML: new elements ──

describe('getDashboardHtml — v2 additions', () => {
  it('config panel has edit button', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="config-edit-btn"');
  });

  it('config panel has save and cancel buttons', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="config-save-btn"');
    expect(html).toContain('id="config-cancel-btn"');
  });

  it('config panel has textarea editor', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="config-editor-area"');
  });

  it('config panel has environment selector section', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="env-selector"');
    expect(html).toContain('id="env-use-btn"');
    expect(html).toContain('id="env-reset-btn"');
  });

  it('config panel references envs API endpoints', () => {
    const html = getDashboardHtml();
    expect(html).toContain('/api/envs');
  });

  it('config panel has save status element', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="config-save-status"');
  });

  it('config panel has env status element', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="env-status"');
  });

  it('has session detail modal', () => {
    const html = getDashboardHtml();
    expect(html).toContain('id="session-modal"');
    expect(html).toContain('id="session-modal-close"');
    expect(html).toContain('id="session-modal-body"');
    expect(html).toContain('id="session-modal-meta"');
  });

  it('session items have data-session-id for click handling', () => {
    const html = getDashboardHtml();
    expect(html).toContain('data-session-id="');
  });

  it('openSessionModal function is defined', () => {
    const html = getDashboardHtml();
    expect(html).toContain('function openSessionModal(');
    expect(html).toContain('/api/sessions/');
  });

  it('loadEnvs function is defined', () => {
    const html = getDashboardHtml();
    expect(html).toContain('async function loadEnvs()');
  });

  it('config save uses POST /api/config', () => {
    const html = getDashboardHtml();
    expect(html).toContain("apiPost('/api/config'");
  });

  it('env-use-btn uses POST /api/envs/use', () => {
    const html = getDashboardHtml();
    expect(html).toContain("apiPost('/api/envs/use'");
  });

  it('env-reset-btn uses POST /api/envs/reset', () => {
    const html = getDashboardHtml();
    expect(html).toContain("apiPost('/api/envs/reset'");
  });

  it('modal has role=dialog for accessibility', () => {
    const html = getDashboardHtml();
    expect(html).toContain('role="dialog"');
  });

  it('session messages have role-based CSS classes', () => {
    const html = getDashboardHtml();
    expect(html).toContain('session-message');
    expect(html).toContain('msg-role');
    expect(html).toContain('msg-content');
  });

  it('modal CSS overlay is defined', () => {
    const html = getDashboardHtml();
    expect(html).toContain('modal-overlay');
    expect(html).toContain('modal-header');
    expect(html).toContain('modal-close');
  });

  it('env-section exists in config panel', () => {
    const html = getDashboardHtml();
    expect(html).toContain('env-section');
    expect(html).toContain('env-selector-row');
  });
});

// ── HTTP API: POST /api/config ──

describe('POST /api/config', () => {
  let server: VedHttpServer;
  let port: number;
  let mockApp: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockApp = createMockApp();
    server = new VedHttpServer(mockApp, { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('accepts JSON body and returns ok with sanitized config', async () => {
    const { writeFileSync } = await import('node:fs');
    const res = await httpPost(port, '/api/config', { logLevel: 'debug' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config).toBeDefined();
    expect((writeFileSync as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('writes to config.local.yaml in config dir', async () => {
    const { writeFileSync } = await import('node:fs');
    const { getConfigDir } = await import('./core/config.js');
    await httpPost(port, '/api/config', { logLevel: 'warn' });
    const calls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const writtenPath = calls[0][0] as string;
    expect(writtenPath).toContain('config.local.yaml');
  });

  it('redacts sensitive fields in returned config', async () => {
    const res = await httpPost(port, '/api/config', { logLevel: 'debug' });
    expect(res.status).toBe(200);
    // apiKey should be redacted in the sanitized config returned
    if (res.body.config?.llm?.apiKey) {
      expect(res.body.config.llm.apiKey).toBe('[REDACTED]');
    }
  });

  it('returns 400 for missing body', async () => {
    const res = await httpPost(port, '/api/config', undefined);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for array body', async () => {
    return new Promise<void>((resolve, reject) => {
      const data = JSON.stringify([{ key: 'val' }]);
      const req = request(
        {
          hostname: '127.0.0.1', port, path: '/api/config', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            try {
              expect(res.statusCode).toBe(400);
              expect(body.error).toBeDefined();
              resolve();
            } catch (e) { reject(e); }
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  });
});

// ── HTTP API: GET /api/envs ──

describe('GET /api/envs', () => {
  let server: VedHttpServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { listEnvs } = await import('./cli-env.js');
    (listEnvs as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: 'dev', path: '/tmp/envs/dev.yaml', size: 128, modifiedAt: new Date().toISOString(), active: true },
      { name: 'prod', path: '/tmp/envs/prod.yaml', size: 256, modifiedAt: new Date().toISOString(), active: false },
    ]);
    server = new VedHttpServer(createMockApp(), { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns env list with count', async () => {
    const res = await httpGet(port, '/api/envs');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.envs).toHaveLength(2);
  });

  it('returns env names and active status', async () => {
    const res = await httpGet(port, '/api/envs');
    const names = res.body.envs.map((e: any) => e.name);
    expect(names).toContain('dev');
    expect(names).toContain('prod');
    const dev = res.body.envs.find((e: any) => e.name === 'dev');
    expect(dev.active).toBe(true);
  });

  it('returns empty list when no envs exist', async () => {
    const { listEnvs } = await import('./cli-env.js');
    (listEnvs as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const res = await httpGet(port, '/api/envs');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.envs).toHaveLength(0);
  });
});

// ── HTTP API: GET /api/envs/current ──

describe('GET /api/envs/current', () => {
  let server: VedHttpServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = new VedHttpServer(createMockApp(), { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns null active when no env is set', async () => {
    const { getActiveEnv } = await import('./cli-env.js');
    (getActiveEnv as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await httpGet(port, '/api/envs/current');
    expect(res.status).toBe(200);
    expect(res.body.active).toBeNull();
  });

  it('returns active env name when one is set', async () => {
    const { getActiveEnv } = await import('./cli-env.js');
    (getActiveEnv as ReturnType<typeof vi.fn>).mockReturnValue('dev');
    const res = await httpGet(port, '/api/envs/current');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe('dev');
  });
});

// ── HTTP API: POST /api/envs/use ──

describe('POST /api/envs/use', () => {
  let server: VedHttpServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { envExists, setActiveEnv } = await import('./cli-env.js');
    (envExists as ReturnType<typeof vi.fn>).mockImplementation((name: string) => name === 'dev' || name === 'prod');
    server = new VedHttpServer(createMockApp(), { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('switches to existing environment', async () => {
    const res = await httpPost(port, '/api/envs/use', { name: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe('dev');
  });

  it('calls setActiveEnv with the env name', async () => {
    const { setActiveEnv } = await import('./cli-env.js');
    await httpPost(port, '/api/envs/use', { name: 'prod' });
    expect((setActiveEnv as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('prod');
  });

  it('returns 404 for unknown environment', async () => {
    const res = await httpPost(port, '/api/envs/use', { name: 'nonexistent' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nonexistent');
  });

  it('returns 400 when name is missing', async () => {
    const res = await httpPost(port, '/api/envs/use', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('returns 400 for missing body', async () => {
    const res = await httpPost(port, '/api/envs/use', undefined);
    expect(res.status).toBe(400);
  });
});

// ── HTTP API: POST /api/envs/reset ──

describe('POST /api/envs/reset', () => {
  let server: VedHttpServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = new VedHttpServer(createMockApp(), { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('deactivates environment and returns active: null', async () => {
    const res = await httpPost(port, '/api/envs/reset', {});
    expect(res.status).toBe(200);
    expect(res.body.active).toBeNull();
  });

  it('calls deactivateEnv', async () => {
    const { deactivateEnv } = await import('./cli-env.js');
    await httpPost(port, '/api/envs/reset', {});
    expect((deactivateEnv as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('works with empty body (no-op)', async () => {
    const res = await httpPost(port, '/api/envs/reset', undefined);
    // Should still work even with no body
    expect(res.status).toBe(200);
  });
});
