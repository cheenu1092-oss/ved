/**
 * `ved init` — Interactive setup wizard.
 *
 * Guides new users through:
 * 1. Choose LLM provider (Anthropic/OpenAI/Ollama/OpenRouter)
 * 2. Enter API key (with validation)
 * 3. Choose vault location
 * 4. Choose trust mode (audit/gate-writes/gate-all)
 * 5. Generate config.yaml + config.local.yaml
 *
 * Falls back to non-interactive mode when stdin is not a TTY.
 */

import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  cyan: '\x1B[36m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  red: '\x1B[31m',
  magenta: '\x1B[35m',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WizardAnswers {
  provider: 'anthropic' | 'openai' | 'ollama' | 'openrouter';
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  vaultPath: string;
  trustMode: 'audit' | 'gate-writes' | 'gate-all';
  ownerId: string;
  enableDiscord: boolean;
  discordToken: string | null;
}

export interface InitWizardOptions {
  force?: boolean;
  nonInteractive?: boolean;
}

// ── Provider metadata ─────────────────────────────────────────────────────────

export interface ProviderInfo {
  name: string;
  description: string;
  defaultModel: string;
  models: string[];
  needsApiKey: boolean;
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string;
  apiKeyHint: string;
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: {
    name: 'Anthropic',
    description: 'Claude models (recommended)',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-20250314'],
    needsApiKey: true,
    defaultBaseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    apiKeyHint: 'sk-ant-...',
  },
  openai: {
    name: 'OpenAI',
    description: 'GPT models',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini'],
    needsApiKey: true,
    defaultBaseUrl: null,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    apiKeyHint: 'sk-...',
  },
  ollama: {
    name: 'Ollama',
    description: 'Local models (free, private)',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'mistral', 'qwen3:1.7b', 'phi4', 'deepseek-r1'],
    needsApiKey: false,
    defaultBaseUrl: 'http://localhost:11434',
    apiKeyEnvVar: '',
    apiKeyHint: '',
  },
  openrouter: {
    name: 'OpenRouter',
    description: 'Multi-model gateway',
    defaultModel: 'anthropic/claude-sonnet-4-20250514',
    models: ['anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o', 'google/gemini-2.5-flash'],
    needsApiKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    apiKeyHint: 'sk-or-...',
  },
};

// ── Trust mode metadata ───────────────────────────────────────────────────────

export interface TrustModeInfo {
  name: string;
  description: string;
  detail: string;
}

export const TRUST_MODES: Record<string, TrustModeInfo> = {
  'audit': {
    name: 'Audit Only',
    description: 'Log everything, block nothing',
    detail: 'All tool calls execute immediately. Full audit trail. Good for trusted environments.',
  },
  'gate-writes': {
    name: 'Gate Writes',
    description: 'Approve file writes, auto-allow reads',
    detail: 'Read operations run automatically. Write/delete/exec operations require your approval.',
  },
  'gate-all': {
    name: 'Gate All',
    description: 'Approve every tool call',
    detail: 'Every MCP tool call requires explicit approval. Maximum security, more friction.',
  },
};

// ── Prompt helpers ────────────────────────────────────────────────────────────

/**
 * Ask a question and return the answer. Returns default if empty input.
 */
export function askQuestion(
  rl: readline.Interface,
  question: string,
  defaultVal?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultVal
      ? `${question} ${C.dim}(${defaultVal})${C.reset}: `
      : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

/**
 * Ask a multiple-choice question. Returns selected index (0-based).
 */
export function askChoice(
  rl: readline.Interface,
  question: string,
  choices: { label: string; description?: string }[],
  defaultIndex: number = 0,
): Promise<number> {
  return new Promise((resolve) => {
    stdout.write(`\n${question}\n\n`);
    for (let i = 0; i < choices.length; i++) {
      const marker = i === defaultIndex ? `${C.cyan}❯${C.reset}` : ' ';
      const num = `${C.bold}${i + 1}${C.reset}`;
      const desc = choices[i]!.description ? `  ${C.dim}${choices[i]!.description}${C.reset}` : '';
      stdout.write(`  ${marker} ${num}) ${choices[i]!.label}${desc}\n`);
    }
    stdout.write('\n');

    rl.question(`${C.dim}Choose [1-${choices.length}]${C.reset} ${C.dim}(${defaultIndex + 1})${C.reset}: `, (answer) => {
      const val = answer.trim();
      if (!val) {
        resolve(defaultIndex);
        return;
      }
      const num = parseInt(val, 10);
      if (num >= 1 && num <= choices.length) {
        resolve(num - 1);
      } else {
        resolve(defaultIndex);
      }
    });
  });
}

/**
 * Ask yes/no. Returns boolean.
 */
export function askYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    rl.question(`${question} ${C.dim}(${hint})${C.reset}: `, (answer) => {
      const val = answer.trim().toLowerCase();
      if (!val) {
        resolve(defaultYes);
        return;
      }
      resolve(val === 'y' || val === 'yes');
    });
  });
}

