/**
 * `ved task` — Task management backed by the Obsidian vault.
 *
 * Tasks are markdown files in `tasks/` with structured YAML frontmatter
 * (status, priority, due, assignee, tags, project). Supports full CRUD,
 * filtering, Kanban-style board view, and task lifecycle tracking.
 *
 * Subcommands:
 *   list [--status <s>] [--priority <p>] [--project <p>] [--assignee <a>] [--due <d>] [--tag <t>] [--limit N]
 *   add <title> [--priority <p>] [--due <d>] [--assignee <a>] [--project <p>] [--tag <t>...]
 *   show <id|title>
 *   edit <id|title> [--status <s>] [--priority <p>] [--due <d>] [--assignee <a>] [--project <p>]
 *   done <id|title> [--note <note>]
 *   archive [--before <date>] [--status done]
 *   board [--project <p>]
 *   stats [--project <p>]
 *   projects
 *   search <query>
 *
 * Aliases: ved tasks, ved todo, ved todos
 *
 * @module cli-task
 */

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
  blue: '\x1B[34m',
  white: '\x1B[37m',
};

// ── Types ──

export type TaskStatus = 'todo' | 'in-progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface TaskFrontmatter {
  type: 'task';
  status: TaskStatus;
  priority: TaskPriority;
  created: string;       // ISO date
  due?: string;          // ISO date
  completed?: string;    // ISO date
  assignee?: string;
  project?: string;
  tags?: string[];
}

export interface Task {
  id: string;           // filename without extension
  path: string;         // relative vault path
  title: string;        // first H1 or filename
  frontmatter: TaskFrontmatter;
  body: string;         // markdown body
}

// ── Constants ──

const TASK_FOLDER = 'tasks';
const VALID_STATUSES: TaskStatus[] = ['todo', 'in-progress', 'blocked', 'done', 'cancelled'];
const VALID_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
const STATUS_ICONS: Record<TaskStatus, string> = {
  'todo': '○',
  'in-progress': '◐',
  'blocked': '⊘',
  'done': '●',
  'cancelled': '✕',
};
const PRIORITY_COLORS: Record<TaskPriority, string> = {
  'critical': C.red,
  'high': C.yellow,
  'medium': C.cyan,
  'low': C.dim,
};
const STATUS_COLORS: Record<TaskStatus, string> = {
  'todo': C.white,
  'in-progress': C.cyan,
  'blocked': C.red,
  'done': C.green,
  'cancelled': C.dim,
};

// ── Helpers ──

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string>; multiFlags: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const multiFlags: Record<string, string[]> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        if (!multiFlags[key]) multiFlags[key] = [];
        multiFlags[key].push(next);
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags, multiFlags };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.round((db.getTime() - da.getTime()) / (86400 * 1000));
}

function dueLabel(due: string): string {
  const days = daysBetween(todayISO(), due);
  if (days < 0) return `${C.red}overdue ${-days}d${C.reset}`;
  if (days === 0) return `${C.yellow}today${C.reset}`;
  if (days === 1) return `${C.yellow}tomorrow${C.reset}`;
  if (days <= 7) return `${C.cyan}${days}d${C.reset}`;
  return `${C.dim}${days}d${C.reset}`;
}

// ── Task Loader ──

