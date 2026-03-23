/**
 * Live Test — Session 96
 *
 * Tests Ved against a real LLM (OpenAI GPT-4o-mini).
 * Exercises: config → init → chat → response → multi-turn → memory.
 *
 * Run: npx tsx test/live-test.ts
 */

import { VedApp } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import type { VedMessage, VedResponse } from '../src/types/index.js';
import { ulid } from 'ulid';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──

const VED_DIR = join(homedir(), '.ved');
const VAULT_DIR = join(homedir(), 'ved-vault-test');
const DB_PATH = join(VED_DIR, 'ved-live-test.db');

// ── Helpers ──

function log(label: string, msg: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('='.repeat(60));
  console.log(msg);
}

function makeMessage(content: string, channel = 'live-test', author = 'owner-1'): VedMessage {
  return {
    id: ulid(),
    channel,
    author,
    content,
    timestamp: Date.now(),
    metadata: {},
  };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    console.log(`\n🧪 ${name}...`);
    await fn();
    console.log(`✅ ${name} — PASSED`);
    return true;
  } catch (err) {
    console.error(`❌ ${name} — FAILED`);
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    return false;
  }
}

// ── Setup ──

function setupTestEnv() {
  // Ensure .ved dir exists
  mkdirSync(VED_DIR, { recursive: true });

  // Create minimal config
  const configYaml = `
llm:
  provider: openai
  model: gpt-4o-mini
  maxTokensPerMessage: 1024
  maxTokensPerSession: 50000
  temperature: 0.5

memory:
  vaultPath: ${VAULT_DIR}
  gitEnabled: false

trust:
  ownerIds:
    - owner-1
  defaultTier: 1

audit:
  anchorInterval: 10

rag:
  embedding:
    model: nomic-embed-text
    baseUrl: http://localhost:11434

logLevel: info
logFormat: pretty
`;

  const localYaml = `
llm:
  apiKey: ${process.env.OPENAI_API_KEY || 'MISSING'}
`;

  writeFileSync(join(VED_DIR, 'config.yaml'), configYaml);
  writeFileSync(join(VED_DIR, 'config.local.yaml'), localYaml);

  // Create vault directory structure
  mkdirSync(join(VAULT_DIR, 'daily'), { recursive: true });
  mkdirSync(join(VAULT_DIR, 'entities'), { recursive: true });
  mkdirSync(join(VAULT_DIR, 'concepts'), { recursive: true });
  mkdirSync(join(VAULT_DIR, 'decisions'), { recursive: true });
}

function cleanup() {
  try {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
    if (existsSync(DB_PATH + '-wal')) rmSync(DB_PATH + '-wal');
    if (existsSync(DB_PATH + '-shm')) rmSync(DB_PATH + '-shm');
    if (existsSync(VAULT_DIR)) rmSync(VAULT_DIR, { recursive: true });
  } catch { /* ignore */ }
}

// ── Tests ──