/**
 * Ask for a secret (API key). Masks input with asterisks.
 * Falls back to normal input if stdin is not a TTY.
 */
export function askSecret(
  rl: readline.Interface,
  question: string,
  hint?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const hintStr = hint ? ` ${C.dim}(${hint})${C.reset}` : '';
    rl.question(`${question}${hintStr}: `, (answer) => {
      resolve(answer.trim());
    });
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateApiKey(provider: string, key: string): { valid: boolean; error?: string } {
  if (!key) return { valid: false, error: 'API key is required' };

  switch (provider) {
    case 'anthropic':
      if (!key.startsWith('sk-ant-')) {
        return { valid: false, error: 'Anthropic keys start with sk-ant-' };
      }
      if (key.length < 20) {
        return { valid: false, error: 'Key seems too short' };
      }
      return { valid: true };

    case 'openai':
      if (!key.startsWith('sk-')) {
        return { valid: false, error: 'OpenAI keys start with sk-' };
      }
      return { valid: true };

    case 'openrouter':
      if (!key.startsWith('sk-or-')) {
        return { valid: false, error: 'OpenRouter keys start with sk-or-' };
      }
      return { valid: true };

    default:
      return { valid: true };
  }
}

export function validateVaultPath(path: string): { valid: boolean; error?: string } {
  if (!path) return { valid: false, error: 'Vault path is required' };

  const expanded = path.replace(/^~/, homedir());

  // Check parent exists
  const parent = expanded.split('/').slice(0, -1).join('/');
  if (parent && !existsSync(parent)) {
    return { valid: false, error: `Parent directory doesn't exist: ${parent}` };
  }

  return { valid: true };
}

export function validateOwnerId(id: string): { valid: boolean; error?: string } {
  if (!id) return { valid: false, error: 'Owner ID is required for trust management' };
  if (id.length < 3) return { valid: false, error: 'ID seems too short' };
  return { valid: true };
}

// ── Config generation ─────────────────────────────────────────────────────────

export function generateConfigYaml(answers: WizardAnswers): string {
  const lines: string[] = [
    '# Ved Configuration',
    `# Generated by \`ved init\` on ${new Date().toISOString().slice(0, 10)}`,
    '# Docs: https://github.com/cheenu1092-oss/ved',
    '',
    '# LLM provider',
    'llm:',
    `  provider: ${answers.provider}`,
    `  model: ${answers.model}`,
    '  # API key goes in config.local.yaml (not committed to git)',
  ];

  if (answers.baseUrl) {
    lines.push(`  baseUrl: ${answers.baseUrl}`);
  }

  lines.push(
    '',
    '# Memory / Obsidian vault',
    'memory:',
    `  vaultPath: ${answers.vaultPath}`,
    '  gitEnabled: true',
    '',
    '# Trust & approvals',
    'trust:',
    '  ownerIds:',
    `    - "${answers.ownerId}"`,
  );

  // Trust mode configuration
  switch (answers.trustMode) {
    case 'audit':
      lines.push(
        '  # Audit mode: log everything, auto-approve all',
        '  defaultTier: 4  # owner-level auto-approval',
      );
      break;
    case 'gate-writes':
      lines.push(
        '  # Gate-writes: reads auto, writes need approval',
        '  defaultTier: 2  # read-only auto-approval',
      );
      break;
    case 'gate-all':
      lines.push(
        '  # Gate-all: every tool call needs approval',
        '  defaultTier: 1  # all tool calls gated',
      );
      break;
  }

  lines.push(
    '',
    '# Channels',
    'channels:',
    '  - type: cli',
    '    enabled: true',
    '    config: {}',
  );

  if (answers.enableDiscord) {
    lines.push(
      '  - type: discord',
      '    enabled: true',
      '    config: {}',
      '    # token goes in config.local.yaml',
    );
  }

  lines.push(
    '',
    '# MCP tool servers',
    'mcp:',
    '  servers: []',
    '',
  );

  return lines.join('\n');
}

export function generateLocalConfigYaml(answers: WizardAnswers): string {
  const lines: string[] = [
    '# Ved Local Config — SECRETS GO HERE',
    '# This file should be in .gitignore',
    '',
  ];

  if (answers.apiKey) {
    lines.push(
      'llm:',
      `  apiKey: ${answers.apiKey}`,
      '',
    );
  } else if (PROVIDERS[answers.provider]?.needsApiKey) {
    lines.push(
      '# Set your API key:',
      'llm:',
      `  # apiKey: ${PROVIDERS[answers.provider]!.apiKeyHint}`,
      `  # Or set env: ${PROVIDERS[answers.provider]!.apiKeyEnvVar}`,
      '',
    );
  }

  if (answers.discordToken) {
    lines.push(
      'channels:',
      '  - type: discord',
      '    config:',
      `      token: ${answers.discordToken}`,
      '',
    );
  }

  return lines.join('\n');
}

// ── Vault creation ────────────────────────────────────────────────────────────

export function createVaultStructure(vaultPath: string): { created: boolean; dirs: string[] } {
  const expanded = vaultPath.replace(/^~/, homedir());
  const dirs = ['daily', 'entities', 'concepts', 'decisions'];
  const created: string[] = [];

  if (!existsSync(expanded)) {
    mkdirSync(expanded, { recursive: true });
    created.push(expanded);
  }

  for (const dir of dirs) {
    const full = join(expanded, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      created.push(full);
    }
  }

  // README
  const readmePath = join(expanded, 'README.md');
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath,
      `# Ved Vault\n\nThis is Ved's knowledge graph. Open this folder in Obsidian to visualize connections.\n\n` +
      `## Structure\n- \`daily/\` — Episodic memory (session summaries)\n- \`entities/\` — People, orgs, projects\n` +
      `- \`concepts/\` — Ideas, technologies\n- \`decisions/\` — Dated decision records\n`,
    );
  }

  return { created: created.length > 0, dirs: created };
}