function loadTasks(app: VedApp): Task[] {
  const vault = app.memory.vault;
  const files = vault.listFiles(TASK_FOLDER);
  const tasks: Task[] = [];

  for (const relPath of files) {
    if (!relPath.endsWith('.md')) continue;
    try {
      const file = vault.readFile(relPath);
      const fm = file.frontmatter as Record<string, unknown>;
      if (fm.type !== 'task') continue;

      const id = relPath.replace(/^tasks\//, '').replace(/\.md$/, '');
      const titleMatch = file.body.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : id;

      tasks.push({
        id,
        path: relPath,
        title,
        frontmatter: {
          type: 'task',
          status: (VALID_STATUSES.includes(fm.status as TaskStatus) ? fm.status : 'todo') as TaskStatus,
          priority: (VALID_PRIORITIES.includes(fm.priority as TaskPriority) ? fm.priority : 'medium') as TaskPriority,
          created: (fm.created as string) || todayISO(),
          due: fm.due as string | undefined,
          completed: fm.completed as string | undefined,
          assignee: fm.assignee as string | undefined,
          project: fm.project as string | undefined,
          tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
        },
        body: file.body,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return tasks;
}

function findTask(tasks: Task[], query: string): Task | undefined {
  // Exact ID match
  const exact = tasks.find(t => t.id === query);
  if (exact) return exact;

  // Case-insensitive title match
  const lower = query.toLowerCase();
  const titleMatch = tasks.find(t => t.title.toLowerCase() === lower);
  if (titleMatch) return titleMatch;

  // Partial match
  return tasks.find(t =>
    t.id.toLowerCase().includes(lower) ||
    t.title.toLowerCase().includes(lower)
  );
}

function filterTasks(tasks: Task[], flags: Record<string, string>): Task[] {
  let filtered = tasks;

  if (flags.status) {
    const s = flags.status as TaskStatus;
    filtered = filtered.filter(t => t.frontmatter.status === s);
  }
  if (flags.priority) {
    const p = flags.priority as TaskPriority;
    filtered = filtered.filter(t => t.frontmatter.priority === p);
  }
  if (flags.project) {
    const proj = flags.project.toLowerCase();
    filtered = filtered.filter(t => t.frontmatter.project?.toLowerCase() === proj);
  }
  if (flags.assignee) {
    const a = flags.assignee.toLowerCase();
    filtered = filtered.filter(t => t.frontmatter.assignee?.toLowerCase() === a);
  }
  if (flags.tag) {
    const tag = flags.tag.toLowerCase();
    filtered = filtered.filter(t => t.frontmatter.tags?.some(tg => tg.toLowerCase() === tag));
  }
  if (flags.due) {
    const d = flags.due;
    if (d === 'overdue') {
      filtered = filtered.filter(t => t.frontmatter.due && t.frontmatter.due < todayISO());
    } else if (d === 'today') {
      filtered = filtered.filter(t => t.frontmatter.due === todayISO());
    } else if (d === 'week') {
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const weekStr = nextWeek.toISOString().slice(0, 10);
      filtered = filtered.filter(t => t.frontmatter.due && t.frontmatter.due <= weekStr);
    } else if (isValidDate(d)) {
      filtered = filtered.filter(t => t.frontmatter.due === d);
    }
  }

  return filtered;
}

function sortTasks(tasks: Task[]): Task[] {
  const priorityOrder: Record<TaskPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const statusOrder: Record<TaskStatus, number> = { 'blocked': 0, 'in-progress': 1, 'todo': 2, 'done': 3, 'cancelled': 4 };

  return [...tasks].sort((a, b) => {
    // Active tasks first
    const sa = statusOrder[a.frontmatter.status] ?? 4;
    const sb = statusOrder[b.frontmatter.status] ?? 4;
    if (sa !== sb) return sa - sb;

    // Higher priority first
    const pa = priorityOrder[a.frontmatter.priority] ?? 2;
    const pb = priorityOrder[b.frontmatter.priority] ?? 2;
    if (pa !== pb) return pa - pb;

    // Earlier due date first
    if (a.frontmatter.due && b.frontmatter.due) {
      return a.frontmatter.due.localeCompare(b.frontmatter.due);
    }
    if (a.frontmatter.due) return -1;
    if (b.frontmatter.due) return 1;

    // Newest first
    return b.frontmatter.created.localeCompare(a.frontmatter.created);
  });
}

function formatTaskLine(t: Task): string {
  const icon = STATUS_ICONS[t.frontmatter.status];
  const sc = STATUS_COLORS[t.frontmatter.status];
  const pc = PRIORITY_COLORS[t.frontmatter.priority];
  const due = t.frontmatter.due ? ` ${dueLabel(t.frontmatter.due)}` : '';
  const proj = t.frontmatter.project ? ` ${C.magenta}[${t.frontmatter.project}]${C.reset}` : '';
  const assignee = t.frontmatter.assignee ? ` ${C.dim}@${t.frontmatter.assignee}${C.reset}` : '';
  const tags = t.frontmatter.tags?.length ? ` ${C.dim}#${t.frontmatter.tags.join(' #')}${C.reset}` : '';
  return `  ${sc}${icon}${C.reset} ${pc}${t.frontmatter.priority[0].toUpperCase()}${C.reset} ${C.bold}${t.title}${C.reset}${due}${proj}${assignee}${tags} ${C.dim}(${t.id})${C.reset}`;
}

// ── Subcommands ──

function cmdList(app: VedApp, args: string[]): string {
  const { flags } = parseArgs(args);
  const limit = parseInt(flags.limit || '50', 10);
  const all = loadTasks(app);
  let tasks = filterTasks(all, flags);

  // By default, hide done/cancelled unless explicitly filtered
  if (!flags.status) {
    tasks = tasks.filter(t => t.frontmatter.status !== 'done' && t.frontmatter.status !== 'cancelled');
  }

  tasks = sortTasks(tasks);
  if (limit > 0) tasks = tasks.slice(0, limit);

  if (tasks.length === 0) {
    return `${C.dim}No tasks found.${C.reset}`;
  }

  const lines = [`${C.bold}Tasks${C.reset} (${tasks.length}${all.length > tasks.length ? '/' + all.length : ''})\n`];
  for (const t of tasks) {
    lines.push(formatTaskLine(t));
  }
  return lines.join('\n');
}

function cmdAdd(app: VedApp, args: string[]): string {
  const { positional, flags, multiFlags } = parseArgs(args);
  const title = positional.join(' ').trim();

  if (!title) {
    return `${C.red}Error: Task title is required.${C.reset}\nUsage: ved task add <title> [--priority <p>] [--due YYYY-MM-DD] [--assignee <a>] [--project <p>] [--tag <t>...]`;
  }

  const priority = flags.priority as TaskPriority || 'medium';
  if (!VALID_PRIORITIES.includes(priority)) {
    return `${C.red}Error: Invalid priority '${priority}'. Must be: ${VALID_PRIORITIES.join(', ')}${C.reset}`;
  }

  if (flags.due && !isValidDate(flags.due)) {
    return `${C.red}Error: Invalid date '${flags.due}'. Format: YYYY-MM-DD${C.reset}`;
  }

  const slug = slugify(title);
  if (!slug) {
    return `${C.red}Error: Could not generate a valid filename from title.${C.reset}`;
  }

  const relPath = `${TASK_FOLDER}/${slug}.md`;
  const vault = app.memory.vault;

  // Ensure tasks/ directory exists
  if (!vault.listFiles(TASK_FOLDER).length && !vault.exists(relPath)) {
    // Vault will create parent directories on createFile
  }

  if (vault.exists(relPath)) {
    return `${C.red}Error: Task '${slug}' already exists. Choose a different title.${C.reset}`;
  }

  const frontmatter: Record<string, unknown> = {
    type: 'task',
    status: 'todo',
    priority,
    created: todayISO(),
  };

  if (flags.due) frontmatter.due = flags.due;
  if (flags.assignee) frontmatter.assignee = flags.assignee;
  if (flags.project) frontmatter.project = flags.project;
  if (multiFlags.tag?.length) frontmatter.tags = multiFlags.tag;

  const body = `# ${title}\n`;

  vault.createFile(relPath, frontmatter, body);

  return `${C.green}✓${C.reset} Created task: ${C.bold}${title}${C.reset} ${C.dim}(${slug})${C.reset}`;
}

function cmdShow(app: VedApp, args: string[]): string {
  const { positional } = parseArgs(args);
  const query = positional.join(' ').trim();
  if (!query) {
    return `${C.red}Error: Task ID or title required.${C.reset}`;
  }

  const tasks = loadTasks(app);
  const task = findTask(tasks, query);
  if (!task) {
    return `${C.red}Error: Task '${query}' not found.${C.reset}`;
  }

  const fm = task.frontmatter;
  const sc = STATUS_COLORS[fm.status];
  const pc = PRIORITY_COLORS[fm.priority];
  const lines: string[] = [
    `${C.bold}${task.title}${C.reset}`,
    '',
    `  ${C.dim}ID:${C.reset}       ${task.id}`,
    `  ${C.dim}Status:${C.reset}   ${sc}${STATUS_ICONS[fm.status]} ${fm.status}${C.reset}`,
    `  ${C.dim}Priority:${C.reset} ${pc}${fm.priority}${C.reset}`,
    `  ${C.dim}Created:${C.reset}  ${fm.created}`,
  ];
  if (fm.due) lines.push(`  ${C.dim}Due:${C.reset}      ${fm.due} (${dueLabel(fm.due)})`);
  if (fm.completed) lines.push(`  ${C.dim}Done:${C.reset}     ${fm.completed}`);
  if (fm.assignee) lines.push(`  ${C.dim}Assignee:${C.reset} @${fm.assignee}`);
  if (fm.project) lines.push(`  ${C.dim}Project:${C.reset}  ${fm.project}`);
  if (fm.tags?.length) lines.push(`  ${C.dim}Tags:${C.reset}     #${fm.tags.join(' #')}`);

  // Show body content (skip the H1 title line)
  const bodyContent = task.body.replace(/^#\s+.+\n?/, '').trim();
  if (bodyContent) {
    lines.push('', `  ${C.dim}───${C.reset}`, '');
    lines.push(bodyContent);
  }

  return lines.join('\n');
}

function cmdEdit(app: VedApp, args: string[]): string {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ').trim();
  if (!query) {
    return `${C.red}Error: Task ID or title required.${C.reset}`;
  }

  const tasks = loadTasks(app);
  const task = findTask(tasks, query);
  if (!task) {
    return `${C.red}Error: Task '${query}' not found.${C.reset}`;
  }

  const updates: Record<string, unknown> = {};
  const changes: string[] = [];

  if (flags.status) {
    if (!VALID_STATUSES.includes(flags.status as TaskStatus)) {
      return `${C.red}Error: Invalid status '${flags.status}'. Must be: ${VALID_STATUSES.join(', ')}${C.reset}`;
    }
    updates.status = flags.status;
    changes.push(`status → ${flags.status}`);
    if (flags.status === 'done' && !task.frontmatter.completed) {
      updates.completed = todayISO();
      changes.push(`completed → ${todayISO()}`);
    }
  }

  if (flags.priority) {
    if (!VALID_PRIORITIES.includes(flags.priority as TaskPriority)) {
      return `${C.red}Error: Invalid priority '${flags.priority}'. Must be: ${VALID_PRIORITIES.join(', ')}${C.reset}`;
    }
    updates.priority = flags.priority;
    changes.push(`priority → ${flags.priority}`);
  }

  if (flags.due) {
    if (flags.due === 'none') {
      updates.due = undefined;
      changes.push('due → removed');
    } else if (isValidDate(flags.due)) {
      updates.due = flags.due;
      changes.push(`due → ${flags.due}`);
    } else {
      return `${C.red}Error: Invalid date '${flags.due}'. Format: YYYY-MM-DD or 'none'${C.reset}`;
    }
  }

  if (flags.assignee) {
    if (flags.assignee === 'none') {
      updates.assignee = undefined;
      changes.push('assignee → removed');
    } else {
      updates.assignee = flags.assignee;
      changes.push(`assignee → @${flags.assignee}`);
    }
  }

  if (flags.project) {
    if (flags.project === 'none') {
      updates.project = undefined;
      changes.push('project → removed');
    } else {
      updates.project = flags.project;
      changes.push(`project → ${flags.project}`);
    }
  }

  if (changes.length === 0) {
    return `${C.yellow}No changes specified.${C.reset} Use --status, --priority, --due, --assignee, or --project.`;
  }

  const vault = app.memory.vault;
  vault.updateFile(task.path, { frontmatter: updates });

  return `${C.green}✓${C.reset} Updated ${C.bold}${task.title}${C.reset}: ${changes.join(', ')}`;
}

function cmdDone(app: VedApp, args: string[]): string {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ').trim();
  if (!query) {
    return `${C.red}Error: Task ID or title required.${C.reset}`;
  }

  const tasks = loadTasks(app);
  const task = findTask(tasks, query);
  if (!task) {
    return `${C.red}Error: Task '${query}' not found.${C.reset}`;
  }

  if (task.frontmatter.status === 'done') {
    return `${C.yellow}Task '${task.title}' is already done.${C.reset}`;
  }

  const vault = app.memory.vault;
  const updates: Record<string, unknown> = {
    status: 'done',
    completed: todayISO(),
  };

  // Append completion note to body if provided
  if (flags.note) {
    const existing = vault.readFile(task.path);
    const newBody = existing.body.trimEnd() + `\n\n## Completion Note\n${flags.note}\n`;
    vault.updateFile(task.path, { frontmatter: updates, body: newBody });
  } else {
    vault.updateFile(task.path, { frontmatter: updates });
  }

  return `${C.green}✓${C.reset} Completed: ${C.bold}${task.title}${C.reset}`;
}

function cmdArchive(app: VedApp, args: string[]): string {
  const { flags } = parseArgs(args);
  const tasks = loadTasks(app);
  const vault = app.memory.vault;

  let toArchive = tasks.filter(t =>
    t.frontmatter.status === 'done' || t.frontmatter.status === 'cancelled'
  );

  if (flags.before && isValidDate(flags.before)) {
    toArchive = toArchive.filter(t => {
      const dateField = t.frontmatter.completed || t.frontmatter.created;
      return dateField <= flags.before;
    });
  }

  if (flags.status) {
    toArchive = toArchive.filter(t => t.frontmatter.status === flags.status);
  }

  if (toArchive.length === 0) {
    return `${C.dim}No tasks to archive.${C.reset}`;
  }

  let archived = 0;
  for (const task of toArchive) {
    const archivePath = `tasks/archive/${task.id}.md`;
    try {
      const file = vault.readFile(task.path);
      vault.createFile(archivePath, file.frontmatter, file.body);
      vault.deleteFile(task.path);
      archived++;
    } catch {
      // Skip failures
    }
  }

  return `${C.green}✓${C.reset} Archived ${archived} task${archived === 1 ? '' : 's'} to tasks/archive/`;
}

function cmdBoard(app: VedApp, args: string[]): string {
  const { flags } = parseArgs(args);
  let tasks = loadTasks(app);

  if (flags.project) {
    const proj = flags.project.toLowerCase();
    tasks = tasks.filter(t => t.frontmatter.project?.toLowerCase() === proj);
  }

  // Group by status (active statuses only)
  const columns: TaskStatus[] = ['todo', 'in-progress', 'blocked', 'done'];
  const grouped: Record<string, Task[]> = {};
  for (const s of columns) grouped[s] = [];

  for (const t of tasks) {
    if (t.frontmatter.status !== 'cancelled') {
      const bucket = grouped[t.frontmatter.status] || grouped['todo'];
      bucket.push(t);
    }
  }

  // Sort each column
  for (const s of columns) {
    grouped[s] = sortTasks(grouped[s]);
  }

  const title = flags.project ? `Board: ${flags.project}` : 'Task Board';
  const lines: string[] = [`${C.bold}${title}${C.reset}\n`];

  for (const status of columns) {
    const sc = STATUS_COLORS[status];
    const icon = STATUS_ICONS[status];
    const items = grouped[status];
    lines.push(`${sc}${C.bold}${icon} ${status.toUpperCase()}${C.reset} (${items.length})`);

    if (items.length === 0) {
      lines.push(`  ${C.dim}(empty)${C.reset}`);
    } else {
      for (const t of items) {
        const pc = PRIORITY_COLORS[t.frontmatter.priority];
        const due = t.frontmatter.due ? ` ${dueLabel(t.frontmatter.due)}` : '';
        lines.push(`  ${pc}${t.frontmatter.priority[0].toUpperCase()}${C.reset} ${t.title}${due} ${C.dim}(${t.id})${C.reset}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function cmdStats(app: VedApp, args: string[]): string {
  const { flags } = parseArgs(args);
  let tasks = loadTasks(app);

  if (flags.project) {
    const proj = flags.project.toLowerCase();
    tasks = tasks.filter(t => t.frontmatter.project?.toLowerCase() === proj);
  }

  const total = tasks.length;
  if (total === 0) {
    return `${C.dim}No tasks found.${C.reset}`;
  }

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const t of tasks) {
    statusCounts[t.frontmatter.status] = (statusCounts[t.frontmatter.status] || 0) + 1;
  }

  // Priority counts
  const priorityCounts: Record<string, number> = {};
  for (const t of tasks) {
    priorityCounts[t.frontmatter.priority] = (priorityCounts[t.frontmatter.priority] || 0) + 1;
  }

  // Overdue count
  const today = todayISO();
  const overdue = tasks.filter(t =>
    t.frontmatter.due && t.frontmatter.due < today &&
    t.frontmatter.status !== 'done' && t.frontmatter.status !== 'cancelled'
  ).length;

  // Due this week
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const weekStr = nextWeek.toISOString().slice(0, 10);
  const dueThisWeek = tasks.filter(t =>
    t.frontmatter.due && t.frontmatter.due >= today && t.frontmatter.due <= weekStr &&
    t.frontmatter.status !== 'done' && t.frontmatter.status !== 'cancelled'
  ).length;

  // Completion rate
  const doneCount = statusCounts['done'] || 0;
  const completionRate = total > 0 ? ((doneCount / total) * 100).toFixed(0) : '0';

  // Avg time to complete (for done tasks with created + completed dates)
  const doneTasks = tasks.filter(t => t.frontmatter.status === 'done' && t.frontmatter.completed);
  let avgDays = 0;
  if (doneTasks.length > 0) {
    const totalDays = doneTasks.reduce((sum, t) =>
      sum + daysBetween(t.frontmatter.created, t.frontmatter.completed!), 0);
    avgDays = totalDays / doneTasks.length;
  }

  const title = flags.project ? `Task Stats: ${flags.project}` : 'Task Stats';
  const lines: string[] = [
    `${C.bold}${title}${C.reset}\n`,
    `  ${C.dim}Total:${C.reset}        ${total}`,
    `  ${C.dim}Completion:${C.reset}   ${completionRate}%`,
  ];

  if (doneTasks.length > 0) {
    lines.push(`  ${C.dim}Avg resolve:${C.reset}  ${avgDays.toFixed(1)} days`);
  }

  if (overdue > 0) lines.push(`  ${C.red}Overdue:${C.reset}      ${overdue}`);
  if (dueThisWeek > 0) lines.push(`  ${C.yellow}Due this wk:${C.reset}  ${dueThisWeek}`);

  lines.push('');
  lines.push(`  ${C.bold}By Status${C.reset}`);
  for (const s of VALID_STATUSES) {
    const count = statusCounts[s] || 0;
    if (count > 0) {
      const sc = STATUS_COLORS[s];
      const bar = '█'.repeat(Math.max(1, Math.round((count / total) * 20)));
      lines.push(`  ${sc}${STATUS_ICONS[s]} ${s.padEnd(12)}${C.reset} ${bar} ${count}`);
    }
  }

  lines.push('');
  lines.push(`  ${C.bold}By Priority${C.reset}`);
  for (const p of VALID_PRIORITIES) {
    const count = priorityCounts[p] || 0;
    if (count > 0) {
      const pc = PRIORITY_COLORS[p];
      const bar = '█'.repeat(Math.max(1, Math.round((count / total) * 20)));
      lines.push(`  ${pc}${p.padEnd(10)}${C.reset} ${bar} ${count}`);
    }
  }

  return lines.join('\n');
}

function cmdProjects(app: VedApp): string {
  const tasks = loadTasks(app);
  const projects = new Map<string, { total: number; done: number; active: number }>();

  for (const t of tasks) {
    const proj = t.frontmatter.project || '(none)';
    if (!projects.has(proj)) projects.set(proj, { total: 0, done: 0, active: 0 });
    const p = projects.get(proj)!;
    p.total++;
    if (t.frontmatter.status === 'done') p.done++;
    if (t.frontmatter.status === 'todo' || t.frontmatter.status === 'in-progress') p.active++;
  }

  if (projects.size === 0) {
    return `${C.dim}No tasks found.${C.reset}`;
  }

  const lines: string[] = [`${C.bold}Projects${C.reset}\n`];
  const sorted = [...projects.entries()].sort((a, b) => b[1].active - a[1].active);

  for (const [name, stats] of sorted) {
    const pct = stats.total > 0 ? ((stats.done / stats.total) * 100).toFixed(0) : '0';
    const active = stats.active > 0 ? ` ${C.cyan}${stats.active} active${C.reset}` : '';
    lines.push(`  ${C.magenta}${name}${C.reset} — ${stats.total} tasks, ${pct}% done${active}`);
  }

  return lines.join('\n');
}

function cmdSearch(app: VedApp, args: string[]): string {
  const query = args.join(' ').trim().toLowerCase();
  if (!query) {
    return `${C.red}Error: Search query required.${C.reset}`;
  }

  const tasks = loadTasks(app);
  const results = tasks.filter(t =>
    t.title.toLowerCase().includes(query) ||
    t.id.toLowerCase().includes(query) ||
    t.body.toLowerCase().includes(query) ||
    t.frontmatter.project?.toLowerCase().includes(query) ||
    t.frontmatter.assignee?.toLowerCase().includes(query) ||
    t.frontmatter.tags?.some(tg => tg.toLowerCase().includes(query))
  );

  if (results.length === 0) {
    return `${C.dim}No tasks matching '${query}'.${C.reset}`;
  }

  const sorted = sortTasks(results);
  const lines: string[] = [`${C.bold}Search: ${query}${C.reset} (${sorted.length} result${sorted.length === 1 ? '' : 's'})\n`];
  for (const t of sorted) {
    lines.push(formatTaskLine(t));
  }
  return lines.join('\n');
}

// ── Main Entry ──

export function checkHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function helpText(): string {
  return [
    `${C.bold}ved task${C.reset} — Task management backed by the Obsidian vault`,
    '',
    `${C.bold}Usage:${C.reset}`,
    '  ved task list [--status <s>] [--priority <p>] [--project <p>] [--due <d>] [--tag <t>] [--limit N]',
    '  ved task add <title> [--priority <p>] [--due YYYY-MM-DD] [--assignee <a>] [--project <p>] [--tag <t>...]',
    '  ved task show <id|title>',
    '  ved task edit <id|title> [--status <s>] [--priority <p>] [--due <d>] [--assignee <a>] [--project <p>]',
    '  ved task done <id|title> [--note <note>]',
    '  ved task archive [--before YYYY-MM-DD] [--status done|cancelled]',
    '  ved task board [--project <p>]',
    '  ved task stats [--project <p>]',
    '  ved task projects',
    '  ved task search <query>',
    '',
    `${C.bold}Statuses:${C.reset} todo, in-progress, blocked, done, cancelled`,
    `${C.bold}Priorities:${C.reset} critical, high, medium, low`,
    `${C.bold}Due filters:${C.reset} overdue, today, week, or YYYY-MM-DD`,
    '',
    `${C.bold}Aliases:${C.reset} tasks, todo, todos`,
  ].join('\n');
}

export async function runTaskCommand(app: VedApp, args: string[]): Promise<string> {
  if (checkHelp(args)) return helpText();

  const sub = args[0] || 'list';
  const rest = args.slice(1);

  switch (sub) {
    case 'list':
    case 'ls':
      return cmdList(app, rest);
    case 'add':
    case 'new':
    case 'create':
      return cmdAdd(app, rest);
    case 'show':
    case 'view':
    case 'get':
      return cmdShow(app, rest);
    case 'edit':
    case 'update':
    case 'set':
      return cmdEdit(app, rest);
    case 'done':
    case 'complete':
    case 'close':
      return cmdDone(app, rest);
    case 'archive':
      return cmdArchive(app, rest);
    case 'board':
    case 'kanban':
      return cmdBoard(app, rest);
    case 'stats':
    case 'summary':
      return cmdStats(app, rest);
    case 'projects':
      return cmdProjects(app);
    case 'search':
    case 'find':
      return cmdSearch(app, rest);
    default:
      return `${C.red}Unknown subcommand '${sub}'.${C.reset} Run 'ved task --help' for usage.`;
  }
}
