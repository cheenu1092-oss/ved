/**
 * `ved pipe` — Multi-step pipeline execution.
 *
 * Chains multiple queries (and shell commands) into a pipeline where
 * each step receives the previous step's output as context.
 *
 * Usage:
 *   ved pipe "summarize" "extract key points" "translate to Spanish"
 *   ved pipe -f pipeline.yaml
 *   ved pipe -f pipeline.yaml --dry-run
 *   ved pipe list
 *   ved pipe show <name>
 *   ved pipe save <name> -f pipeline.yaml
 *   ved pipe delete <name>
 *   ved pipe run <name>
 *
 * Aliases: ved pipeline, ved chain
 *
 * Pipeline YAML format:
 *   name: my-pipeline
 *   description: Summarize and translate
 *   steps:
 *     - query: "Summarize this"
 *       file: input.txt          # optional: attach file
 *       model: gpt-4o            # optional: override model
 *       system: "You are..."     # optional: system prompt
 *       no-rag: true             # optional: skip RAG
 *       no-tools: true           # optional: disable tools
 *     - query: "Extract key points from the above"
 *     - shell: "wc -w"           # pipe through shell command
 *     - query: "Format as markdown list"
 *
 * Exit codes:
 *   0 — Success
 *   1 — Error (config, LLM, pipeline, etc.)
 *   2 — Timeout
 *   3 — No steps / invalid pipeline
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { ulid } from 'ulid';
import { createApp, type VedApp } from './app.js';
import { getConfigDir } from './core/config.js';
import type { VedMessage } from './types/index.js';

const VERSION = '0.1.0';

// ── Types ──

export interface PipelineStep {
  /** LLM query (mutually exclusive with shell) */
  query?: string;
  /** Shell command — receives prev output on stdin, captures stdout */
  shell?: string;
  /** File to attach as context */
  file?: string;
  /** LLM model override */
  model?: string;
  /** System prompt override */
  system?: string;
  /** Skip RAG enrichment */
  'no-rag'?: boolean;
  /** Disable tool execution */
  'no-tools'?: boolean;
  /** Step label for display */
  label?: string;
  /** Timeout in seconds (default: 120) */
  timeout?: number;
}

export interface PipelineDefinition {
  /** Pipeline name */
  name?: string;
  /** Human description */
  description?: string;
  /** Ordered steps */
  steps: PipelineStep[];
  /** Default model for all steps */
  model?: string;
  /** Default system prompt for all steps */
  system?: string;
  /** Default timeout per step (seconds) */
  timeout?: number;
}

