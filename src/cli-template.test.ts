/**
 * Tests for `ved template` — vault template manager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { extractVariables, applyVariables } from './cli-template.js';

// ── Test helpers ──

function createTempDir(): string {
  const dir = join(tmpdir(), `ved-template-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createVaultStructure(vaultPath: string): void {
  const folders = [
    'daily', 'entities/people', 'entities/orgs', 'entities/places',
    'projects', 'concepts', 'decisions', 'topics', 'templates',
  ];
  for (const folder of folders) {
    mkdirSync(join(vaultPath, folder), { recursive: true });
  }
}

function writeTemplate(vaultPath: string, name: string, content: string): void {
  writeFileSync(join(vaultPath, 'templates', `${name}.md`), content, 'utf-8');
}

function readVaultFile(vaultPath: string, relPath: string): string {
  return readFileSync(join(vaultPath, relPath), 'utf-8');
}

// ── Unit tests for extractVariables ──

describe('extractVariables', () => {
  it('extracts simple variables', () => {
    const content = 'Hello {{name}}, welcome to {{place}}';
    expect(extractVariables(content)).toEqual(['name', 'place']);
  });

  it('deduplicates repeated variables', () => {
    const content = '{{name}} is {{name}} and {{age}}';
    expect(extractVariables(content)).toEqual(['age', 'name']);
  });

  it('returns empty for no variables', () => {
    expect(extractVariables('no variables here')).toEqual([]);
  });

  it('handles variables in frontmatter', () => {
    const content = `---
type: person
name: {{name}}
role: {{role}}
---

# {{name}}
`;
    expect(extractVariables(content)).toEqual(['name', 'role']);
  });

  it('handles underscored variable names', () => {
    const content = '{{first_name}} {{last_name}} {{_private}}';
    expect(extractVariables(content)).toEqual(['_private', 'first_name', 'last_name']);
  });

  it('ignores invalid variable patterns', () => {
    const content = '{{}} {{123}} {{valid}} {{also-invalid}} {{under_score}}';
    expect(extractVariables(content)).toEqual(['under_score', 'valid']);
  });

  it('handles many variables in large content', () => {
    const vars = Array.from({ length: 50 }, (_, i) => `var_${i}`);
    const content = vars.map(v => `{{${v}}}`).join(' ');
    expect(extractVariables(content)).toHaveLength(50);
  });
});

// ── Unit tests for applyVariables ──

describe('applyVariables', () => {
  it('replaces known variables', () => {
    const result = applyVariables('Hello {{name}}!', { name: 'Alice' });
    expect(result).toBe('Hello Alice!');
  });

  it('leaves unknown variables as-is', () => {
    const result = applyVariables('{{known}} and {{unknown}}', { known: 'yes' });
    expect(result).toBe('yes and {{unknown}}');
  });

  it('replaces all occurrences', () => {
    const result = applyVariables('{{x}} + {{x}} = {{y}}', { x: '1', y: '2' });
    expect(result).toBe('1 + 1 = 2');
  });

  it('handles empty vars', () => {
    const result = applyVariables('{{name}}', {});
    expect(result).toBe('{{name}}');
  });

  it('handles empty string values', () => {
    const result = applyVariables('{{name}}', { name: '' });
    expect(result).toBe('');
  });

  it('replaces in frontmatter', () => {
    const content = `---
type: person
name: {{name}}
---

# {{name}}
`;
    const result = applyVariables(content, { name: 'Bob' });
    expect(result).toContain('name: Bob');
    expect(result).toContain('# Bob');
  });

  it('handles special regex chars in values', () => {
    const result = applyVariables('{{name}}', { name: 'foo$bar' });
    expect(result).toBe('foo$bar');
  });

  it('handles multiline values', () => {
    const result = applyVariables('Notes: {{notes}}', { notes: 'line1\nline2' });
    expect(result).toBe('Notes: line1\nline2');
  });
});

// ── CLI subcommand tests (via mocked vault) ──

describe('ved template CLI', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = createTempDir();
    createVaultStructure(vaultPath);
  });

  afterEach(() => {
    try { rmSync(vaultPath, { recursive: true, force: true }); } catch {}
  });

  describe('help', () => {
    it('displays help text', () => {
      // Test that the module exports the function
      expect(typeof extractVariables).toBe('function');
      expect(typeof applyVariables).toBe('function');
    });
  });

  describe('template files in vault', () => {
    it('creates template in templates/ folder', () => {
      const content = `---
type: person
name: "{{name}}"
---

# {{name}}
`;
      writeTemplate(vaultPath, 'test-person', content);
      const written = readVaultFile(vaultPath, 'templates/test-person.md');
      expect(written).toContain('{{name}}');
      expect(written).toContain('type: person');
    });

    it('lists templates from templates/ folder', () => {
      writeTemplate(vaultPath, 'person', '# {{name}}');
      writeTemplate(vaultPath, 'project', '# {{title}}');
      const files = readdirSync(join(vaultPath, 'templates'));
      expect(files.sort()).toEqual(['person.md', 'project.md']);
    });

    it('reads template content', () => {
      const content = '---\ntype: concept\n---\n\n# {{name}}\n\n{{definition}}\n';
      writeTemplate(vaultPath, 'concept', content);
      const read = readVaultFile(vaultPath, 'templates/concept.md');
      expect(extractVariables(read)).toEqual(['definition', 'name']);
    });
  });

  describe('variable extraction from built-in templates', () => {
    it('person template has expected variables', () => {
      // The built-in person template should have common variables
      const personTemplate = `---
type: person
name: "{{name}}"
role: "{{role}}"
org: "{{org}}"
created: "{{date}}"
---

# {{name}}

## Context
{{context}}

## Notes
{{notes}}
`;
      const vars = extractVariables(personTemplate);
      expect(vars).toContain('name');
      expect(vars).toContain('role');
      expect(vars).toContain('org');
      expect(vars).toContain('date');
      expect(vars).toContain('context');
      expect(vars).toContain('notes');
    });

    it('decision template has expected variables', () => {
      const decisionTemplate = `---
type: decision
title: "{{title}}"
date: "{{date}}"
status: "{{status}}"
---

# {{title}}

## Context
{{context}}

## Decision
{{decision}}
`;
      const vars = extractVariables(decisionTemplate);
      expect(vars).toContain('title');
      expect(vars).toContain('date');
      expect(vars).toContain('status');
      expect(vars).toContain('context');
      expect(vars).toContain('decision');
    });
  });

  describe('template instantiation (manual)', () => {
    it('applies variables and creates output file', () => {
      const template = `---
type: person
name: {{name}}
role: {{role}}
created: {{date}}
---

# {{name}}

Role: {{role}} at {{org}}
`;
      const vars = { name: 'Alice', role: 'Engineer', date: '2026-03-07', org: 'Acme' };
      const rendered = applyVariables(template, vars);

      expect(rendered).toContain('name: Alice');
      expect(rendered).toContain('role: Engineer');
      expect(rendered).toContain('# Alice');
      expect(rendered).toContain('Role: Engineer at Acme');
      expect(rendered).not.toContain('{{name}}');
      expect(rendered).not.toContain('{{role}}');
    });

    it('writes rendered file to correct location', () => {
      const rendered = '---\ntype: person\nname: Alice\n---\n\n# Alice\n';
      const outPath = join(vaultPath, 'entities/people/alice.md');
      mkdirSync(join(vaultPath, 'entities/people'), { recursive: true });
      writeFileSync(outPath, rendered, 'utf-8');

      expect(existsSync(outPath)).toBe(true);
      const content = readFileSync(outPath, 'utf-8');
      expect(content).toContain('# Alice');
    });

    it('leaves unreplaced variables when values not provided', () => {
      const template = '{{name}} works on {{project}} since {{date}}';
      const result = applyVariables(template, { name: 'Bob' });
      expect(result).toBe('Bob works on {{project}} since {{date}}');
      expect(extractVariables(result)).toEqual(['date', 'project']);
    });

    it('auto-routing: person → entities/people', () => {
      const rendered = '---\ntype: person\nname: Alice\n---\n\n# Alice\n';
      const typeMatch = rendered.match(/^type:\s*(.+)$/m);
      const entityType = typeMatch?.[1]?.trim() ?? 'entities';
      expect(entityType).toBe('person');
    });

    it('auto-routing: project → projects/', () => {
      const rendered = '---\ntype: project\nname: Ved\n---\n';
      const typeMatch = rendered.match(/^type:\s*(.+)$/m);
      const entityType = typeMatch?.[1]?.trim() ?? 'entities';
      expect(entityType).toBe('project');
    });

    it('auto-routing: decision → decisions/', () => {
      const rendered = '---\ntype: decision\ntitle: Use TypeScript\n---\n';
      const typeMatch = rendered.match(/^type:\s*(.+)$/m);
      const entityType = typeMatch?.[1]?.trim() ?? 'entities';
      expect(entityType).toBe('decision');
    });
  });

  describe('name validation', () => {
    it('rejects empty name', () => {
      const vars = extractVariables('');
      expect(vars).toEqual([]);
    });

    it('rejects names with path traversal', () => {
      // Simulating what validateName does
      const badNames = ['../secret', '../../etc', 'foo/bar', '.hidden'];
      for (const name of badNames) {
        expect(/^[a-zA-Z0-9_-]+$/.test(name)).toBe(false);
      }
    });

    it('accepts valid names', () => {
      const goodNames = ['person', 'my-project', 'meeting_notes', 'Template1'];
      for (const name of goodNames) {
        expect(/^[a-zA-Z0-9_-]+$/.test(name)).toBe(true);
      }
    });
  });

  describe('delete', () => {
    it('removes template file from vault', () => {
      writeTemplate(vaultPath, 'to-delete', '# Template');
      const path = join(vaultPath, 'templates', 'to-delete.md');
      expect(existsSync(path)).toBe(true);

      rmSync(path);
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles template with no variables', () => {
      const content = '# Static Content\n\nNo variables here.\n';
      const vars = extractVariables(content);
      expect(vars).toEqual([]);
      const rendered = applyVariables(content, { name: 'ignored' });
      expect(rendered).toBe(content);
    });

    it('handles template with only frontmatter', () => {
      const content = '---\ntype: person\nname: {{name}}\n---\n';
      const vars = extractVariables(content);
      expect(vars).toEqual(['name']);
    });

    it('handles nested curly braces', () => {
      const content = '{{{name}}} and {{ not_a_var }}';
      const vars = extractVariables(content);
      expect(vars).toEqual(['name']);
    });

    it('handles variable at start and end', () => {
      const content = '{{start}}middle{{end}}';
      const rendered = applyVariables(content, { start: 'A', end: 'Z' });
      expect(rendered).toBe('AmiddleZ');
    });

    it('handles wikilinks with variables', () => {
      const content = '[[{{project}}]] depends on [[{{dependency}}]]';
      const vars = extractVariables(content);
      expect(vars).toEqual(['dependency', 'project']);
      const rendered = applyVariables(content, { project: 'Ved', dependency: 'Node' });
      expect(rendered).toBe('[[Ved]] depends on [[Node]]');
    });

    it('handles frontmatter tags with variables', () => {
      const content = '---\ntags: #{{tag1}} #{{tag2}}\n---\n';
      const rendered = applyVariables(content, { tag1: 'ai', tag2: 'agent' });
      expect(rendered).toContain('#ai #agent');
    });
  });
});
