/**
 * Tests for `ved agent` — sub-agent definition and execution manager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateAgentName,
  loadAgent,
  saveAgent,
  listAgents,
  deleteAgent,
  loadHistory,
  AgentProfile,
  AgentRunRecord,
  serializeYaml,
  parseYaml,
  TEMPLATES,
} from './cli-agent.js';

// ── Test helpers ──

let origAgentsDir: string;
let origHistoryDir: string;
let tempDir: string;

/**
 * Override AGENTS_DIR and HISTORY_DIR for tests by patching the module.
 * We use a simpler approach: create agents in a temp dir and test the
 * pure functions directly.
 */
function createTempDirs(): { agentsDir: string; historyDir: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'ved-agent-test-'));
  const agentsDir = join(tempDir, 'agents');
  const historyDir = join(tempDir, 'agent-history');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(historyDir, { recursive: true });
  return { agentsDir, historyDir };
}

function writeAgentYaml(dir: string, name: string, data: Record<string, unknown>): void {
  const yaml = serializeYaml(data);
  writeFileSync(join(dir, `${name}.yaml`), yaml + '\n', 'utf8');
}

function readAgentYaml(dir: string, name: string): Record<string, unknown> {
  const raw = readFileSync(join(dir, `${name}.yaml`), 'utf8');
  return parseYaml(raw);
}

function writeHistory(dir: string, name: string, records: AgentRunRecord[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, `${name}.jsonl`), content, 'utf8');
}

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── validateAgentName ──

describe('validateAgentName', () => {
  it('accepts valid names', () => {
    expect(validateAgentName('researcher')).toBeNull();
    expect(validateAgentName('my-agent')).toBeNull();
    expect(validateAgentName('agent_v2')).toBeNull();
    expect(validateAgentName('A123')).toBeNull();
    expect(validateAgentName('x')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateAgentName('')).toBe('Agent name is required');
  });

  it('rejects names starting with non-letter', () => {
    expect(validateAgentName('123abc')).toContain('must start with a letter');
    expect(validateAgentName('-test')).toContain('must start with a letter');
    expect(validateAgentName('_test')).toContain('must start with a letter');
  });

  it('rejects names with invalid characters', () => {
    expect(validateAgentName('my agent')).toContain('alphanumeric');
    expect(validateAgentName('my.agent')).toContain('alphanumeric');
    expect(validateAgentName('my@agent')).toContain('alphanumeric');
  });

  it('rejects names over 64 characters', () => {
    expect(validateAgentName('a'.repeat(65))).toContain('64 characters');
    expect(validateAgentName('a'.repeat(64))).toBeNull();
  });

  it('rejects reserved names', () => {
    expect(validateAgentName('list')).toContain('reserved');
    expect(validateAgentName('run')).toContain('reserved');
    expect(validateAgentName('delete')).toContain('reserved');
    expect(validateAgentName('help')).toContain('reserved');
    expect(validateAgentName('default')).toContain('reserved');
    expect(validateAgentName('ved')).toContain('reserved');
    expect(validateAgentName('system')).toContain('reserved');
  });

  it('rejects path traversal attempts', () => {
    expect(validateAgentName('a/../b')).not.toBeNull();
    expect(validateAgentName('a/b')).not.toBeNull();
    expect(validateAgentName('a\\b')).not.toBeNull();
  });
});

// ── YAML serializer/parser ──

describe('serializeYaml', () => {
  it('serializes simple key-value pairs', () => {
    const result = serializeYaml({ name: 'test', count: 42, active: true });
    expect(result).toContain('name: test');
    expect(result).toContain('count: 42');
    expect(result).toContain('active: true');
  });

  it('serializes string arrays', () => {
    const result = serializeYaml({ tools: ['web_search', 'file_read'] });
    expect(result).toContain('tools:');
    expect(result).toContain('  - web_search');
    expect(result).toContain('  - file_read');
  });

  it('serializes empty arrays', () => {
    const result = serializeYaml({ tools: [] });
    expect(result).toContain('tools: []');
  });

  it('handles multi-line strings with block scalar', () => {
    const result = serializeYaml({ prompt: 'line 1\nline 2\nline 3' });
    expect(result).toContain('prompt: |');
    expect(result).toContain('  line 1');
    expect(result).toContain('  line 2');
  });

  it('quotes strings with special characters', () => {
    const result = serializeYaml({ val: 'has: colon' });
    expect(result).toContain('"has: colon"');
  });

  it('quotes "true" and "false" strings', () => {
    const result = serializeYaml({ val: 'true' });
    expect(result).toContain('"true"');
  });

  it('skips null and undefined values', () => {
    const result = serializeYaml({ a: 'yes', b: null, c: undefined } as Record<string, unknown>);
    expect(result).toContain('a: yes');
    expect(result).not.toContain('b:');
    expect(result).not.toContain('c:');
  });
});

