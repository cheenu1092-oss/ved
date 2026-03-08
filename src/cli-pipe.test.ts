/**
 * Tests for `ved pipe` — Multi-step pipeline execution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePipelineYaml,
  buildInlinePipeline,
  validatePipeline,
  parsePipeArgs,
  formatPipelineResult,
  executeShellStep,
  savePipeline,
  loadSavedPipeline,
  listSavedPipelines,
  deleteSavedPipeline,
  type PipelineDefinition,
  type PipelineResult,
  type StepResult,
} from './cli-pipe.js';

// ── parsePipelineYaml ──

describe('parsePipelineYaml', () => {
  it('parses a basic pipeline with queries', () => {
    const yaml = `
name: test-pipe
description: A test pipeline
steps:
  - query: "Summarize this"
  - query: "Extract key points"
  - query: "Translate to Spanish"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.name).toBe('test-pipe');
    expect(pipeline.description).toBe('A test pipeline');
    expect(pipeline.steps).toHaveLength(3);
    expect(pipeline.steps[0].query).toBe('Summarize this');
    expect(pipeline.steps[1].query).toBe('Extract key points');
    expect(pipeline.steps[2].query).toBe('Translate to Spanish');
  });

  it('parses mixed query and shell steps', () => {
    const yaml = `
name: mixed
steps:
  - query: "Generate a list"
  - shell: "sort"
  - query: "Format as markdown"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.steps).toHaveLength(3);
    expect(pipeline.steps[0].query).toBe('Generate a list');
    expect(pipeline.steps[1].shell).toBe('sort');
    expect(pipeline.steps[2].query).toBe('Format as markdown');
  });

  it('parses step options', () => {
    const yaml = `
name: with-options
model: gpt-4o
timeout: 60
steps:
  - query: "Analyze"
    file: input.txt
    model: claude-3
    system: "You are an analyst"
    no-rag: true
    no-tools: true
    timeout: 30
    label: analysis-step
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.model).toBe('gpt-4o');
    expect(pipeline.timeout).toBe(60);
    expect(pipeline.steps[0].query).toBe('Analyze');
    expect(pipeline.steps[0].file).toBe('input.txt');
    expect(pipeline.steps[0].model).toBe('claude-3');
    expect(pipeline.steps[0].system).toBe('You are an analyst');
    expect(pipeline.steps[0]['no-rag']).toBe(true);
    expect(pipeline.steps[0]['no-tools']).toBe(true);
    expect(pipeline.steps[0].timeout).toBe(30);
    expect(pipeline.steps[0].label).toBe('analysis-step');
  });

  it('skips comments and empty lines', () => {
    const yaml = `
# This is a comment
name: commented

# More comments
steps:
  # Step comment
  - query: "Hello"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.name).toBe('commented');
    expect(pipeline.steps).toHaveLength(1);
    expect(pipeline.steps[0].query).toBe('Hello');
  });

  it('handles quoted values', () => {
    const yaml = `
name: "quoted-name"
steps:
  - query: 'single quoted'
  - query: "double quoted"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.name).toBe('quoted-name');
    expect(pipeline.steps[0].query).toBe('single quoted');
    expect(pipeline.steps[1].query).toBe('double quoted');
  });

  it('handles empty steps list', () => {
    const yaml = `
name: empty
steps:
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.name).toBe('empty');
    expect(pipeline.steps).toHaveLength(0);
  });

  it('handles system prompt with default', () => {
    const yaml = `
name: with-defaults
system: "You are helpful"
steps:
  - query: "Hello"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.system).toBe('You are helpful');
  });
});

// ── buildInlinePipeline ──

describe('buildInlinePipeline', () => {
  it('converts queries to pipeline steps', () => {
    const pipeline = buildInlinePipeline(['summarize', 'translate']);
    expect(pipeline.steps).toHaveLength(2);
    expect(pipeline.steps[0].query).toBe('summarize');
    expect(pipeline.steps[1].query).toBe('translate');
  });

  it('treats ! prefix as shell commands', () => {
    const pipeline = buildInlinePipeline(['summarize', '!wc -w', 'format']);
    expect(pipeline.steps).toHaveLength(3);
    expect(pipeline.steps[0].query).toBe('summarize');
    expect(pipeline.steps[1].shell).toBe('wc -w');
    expect(pipeline.steps[1].query).toBeUndefined();
    expect(pipeline.steps[2].query).toBe('format');
  });

  it('handles single step', () => {
    const pipeline = buildInlinePipeline(['hello']);
    expect(pipeline.steps).toHaveLength(1);
    expect(pipeline.steps[0].query).toBe('hello');
  });

  it('handles empty array', () => {
    const pipeline = buildInlinePipeline([]);
    expect(pipeline.steps).toHaveLength(0);
  });
});

// ── validatePipeline ──

describe('validatePipeline', () => {
  it('returns no errors for valid pipeline', () => {
    const pipeline: PipelineDefinition = {
      steps: [
        { query: 'step 1' },
        { shell: 'sort' },
        { query: 'step 3' },
      ],
    };
    expect(validatePipeline(pipeline)).toEqual([]);
  });

  it('errors on empty steps', () => {
    const errors = validatePipeline({ steps: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no steps');
  });

  it('errors on step with neither query nor shell', () => {
    const errors = validatePipeline({ steps: [{}] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must have either 'query' or 'shell'");
  });

  it('errors on step with both query and shell', () => {
    const errors = validatePipeline({ steps: [{ query: 'q', shell: 's' }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot have both 'query' and 'shell'");
  });

  it('errors on file with shell step', () => {
    const errors = validatePipeline({ steps: [{ shell: 'cat', file: 'x.txt' }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'file' only makes sense with 'query'");
  });

  it('errors on invalid timeout', () => {
    const errors = validatePipeline({ steps: [{ query: 'q', timeout: -5 }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('timeout must be a positive number');
  });

  it('errors on NaN timeout', () => {
    const errors = validatePipeline({ steps: [{ query: 'q', timeout: NaN }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('timeout must be a positive number');
  });

  it('reports multiple errors', () => {
    const errors = validatePipeline({
      steps: [
        {},
        { query: 'q', shell: 's' },
        { query: 'ok' },
      ],
    });
    expect(errors).toHaveLength(2);
  });
});

// ── parsePipeArgs ──

describe('parsePipeArgs', () => {
  it('defaults to list with no args', () => {
    const result = parsePipeArgs([]);
    expect(result.subcommand).toBe('list');
  });

  it('parses list subcommand', () => {
    expect(parsePipeArgs(['list']).subcommand).toBe('list');
    expect(parsePipeArgs(['ls']).subcommand).toBe('list');
  });

  it('parses show subcommand', () => {
    const result = parsePipeArgs(['show', 'my-pipe']);
    expect(result.subcommand).toBe('show');
    expect(result.pipelineName).toBe('my-pipe');
  });

  it('parses delete subcommand', () => {
    const result = parsePipeArgs(['delete', 'my-pipe']);
    expect(result.subcommand).toBe('delete');
    expect(result.pipelineName).toBe('my-pipe');
  });

  it('parses rm alias for delete', () => {
    const result = parsePipeArgs(['rm', 'my-pipe']);
    expect(result.subcommand).toBe('delete');
    expect(result.pipelineName).toBe('my-pipe');
  });

  it('parses save subcommand with file and description', () => {
    const result = parsePipeArgs(['save', 'my-pipe', '-f', 'pipe.yaml', '-d', 'My description']);
    expect(result.subcommand).toBe('save');
    expect(result.pipelineName).toBe('my-pipe');
    expect(result.pipelineFile).toBe('pipe.yaml');
    expect(result.description).toBe('My description');
  });

  it('parses inline queries', () => {
    const result = parsePipeArgs(['summarize', 'translate', 'format']);
    expect(result.subcommand).toBe('run');
    expect(result.inlineQueries).toEqual(['summarize', 'translate', 'format']);
  });

  it('parses file flag', () => {
    const result = parsePipeArgs(['-f', 'pipeline.yaml']);
    expect(result.subcommand).toBe('run');
    expect(result.pipelineFile).toBe('pipeline.yaml');
  });

  it('parses output format flags', () => {
    expect(parsePipeArgs(['--json', 'q']).format).toBe('json');
    expect(parsePipeArgs(['--raw', 'q']).format).toBe('raw');
  });

  it('parses verbose flag', () => {
    expect(parsePipeArgs(['-v', 'q']).verbose).toBe(true);
    expect(parsePipeArgs(['--verbose', 'q']).verbose).toBe(true);
  });

  it('parses dry-run flag', () => {
    expect(parsePipeArgs(['-n', 'q']).dryRun).toBe(true);
    expect(parsePipeArgs(['--dry-run', 'q']).dryRun).toBe(true);
  });

  it('parses run subcommand with name', () => {
    // This will try to load a saved pipeline and fall back to inline
    const result = parsePipeArgs(['run', '-f', 'pipe.yaml']);
    expect(result.subcommand).toBe('run');
    expect(result.pipelineFile).toBe('pipe.yaml');
  });
});

// ── executeShellStep ──

describe('executeShellStep', () => {
  it('pipes input through a command', () => {
    const result = executeShellStep('cat', 'hello world');
    expect(result.output).toBe('hello world');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stdout from command', () => {
    const result = executeShellStep('echo "test output"', '');
    expect(result.output).toBe('test output');
  });

  it('pipes input to wc', () => {
    const result = executeShellStep('wc -l', 'line1\nline2\nline3\n');
    expect(result.output.trim()).toBe('3');
  });

  it('chains commands', () => {
    const result = executeShellStep('tr a-z A-Z', 'hello');
    expect(result.output).toBe('HELLO');
  });

  it('throws on failed command', () => {
    expect(() => {
      executeShellStep('false', '');
    }).toThrow('Shell command failed');
  });

  it('throws on nonexistent command', () => {
    expect(() => {
      executeShellStep('nonexistent_command_xyz', '');
    }).toThrow();
  });

  it('handles empty input', () => {
    const result = executeShellStep('echo done', '');
    expect(result.output).toBe('done');
  });

  it('handles sort command', () => {
    const result = executeShellStep('sort', 'cherry\napple\nbanana');
    expect(result.output).toBe('apple\nbanana\ncherry');
  });
});

// ── formatPipelineResult ──

describe('formatPipelineResult', () => {
  const makeResult = (overrides?: Partial<PipelineResult>): PipelineResult => ({
    name: 'test-pipe',
    steps: [
      { index: 0, label: 'query: summarize', type: 'query', output: 'Summary here', durationMs: 500, success: true },
      { index: 1, label: 'shell: wc', type: 'shell', output: '42', durationMs: 10, success: true },
    ],
    totalDurationMs: 510,
    success: true,
    finalOutput: '42',
    ...overrides,
  });

  it('formats as raw (final output only)', () => {
    const output = formatPipelineResult(makeResult(), 'raw');
    expect(output).toBe('42');
  });

  it('formats as JSON', () => {
    const output = formatPipelineResult(makeResult(), 'json');
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe('test-pipe');
    expect(parsed.success).toBe(true);
    expect(parsed.totalDurationMs).toBe(510);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.finalOutput).toBe('42');
  });

  it('formats as text with step info', () => {
    const output = formatPipelineResult(makeResult(), 'text');
    expect(output).toContain('Pipeline: test-pipe');
    expect(output).toContain('✅ Step 1');
    expect(output).toContain('✅ Step 2');
    expect(output).toContain('Pipeline complete');
    expect(output).toContain('42');
  });

  it('shows failure info', () => {
    const result = makeResult({
      success: false,
      steps: [
        { index: 0, label: 'query: fail', type: 'query', output: '', durationMs: 100, success: false, error: 'LLM timeout' },
      ],
    });
    const output = formatPipelineResult(result, 'text');
    expect(output).toContain('❌ Step 1');
    expect(output).toContain('LLM timeout');
    expect(output).toContain('Pipeline failed');
  });

  it('JSON includes error field', () => {
    const result = makeResult({
      success: false,
      steps: [
        { index: 0, label: 'q', type: 'query', output: '', durationMs: 0, success: false, error: 'oops' },
      ],
    });
    const parsed = JSON.parse(formatPipelineResult(result, 'json'));
    expect(parsed.steps[0].error).toBe('oops');
    expect(parsed.success).toBe(false);
  });

  it('shows duration in seconds for long steps', () => {
    const result = makeResult({
      totalDurationMs: 5000,
      steps: [
        { index: 0, label: 'slow', type: 'query', output: 'done', durationMs: 5000, success: true },
      ],
    });
    const output = formatPipelineResult(result, 'text');
    expect(output).toContain('5.0s');
  });
});

// ── Saved Pipelines (filesystem) ──

describe('saved pipelines', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ved-pipe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads a pipeline', () => {
    const pipeline: PipelineDefinition = {
      name: 'test-save',
      description: 'Test saving',
      steps: [
        { query: 'step 1' },
        { query: 'step 2' },
      ],
    };

    const filepath = savePipeline('test-save', pipeline, tempDir);
    expect(existsSync(filepath)).toBe(true);

    const loaded = loadSavedPipeline('test-save', tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('test-save');
    expect(loaded!.steps).toHaveLength(2);
  });

  it('lists saved pipelines', () => {
    savePipeline('alpha', { name: 'alpha', steps: [{ query: 'a' }] }, tempDir);
    savePipeline('beta', { name: 'beta', description: 'B pipe', steps: [{ query: 'b' }, { shell: 'sort' }] }, tempDir);

    const list = listSavedPipelines(tempDir);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('alpha');
    expect(list[1].name).toBe('beta');
    expect(list[1].stepCount).toBe(2);
    expect(list[1].description).toBe('B pipe');
  });

  it('deletes a saved pipeline', () => {
    savePipeline('to-delete', { steps: [{ query: 'x' }] }, tempDir);
    expect(listSavedPipelines(tempDir)).toHaveLength(1);

    const deleted = deleteSavedPipeline('to-delete', tempDir);
    expect(deleted).toBe(true);
    expect(listSavedPipelines(tempDir)).toHaveLength(0);
  });

  it('returns false when deleting nonexistent pipeline', () => {
    expect(deleteSavedPipeline('nonexistent', tempDir)).toBe(false);
  });

  it('returns null when loading nonexistent pipeline', () => {
    expect(loadSavedPipeline('nonexistent', tempDir)).toBeNull();
  });

  it('sanitizes pipeline names', () => {
    const filepath = savePipeline('My Pipeline!@#', { steps: [{ query: 'q' }] }, tempDir);
    expect(filepath).toContain('my-pipeline---');
  });

  it('saves step options correctly', () => {
    const pipeline: PipelineDefinition = {
      name: 'opts',
      model: 'gpt-4o',
      timeout: 60,
      steps: [
        { query: 'q1', file: 'f.txt', model: 'claude', 'no-rag': true, 'no-tools': true, timeout: 30 },
        { shell: 'sort', label: 'sorter' },
      ],
    };

    savePipeline('opts', pipeline, tempDir);
    const loaded = loadSavedPipeline('opts', tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.model).toBe('gpt-4o');
    expect(loaded!.timeout).toBe(60);
    expect(loaded!.steps[0].file).toBe('f.txt');
    expect(loaded!.steps[0].model).toBe('claude');
    expect(loaded!.steps[0]['no-rag']).toBe(true);
    expect(loaded!.steps[0]['no-tools']).toBe(true);
    expect(loaded!.steps[1].label).toBe('sorter');
  });

  it('returns empty list when pipelines dir does not exist', () => {
    const nonexistent = join(tmpdir(), `ved-nonexistent-${Date.now()}`);
    expect(listSavedPipelines(nonexistent)).toEqual([]);
  });
});

// ── Edge Cases ──

describe('edge cases', () => {
  it('parsePipelineYaml handles colons in values', () => {
    const yaml = `
name: test
steps:
  - query: "What is the time: now?"
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.steps[0].query).toBe('What is the time: now?');
  });

  it('parsePipelineYaml handles query with no value (dash only)', () => {
    const yaml = `
name: test
steps:
  -
`;
    const pipeline = parsePipelineYaml(yaml);
    // Should create an empty step
    expect(pipeline.steps).toHaveLength(1);
  });

  it('buildInlinePipeline handles !command with spaces', () => {
    const pipeline = buildInlinePipeline(['!grep -i hello']);
    expect(pipeline.steps[0].shell).toBe('grep -i hello');
  });

  it('shell step handles multiline output', () => {
    const result = executeShellStep('printf "line1\\nline2\\nline3"', '');
    expect(result.output).toBe('line1\nline2\nline3');
  });

  it('shell step pipes large input', () => {
    const bigInput = 'x'.repeat(10000);
    const result = executeShellStep('wc -c', bigInput);
    expect(parseInt(result.output.trim())).toBe(10000);
  });
});
