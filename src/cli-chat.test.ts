/**
 * Tests for ved chat — interactive conversational REPL.
 *
 * Tests parseChatArgs, TypingIndicator, slash command handling,
 * sendAndDisplay flow, and edge cases.
 *
 * @module cli-chat.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseChatArgs,
  TypingIndicator,
  type ChatOptions,
  type ChatStats,
} from './cli-chat.js';

// ── parseChatArgs ──────────────────────────────────────────────────────

describe('parseChatArgs', () => {
  it('returns empty options for no args', () => {
    const opts = parseChatArgs([]);
    expect(opts).toEqual({});
  });

  it('parses --model flag', () => {
    const opts = parseChatArgs(['--model', 'gpt-4']);
    expect(opts.model).toBe('gpt-4');
  });

  it('parses -m shorthand', () => {
    const opts = parseChatArgs(['-m', 'claude-3']);
    expect(opts.model).toBe('claude-3');
  });

  it('parses --no-rag flag', () => {
    const opts = parseChatArgs(['--no-rag']);
    expect(opts.noRag).toBe(true);
  });

  it('parses --no-tools flag', () => {
    const opts = parseChatArgs(['--no-tools']);
    expect(opts.noTools).toBe(true);
  });

  it('parses --verbose flag', () => {
    const opts = parseChatArgs(['--verbose']);
    expect(opts.verbose).toBe(true);
  });

  it('parses -v shorthand', () => {
    const opts = parseChatArgs(['-v']);
    expect(opts.verbose).toBe(true);
  });

  it('parses all flags combined', () => {
    const opts = parseChatArgs(['--model', 'llama3', '--no-rag', '--no-tools', '-v']);
    expect(opts).toEqual({
      model: 'llama3',
      noRag: true,
      noTools: true,
      verbose: true,
    });
  });

  it('handles --model with various model names', () => {
    expect(parseChatArgs(['-m', 'anthropic/claude-3-opus']).model).toBe('anthropic/claude-3-opus');
    expect(parseChatArgs(['-m', 'local:llama3:8b']).model).toBe('local:llama3:8b');
    expect(parseChatArgs(['-m', 'gpt-4o-2024-05-13']).model).toBe('gpt-4o-2024-05-13');
  });

  it('handles --model with missing value (undefined)', () => {
    const opts = parseChatArgs(['--model']);
    expect(opts.model).toBeUndefined();
  });

  it('handles duplicate flags (last wins for model)', () => {
    const opts = parseChatArgs(['-m', 'first', '-m', 'second']);
    expect(opts.model).toBe('second');
  });

  it('handles --help by calling process.exit', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    expect(() => parseChatArgs(['--help'])).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });

  it('handles -h by calling process.exit', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    expect(() => parseChatArgs(['-h'])).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });

  it('handles unknown flag by calling process.exit(1)', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseChatArgs(['--unknown'])).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('--unknown'));

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('ignores non-flag arguments (no dash prefix)', () => {
    // Non-flag args without - prefix are silently ignored (fall through default)
    const opts = parseChatArgs(['hello']);
    expect(opts).toEqual({});
  });

  it('parses flags in any order', () => {
    const opts = parseChatArgs(['--no-tools', '-m', 'test', '--verbose', '--no-rag']);
    expect(opts.model).toBe('test');
    expect(opts.noTools).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.noRag).toBe(true);
  });
});

// ── TypingIndicator ────────────────────────────────────────────────────

describe('TypingIndicator', () => {
  let indicator: TypingIndicator;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    indicator = new TypingIndicator();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    indicator.stop();
    writeSpy.mockRestore();
  });

  it('start() begins writing frames', async () => {
    indicator.start();

    // Wait for a few frames
    await new Promise(r => setTimeout(r, 200));

    indicator.stop();

    // Should have written multiple frames
    expect(writeSpy).toHaveBeenCalled();
    const calls = writeSpy.mock.calls;
    // At least one frame write + one clear write from stop()
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('start() uses custom label', async () => {
    indicator.start('searching');

    await new Promise(r => setTimeout(r, 100));

    indicator.stop();

    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    expect(writes.some(w => w.includes('searching'))).toBe(true);
  });

  it('start() uses default "thinking" label', async () => {
    indicator.start();

    await new Promise(r => setTimeout(r, 100));

    indicator.stop();

    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    expect(writes.some(w => w.includes('thinking'))).toBe(true);
  });

  it('stop() clears the line', () => {
    indicator.start();
    indicator.stop();

    const lastWrite = String(writeSpy.mock.calls[writeSpy.mock.calls.length - 1]?.[0] ?? '');
    // Should contain escape sequence to clear line
    expect(lastWrite).toContain('\r');
    expect(lastWrite).toContain('\x1B[K');
  });

  it('stop() is idempotent', () => {
    indicator.start();
    indicator.stop();
    const callCount = writeSpy.mock.calls.length;

    indicator.stop(); // second stop
    // Should not have written more
    expect(writeSpy.mock.calls.length).toBe(callCount);
  });

  it('stop() without start() does nothing', () => {
    indicator.stop();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('start() cancels previous indicator', async () => {
    indicator.start('first');
    await new Promise(r => setTimeout(r, 100));

    // Calling start again should stop the first one
    indicator.start('second');
    await new Promise(r => setTimeout(r, 100));

    indicator.stop();

    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    // Should see both labels
    expect(writes.some(w => w.includes('first'))).toBe(true);
    expect(writes.some(w => w.includes('second'))).toBe(true);
  });

  it('cycles through spinner frames', async () => {
    indicator.start();

    // Wait long enough for multiple frames (80ms each)
    await new Promise(r => setTimeout(r, 500));

    indicator.stop();

    const writes = writeSpy.mock.calls.map(c => String(c[0])).filter(w => w.includes('thinking'));
    // Should have cycled through multiple frames
    expect(writes.length).toBeGreaterThan(3);
  });
});

// ── ChatStats ──────────────────────────────────────────────────────────

describe('ChatStats', () => {
  it('can be initialized with default values', () => {
    const stats: ChatStats = {
      messageCount: 0,
      startTime: Date.now(),
      lastResponseMs: 0,
    };
    expect(stats.messageCount).toBe(0);
    expect(stats.lastResponseMs).toBe(0);
  });

  it('tracks incrementing message count', () => {
    const stats: ChatStats = {
      messageCount: 0,
      startTime: Date.now(),
      lastResponseMs: 0,
    };
    stats.messageCount++;
    stats.messageCount++;
    stats.messageCount++;
    expect(stats.messageCount).toBe(3);
  });

  it('tracks response time', () => {
    const stats: ChatStats = {
      messageCount: 0,
      startTime: Date.now(),
      lastResponseMs: 0,
    };
    stats.lastResponseMs = 1234;
    expect(stats.lastResponseMs).toBe(1234);
  });
});

// ── printChatHelp ──────────────────────────────────────────────────────

describe('printChatHelp', () => {
  it('outputs help text to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Import dynamically to avoid the top-level import issues
    const { printChatHelp } = await import('./cli-chat.js');
    printChatHelp();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('ved chat');
    expect(output).toContain('--model');
    expect(output).toContain('--no-rag');
    expect(output).toContain('--no-tools');
    expect(output).toContain('--verbose');
    expect(output).toContain('/help');
    expect(output).toContain('/search');
    expect(output).toContain('/quit');
    expect(output).toContain('/multi');
    expect(output).toContain('/stats');
    expect(output).toContain('/approve');
    expect(output).toContain('/deny');
    expect(output).toContain('/clear');
    expect(output).toContain('/facts');
    expect(output).toContain('/memory');

    writeSpy.mockRestore();
  });
});

// ── ChatOptions ────────────────────────────────────────────────────────

describe('ChatOptions', () => {
  it('model is optional', () => {
    const opts: ChatOptions = {};
    expect(opts.model).toBeUndefined();
  });

  it('all fields are optional', () => {
    const opts: ChatOptions = {};
    expect(opts.model).toBeUndefined();
    expect(opts.noRag).toBeUndefined();
    expect(opts.noTools).toBeUndefined();
    expect(opts.verbose).toBeUndefined();
  });

  it('all fields can be set', () => {
    const opts: ChatOptions = {
      model: 'test',
      noRag: true,
      noTools: true,
      verbose: true,
    };
    expect(opts.model).toBe('test');
    expect(opts.noRag).toBe(true);
    expect(opts.noTools).toBe(true);
    expect(opts.verbose).toBe(true);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('parseChatArgs handles empty string in array', () => {
    const opts = parseChatArgs(['']);
    expect(opts).toEqual({});
  });

  it('parseChatArgs handles model with spaces (unusual but valid)', () => {
    // Each arg is a separate element, so model value can be anything
    const opts = parseChatArgs(['-m', 'model with spaces']);
    expect(opts.model).toBe('model with spaces');
  });

  it('parseChatArgs handles model with special chars', () => {
    const opts = parseChatArgs(['-m', 'openai/gpt-4o@latest']);
    expect(opts.model).toBe('openai/gpt-4o@latest');
  });

  it('TypingIndicator frame array has 10 frames', () => {
    const indicator = new TypingIndicator();
    // Access private frames via prototype check
    expect((indicator as any).frames).toHaveLength(10);
    indicator.stop();
  });

  it('TypingIndicator frames are all braille characters', () => {
    const indicator = new TypingIndicator();
    const frames = (indicator as any).frames as string[];
    for (const frame of frames) {
      // Braille range: U+2800 to U+28FF
      expect(frame.charCodeAt(0)).toBeGreaterThanOrEqual(0x2800);
      expect(frame.charCodeAt(0)).toBeLessThanOrEqual(0x28FF);
    }
    indicator.stop();
  });
});