export interface StepResult {
  index: number;
  label: string;
  type: 'query' | 'shell';
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface PipelineResult {
  name?: string;
  steps: StepResult[];
  totalDurationMs: number;
  success: boolean;
  finalOutput: string;
}

// ── Parsing ──

/**
 * Get the pipelines storage directory.
 * Accepts optional override for testing.
 */
export function getPipelinesDir(override?: string): string {
  if (override) return override;
  return join(getConfigDir(), 'pipelines');
}

/**
 * Parse a YAML-like pipeline definition.
 * Supports real YAML via simple key: value parsing (no dependency needed).
 */
export function parsePipelineYaml(content: string): PipelineDefinition {
  const lines = content.split('\n');
  const pipeline: PipelineDefinition = { steps: [] };
  let currentStep: PipelineStep | null = null;
  let inSteps = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Top-level keys
    if (!line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-')) {
      inSteps = false;
      const [key, ...rest] = trimmed.split(':');
      const value = rest.join(':').trim().replace(/^["']|["']$/g, '');

      if (key === 'name') pipeline.name = value;
      else if (key === 'description') pipeline.description = value;
      else if (key === 'model') pipeline.model = value;
      else if (key === 'system') pipeline.system = value;
      else if (key === 'timeout') pipeline.timeout = parseInt(value, 10);
      else if (key === 'steps') inSteps = true;
      continue;
    }

    if (!inSteps) continue;

    // New step (starts with -)
    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (currentStep) pipeline.steps.push(currentStep);
      currentStep = {};

      // Inline key on same line as dash
      const afterDash = trimmed.slice(2).trim();
      if (afterDash) {
        parseStepKeyValue(currentStep, afterDash);
      }
      continue;
    }

    // Step properties (indented under a -)
    if (currentStep && (line.startsWith('    ') || line.startsWith('\t\t') || line.startsWith('  '))) {
      parseStepKeyValue(currentStep, trimmed);
    }
  }

  // Push final step
  if (currentStep) pipeline.steps.push(currentStep);

  return pipeline;
}

function parseStepKeyValue(step: PipelineStep, kv: string): void {
  const colonIdx = kv.indexOf(':');
  if (colonIdx === -1) return;

  const key = kv.slice(0, colonIdx).trim();
  const value = kv.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');

  switch (key) {
    case 'query': step.query = value; break;
    case 'shell': step.shell = value; break;
    case 'file': step.file = value; break;
    case 'model': step.model = value; break;
    case 'system': step.system = value; break;
    case 'label': step.label = value; break;
    case 'timeout': step.timeout = parseInt(value, 10); break;
    case 'no-rag': step['no-rag'] = value === 'true'; break;
    case 'no-tools': step['no-tools'] = value === 'true'; break;
  }
}

/**
 * Build a PipelineDefinition from inline CLI args.
 * Each positional arg becomes a query step.
 */
export function buildInlinePipeline(queries: string[]): PipelineDefinition {
  return {
    steps: queries.map(q => {
      // If starts with !, treat as shell command
      if (q.startsWith('!')) {
        return { shell: q.slice(1).trim() };
      }
      return { query: q };
    }),
  };
}

/**
 * Validate a pipeline definition.
 */
export function validatePipeline(pipeline: PipelineDefinition): string[] {
  const errors: string[] = [];

  if (!pipeline.steps || pipeline.steps.length === 0) {
    errors.push('Pipeline has no steps.');
    return errors;
  }

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    if (!step.query && !step.shell) {
      errors.push(`Step ${i + 1}: must have either 'query' or 'shell'.`);
    }
    if (step.query && step.shell) {
      errors.push(`Step ${i + 1}: cannot have both 'query' and 'shell'.`);
    }
    if (step.file && !step.query) {
      errors.push(`Step ${i + 1}: 'file' only makes sense with 'query', not 'shell'.`);
    }
    if (step.timeout !== undefined && (isNaN(step.timeout) || step.timeout <= 0)) {
      errors.push(`Step ${i + 1}: timeout must be a positive number.`);
    }
  }

  return errors;
}

// ── Execution ──

/**
 * Execute a single query step through the Ved pipeline.
 */
