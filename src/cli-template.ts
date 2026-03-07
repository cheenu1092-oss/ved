/**
 * `ved template` — Vault template manager.
 *
 * Templates are `.md` files in `~/ved-vault/templates/` with YAML frontmatter
 * and `{{variable}}` placeholders. When instantiated, variables get replaced
 * with user-provided values.
 *
 * This enables consistent vault entries (people, projects, decisions) and
 * works natively in Obsidian — templates are just markdown files in the vault.
 *
 * Subcommands:
 *   list                              List available templates
 *   show <name>                       Display template contents
 *   create <name> [--type <type>]     Create a new template from built-in defaults
 *   edit <name>                       Open template in $EDITOR
 *   delete <name>                     Remove a template
 *   use <name> <filename> [--var k=v] Instantiate a template into the vault
 *   vars <name>                       Show template variables
 *
 * Aliases: templates, tpl
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type { VedApp } from './app.js';

// ── ANSI colors ──

const C = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  cyan: '\x1B[36m',
  red: '\x1B[31m',
  magenta: '\x1B[35m',
};

// ── Constants ──

const TEMPLATES_FOLDER = 'templates';
const VARIABLE_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

// Safe name pattern — alphanumeric, dashes, underscores only
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ── Built-in template defaults ──

const BUILT_IN_TEMPLATES: Record<string, { frontmatter: Record<string, string>; body: string }> = {
  person: {
    frontmatter: {
      type: 'person',
      name: '{{name}}',
      role: '{{role}}',
      org: '{{org}}',
      tags: '#person',
      confidence: 'medium',
      source: 'conversation',
      created: '{{date}}',
      updated: '{{date}}',
    },
    body: `# {{name}}

## Context
{{context}}

## Key Facts
- Role: {{role}}
- Organization: [[{{org}}]]

## Notes
{{notes}}

## Links
- Related: {{related}}
`,
  },

  project: {
    frontmatter: {
      type: 'project',
      name: '{{name}}',
      status: '{{status}}',
      tags: '#project',
      confidence: 'high',
      source: 'manual',
      created: '{{date}}',
      updated: '{{date}}',
    },
    body: `# {{name}}

## Overview
{{overview}}

## Goals
- {{goal_1}}

## Status
**Current:** {{status}}

## Decisions
- {{decision}}

## Links
- Related: {{related}}
`,
  },

  decision: {
    frontmatter: {
      type: 'decision',
      title: '{{title}}',
      date: '{{date}}',
      status: '{{status}}',
      tags: '#decision',
      confidence: '{{confidence}}',
      source: '{{source}}',
      created: '{{date}}',
      updated: '{{date}}',
    },
    body: `# {{title}}

## Context
{{context}}

## Options Considered
1. {{option_1}}
2. {{option_2}}

## Decision
{{decision}}

## Rationale
{{rationale}}

## Consequences
- {{consequence}}

## Links
- Related: {{related}}
`,
  },

  concept: {
    frontmatter: {
      type: 'concept',
      name: '{{name}}',
      tags: '#concept',
      confidence: 'medium',
      source: '{{source}}',
      created: '{{date}}',
      updated: '{{date}}',
    },
    body: `# {{name}}

## Definition
{{definition}}

## Key Points
- {{point_1}}

## Examples
- {{example}}

## Related Concepts
- [[{{related}}]]

## Notes
{{notes}}
`,
  },

  daily: {
    frontmatter: {
      type: 'daily',
      date: '{{date}}',
      tags: '#daily',
    },
    body: `# {{date}}

## Summary
{{summary}}

## What Happened
- {{event}}

## Decisions
- {{decision}}

## TODOs
- [ ] {{todo}}

## Reflections
{{reflections}}
`,
  },

  topic: {
    frontmatter: {
      type: 'topic',
      name: '{{name}}',
      tags: '#topic',
      confidence: 'medium',
      source: '{{source}}',
      created: '{{date}}',
      updated: '{{date}}',
    },
    body: `# {{name}}

## Overview
{{overview}}

## Key Resources
- {{resource}}

## Notes
{{notes}}

## Links
- Related: [[{{related}}]]
`,
  },
};

// ── Helpers ──

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string>; vars: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const vars: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--var' || args[i] === '-v') {
      const next = args[i + 1];
      if (next && next.includes('=')) {
        const eqIdx = next.indexOf('=');
        const key = next.slice(0, eqIdx);
        const val = next.slice(eqIdx + 1);
        if (key) vars[key] = val;
        i++;
      }
    } else if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags, vars };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Extract all unique variable names from template content.
 */
