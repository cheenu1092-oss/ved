/**
 * Tests for cli-chat-tui.ts — the upgraded Ved chat TUI.
 *
 * Covers:
 *   - parseTuiArgs: argument parsing (including --simple)
 *   - renderWithCodeHighlighting: code fence detection and rendering
 *   - highlightCodeLine: per-line syntax highlighting (structural tests)
 *   - riskBadge: risk level color codes
 *   - StatusBar: format helpers and lifecycle
 *   - TuiSpinner: start/stop lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseTuiArgs,
  renderWithCodeHighlighting,
  highlightCodeLine,
  riskBadge,
  StatusBar,
  TuiSpinner,
  printTuiHelp,
  formatAgo,
  showSessionPicker,
  type TuiOptions,
  type TuiStats,
} from './cli-chat-tui.js';

// ── parseTuiArgs ───────────────────────────────────────────────────────────────

describe('parseTuiArgs', () => {
  it('returns empty options for no args', () => {
    const opts = parseTuiArgs([]);
    expect(opts).toEqual({});
  });

  it('parses --model flag', () => {
    const opts = parseTuiArgs(['--model', 'gpt-4']);
    expect(opts.model).toBe('gpt-4');
  });

  it('parses -m shorthand', () => {
    const opts = parseTuiArgs(['-m', 'claude-3']);
    expect(opts.model).toBe('claude-3');
  });

  it('parses --no-rag flag', () => {
    const opts = parseTuiArgs(['--no-rag']);
    expect(opts.noRag).toBe(true);
  });

  it('parses --no-tools flag', () => {
    const opts = parseTuiArgs(['--no-tools']);
    expect(opts.noTools).toBe(true);
  });

  it('parses --verbose flag', () => {
    const opts = parseTuiArgs(['--verbose']);
    expect(opts.verbose).toBe(true);
  });

  it('parses -v shorthand', () => {
    const opts = parseTuiArgs(['-v']);
    expect(opts.verbose).toBe(true);
  });

  it('parses --simple flag', () => {
    const opts = parseTuiArgs(['--simple']);
    expect(opts.simple).toBe(true);
  });

  it('parses -s shorthand for --simple', () => {
    const opts = parseTuiArgs(['-s']);
    expect(opts.simple).toBe(true);
  });

  it('parses all flags combined', () => {
    const opts = parseTuiArgs(['--model', 'llama3', '--no-rag', '--no-tools', '-v']);
    expect(opts).toEqual({
      model: 'llama3',
      noRag: true,
      noTools: true,
      verbose: true,
    });
  });

  it('handles --model with missing value', () => {
    const opts = parseTuiArgs(['--model']);
    expect(opts.model).toBeUndefined();
  });

  it('handles duplicate --model (last wins)', () => {
    const opts = parseTuiArgs(['-m', 'first', '-m', 'second']);
    expect(opts.model).toBe('second');
  });

  it('handles unknown flag by calling process.exit(1)', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseTuiArgs(['--unknown-flag'])).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('--unknown-flag'));

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('handles --help by calling process.exit(0)', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(() => parseTuiArgs(['--help'])).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
    vi.restoreAllMocks();
  });

  it('ignores non-flag arguments', () => {
    const opts = parseTuiArgs(['sometext']);
    expect(opts).toEqual({});
  });

  it('parses flags in any order', () => {
    const opts = parseTuiArgs(['--no-tools', '-m', 'test', '--verbose', '--no-rag']);
    expect(opts.model).toBe('test');
    expect(opts.noTools).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.noRag).toBe(true);
  });
});

// ── TuiOptions type ────────────────────────────────────────────────────────────

describe('TuiOptions', () => {
  it('all fields are optional', () => {
    const opts: TuiOptions = {};
    expect(opts.model).toBeUndefined();
    expect(opts.noRag).toBeUndefined();
    expect(opts.noTools).toBeUndefined();
    expect(opts.verbose).toBeUndefined();
    expect(opts.simple).toBeUndefined();
  });

  it('simple flag differentiates TUI from simple mode', () => {
    const tui: TuiOptions = { simple: false };
    const simple: TuiOptions = { simple: true };
    expect(tui.simple).toBe(false);
    expect(simple.simple).toBe(true);
  });
});

// ── highlightCodeLine ──────────────────────────────────────────────────────────

describe('highlightCodeLine', () => {
  it('returns a string', () => {
    const result = highlightCodeLine('const x = 1;', 'typescript');
    expect(typeof result).toBe('string');
  });

  it('returns non-empty string for non-empty input', () => {
    const result = highlightCodeLine('hello world', 'text');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty string for empty input', () => {
    const result = highlightCodeLine('', 'text');
    expect(result).toBe('');
  });

  it('highlights keywords with ANSI codes', () => {
    const result = highlightCodeLine('const x = 1;', 'typescript');
    // Should contain ANSI escape sequences
    expect(result).toContain('\x1B[');
    // Original content should still be present
    expect(result).toContain('const');
  });

  it('preserves non-keyword content', () => {
    const result = highlightCodeLine('myVariable = something;', 'js');
    expect(result).toContain('myVariable');
    expect(result).toContain('something');
  });

  it('handles line with only whitespace', () => {
    const result = highlightCodeLine('   ', 'python');
    expect(result).toBe('   ');
  });

  it('highlights string literals', () => {
    const result = highlightCodeLine('const s = "hello";', 'js');
    expect(result).toContain('"hello"');
  });

  it('highlights numeric literals', () => {
    const result = highlightCodeLine('const n = 42;', 'js');
    expect(result).toContain('42');
  });

  it('is called with any language string', () => {
    // Should not throw for unknown languages
    expect(() => highlightCodeLine('print("hi")', 'python')).not.toThrow();
    expect(() => highlightCodeLine('puts "hi"', 'ruby')).not.toThrow();
    expect(() => highlightCodeLine('echo "hi"', 'bash')).not.toThrow();
  });
});

// ── renderWithCodeHighlighting ────────────────────────────────────────────────

describe('renderWithCodeHighlighting', () => {
  it('passes through plain text unchanged', () => {
    const text = 'Hello, world!';
    const result = renderWithCodeHighlighting(text, 80);
    expect(result).toBe(text);
  });

  it('passes through multi-line plain text unchanged', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const result = renderWithCodeHighlighting(text, 80);
    expect(result).toBe(text);
  });

  it('detects and wraps code fences', () => {
    const text = '```typescript\nconst x = 1;\n```';
    const result = renderWithCodeHighlighting(text, 80);
    // Should have box borders
    expect(result).toContain('┌');
    expect(result).toContain('└');
    // Should have line prefix
    expect(result).toContain('│');
  });

  it('includes language label in top border', () => {
    const text = '```typescript\nconst x = 1;\n```';
    const result = renderWithCodeHighlighting(text, 80);
    expect(result).toContain('typescript');
  });

  it('renders code lines with pipe prefix', () => {
    const text = '```js\nconsole.log("hi");\n```';
    const result = renderWithCodeHighlighting(text, 80);
    // Each code line should have │ prefix
    const lines = result.split('\n');
    const codeLines = lines.filter(l => l.includes('│') && !l.includes('┌') && !l.includes('└'));
    expect(codeLines.length).toBeGreaterThan(0);
  });

  it('handles multiple code blocks in one text', () => {
    const text = '```js\nlet a = 1;\n```\n\nSome text\n\n```python\nprint("hi")\n```';
    const result = renderWithCodeHighlighting(text, 80);
    const borders = (result.match(/┌/g) ?? []).length;
    expect(borders).toBe(2);
  });

  it('handles empty code block', () => {
    const text = '```\n```';
    expect(() => renderWithCodeHighlighting(text, 80)).not.toThrow();
    const result = renderWithCodeHighlighting(text, 80);
    expect(result).toContain('┌');
    expect(result).toContain('└');
  });

  it('handles unclosed code block gracefully', () => {
    const text = '```js\nconst x = 1;';
    expect(() => renderWithCodeHighlighting(text, 80)).not.toThrow();
    const result = renderWithCodeHighlighting(text, 80);
    // Should still close the box
    expect(result).toContain('└');
  });

  it('works with narrow terminal width', () => {
    const text = '```js\nconst x = 1;\n```';
    expect(() => renderWithCodeHighlighting(text, 20)).not.toThrow();
  });

  it('handles code block without language', () => {
    const text = '```\nplain code\n```';
    const result = renderWithCodeHighlighting(text, 80);
    expect(result).toContain('┌');
    // Fenced code without lang still renders a border
  });

  it('preserves text before and after code block', () => {
    const text = 'Before\n```js\ncode\n```\nAfter';
    const result = renderWithCodeHighlighting(text, 80);
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });
});

// ── riskBadge ─────────────────────────────────────────────────────────────────

describe('riskBadge', () => {
  it('returns a string for all risk levels', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      const badge = riskBadge(level);
      expect(typeof badge).toBe('string');
      expect(badge.length).toBeGreaterThan(0);
    }
  });

  it('includes the level name in the badge', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      const badge = riskBadge(level);
      expect(badge.toUpperCase()).toContain(level.toUpperCase());
    }
  });

  it('critical badge contains ANSI red color', () => {
    const badge = riskBadge('critical');
    expect(badge).toContain('\x1B[');
  });

  it('handles unknown risk level with gray color', () => {
    const badge = riskBadge('unknown-level');
    expect(badge).toContain('unknown-level');
    expect(badge).toContain('\x1B[');
  });

  it('returns distinct output for different risk levels', () => {
    const badges = ['critical', 'high', 'medium', 'low'].map(riskBadge);
    // Each badge should be unique
    const unique = new Set(badges);
    expect(unique.size).toBe(4);
  });
});

// ── TuiSpinner ────────────────────────────────────────────────────────────────

describe('TuiSpinner', () => {
  let spinner: TuiSpinner;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spinner = new TuiSpinner();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    spinner.stop();
    writeSpy.mockRestore();
  });

  it('start() begins writing frames', async () => {
    spinner.start();
    await new Promise(r => setTimeout(r, 200));
    spinner.stop();
    expect(writeSpy).toHaveBeenCalled();
    // At least frame writes + one clear from stop()
    expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('start() uses custom label', async () => {
    spinner.start('processing');
    await new Promise(r => setTimeout(r, 100));
    spinner.stop();
    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    expect(writes.some(w => w.includes('processing'))).toBe(true);
  });

  it('start() uses default "thinking" label', async () => {
    spinner.start();
    await new Promise(r => setTimeout(r, 100));
    spinner.stop();
    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    expect(writes.some(w => w.includes('thinking'))).toBe(true);
  });

  it('stop() clears the line', () => {
    spinner.start();
    spinner.stop();
    const lastWrite = String(writeSpy.mock.calls[writeSpy.mock.calls.length - 1]?.[0] ?? '');
    expect(lastWrite).toContain('\r');
    expect(lastWrite).toContain('\x1B[K');
  });

  it('stop() is idempotent', () => {
    spinner.start();
    spinner.stop();
    const callCount = writeSpy.mock.calls.length;
    spinner.stop();
    expect(writeSpy.mock.calls.length).toBe(callCount);
  });

  it('stop() without start() does nothing', () => {
    spinner.stop();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('start() cancels previous indicator', async () => {
    spinner.start('first');
    await new Promise(r => setTimeout(r, 100));
    spinner.start('second');
    await new Promise(r => setTimeout(r, 100));
    spinner.stop();
    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    expect(writes.some(w => w.includes('first'))).toBe(true);
    expect(writes.some(w => w.includes('second'))).toBe(true);
  });

  it('cycles through braille frames', async () => {
    spinner.start();
    await new Promise(r => setTimeout(r, 500));
    spinner.stop();
    const writes = writeSpy.mock.calls.map(c => String(c[0])).filter(w => w.includes('thinking'));
    expect(writes.length).toBeGreaterThan(3);
  });

  it('frames are braille characters', () => {
    const s = new TuiSpinner();
    const frames = (s as unknown as { frames: string[] }).frames;
    expect(frames).toBeDefined();
    expect(frames.length).toBe(10);
    for (const frame of frames) {
      expect(frame.charCodeAt(0)).toBeGreaterThanOrEqual(0x2800);
      expect(frame.charCodeAt(0)).toBeLessThanOrEqual(0x28FF);
    }
    s.stop();
  });
});

// ── StatusBar ─────────────────────────────────────────────────────────────────

describe('StatusBar', () => {
  let statusBar: StatusBar;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statusBar = new StatusBar();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    statusBar.destroy();
    writeSpy.mockRestore();
  });

  it('init() writes ANSI scroll region sequence', () => {
    statusBar.init();
    const writes = writeSpy.mock.calls.map(c => String(c[0]));
    // Should set scroll region
    expect(writes.some(w => w.includes('\x1B[1;'))).toBe(true);
  });

  it('update() writes to stdout', () => {
    statusBar.init();
    writeSpy.mockClear();

    const stats: TuiStats = {
      messageCount: 5,
      startTime: Date.now() - 90000,
      lastResponseMs: 1200,
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      trustTier: 'owner',
      sessionId: '01JXXXXXXXXXXXXXXXXXXXXXXX',
    };

    statusBar.update(stats);
    expect(writeSpy).toHaveBeenCalled();
  });

  it('update() includes message count in output', () => {
    statusBar.init();
    writeSpy.mockClear();

    const stats: TuiStats = {
      messageCount: 7,
      startTime: Date.now(),
      lastResponseMs: 0,
      model: 'test-model',
      provider: 'test',
      trustTier: 'owner',
      sessionId: '01JTEST',
    };

    statusBar.update(stats);
    const writes = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(writes).toContain('7');
  });

  it('update() includes model name', () => {
    statusBar.init();
    writeSpy.mockClear();

    const stats: TuiStats = {
      messageCount: 0,
      startTime: Date.now(),
      lastResponseMs: 0,
      model: 'my-special-model',
      provider: 'test',
      trustTier: 'owner',
      sessionId: '01JTEST',
    };

    statusBar.update(stats);
    const writes = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(writes).toContain('my-special-model');
  });

  it('destroy() clears status line', () => {
    statusBar.init();
    writeSpy.mockClear();
    statusBar.destroy();
    const writes = writeSpy.mock.calls.map(c => String(c[0])).join('');
    // Should contain clear line sequence
    expect(writes).toContain('\x1B[');
  });

  it('destroy() is safe to call multiple times', () => {
    statusBar.init();
    statusBar.destroy();
    expect(() => statusBar.destroy()).not.toThrow();
  });

  it('update() after destroy() does nothing', () => {
    statusBar.init();
    statusBar.destroy();
    writeSpy.mockClear();

    const stats: TuiStats = {
      messageCount: 1,
      startTime: Date.now(),
      lastResponseMs: 0,
      model: 'test',
      provider: 'test',
      trustTier: 'owner',
      sessionId: '01JTEST',
    };

    statusBar.update(stats);
    // After destroy, update should not write anything
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── printTuiHelp ───────────────────────────────────────────────────────────────

describe('printTuiHelp', () => {
  it('outputs help text to stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    printTuiHelp();

    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('ved chat');
    expect(output).toContain('--model');
    expect(output).toContain('--no-rag');
    expect(output).toContain('--no-tools');
    expect(output).toContain('--verbose');
    expect(output).toContain('--simple');
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

// ── TuiStats type ──────────────────────────────────────────────────────────────

describe('TuiStats', () => {
  it('can be initialized with all fields', () => {
    const stats: TuiStats = {
      messageCount: 0,
      startTime: Date.now(),
      lastResponseMs: 0,
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      trustTier: 'owner',
      sessionId: '01JTEST',
    };
    expect(stats.messageCount).toBe(0);
    expect(stats.model).toBe('claude-3-5-sonnet');
    expect(stats.trustTier).toBe('owner');
  });

  it('tracks incrementing message count', () => {
    const stats: TuiStats = {
      messageCount: 0,
      startTime: Date.now(),
      lastResponseMs: 0,
      model: 'test',
      provider: 'test',
      trustTier: 'owner',
      sessionId: '01JTEST',
    };
    stats.messageCount++;
    stats.messageCount++;
    expect(stats.messageCount).toBe(2);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('renderWithCodeHighlighting handles empty string', () => {
    const result = renderWithCodeHighlighting('', 80);
    expect(result).toBe('');
  });

  it('renderWithCodeHighlighting handles very long lines', () => {
    const longLine = 'x'.repeat(500);
    expect(() => renderWithCodeHighlighting(`\`\`\`\n${longLine}\n\`\`\``, 80)).not.toThrow();
  });

  it('riskBadge handles empty string', () => {
    const badge = riskBadge('');
    expect(typeof badge).toBe('string');
  });

  it('parseTuiArgs handles empty array', () => {
    const opts = parseTuiArgs([]);
    expect(opts).toEqual({});
  });

  it('parseTuiArgs handles --simple with other flags', () => {
    const opts = parseTuiArgs(['--simple', '--verbose', '-m', 'test']);
    expect(opts.simple).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.model).toBe('test');
  });
});

// ── formatAgo ─────────────────────────────────────────────────────────────────

describe('formatAgo', () => {
  it('returns seconds for <60s', () => {
    expect(formatAgo(5_000)).toBe('5s ago');
    expect(formatAgo(30_000)).toBe('30s ago');
    expect(formatAgo(59_000)).toBe('59s ago');
  });

  it('returns minutes for <60m', () => {
    expect(formatAgo(60_000)).toBe('1m ago');
    expect(formatAgo(5 * 60_000)).toBe('5m ago');
    expect(formatAgo(59 * 60_000)).toBe('59m ago');
  });

  it('returns hours for <24h', () => {
    expect(formatAgo(60 * 60_000)).toBe('1h ago');
    expect(formatAgo(12 * 60 * 60_000)).toBe('12h ago');
    expect(formatAgo(23 * 60 * 60_000)).toBe('23h ago');
  });

  it('returns days for >=24h', () => {
    expect(formatAgo(24 * 60 * 60_000)).toBe('1d ago');
    expect(formatAgo(7 * 24 * 60 * 60_000)).toBe('7d ago');
    expect(formatAgo(365 * 24 * 60 * 60_000)).toBe('365d ago');
  });

  it('handles zero', () => {
    expect(formatAgo(0)).toBe('0s ago');
  });

  it('handles very small durations', () => {
    expect(formatAgo(500)).toBe('0s ago');
  });
});

// ── showSessionPicker ─────────────────────────────────────────────────────────

describe('showSessionPicker', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('returns null when no resumable sessions exist', async () => {
    const mockApp = {
      listRecentSessions: () => [],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn(),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
    // Should not prompt the user
    expect(mockRl.question).not.toHaveBeenCalled();
  });

  it('returns null when only closed sessions exist', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS001', status: 'closed', lastActive: Date.now(), workingMemory: { messageCount: 0, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn(),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
  });

  it('returns null when user types "n"', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS001ABCDEF', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 3, messages: [{ content: 'hello' }] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('n'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
  });

  it('returns null when user presses enter (empty)', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS001ABCDEF', status: 'idle', lastActive: Date.now() - 60000, workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue(''),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
  });

  it('returns session ID when user picks "1"', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS_FIRST_ONE', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 5, messages: [{ content: 'last message here' }] }, channel: 'chat' },
        { id: 'SESS_SECOND', status: 'idle', lastActive: Date.now() - 3600000, workingMemory: { messageCount: 2, messages: [] }, channel: 'discord' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('1'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBe('SESS_FIRST_ONE');
  });

  it('returns second session when user picks "2"', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'FIRST', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
        { id: 'SECOND', status: 'idle', lastActive: Date.now() - 1000, workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('2'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBe('SECOND');
  });

  it('returns null for out-of-range number', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'ONLY_ONE', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('5'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
  });

  it('returns null for "new" input', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS1', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('new'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
  });

  it('returns null for non-numeric garbage input', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS1', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('xyz'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBeNull();
  });

  it('displays session info including channel and message count', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'SESS_DISPLAY_TEST', status: 'active', lastActive: Date.now() - 120000, workingMemory: { messageCount: 7, messages: [{ content: 'Preview text here' }] }, channel: 'discord' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('n'),
    } as unknown as import('node:readline/promises').Interface;

    await showSessionPicker(mockApp, mockRl);
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Recent Sessions');
    expect(output).toContain('7 msgs');
    expect(output).toContain('discord');
    expect(output).toContain('Preview text here');
  });

  it('skips closed sessions in display', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'ACTIVE_ONE', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
        { id: 'CLOSED_ONE', status: 'closed', lastActive: Date.now() - 1000, workingMemory: { messageCount: 1, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('1'),
    } as unknown as import('node:readline/promises').Interface;

    const result = await showSessionPicker(mockApp, mockRl);
    expect(result).toBe('ACTIVE_ONE');
    // "1" should map to ACTIVE_ONE, not CLOSED_ONE
  });

  it('shows active sessions with green dot', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'ACTIVE_DOT', status: 'active', lastActive: Date.now(), workingMemory: { messageCount: 0, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('n'),
    } as unknown as import('node:readline/promises').Interface;

    await showSessionPicker(mockApp, mockRl);
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('●');
  });

  it('shows idle sessions with yellow circle', async () => {
    const mockApp = {
      listRecentSessions: () => [
        { id: 'IDLE_DOT', status: 'idle', lastActive: Date.now() - 600000, workingMemory: { messageCount: 0, messages: [] }, channel: 'chat' },
      ],
    } as unknown as import('./app.js').VedApp;

    const mockRl = {
      question: vi.fn().mockResolvedValue('n'),
    } as unknown as import('node:readline/promises').Interface;

    await showSessionPicker(mockApp, mockRl);
    const output = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('○');
  });
});
