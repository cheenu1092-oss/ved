#!/usr/bin/env node
/**
 * Ved post-install script.
 *
 * Runs after `npm install ved-ai`. Checks for optional local LLM (Ollama)
 * and prints a helpful welcome message with next steps.
 *
 * Non-blocking: exits 0 regardless of findings (never fails install).
 */

import { execSync } from 'node:child_process';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function checkOllama() {
  try {
    const out = execSync('ollama --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim();
  } catch {
    return null;
  }
}

function main() {
  // Skip in CI or non-interactive environments
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION || !process.stdout.isTTY) {
    return;
  }

  console.log('');
  console.log(`${BOLD}${CYAN}  ⚡ Ved installed successfully${RESET}`);
  console.log(`${DIM}  The personal AI agent that remembers everything and proves it.${RESET}`);
  console.log('');

  // Check Ollama
  const ollamaVersion = checkOllama();
  if (ollamaVersion) {
    console.log(`${GREEN}  ✓ Ollama detected${RESET} ${DIM}(${ollamaVersion})${RESET}`);
    console.log(`${DIM}    Use "ollama" as your LLM provider during setup for free local AI.${RESET}`);
  } else {
    console.log(`${YELLOW}  ℹ Ollama not found${RESET} ${DIM}(optional — for free local LLM)${RESET}`);
    console.log(`${DIM}    Install: https://ollama.com${RESET}`);
    console.log(`${DIM}    Or use Anthropic/OpenAI/OpenRouter during setup.${RESET}`);
  }

  console.log('');
  console.log(`${BOLD}  Quick start:${RESET}`);
  console.log(`    ${CYAN}ved init${RESET}      ${DIM}Interactive setup wizard${RESET}`);
  console.log(`    ${CYAN}ved chat${RESET}      ${DIM}Start a conversation${RESET}`);
  console.log(`    ${CYAN}ved --help${RESET}    ${DIM}See all commands${RESET}`);
  console.log('');
}

main();
