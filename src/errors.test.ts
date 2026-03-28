/**
 * Tests for src/errors.ts — actionable error message utility.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { VED_ERRORS, vedError, type VedErrorCode } from './errors.js';

// ── VED_ERRORS registry ──────────────────────────────────────────────────────

describe('VED_ERRORS registry', () => {
  it('exports all expected error codes', () => {
    const expectedCodes: VedErrorCode[] = [
      'CONFIG_MISSING',
      'CONFIG_INVALID',
      'DB_CORRUPT',
      'VAULT_MISSING',
      'LLM_UNREACHABLE',
      'AUTH_FAILED',
      'COMMAND_NOT_FOUND',
      'INIT_REQUIRED',
      'RAG_STALE',
      'HOOK_FAILED',
      'BACKUP_FAILED',
      'IMPORT_FAILED',
      'EXPORT_FAILED',
      'SESSION_NOT_FOUND',
      'CRON_INVALID',
    ];
    for (const code of expectedCodes) {
      expect(VED_ERRORS).toHaveProperty(code);
    }
  });

  it('every entry has a non-empty num, message, and fix', () => {
    for (const [code, def] of Object.entries(VED_ERRORS)) {
      expect(def.num, `${code}.num`).toMatch(/^\d{3}$/);
      expect(def.message, `${code}.message`).toBeTruthy();
      expect(def.fix, `${code}.fix`).toBeTruthy();
    }
  });

  it('has no duplicate nums', () => {
    const nums = Object.values(VED_ERRORS).map(d => d.num);
    const unique = new Set(nums);
    expect(unique.size).toBe(nums.length);
  });

  it('CONFIG_MISSING is VED-001', () => {
    expect(VED_ERRORS.CONFIG_MISSING.num).toBe('001');
  });

  it('COMMAND_NOT_FOUND is VED-007', () => {
    expect(VED_ERRORS.COMMAND_NOT_FOUND.num).toBe('007');
  });
});

// ── vedError() function ───────────────────────────────────────────────────────

describe('vedError()', () => {
  const errors: string[] = [];
  const origError = console.error;

  afterEach(() => {
    console.error = origError;
    errors.length = 0;
  });

  function captureErrors() {
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  }

  it('prints formatted error with code number', () => {
    captureErrors();
    vedError('CONFIG_MISSING');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toContain('[VED-001]');
    expect(errors[0]).toContain('Config file not found');
    expect(errors[0]).toContain('❌');
  });

  it('prints Fix line on second line', () => {
    captureErrors();
    vedError('CONFIG_MISSING');
    expect(errors.length).toBe(2);
    expect(errors[1]).toContain('Fix:');
    expect(errors[1]).toContain('ved init');
  });

  it('uses customMessage when provided', () => {
    captureErrors();
    vedError('CONFIG_MISSING', 'my custom message');
    expect(errors[0]).toContain('my custom message');
    expect(errors[0]).not.toContain('Config file not found');
  });

  it('uses customFix when provided', () => {
    captureErrors();
    vedError('CONFIG_MISSING', undefined, 'my custom fix');
    expect(errors[1]).toContain('my custom fix');
  });

  it('handles unknown code gracefully (uses ??? as num)', () => {
    captureErrors();
    vedError('TOTALLY_UNKNOWN_CODE' as VedErrorCode);
    expect(errors[0]).toContain('[VED-???]');
    expect(errors[0]).toContain('TOTALLY_UNKNOWN_CODE');
  });

  it('does not print Fix line when fix is empty for unknown code', () => {
    captureErrors();
    vedError('TOTALLY_UNKNOWN_CODE' as VedErrorCode, 'msg', '');
    // Only the error line, no Fix line when fix is empty
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('msg');
  });

  it('includes [VED-NNN] prefix for all known codes', () => {
    captureErrors();
    for (const code of Object.keys(VED_ERRORS) as VedErrorCode[]) {
      errors.length = 0;
      vedError(code);
      expect(errors[0]).toMatch(/\[VED-\d{3}\]/);
    }
  });

  it('COMMAND_NOT_FOUND suggests ved help', () => {
    captureErrors();
    vedError('COMMAND_NOT_FOUND');
    expect(errors[1]).toContain('ved help');
  });

  it('VAULT_MISSING suggests ved doctor --fix', () => {
    captureErrors();
    vedError('VAULT_MISSING');
    expect(errors[1]).toContain('ved doctor --fix');
  });

  it('INIT_REQUIRED suggests ved init', () => {
    captureErrors();
    vedError('INIT_REQUIRED');
    expect(errors[1]).toContain('ved init');
  });
});
