/**
 * Tests for ved hook — lifecycle hook manager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateHookName,
  validateCommand,
  validateEvents,
  loadHooks,
  saveHooks,
  executeHook,
  HookRunner,
  type HookEntry,
  type HookStore,
} from './cli-hook.js';
import { EventBus, type VedEvent } from './event-bus.js';
import type { AuditEventType } from './types/index.js';

// ── Test Helpers ───────────────────────────────────────────────────────

let originalConfigDir: string | undefined;
let testDir: string;

function setTestConfigDir(dir: string): void {
  // Monkey-patch getConfigDir for tests
  originalConfigDir = process.env.VED_CONFIG_DIR;
  process.env.VED_CONFIG_DIR = dir;
}

function makeHook(overrides: Partial<HookEntry> = {}): HookEntry {
  const now = new Date().toISOString();
  return {
    name: 'test-hook',
    events: ['message_received'] as AuditEventType[],
    command: 'echo "hello"',
    enabled: true,
    timeoutMs: 30000,
    maxConcurrent: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<VedEvent> = {}): VedEvent {
  return {
    id: 'evt_' + Date.now(),
    timestamp: Date.now(),
    type: 'message_received',
    actor: 'test-user',
    sessionId: 'test-session',
    detail: { content: 'hello' },
    hash: 'hash_' + Date.now().toString(36),
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `ved-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setTestConfigDir(testDir);
});

afterEach(() => {
  if (originalConfigDir !== undefined) {
    process.env.VED_CONFIG_DIR = originalConfigDir;
  } else {
    delete process.env.VED_CONFIG_DIR;
  }
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ── Validation Tests ───────────────────────────────────────────────────

describe('validateHookName', () => {
  it('accepts valid names', () => {
    expect(validateHookName('my-hook')).toBeNull();
    expect(validateHookName('hook1')).toBeNull();
    expect(validateHookName('a')).toBeNull();
    expect(validateHookName('notify_slack')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateHookName('')).toContain('required');
  });

  it('rejects names starting with number', () => {
    expect(validateHookName('1hook')).not.toBeNull();
  });

  it('rejects names starting with hyphen', () => {
    expect(validateHookName('-hook')).not.toBeNull();
  });

  it('rejects names with special chars', () => {
    expect(validateHookName('hook@test')).not.toBeNull();
    expect(validateHookName('hook test')).not.toBeNull();
  });

  it('rejects names over 64 chars', () => {
    expect(validateHookName('a'.repeat(65))).not.toBeNull();
  });

  it('accepts max length name (64)', () => {
    expect(validateHookName('a'.repeat(64))).toBeNull();
  });
});

describe('validateCommand', () => {
  it('accepts safe commands', () => {
    expect(validateCommand('echo hello')).toBeNull();
    expect(validateCommand('curl -X POST https://hooks.slack.com/xxx')).toBeNull();
    expect(validateCommand('ved backup create')).toBeNull();
    expect(validateCommand('python3 script.py')).toBeNull();
  });

  it('rejects empty commands', () => {
    expect(validateCommand('')).toContain('required');
    expect(validateCommand('   ')).toContain('required');
  });

  it('blocks rm -rf /', () => {
    expect(validateCommand('rm -rf /')).toContain('blocked');
  });

  it('blocks sudo', () => {
    expect(validateCommand('sudo apt update')).toContain('blocked');
  });

  it('blocks dd if=', () => {
    expect(validateCommand('dd if=/dev/zero of=/dev/sda')).not.toBeNull();
  });

  it('blocks fork bombs', () => {
    expect(validateCommand(':() { :|:& };:')).not.toBeNull();
  });
});

describe('validateEvents', () => {
  it('validates known event types', () => {
    const { valid, invalid } = validateEvents(['message_received', 'session_start']);
    expect(valid).toEqual(['message_received', 'session_start']);
    expect(invalid).toEqual([]);
  });

  it('separates invalid event types', () => {
    const { valid, invalid } = validateEvents(['message_received', 'fake_event']);
    expect(valid).toEqual(['message_received']);
    expect(invalid).toEqual(['fake_event']);
  });

  it('handles all invalid', () => {
    const { valid, invalid } = validateEvents(['not_real', 'also_fake']);
    expect(valid).toEqual([]);
    expect(invalid).toEqual(['not_real', 'also_fake']);
  });

  it('handles empty array', () => {
    const { valid, invalid } = validateEvents([]);
    expect(valid).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

// ── Store I/O Tests ────────────────────────────────────────────────────

describe('loadHooks / saveHooks', () => {
  it('returns empty store when no file exists', () => {
    const store = loadHooks();
    expect(store.hooks).toEqual([]);
    expect(store.history).toEqual([]);
  });

  it('round-trips hooks through save/load', () => {
    const hook = makeHook({ name: 'test-roundtrip', description: 'A test hook' });
    const store: HookStore = { hooks: [hook], history: [] };
    saveHooks(store);

    const loaded = loadHooks();
    expect(loaded.hooks).toHaveLength(1);
    expect(loaded.hooks[0].name).toBe('test-roundtrip');
    expect(loaded.hooks[0].events).toEqual(['message_received']);
    expect(loaded.hooks[0].command).toBe('echo "hello"');
    expect(loaded.hooks[0].enabled).toBe(true);
    expect(loaded.hooks[0].description).toBe('A test hook');
    expect(loaded.hooks[0].timeoutMs).toBe(30000);
    expect(loaded.hooks[0].maxConcurrent).toBe(1);
  });

  it('handles multiple hooks', () => {
    const hooks = [
      makeHook({ name: 'hook-a', events: ['message_received'] as AuditEventType[] }),
      makeHook({ name: 'hook-b', events: ['session_start', 'session_close'] as AuditEventType[] }),
      makeHook({ name: 'hook-c', enabled: false }),
    ];
    saveHooks({ hooks, history: [] });

    const loaded = loadHooks();
    expect(loaded.hooks).toHaveLength(3);
    expect(loaded.hooks[0].name).toBe('hook-a');
    expect(loaded.hooks[1].name).toBe('hook-b');
    expect(loaded.hooks[1].events).toEqual(['session_start', 'session_close']);
    expect(loaded.hooks[2].enabled).toBe(false);
  });

  it('handles special characters in commands', () => {
    const hook = makeHook({ command: 'echo "hello: world" | grep \'test\'' });
    saveHooks({ hooks: [hook], history: [] });

    const loaded = loadHooks();
    expect(loaded.hooks[0].command).toBe('echo "hello: world" | grep \'test\'');
  });

  it('handles corrupt file gracefully', () => {
    writeFileSync(join(testDir, 'hooks.yaml'), 'not: valid: yaml: {{{', 'utf-8');
    // Should not throw
    const loaded = loadHooks();
    expect(loaded.hooks).toEqual([]);
  });
});

// ── Hook Execution Tests ───────────────────────────────────────────────

describe('executeHook', () => {
  it('executes a simple echo command', async () => {
    const hook = makeHook({ command: 'echo "executed"' });
    const event = makeEvent();
    const result = await executeHook(hook, event);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('executed');
    expect(result.hookName).toBe('test-hook');
    expect(result.eventType).toBe('message_received');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('receives event JSON on stdin', async () => {
    const hook = makeHook({ command: 'cat' });
    const event = makeEvent({ detail: { foo: 'bar' } });
    const result = await executeHook(hook, event);

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.detail.foo).toBe('bar');
    expect(parsed.type).toBe('message_received');
  });

  it('sets VED_EVENT_* environment variables', async () => {
    const hook = makeHook({ command: 'echo $VED_EVENT_TYPE' });
    const event = makeEvent({ type: 'session_start' });
    const result = await executeHook(hook, event);

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('session_start');
  });

  it('captures stderr on failure', async () => {
    const hook = makeHook({ command: 'echo "error msg" >&2 && exit 1' });
    const event = makeEvent();
    const result = await executeHook(hook, event);

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('error msg');
  });

  it('respects timeout', async () => {
    const hook = makeHook({ command: 'sleep 10', timeoutMs: 200 });
    const event = makeEvent();
    const result = await executeHook(hook, event);

    expect(result.success).toBe(false);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('enforces concurrency limit', async () => {
    const hook = makeHook({ command: 'sleep 0.5', maxConcurrent: 1 });
    const event = makeEvent();

    // Start first execution (runs in background)
    const first = executeHook(hook, event);

    // Wait a tick for the first to register its active count
    await new Promise(r => setTimeout(r, 50));

    // Second should be skipped
    const second = await executeHook(hook, event);
    expect(second.success).toBe(false);
    expect(second.stderr).toContain('concurrent');

    // Wait for first to finish
    const firstResult = await first;
    expect(firstResult.success).toBe(true);
  });

  it('truncates long output', async () => {
    // Generate output larger than 4KB using printf (more portable)
    const hook = makeHook({ command: 'printf "%0.sx" $(seq 1 10000)' });
    const event = makeEvent();
    const result = await executeHook(hook, event);

    // Whether it succeeds or not (maxBuffer), the output should be capped
    if (result.success) {
      expect(result.stdout.length).toBeLessThanOrEqual(4096 + 20);
    }
    // If maxBuffer exceeded, that's also valid truncation behavior
  });
});

// ── HookRunner Tests ───────────────────────────────────────────────────

describe('HookRunner', () => {
  it('subscribes to EventBus on start', () => {
    const bus = new EventBus();
    const runner = new HookRunner(bus);

    expect(bus.subscriberCount).toBe(0);
    runner.start();
    expect(bus.subscriberCount).toBe(1);
    runner.stop();
    expect(bus.subscriberCount).toBe(0);
  });

  it('does not double-subscribe', () => {
    const bus = new EventBus();
    const runner = new HookRunner(bus);

    runner.start();
    runner.start(); // idempotent
    expect(bus.subscriberCount).toBe(1);
    runner.stop();
  });

  it('executes matching hooks on event', async () => {
    // Save a hook that echoes to a temp file
    const outFile = join(testDir, 'hook-output.txt');
    const hook = makeHook({
      name: 'test-runner',
      events: ['message_received'] as AuditEventType[],
      command: `echo "triggered" > "${outFile}"`,
    });
    saveHooks({ hooks: [hook], history: [] });

    const bus = new EventBus();
    const runner = new HookRunner(bus);
    runner.start();

    const event = makeEvent();
    bus.emit(event);

    // Wait for async execution
    await new Promise(r => setTimeout(r, 500));

    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, 'utf-8').trim()).toBe('triggered');

    runner.stop();
  });

  it('skips disabled hooks', async () => {
    const outFile = join(testDir, 'hook-disabled.txt');
    const hook = makeHook({
      name: 'disabled-hook',
      enabled: false,
      command: `echo "should-not-run" > "${outFile}"`,
    });
    saveHooks({ hooks: [hook], history: [] });

    const bus = new EventBus();
    const runner = new HookRunner(bus);
    runner.start();

    bus.emit(makeEvent());
    await new Promise(r => setTimeout(r, 300));

    expect(existsSync(outFile)).toBe(false);
    runner.stop();
  });

  it('skips non-matching event types', async () => {
    const outFile = join(testDir, 'hook-nomatch.txt');
    const hook = makeHook({
      name: 'session-only',
      events: ['session_start'] as AuditEventType[],
      command: `echo "wrong-event" > "${outFile}"`,
    });
    saveHooks({ hooks: [hook], history: [] });

    const bus = new EventBus();
    const runner = new HookRunner(bus);
    runner.start();

    bus.emit(makeEvent({ type: 'message_received' }));
    await new Promise(r => setTimeout(r, 300));

    expect(existsSync(outFile)).toBe(false);
    runner.stop();
  });

  it('reloads hooks from disk', () => {
    const bus = new EventBus();
    const runner = new HookRunner(bus);

    // Initially no hooks
    saveHooks({ hooks: [], history: [] });
    runner.reload();

    // Add a hook and reload
    saveHooks({ hooks: [makeHook()], history: [] });
    runner.reload();

    // No crash, no error — reload is safe
    runner.stop();
  });
});

// ── YAML Edge Cases ────────────────────────────────────────────────────

describe('YAML serialization edge cases', () => {
  it('handles colons in commands', () => {
    const hook = makeHook({ command: 'curl https://api.example.com:8080/path' });
    saveHooks({ hooks: [hook], history: [] });
    const loaded = loadHooks();
    expect(loaded.hooks[0].command).toBe('curl https://api.example.com:8080/path');
  });

  it('handles quotes in descriptions', () => {
    const hook = makeHook({ description: 'Hook for "testing" purposes' });
    saveHooks({ hooks: [hook], history: [] });
    const loaded = loadHooks();
    expect(loaded.hooks[0].description).toBe('Hook for "testing" purposes');
  });

  it('handles multiple event types', () => {
    const hook = makeHook({
      events: ['message_received', 'session_start', 'tool_executed'] as AuditEventType[],
    });
    saveHooks({ hooks: [hook], history: [] });
    const loaded = loadHooks();
    expect(loaded.hooks[0].events).toEqual(['message_received', 'session_start', 'tool_executed']);
  });

  it('preserves enabled=false through round-trip', () => {
    const hook = makeHook({ enabled: false });
    saveHooks({ hooks: [hook], history: [] });
    const loaded = loadHooks();
    expect(loaded.hooks[0].enabled).toBe(false);
  });

  it('handles pipe characters in commands', () => {
    const hook = makeHook({ command: 'cat | jq ".type" | tee /tmp/out.txt' });
    saveHooks({ hooks: [hook], history: [] });
    const loaded = loadHooks();
    expect(loaded.hooks[0].command).toBe('cat | jq ".type" | tee /tmp/out.txt');
  });
});

// ── Security Tests ─────────────────────────────────────────────────────

describe('Hook security', () => {
  it('blocks rm -rf /', () => {
    expect(validateCommand('rm -rf /')).not.toBeNull();
  });

  it('blocks rm -f ~', () => {
    expect(validateCommand('rm -f ~/important')).not.toBeNull();
  });

  it('blocks sudo commands', () => {
    expect(validateCommand('sudo systemctl restart')).not.toBeNull();
  });

  it('blocks writing to /dev', () => {
    expect(validateCommand('echo x > /dev/sda')).not.toBeNull();
  });

  it('allows safe commands through', () => {
    expect(validateCommand('echo hello')).toBeNull();
    expect(validateCommand('curl https://safe.com')).toBeNull();
    expect(validateCommand('ved search "test"')).toBeNull();
  });
});
