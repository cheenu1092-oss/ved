import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spinner, withSpinner } from './spinner.js';

describe('spinner', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe('non-TTY mode', () => {
    beforeEach(() => {
      // Force non-TTY
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    });

    it('prints static text on create', () => {
      const s = spinner('Loading...');
      expect(stderrSpy).toHaveBeenCalledWith('  … Loading...\n');
      s.stop();
    });

    it('succeed prints checkmark', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.succeed('Done!');
      expect(stderrSpy).toHaveBeenCalledWith('  ✔ Done!\n');
    });

    it('fail prints cross', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.fail('Failed!');
      expect(stderrSpy).toHaveBeenCalledWith('  ✗ Failed!\n');
    });

    it('warn prints warning', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.warn('Warning!');
      expect(stderrSpy).toHaveBeenCalledWith('  ⚠ Warning!\n');
    });

    it('info prints info', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.info('Info');
      expect(stderrSpy).toHaveBeenCalledWith('  ℹ Info\n');
    });

    it('succeed uses original text if no arg', () => {
      const s = spinner('original');
      stderrSpy.mockClear();
      s.succeed();
      expect(stderrSpy).toHaveBeenCalledWith('  ✔ original\n');
    });

    it('only prints once (idempotent)', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.succeed('Done');
      s.succeed('Done again');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it('isSpinning reflects state', () => {
      const s = spinner('test');
      expect(s.isSpinning).toBe(true);
      s.stop();
      expect(s.isSpinning).toBe(false);
    });

    it('update is a no-op in non-TTY', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.update('new text');
      expect(stderrSpy).not.toHaveBeenCalled();
      s.stop();
    });
  });

  describe('TTY mode', () => {
    beforeEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    });

    it('starts spinning with initial text', () => {
      const s = spinner('Loading...');
      // Should have written at least once with spinner frame
      expect(stderrSpy).toHaveBeenCalled();
      const firstCall = stderrSpy.mock.calls[0]?.[0] as string;
      expect(firstCall).toContain('Loading...');
      s.stop();
    });

    it('succeed clears and prints green checkmark', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.succeed('All done');
      const calls = stderrSpy.mock.calls.map(c => c[0] as string);
      // Should have clear line + final message
      expect(calls.some(c => c.includes('All done'))).toBe(true);
      expect(calls.some(c => c.includes('✔'))).toBe(true);
    });

    it('fail clears and prints red cross', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.fail('Oops');
      const calls = stderrSpy.mock.calls.map(c => c[0] as string);
      expect(calls.some(c => c.includes('Oops'))).toBe(true);
      expect(calls.some(c => c.includes('✗'))).toBe(true);
    });

    it('update changes displayed text', () => {
      const s = spinner('first');
      s.update('second');
      // The next render tick should show 'second'
      s.stop();
    });

    it('stop clears the line', () => {
      const s = spinner('test');
      stderrSpy.mockClear();
      s.stop();
      const calls = stderrSpy.mock.calls.map(c => c[0] as string);
      // Should clear the line
      expect(calls.some(c => c.includes('\x1B[K'))).toBe(true);
    });

    it('isSpinning is true while running, false after stop', () => {
      const s = spinner('test');
      expect(s.isSpinning).toBe(true);
      s.stop();
      expect(s.isSpinning).toBe(false);
    });

    it('double stop is safe', () => {
      const s = spinner('test');
      s.stop();
      s.stop(); // should not throw
    });
  });
});

describe('withSpinner', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  });

  it('returns the function result on success', async () => {
    const result = await withSpinner('test', async () => 42);
    expect(result).toBe(42);
  });

  it('auto-succeeds on completion', async () => {
    await withSpinner('test', async () => 'ok');
    const calls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('✔'))).toBe(true);
  });

  it('auto-fails on error', async () => {
    await expect(
      withSpinner('test', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    const calls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('✗'))).toBe(true);
  });

  it('uses custom success text', async () => {
    await withSpinner('loading', async () => 'ok', { successText: 'Loaded!' });
    const calls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('Loaded!'))).toBe(true);
  });

  it('uses custom fail text', async () => {
    await expect(
      withSpinner('loading', async () => { throw new Error('x'); }, { failText: 'Custom fail' }),
    ).rejects.toThrow();
    const calls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('Custom fail'))).toBe(true);
  });

  it('passes spinner to callback for manual control', async () => {
    await withSpinner('test', async (spin) => {
      spin.update('step 2');
      spin.succeed('manually done');
    });
    const calls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('manually done'))).toBe(true);
  });

  it('does not double-succeed if callback calls succeed', async () => {
    await withSpinner('test', async (spin) => {
      spin.succeed('early');
      return 'result';
    });
    const succeedCalls = stderrSpy.mock.calls
      .map(c => c[0] as string)
      .filter(c => c.includes('✔'));
    expect(succeedCalls.length).toBe(1);
  });
});