export async function executeQueryStep(
  app: VedApp,
  step: PipelineStep,
  prevOutput: string,
  defaults: { model?: string; system?: string; timeout?: number },
): Promise<{ output: string; durationMs: number }> {
  let content = step.query ?? '';

  // Prepend previous output as context
  if (prevOutput) {
    content = `${content}\n\n--- Previous step output ---\n\n${prevOutput}`;
  }

  // Attach file if specified
  if (step.file) {
    if (!existsSync(step.file)) {
      throw new Error(`File not found: ${step.file}`);
    }
    const stat = statSync(step.file);
    if (stat.size > 1024 * 1024) {
      throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 1MB.`);
    }
    const fileContent = readFileSync(step.file, 'utf-8');
    const fileName = basename(step.file);
    content = `${content}\n\n--- ${fileName} ---\n\n${fileContent}`;
  }

  content = content.trim();
  if (!content) {
    throw new Error('Empty query after assembly.');
  }

  const msg: VedMessage = {
    id: ulid(),
    channel: 'run' as const,
    author: `pipe-${ulid()}`,
    content,
    timestamp: Date.now(),
  };

  const timeout = (step.timeout ?? defaults.timeout ?? 120) * 1000;
  const startTime = Date.now();

  const response = await Promise.race([
    app.processMessageDirect(msg),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('STEP_TIMEOUT')), timeout)
    ),
  ]);

  return {
    output: response.content,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Execute a shell step. Pipes prevOutput to stdin, captures stdout.
 */
export function executeShellStep(
  command: string,
  prevOutput: string,
  timeoutSec: number = 30,
): { output: string; durationMs: number } {
  const startTime = Date.now();

  try {
    const result = execSync(command, {
      input: prevOutput,
      encoding: 'utf-8',
      timeout: timeoutSec * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      output: result.trimEnd(),
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`Shell command failed: ${msg}`);
  }
}

/**
 * Execute a full pipeline.
 */
export async function executePipeline(
  app: VedApp,
  pipeline: PipelineDefinition,
  opts: { verbose?: boolean; dryRun?: boolean } = {},
): Promise<PipelineResult> {
  const results: StepResult[] = [];
  let prevOutput = '';
  const totalStart = Date.now();

  const defaults = {
    model: pipeline.model,
    system: pipeline.system,
    timeout: pipeline.timeout,
  };

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const isShell = !!step.shell;
    const label = step.label ?? (isShell ? `shell: ${step.shell}` : `query: ${(step.query ?? '').slice(0, 50)}`);

    if (opts.verbose) {
      const stepNum = `[${i + 1}/${pipeline.steps.length}]`;
      process.stderr.write(`  ${stepNum} ${label}...`);
    }

    if (opts.dryRun) {
      results.push({
        index: i,
        label,
        type: isShell ? 'shell' : 'query',
        output: `[DRY RUN] Would ${isShell ? `run: ${step.shell}` : `query: ${step.query}`}`,
        durationMs: 0,
        success: true,
      });
      if (opts.verbose) {
        process.stderr.write(' [dry run]\n');
      }
      continue;
    }

    try {
      let output: string;
      let durationMs: number;

      if (isShell) {
        const result = executeShellStep(step.shell!, prevOutput, step.timeout ?? 30);
        output = result.output;
        durationMs = result.durationMs;
      } else {
        const result = await executeQueryStep(app, step, prevOutput, defaults);
        output = result.output;
        durationMs = result.durationMs;
      }

      results.push({
        index: i,
        label,
        type: isShell ? 'shell' : 'query',
        output,
        durationMs,
        success: true,
      });

      prevOutput = output;

      if (opts.verbose) {
        process.stderr.write(` done (${durationMs}ms)\n`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      results.push({
        index: i,
        label,
        type: isShell ? 'shell' : 'query',
        output: '',
        durationMs: Date.now() - totalStart,
        success: false,
        error: errorMsg,
      });

      if (opts.verbose) {
        process.stderr.write(` FAILED: ${errorMsg}\n`);
      }

      // Pipeline stops on first failure
      return {
        name: pipeline.name,
        steps: results,
        totalDurationMs: Date.now() - totalStart,
        success: false,
        finalOutput: prevOutput,
      };
    }
  }

  return {
    name: pipeline.name,
    steps: results,
    totalDurationMs: Date.now() - totalStart,
    success: true,
    finalOutput: prevOutput,
  };
}

// ── Saved Pipelines ──

/**
 * List saved pipelines.
 */
export function listSavedPipelines(pipelinesDir?: string): Array<{
  name: string;
  description?: string;
  stepCount: number;
  filename: string;
}> {
  const dir = pipelinesDir ?? getPipelinesDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const results: Array<{ name: string; description?: string; stepCount: number; filename: string }> = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const pipeline = parsePipelineYaml(content);
      results.push({
        name: pipeline.name ?? file.replace(/\.ya?ml$/, ''),
        description: pipeline.description,
        stepCount: pipeline.steps.length,
        filename: file,
      });
    } catch {
      // Skip malformed files
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a saved pipeline by name.
 */
export function loadSavedPipeline(name: string, pipelinesDir?: string): PipelineDefinition | null {
  const dir = pipelinesDir ?? getPipelinesDir();
  if (!existsSync(dir)) return null;

  // Try exact filename first, then with extensions
  for (const ext of ['', '.yaml', '.yml']) {
    const path = join(dir, `${name}${ext}`);
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      return parsePipelineYaml(content);
    }
  }

  return null;
}

/**
 * Save a pipeline definition.
 */
export function savePipeline(name: string, pipeline: PipelineDefinition, pipelinesDir?: string): string {
  const dir = pipelinesDir ?? getPipelinesDir();
  mkdirSync(dir, { recursive: true });

  // Sanitize name
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const filename = `${safeName}.yaml`;
  const filepath = join(dir, filename);

  // Build YAML content
  const lines: string[] = [];
  lines.push(`name: ${pipeline.name ?? safeName}`);
  if (pipeline.description) lines.push(`description: ${pipeline.description}`);
  if (pipeline.model) lines.push(`model: ${pipeline.model}`);
  if (pipeline.system) lines.push(`system: "${pipeline.system}"`);
  if (pipeline.timeout) lines.push(`timeout: ${pipeline.timeout}`);
  lines.push('steps:');

  for (const step of pipeline.steps) {
    if (step.query) {
      lines.push(`  - query: "${step.query.replace(/"/g, '\\"')}"`);
    } else if (step.shell) {
      lines.push(`  - shell: "${step.shell.replace(/"/g, '\\"')}"`);
    }
    if (step.label) lines.push(`    label: ${step.label}`);
    if (step.file) lines.push(`    file: ${step.file}`);
    if (step.model) lines.push(`    model: ${step.model}`);
    if (step.system) lines.push(`    system: "${step.system.replace(/"/g, '\\"')}"`);
    if (step['no-rag']) lines.push(`    no-rag: true`);
    if (step['no-tools']) lines.push(`    no-tools: true`);
    if (step.timeout) lines.push(`    timeout: ${step.timeout}`);
  }

  writeFileSync(filepath, lines.join('\n') + '\n');
  return filepath;
}