export function extractVariables(content: string): string[] {
  const vars = new Set<string>();
  let match;
  const re = new RegExp(VARIABLE_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return [...vars].sort();
}

/**
 * Replace {{variables}} in content with provided values.
 * Unreplaced variables are left as-is.
 */
export function applyVariables(content: string, vars: Record<string, string>): string {
  return content.replace(VARIABLE_RE, (full, name) => {
    return vars[name] !== undefined ? vars[name] : full;
  });
}

/**
 * Serialize a built-in template to markdown.
 */
function serializeTemplate(tpl: { frontmatter: Record<string, string>; body: string }): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(tpl.frontmatter)) {
    lines.push(`${key}: ${val}`);
  }
  lines.push('---', '', tpl.body);
  return lines.join('\n');
}

/**
 * Validate template name — no path traversal, no dots, safe chars only.
 */
function validateName(name: string): string | null {
  if (!name || name.trim() === '') return 'Template name is required';
  if (!SAFE_NAME_RE.test(name)) return 'Template name can only contain letters, numbers, dashes, and underscores';
  if (name.startsWith('-') || name.startsWith('.')) return 'Template name cannot start with - or .';
  if (name.includes('..')) return 'Template name cannot contain ..';
  return null;
}

/**
 * Get template path within vault.
 */
function templatePath(name: string): string {
  return `${TEMPLATES_FOLDER}/${name}.md`;
}

/**
 * Determine output folder based on entity type.
 */
function outputFolder(type: string): string {
  switch (type) {
    case 'person': return 'entities/people';
    case 'org': return 'entities/orgs';
    case 'place': return 'entities/places';
    case 'project': return 'projects';
    case 'concept': return 'concepts';
    case 'decision': return 'decisions';
    case 'topic': return 'topics';
    case 'daily': return 'daily';
    default: return 'entities';
  }
}

// ── Main entry point ──