describe('parseYaml', () => {
  it('parses simple key-value pairs', () => {
    const result = parseYaml('name: test\ncount: 42\nactive: true');
    expect(result.name).toBe('test');
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
  });

  it('parses string arrays', () => {
    const result = parseYaml('tools:\n  - web_search\n  - file_read');
    expect(result.tools).toEqual(['web_search', 'file_read']);
  });

  it('parses empty arrays', () => {
    const result = parseYaml('tools: []');
    expect(result.tools).toEqual([]);
  });

  it('parses block scalar strings', () => {
    const result = parseYaml('prompt: |\n  line 1\n  line 2\n  line 3');
    expect(result.prompt).toBe('line 1\nline 2\nline 3');
  });

  it('parses quoted strings', () => {
    const result = parseYaml('val: "has: colon"');
    expect(result.val).toBe('has: colon');
  });

  it('parses false and true', () => {
    const result = parseYaml('a: true\nb: false');
    expect(result.a).toBe(true);
    expect(result.b).toBe(false);
  });

  it('parses floats', () => {
    const result = parseYaml('val: 3.14');
    expect(result.val).toBe(3.14);
  });

  it('skips comments and blank lines', () => {
    const result = parseYaml('# comment\n\nname: test\n# another comment');
    expect(result.name).toBe('test');
    expect(Object.keys(result)).toEqual(['name']);
  });

  it('round-trips through serialize/parse', () => {
    const original = {
      description: 'A test agent',
      trustTier: 3,
      noRag: false,
      tools: ['web_search', 'vault_search'],
      tags: ['test', 'demo'],
    };
    const yaml = serializeYaml(original);
    const parsed = parseYaml(yaml);
    expect(parsed.description).toBe(original.description);
    expect(parsed.trustTier).toBe(original.trustTier);
    expect(parsed.noRag).toBe(original.noRag);
    expect(parsed.tools).toEqual(original.tools);
    expect(parsed.tags).toEqual(original.tags);
  });
});

// ── Agent CRUD ──

describe('Agent CRUD (file-based)', () => {
  let agentsDir: string;

  beforeEach(() => {
    const dirs = createTempDirs();
    agentsDir = dirs.agentsDir;
  });

  it('writes and reads agent YAML', () => {
    const agent: Record<string, unknown> = {
      description: 'Test researcher',
      systemPrompt: 'You are a researcher.',
      trustTier: 2,
      tools: ['web_search'],
      tags: ['research'],
    };

    writeAgentYaml(agentsDir, 'researcher', agent);
    const read = readAgentYaml(agentsDir, 'researcher');

    expect(read.description).toBe('Test researcher');
    expect(read.systemPrompt).toBe('You are a researcher.');
    expect(read.trustTier).toBe(2);
    expect(read.tools).toEqual(['web_search']);
    expect(read.tags).toEqual(['research']);
  });

  it('handles agent with all fields', () => {
    const agent: Record<string, unknown> = {
      description: 'Full agent',
      systemPrompt: 'Full system prompt.',
      promptProfile: 'custom',
      tools: ['a', 'b'],
      toolsDeny: ['c'],
      trustTier: 4,
      memoryScope: ['entities/', 'concepts/'],
      model: 'gpt-4o',
      maxTurns: 15,
      noRag: true,
      timeout: 60,
      tags: ['full', 'test'],
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-02T00:00:00Z',
    };

    writeAgentYaml(agentsDir, 'full', agent);
    const read = readAgentYaml(agentsDir, 'full');

    expect(read.description).toBe('Full agent');
    expect(read.promptProfile).toBe('custom');
    expect(read.tools).toEqual(['a', 'b']);
    expect(read.toolsDeny).toEqual(['c']);
    expect(read.trustTier).toBe(4);
    expect(read.memoryScope).toEqual(['entities/', 'concepts/']);
    expect(read.model).toBe('gpt-4o');
    expect(read.maxTurns).toBe(15);
    expect(read.noRag).toBe(true);
    expect(read.timeout).toBe(60);
    expect(read.tags).toEqual(['full', 'test']);
  });

  it('handles agent with empty tools (all allowed)', () => {
    writeAgentYaml(agentsDir, 'open', { description: 'Open', tools: [] });
    const read = readAgentYaml(agentsDir, 'open');
    expect(read.tools).toEqual([]);
  });

  it('handles agent with no optional fields', () => {
    writeAgentYaml(agentsDir, 'minimal', { description: 'Bare minimum' });
    const read = readAgentYaml(agentsDir, 'minimal');
    expect(read.description).toBe('Bare minimum');
  });
});

// ── History JSONL ──

