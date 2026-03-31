/**
 * Comprehensive Live Test — Ved with real LLMs (Ollama + OpenAI)
 *
 * Tests:
 * 1. Basic chat (non-streaming)
 * 2. Streaming chat (token-by-token)
 * 3. Multi-turn conversation (working memory)
 * 4. System prompt behavior
 * 5. Audit trail integrity
 * 6. RAG-enriched responses
 * 7. T1→T2 memory compression
 * 8. Session resume (persistence across restarts)
 * 9. Error handling (bad model)
 *
 * Usage:
 *   npx tsx test/live-test-comprehensive.ts              # Ollama only
 *   OPENAI_API_KEY=sk-... npx tsx test/live-test-comprehensive.ts  # + OpenAI
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import type { VedConfig, TrustTier, VedMessage } from '../src/types/index.js';

// ── Config ──

const TEST_DIR = join(tmpdir(), `ved-live-comprehensive-${Date.now()}`);
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:1.7b';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ── Helpers ──

let passed = 0;
let failed = 0;
let warned = 0;

function pass(name: string, detail?: string) {
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
}

function fail(name: string, detail: string) {
  console.log(`  ❌ ${name} — ${detail}`);
  failed++;
}

function warn(name: string, detail: string) {
  console.log(`  ⚠️  ${name} — ${detail}`);
  warned++;
}

function msg(id: string, content: string): VedMessage {
  return {
    id,
    content,
    author: 'test-owner',
    channel: 'cli',
    timestamp: Date.now(),
  };
}

function makeVaultDir(base: string) {
  for (const d of ['daily', 'entities', 'concepts', 'decisions']) {
    mkdirSync(join(base, d), { recursive: true });
  }
}

function makeConfig(provider: string, label: string, overrides?: Partial<VedConfig>): Partial<VedConfig> {
  const vaultPath = join(TEST_DIR, `vault-${label}`);
  makeVaultDir(vaultPath);

  const base: Partial<VedConfig> = {
    name: `Ved Live Test (${provider})`,
    dbPath: join(TEST_DIR, `ved-${label}.db`),
    logLevel: 'error',
    logFormat: 'pretty',
    logFile: null,
    llm: {
      provider: provider === 'openai' ? 'openai' : 'ollama',
      model: provider === 'openai' ? OPENAI_MODEL : OLLAMA_MODEL,
      apiKey: provider === 'openai' ? OPENAI_KEY : null,
      baseUrl: provider === 'openai' ? undefined : OLLAMA_URL,
      maxTokensPerMessage: 2048,
      maxTokensPerSession: 100000,
      temperature: 0.3,
      systemPromptPath: null,
    },
    memory: {
      vaultPath,
      workingMemoryMaxTokens: 4000,
      ragContextMaxTokens: 2000,
      compressionThreshold: 3000,
      sessionIdleMinutes: 30,
      gitEnabled: false,
    },
    trust: {
      defaultTier: 'owner' as TrustTier,
      requireApproval: false,
      maxPendingApprovals: 100,
      approvalTimeoutMinutes: 30,
      ownerIds: ['test-owner'],
    },
    mcp: { servers: [], defaultTimeout: 30000, maxConcurrent: 5 },
    channels: {},
    audit: { dbPath: '', hmacSecret: 'test-hmac-secret', anchorIntervalMinutes: 60 },
    cron: { enabled: false, jobs: [] },
  };

  // Deep merge overrides
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && (base as Record<string, unknown>)[k]) {
        (base as Record<string, unknown>)[k] = { ...(base as Record<string, unknown>)[k] as object, ...v };
      } else {
        (base as Record<string, unknown>)[k] = v;
      }
    }
  }

  return base;
}

// ── Test Suite ──

async function testBasicChat(provider: string) {
  const name = `[${provider}] Basic chat`;
  try {
    const app = createApp(makeConfig(provider, `basic-${provider}`));
    await app.init();

    const response = await app.processMessageDirect(
      msg('basic-1', 'What is 7 + 13? Reply with just the number.')
    );

    await app.stop();

    if (!response?.content) {
      fail(name, 'No response content');
      return;
    }

    if (response.content.includes('20')) {
      pass(name, `"${response.content.substring(0, 80).trim()}"`);
    } else {
      warn(name, `Response doesn't contain "20": "${response.content.substring(0, 100)}"`);
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testStreamingChat(provider: string) {
  const name = `[${provider}] Streaming chat`;
  try {
    const app = createApp(makeConfig(provider, `stream-${provider}`));
    await app.init();

    const tokens: string[] = [];

    const response = await app.processMessageStream(
      msg('stream-1', 'Count from 1 to 5, separated by commas.'),
      (token: string) => { tokens.push(token); },
    );

    await app.stop();

    if (tokens.length > 1) {
      pass(name, `${tokens.length} tokens streamed, response: "${(response?.content ?? '').substring(0, 80).trim()}"`);
    } else if (tokens.length === 1) {
      warn(name, `Only 1 token — fallback? Content: "${tokens[0].substring(0, 60)}"`);
    } else {
      fail(name, 'No tokens received');
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testMultiTurn(provider: string) {
  const name = `[${provider}] Multi-turn conversation`;
  try {
    const app = createApp(makeConfig(provider, `multi-${provider}`));
    await app.init();

    // Turn 1
    await app.processMessageDirect(
      msg('mt-1', 'My name is Zephyr and I live in Tokyo. Remember this.')
    );

    // Turn 2
    const response = await app.processMessageDirect(
      msg('mt-2', 'What is my name and where do I live?')
    );

    await app.stop();

    if (!response?.content) {
      fail(name, 'No response');
      return;
    }

    const hasName = response.content.toLowerCase().includes('zephyr');
    const hasCity = response.content.toLowerCase().includes('tokyo');

    if (hasName && hasCity) {
      pass(name, 'Recalled name + city');
    } else if (hasName || hasCity) {
      warn(name, `Partial recall: name=${hasName}, city=${hasCity}`);
    } else {
      fail(name, `No recall: "${response.content.substring(0, 100)}"`);
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testSystemPrompt(provider: string) {
  const name = `[${provider}] System prompt`;
  try {
    const app = createApp(makeConfig(provider, `sysprompt-${provider}`));
    await app.init();

    const response = await app.processMessageDirect(
      msg('sp-1', 'What is your name? Reply with just your name.')
    );

    await app.stop();

    if (!response?.content) {
      fail(name, 'No response');
      return;
    }

    if (response.content.toLowerCase().includes('ved')) {
      pass(name, `Self-identified as Ved: "${response.content.substring(0, 80).trim()}"`);
    } else {
      warn(name, `Didn't mention Ved: "${response.content.substring(0, 100)}"`);
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testAuditTrail(provider: string) {
  const name = `[${provider}] Audit trail`;
  try {
    const app = createApp(makeConfig(provider, `audit-${provider}`));
    await app.init();

    await app.processMessageDirect(msg('audit-1', 'Say hello.'));

    const history = app.getHistory({ limit: 50 });
    const chainResult = app.verifyAuditChain();

    await app.stop();

    if (!history || history.length === 0) {
      fail(name, 'No audit entries');
      return;
    }

    if (history.length >= 2 && chainResult.intact) {
      pass(name, `${history.length} entries, chain intact`);
    } else {
      warn(name, `${history.length} entries, chain intact=${chainResult.intact}`);
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testRAGEnrichment(provider: string) {
  const name = `[${provider}] RAG enrichment`;
  try {
    const vaultPath = join(TEST_DIR, `vault-rag-${provider}`);
    makeVaultDir(vaultPath);

    // Pre-populate vault with a unique fact
    writeFileSync(
      join(vaultPath, 'entities', 'project-phoenix.md'),
      `---
type: project
tags: [secret, test]
created: 2026-01-01
---
# Project Phoenix

Project Phoenix is a secret initiative that launched on January 15, 2026.
The project lead is Dr. Amara Okafor.
The project budget is exactly $3.7 million.
The codename was chosen because the project aims to revive discontinued product lines.
`,
    );

    const config = makeConfig(provider, `rag-${provider}`, {
      memory: {
        vaultPath,
        workingMemoryMaxTokens: 4000,
        ragContextMaxTokens: 2000,
        compressionThreshold: 3000,
        sessionIdleMinutes: 30,
        gitEnabled: false,
      },
    });

    const app = createApp(config);
    await app.init();

    // Index the vault
    await app.reindexVault();

    // Test RAG search directly first
    const searchResult = await app.search('Project Phoenix lead budget');
    console.log(`    [RAG debug] search returned ${searchResult.results.length} results, text length: ${searchResult.text.length}`);
    if (searchResult.results.length > 0) {
      console.log(`    [RAG debug] first result: ${searchResult.results[0].filePath} (score: ${searchResult.results[0].score?.toFixed(3)})`);
    }

    const response = await app.processMessageDirect(
      msg('rag-1', 'Who is the lead of Project Phoenix and what is its budget?')
    );

    await app.stop();

    if (!response?.content) {
      fail(name, 'No response');
      return;
    }

    const hasLead = response.content.toLowerCase().includes('amara') || response.content.toLowerCase().includes('okafor');
    const hasBudget = response.content.includes('3.7') || response.content.includes('3,700,000');

    if (hasLead && hasBudget) {
      pass(name, 'Retrieved both lead and budget from vault');
    } else if (hasLead || hasBudget) {
      warn(name, `Partial RAG: lead=${hasLead}, budget=${hasBudget}`);
    } else {
      warn(name, `Model may have ignored RAG context: "${response.content.substring(0, 120)}"`);
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testMemoryCompression(provider: string) {
  const name = `[${provider}] T1→T2 compression`;
  try {
    const vaultPath = join(TEST_DIR, `vault-compress-${provider}`);
    makeVaultDir(vaultPath);

    const config = makeConfig(provider, `compress-${provider}`, {
      memory: {
        vaultPath,
        workingMemoryMaxTokens: 4000,
        ragContextMaxTokens: 2000,
        compressionThreshold: 3, // Very low — triggers after 3 messages
        sessionIdleMinutes: 30,
        gitEnabled: false,
      },
    });

    const app = createApp(config);
    await app.init();

    // Send messages to trigger compression
    for (let i = 1; i <= 6; i++) {
      await app.processMessageDirect(
        msg(`compress-${i}`, `Message ${i}: The weather is ${['sunny', 'rainy', 'cloudy', 'windy', 'foggy', 'snowy'][i - 1]}. Reply with one word: acknowledged.`)
      );
    }

    await app.stop(); // Shutdown triggers compression

    // Check if daily note was created
    const dailyDir = join(vaultPath, 'daily');
    const dailyFiles = existsSync(dailyDir) ? readdirSync(dailyDir).filter(f => f.endsWith('.md')) : [];

    if (dailyFiles.length > 0) {
      const content = readFileSync(join(dailyDir, dailyFiles[0]), 'utf-8');
      pass(name, `Daily note created: ${dailyFiles[0]} (${content.length} chars)`);
    } else {
      warn(name, 'No daily note — compression may not have fired (model may not produce structured output)');
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testSessionResume(provider: string) {
  const name = `[${provider}] Session resume`;
  try {
    const vaultPath = join(TEST_DIR, `vault-resume-${provider}`);
    makeVaultDir(vaultPath);
    const dbPath = join(TEST_DIR, `ved-resume-${provider}.db`);

    const config = makeConfig(provider, `resume-${provider}`, { dbPath });
    (config as Record<string, unknown>)['memory'] = {
      vaultPath,
      workingMemoryMaxTokens: 4000,
      ragContextMaxTokens: 2000,
      compressionThreshold: 3000,
      sessionIdleMinutes: 30,
      gitEnabled: false,
    };

    // Session 1: Establish fact
    const app1 = createApp(config);
    await app1.init();
    await app1.processMessageDirect(
      msg('resume-1', 'Remember: ALPHA-7749 is the secret code.')
    );
    await app1.stop();

    // Session 2: Resume and check
    const app2 = createApp(config);
    await app2.init();
    const sessions = app2.listRecentSessions();
    await app2.stop();

    if (sessions.length > 0) {
      pass(name, `${sessions.length} session(s) persisted after restart`);
    } else {
      warn(name, 'No sessions found after restart');
    }
  } catch (err) {
    fail(name, `${err}`);
  }
}

async function testErrorHandling(provider: string) {
  const name = `[${provider}] Error handling`;
  try {
    const config = makeConfig(provider, `err-${provider}`, {
      llm: {
        provider: provider === 'openai' ? 'openai' : 'ollama',
        model: 'nonexistent-model-xyz-12345',
        apiKey: provider === 'openai' ? OPENAI_KEY : null,
        baseUrl: provider === 'openai' ? undefined : OLLAMA_URL,
        maxTokensPerMessage: 2048,
        maxTokensPerSession: 50000,
        temperature: 0.7,
        systemPromptPath: null,
      },
    });

    const app = createApp(config);
    await app.init();

    let errorCaught = false;
    let errorMsg = '';
    try {
      await app.processMessageDirect(msg('err-1', 'This should fail.'));
    } catch (err) {
      errorCaught = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    await app.stop();

    if (errorCaught) {
      pass(name, `Error caught: "${errorMsg.substring(0, 80)}"`);
    } else {
      warn(name, 'No error thrown for invalid model');
    }
  } catch (err) {
    pass(name, `Error caught: "${String(err).substring(0, 80)}"`);
  }
}

// ── Main ──

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Ved Comprehensive Live Test');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Test dir:  ${TEST_DIR}`);
  console.log(`  Ollama:    ${OLLAMA_URL} / ${OLLAMA_MODEL}`);
  console.log(`  OpenAI:    ${OPENAI_KEY ? `${OPENAI_MODEL} (key present)` : 'SKIPPED (no key)'}`);
  console.log('');

  mkdirSync(TEST_DIR, { recursive: true });

  // ── Ollama Tests ──
  console.log('── Ollama Tests ──');
  await testBasicChat('ollama');
  await testStreamingChat('ollama');
  await testMultiTurn('ollama');
  await testSystemPrompt('ollama');
  await testAuditTrail('ollama');
  await testRAGEnrichment('ollama');
  await testMemoryCompression('ollama');
  await testSessionResume('ollama');
  await testErrorHandling('ollama');
  console.log('');

  // ── OpenAI Tests ──
  if (OPENAI_KEY) {
    console.log('── OpenAI Tests ──');
    await testBasicChat('openai');
    await testStreamingChat('openai');
    await testMultiTurn('openai');
    await testSystemPrompt('openai');
    await testAuditTrail('openai');
    await testRAGEnrichment('openai');
    await testMemoryCompression('openai');
    await testSessionResume('openai');
    await testErrorHandling('openai');
    console.log('');
  }

  // ── Summary ──
  const total = passed + failed + warned;
  console.log('═══════════════════════════════════════════════');
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed, ${warned} warnings`);
  console.log('═══════════════════════════════════════════════');

  // Cleanup
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
