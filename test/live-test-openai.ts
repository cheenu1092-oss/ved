/**
 * Live test: Ved talks to OpenAI GPT-4o-mini.
 *
 * Tests the full pipeline with a production-grade LLM.
 * Requires: OPENAI_API_KEY environment variable
 * Run: npx tsx test/live-test-openai.ts
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createApp, VedApp } from '../src/app.js';
import type { VedConfig, TrustTier, VedMessage } from '../src/types/index.js';

// ── Pre-flight ──

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set.');
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TEST_DIR = join(tmpdir(), `ved-live-openai-${Date.now()}`);
const VAULT_DIR = join(TEST_DIR, 'vault');
const DB_PATH = join(TEST_DIR, 'ved.db');

console.log('=== Ved Live Test — OpenAI ===');
console.log(`Model: ${MODEL}`);
console.log(`Dir: ${TEST_DIR}\n`);

// Vault structure
for (const d of ['daily', 'entities', 'concepts', 'decisions']) {
  mkdirSync(join(VAULT_DIR, d), { recursive: true });
}

try {
  execSync('git init && git add -A && git commit -m "init" --allow-empty', {
    cwd: VAULT_DIR, stdio: 'ignore',
  });
} catch {}

// Seed test entity for RAG
writeFileSync(
  join(VAULT_DIR, 'entities', 'project-aurora.md'),
  `---\ntype: project\ntags: [secret, test]\ncreated: 2026-03-30\n---\n\n# Project Aurora\n\nProject Aurora is a classified initiative to build a quantum-resistant encryption library.\nThe lead engineer is Dr. Sarah Chen. Budget: $4.2 million. Deadline: July 2026. Language: Rust.\n`
);

// Helper to build proper VedMessage
let mc = 0;
function msg(content: string, channel = 'cli', author = 'test-owner'): VedMessage {
  return { id: `msg-${++mc}`, channel, author, content, timestamp: Date.now() };
}

// Config
const overrides: Partial<VedConfig> = {
  name: 'Ved Live Test (OpenAI)',
  dbPath: DB_PATH,
  logLevel: 'warn',
  logFormat: 'pretty',
  logFile: null,
  llm: {
    provider: 'openai',
    model: MODEL,
    apiKey: OPENAI_API_KEY,
    baseUrl: null,
    maxTokensPerMessage: 2048,
    maxTokensPerSession: 50000,
    temperature: 0.3,
    systemPrompt: null,
  },
  memory: {
    vaultPath: VAULT_DIR,
    dailyNoteFolder: 'daily',
    entityFolder: 'entities',
    conceptFolder: 'concepts',
    decisionFolder: 'decisions',
    maxWorkingMemoryMessages: 20,
    compressionThreshold: 8,
    compressionIdleMs: 60_000,
    enableGitAutoCommit: true,
  },
  trust: {
    ownerIds: ['test-owner'],
    defaultTier: 'audit' as TrustTier,
    trustMode: 'audit',
  },
  rag: {
    chunkSize: 500,
    chunkOverlap: 50,
    maxResults: 5,
    minScore: 0.1,
    embeddingProvider: null,
    embeddingModel: null,
    embeddingDimensions: null,
    useGraph: true,
    useFTS: true,
    useVector: false,
  },
  audit: {
    hmacSecret: 'live-test-secret',
    anchorIntervalHours: 24,
    retentionDays: 365,
  },
  channels: [{ type: 'cli', enabled: true, config: {} }],
  mcp: { servers: [] },
};

// ── Runner ──

let passed = 0, failed = 0, warned = 0;

function ok(n: string, d?: string) { passed++; console.log(`  ✅ ${n}${d ? ` — ${d}` : ''}`); }
function fail(n: string, e: unknown) { failed++; console.log(`  ❌ ${n} — ${e instanceof Error ? e.message : String(e)}`); }
function warn(n: string, d: string) { warned++; console.log(`  ⚠️  ${n} — ${d}`); }

async function run() {
  const t0 = Date.now();

  // 1: Init
  console.log('\n🔧 Test 1: App initialization');
  let app: VedApp;
  try {
    app = createApp({ configOverrides: overrides as VedConfig });
    await app.init();
    ok('Init', `${Date.now() - t0}ms`);
  } catch (e) {
    fail('Init', e);
    process.exit(1);
  }

  // 2: Simple chat
  console.log('\n💬 Test 2: Simple chat (17 × 23)');
  try {
    const t = Date.now();
    const r = await app.processMessageDirect(msg('What is 17 multiplied by 23? Reply with just the number.'));
    console.log(`     → "${r.content?.substring(0, 200)}"`);
    r.content?.includes('391') ? ok('Correct (391)', `${Date.now() - t}ms`) : warn('Wrong', `Got: ${r.content?.substring(0, 80)}`);
  } catch (e) { fail('Simple chat', e); }

  // 3: Multi-turn
  console.log('\n🔄 Test 3: Multi-turn conversation');
  try {
    // Same channel+author = same session
    await app.processMessageDirect(msg('My name is Marcus and I live in Prague.'));
    await app.processMessageDirect(msg('I work as a violin maker.'));
    const r = await app.processMessageDirect(msg('What is my name, where do I live, and what do I do?'));
    console.log(`     → "${r.content?.substring(0, 300)}"`);
    const c = r.content?.toLowerCase() ?? '';
    const hits = [c.includes('marcus'), c.includes('prague'), c.includes('violin')].filter(Boolean).length;
    hits === 3 ? ok('All 3 facts recalled') : hits >= 2 ? warn('Partial', `${hits}/3`) : fail('Memory', `${hits}/3`);
  } catch (e) { fail('Multi-turn', e); }

  // 4: Self-identification
  console.log('\n🆔 Test 4: System prompt (Ved identity)');
  try {
    // New channel to get fresh session
    const r = await app.processMessageDirect(msg('Who are you? What is your name? Brief answer.', 'test-chan'));
    console.log(`     → "${r.content?.substring(0, 200)}"`);
    r.content?.toLowerCase().includes('ved') ? ok('Self-identifies as Ved') : warn('No Ved mention', r.content?.substring(0, 80) ?? '');
  } catch (e) { fail('Identity', e); }

  // 5: Streaming
  console.log('\n📡 Test 5: Streaming');
  try {
    const t = Date.now();
    let chunks = 0;
    const r = await app.processMessageStream(
      msg('Count from 1 to 5, one number per line.', 'stream-test'),
      () => { chunks++; },
    );
    const ms = Date.now() - t;
    console.log(`     → ${chunks} tokens, "${(r.content ?? '').substring(0, 80)}"`);
    chunks > 1 ? ok('Streaming', `${chunks} tokens in ${ms}ms`) : warn('No streaming', `${chunks} tokens`);
  } catch (e) { fail('Streaming', e); }

  // 6: RAG
  console.log('\n📚 Test 6: RAG-enriched response');
  try {
    await app.reindexVault();
    const r = await app.processMessageDirect(msg('What is Project Aurora? Who leads it and what language?', 'rag-test'));
    console.log(`     → "${r.content?.substring(0, 300)}"`);
    const c = r.content?.toLowerCase() ?? '';
    const hits = [c.includes('sarah') || c.includes('chen'), c.includes('rust'), c.includes('quantum') || c.includes('encryption')].filter(Boolean).length;
    hits >= 2 ? ok('RAG used', `${hits}/3 vault facts`) : hits === 1 ? warn('Partial RAG', `${hits}/3`) : warn('RAG not used', 'FTS may not have matched');
  } catch (e) { fail('RAG', e); }

  // 7: Audit trail
  console.log('\n🔗 Test 7: Audit trail');
  try {
    const entries = app.queryAudit('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
    const count = (entries as any[]).length;
    count > 0 ? ok('Audit logged', `${count} entries`) : fail('No audit entries', '0');
  } catch (e) { fail('Audit', e); }

  // 8: Empty message
  console.log('\n🛑 Test 8: Empty message handling');
  try {
    const r = await app.processMessageDirect(msg(''));
    r.content ? ok('Handled', r.content.substring(0, 60)) : ok('Empty response (graceful)');
  } catch (e: any) {
    ok('Threw', e.message?.substring(0, 60) ?? String(e));
  }

  // 9: Usage
  console.log('\n📊 Test 9: Usage tracking');
  try {
    const u = app.llm.sessionUsage;
    console.log(`     prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`);
    u.totalTokens > 0 ? ok('Tracked', `${u.totalTokens} tokens`) : warn('Zero', 'Not accumulated');
  } catch (e) { fail('Usage', e); }

  // 10: Shutdown
  console.log('\n🔌 Test 10: Shutdown');
  try { await app.stop(); ok('Clean'); } catch (e) { fail('Shutdown', e); }

  // Summary
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ ${passed}  ❌ ${failed}  ⚠️ ${warned}  |  ${elapsed}s  |  ${MODEL}`);
  console.log('='.repeat(50));

  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
