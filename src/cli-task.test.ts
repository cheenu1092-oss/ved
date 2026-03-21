/**
 * Tests for `ved task` — task management CLI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTaskCommand, helpText, checkHelp } from './cli-task.js';

// ── Test Helpers ──

function createTestApp(vaultPath: string) {
  // Minimal app mock with real vault-like behavior
  const files = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();

  function ensureDir(p: string) {
    try { mkdirSync(p, { recursive: true }); } catch {}
  }

  function serializeFrontmatter(fm: Record<string, unknown>): string {
    const lines: string[] = ['---'];
    for (const [k, v] of Object.entries(fm)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    lines.push('---');
    return lines.join('\n');
  }

  function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: raw };
    const fmBlock = match[1];
    const body = match[2];
    const fm: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: string[] | null = null;
    for (const line of fmBlock.split('\n')) {
      const arrMatch = line.match(/^  - (.+)$/);
      if (arrMatch && currentKey) {
        if (!currentArray) currentArray = [];
        currentArray.push(arrMatch[1]);
        fm[currentKey] = currentArray;
        continue;
      }
      if (currentArray) {
        currentArray = null;
      }
      const kvMatch = line.match(/^(\w[\w-]*): ?(.*)$/);
      if (kvMatch) {
        currentKey = kvMatch[1];
        const val = kvMatch[2].trim();
        if (val === '') {
          // Could be start of array
          currentArray = [];
          fm[currentKey] = currentArray;
        } else {
          fm[currentKey] = val;
          currentArray = null;
        }
      }
    }
    return { frontmatter: fm, body };
  }

  const vault = {
    vaultPath,

    listFiles(folder?: string): string[] {
      const dir = folder ? join(vaultPath, folder) : vaultPath;
      if (!existsSync(dir)) return [];
      const results: string[] = [];
      function walk(d: string, prefix: string) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walk(join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          } else if (entry.name.endsWith('.md')) {
            results.push(folder ? `${folder}/${prefix ? prefix + '/' : ''}${entry.name}` : (prefix ? `${prefix}/${entry.name}` : entry.name));
          }
        }
      }
      walk(dir, '');
      return results;
    },

    readFile(relPath: string) {
      const absPath = join(vaultPath, relPath);
      if (!existsSync(absPath)) throw new Error(`File not found: ${relPath}`);
      const raw = readFileSync(absPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const links = (body.match(/\[\[([^\]]+)\]\]/g) || []).map(l => l.slice(2, -2));
      return { path: relPath, frontmatter, body, links, raw, stats: { created: new Date(), modified: new Date(), size: raw.length } };
    },

    exists(relPath: string): boolean {
      return existsSync(join(vaultPath, relPath));
    },

    createFile(relPath: string, frontmatter: Record<string, unknown>, body: string) {
      const absPath = join(vaultPath, relPath);
      ensureDir(join(absPath, '..'));
      const raw = serializeFrontmatter(frontmatter) + '\n' + body;
      writeFileSync(absPath, raw, 'utf-8');
    },

    updateFile(relPath: string, updates: { frontmatter?: Record<string, unknown>; body?: string }) {
      const absPath = join(vaultPath, relPath);
      const raw = readFileSync(absPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      if (updates.frontmatter) {
        for (const [k, v] of Object.entries(updates.frontmatter)) {
          if (v === undefined) {
            delete frontmatter[k];
          } else {
            frontmatter[k] = v;
          }
        }
      }
      const newBody = updates.body !== undefined ? updates.body : body;
      const newRaw = serializeFrontmatter(frontmatter) + '\n' + newBody;
      writeFileSync(absPath, newRaw, 'utf-8');
    },

    deleteFile(relPath: string) {
      const absPath = join(vaultPath, relPath);
      if (existsSync(absPath)) rmSync(absPath);
    },
  };

  return {
    memory: { vault },
    config: { memory: { vaultPath } },
  } as any;
}

function createTask(app: any, id: string, overrides: Partial<Record<string, unknown>> = {}) {
  const fm: Record<string, unknown> = {
    type: 'task',
    status: 'todo',
    priority: 'medium',
    created: '2026-03-15',
    ...overrides,
  };
  const title = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  app.memory.vault.createFile(`tasks/${id}.md`, fm, `# ${title}\n`);
}

// ── Setup ──

let testDir: string;
let app: any;

beforeEach(() => {
  testDir = join(tmpdir(), `ved-task-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  app = createTestApp(testDir);
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ── Tests ──

describe('ved task', () => {

  // ─── Help ───

  describe('help', () => {
    it('checkHelp returns true for --help', () => {
      expect(checkHelp(['--help'])).toBe(true);
      expect(checkHelp(['-h'])).toBe(true);
      expect(checkHelp(['list'])).toBe(false);
    });

    it('helpText includes subcommands', () => {
      const text = helpText();
      expect(text).toContain('ved task list');
      expect(text).toContain('ved task add');
      expect(text).toContain('ved task board');
      expect(text).toContain('tasks, todo, todos');
    });

    it('--help flag returns help text', async () => {
      const result = await runTaskCommand(app, ['--help']);
      expect(result).toContain('ved task');
    });
  });

  // ─── Add ───

  describe('add', () => {
    it('creates a task with minimal args', async () => {
      const result = await runTaskCommand(app, ['add', 'Fix', 'the', 'bug']);
      expect(result).toContain('✓');
      expect(result).toContain('Fix the bug');
      expect(app.memory.vault.exists('tasks/fix-the-bug.md')).toBe(true);

      const file = app.memory.vault.readFile('tasks/fix-the-bug.md');
      expect(file.frontmatter.type).toBe('task');
      expect(file.frontmatter.status).toBe('todo');
      expect(file.frontmatter.priority).toBe('medium');
    });

    it('creates a task with all flags', async () => {
      const result = await runTaskCommand(app, [
        'add', 'Deploy', 'v2',
        '--priority', 'high',
        '--due', '2026-04-01',
        '--assignee', 'nag',
        '--project', 'ved',
        '--tag', 'infra',
        '--tag', 'release',
      ]);
      expect(result).toContain('✓');

      const file = app.memory.vault.readFile('tasks/deploy-v2.md');
      expect(file.frontmatter.priority).toBe('high');
      expect(file.frontmatter.due).toBe('2026-04-01');
      expect(file.frontmatter.assignee).toBe('nag');
      expect(file.frontmatter.project).toBe('ved');
      expect(file.frontmatter.tags).toEqual(['infra', 'release']);
    });

    it('rejects empty title', async () => {
      const result = await runTaskCommand(app, ['add']);
      expect(result).toContain('Error');
      expect(result).toContain('title is required');
    });

    it('rejects invalid priority', async () => {
      const result = await runTaskCommand(app, ['add', 'test', '--priority', 'urgent']);
      expect(result).toContain('Error');
      expect(result).toContain('Invalid priority');
    });

    it('rejects invalid due date', async () => {
      const result = await runTaskCommand(app, ['add', 'test', '--due', 'next-tuesday']);
      expect(result).toContain('Error');
      expect(result).toContain('Invalid date');
    });

    it('rejects duplicate task IDs', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, ['add', 'my', 'task']);
      expect(result).toContain('Error');
      expect(result).toContain('already exists');
    });
  });

  // ─── List ───

  describe('list', () => {
    it('shows empty state', async () => {
      const result = await runTaskCommand(app, ['list']);
      expect(result).toContain('No tasks');
    });

    it('lists tasks sorted by priority', async () => {
      createTask(app, 'low-task', { priority: 'low' });
      createTask(app, 'high-task', { priority: 'high' });
      createTask(app, 'critical-task', { priority: 'critical' });

      const result = await runTaskCommand(app, ['list']);
      const critIdx = result.indexOf('Critical Task');
      const highIdx = result.indexOf('High Task');
      const lowIdx = result.indexOf('Low Task');
      expect(critIdx).toBeLessThan(highIdx);
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('hides done tasks by default', async () => {
      createTask(app, 'open-task');
      createTask(app, 'closed-task', { status: 'done' });

      const result = await runTaskCommand(app, ['list']);
      expect(result).toContain('Open Task');
      expect(result).not.toContain('Closed Task');
    });

    it('shows done tasks when filtered', async () => {
      createTask(app, 'closed-task', { status: 'done' });

      const result = await runTaskCommand(app, ['list', '--status', 'done']);
      expect(result).toContain('Closed Task');
    });

    it('filters by project', async () => {
      createTask(app, 'ved-task', { project: 'ved' });
      createTask(app, 'other-task', { project: 'other' });

      const result = await runTaskCommand(app, ['list', '--project', 'ved']);
      expect(result).toContain('Ved Task');
      expect(result).not.toContain('Other Task');
    });

    it('filters by priority', async () => {
      createTask(app, 'high-task', { priority: 'high' });
      createTask(app, 'low-task', { priority: 'low' });

      const result = await runTaskCommand(app, ['list', '--priority', 'high']);
      expect(result).toContain('High Task');
      expect(result).not.toContain('Low Task');
    });

    it('filters by assignee', async () => {
      createTask(app, 'nag-task', { assignee: 'nag' });
      createTask(app, 'other-task', { assignee: 'other' });

      const result = await runTaskCommand(app, ['list', '--assignee', 'nag']);
      expect(result).toContain('Nag Task');
      expect(result).not.toContain('Other Task');
    });

    it('respects --limit', async () => {
      for (let i = 0; i < 10; i++) createTask(app, `task-${i}`);

      const result = await runTaskCommand(app, ['list', '--limit', '3']);
      // Count task lines (lines with task IDs in parentheses)
      const taskLines = result.split('\n').filter(l => l.includes('(task-'));
      expect(taskLines.length).toBe(3);
    });

    it('skips non-task files in tasks/', async () => {
      createTask(app, 'real-task');
      // Create a non-task file
      app.memory.vault.createFile('tasks/readme.md', { type: 'note' }, '# Not a task\n');

      const result = await runTaskCommand(app, ['list']);
      expect(result).toContain('Real Task');
      expect(result).not.toContain('readme');
    });
  });

  // ─── Show ───

  describe('show', () => {
    it('shows task details', async () => {
      createTask(app, 'my-task', {
        priority: 'high',
        due: '2026-04-01',
        assignee: 'nag',
        project: 'ved',
        tags: ['infra', 'release'],
      });

      const result = await runTaskCommand(app, ['show', 'my-task']);
      expect(result).toContain('My Task');
      expect(result).toContain('high');
      expect(result).toContain('2026-04-01');
      expect(result).toContain('@nag');
      expect(result).toContain('ved');
      expect(result).toContain('#infra');
    });

    it('finds by partial title', async () => {
      createTask(app, 'deploy-the-app');
      const result = await runTaskCommand(app, ['show', 'deploy']);
      expect(result).toContain('Deploy The App');
    });

    it('errors on not found', async () => {
      const result = await runTaskCommand(app, ['show', 'nonexistent']);
      expect(result).toContain('Error');
      expect(result).toContain('not found');
    });

    it('errors on empty query', async () => {
      const result = await runTaskCommand(app, ['show']);
      expect(result).toContain('Error');
    });
  });

  // ─── Edit ───

  describe('edit', () => {
    it('updates status', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, ['edit', 'my-task', '--status', 'in-progress']);
      expect(result).toContain('✓');
      expect(result).toContain('status → in-progress');

      const file = app.memory.vault.readFile('tasks/my-task.md');
      expect(file.frontmatter.status).toBe('in-progress');
    });

    it('auto-sets completed date when marking done', async () => {
      createTask(app, 'my-task');
      await runTaskCommand(app, ['edit', 'my-task', '--status', 'done']);

      const file = app.memory.vault.readFile('tasks/my-task.md');
      expect(file.frontmatter.status).toBe('done');
      expect(file.frontmatter.completed).toBeTruthy();
    });

    it('updates priority', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, ['edit', 'my-task', '--priority', 'critical']);
      expect(result).toContain('priority → critical');
    });

    it('removes due date with "none"', async () => {
      createTask(app, 'my-task', { due: '2026-04-01' });
      const result = await runTaskCommand(app, ['edit', 'my-task', '--due', 'none']);
      expect(result).toContain('due → removed');

      const file = app.memory.vault.readFile('tasks/my-task.md');
      expect(file.frontmatter.due).toBeUndefined();
    });

    it('rejects invalid status', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, ['edit', 'my-task', '--status', 'invalid']);
      expect(result).toContain('Error');
      expect(result).toContain('Invalid status');
    });

    it('reports no changes if no flags', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, ['edit', 'my-task']);
      expect(result).toContain('No changes');
    });

    it('updates multiple fields at once', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, [
        'edit', 'my-task',
        '--status', 'in-progress',
        '--priority', 'high',
        '--assignee', 'nag',
      ]);
      expect(result).toContain('status → in-progress');
      expect(result).toContain('priority → high');
      expect(result).toContain('assignee → @nag');
    });
  });

  // ─── Done ───

  describe('done', () => {
    it('marks a task done', async () => {
      createTask(app, 'my-task');
      const result = await runTaskCommand(app, ['done', 'my-task']);
      expect(result).toContain('✓');
      expect(result).toContain('Completed');

      const file = app.memory.vault.readFile('tasks/my-task.md');
      expect(file.frontmatter.status).toBe('done');
      expect(file.frontmatter.completed).toBeTruthy();
    });

    it('adds completion note', async () => {
      createTask(app, 'my-task');
      await runTaskCommand(app, ['done', 'my-task', '--note', 'Shipped to prod']);

      const file = app.memory.vault.readFile('tasks/my-task.md');
      expect(file.body).toContain('Completion Note');
      expect(file.body).toContain('Shipped to prod');
    });

    it('warns if already done', async () => {
      createTask(app, 'my-task', { status: 'done' });
      const result = await runTaskCommand(app, ['done', 'my-task']);
      expect(result).toContain('already done');
    });

    it('errors on not found', async () => {
      const result = await runTaskCommand(app, ['done', 'nonexistent']);
      expect(result).toContain('Error');
    });
  });

  // ─── Archive ───

  describe('archive', () => {
    it('archives done tasks', async () => {
      createTask(app, 'done-task', { status: 'done', completed: '2026-03-01' });
      createTask(app, 'open-task');

      const result = await runTaskCommand(app, ['archive']);
      expect(result).toContain('✓');
      expect(result).toContain('Archived 1');
      expect(app.memory.vault.exists('tasks/archive/done-task.md')).toBe(true);
      expect(app.memory.vault.exists('tasks/done-task.md')).toBe(false);
      expect(app.memory.vault.exists('tasks/open-task.md')).toBe(true);
    });

    it('filters by --before date', async () => {
      createTask(app, 'old-task', { status: 'done', completed: '2026-01-01' });
      createTask(app, 'new-task', { status: 'done', completed: '2026-03-15' });

      const result = await runTaskCommand(app, ['archive', '--before', '2026-02-01']);
      expect(result).toContain('Archived 1');
      expect(app.memory.vault.exists('tasks/archive/old-task.md')).toBe(true);
      expect(app.memory.vault.exists('tasks/new-task.md')).toBe(true);
    });

    it('reports empty when nothing to archive', async () => {
      createTask(app, 'open-task');
      const result = await runTaskCommand(app, ['archive']);
      expect(result).toContain('No tasks to archive');
    });
  });

  // ─── Board ───

  describe('board', () => {
    it('shows kanban-style board', async () => {
      createTask(app, 'task-a', { status: 'todo' });
      createTask(app, 'task-b', { status: 'in-progress' });
      createTask(app, 'task-c', { status: 'done' });

      const result = await runTaskCommand(app, ['board']);
      expect(result).toContain('TODO');
      expect(result).toContain('IN-PROGRESS');
      expect(result).toContain('DONE');
      expect(result).toContain('Task A');
      expect(result).toContain('Task B');
      expect(result).toContain('Task C');
    });

    it('filters by project', async () => {
      createTask(app, 'ved-task', { project: 'ved' });
      createTask(app, 'other-task', { project: 'other' });

      const result = await runTaskCommand(app, ['board', '--project', 'ved']);
      expect(result).toContain('Board: ved');
      expect(result).toContain('Ved Task');
      expect(result).not.toContain('Other Task');
    });

    it('shows empty columns', async () => {
      const result = await runTaskCommand(app, ['board']);
      expect(result).toContain('(empty)');
    });
  });

  // ─── Stats ───

  describe('stats', () => {
    it('shows statistics', async () => {
      createTask(app, 'task-a', { status: 'todo', priority: 'high' });
      createTask(app, 'task-b', { status: 'done', priority: 'medium', completed: '2026-03-18', created: '2026-03-15' });
      createTask(app, 'task-c', { status: 'in-progress', priority: 'low' });

      const result = await runTaskCommand(app, ['stats']);
      expect(result).toContain('Total:');
      expect(result).toContain('3');
      expect(result).toContain('Completion:');
      expect(result).toContain('By Status');
      expect(result).toContain('By Priority');
    });

    it('shows empty state', async () => {
      const result = await runTaskCommand(app, ['stats']);
      expect(result).toContain('No tasks');
    });

    it('filters by project', async () => {
      createTask(app, 'ved-task', { project: 'ved' });
      createTask(app, 'other-task', { project: 'other' });

      const result = await runTaskCommand(app, ['stats', '--project', 'ved']);
      expect(result).toContain('Task Stats: ved');
    });
  });

  // ─── Projects ───

  describe('projects', () => {
    it('lists projects with stats', async () => {
      createTask(app, 'task-a', { project: 'ved' });
      createTask(app, 'task-b', { project: 'ved', status: 'done' });
      createTask(app, 'task-c', { project: 'other' });

      const result = await runTaskCommand(app, ['projects']);
      expect(result).toContain('ved');
      expect(result).toContain('other');
      expect(result).toContain('2 tasks');
      expect(result).toContain('50%');
    });

    it('shows tasks without projects', async () => {
      createTask(app, 'unassigned-task');
      const result = await runTaskCommand(app, ['projects']);
      expect(result).toContain('(none)');
    });

    it('shows empty state', async () => {
      const result = await runTaskCommand(app, ['projects']);
      expect(result).toContain('No tasks');
    });
  });

  // ─── Search ───

  describe('search', () => {
    it('searches by title', async () => {
      createTask(app, 'deploy-app');
      createTask(app, 'fix-bug');

      const result = await runTaskCommand(app, ['search', 'deploy']);
      expect(result).toContain('Deploy App');
      expect(result).not.toContain('Fix Bug');
    });

    it('searches by project', async () => {
      createTask(app, 'task-a', { project: 'ved' });
      createTask(app, 'task-b', { project: 'other' });

      const result = await runTaskCommand(app, ['search', 'ved']);
      expect(result).toContain('Task A');
      expect(result).not.toContain('Task B');
    });

    it('searches by tag', async () => {
      createTask(app, 'task-a', { tags: ['infra'] });
      createTask(app, 'task-b', { tags: ['docs'] });

      const result = await runTaskCommand(app, ['search', 'infra']);
      expect(result).toContain('Task A');
      expect(result).not.toContain('Task B');
    });

    it('shows empty results', async () => {
      const result = await runTaskCommand(app, ['search', 'nonexistent']);
      expect(result).toContain('No tasks matching');
    });

    it('requires a query', async () => {
      const result = await runTaskCommand(app, ['search']);
      expect(result).toContain('Error');
    });
  });

  // ─── Due date filtering ───

  describe('due date filtering', () => {
    it('filters overdue tasks', async () => {
      createTask(app, 'overdue-task', { due: '2020-01-01' });
      createTask(app, 'future-task', { due: '2030-01-01' });

      const result = await runTaskCommand(app, ['list', '--due', 'overdue']);
      expect(result).toContain('Overdue Task');
      expect(result).not.toContain('Future Task');
    });

    it('filters by specific date', async () => {
      createTask(app, 'target-task', { due: '2026-04-01' });
      createTask(app, 'other-task', { due: '2026-05-01' });

      const result = await runTaskCommand(app, ['list', '--due', '2026-04-01']);
      expect(result).toContain('Target Task');
      expect(result).not.toContain('Other Task');
    });
  });

  // ─── Subcommand aliases ───

  describe('aliases', () => {
    it('ls = list', async () => {
      createTask(app, 'test-task');
      const result = await runTaskCommand(app, ['ls']);
      expect(result).toContain('Test Task');
    });

    it('new = add', async () => {
      const result = await runTaskCommand(app, ['new', 'Test', 'Task']);
      expect(result).toContain('✓');
    });

    it('view = show', async () => {
      createTask(app, 'test-task');
      const result = await runTaskCommand(app, ['view', 'test-task']);
      expect(result).toContain('Test Task');
    });

    it('complete = done', async () => {
      createTask(app, 'test-task');
      const result = await runTaskCommand(app, ['complete', 'test-task']);
      expect(result).toContain('Completed');
    });

    it('kanban = board', async () => {
      const result = await runTaskCommand(app, ['kanban']);
      expect(result).toContain('Task Board');
    });

    it('find = search', async () => {
      createTask(app, 'needle-task');
      const result = await runTaskCommand(app, ['find', 'needle']);
      expect(result).toContain('Needle Task');
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('unknown subcommand returns error', async () => {
      const result = await runTaskCommand(app, ['badcmd']);
      expect(result).toContain('Unknown subcommand');
    });

    it('default subcommand is list', async () => {
      createTask(app, 'test-task');
      const result = await runTaskCommand(app, []);
      expect(result).toContain('Test Task');
    });

    it('handles task with no body content', async () => {
      app.memory.vault.createFile('tasks/empty-task.md', {
        type: 'task', status: 'todo', priority: 'low', created: '2026-03-15'
      }, '# Empty Task\n');

      const result = await runTaskCommand(app, ['show', 'empty-task']);
      expect(result).toContain('Empty Task');
    });

    it('slugify handles special characters', async () => {
      const result = await runTaskCommand(app, ['add', 'Fix: the BIG bug!!! (urgent)']);
      expect(result).toContain('✓');
      expect(app.memory.vault.exists('tasks/fix-the-big-bug-urgent.md')).toBe(true);
    });

    it('handles tag filtering', async () => {
      createTask(app, 'tagged-task', { tags: ['release'] });
      createTask(app, 'untagged-task');

      const result = await runTaskCommand(app, ['list', '--tag', 'release']);
      expect(result).toContain('Tagged Task');
      expect(result).not.toContain('Untagged Task');
    });
  });
});