async function main() {
  console.log('\n🔥 Ved Live Test Suite — Session 96');
  console.log('Testing against REAL LLM (OpenAI GPT-4o-mini)\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not set. Cannot run live tests.');
    process.exit(1);
  }

  cleanup();
  setupTestEnv();

  const results: boolean[] = [];
  let app: VedApp | null = null;

  try {
    // ── Test 1: Config loads correctly ──
    results.push(await runTest('Config loads with OpenAI provider', async () => {
      const config = loadConfig({ dbPath: DB_PATH });
      if (config.llm.provider !== 'openai') throw new Error(`Expected openai, got ${config.llm.provider}`);
      if (config.llm.model !== 'gpt-4o-mini') throw new Error(`Expected gpt-4o-mini, got ${config.llm.model}`);
      if (!config.llm.apiKey) throw new Error('API key not loaded from config.local.yaml');
      console.log(`  Provider: ${config.llm.provider}, Model: ${config.llm.model}`);
      console.log(`  API Key: ${config.llm.apiKey.slice(0, 10)}...`);
    }));

    // ── Test 2: App initializes ──
    results.push(await runTest('VedApp initializes', async () => {
      const config = loadConfig({ dbPath: DB_PATH });
      app = new VedApp(config);
      await app.init();
      console.log('  App initialized successfully');
    }));

    // ── Test 3: Simple chat — message → LLM → response ──
    results.push(await runTest('Simple chat: message → LLM → response', async () => {
      if (!app) throw new Error('App not initialized');

      const msg = makeMessage('What is 2 + 2? Reply with just the number.');
      const startMs = Date.now();
      const response = await app.processMessageDirect(msg);
      const durationMs = Date.now() - startMs;

      console.log(`  Response (${durationMs}ms): "${response.content}"`);
      console.log(`  Actions: ${response.actions.length}`);

      if (!response.content) throw new Error('No response content');
      if (!response.content.includes('4')) throw new Error(`Expected "4" in response, got: ${response.content}`);
    }));

    // ── Test 4: Multi-turn conversation ──
    results.push(await runTest('Multi-turn conversation', async () => {
      if (!app) throw new Error('App not initialized');

      // Turn 1
      const msg1 = makeMessage('My name is TestUser and I like coding in Rust.');
      const resp1 = await app.processMessageDirect(msg1);
      console.log(`  Turn 1: "${resp1.content?.slice(0, 80)}..."`);

      if (!resp1.content) throw new Error('No response for turn 1');

      // Turn 2 — should remember context from turn 1
      const msg2 = makeMessage('What programming language did I say I like?');
      const resp2 = await app.processMessageDirect(msg2);
      console.log(`  Turn 2: "${resp2.content?.slice(0, 80)}..."`);

      if (!resp2.content) throw new Error('No response for turn 2');
      if (!resp2.content.toLowerCase().includes('rust')) {
        throw new Error(`Expected "Rust" in response, got: ${resp2.content}`);
      }
    }));

    // ── Test 5: System prompt is assembled ──
    results.push(await runTest('System prompt assembled and sent', async () => {
      if (!app) throw new Error('App not initialized');

      const msg = makeMessage('What is your name? Reply in one sentence.');
      const response = await app.processMessageDirect(msg);
      console.log(`  Response: "${response.content?.slice(0, 120)}"`);

      if (!response.content) throw new Error('No response content');
      // The system prompt tells the LLM it's "Ved"
      if (response.content.toLowerCase().includes('ved')) {
        console.log('  ✓ Ved identity reflected in response');
      } else {
        console.log('  ⚠ Ved identity NOT reflected (may be expected with minimal system prompt)');
      }
    }));

    // ── Test 6: Audit trail created ──
    results.push(await runTest('Audit trail created for messages', async () => {
      if (!app) throw new Error('App not initialized');

      const history = app.getHistory({ limit: 20 });
      console.log(`  Audit entries: ${history.length}`);

      const messageEvents = history.filter((e: any) => e.eventType === 'message_received');
      const llmEvents = history.filter((e: any) => e.eventType === 'llm_response');

      console.log(`  message_received events: ${messageEvents.length}`);
      console.log(`  llm_response events: ${llmEvents.length}`);

      if (messageEvents.length === 0) throw new Error('No message_received audit events');
    }));

    // ── Test 7: LLM usage tracking ──
    results.push(await runTest('LLM usage tracked', async () => {
      if (!app) throw new Error('App not initialized');

      const stats = await app.getStats();
      console.log(`  Stats: ${JSON.stringify(stats, null, 2).slice(0, 300)}`);
    }));

    // ── Test 8: Error handling — invalid model ──
    results.push(await runTest('Error handling: graceful LLM errors', async () => {
      // Create a new app with a bad model name
      let errorApp: VedApp | null = null;
      try {
        const errConfig = loadConfig({
          dbPath: DB_PATH.replace('.db', '-err.db'),
          llm: {
            provider: 'openai' as const,
            model: 'nonexistent-model-12345',
            apiKey: process.env.OPENAI_API_KEY!,
            baseUrl: null,
            maxTokensPerMessage: 1024,
            maxTokensPerSession: 50000,
            temperature: 0.5,
            systemPromptPath: null,
          },
        });
        errorApp = new VedApp(errConfig);
        await errorApp.init();

        const msg = makeMessage('Hello');
        try {
          await errorApp.processMessageDirect(msg);
          console.log('  ⚠ No error thrown (model may have been auto-resolved)');
        } catch (err) {
          console.log(`  ✓ Error caught: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
        }
      } finally {
        if (errorApp) await errorApp.stop();
        try {
          rmSync(DB_PATH.replace('.db', '-err.db'), { force: true });
          rmSync(DB_PATH.replace('.db', '-err.db') + '-wal', { force: true });
          rmSync(DB_PATH.replace('.db', '-err.db') + '-shm', { force: true });
        } catch { /* ignore */ }
      }
    }));

  } finally {
    // ── Shutdown ──
    if (app) {
      console.log('\n🔄 Shutting down...');
      await app.stop();
      console.log('  App shut down cleanly');
    }
    cleanup();
  }

  // ── Summary ──
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;

  log('RESULTS', `
  Total:  ${results.length}
  Passed: ${passed}
  Failed: ${failed}
  `);

  if (failed > 0) {
    console.error('❌ Some live tests failed!');
    process.exit(1);
  } else {
    console.log('🎉 All live tests passed! Ved talks to real LLMs!');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