/**
 * Delete a saved pipeline.
 */
export function deleteSavedPipeline(name: string, pipelinesDir?: string): boolean {
  const dir = pipelinesDir ?? getPipelinesDir();
  if (!existsSync(dir)) return false;

  for (const ext of ['', '.yaml', '.yml']) {
    const path = join(dir, `${name}${ext}`);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
  }

  return false;
}

// ── CLI ──

/**
 * Format pipeline result for display.
 */
export function formatPipelineResult(
  result: PipelineResult,
  format: 'text' | 'json' | 'raw',
): string {
  if (format === 'json') {
    return JSON.stringify({
      name: result.name,
      success: result.success,
      totalDurationMs: result.totalDurationMs,
      steps: result.steps.map(s => ({
        index: s.index,
        label: s.label,
        type: s.type,
        output: s.output,
        durationMs: s.durationMs,
        success: s.success,
        error: s.error,
      })),
      finalOutput: result.finalOutput,
    }, null, 2);
  }

  if (format === 'raw') {
    return result.finalOutput;
  }

  // Text format
  const lines: string[] = [];

  if (result.name) {
    lines.push(`Pipeline: ${result.name}`);
    lines.push('');
  }

  for (const step of result.steps) {
    const icon = step.success ? '✅' : '❌';
    const dur = step.durationMs < 1000
      ? `${step.durationMs}ms`
      : `${(step.durationMs / 1000).toFixed(1)}s`;

    lines.push(`${icon} Step ${step.index + 1}: ${step.label} (${dur})`);
    if (step.error) {
      lines.push(`   Error: ${step.error}`);
    }
  }

  lines.push('');
  if (result.success) {
    const totalDur = result.totalDurationMs < 1000
      ? `${result.totalDurationMs}ms`
      : `${(result.totalDurationMs / 1000).toFixed(1)}s`;
    lines.push(`✅ Pipeline complete (${result.steps.length} steps, ${totalDur})`);
  } else {
    lines.push(`❌ Pipeline failed at step ${result.steps.length}`);
  }

  lines.push('');
  lines.push('─── Output ───');
  lines.push('');
  lines.push(result.finalOutput);

  return lines.join('\n');
}

/**
 * Parse CLI args for `ved pipe`.
 */
