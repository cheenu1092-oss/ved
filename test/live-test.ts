/**
 * Live test: Ved talks to a real LLM for the first time.
 *
 * Tests the full pipeline: message → LLM → response
 * Uses Ollama (local) to avoid API key requirements.
 *
 * Run from project root: npx tsx test/live-test.ts
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import type { VedConfig, TrustTier } from '../src/types/index.js';

// ── Setup test environment ──

const TEST_DIR = join(tmpdir(), `ved-live-test-${Date.now()}`);
const VAULT_DIR = join(TEST_DIR, 'vault');
const DB_PATH = join(TEST_DIR, 'ved.db');

// Ollama base URL — use host.docker.internal if in Docker
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:1.7b';

console.log('=== Ved Live Test ===');
console.log(`Test dir: ${TEST_DIR}`);
console.log(`Ollama: ${OLLAMA_URL} / ${OLLAMA_MODEL}`);
console.log('');

// Create vault structure
mkdirSync(join(VAULT_DIR, 'daily'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'entities'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'concepts'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'decisions'), { recursive: true });

// Config overrides for live test
const overrides: Partial<VedConfig> = {
  name: 'Ved Live Test',
  dbPath: DB_PATH,
  logLevel: 'warn',
  logFormat: 'pretty',
  logFile: null,
  llm: {
    provider: 'ollama',
    model: OLLAMA_MODEL,
    apiKey: null,
    baseUrl: OLLAMA_URL,
    maxTokensPerMessage: 2048,
    maxTokensPerSession: 50000,
    temperature: 0.7,
    systemPromptPath: null,
  },
  memory: {
    vaultPath: VAULT_DIR,
    workingMemoryMaxTokens: 4000,
    ragContextMaxTokens: 2000,
    compressionThreshold: 3000,
    sessionIdleMinutes: 30,
    gitEnabled: false,
    gitAutoCommitIntervalMinutes: 5,
  },
  trust: {
    ownerIds: ['live-test'],
    tribeIds: [],
    knownIds: [],
    defaultTier: 4 as TrustTier,
    approvalTimeoutMs: 300000,
    maxToolCallsPerMessage: 5,
    maxAgenticLoops: 5,
  },
  audit: {
    anchorInterval: 100,
    hmacSecret: null,
  },
  rag: {
    vectorTopK: 5,
    ftsTopK: 5,
    graphMaxDepth: 2,
    graphMaxNodes: 10,
    maxContextTokens: 2000,
    rrfK: 60,
    embedding: {
      model: 'nomic-embed-text',
      baseUrl: OLLAMA_URL,
      batchSize: 16,
      dimensions: 768,
    },
    chunking: {
      maxTokens: 512,
      minTokens: 32,
      frontmatterPrefix: true,
    },
  },
  channels: [{ type: 'cli', enabled: true, config: {} }],
  mcp: { servers: [] },
};

type TestResult = { test: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string; durationMs?: number };

async function runLiveTest() {
  const results: TestResult[] = [];

  // ── Test 1: App initialization ──
  console.log('--- Test 1: App initialization ---');
  let app: ReturnType<typeof createApp>;
  try {
    const t0 = Date.now();
    app = createApp({ configOverrides: overrides });
    await app.init();
    const dt = Date.now() - t0;
    results.push({ test: 'App init', status: 'PASS', detail: 'Initialized successfully', durationMs: dt });
    console.log(`✅ App initialized (${dt}ms)\n`);
  } catch (err: any) {
    results.push({ test: 'App init', status: 'FAIL', detail: err.message });
    console.error('❌ App init failed:', err.message);
    console.error(err.stack);
    printResults(results);
    cleanup();
    process.exit(1);
  }

  // ── Test 2: Simple message → LLM → response ──
  console.log('--- Test 2: Simple conversation ---');
  try {
    const t0 = Date.now();
    const response = await app.processMessageDirect({
      id: 'test-msg-1',
      channel: 'chat',
      author: 'live-test',
      content: 'Hello! What is 2 + 2? Reply with just the number.',
      timestamp: Date.now(),
    });
    const dt = Date.now() - t0;

    console.log(`Response (${dt}ms): "${response.content?.slice(0, 300)}"`);
    console.log(`Actions: ${response.actions?.length ?? 0}`);
    console.log(`Memory ops: ${response.memoryOps?.length ?? 0}`);

    if (response.content && response.content.length > 0) {
      results.push({ test: 'Simple chat', status: 'PASS', detail: `${response.content.length} chars in ${dt}ms`, durationMs: dt });
      console.log('✅ Got LLM response\n');
    } else {
      results.push({ test: 'Simple chat', status: 'FAIL', detail: 'Empty response' });
      console.log('❌ Empty response\n');
    }
  } catch (err: any) {
    results.push({ test: 'Simple chat', status: 'FAIL', detail: err.message });
    console.error('❌ Simple chat failed:', err.message, '\n');
  }

  // ── Test 3: Multi-turn conversation (working memory) ──
  console.log('--- Test 3: Multi-turn conversation ---');
  try {
    const t0 = Date.now();
    const r1 = await app.processMessageDirect({
      id: 'test-msg-2',
      channel: 'chat',
      author: 'live-test',
      content: 'My name is Alice. Please remember that.',
      timestamp: Date.now(),
    });
    console.log(`Turn 1 (${Date.now() - t0}ms): "${r1.content?.slice(0, 150)}"`);

    const t1 = Date.now();
    const r2 = await app.processMessageDirect({
      id: 'test-msg-3',
      channel: 'chat',
      author: 'live-test',
      content: 'What is my name?',
      timestamp: Date.now(),
    });
    const dt = Date.now() - t1;
    console.log(`Turn 2 (${dt}ms): "${r2.content?.slice(0, 150)}"`);

    const hasAlice = r2.content?.toLowerCase().includes('alice');
    if (hasAlice) {
      results.push({ test: 'Multi-turn', status: 'PASS', detail: `Remembered "Alice" (${dt}ms)`, durationMs: dt });
      console.log('✅ Context maintained across turns\n');
    } else {
      results.push({ test: 'Multi-turn', status: 'WARN', detail: `May not have remembered: "${r2.content?.slice(0, 100)}"` });
      console.log('⚠️ May not have remembered name (small model)\n');
    }
  } catch (err: any) {
    results.push({ test: 'Multi-turn', status: 'FAIL', detail: err.message });
    console.error('❌ Multi-turn failed:', err.message, '\n');
  }

  // ── Test 4: System prompt presence ──
  console.log('--- Test 4: System prompt ---');
  try {
    const t0 = Date.now();
    const r = await app.processMessageDirect({
      id: 'test-msg-4',
      channel: 'chat',
      author: 'live-test',
      content: 'Who are you? What is your name? Answer in one sentence.',
      timestamp: Date.now(),
    });
    const dt = Date.now() - t0;
    console.log(`Response (${dt}ms): "${r.content?.slice(0, 200)}"`);

    const mentionsVed = r.content?.toLowerCase().includes('ved');
    if (mentionsVed) {
      results.push({ test: 'System prompt', status: 'PASS', detail: `Identifies as Ved (${dt}ms)`, durationMs: dt });
      console.log('✅ System prompt working\n');
    } else {
      results.push({ test: 'System prompt', status: 'WARN', detail: `Did not say "Ved": "${r.content?.slice(0, 80)}"` });
      console.log('⚠️ Did not self-identify as Ved (model limitation?)\n');
    }
  } catch (err: any) {
    results.push({ test: 'System prompt', status: 'FAIL', detail: err.message });
    console.error('❌ System prompt failed:', err.message, '\n');
  }

  // ── Test 5: Audit trail verification ──
  console.log('--- Test 5: Audit trail ---');
  try {
    const entries = app.getHistory({ limit: 100 });
    const chainResult = app.verifyAuditChain(100);
    console.log(`Audit entries: ${entries.length}`);
    console.log(`Chain intact: ${chainResult.intact}`);

    if (entries.length > 0 && chainResult.intact) {
      results.push({ test: 'Audit trail', status: 'PASS', detail: `${entries.length} entries, chain intact` });
      console.log('✅ Audit trail intact\n');
    } else if (entries.length > 0) {
      results.push({ test: 'Audit trail', status: 'WARN', detail: `${entries.length} entries, chain: ${chainResult.intact}` });
      console.log('⚠️ Audit entries exist but chain issue\n');
    } else {
      results.push({ test: 'Audit trail', status: 'FAIL', detail: 'No audit entries' });
      console.log('❌ No audit entries\n');
    }
  } catch (err: any) {
    results.push({ test: 'Audit trail', status: 'FAIL', detail: err.message });
    console.error('❌ Audit check failed:', err.message, '\n');
  }

  // ── Test 6: Vault + RAG search ──
  console.log('--- Test 6: Vault + RAG search ---');
  try {
    // Write a test entity
    writeFileSync(join(VAULT_DIR, 'entities', 'test-entity.md'), `---
title: Test Entity
type: person
tags: [test, live]
---

# Test Entity

This is a test entity created during the live test.
The answer to the ultimate question of life is 42.
`);

    // Index
    await app.indexVaultOnStartup();

    // Search
    const searchResult = await app.search('ultimate question 42', { vectorTopK: 3, ftsTopK: 3 });
    const count = searchResult.results?.length ?? 0;
    console.log(`Search results: ${count}`);

    if (count > 0) {
      const top = searchResult.results[0];
      console.log(`Top result: ${top.filePath} (score: ${top.rrfScore.toFixed(3)})`);
      results.push({ test: 'Vault + RAG', status: 'PASS', detail: `${count} results found` });
      console.log('✅ RAG search working\n');
    } else {
      results.push({ test: 'Vault + RAG', status: 'WARN', detail: 'No search results (embedding may not be available)' });
      console.log('⚠️ No search results\n');
    }
  } catch (err: any) {
    results.push({ test: 'Vault + RAG', status: 'WARN', detail: `RAG error (non-critical): ${err.message}` });
    console.error('⚠️ RAG failed (non-critical):', err.message, '\n');
  }

  // ── Test 7: RAG-enriched LLM response ──
  console.log('--- Test 7: RAG-enriched conversation ---');
  try {
    const t0 = Date.now();
    const r = await app.processMessageDirect({
      id: 'test-msg-5',
      channel: 'chat',
      author: 'live-test',
      content: 'What is the answer to the ultimate question of life? Check your memory.',
      timestamp: Date.now(),
    });
    const dt = Date.now() - t0;
    console.log(`Response (${dt}ms): "${r.content?.slice(0, 200)}"`);

    const has42 = r.content?.includes('42');
    if (has42) {
      results.push({ test: 'RAG-enriched chat', status: 'PASS', detail: `Found "42" in response (${dt}ms)`, durationMs: dt });
      console.log('✅ RAG context injected into LLM\n');
    } else {
      results.push({ test: 'RAG-enriched chat', status: 'WARN', detail: `Response didn't mention 42: "${r.content?.slice(0, 80)}"` });
      console.log('⚠️ May not have used RAG context\n');
    }
  } catch (err: any) {
    results.push({ test: 'RAG-enriched chat', status: 'FAIL', detail: err.message });
    console.error('❌ RAG-enriched chat failed:', err.message, '\n');
  }

  // ── Cleanup ──
  console.log('--- Shutdown ---');
  try {
    await app.stop();
    results.push({ test: 'Clean shutdown', status: 'PASS', detail: 'Stopped without errors' });
    console.log('✅ App stopped cleanly\n');
  } catch (err: any) {
    results.push({ test: 'Clean shutdown', status: 'FAIL', detail: err.message });
    console.error('❌ Shutdown failed:', err.message, '\n');
  }

  printResults(results);
  cleanup();

  const failures = results.filter(r => r.status === 'FAIL');
  process.exit(failures.length > 0 ? 1 : 0);
}

function printResults(results: TestResult[]) {
  console.log('\n=== VED LIVE TEST RESULTS ===');
  console.log('─'.repeat(60));
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️' : '❌';
    const time = r.durationMs ? ` (${r.durationMs}ms)` : '';
    console.log(`${icon} ${r.test}: ${r.detail}${time}`);
  }
  console.log('─'.repeat(60));
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total: ${pass} pass, ${warn} warn, ${fail} fail out of ${results.length} tests`);
  console.log('');
}

function cleanup() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    console.log(`Cleaned up: ${TEST_DIR}`);
  } catch {
    // best effort
  }
}

runLiveTest().catch(err => {
  console.error('Fatal error:', err);
  cleanup();
  process.exit(1);
});
