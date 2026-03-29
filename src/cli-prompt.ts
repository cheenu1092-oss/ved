/**
 * `ved prompt` — System prompt profile manager.
 *
 * Manage, preview, and switch between system prompt profiles stored in
 * `~/.ved/prompts/`. Each profile is a plain `.md` file that replaces
 * Ved's default system prompt preamble.
 *
 * Subcommands:
 *   list              List available prompt profiles
 *   show [name]       Display a prompt (active if no name)
 *   create <name>     Create a new prompt profile
 *   edit <name>       Open prompt in $EDITOR
 *   use <name>        Set as active system prompt
 *   test              Dry-run: show fully assembled system prompt
 *   reset             Clear custom prompt, revert to default
 *   diff <a> <b>      Compare two prompt profiles
 *
 * Aliases: prompts, sp, system-prompt
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { VedApp } from './app.js';
import type { VedConfig } from './types/index.js';
import { errHint, errUsage } from './errors.js';

// ── Constants ──

const PROMPTS_DIR = join(homedir(), '.ved', 'prompts');
const CONFIG_PATH = join(homedir(), '.ved', 'config.yaml');

// ── ANSI colors ──

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  cyan: '\x1B[36m',
  red: '\x1B[31m',
  magenta: '\x1B[35m',
};

// ── Helpers ──

function ensurePromptsDir(): void {
  if (!existsSync(PROMPTS_DIR)) {
    mkdirSync(PROMPTS_DIR, { recursive: true });
  }
}

function listProfiles(): string[] {
  ensurePromptsDir();
  return readdirSync(PROMPTS_DIR)
    .filter(f => extname(f) === '.md')
    .map(f => basename(f, '.md'))
    .sort();
}

function profilePath(name: string): string {
  // Prevent path traversal
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe || safe !== name) {
    throw new Error(`Invalid profile name: "${name}". Use only a-z, A-Z, 0-9, _, -`);
  }
  return join(PROMPTS_DIR, `${safe}.md`);
}

function readProfile(name: string): string {
  const path = profilePath(name);
  if (!existsSync(path)) {
    throw new Error(`Profile "${name}" not found. Run "ved prompt list" to see available profiles.`);
  }
  return readFileSync(path, 'utf-8');
}

function getActivePromptPath(config: VedConfig): string | null {
  return config.llm.systemPromptPath ?? null;
}

function getActiveProfileName(config: VedConfig): string | null {
  const path = getActivePromptPath(config);
  if (!path) return null;
  // Check if it's in our prompts dir
  if (path.startsWith(PROMPTS_DIR)) {
    const name = basename(path, '.md');
    return name;
  }
  return null; // Custom path outside prompts dir
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Default prompt template ──

const DEFAULT_TEMPLATE = `# Custom System Prompt for Ved

You are Ved, a personal AI assistant. You remember everything and prove it.

## Personality
- Be concise, accurate, and helpful.
- Use tools when they help answer the question. Do not hallucinate tool results.
- When asked to remember something, acknowledge and confirm.
- Cite your knowledge sources when relevant.

## Custom Instructions
<!-- Add your custom instructions here -->
`;

// ── Subcommand handlers ──

async function handleList(config: VedConfig): Promise<void> {
  const profiles = listProfiles();
  const activeName = getActiveProfileName(config);
  const activePath = getActivePromptPath(config);

  if (profiles.length === 0 && !activePath) {
    console.log(`${C.dim}No prompt profiles found.${C.reset}`);
    console.log(`${C.dim}Create one with: ved prompt create <name>${C.reset}`);
    console.log(`${C.dim}Prompts directory: ${PROMPTS_DIR}${C.reset}`);
    return;
  }

  console.log(`${C.bold}Prompt Profiles${C.reset} ${C.dim}(${PROMPTS_DIR})${C.reset}\n`);

  if (profiles.length === 0) {
    console.log(`${C.dim}  No profiles in prompts directory.${C.reset}`);
  } else {
    for (const name of profiles) {
      const path = profilePath(name);
      const stat = statSync(path);
      const isActive = name === activeName;
      const marker = isActive ? `${C.green}● active${C.reset}` : '';
      const size = formatFileSize(stat.size);
      const date = stat.mtime.toISOString().slice(0, 10);
      console.log(`  ${isActive ? C.green : ''}${name}${C.reset}  ${C.dim}${size}  ${date}${C.reset}  ${marker}`);
    }
  }

  // Show active prompt info
  console.log('');
  if (activePath) {
    if (activeName) {
      console.log(`${C.green}Active:${C.reset} ${activeName}`);
    } else {
      console.log(`${C.green}Active:${C.reset} ${activePath} ${C.dim}(custom path)${C.reset}`);
    }
  } else {
    console.log(`${C.dim}Active: Ved default prompt (built-in)${C.reset}`);
  }
}

function handleShow(config: VedConfig, args: string[]): void {
  const name = args[0];

  if (!name) {
    // Show active prompt
    const activePath = getActivePromptPath(config);
    if (activePath && existsSync(activePath)) {
      const content = readFileSync(activePath, 'utf-8');
      const activeName = getActiveProfileName(config);
      console.log(`${C.bold}Active Prompt${C.reset}${activeName ? ` (${C.green}${activeName}${C.reset})` : ''}`);
      console.log(`${C.dim}Path: ${activePath}${C.reset}\n`);
      console.log(content);
    } else {
      console.log(`${C.bold}Active Prompt${C.reset} ${C.dim}(Ved default)${C.reset}\n`);
      console.log('You are Ved, a personal AI assistant. You remember everything and prove it.\n');
      console.log('## Rules');
      console.log('- Be concise, accurate, and helpful.');
      console.log('- Use tools when they help answer the question. Do not hallucinate tool results.');
      console.log('- When asked to remember something, acknowledge and confirm.');
      console.log('- Cite your knowledge sources when relevant (e.g. "From your vault: ...")');
    }
    return;
  }

  const content = readProfile(name);
  const path = profilePath(name);
  const stat = statSync(path);
  const isActive = getActiveProfileName(config) === name;

  console.log(`${C.bold}${name}${C.reset}${isActive ? ` ${C.green}● active${C.reset}` : ''}`);
  console.log(`${C.dim}Path: ${path}${C.reset}`);
  console.log(`${C.dim}Size: ${formatFileSize(stat.size)} | Modified: ${stat.mtime.toISOString().slice(0, 19)}${C.reset}\n`);
  console.log(content);
}

function handleCreate(args: string[]): void {
  const name = args[0];
  if (!name) {
    errUsage('ved prompt create <name>');
    process.exitCode = 1;
    return;
  }

  ensurePromptsDir();
  const path = profilePath(name);

  if (existsSync(path)) {
    errHint(`Profile "${name}" already exists. Use "ved prompt edit ${name}" to modify.`);
    process.exitCode = 1;
    return;
  }

  // Check if content is being piped via stdin
  let content = DEFAULT_TEMPLATE;
  if (!process.stdin.isTTY) {
    try {
      content = readFileSync('/dev/stdin', 'utf-8');
    } catch {
      // Fall back to template
    }
  }

  writeFileSync(path, content, 'utf-8');
  console.log(`${C.green}Created profile "${name}"${C.reset}`);
  console.log(`${C.dim}Path: ${path}${C.reset}`);
  console.log(`${C.dim}Activate with: ved prompt use ${name}${C.reset}`);
}

function handleEdit(args: string[]): void {
  const name = args[0];
  if (!name) {
    errUsage('ved prompt edit <name>');
    process.exitCode = 1;
    return;
  }

  const path = profilePath(name);
  if (!existsSync(path)) {
    errHint(`${C.red}Profile "${name}" not found. Create it first: ved prompt create ${name}${C.reset}`, 'Check the name and try again');
    process.exitCode = 1;
    return;
  }

  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  try {
    execSync(`${editor} ${path}`, { stdio: 'inherit' });
    console.log(`${C.green}Saved changes to "${name}"${C.reset}`);
  } catch (err) {
    errHint(`Editor exited with error`);
    process.exitCode = 1;
  }
}

function handleUse(_config: VedConfig, args: string[]): void {
  const name = args[0];
  if (!name) {
    errUsage('ved prompt use <name>');
    process.exitCode = 1;
    return;
  }

  const path = profilePath(name);
  if (!existsSync(path)) {
    errHint(`${C.red}Profile "${name}" not found. Run "ved prompt list" to see available profiles.${C.reset}`, 'Check the name and try again');
    process.exitCode = 1;
    return;
  }

  // Update config.yaml with the new system prompt path
  updateConfigPromptPath(path);

  console.log(`${C.green}Active prompt set to "${name}"${C.reset}`);
  console.log(`${C.dim}Restart Ved for changes to take effect.${C.reset}`);
}

function handleReset(): void {
  // Remove systemPromptPath from config.yaml
  updateConfigPromptPath(null);

  console.log(`${C.green}Reverted to Ved default prompt${C.reset}`);
  console.log(`${C.dim}Restart Ved for changes to take effect.${C.reset}`);
}

async function handleTest(_app: VedApp, config: VedConfig): Promise<void> {
  console.log(`${C.bold}Assembled System Prompt Preview${C.reset}\n`);
  console.log(`${C.dim}This is what Ved sends to the LLM as the system prompt,`);
  console.log(`including active facts and sample RAG context.${C.reset}\n`);
  console.log(`${C.cyan}${'─'.repeat(60)}${C.reset}`);

  // Build the system prompt using the actual buildSystemPrompt logic
  const parts: string[] = [];

  // 1. Custom or default preamble
  const promptPath = getActivePromptPath(config);
  if (promptPath && existsSync(promptPath)) {
    const content = readFileSync(promptPath, 'utf-8').trim();
    if (content) {
      parts.push(content);
      parts.push('');
      console.log(`${C.dim}[Using custom prompt: ${basename(promptPath, '.md')}]${C.reset}\n`);
    } else {
      pushDefaultPreamble(parts);
      console.log(`${C.dim}[Custom prompt file is empty, using default]${C.reset}\n`);
    }
  } else {
    pushDefaultPreamble(parts);
    if (promptPath) {
      console.log(`${C.dim}[Custom prompt not found: ${promptPath}, using default]${C.reset}\n`);
    } else {
      console.log(`${C.dim}[Using Ved default prompt]${C.reset}\n`);
    }
  }

  // 2. Sample working memory facts (simulated)
  parts.push('## Active Facts (from this session)');
  parts.push('- **user_name:** Example User');
  parts.push('- **user_preference:** Prefers concise answers');
  parts.push(`${C.dim}(In live mode, these are real session facts)${C.reset}`);
  parts.push('');

  // 3. Sample RAG context (simulated)
  parts.push('## Retrieved Knowledge (from your vault)');
  parts.push(`${C.dim}(In live mode, RAG results from vault search appear here)${C.reset}`);
  parts.push('No RAG context — run "ved prompt test" during a live session for real context.');
  parts.push('');

  console.log(parts.join('\n'));
  console.log(`${C.cyan}${'─'.repeat(60)}${C.reset}`);

  // Stats
  const assembled = parts.join('\n');
  const charCount = assembled.length;
  const lineCount = assembled.split('\n').length;
  const wordCount = assembled.split(/\s+/).filter(Boolean).length;

  console.log(`\n${C.dim}Stats: ${charCount} chars, ${wordCount} words, ${lineCount} lines${C.reset}`);
}

function handleDiff(args: string[]): void {
  const [nameA, nameB] = args;
  if (!nameA || !nameB) {
    errUsage('ved prompt diff <profile-a> <profile-b>');
    process.exitCode = 1;
    return;
  }

  // Support "default" as a pseudo-profile
  let contentA: string;
  let contentB: string;
  let labelA = nameA;
  let labelB = nameB;

  if (nameA === 'default') {
    contentA = getDefaultPromptText();
    labelA = 'default (built-in)';
  } else {
    contentA = readProfile(nameA);
  }

  if (nameB === 'default') {
    contentB = getDefaultPromptText();
    labelB = 'default (built-in)';
  } else {
    contentB = readProfile(nameB);
  }

  if (contentA === contentB) {
    console.log(`${C.green}Profiles "${labelA}" and "${labelB}" are identical.${C.reset}`);
    return;
  }

  // Simple line-by-line diff
  const linesA = contentA.split('\n');
  const linesB = contentB.split('\n');
  const maxLines = Math.max(linesA.length, linesB.length);

  console.log(`${C.bold}Comparing: ${labelA} ↔ ${labelB}${C.reset}\n`);

  let diffCount = 0;
  for (let i = 0; i < maxLines; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a === b) continue;

    diffCount++;
    console.log(`${C.dim}Line ${i + 1}:${C.reset}`);
    if (a !== undefined) {
      console.log(`${C.red}  - ${a}${C.reset}`);
    }
    if (b !== undefined) {
      console.log(`${C.green}  + ${b}${C.reset}`);
    }
  }

  console.log(`\n${C.dim}${diffCount} difference(s) found.${C.reset}`);
}

// ── Config file update ──

function updateConfigPromptPath(path: string | null): void {
  let content = '';
  if (existsSync(CONFIG_PATH)) {
    content = readFileSync(CONFIG_PATH, 'utf-8');
  }

  // Simple YAML update: find or add systemPromptPath under llm section
  const lines = content.split('\n');
  let foundLlm = false;
  let foundPromptLine = -1;
  let llmIndent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^llm:\s*$/.test(line) || /^llm:\s*#/.test(line)) {
      foundLlm = true;
      // Detect indent of next line
      if (i + 1 < lines.length) {
        const match = lines[i + 1].match(/^(\s+)/);
        llmIndent = match ? match[1] : '  ';
      }
    }
    if (foundLlm && /^\s+systemPromptPath:/.test(line)) {
      foundPromptLine = i;
      break;
    }
    // If we hit another top-level key, stop searching in this section
    if (foundLlm && i > 0 && /^[a-zA-Z]/.test(line) && !/^llm:/.test(line)) {
      break;
    }
  }

  if (path === null) {
    // Remove the line
    if (foundPromptLine >= 0) {
      lines.splice(foundPromptLine, 1);
    }
  } else if (foundPromptLine >= 0) {
    // Update existing line
    lines[foundPromptLine] = `${llmIndent || '  '}systemPromptPath: "${path}"`;
  } else if (foundLlm) {
    // Add after llm: section header
    const insertIdx = lines.findIndex(l => /^llm:\s*$/.test(l) || /^llm:\s*#/.test(l));
    if (insertIdx >= 0) {
      lines.splice(insertIdx + 1, 0, `${llmIndent || '  '}systemPromptPath: "${path}"`);
    }
  } else {
    // No llm section yet, append one
    lines.push('');
    lines.push('llm:');
    lines.push(`  systemPromptPath: "${path}"`);
  }

  // Ensure config dir exists
  const configDir = join(homedir(), '.ved');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf-8');
}

// ── Default prompt text ──

function getDefaultPromptText(): string {
  return [
    'You are Ved, a personal AI assistant. You remember everything and prove it.',
    '',
    '## Rules',
    '- Be concise, accurate, and helpful.',
    '- Use tools when they help answer the question. Do not hallucinate tool results.',
    '- When asked to remember something, acknowledge and confirm.',
    '- Cite your knowledge sources when relevant (e.g. "From your vault: ...")',
  ].join('\n');
}

function pushDefaultPreamble(parts: string[]): void {
  parts.push('You are Ved, a personal AI assistant. You remember everything and prove it.');
  parts.push('');
  parts.push('## Rules');
  parts.push('- Be concise, accurate, and helpful.');
  parts.push('- Use tools when they help answer the question. Do not hallucinate tool results.');
  parts.push('- When asked to remember something, acknowledge and confirm.');
  parts.push('- Cite your knowledge sources when relevant (e.g. "From your vault: ...")');
  parts.push('');
}

// ── Help ──

function showHelp(): void {
  console.log(`${C.bold}ved prompt${C.reset} — System prompt profile manager\n`);
  console.log('Subcommands:');
  console.log(`  ${C.cyan}list${C.reset}              List available prompt profiles`);
  console.log(`  ${C.cyan}show${C.reset} [name]       Display a prompt (active if omitted)`);
  console.log(`  ${C.cyan}create${C.reset} <name>     Create a new prompt profile`);
  console.log(`  ${C.cyan}edit${C.reset} <name>       Open prompt in $EDITOR`);
  console.log(`  ${C.cyan}use${C.reset} <name>        Set as active system prompt`);
  console.log(`  ${C.cyan}test${C.reset}              Preview fully assembled system prompt`);
  console.log(`  ${C.cyan}reset${C.reset}             Revert to Ved default prompt`);
  console.log(`  ${C.cyan}diff${C.reset} <a> <b>      Compare two profiles (use "default" for built-in)`);
  console.log('');
  console.log(`Profiles are stored as .md files in ${C.dim}${PROMPTS_DIR}${C.reset}`);
  console.log('');
  console.log('Aliases: prompts, sp, system-prompt');
}

// ── Main entry ──

export async function runPromptCli(app: VedApp | null, config: VedConfig, args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const subArgs = args.slice(1);

  switch (sub) {
    case 'help':
    case '-h':
    case '--help':
      showHelp();
      break;

    case 'list':
    case 'ls':
      await handleList(config);
      break;

    case 'show':
    case 'cat':
    case 'view':
      handleShow(config, subArgs);
      break;

    case 'create':
    case 'new':
    case 'add':
      handleCreate(subArgs);
      break;

    case 'edit':
      handleEdit(subArgs);
      break;

    case 'use':
    case 'set':
    case 'activate':
      handleUse(config, subArgs);
      break;

    case 'test':
    case 'preview':
    case 'dry-run':
      if (app) {
        await handleTest(app, config);
      } else {
        // Lightweight test without app — just show the prompt
        await handleTest(null as unknown as VedApp, config);
      }
      break;

    case 'reset':
    case 'clear':
      handleReset();
      break;

    case 'diff':
    case 'compare':
      handleDiff(subArgs);
      break;

    default:
      errHint(`Unknown subcommand: ${sub}`, 'Run "ved help" to see available commands');
      showHelp();
      process.exitCode = 1;
  }
}