describe('History JSONL', () => {
  let historyDir: string;

  beforeEach(() => {
    const dirs = createTempDirs();
    historyDir = dirs.historyDir;
  });

  it('writes and reads history records', () => {
    const records: AgentRunRecord[] = [
      {
        timestamp: '2026-03-19T10:00:00Z',
        agent: 'researcher',
        query: 'What is Ved?',
        responseSummary: 'Ved is a personal AI assistant...',
        durationMs: 1234,
        toolsUsed: ['web_search'],
        status: 'success',
      },
      {
        timestamp: '2026-03-19T11:00:00Z',
        agent: 'researcher',
        query: 'Explain the audit system',
        responseSummary: 'The audit system uses hash chains...',
        durationMs: 2345,
        toolsUsed: [],
        status: 'success',
      },
    ];

    writeHistory(historyDir, 'researcher', records);

    const raw = readFileSync(join(historyDir, 'researcher.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].query).toBe('What is Ved?');
    expect(parsed[1].status).toBe('success');
  });

  it('handles error records', () => {
    const records: AgentRunRecord[] = [
      {
        timestamp: '2026-03-19T12:00:00Z',
        agent: 'coder',
        query: 'Fix the bug',
        responseSummary: '',
        durationMs: 500,
        toolsUsed: [],
        status: 'error',
        error: 'LLM connection failed',
      },
    ];

    writeHistory(historyDir, 'coder', records);
    const raw = readFileSync(join(historyDir, 'coder.jsonl'), 'utf8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('LLM connection failed');
  });

  it('handles timeout records', () => {
    const record: AgentRunRecord = {
      timestamp: '2026-03-19T13:00:00Z',
      agent: 'slow',
      query: 'Process this huge dataset',
      responseSummary: '',
      durationMs: 120000,
      toolsUsed: ['file_read'],
      status: 'timeout',
    };

    writeHistory(historyDir, 'slow', [record]);
    const raw = readFileSync(join(historyDir, 'slow.jsonl'), 'utf8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed.status).toBe('timeout');
    expect(parsed.durationMs).toBe(120000);
  });
});

// ── Templates ──

describe('Built-in templates', () => {
  it('has expected templates', () => {
    expect(Object.keys(TEMPLATES)).toContain('researcher');
    expect(Object.keys(TEMPLATES)).toContain('coder');
    expect(Object.keys(TEMPLATES)).toContain('writer');
    expect(Object.keys(TEMPLATES)).toContain('analyst');
    expect(Object.keys(TEMPLATES)).toContain('guardian');
  });

  it('all templates have required fields', () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl.description, `${name} missing description`).toBeTruthy();
      expect(tpl.systemPrompt, `${name} missing systemPrompt`).toBeTruthy();
      expect(tpl.tags, `${name} missing tags`).toBeDefined();
    }
  });

  it('researcher template has search tools', () => {
    const r = TEMPLATES.researcher;
    expect(r.tools).toContain('web_search');
    expect(r.trustTier).toBe(2);
  });

  it('guardian template has highest trust', () => {
    expect(TEMPLATES.guardian.trustTier).toBe(4);
  });

  it('coder template allows code tools', () => {
    const c = TEMPLATES.coder;
    expect(c.tools).toContain('shell_exec');
    expect(c.trustTier).toBe(3);
  });

  it('templates serialize cleanly', () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      const yaml = serializeYaml(tpl as unknown as Record<string, unknown>);
      const parsed = parseYaml(yaml);
      expect(parsed.description, `${name} round-trip failed`).toBe(tpl.description);
    }
  });
});

// ── Name Validation Edge Cases ──

describe('validateAgentName edge cases', () => {
  it('accepts max length name', () => {
    expect(validateAgentName('a'.repeat(64))).toBeNull();
  });

  it('rejects just over max length', () => {
    expect(validateAgentName('a'.repeat(65))).toContain('64');
  });

  it('reserved names are case-insensitive', () => {
    expect(validateAgentName('List')).toContain('reserved');
    expect(validateAgentName('RUN')).toContain('reserved');
    expect(validateAgentName('Help')).toContain('reserved');
  });

  it('accepts similar-to-reserved but valid names', () => {
    expect(validateAgentName('lister')).toBeNull();
    expect(validateAgentName('runner')).toBeNull();
    expect(validateAgentName('helper')).toBeNull();
    expect(validateAgentName('my-list')).toBeNull();
  });

  it('rejects names with unicode', () => {
    expect(validateAgentName('café')).not.toBeNull();
    expect(validateAgentName('über')).not.toBeNull();
  });

  it('rejects single special characters', () => {
    expect(validateAgentName('.')).not.toBeNull();
    expect(validateAgentName('-')).not.toBeNull();
    expect(validateAgentName('_')).not.toBeNull();
  });
});

// ── YAML edge cases ──