export function parsePipeArgs(args: string[]): {
  subcommand: 'run' | 'list' | 'show' | 'save' | 'delete';
  pipelineName?: string;
  pipelineFile?: string;
  inlineQueries: string[];
  format: 'text' | 'json' | 'raw';
  verbose: boolean;
  dryRun: boolean;
  description?: string;
} {
  const result = {
    subcommand: 'run' as 'run' | 'list' | 'show' | 'save' | 'delete',
    pipelineName: undefined as string | undefined,
    pipelineFile: undefined as string | undefined,
    inlineQueries: [] as string[],
    format: 'text' as 'text' | 'json' | 'raw',
    verbose: false,
    dryRun: false,
    description: undefined as string | undefined,
  };

  if (args.length === 0) {
    result.subcommand = 'list';
    return result;
  }

  // Check for subcommands
  const first = args[0];
  if (first === 'list' || first === 'ls') {
    result.subcommand = 'list';
    return result;
  }
  if (first === 'show' || first === 'cat' || first === 'view') {
    result.subcommand = 'show';
    result.pipelineName = args[1];
    return result;
  }
  if (first === 'save') {
    result.subcommand = 'save';
    result.pipelineName = args[1];
    // Parse remaining flags
    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '-f' || args[i] === '--file') && args[i + 1]) {
        result.pipelineFile = args[++i];
      } else if ((args[i] === '-d' || args[i] === '--description') && args[i + 1]) {
        result.description = args[++i];
      }
    }
    return result;
  }
  if (first === 'delete' || first === 'rm' || first === 'remove') {
    result.subcommand = 'delete';
    result.pipelineName = args[1];
    return result;
  }
  if (first === 'run') {
    result.subcommand = 'run';
    // Shift args to skip 'run'
    args = args.slice(1);
    // First arg after 'run' could be a saved pipeline name
    if (args.length === 1 && !args[0].startsWith('-') && !args[0].includes(' ')) {
      // Check if it's a saved pipeline
      const saved = loadSavedPipeline(args[0]);
      if (saved) {
        result.pipelineName = args[0];
        return result;
      }
    }
  }

  // Parse run flags and inline queries
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if ((arg === '-f' || arg === '--file') && args[i + 1]) {
      result.pipelineFile = args[++i];
    } else if (arg === '--json') {
      result.format = 'json';
    } else if (arg === '--raw') {
      result.format = 'raw';
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      result.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printPipeHelp();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`);
      console.error('Run `ved pipe --help` for usage.');
      process.exit(1);
    } else {
      result.inlineQueries.push(arg);
    }
  }

  return result;
}

function printPipeHelp(): void {
  console.log(`
ved pipe — Multi-step pipeline execution

USAGE
  ved pipe "step 1" "step 2" "step 3"         Inline pipeline
  ved pipe -f pipeline.yaml                    Run from file
  ved pipe run <saved-name>                    Run saved pipeline
  ved pipe "step 1" "!wc -w" "step 2"         Mix queries and shell (! prefix)
  ved pipe list                                List saved pipelines
  ved pipe show <name>                         Show pipeline definition
  ved pipe save <name> -f pipeline.yaml        Save a pipeline
  ved pipe delete <name>                       Delete saved pipeline

OPTIONS
  -f, --file <path>      Load pipeline from YAML file
  --json                 Output result as JSON
  --raw                  Output final result only (no step info)
  -v, --verbose          Show step-by-step progress
  -n, --dry-run          Show what would run without executing
  -h, --help             Show this help

PIPELINE YAML
  name: my-pipeline
  description: Summarize and translate
  steps:
    - query: "Summarize this document"
      file: input.txt
    - query: "Extract the 5 key points"
    - shell: "wc -w"
    - query: "Format as markdown"

SHELL STEPS
  In inline mode, prefix with ! to run a shell command:
    ved pipe "summarize" "!wc -w" "format the word count"

  Shell commands receive the previous step's output on stdin
  and their stdout becomes the next step's input.

ALIASES
  ved pipeline, ved chain

EXIT CODES
  0  Success
  1  Error
  2  Timeout
  3  No steps / invalid pipeline
`.trim());
}

/**
 * Entry point for `ved pipe` command.
 */
export async function vedPipe(args: string[]): Promise<void> {
  const parsed = parsePipeArgs(args);

  switch (parsed.subcommand) {
    case 'list': {
      const pipelines = listSavedPipelines();
      console.log(`\nVed v${VERSION} — Saved Pipelines\n`);

      if (pipelines.length === 0) {
        console.log('  No saved pipelines.\n');
        console.log('  Create one with: ved pipe save <name> -f pipeline.yaml');
        console.log('  Or run inline:   ved pipe "step 1" "step 2" "step 3"\n');
        return;
      }

      for (const p of pipelines) {
        console.log(`  📋 ${p.name} (${p.stepCount} steps)`);
        if (p.description) console.log(`     ${p.description}`);
      }
      console.log(`\n  ${pipelines.length} pipeline(s) saved.\n`);
      return;
    }

    case 'show': {
      if (!parsed.pipelineName) {
        console.error('Usage: ved pipe show <name>');
        process.exit(1);
      }

      const pipeline = loadSavedPipeline(parsed.pipelineName);
      if (!pipeline) {
        console.error(`Pipeline not found: ${parsed.pipelineName}`);
        process.exit(1);
      }

      console.log(`\nVed v${VERSION} — Pipeline: ${pipeline.name ?? parsed.pipelineName}\n`);
      if (pipeline.description) console.log(`  ${pipeline.description}\n`);
      if (pipeline.model) console.log(`  Default model: ${pipeline.model}`);
      if (pipeline.timeout) console.log(`  Default timeout: ${pipeline.timeout}s`);

      console.log(`\n  Steps (${pipeline.steps.length}):\n`);
      for (let i = 0; i < pipeline.steps.length; i++) {
        const step = pipeline.steps[i];
        const num = `${i + 1}.`;
        if (step.query) {
          console.log(`  ${num} [query] ${step.query}`);
        } else if (step.shell) {
          console.log(`  ${num} [shell] ${step.shell}`);
        }
        if (step.file) console.log(`     file: ${step.file}`);
        if (step.model) console.log(`     model: ${step.model}`);
        if (step['no-rag']) console.log(`     no-rag: true`);
        if (step['no-tools']) console.log(`     no-tools: true`);
      }
      console.log('');
      return;
    }

    case 'save': {
      if (!parsed.pipelineName) {
        console.error('Usage: ved pipe save <name> -f pipeline.yaml [-d "description"]');
        process.exit(1);
      }
      if (!parsed.pipelineFile) {
        console.error('Error: -f <file> is required for save.');
        process.exit(1);
      }
      if (!existsSync(parsed.pipelineFile)) {
        console.error(`File not found: ${parsed.pipelineFile}`);
        process.exit(1);
      }

      const content = readFileSync(parsed.pipelineFile, 'utf-8');
      const pipeline = parsePipelineYaml(content);

      // Override name/description if provided
      pipeline.name = parsed.pipelineName;
      if (parsed.description) pipeline.description = parsed.description;

      const errors = validatePipeline(pipeline);
      if (errors.length > 0) {
        console.error('Pipeline validation failed:');
        for (const e of errors) console.error(`  ❌ ${e}`);
        process.exit(1);
      }

      const filepath = savePipeline(parsed.pipelineName, pipeline);
      console.log(`\n  ✅ Pipeline saved: ${parsed.pipelineName}`);
      console.log(`     File: ${filepath}`);
      console.log(`     Steps: ${pipeline.steps.length}\n`);
      return;
    }

    case 'delete': {
      if (!parsed.pipelineName) {
        console.error('Usage: ved pipe delete <name>');
        process.exit(1);
      }

      if (deleteSavedPipeline(parsed.pipelineName)) {
        console.log(`\n  ✅ Pipeline deleted: ${parsed.pipelineName}\n`);
      } else {
        console.error(`Pipeline not found: ${parsed.pipelineName}`);
        process.exit(1);
      }
      return;
    }

    case 'run': {
      // Build pipeline from source
      let pipeline: PipelineDefinition;

      if (parsed.pipelineName) {
        // Load saved pipeline
        const saved = loadSavedPipeline(parsed.pipelineName);
        if (!saved) {
          console.error(`Pipeline not found: ${parsed.pipelineName}`);
          process.exit(1);
          return; // unreachable
        }
        pipeline = saved;
      } else if (parsed.pipelineFile) {
        // Load from file
        if (!existsSync(parsed.pipelineFile)) {
          console.error(`File not found: ${parsed.pipelineFile}`);
          process.exit(1);
          return;
        }
        const content = readFileSync(parsed.pipelineFile, 'utf-8');
        pipeline = parsePipelineYaml(content);
      } else if (parsed.inlineQueries.length > 0) {
        // Inline queries
        pipeline = buildInlinePipeline(parsed.inlineQueries);
      } else {
        printPipeHelp();
        process.exit(3);
        return;
      }

      // Validate
      const errors = validatePipeline(pipeline);
      if (errors.length > 0) {
        console.error('Pipeline validation failed:');
        for (const e of errors) console.error(`  ❌ ${e}`);
        process.exit(3);
      }

      // Dry run doesn't need app
      if (parsed.dryRun) {
        const result = await executePipeline(null as any, pipeline, {
          verbose: true,
          dryRun: true,
        });
        console.log(formatPipelineResult(result, parsed.format));
        return;
      }

      // Execute
      let app: VedApp | undefined;
      try {
        // Only init app if we have query steps
        const hasQuerySteps = pipeline.steps.some(s => !!s.query);
        if (hasQuerySteps) {
          app = createApp();
          await app.init();
        }

        if (parsed.verbose) {
          console.error(`\nVed v${VERSION} — Pipeline${pipeline.name ? `: ${pipeline.name}` : ''}\n`);
        }

        const result = await executePipeline(app!, pipeline, {
          verbose: parsed.verbose,
          dryRun: false,
        });

        console.log(formatPipelineResult(result, parsed.format));

        if (!result.success) {
          process.exit(1);
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'STEP_TIMEOUT') {
          console.error('Error: Pipeline step timed out.');
          process.exit(2);
        }
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        if (app) {
          await app.stop();
        }
      }
    }
  }
}
