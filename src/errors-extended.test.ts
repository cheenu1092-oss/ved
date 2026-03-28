import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vedError, errHint, errUsage, dieWithHint, VED_ERRORS } from './errors.js';

describe('VED_ERRORS registry', () => {
  it('has unique error numbers', () => {
    const nums = new Set<string>();
    for (const [key, def] of Object.entries(VED_ERRORS)) {
      expect(nums.has(def.num)).toBe(false);
      nums.add(def.num);
    }
  });

  it('all entries have message and fix', () => {
    for (const [key, def] of Object.entries(VED_ERRORS)) {
      expect(def.message.length).toBeGreaterThan(0);
      expect(def.fix.length).toBeGreaterThan(0);
      expect(def.num).toMatch(/^\d{3}$/);
    }
  });

  it('has the new error codes', () => {
    expect(VED_ERRORS.SYNC_FAILED).toBeDefined();
    expect(VED_ERRORS.TEMPLATE_NOT_FOUND).toBeDefined();
    expect(VED_ERRORS.SNAPSHOT_NOT_FOUND).toBeDefined();
    expect(VED_ERRORS.MIGRATION_FAILED).toBeDefined();
    expect(VED_ERRORS.INVALID_ARGUMENT).toBeDefined();
    expect(VED_ERRORS.MISSING_ARGUMENT).toBeDefined();
    expect(VED_ERRORS.PERMISSION_DENIED).toBeDefined();
    expect(VED_ERRORS.NOT_INITIALIZED).toBeDefined();
    expect(VED_ERRORS.AGENT_NOT_FOUND).toBeDefined();
    expect(VED_ERRORS.HOOK_BLOCKED).toBeDefined();
    expect(VED_ERRORS.ALREADY_EXISTS).toBeDefined();
  });

  it('error numbers are sequential 016-026 for new codes', () => {
    expect(VED_ERRORS.SYNC_FAILED.num).toBe('016');
    expect(VED_ERRORS.ALREADY_EXISTS.num).toBe('026');
  });
});

describe('vedError', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints error code and message', () => {
    vedError('CONFIG_MISSING');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('VED-001'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Config file not found'));
  });

  it('prints fix hint', () => {
    vedError('CONFIG_MISSING');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ved init'));
  });

  it('allows custom message', () => {
    vedError('CONFIG_MISSING', 'Custom msg');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Custom msg'));
  });

  it('allows custom fix', () => {
    vedError('CONFIG_MISSING', undefined, 'Custom fix');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Custom fix'));
  });

  it('handles unknown code gracefully', () => {
    vedError('UNKNOWN_CODE' as any);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('VED-???'));
  });
});

describe('errHint', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints message with red cross', () => {
    errHint('Something failed');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Something failed'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('✗'));
  });

  it('prints hint with arrow', () => {
    errHint('Failed', 'Try again');
    const calls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('→') && c.includes('Try again'))).toBe(true);
  });

  it('skips hint if not provided', () => {
    errHint('Just an error');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});

describe('errUsage', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints usage line', () => {
    errUsage('ved search <query>');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: ved search <query>'));
  });
});

describe('dieWithHint', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints message and hint then exits', () => {
    try {
      dieWithHint('Fatal error', 'Fix it');
    } catch { /* process.exit is mocked */ }
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Fatal error'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Fix it'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