describe('YAML parser edge cases', () => {
  it('handles single-quoted strings', () => {
    const result = parseYaml("val: 'hello world'");
    expect(result.val).toBe('hello world');
  });

  it('handles negative numbers', () => {
    const result = parseYaml('val: -5');
    expect(result.val).toBe(-5);
  });

  it('handles zero', () => {
    const result = parseYaml('val: 0');
    expect(result.val).toBe(0);
  });

  it('handles empty string value', () => {
    // Empty value after colon-space is treated as empty string or list marker
    const result = parseYaml('val: ""');
    expect(result.val).toBe('');
  });

  it('handles quoted list items', () => {
    const result = parseYaml('items:\n  - "has: colon"\n  - "has, comma"');
    expect(result.items).toEqual(['has: colon', 'has, comma']);
  });

  it('ignores malformed lines gracefully', () => {
    const result = parseYaml('valid: yes\nthis is not yaml\nalso_valid: true');
    expect(result.valid).toBe('yes');
    expect(result.also_valid).toBe(true);
  });
});

// ── AgentProfile serialization round-trip ──

describe('AgentProfile round-trip', () => {
  it('full profile survives serialize → parse', () => {
    const profile: Record<string, unknown> = {
      description: 'Research agent for deep analysis',
      systemPrompt: 'You are a research assistant.\nAlways cite sources.\nBe thorough.',
      trustTier: 3,
      model: 'claude-sonnet-4-5-20250514',
      maxTurns: 12,
      timeout: 90,
      noRag: false,
      tools: ['web_search', 'web_fetch', 'vault_search'],
      toolsDeny: ['shell_exec', 'file_write'],
      memoryScope: ['entities/', 'concepts/'],
      tags: ['research', 'deep-dive'],
      created: '2026-03-19T14:00:00.000Z',
      modified: '2026-03-19T14:30:00.000Z',
    };

    const yaml = serializeYaml(profile);
    const parsed = parseYaml(yaml);

    expect(parsed.description).toBe(profile.description);
    expect(parsed.trustTier).toBe(profile.trustTier);
    expect(parsed.model).toBe(profile.model);
    expect(parsed.maxTurns).toBe(profile.maxTurns);
    expect(parsed.timeout).toBe(profile.timeout);
    expect(parsed.noRag).toBe(profile.noRag);
    expect(parsed.tools).toEqual(profile.tools);
    expect(parsed.toolsDeny).toEqual(profile.toolsDeny);
    expect(parsed.memoryScope).toEqual(profile.memoryScope);
    expect(parsed.tags).toEqual(profile.tags);
  });

  it('minimal profile survives round-trip', () => {
    const profile = { description: 'Simple agent' };
    const yaml = serializeYaml(profile);
    const parsed = parseYaml(yaml);
    expect(parsed.description).toBe('Simple agent');
  });

  it('profile with multi-line system prompt survives', () => {
    const profile = {
      description: 'Multi-line test',
      systemPrompt: 'Line 1\nLine 2\nLine 3',
    };
    const yaml = serializeYaml(profile);
    const parsed = parseYaml(yaml);
    expect(parsed.systemPrompt).toBe('Line 1\nLine 2\nLine 3');
  });
});

// ── History limits ──

describe('History record format', () => {
  it('records contain all required fields', () => {
    const record: AgentRunRecord = {
      timestamp: new Date().toISOString(),
      agent: 'test',
      query: 'test query',
      responseSummary: 'test response',
      durationMs: 100,
      toolsUsed: [],
      status: 'success',
    };

    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as AgentRunRecord;

    expect(parsed.timestamp).toBeTruthy();
    expect(parsed.agent).toBe('test');
    expect(parsed.query).toBe('test query');
    expect(parsed.responseSummary).toBe('test response');
    expect(parsed.durationMs).toBe(100);
    expect(parsed.toolsUsed).toEqual([]);
    expect(parsed.status).toBe('success');
    expect(parsed.error).toBeUndefined();
  });

  it('error records include error field', () => {
    const record: AgentRunRecord = {
      timestamp: new Date().toISOString(),
      agent: 'fail',
      query: 'bad query',
      responseSummary: '',
      durationMs: 50,
      toolsUsed: [],
      status: 'error',
      error: 'Something went wrong',
    };

    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as AgentRunRecord;
    expect(parsed.error).toBe('Something went wrong');
  });

  it('tool list is preserved', () => {
    const record: AgentRunRecord = {
      timestamp: new Date().toISOString(),
      agent: 'multi-tool',
      query: 'complex task',
      responseSummary: 'did stuff',
      durationMs: 5000,
      toolsUsed: ['web_search', 'file_read', 'shell_exec'],
      status: 'success',
    };

    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as AgentRunRecord;
    expect(parsed.toolsUsed).toEqual(['web_search', 'file_read', 'shell_exec']);
  });
});
