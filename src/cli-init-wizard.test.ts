/**
 * Tests for cli-init-wizard.ts — Interactive setup wizard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PROVIDERS,
  TRUST_MODES,
  validateApiKey,
  validateVaultPath,
  validateOwnerId,
  generateConfigYaml,
  generateLocalConfigYaml,
  createVaultStructure,
  writeConfigs,
  parseInitArgs,
  getEditorCommand,
  printBanner,
  printSuccess,
  askQuestion,
  askChoice,
  askYesNo,
  askSecret,
  type WizardAnswers,
} from './cli-init-wizard.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ved-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultAnswers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: null,
    baseUrl: null,
    vaultPath: '~/ved-vault',
    trustMode: 'gate-writes',
    ownerId: 'owner-123',
    enableDiscord: false,
    discordToken: null,
    ...overrides,
  };
}

function mockReadline(answers: string[]) {
  let idx = 0;
  return {
    question: (_prompt: string, cb: (answer: string) => void) => {
      cb(answers[idx++] ?? '');
    },
    close: vi.fn(),
  } as any;
}

// ── PROVIDERS metadata ────────────────────────────────────────────────────────

describe('PROVIDERS', () => {
  it('has all 4 providers', () => {
    expect(Object.keys(PROVIDERS)).toEqual(['anthropic', 'openai', 'ollama', 'openrouter']);
  });

  it('each provider has required fields', () => {
    for (const [key, info] of Object.entries(PROVIDERS)) {
      expect(info.name).toBeTruthy();
      expect(info.defaultModel).toBeTruthy();
      expect(info.models.length).toBeGreaterThan(0);
      expect(typeof info.needsApiKey).toBe('boolean');
      if (key !== 'ollama') {
        expect(info.apiKeyEnvVar).toBeTruthy();
        expect(info.apiKeyHint).toBeTruthy();
      }
    }
  });

  it('ollama does not need API key', () => {
    expect(PROVIDERS.ollama!.needsApiKey).toBe(false);
    expect(PROVIDERS.ollama!.defaultBaseUrl).toBe('http://localhost:11434');
  });

  it('anthropic needs API key', () => {
    expect(PROVIDERS.anthropic!.needsApiKey).toBe(true);
  });
});

// ── TRUST_MODES metadata ──────────────────────────────────────────────────────

describe('TRUST_MODES', () => {
  it('has all 3 modes', () => {
    expect(Object.keys(TRUST_MODES)).toEqual(['audit', 'gate-writes', 'gate-all']);
  });

  it('each mode has name, description, detail', () => {
    for (const info of Object.values(TRUST_MODES)) {
      expect(info.name).toBeTruthy();
      expect(info.description).toBeTruthy();
      expect(info.detail).toBeTruthy();
    }
  });
});

// ── validateApiKey ────────────────────────────────────────────────────────────

describe('validateApiKey', () => {
  it('rejects empty key', () => {
    const r = validateApiKey('anthropic', '');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('required');
  });

  it('validates anthropic prefix', () => {
    expect(validateApiKey('anthropic', 'sk-ant-abcdef1234567890abc').valid).toBe(true);
    expect(validateApiKey('anthropic', 'sk-wrong').valid).toBe(false);
  });

  it('rejects short anthropic key', () => {
    expect(validateApiKey('anthropic', 'sk-ant-abc').valid).toBe(false);
  });

  it('validates openai prefix', () => {
    expect(validateApiKey('openai', 'sk-abcdef').valid).toBe(true);
    expect(validateApiKey('openai', 'wrong').valid).toBe(false);
  });

  it('validates openrouter prefix', () => {
    expect(validateApiKey('openrouter', 'sk-or-abcdef').valid).toBe(true);
    expect(validateApiKey('openrouter', 'wrong').valid).toBe(false);
  });

  it('accepts any key for ollama', () => {
    expect(validateApiKey('ollama', 'anything').valid).toBe(true);
  });

  it('accepts any key for unknown provider', () => {
    expect(validateApiKey('custom', 'whatever').valid).toBe(true);
  });
});

// ── validateVaultPath ─────────────────────────────────────────────────────────

describe('validateVaultPath', () => {
  it('rejects empty path', () => {
    const r = validateVaultPath('');
    expect(r.valid).toBe(false);
  });

  it('accepts home-relative path', () => {
    expect(validateVaultPath('~/ved-vault').valid).toBe(true);
  });

  it('accepts absolute path with existing parent', () => {
    expect(validateVaultPath('/tmp/ved-test-vault').valid).toBe(true);
  });

  it('rejects path with nonexistent parent', () => {
    const r = validateVaultPath('/nonexistent-parent-xyz/subdir/vault');
    expect(r.valid).toBe(false);
    expect(r.error).toContain("doesn't exist");
  });
});

// ── validateOwnerId ───────────────────────────────────────────────────────────

describe('validateOwnerId', () => {
  it('rejects empty', () => {
    expect(validateOwnerId('').valid).toBe(false);
  });

  it('rejects too short', () => {
    expect(validateOwnerId('ab').valid).toBe(false);
  });

  it('accepts valid ID', () => {
    expect(validateOwnerId('user-12345').valid).toBe(true);
  });

  it('accepts Discord snowflake', () => {
    expect(validateOwnerId('719990816659210360').valid).toBe(true);
  });
});

// ── generateConfigYaml ───────────────────────────────────────────────────────

describe('generateConfigYaml', () => {
  it('includes provider and model', () => {
    const yaml = generateConfigYaml(defaultAnswers());
    expect(yaml).toContain('provider: anthropic');
    expect(yaml).toContain('model: claude-sonnet-4-20250514');
  });

  it('includes vault path', () => {
    const yaml = generateConfigYaml(defaultAnswers({ vaultPath: '~/my-vault' }));
    expect(yaml).toContain('vaultPath: ~/my-vault');
  });

  it('includes owner ID', () => {
    const yaml = generateConfigYaml(defaultAnswers({ ownerId: 'test-owner' }));
    expect(yaml).toContain('"test-owner"');
  });

  it('includes base URL when set', () => {
    const yaml = generateConfigYaml(defaultAnswers({ baseUrl: 'http://localhost:11434' }));
    expect(yaml).toContain('baseUrl: http://localhost:11434');
  });

  it('omits base URL when null', () => {
    const yaml = generateConfigYaml(defaultAnswers({ baseUrl: null }));
    expect(yaml).not.toContain('baseUrl:');
  });

  it('configures audit trust mode', () => {
    const yaml = generateConfigYaml(defaultAnswers({ trustMode: 'audit' }));
    expect(yaml).toContain('defaultTier: 4');
  });

  it('configures gate-writes trust mode', () => {
    const yaml = generateConfigYaml(defaultAnswers({ trustMode: 'gate-writes' }));
    expect(yaml).toContain('defaultTier: 2');
  });

  it('configures gate-all trust mode', () => {
    const yaml = generateConfigYaml(defaultAnswers({ trustMode: 'gate-all' }));
    expect(yaml).toContain('defaultTier: 1');
  });

  it('includes Discord channel when enabled', () => {
    const yaml = generateConfigYaml(defaultAnswers({ enableDiscord: true }));
    expect(yaml).toContain('type: discord');
  });

  it('excludes Discord when disabled', () => {
    const yaml = generateConfigYaml(defaultAnswers({ enableDiscord: false }));
    expect(yaml).not.toContain('type: discord');
  });

  it('always includes CLI channel', () => {
    const yaml = generateConfigYaml(defaultAnswers());
    expect(yaml).toContain('type: cli');
  });

  it('includes generation date', () => {
    const yaml = generateConfigYaml(defaultAnswers());
    expect(yaml).toContain('Generated by');
  });
});

// ── generateLocalConfigYaml ───────────────────────────────────────────────────

describe('generateLocalConfigYaml', () => {
  it('includes API key when provided', () => {
    const yaml = generateLocalConfigYaml(defaultAnswers({ apiKey: 'sk-ant-test123' }));
    expect(yaml).toContain('apiKey: sk-ant-test123');
  });

  it('includes commented hint when no key', () => {
    const yaml = generateLocalConfigYaml(defaultAnswers({ apiKey: null }));
    expect(yaml).toContain('# apiKey: sk-ant-');
    expect(yaml).toContain('ANTHROPIC_API_KEY');
  });

  it('no LLM section for ollama with no key', () => {
    const yaml = generateLocalConfigYaml(defaultAnswers({ provider: 'ollama', apiKey: null }));
    expect(yaml).not.toContain('apiKey');
  });

  it('includes Discord token when provided', () => {
    const yaml = generateLocalConfigYaml(defaultAnswers({ discordToken: 'bot-token-123' }));
    expect(yaml).toContain('token: bot-token-123');
  });

  it('no Discord section when no token', () => {
    const yaml = generateLocalConfigYaml(defaultAnswers({ discordToken: null }));
    expect(yaml).not.toContain('token:');
  });
});

// ── createVaultStructure ──────────────────────────────────────────────────────

describe('createVaultStructure', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates vault with all subdirectories', () => {
    const vaultPath = join(tmpDir, 'test-vault');
    const result = createVaultStructure(vaultPath);

    expect(result.created).toBe(true);
    expect(existsSync(join(vaultPath, 'daily'))).toBe(true);
    expect(existsSync(join(vaultPath, 'entities'))).toBe(true);
    expect(existsSync(join(vaultPath, 'concepts'))).toBe(true);
    expect(existsSync(join(vaultPath, 'decisions'))).toBe(true);
  });

  it('creates README.md', () => {
    const vaultPath = join(tmpDir, 'test-vault');
    createVaultStructure(vaultPath);

    const readme = readFileSync(join(vaultPath, 'README.md'), 'utf-8');
    expect(readme).toContain('Ved Vault');
    expect(readme).toContain('Obsidian');
  });

  it('is idempotent', () => {
    const vaultPath = join(tmpDir, 'test-vault');
    createVaultStructure(vaultPath);
    const result2 = createVaultStructure(vaultPath);

    // Second call should not re-create (dirs already exist)
    expect(result2.created).toBe(false);
  });
});

// ── writeConfigs ──────────────────────────────────────────────────────────────

describe('writeConfigs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates config.yaml and config.local.yaml', () => {
    const configDir = join(tmpDir, '.ved');
    const answers = defaultAnswers({ vaultPath: join(tmpDir, 'vault') });
    writeConfigs(configDir, answers);

    expect(existsSync(join(configDir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(configDir, 'config.local.yaml'))).toBe(true);
  });

  it('config.yaml has correct content', () => {
    const configDir = join(tmpDir, '.ved');
    const answers = defaultAnswers({ vaultPath: join(tmpDir, 'vault'), ownerId: 'test-owner-42' });
    writeConfigs(configDir, answers);

    const yaml = readFileSync(join(configDir, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('provider: anthropic');
    expect(yaml).toContain('"test-owner-42"');
  });

  it('creates vault directory structure', () => {
    const configDir = join(tmpDir, '.ved');
    const vaultPath = join(tmpDir, 'vault');
    writeConfigs(configDir, defaultAnswers({ vaultPath }));

    expect(existsSync(join(vaultPath, 'daily'))).toBe(true);
    expect(existsSync(join(vaultPath, 'entities'))).toBe(true);
  });

  it('handles API key in local config', () => {
    const configDir = join(tmpDir, '.ved');
    const answers = defaultAnswers({ apiKey: 'sk-ant-secret', vaultPath: join(tmpDir, 'vault') });
    writeConfigs(configDir, answers);

    const local = readFileSync(join(configDir, 'config.local.yaml'), 'utf-8');
    expect(local).toContain('sk-ant-secret');

    // Main config should NOT contain the key
    const main = readFileSync(join(configDir, 'config.yaml'), 'utf-8');
    expect(main).not.toContain('sk-ant-secret');
  });
});

// ── parseInitArgs ─────────────────────────────────────────────────────────────

describe('parseInitArgs', () => {
  it('parses empty args', () => {
    const opts = parseInitArgs([]);
    expect(opts.force).toBeUndefined();
    expect(opts.nonInteractive).toBeUndefined();
  });

  it('parses --force', () => {
    expect(parseInitArgs(['--force']).force).toBe(true);
    expect(parseInitArgs(['-f']).force).toBe(true);
  });

  it('parses --non-interactive', () => {
    expect(parseInitArgs(['--non-interactive']).nonInteractive).toBe(true);
    expect(parseInitArgs(['--yes']).nonInteractive).toBe(true);
    expect(parseInitArgs(['-y']).nonInteractive).toBe(true);
  });

  it('parses combined flags', () => {
    const opts = parseInitArgs(['--force', '--yes']);
    expect(opts.force).toBe(true);
    expect(opts.nonInteractive).toBe(true);
  });
});

// ── getEditorCommand ──────────────────────────────────────────────────────────

describe('getEditorCommand', () => {
  const origVisual = process.env.VISUAL;
  const origEditor = process.env.EDITOR;

  afterEach(() => {
    if (origVisual !== undefined) process.env.VISUAL = origVisual;
    else delete process.env.VISUAL;
    if (origEditor !== undefined) process.env.EDITOR = origEditor;
    else delete process.env.EDITOR;
  });

  it('prefers VISUAL', () => {
    process.env.VISUAL = 'code';
    process.env.EDITOR = 'vim';
    expect(getEditorCommand()).toBe('code');
  });

  it('falls back to EDITOR', () => {
    delete process.env.VISUAL;
    process.env.EDITOR = 'nano';
    expect(getEditorCommand()).toBe('nano');
  });

  it('defaults to vi', () => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    expect(getEditorCommand()).toBe('vi');
  });
});

// ── askQuestion ───────────────────────────────────────────────────────────────

describe('askQuestion', () => {
  it('returns user input', async () => {
    const rl = mockReadline(['my answer']);
    const result = await askQuestion(rl, 'Question');
    expect(result).toBe('my answer');
  });

  it('returns default on empty input', async () => {
    const rl = mockReadline(['']);
    const result = await askQuestion(rl, 'Question', 'default-val');
    expect(result).toBe('default-val');
  });

  it('trims whitespace', async () => {
    const rl = mockReadline(['  spaced  ']);
    const result = await askQuestion(rl, 'Question');
    expect(result).toBe('spaced');
  });
});

// ── askChoice ─────────────────────────────────────────────────────────────────

describe('askChoice', () => {
  it('returns selected index', async () => {
    const rl = mockReadline(['2']);
    const result = await askChoice(rl, 'Pick one', [
      { label: 'A' }, { label: 'B' }, { label: 'C' },
    ], 0);
    expect(result).toBe(1); // 0-based
  });

  it('returns default on empty input', async () => {
    const rl = mockReadline(['']);
    const result = await askChoice(rl, 'Pick one', [
      { label: 'A' }, { label: 'B' },
    ], 1);
    expect(result).toBe(1);
  });

  it('returns default on invalid input', async () => {
    const rl = mockReadline(['99']);
    const result = await askChoice(rl, 'Pick one', [
      { label: 'A' }, { label: 'B' },
    ], 0);
    expect(result).toBe(0);
  });

  it('returns default on non-numeric input', async () => {
    const rl = mockReadline(['abc']);
    const result = await askChoice(rl, 'Pick', [{ label: 'A' }], 0);
    expect(result).toBe(0);
  });
});

// ── askYesNo ──────────────────────────────────────────────────────────────────

describe('askYesNo', () => {
  it('returns true on "y"', async () => {
    const rl = mockReadline(['y']);
    expect(await askYesNo(rl, 'Q')).toBe(true);
  });

  it('returns true on "yes"', async () => {
    const rl = mockReadline(['yes']);
    expect(await askYesNo(rl, 'Q')).toBe(true);
  });

  it('returns false on "n"', async () => {
    const rl = mockReadline(['n']);
    expect(await askYesNo(rl, 'Q')).toBe(false);
  });

  it('returns default on empty', async () => {
    const rl1 = mockReadline(['']);
    expect(await askYesNo(rl1, 'Q', true)).toBe(true);
    const rl2 = mockReadline(['']);
    expect(await askYesNo(rl2, 'Q', false)).toBe(false);
  });

  it('case insensitive', async () => {
    const rl = mockReadline(['YES']);
    expect(await askYesNo(rl, 'Q')).toBe(true);
  });
});

// ── askSecret ─────────────────────────────────────────────────────────────────

describe('askSecret', () => {
  it('returns trimmed input', async () => {
    const rl = mockReadline(['  sk-ant-123  ']);
    expect(await askSecret(rl, 'Key')).toBe('sk-ant-123');
  });

  it('returns empty on empty input', async () => {
    const rl = mockReadline(['']);
    expect(await askSecret(rl, 'Key')).toBe('');
  });
});

// ── printBanner ───────────────────────────────────────────────────────────────

describe('printBanner', () => {
  it('prints without throwing', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printBanner();
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).toContain('Ved');
    expect(output).toContain('Setup Wizard');
  });
});

// ── printSuccess ──────────────────────────────────────────────────────────────

describe('printSuccess', () => {
  it('shows config paths', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printSuccess('/home/user/.ved', defaultAnswers());
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).toContain('config.yaml');
    expect(output).toContain('config.local.yaml');
    expect(output).toContain('initialized successfully');
  });

  it('shows API key warning when no key', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printSuccess('/home/user/.ved', defaultAnswers({ apiKey: null }));
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).toContain("Don't forget");
    expect(output).toContain('API key');
  });

  it('no API key warning when key present', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printSuccess('/home/user/.ved', defaultAnswers({ apiKey: 'sk-ant-123abc' }));
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).not.toContain("Don't forget");
  });

  it('no API key warning for ollama', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printSuccess('/home/user/.ved', defaultAnswers({ provider: 'ollama', apiKey: null }));
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).not.toContain("Don't forget");
  });

  it('shows trust mode', () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    printSuccess('/home/user/.ved', defaultAnswers({ trustMode: 'gate-all' }));
    process.stdout.write = orig;
    const output = writes.join('');
    expect(output).toContain('Gate All');
  });
});

// ── Config edit wiring ────────────────────────────────────────────────────────

describe('config edit integration', () => {
  it('PROVIDERS models include default model', () => {
    for (const info of Object.values(PROVIDERS)) {
      expect(info.models).toContain(info.defaultModel);
    }
  });

  it('generateConfigYaml produces valid YAML-like structure', () => {
    const yaml = generateConfigYaml(defaultAnswers());
    // Check key structural elements
    expect(yaml).toContain('llm:');
    expect(yaml).toContain('memory:');
    expect(yaml).toContain('trust:');
    expect(yaml).toContain('channels:');
    expect(yaml).toContain('mcp:');
  });

  it('all trust modes produce different tiers', () => {
    const tiers = new Set<string>();
    for (const mode of ['audit', 'gate-writes', 'gate-all'] as const) {
      const yaml = generateConfigYaml(defaultAnswers({ trustMode: mode }));
      const match = yaml.match(/defaultTier: (\d)/);
      expect(match).toBeTruthy();
      tiers.add(match![1]!);
    }
    expect(tiers.size).toBe(3); // All different
  });

  it('openrouter includes baseUrl', () => {
    const yaml = generateConfigYaml(defaultAnswers({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-20250514',
      baseUrl: 'https://openrouter.ai/api/v1',
    }));
    expect(yaml).toContain('baseUrl: https://openrouter.ai/api/v1');
  });
});
