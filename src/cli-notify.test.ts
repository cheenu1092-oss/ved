/**
 * Tests for ved notify — notification rules manager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock getConfigDir before imports
const testDir = join(tmpdir(), `ved-notify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
vi.mock('./core/config.js', () => ({
  getConfigDir: () => testDir,
  loadConfig: () => ({}),
  validateConfig: () => ({ valid: true, errors: [] }),
  getDefaults: () => ({}),
}));

import {
  loadRules,
  saveRules,
  loadHistory,
  loadMuteState,
  validateRuleName,
  renderTemplate,
  isInQuietHours,
  deliverTerminal,
  deliverLog,
  NotifyRunner,
  notifyCommand,
  NOTIFY_CHANNELS,
  type NotifyRule,
} from './cli-notify.js';
import { EventBus, type VedEvent } from './event-bus.js';

function makeRule(overrides: Partial<NotifyRule> = {}): NotifyRule {
  const now = new Date().toISOString();
  return {
    name: 'test-rule',
    events: ['message_received'],
    channel: 'terminal',
    enabled: true,
    throttleMs: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<VedEvent> = {}): VedEvent {
  return {
    id: `evt_${Date.now()}`,
    timestamp: Date.now(),
    type: 'message_received',
    actor: 'test-user',
    sessionId: 'test-session',
    detail: { content: 'hello' },
    hash: 'abc123',
    ...overrides,
  };
}

describe('cli-notify', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ── Name Validation ──

  describe('validateRuleName', () => {
    it('accepts valid names', () => {
      expect(validateRuleName('my-rule')).toBeNull();
      expect(validateRuleName('alertOnError')).toBeNull();
      expect(validateRuleName('r123')).toBeNull();
      expect(validateRuleName('a')).toBeNull();
      expect(validateRuleName('rule_with_underscore')).toBeNull();
    });

    it('rejects invalid names', () => {
      expect(validateRuleName('')).not.toBeNull();
      expect(validateRuleName('123abc')).not.toBeNull(); // starts with number
      expect(validateRuleName('-abc')).not.toBeNull(); // starts with hyphen
      expect(validateRuleName('a'.repeat(65))).not.toBeNull(); // too long
      expect(validateRuleName('has space')).not.toBeNull();
      expect(validateRuleName('has.dot')).not.toBeNull();
    });

    it('rejects reserved names', () => {
      expect(validateRuleName('list')).not.toBeNull();
      expect(validateRuleName('add')).not.toBeNull();
      expect(validateRuleName('remove')).not.toBeNull();
      expect(validateRuleName('mute')).not.toBeNull();
      expect(validateRuleName('channels')).not.toBeNull();
    });
  });

  // ── Template Rendering ──

  describe('renderTemplate', () => {
    it('replaces all placeholders', () => {
      const event = makeEvent({
        type: 'tool_executed',
        actor: 'alice',
        sessionId: 'sess-1',
        id: 'evt-42',
      });
      const result = renderTemplate(
        'Event {type} by {actor} in {session} (id={id})',
        event
      );
      expect(result).toBe('Event tool_executed by alice in sess-1 (id=evt-42)');
    });

    it('handles missing sessionId', () => {
      const event = makeEvent({ sessionId: undefined });
      const result = renderTemplate('{session}', event);
      expect(result).toBe('none');
    });

    it('handles multiple occurrences', () => {
      const event = makeEvent({ type: 'error' });
      const result = renderTemplate('{type}:{type}', event);
      expect(result).toBe('error:error');
    });

    it('includes detail as JSON', () => {
      const event = makeEvent({ detail: { key: 'value' } });
      const result = renderTemplate('{detail}', event);
      expect(result).toBe('{"key":"value"}');
    });
  });

  // ── Quiet Hours ──

  describe('isInQuietHours', () => {
    it('returns false with no quiet hours', () => {
      expect(isInQuietHours()).toBe(false);
      expect(isInQuietHours(undefined, '07:00')).toBe(false);
    });

    it('detects same-day quiet window', () => {
      // This test is time-dependent, so we just verify the logic
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      const start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const endH = (h + 1) % 24;
      const end = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      expect(isInQuietHours(start, end)).toBe(true);
    });

    it('detects overnight quiet window', () => {
      // Test overnight: current time should be outside or inside
      const now = new Date();
      const h = now.getHours();
      // Create window that definitely includes now
      const start = `${String((h - 1 + 24) % 24).padStart(2, '0')}:00`;
      const end = `${String((h + 1) % 24).padStart(2, '0')}:00`;
      // This should be true whether it wraps or not
      expect(isInQuietHours(start, end)).toBe(true);
    });

    it('returns false when outside quiet hours', () => {
      const now = new Date();
      const h = now.getHours();
      // Create window that definitely excludes now (2 hours ago to 1 hour ago)
      const start = `${String((h - 3 + 24) % 24).padStart(2, '0')}:00`;
      const end = `${String((h - 2 + 24) % 24).padStart(2, '0')}:00`;
      expect(isInQuietHours(start, end)).toBe(false);
    });
  });

  // ── Rule CRUD ──

  describe('loadRules / saveRules', () => {
    it('returns empty array when no file', () => {
      expect(loadRules()).toEqual([]);
    });

    it('round-trips rules through YAML', () => {
      const rules: NotifyRule[] = [
        makeRule({ name: 'alert-errors', events: ['error', 'tool_error'], channel: 'desktop' }),
        makeRule({
          name: 'log-all',
          events: ['message_received'],
          channel: 'log',
          logPath: '/tmp/ved.log',
          throttleMs: 5000,
          quietStart: '22:00',
          quietEnd: '07:00',
          description: 'Log all messages',
        }),
      ];
      saveRules(rules);
      const loaded = loadRules();
      expect(loaded.length).toBe(2);
      expect(loaded[0].name).toBe('alert-errors');
      expect(loaded[0].events).toEqual(['error', 'tool_error']);
      expect(loaded[0].channel).toBe('desktop');
      expect(loaded[1].name).toBe('log-all');
      expect(loaded[1].throttleMs).toBe(5000);
      expect(loaded[1].quietStart).toBe('22:00');
      expect(loaded[1].quietEnd).toBe('07:00');
      expect(loaded[1].logPath).toBe('/tmp/ved.log');
    });

    it('handles many events (block format)', () => {
      const events = ['message_received', 'message_sent', 'llm_call', 'llm_response', 'tool_executed'] as const;
      const rules = [makeRule({ name: 'multi', events: [...events] })];
      saveRules(rules);
      const loaded = loadRules();
      expect(loaded[0].events.length).toBe(5);
      expect(loaded[0].events).toEqual([...events]);
    });

    it('handles empty rules', () => {
      saveRules([]);
      expect(loadRules()).toEqual([]);
    });
  });

  // ── Mute State ──

  describe('mute state', () => {
    it('defaults to unmuted', () => {
      const state = loadMuteState();
      expect(state.muted).toBe(false);
    });

    it('persists mute state', () => {
      // Mute via file write (simulating muteNotifications)
      const mutePath = join(testDir, 'notify-mute.json');
      writeFileSync(mutePath, JSON.stringify({ muted: true }), 'utf-8');
      const state = loadMuteState();
      expect(state.muted).toBe(true);
    });

    it('auto-unmutes when past expiry', () => {
      const mutePath = join(testDir, 'notify-mute.json');
      const pastDate = new Date(Date.now() - 60000).toISOString();
      writeFileSync(mutePath, JSON.stringify({ muted: true, until: pastDate }), 'utf-8');
      const state = loadMuteState();
      expect(state.muted).toBe(false);
    });

    it('stays muted when before expiry', () => {
      const mutePath = join(testDir, 'notify-mute.json');
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      writeFileSync(mutePath, JSON.stringify({ muted: true, until: futureDate }), 'utf-8');
      const state = loadMuteState();
      expect(state.muted).toBe(true);
    });
  });

  // ── Delivery Channels ──

  describe('deliverTerminal', () => {
    it('writes to stdout', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await deliverTerminal('Test Title', 'Test Body');
      expect(writeSpy).toHaveBeenCalled();
      const allOutput = writeSpy.mock.calls.map(c => c[0]).join('');
      expect(allOutput).toContain('Test Title');
      expect(allOutput).toContain('Test Body');
      expect(allOutput).toContain('\x07'); // bell
      writeSpy.mockRestore();
    });
  });

  describe('deliverLog', () => {
    it('appends to log file', async () => {
      const logPath = join(testDir, 'test.log');
      const event = makeEvent({ type: 'error' });
      await deliverLog(logPath, 'Error occurred', 'Something broke', event);
      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('[error]');
      expect(content).toContain('Error occurred');
      expect(content).toContain('Something broke');
    });

    it('appends multiple entries', async () => {
      const logPath = join(testDir, 'test.log');
      const event1 = makeEvent({ type: 'error' });
      const event2 = makeEvent({ type: 'startup' });
      await deliverLog(logPath, 'First', 'body1', event1);
      await deliverLog(logPath, 'Second', 'body2', event2);
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  // ── NotifyRunner ──

  describe('NotifyRunner', () => {
    it('starts and stops cleanly', () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      runner.start();
      expect(runner.stats().active).toBe(true);
      expect(bus.subscriberCount).toBe(1);
      runner.stop();
      expect(runner.stats().active).toBe(false);
      expect(bus.subscriberCount).toBe(0);
    });

    it('double start is no-op', () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      runner.start();
      runner.start();
      expect(bus.subscriberCount).toBe(1);
      runner.stop();
    });

    it('delivers matching events via log channel', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const logPath = join(testDir, 'runner-test.log');
      const rule = makeRule({
        name: 'log-errors',
        events: ['error'],
        channel: 'log',
        logPath,
      });
      saveRules([rule]);

      runner.start();
      const event = makeEvent({ type: 'error' });
      await runner.processEvent(event);

      expect(runner.stats().deliveryCount).toBe(1);
      expect(existsSync(logPath)).toBe(true);
      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('[error]');
      runner.stop();
    });

    it('skips non-matching events', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const rule = makeRule({ name: 'errors-only', events: ['error'], channel: 'log' });
      saveRules([rule]);

      runner.start();
      await runner.processEvent(makeEvent({ type: 'message_received' }));
      expect(runner.stats().deliveryCount).toBe(0);
      runner.stop();
    });

    it('skips disabled rules', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const rule = makeRule({ name: 'disabled-rule', events: ['error'], channel: 'log', enabled: false });
      saveRules([rule]);

      runner.start();
      await runner.processEvent(makeEvent({ type: 'error' }));
      expect(runner.stats().deliveryCount).toBe(0);
      runner.stop();
    });

    it('suppresses when globally muted', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const logPath = join(testDir, 'muted-test.log');
      saveRules([makeRule({ name: 'should-mute', events: ['error'], channel: 'log', logPath })]);

      // Set mute
      const mutePath = join(testDir, 'notify-mute.json');
      writeFileSync(mutePath, JSON.stringify({ muted: true }), 'utf-8');

      runner.start();
      await runner.processEvent(makeEvent({ type: 'error' }));
      expect(runner.stats().deliveryCount).toBe(0);
      expect(runner.stats().suppressCount).toBe(1);

      // Verify suppression recorded in history
      const history = loadHistory();
      expect(history.length).toBe(1);
      expect(history[0].suppressed).toBe(true);
      expect(history[0].suppressReason).toBe('muted');
      runner.stop();
    });

    it('throttles rapid events', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const logPath = join(testDir, 'throttle-test.log');
      saveRules([makeRule({
        name: 'throttled',
        events: ['error'],
        channel: 'log',
        logPath,
        throttleMs: 60000, // 1 minute
      })]);

      runner.start();

      // First event should deliver
      await runner.processEvent(makeEvent({ type: 'error' }));
      expect(runner.stats().deliveryCount).toBe(1);

      // Second event should be throttled
      await runner.processEvent(makeEvent({ type: 'error' }));
      expect(runner.stats().deliveryCount).toBe(1);
      expect(runner.stats().suppressCount).toBe(1);

      runner.stop();
    });

    it('uses custom title/body templates', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const logPath = join(testDir, 'template-test.log');
      saveRules([makeRule({
        name: 'custom-template',
        events: ['error'],
        channel: 'log',
        logPath,
        title: 'ALERT: {type}',
        body: 'User {actor} in {session}',
      })]);

      runner.start();
      await runner.processEvent(makeEvent({
        type: 'error',
        actor: 'bob',
        sessionId: 'main',
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('ALERT: error');
      expect(content).toContain('User bob in main');
      runner.stop();
    });

    it('records successful delivery in history', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const logPath = join(testDir, 'history-test.log');
      saveRules([makeRule({
        name: 'history-rule',
        events: ['startup'],
        channel: 'log',
        logPath,
      })]);

      runner.start();
      await runner.processEvent(makeEvent({ type: 'startup' }));

      const history = loadHistory();
      expect(history.length).toBe(1);
      expect(history[0].ruleName).toBe('history-rule');
      expect(history[0].success).toBe(true);
      expect(history[0].channel).toBe('log');
      runner.stop();
    });

    it('handles delivery errors gracefully', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      // command channel with no command configured
      saveRules([makeRule({
        name: 'will-fail',
        events: ['error'],
        channel: 'command',
        // no command!
      })]);

      runner.start();
      await runner.processEvent(makeEvent({ type: 'error' }));

      // Should not crash, error recorded in history
      const history = loadHistory();
      expect(history.length).toBe(1);
      expect(history[0].success).toBe(false);
      expect(history[0].error).toContain('No command');
      runner.stop();
    });

    it('processes multiple rules for same event', async () => {
      const bus = new EventBus();
      const runner = new NotifyRunner(bus);
      const logPath1 = join(testDir, 'multi-1.log');
      const logPath2 = join(testDir, 'multi-2.log');
      saveRules([
        makeRule({ name: 'rule-1', events: ['error'], channel: 'log', logPath: logPath1 }),
        makeRule({ name: 'rule-2', events: ['error'], channel: 'log', logPath: logPath2 }),
      ]);

      runner.start();
      await runner.processEvent(makeEvent({ type: 'error' }));
      expect(runner.stats().deliveryCount).toBe(2);
      expect(existsSync(logPath1)).toBe(true);
      expect(existsSync(logPath2)).toBe(true);
      runner.stop();
    });
  });

  // ── CLI Command (via exit code checks) ──

  describe('notifyCommand', () => {
    it('lists channels', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifyCommand(['channels']);
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('terminal');
      expect(output).toContain('desktop');
      expect(output).toContain('command');
      expect(output).toContain('log');
      logSpy.mockRestore();
    });

    it('lists empty rules', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifyCommand(['list']);
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('No notification rules');
      logSpy.mockRestore();
    });

    it('lists rules after save', async () => {
      saveRules([makeRule({ name: 'my-alert', events: ['error'], channel: 'desktop' })]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifyCommand(['list']);
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('my-alert');
      expect(output).toContain('desktop');
      logSpy.mockRestore();
    });

    it('shows rule details', async () => {
      saveRules([makeRule({
        name: 'detail-test',
        events: ['error', 'tool_error'],
        channel: 'command',
        command: 'echo test',
        description: 'Test description',
      })]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifyCommand(['show', 'detail-test']);
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('detail-test');
      expect(output).toContain('echo test');
      expect(output).toContain('Test description');
      logSpy.mockRestore();
    });

    it('shows history', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifyCommand(['history']);
      const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('No notification history');
      logSpy.mockRestore();
    });
  });

  // ── Constants ──

  describe('NOTIFY_CHANNELS', () => {
    it('has all expected channels', () => {
      expect(NOTIFY_CHANNELS).toEqual(['terminal', 'desktop', 'command', 'log']);
    });
  });
});