// ── Banner ────────────────────────────────────────────────────────────────────

export function printBanner(): void {
  stdout.write(`
${C.cyan}${C.bold}  ╔══════════════════════════════════════╗
  ║          Ved — Setup Wizard          ║
  ╚══════════════════════════════════════╝${C.reset}

  ${C.dim}The personal AI agent that remembers everything and proves it.${C.reset}

`);
}

export function printSuccess(configDir: string, answers: WizardAnswers): void {
  const expanded = answers.vaultPath.replace(/^~/, homedir());

  stdout.write(`
${C.green}${C.bold}  ✅ Ved initialized successfully!${C.reset}

  ${C.bold}Files created:${C.reset}
    ${C.cyan}${configDir}/config.yaml${C.reset}       — main configuration
    ${C.cyan}${configDir}/config.local.yaml${C.reset}  — secrets (gitignored)
    ${C.cyan}${expanded}/${C.reset}          — Obsidian vault

  ${C.bold}Trust mode:${C.reset} ${TRUST_MODES[answers.trustMode]?.name ?? answers.trustMode}
  ${C.bold}Provider:${C.reset}   ${PROVIDERS[answers.provider]?.name ?? answers.provider} (${answers.model})

`);

  if (PROVIDERS[answers.provider]?.needsApiKey && !answers.apiKey) {
    stdout.write(`  ${C.yellow}⚠  Don't forget to set your API key:${C.reset}
    ${C.dim}Edit ${configDir}/config.local.yaml${C.reset}
    ${C.dim}Or set: export ${PROVIDERS[answers.provider]!.apiKeyEnvVar}=your-key${C.reset}

`);
  }

  stdout.write(`  ${C.bold}Next steps:${C.reset}
    ${C.cyan}1.${C.reset} ${answers.apiKey ? '' : 'Set your API key, then '}Run: ${C.bold}ved chat${C.reset}
    ${C.cyan}2.${C.reset} Check health: ${C.bold}ved doctor${C.reset}
    ${C.cyan}3.${C.reset} Explore: ${C.bold}ved help${C.reset}

`);
}

// ── Wizard runner ─────────────────────────────────────────────────────────────

