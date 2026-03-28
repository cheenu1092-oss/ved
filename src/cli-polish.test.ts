import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static analysis tests — verify the codebase follows P5 polish standards

describe('P5 Polish — Error Messages', () => {
  let cliSource: string;

  beforeEach(() => {
    cliSource = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
  });

  it('imports errHint and errUsage', () => {
    expect(cliSource).toContain("import { vedError, errHint, errUsage } from './errors.js'");
  });

  it('imports spinner', () => {
    expect(cliSource).toContain("import { spinner } from './spinner.js'");
  });

  it('uses vedError for critical failures', () => {
    // These specific patterns should use vedError, not raw console.error
    const criticalPatterns = [
      'vedError(\'CONFIG_MISSING\'',
      'vedError(\'CONFIG_INVALID\'',
      'vedError(\'NOT_INITIALIZED\'',
      'vedError(\'BACKUP_FAILED\'',
      'vedError(\'EXPORT_FAILED\'',
      'vedError(\'IMPORT_FAILED\'',
      'vedError(\'RAG_STALE\'',
      'vedError(\'DB_CORRUPT\'',
    ];
    for (const pattern of criticalPatterns) {
      expect(cliSource).toContain(pattern);
    }
  });

  it('uses errHint for user-facing validation errors', () => {
    expect(cliSource).toContain('errHint(');
    // Should have at least 5 errHint calls (we added many)
    const hintCount = (cliSource.match(/errHint\(/g) || []).length;
    expect(hintCount).toBeGreaterThanOrEqual(5);
  });

  it('uses errUsage for usage help', () => {
    expect(cliSource).toContain('errUsage(');
    const usageCount = (cliSource.match(/errUsage\(/g) || []).length;
    expect(usageCount).toBeGreaterThanOrEqual(3);
  });

  it('uses spinner for long-running operations', () => {
    // Reindex, backup, and doctor should all use spinners
    expect(cliSource).toContain("spinner('Indexing vault files...')");
    expect(cliSource).toContain("spinner('Creating backup...')");
    expect(cliSource).toContain("spinner('Running diagnostics...')");
  });

  it('auto-installs completions during ved init', () => {
    // The init function should call installCompletions
    const initFn = cliSource.slice(
      cliSource.indexOf('async function init('),
      cliSource.indexOf('async function init(') + 800,
    );
    expect(initFn).toContain('installCompletions');
    expect(initFn).toContain('detectShell');
  });

  it('does not use raw "Error: " prefix for upgraded messages', () => {
    // Count remaining raw Error: patterns — should be decreasing
    const rawErrorCount = (cliSource.match(/console\.error\(`Error: /g) || []).length;
    // We still have some in less critical paths — but should be under 20
    expect(rawErrorCount).toBeLessThanOrEqual(20);
  });
});

describe('P5 Polish — Error Registry', () => {
  it('has at least 26 error codes', async () => {
    const { VED_ERRORS } = await import('./errors.js');
    expect(Object.keys(VED_ERRORS).length).toBeGreaterThanOrEqual(26);
  });

  it('every error has a fix hint', async () => {
    const { VED_ERRORS } = await import('./errors.js');
    for (const [code, def] of Object.entries(VED_ERRORS)) {
      expect(def.fix, `${code} missing fix`).toBeTruthy();
      expect(def.fix.length, `${code} has empty fix`).toBeGreaterThan(5);
    }
  });
});

describe('P5 Polish — Spinner Module', () => {
  it('exports spinner and withSpinner', async () => {
    const mod = await import('./spinner.js');
    expect(typeof mod.spinner).toBe('function');
    expect(typeof mod.withSpinner).toBe('function');
  });

  it('spinner has standard methods', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

    const { spinner } = await import('./spinner.js');
    const s = spinner('test');
    expect(typeof s.update).toBe('function');
    expect(typeof s.succeed).toBe('function');
    expect(typeof s.fail).toBe('function');
    expect(typeof s.warn).toBe('function');
    expect(typeof s.info).toBe('function');
    expect(typeof s.stop).toBe('function');
    expect(typeof s.isSpinning).toBe('boolean');
    s.stop();

    stderrSpy.mockRestore();
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  });
});

describe('P5 Polish — First-Run Experience', () => {
  it('cli.ts has first-run welcome when no config exists', () => {
    const cliSource = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
    expect(cliSource).toContain('Welcome to Ved');
    expect(cliSource).toContain('ved init');
    expect(cliSource).toContain('first time');
  });
});
