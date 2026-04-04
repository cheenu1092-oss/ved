import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const schemaPath = resolve(__dirname, '..', 'config.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

function makeAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function makeValidConfig() {
  return {
    name: 'Ved',
    version: '1.0.0',
    dbPath: '~/.ved/ved.db',
    logLevel: 'info',
    logFormat: 'pretty',
    logFile: null,
    llm: {
      provider: 'ollama',
      model: 'qwen3:1.7b',
      apiKey: null,
      baseUrl: null,
      maxTokensPerMessage: 4096,
      maxTokensPerSession: 100000,
      temperature: 0.7,
      systemPromptPath: null,
    },
    memory: {
      vaultPath: '~/ved-vault',
      workingMemoryMaxTokens: 8000,
      ragContextMaxTokens: 2000,
      compressionThreshold: 6000,
      sessionIdleMinutes: 30,
      gitEnabled: true,
      gitAutoCommitIntervalMinutes: 5,
    },
    trust: {
      ownerIds: ['user123'],
      tribeIds: [],
      knownIds: [],
      defaultTier: 1,
      approvalTimeoutMs: 300000,
      maxToolCallsPerMessage: 10,
      maxAgenticLoops: 5,
    },
    audit: {
      anchorInterval: 100,
      hmacSecret: null,
    },
    rag: {
      vectorTopK: 10,
      ftsTopK: 10,
      graphMaxDepth: 2,
      graphMaxNodes: 20,
      maxContextTokens: 2000,
      rrfK: 60,
      embedding: {
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434',
        batchSize: 32,
        dimensions: 768,
      },
      chunking: {
        maxTokens: 1024,
        minTokens: 64,
        frontmatterPrefix: true,
      },
    },
    channels: [],
    mcp: {
      servers: [],
    },
  };
}

describe('config.schema.json', () => {
  it('is valid JSON Schema draft-07', () => {
    const ajv = makeAjv();
    const valid = ajv.validateSchema(schema);
    expect(valid).toBe(true);
  });

  it('accepts a fully-specified valid config', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    const valid = validate(config);
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('accepts minimal valid config (required fields only)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      llm: { provider: 'ollama', model: 'qwen3:1.7b' },
      memory: { vaultPath: '~/ved-vault' },
      trust: { ownerIds: ['user1'] },
    };
    const valid = validate(config);
    expect(valid).toBe(true);
  });

  // --- Missing required fields ---

  it('rejects config missing llm', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      memory: { vaultPath: '~/v' },
      trust: { ownerIds: ['u'] },
    };
    expect(validate(config)).toBe(false);
    expect(validate.errors!.some((e: any) => e.params?.missingProperty === 'llm')).toBe(true);
  });

  it('rejects config missing memory', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      llm: { provider: 'ollama', model: 'm' },
      trust: { ownerIds: ['u'] },
    };
    expect(validate(config)).toBe(false);
    expect(validate.errors!.some((e: any) => e.params?.missingProperty === 'memory')).toBe(true);
  });

  it('rejects config missing trust', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      llm: { provider: 'ollama', model: 'm' },
      memory: { vaultPath: '~/v' },
    };
    expect(validate(config)).toBe(false);
    expect(validate.errors!.some((e: any) => e.params?.missingProperty === 'trust')).toBe(true);
  });

  it('rejects llm missing provider', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      llm: { model: 'm' },
      memory: { vaultPath: '~/v' },
      trust: { ownerIds: ['u'] },
    };
    expect(validate(config)).toBe(false);
  });

  it('rejects llm missing model', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      llm: { provider: 'ollama' },
      memory: { vaultPath: '~/v' },
      trust: { ownerIds: ['u'] },
    };
    expect(validate(config)).toBe(false);
  });

  it('rejects trust with empty ownerIds', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = {
      llm: { provider: 'ollama', model: 'm' },
      memory: { vaultPath: '~/v' },
      trust: { ownerIds: [] },
    };
    expect(validate(config)).toBe(false);
  });

  // --- Invalid enum values ---

  it('rejects invalid llm provider', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.llm.provider = 'gemini' as any;
    expect(validate(config)).toBe(false);
  });

  it('rejects invalid logLevel', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    (config as any).logLevel = 'verbose';
    expect(validate(config)).toBe(false);
  });

  it('rejects invalid logFormat', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    (config as any).logFormat = 'yaml';
    expect(validate(config)).toBe(false);
  });

  it('rejects invalid defaultTier', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.trust.defaultTier = 5 as any;
    expect(validate(config)).toBe(false);
  });

  it('rejects invalid mcp transport', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.mcp.servers = [{ name: 'test', transport: 'grpc' as any, enabled: true }];
    expect(validate(config)).toBe(false);
  });

  // --- Type mismatches ---

  it('rejects string where number expected (temperature)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    (config.llm as any).temperature = 'hot';
    expect(validate(config)).toBe(false);
  });

  it('rejects number where string expected (model)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    (config.llm as any).model = 42;
    expect(validate(config)).toBe(false);
  });

  it('rejects string where boolean expected (gitEnabled)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    (config.memory as any).gitEnabled = 'yes';
    expect(validate(config)).toBe(false);
  });

  it('rejects string where array expected (ownerIds)', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    (config.trust as any).ownerIds = 'user123';
    expect(validate(config)).toBe(false);
  });

  // --- Boundary values ---

  it('rejects temperature below 0', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.llm.temperature = -0.1;
    expect(validate(config)).toBe(false);
  });

  it('rejects temperature above 2', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.llm.temperature = 2.1;
    expect(validate(config)).toBe(false);
  });

  it('rejects maxTokensPerMessage below minimum', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.llm.maxTokensPerMessage = 10;
    expect(validate(config)).toBe(false);
  });

  it('rejects approvalTimeoutMs below minimum', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.trust.approvalTimeoutMs = 1000;
    expect(validate(config)).toBe(false);
  });

  // --- MCP server validation ---

  it('accepts valid stdio mcp server', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.mcp.servers = [{
      name: 'calc',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      enabled: true,
    }];
    expect(validate(config)).toBe(true);
  });

  it('accepts valid http mcp server', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.mcp.servers = [{
      name: 'remote',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      enabled: true,
    }];
    expect(validate(config)).toBe(true);
  });

  // --- Channel validation ---

  it('accepts valid channel config', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = makeValidConfig();
    config.channels = [{
      type: 'discord',
      enabled: true,
      config: { token: 'abc', guildId: '123' },
    }];
    expect(validate(config)).toBe(true);
  });

  // --- additionalProperties ---

  it('rejects unknown top-level properties', () => {
    const ajv = makeAjv();
    const validate = ajv.compile(schema);
    const config = { ...makeValidConfig(), unknownField: 'bad' };
    expect(validate(config)).toBe(false);
  });

  // --- All four providers accepted ---

  for (const provider of ['anthropic', 'openai', 'openrouter', 'ollama']) {
    it(`accepts provider: ${provider}`, () => {
      const ajv = makeAjv();
      const validate = ajv.compile(schema);
      const config = makeValidConfig();
      config.llm.provider = provider as any;
      expect(validate(config)).toBe(true);
    });
  }
});