export async function runInitWizard(opts: InitWizardOptions = {}): Promise<WizardAnswers | null> {
  const configDir = join(homedir(), '.ved');
  const configPath = join(configDir, 'config.yaml');

  // Check existing config
  if (existsSync(configPath) && !opts.force) {
    stdout.write(`\n  ${C.yellow}Config already exists at ${configPath}${C.reset}\n`);
    stdout.write(`  ${C.dim}Use --force to overwrite, or edit directly.${C.reset}\n\n`);
    return null;
  }

  // Non-interactive fallback
  if (opts.nonInteractive || !stdin.isTTY) {
    return runNonInteractive(configDir);
  }

  printBanner();

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    // ── Step 1: Provider ──────────────────────────────────────────────────
    const providerKeys = Object.keys(PROVIDERS);
    const providerIdx = await askChoice(
      rl,
      `${C.bold}Choose your LLM provider:${C.reset}`,
      providerKeys.map(k => ({
        label: PROVIDERS[k]!.name,
        description: PROVIDERS[k]!.description,
      })),
      0,
    );
    const provider = providerKeys[providerIdx]! as WizardAnswers['provider'];
    const providerInfo = PROVIDERS[provider]!;

    stdout.write(`  ${C.green}✓${C.reset} Provider: ${C.bold}${providerInfo.name}${C.reset}\n`);

    // ── Step 2: Model ─────────────────────────────────────────────────────
    const modelIdx = await askChoice(
      rl,
      `${C.bold}Choose a model:${C.reset}`,
      providerInfo.models.map(m => ({ label: m })),
      0,
    );
    const model = providerInfo.models[modelIdx] ?? providerInfo.defaultModel;

    stdout.write(`  ${C.green}✓${C.reset} Model: ${C.bold}${model}${C.reset}\n`);

    // ── Step 3: API Key ───────────────────────────────────────────────────
    let apiKey: string | null = null;

    if (providerInfo.needsApiKey) {
      // Check env first
      const envKey = process.env[providerInfo.apiKeyEnvVar];
      if (envKey) {
        stdout.write(`\n  ${C.green}✓${C.reset} Found API key in $${providerInfo.apiKeyEnvVar}\n`);
        apiKey = envKey;
      } else {
        stdout.write(`\n  ${C.dim}You can enter your API key now or set it later.${C.reset}\n`);
        const key = await askSecret(rl, `  ${C.bold}API key${C.reset}`, `${providerInfo.apiKeyHint} or Enter to skip`);

        if (key) {
          const validation = validateApiKey(provider, key);
          if (!validation.valid) {
            stdout.write(`  ${C.yellow}⚠  ${validation.error}${C.reset}\n`);
            const proceed = await askYesNo(rl, `  Use it anyway?`, false);
            if (proceed) {
              apiKey = key;
            }
          } else {
            apiKey = key;
            stdout.write(`  ${C.green}✓${C.reset} API key saved to config.local.yaml\n`);
          }
        } else {
          stdout.write(`  ${C.dim}Skipped — set later in config.local.yaml or $${providerInfo.apiKeyEnvVar}${C.reset}\n`);
        }
      }
    } else {
      stdout.write(`\n  ${C.green}✓${C.reset} ${providerInfo.name} runs locally — no API key needed\n`);
    }

    // ── Step 4: Base URL (Ollama / custom) ────────────────────────────────
    let baseUrl: string | null = providerInfo.defaultBaseUrl;
    if (provider === 'ollama') {
      const customUrl = await askQuestion(rl, `\n  ${C.bold}Ollama URL${C.reset}`, providerInfo.defaultBaseUrl!);
      if (customUrl !== providerInfo.defaultBaseUrl) {
        baseUrl = customUrl;
      }
    }

    // ── Step 5: Vault path ────────────────────────────────────────────────
    const defaultVault = '~/ved-vault';
    const vault = await askQuestion(rl, `\n  ${C.bold}Vault location${C.reset}`, defaultVault);
    const vaultPath = vault || defaultVault;

    const vaultValidation = validateVaultPath(vaultPath);
    if (!vaultValidation.valid) {
      stdout.write(`  ${C.yellow}⚠  ${vaultValidation.error}${C.reset}\n`);
    } else {
      stdout.write(`  ${C.green}✓${C.reset} Vault: ${C.bold}${vaultPath}${C.reset}\n`);
    }

    // ── Step 6: Trust mode ────────────────────────────────────────────────
    const trustKeys = Object.keys(TRUST_MODES);
    const trustIdx = await askChoice(
      rl,
      `${C.bold}Choose trust mode:${C.reset}`,
      trustKeys.map(k => ({
        label: TRUST_MODES[k]!.name,
        description: TRUST_MODES[k]!.description,
      })),
      1, // Default: gate-writes
    );
    const trustMode = trustKeys[trustIdx]! as WizardAnswers['trustMode'];

    stdout.write(`  ${C.green}✓${C.reset} Trust: ${C.bold}${TRUST_MODES[trustMode]!.name}${C.reset}\n`);
    stdout.write(`    ${C.dim}${TRUST_MODES[trustMode]!.detail}${C.reset}\n`);

    // ── Step 7: Owner ID ──────────────────────────────────────────────────
    const ownerId = await askQuestion(rl, `\n  ${C.bold}Your owner ID${C.reset} ${C.dim}(Discord user ID, username, or any unique ID)${C.reset}`, '');

    if (ownerId) {
      const ownerValidation = validateOwnerId(ownerId);
      if (!ownerValidation.valid) {
        stdout.write(`  ${C.yellow}⚠  ${ownerValidation.error}${C.reset}\n`);
      } else {
        stdout.write(`  ${C.green}✓${C.reset} Owner: ${C.bold}${ownerId}${C.reset}\n`);
      }
    } else {
      stdout.write(`  ${C.yellow}⚠  No owner ID — you'll need to set trust.ownerIds in config.yaml${C.reset}\n`);
    }

    // ── Step 8: Discord (optional) ────────────────────────────────────────
    const enableDiscord = await askYesNo(rl, `\n  ${C.bold}Enable Discord channel?${C.reset}`, false);
    let discordToken: string | null = null;

    if (enableDiscord) {
      const token = await askSecret(rl, `  ${C.bold}Discord bot token${C.reset}`, 'Enter to skip');
      if (token) {
        discordToken = token;
        stdout.write(`  ${C.green}✓${C.reset} Discord token saved to config.local.yaml\n`);
      }
    }

    // ── Generate configs ──────────────────────────────────────────────────
    const answers: WizardAnswers = {
      provider,
      model,
      apiKey,
      baseUrl,
      vaultPath,
      trustMode,
      ownerId: ownerId || 'your-id-here',
      enableDiscord,
      discordToken,
    };

    // Confirm
    stdout.write(`\n${C.dim}${'─'.repeat(50)}${C.reset}\n`);
    const confirm = await askYesNo(rl, `\n  ${C.bold}Create configuration?${C.reset}`, true);

    if (!confirm) {
      stdout.write(`\n  ${C.dim}Cancelled. No files were created.${C.reset}\n\n`);
      rl.close();
      return null;
    }

    // Write files
    writeConfigs(configDir, answers);
    printSuccess(configDir, answers);

    rl.close();
    return answers;

  } catch (err) {
    rl.close();
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      // readline closed unexpectedly (Ctrl+C etc)
      stdout.write(`\n  ${C.dim}Cancelled.${C.reset}\n\n`);
      return null;
    }
    throw err;
  }
}