export async function runTemplate(app: VedApp, args: string[]): Promise<void> {
  const { positional, flags, vars } = parseArgs(args);
  const subcommand = positional[0] ?? 'help';

  const vault = app.memory.vault;

  // Aliases
  const aliasMap: Record<string, string> = {
    ls: 'list',
    cat: 'show',
    view: 'show',
    new: 'create',
    add: 'create',
    rm: 'delete',
    remove: 'delete',
    apply: 'use',
    instantiate: 'use',
    render: 'use',
    variables: 'vars',
    placeholders: 'vars',
  };

  const cmd = aliasMap[subcommand] ?? subcommand;

  switch (cmd) {
    case 'list': {
      const files = vault.listFiles(TEMPLATES_FOLDER);
      if (files.length === 0) {
        console.log(`${C.dim}No templates found. Create one with: ved template create <name>${C.reset}`);
        console.log(`${C.dim}Or create from built-in: ved template create <name> --type person${C.reset}`);
        return;
      }

      console.log(`${C.bold}Templates${C.reset} (${files.length})\n`);
      const nameWidth = Math.max(12, ...files.map(f => basename(f, '.md').length));

      for (const file of files.sort()) {
        const name = basename(file, '.md');
        const vaultFile = vault.readFile(file);
        const type = (vaultFile.frontmatter['type'] as string) || '-';
        const variables = extractVariables(vaultFile.raw);
        const varCount = variables.length;
        const size = formatSize(vaultFile.stats?.size ?? vaultFile.raw.length);

        console.log(
          `  ${C.cyan}${name.padEnd(nameWidth)}${C.reset}  ` +
          `${C.dim}type:${C.reset}${type.padEnd(10)}  ` +
          `${C.dim}vars:${C.reset}${String(varCount).padStart(2)}  ` +
          `${C.dim}${size}${C.reset}`
        );
      }
      return;
    }

    case 'show': {
      const name = positional[1];
      if (!name) {
        console.error(`${C.red}Usage: ved template show <name>${C.reset}`);
        return;
      }

      const err = validateName(name);
      if (err) {
        console.error(`${C.red}${err}${C.reset}`);
        return;
      }

      // Check built-in if not in vault
      const relPath = templatePath(name);
      if (vault.exists(relPath)) {
        const file = vault.readFile(relPath);
        console.log(`${C.bold}Template: ${name}${C.reset}\n`);
        console.log(file.raw);
      } else if (BUILT_IN_TEMPLATES[name]) {
        console.log(`${C.bold}Template: ${name}${C.reset} ${C.dim}(built-in)${C.reset}\n`);
        console.log(serializeTemplate(BUILT_IN_TEMPLATES[name]));
      } else {
        console.error(`${C.red}Template not found: ${name}${C.reset}`);
        console.log(`${C.dim}Available built-ins: ${Object.keys(BUILT_IN_TEMPLATES).join(', ')}${C.reset}`);
      }
      return;
    }

    case 'create': {
      const name = positional[1];
      if (!name) {
        console.error(`${C.red}Usage: ved template create <name> [--type <type>]${C.reset}`);
        return;
      }

      const err = validateName(name);
      if (err) {
        console.error(`${C.red}${err}${C.reset}`);
        return;
      }

      const relPath = templatePath(name);
      if (vault.exists(relPath)) {
        console.error(`${C.red}Template already exists: ${name}${C.reset}`);
        console.log(`${C.dim}Use 'ved template edit ${name}' to modify it${C.reset}`);
        return;
      }

      const type = flags['type'];
      let content: string;

      if (type && BUILT_IN_TEMPLATES[type]) {
        content = serializeTemplate(BUILT_IN_TEMPLATES[type]);
        console.log(`${C.green}✓${C.reset} Created template ${C.cyan}${name}${C.reset} from built-in ${C.magenta}${type}${C.reset}`);
      } else if (type) {
        // Unknown type — create minimal template with that type
        content = serializeTemplate({
          frontmatter: {
            type,
            name: '{{name}}',
            tags: `#${type}`,
            created: '{{date}}',
            updated: '{{date}}',
          },
          body: `# {{name}}\n\n## Notes\n{{notes}}\n`,
        });
        console.log(`${C.green}✓${C.reset} Created template ${C.cyan}${name}${C.reset} with type ${C.magenta}${type}${C.reset}`);
      } else {
        // Blank template
        content = serializeTemplate({
          frontmatter: {
            type: '{{type}}',
            name: '{{name}}',
            created: '{{date}}',
            updated: '{{date}}',
          },
          body: `# {{name}}\n\n{{content}}\n`,
        });
        console.log(`${C.green}✓${C.reset} Created blank template ${C.cyan}${name}${C.reset}`);
      }

      vault.createFile(relPath, {}, '');
      // Write raw content directly (createFile uses serialize which would double-wrap frontmatter)
      const absPath = join(vault['vaultPath'], relPath);
      writeFileSync(absPath, content, 'utf-8');

      const variables = extractVariables(content);
      if (variables.length > 0) {
        console.log(`${C.dim}Variables: ${variables.map(v => `{{${v}}}`).join(', ')}${C.reset}`);
      }
      return;
    }

    case 'edit': {
      const name = positional[1];
      if (!name) {
        console.error(`${C.red}Usage: ved template edit <name>${C.reset}`);
        return;
      }

      const err = validateName(name);
      if (err) {
        console.error(`${C.red}${err}${C.reset}`);
        return;
      }

      const relPath = templatePath(name);
      if (!vault.exists(relPath)) {
        console.error(`${C.red}Template not found: ${name}${C.reset}`);
        return;
      }

      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
      const absPath = join(vault['vaultPath'], relPath);
      try {
        execSync(`${editor} "${absPath}"`, { stdio: 'inherit' });
        console.log(`${C.green}✓${C.reset} Template ${C.cyan}${name}${C.reset} updated`);
      } catch {
        console.error(`${C.red}Editor failed${C.reset}`);
      }
      return;
    }

    case 'delete': {
      const name = positional[1];
      if (!name) {
        console.error(`${C.red}Usage: ved template delete <name>${C.reset}`);
        return;
      }

      const err = validateName(name);
      if (err) {
        console.error(`${C.red}${err}${C.reset}`);
        return;
      }

      const relPath = templatePath(name);
      if (!vault.exists(relPath)) {
        console.error(`${C.red}Template not found: ${name}${C.reset}`);
        return;
      }

      vault.deleteFile(relPath);
      console.log(`${C.green}✓${C.reset} Deleted template ${C.cyan}${name}${C.reset}`);
      return;
    }

    case 'use': {
      const name = positional[1];
      const filename = positional[2];

      if (!name) {
        console.error(`${C.red}Usage: ved template use <template> <filename> [--var key=value ...]${C.reset}`);
        return;
      }

      if (!filename) {
        console.error(`${C.red}Missing filename. Usage: ved template use ${name} <filename> [--var key=value ...]${C.reset}`);
        return;
      }

      const nameErr = validateName(name);
      if (nameErr) {
        console.error(`${C.red}Invalid template name: ${nameErr}${C.reset}`);
        return;
      }

      // Validate filename — allow path separators for specifying folder
      const filenameClean = filename.replace(/\.md$/, '');
      if (filenameClean.includes('..')) {
        console.error(`${C.red}Filename cannot contain ..${C.reset}`);
        return;
      }

      // Get template content
      let content: string;
      const relPath = templatePath(name);

      if (vault.exists(relPath)) {
        content = vault.readFile(relPath).raw;
      } else if (BUILT_IN_TEMPLATES[name]) {
        content = serializeTemplate(BUILT_IN_TEMPLATES[name]);
      } else {
        console.error(`${C.red}Template not found: ${name}${C.reset}`);
        return;
      }

      // Auto-set date variable
      const allVars = { ...vars };
      if (!allVars['date']) {
        allVars['date'] = new Date().toISOString().split('T')[0];
      }

      // Apply variables
      const rendered = applyVariables(content, allVars);

      // Determine output path
      // Parse rendered content to get the type for folder routing
      const typeMatch = rendered.match(/^type:\s*(.+)$/m);
      const entityType = typeMatch?.[1]?.trim().replace(/['"]/g, '') ?? 'entities';
      let outPath: string;

      if (filenameClean.includes('/')) {
        // User specified a path — use it directly
        outPath = `${filenameClean}.md`;
      } else {
        // Route to appropriate folder based on type
        const folder = outputFolder(entityType);
        outPath = `${folder}/${filenameClean}.md`;
      }

      // Check if target exists
      if (vault.exists(outPath)) {
        if (flags['force'] !== 'true') {
          console.error(`${C.red}File already exists: ${outPath}${C.reset}`);
          console.log(`${C.dim}Use --force to overwrite${C.reset}`);
          return;
        }
      }

      // Write the rendered file
      const absOut = join(vault['vaultPath'], outPath);
      mkdirSync(dirname(absOut), { recursive: true });
      writeFileSync(absOut, rendered, 'utf-8');

      // Trigger vault re-index
      vault['indexFile'](outPath, rendered);
      vault['git'].markDirty(outPath);
      vault['emitChange'](outPath, vault.exists(outPath) ? 'update' : 'create');

      console.log(`${C.green}✓${C.reset} Created ${C.cyan}${outPath}${C.reset} from template ${C.magenta}${name}${C.reset}`);

      // Show any unreplaced variables
      const remaining = extractVariables(rendered);
      if (remaining.length > 0) {
        console.log(`${C.yellow}⚠ Unreplaced variables:${C.reset} ${remaining.map(v => `{{${v}}}`).join(', ')}`);
      }

      // Show applied variables
      const appliedKeys = Object.keys(allVars);
      if (appliedKeys.length > 0) {
        console.log(`${C.dim}Applied: ${appliedKeys.map(k => `${k}=${allVars[k]}`).join(', ')}${C.reset}`);
      }
      return;
    }

    case 'vars': {
      const name = positional[1];
      if (!name) {
        console.error(`${C.red}Usage: ved template vars <name>${C.reset}`);
        return;
      }

      const err = validateName(name);
      if (err) {
        console.error(`${C.red}${err}${C.reset}`);
        return;
      }

      let content: string;
      const relPath = templatePath(name);

      if (vault.exists(relPath)) {
        content = vault.readFile(relPath).raw;
      } else if (BUILT_IN_TEMPLATES[name]) {
        content = serializeTemplate(BUILT_IN_TEMPLATES[name]);
      } else {
        console.error(`${C.red}Template not found: ${name}${C.reset}`);
        return;
      }

      const variables = extractVariables(content);
      if (variables.length === 0) {
        console.log(`${C.dim}No variables found in template ${name}${C.reset}`);
        return;
      }

      console.log(`${C.bold}Variables in ${name}${C.reset} (${variables.length})\n`);
      for (const v of variables) {
        // Count occurrences
        const re = new RegExp(`\\{\\{${v}\\}\\}`, 'g');
        const count = (content.match(re) || []).length;
        console.log(`  ${C.cyan}{{${v}}}${C.reset}  ${C.dim}(${count} occurrence${count > 1 ? 's' : ''})${C.reset}`);
      }
      return;
    }

    case 'help':
    default: {
      if (cmd !== 'help') {
        console.error(`${C.red}Unknown subcommand: ${cmd}${C.reset}\n`);
      }
      console.log(`${C.bold}ved template${C.reset} — Vault template manager\n`);
      console.log('Subcommands:');
      console.log(`  ${C.cyan}list${C.reset}                              List available templates`);
      console.log(`  ${C.cyan}show${C.reset} <name>                       Display template contents`);
      console.log(`  ${C.cyan}create${C.reset} <name> [--type <type>]     Create a template (from built-in or blank)`);
      console.log(`  ${C.cyan}edit${C.reset} <name>                       Open template in $EDITOR`);
      console.log(`  ${C.cyan}delete${C.reset} <name>                     Remove a template`);
      console.log(`  ${C.cyan}use${C.reset} <tpl> <file> [--var k=v ...]  Instantiate template into vault`);
      console.log(`  ${C.cyan}vars${C.reset} <name>                       Show template variables`);
      console.log('');
      console.log(`${C.dim}Built-in types: ${Object.keys(BUILT_IN_TEMPLATES).join(', ')}${C.reset}`);
      console.log(`${C.dim}Aliases: templates, tpl${C.reset}`);
      return;
    }
  }
}
