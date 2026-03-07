/**
 * Tests for `ved trust` — CLI for managing trust tiers and work orders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VedApp } from './app.js';
import { trustCommand } from './cli-trust.js';

// === Test Helpers ===

let app: VedApp;
let tmpDir: string;
let consoleLogs: string[];
let consoleErrors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

function captureConsole(): void {
  consoleLogs = [];
  consoleErrors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => consoleLogs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => consoleErrors.push(args.map(String).join(' '));
}

function restoreConsole(): void {
  console.log = originalLog;
  console.error = originalError;
}

function allOutput(): string {
  return [...consoleLogs, ...consoleErrors].join('\n');
}

function createTestApp(): VedApp {
  tmpDir = join(tmpdir(), `ved-trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  const vaultPath = join(tmpDir, 'vault');
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(join(vaultPath, 'daily'), { recursive: true });
  mkdirSync(join(vaultPath, 'entities'), { recursive: true });
  mkdirSync(join(vaultPath, 'concepts'), { recursive: true });
  mkdirSync(join(vaultPath, 'decisions'), { recursive: true });

  return new VedApp({
    dbPath: join(tmpDir, 'ved.db'),
    memory: { vaultPath, gitEnabled: false },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'test-key' },
    trust: {
      ownerIds: ['owner-1', 'owner-2'],
      tribeIds: ['tribe-1'],
      knownIds: ['known-1'],
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
}

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

beforeEach(async () => {
  app = createTestApp();
  await app.init();
  captureConsole(); // capture AFTER init so migration logs don't break
});

afterEach(async () => {
  restoreConsole();
  await app.stop();
  mockExit.mockClear();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// === Tests ===

describe('ved trust', () => {

  describe('help / no subcommand', () => {
    it('should show usage when no subcommand given', async () => {
      await trustCommand(app, []);
      const output = allOutput();
      expect(output).toContain('Usage: ved trust');
      expect(output).toContain('matrix');
      expect(output).toContain('resolve');
      expect(output).toContain('assess');
      expect(output).toContain('grant');
      expect(output).toContain('revoke');
      expect(output).toContain('ledger');
      expect(output).toContain('pending');
    });

    it('should show usage for unknown subcommand', async () => {
      await trustCommand(app, ['nonexistent']);
      expect(allOutput()).toContain('Usage: ved trust');
    });
  });

  describe('matrix', () => {
    it('should display the trust × risk matrix', async () => {
      await trustCommand(app, ['matrix']);
      const output = allOutput();
      expect(output).toContain('Trust');
      expect(output).toContain('Risk Matrix');
      expect(output).toContain('low');
      expect(output).toContain('medium');
      expect(output).toContain('high');
      expect(output).toContain('critical');
      expect(output).toContain('Owner');
      expect(output).toContain('Tribe');
      expect(output).toContain('Known');
      expect(output).toContain('Stranger');
    });

    it('should show auto/approve/deny decisions', async () => {
      await trustCommand(app, ['matrix']);
      const output = allOutput();
      expect(output).toContain('auto');
      expect(output).toContain('approve');
      expect(output).toContain('deny');
    });

    it('should work with mat alias', async () => {
      await trustCommand(app, ['mat']);
      expect(allOutput()).toContain('Risk Matrix');
    });
  });

  describe('resolve', () => {
    it('should resolve tier 4 for configured owner', async () => {
      await trustCommand(app, ['resolve', 'discord', 'owner-1']);
      const output = allOutput();
      expect(output).toContain('Trust Resolution');
      expect(output).toContain('Owner');
    });

    it('should resolve tier 3 for tribe member', async () => {
      await trustCommand(app, ['resolve', 'discord', 'tribe-1']);
      const output = allOutput();
      expect(output).toContain('Tribe');
    });

    it('should resolve tier 2 for known user', async () => {
      await trustCommand(app, ['resolve', 'discord', 'known-1']);
      const output = allOutput();
      expect(output).toContain('Known');
    });

    it('should resolve default tier for unknown user', async () => {
      await trustCommand(app, ['resolve', 'discord', 'stranger-xyz']);
      const output = allOutput();
      expect(output).toContain('Trust Resolution');
      expect(output).toContain('Stranger');
    });

    it('should show permissions for resolved tier', async () => {
      await trustCommand(app, ['resolve', 'cli', 'owner-1']);
      const output = allOutput();
      expect(output).toContain('Permissions');
      expect(output).toContain('low');
      expect(output).toContain('critical');
    });

    it('should error with missing args', async () => {
      try {
        await trustCommand(app, ['resolve']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('Usage');
    });

    it('should work with who alias', async () => {
      await trustCommand(app, ['who', 'cli', 'owner-1']);
      expect(allOutput()).toContain('Trust Resolution');
    });
  });

  describe('assess', () => {
    it('should assess low-risk tool', async () => {
      await trustCommand(app, ['assess', 'read']);
      const output = allOutput();
      expect(output).toContain('Risk Assessment');
      expect(output).toContain('read');
      expect(output).toContain('low');
    });

    it('should assess high-risk tool', async () => {
      await trustCommand(app, ['assess', 'exec']);
      const output = allOutput();
      expect(output).toContain('high');
    });

    it('should assess with params that escalate risk', async () => {
      await trustCommand(app, ['assess', 'exec', '--params', '{"command":"rm -rf /"}']);
      const output = allOutput();
      expect(output).toContain('critical');
      expect(output).toContain('Destructive');
    });

    it('should show tier decisions for assessed risk', async () => {
      await trustCommand(app, ['assess', 'write']);
      const output = allOutput();
      expect(output).toContain('Tier 4');
      expect(output).toContain('Tier 1');
    });

    it('should assess unknown tool as medium', async () => {
      await trustCommand(app, ['assess', 'custom_tool_xyz']);
      const output = allOutput();
      expect(output).toContain('medium');
      expect(output).toContain('Unknown tool');
    });

    it('should error with missing tool name', async () => {
      try {
        await trustCommand(app, ['assess']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('Usage');
    });

    it('should error with invalid params JSON', async () => {
      try {
        await trustCommand(app, ['assess', 'exec', '--params', 'not-json']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('valid JSON');
    });

    it('should work with risk alias', async () => {
      await trustCommand(app, ['risk', 'read']);
      expect(allOutput()).toContain('Risk Assessment');
    });
  });

  describe('grant', () => {
    it('should grant trust when called by owner', async () => {
      await trustCommand(app, ['grant', 'discord', 'new-user', '3', '--as', 'owner-1', '--reason', 'trusted friend']);
      const output = allOutput();
      expect(output).toContain('Trust Granted');
      expect(output).toContain('Tribe');
      expect(output).toContain('trusted friend');
    });

    it('should error when non-owner tries to grant', async () => {
      try {
        await trustCommand(app, ['grant', 'discord', 'user', '3', '--as', 'not-an-owner']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('not an authorized owner');
    });

    it('should error with invalid tier', async () => {
      try {
        await trustCommand(app, ['grant', 'discord', 'user', '5', '--as', 'owner-1']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('tier must be');
    });

    it('should error with missing --as flag', async () => {
      try {
        await trustCommand(app, ['grant', 'discord', 'user', '3']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('Usage');
    });

    it('should grant without reason', async () => {
      await trustCommand(app, ['grant', 'slack', 'user2', '2', '--as', 'owner-1']);
      const output = allOutput();
      expect(output).toContain('Trust Granted');
      expect(output).toContain('Known');
      expect(output).not.toContain('Reason');
    });
  });

  describe('revoke', () => {
    it('should revoke trust', async () => {
      app.trustGrant('discord', 'revoke-test', 3, 'owner-1');
      await trustCommand(app, ['revoke', 'discord', 'revoke-test', '--as', 'owner-1', '--reason', 'no longer trusted']);
      const output = allOutput();
      expect(output).toContain('Trust Revoked');
      expect(output).toContain('no longer trusted');
    });

    it('should error with missing --as flag', async () => {
      try {
        await trustCommand(app, ['revoke', 'discord', 'user']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('Usage');
    });

    it('should revoke without reason', async () => {
      app.trustGrant('cli', 'revoke2', 2, 'owner-1');
      await trustCommand(app, ['revoke', 'cli', 'revoke2', '--as', 'owner-1']);
      const output = allOutput();
      expect(output).toContain('Trust Revoked');
    });
  });

  describe('ledger', () => {
    it('should show empty ledger', async () => {
      await trustCommand(app, ['ledger']);
      const output = allOutput();
      expect(output).toContain('No trust ledger entries');
    });

    it('should show ledger entries after grant', async () => {
      app.trustGrant('discord', 'ledger-test', 2, 'owner-1', 'test grant');
      await trustCommand(app, ['ledger']);
      const output = allOutput();
      expect(output).toContain('Trust Ledger');
      expect(output).toContain('ledger-test');
      expect(output).toContain('active');
    });

    it('should filter by --active flag', async () => {
      app.trustGrant('discord', 'active-test', 2, 'owner-1');
      app.trustRevoke('discord', 'active-test', 'owner-1');

      await trustCommand(app, ['ledger', '--active']);
      const output = allOutput();
      expect(output).not.toContain('active-test');
    });

    it('should filter by --channel', async () => {
      app.trustGrant('slack', 'channel-test', 2, 'owner-1');
      await trustCommand(app, ['ledger', '--channel', 'telegram']);
      const output = allOutput();
      expect(output).not.toContain('channel-test');
    });

    it('should filter by --user', async () => {
      app.trustGrant('discord', 'user-filter-test', 3, 'owner-1');
      await trustCommand(app, ['ledger', '--user', 'user-filter-test']);
      const output = allOutput();
      expect(output).toContain('user-filter-test');
    });

    it('should respect --limit', async () => {
      app.trustGrant('discord', 'limit1', 2, 'owner-1');
      app.trustGrant('discord', 'limit2', 3, 'owner-1');
      app.trustGrant('discord', 'limit3', 2, 'owner-1');

      await trustCommand(app, ['ledger', '--limit', '1']);
      const output = allOutput();
      expect(output).toContain('1 entries');
    });

    it('should work with log alias', async () => {
      await trustCommand(app, ['log']);
      expect(allOutput()).toContain('No trust ledger entries');
    });
  });

  describe('pending', () => {
    it('should show empty pending list', async () => {
      await trustCommand(app, ['pending']);
      expect(allOutput()).toContain('No pending work orders');
    });

    it('should work with wo alias', async () => {
      await trustCommand(app, ['wo']);
      expect(allOutput()).toContain('No pending work orders');
    });
  });

  describe('history', () => {
    it('should show empty work order history', async () => {
      await trustCommand(app, ['history']);
      expect(allOutput()).toContain('No work orders found');
    });

    it('should accept --limit flag', async () => {
      await trustCommand(app, ['history', '--limit', '5']);
      expect(allOutput()).toContain('No work orders found');
    });

    it('should accept --status filter', async () => {
      await trustCommand(app, ['history', '--status', 'denied']);
      expect(allOutput()).toContain('No work orders found');
    });

    it('should accept --tool filter', async () => {
      await trustCommand(app, ['history', '--tool', 'exec']);
      expect(allOutput()).toContain('No work orders found');
    });

    it('should work with orders alias', async () => {
      await trustCommand(app, ['orders']);
      expect(allOutput()).toContain('No work orders found');
    });
  });

  describe('show', () => {
    it('should error for nonexistent work order', async () => {
      try {
        await trustCommand(app, ['show', 'nonexistent-id']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('not found');
    });

    it('should error with missing ID', async () => {
      try {
        await trustCommand(app, ['show']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('Usage');
    });

    it('should work with detail alias', async () => {
      try {
        await trustCommand(app, ['detail', 'fake-id']);
      } catch { /* process.exit */ }
      expect(consoleErrors.join(' ')).toContain('not found');
    });
  });

  describe('config', () => {
    it('should display trust configuration', async () => {
      await trustCommand(app, ['config']);
      const output = allOutput();
      expect(output).toContain('Trust Configuration');
      expect(output).toContain('Default Tier');
      expect(output).toContain('Approval Timeout');
      expect(output).toContain('Max Agentic Loops');
    });

    it('should show configured owner IDs', async () => {
      await trustCommand(app, ['config']);
      const output = allOutput();
      expect(output).toContain('Owner IDs');
      expect(output).toContain('owner-1');
      expect(output).toContain('owner-2');
    });

    it('should show tribe IDs', async () => {
      await trustCommand(app, ['config']);
      const output = allOutput();
      expect(output).toContain('Tribe IDs');
      expect(output).toContain('tribe-1');
    });

    it('should show known IDs', async () => {
      await trustCommand(app, ['config']);
      const output = allOutput();
      expect(output).toContain('Known IDs');
      expect(output).toContain('known-1');
    });

    it('should work with cfg alias', async () => {
      await trustCommand(app, ['cfg']);
      expect(allOutput()).toContain('Trust Configuration');
    });
  });

  describe('edge cases', () => {
    it('should handle resolve with extra args gracefully', async () => {
      await trustCommand(app, ['resolve', 'discord', 'owner-1', 'extra-arg']);
      expect(allOutput()).toContain('Trust Resolution');
    });

    it('should handle assess with sensitive file write', async () => {
      await trustCommand(app, ['assess', 'Write', '--params', '{"file_path":"/etc/passwd.key"}']);
      const output = allOutput();
      expect(output).toContain('critical');
      expect(output).toContain('sensitive');
    });

    it('should handle assess with sudo escalation', async () => {
      await trustCommand(app, ['assess', 'exec', '--params', '{"command":"sudo apt update"}']);
      const output = allOutput();
      expect(output).toContain('high');
      expect(output).toContain('sudo');
    });

    it('should handle grant with tier 1 (stranger)', async () => {
      await trustCommand(app, ['grant', 'cli', 'downgrade-test', '1', '--as', 'owner-1']);
      expect(allOutput()).toContain('Stranger');
    });

    it('should handle grant with tier 4 (owner)', async () => {
      await trustCommand(app, ['grant', 'cli', 'promote-test', '4', '--as', 'owner-1']);
      expect(allOutput()).toContain('Owner');
    });

    it('should verify granted trust persists via resolve', async () => {
      // Grant tier 3 to a stranger, then resolve should show tier 3
      app.trustGrant('discord', 'persist-test', 3, 'owner-1');
      await trustCommand(app, ['resolve', 'discord', 'persist-test']);
      expect(allOutput()).toContain('Tribe');
    });

    it('should verify revoked trust falls back to config', async () => {
      app.trustGrant('discord', 'fallback-test', 3, 'owner-1');
      app.trustRevoke('discord', 'fallback-test', 'owner-1');
      await trustCommand(app, ['resolve', 'discord', 'fallback-test']);
      expect(allOutput()).toContain('Stranger');
    });

    it('should assess script file write as high risk', async () => {
      await trustCommand(app, ['assess', 'Write', '--params', '{"file_path":"deploy.sh"}']);
      const output = allOutput();
      expect(output).toContain('high');
      expect(output).toContain('script');
    });
  });
});