// ── Non-interactive fallback ──────────────────────────────────────────────────

function runNonInteractive(configDir: string): WizardAnswers {
  const answers: WizardAnswers = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    baseUrl: null,
    vaultPath: '~/ved-vault',
    trustMode: 'gate-writes',
    ownerId: 'your-id-here',
    enableDiscord: false,
    discordToken: null,
  };

  writeConfigs(configDir, answers);

  stdout.write(`\n  ${C.green}✅${C.reset} Created default config at ${configDir}/\n`);
  stdout.write(`  ${C.dim}Edit config.yaml and config.local.yaml to customize.${C.reset}\n\n`);

  return answers;
}

// ── File writing ──────────────────────────────────────────────────────────────

export function writeConfigs(configDir: string, answers: WizardAnswers): void {
  mkdirSync(configDir, { recursive: true });

  writeFileSync(join(configDir, 'config.yaml'), generateConfigYaml(answers));
  writeFileSync(join(configDir, 'config.local.yaml'), generateLocalConfigYaml(answers));

  // Create vault structure
  createVaultStructure(answers.vaultPath);
}

// ── `ved config edit` ─────────────────────────────────────────────────────────

export function getEditorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || 'vi';
}

export function parseInitArgs(args: string[]): InitWizardOptions {
  const opts: InitWizardOptions = {};
  for (const arg of args) {
    switch (arg) {
      case '--force':
      case '-f':
        opts.force = true;
        break;
      case '--non-interactive':
      case '--yes':
      case '-y':
        opts.nonInteractive = true;
        break;
    }
  }
  return opts;
}
