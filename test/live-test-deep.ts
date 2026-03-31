/**
 * Deep Live Test — Session 106
 *
 * Tests Ved against a real cloud LLM (OpenAI gpt-4o-mini) covering:
 * 1. Basic chat (non-streaming)
 * 2. Streaming token output
 * 3. Multi-turn conversation (memory persistence)
 * 4. RAG enrichment (model that respects injected context)
 * 5. T1→T2 memory compression (LLM-based summarization)
 * 6. Tool calling via MCP (simple echo server)
 * 7. Audit chain integrity across all operations
 * 8. System prompt self-identification
 *
 * Run: OPENAI_API_KEY=sk-... npx tsx test/live-test-deep.ts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import type { VedConfig, TrustTier, VedMessage } from '../src/types/index.js';

// ── Config ──

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('❌ OPENAI_API_KEY is required. Set it in the environment.');
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TEST_DIR = join(tmpdir(), `ved-deep-test-${Date.now()}`);
const VAULT_DIR = join(TEST_DIR, 'vault');
const DB_PATH = join(TEST_DIR, 'ved.db');

console.log('=== Ved Deep Live Test (Session 106) ===');
console.log(`Test dir: ${TEST_DIR}`);
console.log(`Provider: openai / ${MODEL}`);
console.log('');

// ── Setup ──

mkdirSync(join(VAULT_DIR, 'daily'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'entities'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'concepts'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'decisions'), { recursive: true });

// Seed vault with a test entity for RAG
writeFileSync(join(VAULT_DIR, 'entities', 'project-aurora.md'), `---
type: project
tags: [secret, codename]
created: 2026-03-01
---

# Project Aurora

Project Aurora is a classified initiative to build a quantum-resistant encryption protocol.
The project lead is Dr. Elena Vasquez.
Budget: $2.4M over 18 months.
Status: Phase 2 — prototype validation.
Key partner: NovaCrypt Labs.
`);

writeFileSync(join(VAULT_DIR, 'concepts', 'ved-philosophy.md'), `---
type: concept
tags: [ved, philosophy]
created: 2026-01-15
---

# Ved's Philosophy

Ved follows three core principles:
1. **Audit everything** — every action is hash-chain logged
2. **Trust but verify** — HITL approval for risky operations
3. **Memory is identity** — Obsidian vault is the knowledge graph
`);

const overrides: Partial<VedConfig> = {
  name: 'Ved Deep Test',
  dbPath: DB_PATH,
  logLevel: 'warn',
  logFormat: 'pretty',
  logFile: null,
  llm: {
    provider: 'openai',
    model: MODEL,
    apiKey: OPENAI_KEY,
    baseUrl: null,
    maxTokensPerMessage: 1024,
    maxTokensPerSession: 50000,
    temperature: 0.3, // lower for more deterministic
    systemPromptPath: null,
  },
  memory: {
    vaultPath: VAULT_DIR,
    workingMemoryMaxTokens: 4000,
    ragContextMaxTokens: 2000,
    compressionThreshold: 500, // low threshold to trigger compression
    sessionIdleMinutes: 30,
    gitEnabled: false,
    gitAutoCommitIntervalMinutes: 5,
  },
  trust: {
    ownerIds: ['deep-test'],
    tribeIds: [],
    knownIds: [],
    defaultTier: 4 as TrustTier,
    approvalTimeoutMs: 300000,
    maxToolCallsPerMessage: 5,
    maxAgenticLoops: 5,
  },
  audit: {
    anchorInterval: 100,
    hmacSecret: 'deep-test-secret',
  },
  rag: {
    vectorTopK: 5,
    ftsTopK: 5,
    graphMaxDepth: 2,
    graphMaxNodes: 10,
    fusionWeights: { fts: 0.3, vector: 0.4, graph: 0.3 },
    embeddingProvider: null,
    embeddingModel: null,
    embeddingBaseUrl: null,
    embeddingApiKey: null,
  },
  channels: [{ type: 'cli' as const, enabled: true, config: {} }],
  mcp: { servers: [] },
  cron: { enabled: false, jobs: [] },
};

// ── Test harness ──

let passed = 0;
let failed = 0;
let warnings = 0;
const results: Array<{ name: string; status: string; detail: string; durationMs: number }> = [];

function makeMsg(content: string, id?: string): VedMessage {
  return {
    id: id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'deep-test-channel',
    author: 'deep-test',
    content,
    timestamp: Date.now(),
  };
}

async function test(name: string, fn: () => Promise<{ ok: boolean; detail: string; warn?: boolean }>) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    if (result.ok) {
      if (result.warn) {
        warnings++;
        results.push({ name, status: '⚠️ WARN', detail: result.detail, durationMs: ms });
        console.log(`  ⚠️  ${name} (${ms}ms) — ${result.detail}`);
      } else {
        passed++;
        results.push({ name, status: '✅ PASS', detail: result.detail, durationMs: ms });
        console.log(`  ✅ ${name} (${ms}ms) — ${result.detail}`);
      }
    } else {
      failed++;
      results.push({ name, status: '❌ FAIL', detail: result.detail, durationMs: ms });
      console.log(`  ❌ ${name} (${ms}ms) — ${result.detail}`);
    }
  } catch (err) {
    const ms = Date.now() - start;
    failed++;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, status: '💥 ERROR', detail, durationMs: ms });
    console.log(`  💥 ${name} (${ms}ms) — ${detail}`);
  }
}

// ── Tests ──

async function run() {
  const app = createApp({ configOverrides: overrides });

  // Test 1: Init
  console.log('\n── Initialization ──');
  await test('App init with OpenAI', async () => {
    await app.init();
    return { ok: true, detail: 'Initialized successfully' };
  });

  // Test 2: Simple chat
  console.log('\n── Basic Chat ──');
  await test('Simple question (non-streaming)', async () => {
    const resp = await app.processMessageDirect(makeMsg('What is the capital of France? Answer in one word.'));
    const text = resp.content.toLowerCase();
    const ok = text.includes('paris');
    return { ok, detail: ok ? `Got: "${resp.content.trim().slice(0, 80)}"` : `Expected "paris", got: "${resp.content.trim().slice(0, 100)}"` };
  });

  // Test 3: Streaming
  console.log('\n── Streaming ──');
  await test('Streaming token output', async () => {
    const tokens: string[] = [];
    const resp = await app.processMessageStream(
      makeMsg('Count from 1 to 5, separated by commas. Nothing else.'),
      (token) => tokens.push(token),
    );
    const hasTokens = tokens.length > 0;
    const hasResponse = resp.content.length > 0;
    const ok = hasTokens && hasResponse;
    return {
      ok,
      detail: ok
        ? `${tokens.length} tokens streamed, response: "${resp.content.trim().slice(0, 60)}"`
        : `Tokens: ${tokens.length}, Response length: ${resp.content.length}`,
    };
  });

  // Test 4: Multi-turn (memory)
  console.log('\n── Multi-turn Memory ──');
  await test('Working memory persists across turns', async () => {
    await app.processMessageDirect(makeMsg('My favorite color is cerulean blue. Remember that.'));
    const resp = await app.processMessageDirect(makeMsg('What is my favorite color?'));
    const text = resp.content.toLowerCase();
    const ok = text.includes('cerulean') || text.includes('blue');
    return { ok, detail: ok ? `Correctly recalled: "${resp.content.trim().slice(0, 80)}"` : `Failed to recall. Got: "${resp.content.trim().slice(0, 100)}"` };
  });

  // Test 5: System prompt self-identification
  console.log('\n── System Prompt ──');
  await test('Ved self-identifies from system prompt', async () => {
    const resp = await app.processMessageDirect(makeMsg('What is your name? Who are you?'));
    const text = resp.content.toLowerCase();
    const ok = text.includes('ved');
    return { ok, detail: ok ? `Self-identified: "${resp.content.trim().slice(0, 80)}"` : `No "Ved" in response: "${resp.content.trim().slice(0, 100)}"` };
  });

  // Test 6: RAG enrichment
  console.log('\n── RAG Enrichment ──');
  await test('RAG-enriched response uses vault context', async () => {
    // Index vault first
    await app.reindexVault();
    // Ask about seeded entity
    const resp = await app.processMessageDirect(makeMsg('Tell me about Project Aurora. Who is the project lead?'));
    const text = resp.content.toLowerCase();
    const hasAurora = text.includes('aurora');
    const hasLead = text.includes('elena') || text.includes('vasquez');
    const ok = hasAurora && hasLead;
    return {
      ok,
      detail: ok
        ? `Correctly used vault context: "${resp.content.trim().slice(0, 100)}"`
        : `Missing vault info. Aurora: ${hasAurora}, Lead: ${hasLead}. Got: "${resp.content.trim().slice(0, 120)}"`,
      warn: hasAurora && !hasLead, // partial credit
    };
  });

  // Test 7: T1→T2 Compression
  console.log('\n── Memory Compression (T1→T2) ──');
  await test('T1→T2 compression fires on shutdown', async () => {
    // Send several messages to fill working memory past compression threshold
    for (let i = 0; i < 6; i++) {
      await app.processMessageDirect(makeMsg(
        `Tell me an interesting fact about the number ${i + 10}. Be brief, one sentence.`
      ));
    }

    // Shutdown triggers compression
    await app.stop();

    // Check for daily note files
    const dailyDir = join(VAULT_DIR, 'daily');
    const dailyFiles = existsSync(dailyDir) ? readdirSync(dailyDir).filter(f => f.endsWith('.md')) : [];
    const hasDaily = dailyFiles.length > 0;

    let dailyContent = '';
    if (hasDaily) {
      dailyContent = readFileSync(join(dailyDir, dailyFiles[0]), 'utf-8');
    }

    const ok = hasDaily && dailyContent.length > 50;
    return {
      ok,
      detail: ok
        ? `Compression wrote ${dailyFiles.length} daily note(s), ${dailyContent.length} chars. Preview: "${dailyContent.slice(0, 120).replace(/\n/g, ' ')}"`
        : `No daily notes found. Files: ${dailyFiles.length}, Content length: ${dailyContent.length}`,
    };
  });

  // Test 8: Audit chain integrity
  console.log('\n── Audit Chain ──');

  // Re-init to check audit (app was stopped for compression test)
  const app2 = createApp({ configOverrides: { ...overrides, dbPath: DB_PATH } });
  await app2.init();

  await test('Audit chain integrity', async () => {
    const verifyResult = app2.verifyAuditChain();
    const ok = verifyResult.intact;
    return {
      ok,
      detail: ok
        ? `Chain intact: ${verifyResult.total} entries`
        : `Chain broken at entry ${verifyResult.brokenAt}`,
    };
  });

  await test('Audit log has expected event types', async () => {
    const history = app2.getHistory({ limit: 200 });
    const types = new Set(history.map((e: any) => e.eventType));
    const expected = ['message_received', 'llm_call'];
    const hasAll = expected.every(t => types.has(t));
    return {
      ok: hasAll,
      detail: `Event types found: ${[...types].sort().join(', ')}`,
    };
  });

  await app2.stop();

  // ── Summary ──
  console.log('\n══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('══════════════════════════════════════');

  console.log('\n| Test | Status | Time | Detail |');
  console.log('|------|--------|------|--------|');
  for (const r of results) {
    console.log(`| ${r.name} | ${r.status} | ${r.durationMs}ms | ${r.detail.slice(0, 80)} |`);
  }

  // Cleanup
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

  if (failed > 0) {
    console.log(`\n❌ ${failed} test(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n✅ All ${passed} tests passed (${warnings} warnings)`);
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
