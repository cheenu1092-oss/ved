/**
 * MCP Live Test — Session 107
 *
 * Tests Ved's tool calling with a real LLM + real MCP server (stdio).
 * The LLM must decide to call tools, Ved routes to MCP, results return to LLM.
 *
 * Tests:
 * 1. MCP server connects and discovers tools
 * 2. LLM calls calculator tool for math
 * 3. LLM calls get_weather tool
 * 4. LLM calls get_time tool
 * 5. Multi-tool: LLM calls multiple tools in one response
 * 6. Agentic loop: tool result feeds back into LLM for final answer
 * 7. Audit trail captures tool events
 * 8. Tool results appear in conversation context
 *
 * Run: OPENAI_API_KEY=sk-... npx tsx test/live-test-mcp.ts
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import type { VedConfig, TrustTier, VedMessage } from '../src/types/index.js';

// ── Config ──

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('❌ OPENAI_API_KEY is required. Set it in the environment.');
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TEST_DIR = join(tmpdir(), `ved-mcp-test-${Date.now()}`);
const VAULT_DIR = join(TEST_DIR, 'vault');
const DB_PATH = join(TEST_DIR, 'ved.db');

// Resolve MCP test server path relative to this file
const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = resolve(__dirname, 'mcp-test-server.ts');

console.log('=== Ved MCP Live Test (Session 107) ===');
console.log(`Test dir: ${TEST_DIR}`);
console.log(`Provider: openai / ${MODEL}`);
console.log(`MCP server: ${MCP_SERVER_PATH}`);
console.log('');

// ── Setup ──

mkdirSync(join(VAULT_DIR, 'daily'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'entities'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'concepts'), { recursive: true });
mkdirSync(join(VAULT_DIR, 'decisions'), { recursive: true });

const overrides: Partial<VedConfig> = {
  name: 'Ved MCP Test',
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
    temperature: 0.1, // very low for deterministic tool use
    systemPromptPath: null,
  },
  memory: {
    vaultPath: VAULT_DIR,
    workingMemoryMaxTokens: 4000,
    ragContextMaxTokens: 2000,
    compressionThreshold: 3999, // just under max — don't trigger compression
    sessionIdleMinutes: 30,
    gitEnabled: false,
    gitAutoCommitIntervalMinutes: 5,
  },
  trust: {
    ownerIds: ['mcp-test'],
    tribeIds: [],
    knownIds: [],
    defaultTier: 4 as TrustTier, // owner — auto-approve all tools
    approvalTimeoutMs: 300000,
    maxToolCallsPerMessage: 10,
    maxAgenticLoops: 5,
  },
  audit: {
    anchorInterval: 100,
    hmacSecret: 'mcp-test-secret',
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
  mcp: {
    servers: [
      {
        name: 'test-tools',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['tsx', MCP_SERVER_PATH],
        enabled: true,
      },
    ],
  },
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
    channel: 'mcp-test-channel',
    author: 'mcp-test',
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
    const detail = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    results.push({ name, status: '💥 ERROR', detail, durationMs: ms });
    console.log(`  💥 ${name} (${ms}ms) — ${detail}`);
  }
}

// ── Tests ──

async function run() {
  const app = createApp({ configOverrides: overrides });

  // Test 1: Init + MCP discovery
  console.log('\n── MCP Server Discovery ──');
  await test('App init + MCP server connects', async () => {
    await app.init();
    // Discover tools from MCP server
    const mcpClient = (app as any).mcp;
    if (!mcpClient) {
      return { ok: false, detail: 'MCP client not initialized' };
    }
    // discoverTools connects to servers and lists tools
    const tools = await mcpClient.discoverTools();
    const toolNames = tools.map((t: any) => t.name);
    const hasCalc = toolNames.some((n: string) => n.includes('calculator'));
    const hasWeather = toolNames.some((n: string) => n.includes('get_weather'));
    const hasTime = toolNames.some((n: string) => n.includes('get_time'));
    const ok = tools.length === 3 && hasCalc && hasWeather && hasTime;
    return {
      ok,
      detail: ok
        ? `Discovered ${tools.length} tools: ${toolNames.join(', ')}`
        : `Expected 3 tools (calc, weather, time), got ${tools.length}: ${toolNames.join(', ')}`,
    };
  });

  // Test 2: LLM calls calculator
  console.log('\n── Calculator Tool ──');
  await test('LLM uses calculator for math', async () => {
    const resp = await app.processMessageDirect(
      makeMsg('What is 347 * 23? Use the calculator tool to compute this. Give me just the number.')
    );
    const text = resp.content;
    const expected = 347 * 23; // 7981
    const hasAnswer = text.includes(String(expected));
    return {
      ok: hasAnswer,
      detail: hasAnswer
        ? `Correctly computed: ${expected}. Response: "${text.trim().slice(0, 100)}"`
        : `Expected ${expected} in response. Got: "${text.trim().slice(0, 150)}"`,
    };
  });

  // Test 3: LLM calls get_weather
  console.log('\n── Weather Tool ──');
  await test('LLM uses weather tool', async () => {
    const resp = await app.processMessageDirect(
      makeMsg('What is the current weather in San Francisco? Use the get_weather tool.')
    );
    const text = resp.content.toLowerCase();
    // Our fake data: 62°F, Foggy, 78% humidity
    const hasFoggy = text.includes('fog');
    const hasTemp = text.includes('62');
    const ok = hasFoggy || hasTemp;
    return {
      ok,
      detail: ok
        ? `Got weather data. Response: "${resp.content.trim().slice(0, 120)}"`
        : `Expected fog/62°F. Got: "${resp.content.trim().slice(0, 150)}"`,
    };
  });

  // Test 4: LLM calls get_time
  console.log('\n── Time Tool ──');
  await test('LLM uses time tool', async () => {
    const resp = await app.processMessageDirect(
      makeMsg('What is the current time? Use the get_time tool and tell me.')
    );
    const text = resp.content;
    // Should contain something time-like (ISO format or readable)
    const hasTime = /\d{4}/.test(text) || /\d{1,2}:\d{2}/.test(text);
    return {
      ok: hasTime,
      detail: hasTime
        ? `Got time. Response: "${text.trim().slice(0, 120)}"`
        : `No time found in response: "${text.trim().slice(0, 150)}"`,
    };
  });

  // Test 5: Multi-step reasoning with tool
  console.log('\n── Multi-step Reasoning ──');
  await test('LLM uses tool result to reason further', async () => {
    const resp = await app.processMessageDirect(
      makeMsg('Use the calculator to compute 15 * 17, then tell me if the result is a prime number.')
    );
    const text = resp.content.toLowerCase();
    // 15 * 17 = 255, which is NOT prime (3 * 5 * 17)
    const hasResult = text.includes('255');
    const saysNotPrime = text.includes('not') && text.includes('prime');
    const ok = hasResult && saysNotPrime;
    return {
      ok,
      detail: ok
        ? `Correctly computed 255 and identified as not prime. Response: "${resp.content.trim().slice(0, 120)}"`
        : `Expected 255 + "not prime". Got: "${resp.content.trim().slice(0, 150)}"`,
      warn: hasResult && !saysNotPrime, // partial credit if math is right
    };
  });

  // Test 6: Weather comparison (may trigger multiple calls)
  console.log('\n── Multi-city Weather ──');
  await test('LLM fetches weather for multiple cities', async () => {
    const resp = await app.processMessageDirect(
      makeMsg('Compare the weather in Tokyo and London using the get_weather tool. Which city is warmer?')
    );
    const text = resp.content.toLowerCase();
    // Tokyo: 68°F Sunny, London: 50°F Rainy → Tokyo is warmer
    const hasTokyo = text.includes('tokyo');
    const hasLondon = text.includes('london');
    const saysWarmer = text.includes('tokyo') && (text.includes('warmer') || text.includes('higher'));
    const ok = hasTokyo && hasLondon;
    return {
      ok,
      detail: ok
        ? `Compared both cities. Tokyo warmer: ${saysWarmer}. Response: "${resp.content.trim().slice(0, 140)}"`
        : `Expected both cities. Got: "${resp.content.trim().slice(0, 150)}"`,
      warn: ok && !saysWarmer,
    };
  });

  // Test 7: Audit trail has tool events
  console.log('\n── Audit Trail ──');
  await test('Audit trail captures tool_requested and tool_executed events', async () => {
    const history = app.getHistory({ limit: 500 });
    const types = new Set(history.map((e: any) => e.eventType));
    const hasRequested = types.has('tool_requested');
    const hasExecuted = types.has('tool_executed');
    const hasLlmCall = types.has('llm_call');
    const ok = hasRequested && hasExecuted && hasLlmCall;
    return {
      ok,
      detail: `Event types: ${[...types].sort().join(', ')}. tool_requested: ${hasRequested}, tool_executed: ${hasExecuted}`,
    };
  });

  // Test 8: Chain integrity
  await test('Audit chain intact after tool operations', async () => {
    const verifyResult = app.verifyAuditChain();
    return {
      ok: verifyResult.intact,
      detail: verifyResult.intact
        ? `Chain intact: ${verifyResult.total} entries`
        : `Chain broken at entry ${verifyResult.brokenAt}`,
    };
  });

  // Test 9: Tool call details in audit
  await test('Audit entries contain tool call details', async () => {
    const history = app.getHistory({ limit: 500 });
    const toolEvents = history.filter((e: any) => e.eventType === 'tool_executed');
    if (toolEvents.length === 0) {
      return { ok: false, detail: 'No tool_executed events found' };
    }
    // Check that at least one event has tool name and success flag
    const hasDetail = toolEvents.some((e: any) => {
      const detail = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail;
      return detail.tool && typeof detail.success === 'boolean';
    });
    return {
      ok: hasDetail,
      detail: `Found ${toolEvents.length} tool_executed events. Details present: ${hasDetail}`,
    };
  });

  // Cleanup
  await app.stop();

  // ── Summary ──
  console.log('\n══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('══════════════════════════════════════');

  console.log('\n| Test | Status | Time | Detail |');
  console.log('|------|--------|------|--------|');
  for (const r of results) {
    console.log(`| ${r.name} | ${r.status} | ${r.durationMs}ms | ${r.detail.slice(0, 100)} |`);
  }

  // Cleanup temp dir
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
