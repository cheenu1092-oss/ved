/**
 * `ved diff` — Vault diff viewer and change tracker.
 *
 * Shows changes to the Obsidian vault (git-tracked knowledge graph).
 * Because Ved's memory is an Obsidian vault with git versioning,
 * `ved diff` lets you see exactly how knowledge evolves over time.
 *
 * Subcommands:
 *   ved diff                          — Show uncommitted changes (working tree)
 *   ved diff <file>                   — Show diff for a specific vault file
 *   ved diff log [--limit N]          — Show git log of vault changes
 *   ved diff show <hash>              — Show a specific commit's changes
 *   ved diff stat                     — Show file change statistics
 *   ved diff blame <file>             — Show line-by-line blame for vault file
 *   ved diff between <hash1> <hash2>  — Show diff between two commits
 *   ved diff files [--since <date>]   — List changed files
 *
 * Aliases: ved changes, ved delta
 *
 * @module cli-diff
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './core/config.js';
import { errHint, errUsage } from './errors.js';

// ── Helpers ─────────────────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else if (args[i].startsWith('-') && args[i].length === 2) {
      const key = args[i].slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

function getVaultPath(): string {
  try {
    const config = loadConfig();
    return config.memory.vaultPath;
  } catch {
    // Fallback
    const { homedir } = require('node:os');
    return join(homedir(), 'ved-vault');
  }
}

function git(vaultPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: vaultPath,
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function isGitRepo(vaultPath: string): boolean {
  return existsSync(join(vaultPath, '.git'));
}

function ensureRepo(vaultPath: string): void {
  if (!existsSync(vaultPath)) {
    errHint(`Vault not found: ${vaultPath}`, 'Check the name and try again');
    console.log('Run `ved init` to create the vault.');
    process.exit(1);
  }
  if (!isGitRepo(vaultPath)) {
    errHint(`Vault is not a git repository: ${vaultPath}`);
    console.log('Run `ved start` to initialize git tracking.');
    process.exit(1);
  }
}

// ── ANSI colors ─────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function colorDiff(raw: string): string {
  return raw
    .split('\n')
    .map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return `${C.bold}${line}${C.reset}`;
      }
      if (line.startsWith('+')) return `${C.green}${line}${C.reset}`;
      if (line.startsWith('-')) return `${C.red}${line}${C.reset}`;
      if (line.startsWith('@@')) return `${C.cyan}${line}${C.reset}`;
      if (line.startsWith('diff ')) return `${C.bold}${C.blue}${line}${C.reset}`;
      return line;
    })
    .join('\n');
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toISOString().slice(0, 10);
}

// ── Subcommands ─────────────────────────────────────────────────────

/**
 * Show uncommitted changes in vault working tree.
 * If a file is specified, show diff for that file only.
 */
function workingDiff(vaultPath: string, file?: string): void {
  const args = ['diff', '--', file ? file : '.'];
  let diff: string;
  try {
    diff = git(vaultPath, args);
  } catch (e: unknown) {
    errHint(`Failed to get diff: ${(e as Error).message}`);
    return;
  }

  // Also check for untracked files
  let untracked = '';
  if (!file) {
    try {
      untracked = git(vaultPath, ['ls-files', '--others', '--exclude-standard']).trim();
    } catch { /* ignore */ }
  }

  // Also show staged changes
  let staged = '';
  try {
    staged = git(vaultPath, file
      ? ['diff', '--cached', '--', file]
      : ['diff', '--cached']
    );
  } catch { /* ignore */ }

  if (!diff && !staged && !untracked) {
    console.log(`${C.dim}No changes in vault working tree.${C.reset}`);
    return;
  }

  if (staged) {
    console.log(`${C.bold}${C.green}── Staged Changes ──${C.reset}\n`);
    console.log(colorDiff(staged));
  }

  if (diff) {
    console.log(`${C.bold}${C.yellow}── Unstaged Changes ──${C.reset}\n`);
    console.log(colorDiff(diff));
  }

  if (untracked) {
    console.log(`${C.bold}${C.magenta}── Untracked Files ──${C.reset}`);
    for (const f of untracked.split('\n')) {
      if (f) console.log(`  ${C.green}+ ${f}${C.reset}`);
    }
  }
}

/**
 * Show commit log for the vault.
 */
function logCmd(vaultPath: string, args: string[]): void {
  const { flags } = parseArgs(args);
  const limit = flags.limit || flags.n || '20';
  const file = flags.file;

  const gitArgs = [
    'log',
    `--max-count=${limit}`,
    '--format=%H|%s|%an|%aI|%h',
  ];
  if (file) gitArgs.push('--', file);

  let raw: string;
  try {
    raw = git(vaultPath, gitArgs);
  } catch (e: unknown) {
    errHint(`Failed to get log: ${(e as Error).message}`);
    return;
  }

  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    console.log(`${C.dim}No commits found.${C.reset}`);
    return;
  }

  console.log(`${C.bold}Vault History${C.reset} (${lines.length} commits)\n`);

  for (const line of lines) {
    const parts = line.split('|');
    const shortHash = parts[4] || parts[0]?.slice(0, 7) || '???????';
    const message = parts[1] || '';
    const author = parts[2] || '';
    const date = parts[3] ? new Date(parts[3]) : new Date();
    const timeStr = formatRelativeTime(date);

    console.log(
      `  ${C.yellow}${shortHash}${C.reset} ${message}  ${C.dim}(${author}, ${timeStr})${C.reset}`
    );
  }
}

/**
 * Show a specific commit's changes.
 */
function showCommit(vaultPath: string, hash: string): void {
  if (!hash) {
    errUsage('ved diff show <commit-hash>');
    process.exit(1);
  }

  try {
    const info = git(vaultPath, ['log', '-1', '--format=%H%n%s%n%an%n%aI', hash]);
    const [fullHash, message, author, dateStr] = info.trim().split('\n');
    const date = new Date(dateStr);

    console.log(`${C.bold}Commit:${C.reset}  ${C.yellow}${fullHash}${C.reset}`);
    console.log(`${C.bold}Author:${C.reset}  ${author}`);
    console.log(`${C.bold}Date:${C.reset}    ${date.toISOString().replace('T', ' ').replace(/\.\d+Z/, '')} (${formatRelativeTime(date)})`);
    console.log(`${C.bold}Message:${C.reset} ${message}\n`);

    const diff = git(vaultPath, ['show', '--format=', hash]);
    if (diff.trim()) {
      console.log(colorDiff(diff));
    } else {
      console.log(`${C.dim}(empty commit)${C.reset}`);
    }
  } catch (e: unknown) {
    errHint(`Failed to show commit ${hash}: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * Show file change statistics (shortstat).
 */
function stat(vaultPath: string, args: string[]): void {
  const { flags } = parseArgs(args);
  const limit = flags.limit || flags.n || '20';
  const since = flags.since;

  const gitArgs = [
    'log',
    `--max-count=${limit}`,
    '--format=%h|%s|%aI',
    '--stat',
    '--stat-width=60',
  ];
  if (since) gitArgs.push(`--since=${since}`);

  try {
    const raw = git(vaultPath, gitArgs);
    console.log(`${C.bold}Vault Change Statistics${C.reset}\n`);

    // Parse and colorize stat output
    const colorized = raw.split('\n').map(line => {
      // Hash|message|date line
      if (line.includes('|')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          return `${C.yellow}${parts[0]}${C.reset} ${parts[1]}  ${C.dim}(${formatRelativeTime(new Date(parts[2]))})${C.reset}`;
        }
      }
      // File stat line with +/-
      if (line.includes('|') && (line.includes('+') || line.includes('-'))) {
        return line
          .replace(/(\++)/g, `${C.green}$1${C.reset}`)
          .replace(/(-+)/g, `${C.red}$1${C.reset}`);
      }
      // Summary line
      if (line.includes('changed')) {
        return `${C.dim}${line}${C.reset}`;
      }
      return line;
    }).join('\n');

    console.log(colorized);
  } catch (e: unknown) {
    errHint(`Failed to get stats: ${(e as Error).message}`);
  }
}

/**
 * Show line-by-line blame for a vault file.
 */
function blame(vaultPath: string, file: string): void {
  if (!file) {
    errUsage('ved diff blame <file>');
    process.exit(1);
  }

  try {
    const raw = git(vaultPath, ['blame', '--date=short', file]);
    console.log(`${C.bold}Blame: ${file}${C.reset}\n`);

    const colored = raw.split('\n').map(line => {
      // Format: hash (author date lineno) content
      const match = line.match(/^(\w+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d+)\)\s?(.*)/);
      if (match) {
        const [, hash, author, date, lineNo, content] = match;
        return `${C.yellow}${hash.slice(0, 7)}${C.reset} ${C.dim}${author.padEnd(10)} ${date}${C.reset} ${C.dim}${lineNo.padStart(4)}${C.reset} │ ${content}`;
      }
      return line;
    }).join('\n');

    console.log(colored);
  } catch (e: unknown) {
    errHint(`Failed to blame ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * Show diff between two commits.
 */
function between(vaultPath: string, hash1: string, hash2: string): void {
  if (!hash1 || !hash2) {
    errUsage('ved diff between <commit1> <commit2>');
    process.exit(1);
  }

  try {
    const diff = git(vaultPath, ['diff', hash1, hash2]);
    if (!diff.trim()) {
      console.log(`${C.dim}No differences between ${hash1.slice(0, 7)} and ${hash2.slice(0, 7)}.${C.reset}`);
      return;
    }

    console.log(`${C.bold}Diff: ${C.yellow}${hash1.slice(0, 7)}${C.reset}${C.bold}..${C.yellow}${hash2.slice(0, 7)}${C.reset}\n`);
    console.log(colorDiff(diff));
  } catch (e: unknown) {
    errHint(`Failed to diff ${hash1}..${hash2}: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * List changed files (optionally since a date).
 */
function files(vaultPath: string, args: string[]): void {
  const { flags } = parseArgs(args);
  const since = flags.since;
  const limit = flags.limit || flags.n || '50';

  if (since) {
    // Files changed in commits since date
    try {
      const raw = git(vaultPath, [
        'log',
        `--max-count=${limit}`,
        `--since=${since}`,
        '--format=',
        '--name-status',
      ]);
      const seen = new Map<string, string>(); // file → last status
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        const [status, file] = line.split('\t');
        if (file) seen.set(file, status);
      }

      if (seen.size === 0) {
        console.log(`${C.dim}No files changed since ${since}.${C.reset}`);
        return;
      }

      console.log(`${C.bold}Files changed since ${since}${C.reset} (${seen.size} files)\n`);

      const statusColors: Record<string, string> = {
        'A': C.green,
        'M': C.yellow,
        'D': C.red,
        'R': C.cyan,
      };

      for (const [file, status] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const color = statusColors[status] || C.dim;
        const label = status === 'A' ? 'added' : status === 'M' ? 'modified' : status === 'D' ? 'deleted' : status === 'R' ? 'renamed' : status;
        console.log(`  ${color}${label.padEnd(9)}${C.reset} ${file}`);
      }
    } catch (e: unknown) {
      errHint(`Failed to list files: ${(e as Error).message}`);
    }
  } else {
    // Currently modified files
    try {
      const raw = git(vaultPath, ['status', '--porcelain']);
      if (!raw.trim()) {
        console.log(`${C.dim}No modified files in vault.${C.reset}`);
        return;
      }

      console.log(`${C.bold}Modified Files${C.reset}\n`);

      for (const line of raw.trim().split('\n')) {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);
        const statusMap: Record<string, { label: string; color: string }> = {
          'M': { label: 'modified', color: C.yellow },
          'A': { label: 'added', color: C.green },
          'D': { label: 'deleted', color: C.red },
          '??': { label: 'untracked', color: C.magenta },
          'MM': { label: 'modified', color: C.yellow },
          'AM': { label: 'added+mod', color: C.green },
        };
        const info = statusMap[status] || { label: status, color: C.dim };
        console.log(`  ${info.color}${info.label.padEnd(9)}${C.reset} ${file}`);
      }
    } catch (e: unknown) {
      errHint(`Failed to list files: ${(e as Error).message}`);
    }
  }
}

/**
 * Show a summary of recent vault evolution.
 */
function summary(vaultPath: string, args: string[]): void {
  const { flags } = parseArgs(args);
  const days = parseInt(flags.days || '7', 10);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  try {
    // Commit count
    const logRaw = git(vaultPath, [
      'log',
      `--since=${sinceStr}`,
      '--format=%H',
    ]);
    const commitCount = logRaw.trim().split('\n').filter(Boolean).length;

    // Files changed
    const filesRaw = git(vaultPath, [
      'log',
      `--since=${sinceStr}`,
      '--format=',
      '--name-only',
    ]);
    const uniqueFiles = new Set(filesRaw.trim().split('\n').filter(Boolean));

    // Net lines changed
    const statRaw = git(vaultPath, [
      'log',
      `--since=${sinceStr}`,
      '--format=',
      '--numstat',
    ]);
    let added = 0, removed = 0;
    for (const line of statRaw.trim().split('\n').filter(Boolean)) {
      const [a, r] = line.split('\t');
      if (a !== '-') added += parseInt(a, 10) || 0;
      if (r !== '-') removed += parseInt(r, 10) || 0;
    }

    // Folder breakdown
    const folderCounts = new Map<string, number>();
    for (const f of uniqueFiles) {
      const parts = f.split('/');
      const folder = parts.length > 1 ? parts[0] : '(root)';
      folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
    }

    console.log(`${C.bold}Vault Evolution — Last ${days} Days${C.reset}\n`);
    console.log(`  ${C.cyan}Commits:${C.reset}  ${commitCount}`);
    console.log(`  ${C.cyan}Files:${C.reset}    ${uniqueFiles.size} unique files changed`);
    console.log(`  ${C.green}Added:${C.reset}    +${added} lines`);
    console.log(`  ${C.red}Removed:${C.reset}  -${removed} lines`);
    console.log(`  ${C.cyan}Net:${C.reset}      ${added - removed >= 0 ? '+' : ''}${added - removed} lines`);

    if (folderCounts.size > 0) {
      console.log(`\n  ${C.bold}By Folder:${C.reset}`);
      const sorted = [...folderCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [folder, count] of sorted) {
        const bar = '█'.repeat(Math.min(count, 30));
        console.log(`    ${folder.padEnd(20)} ${C.blue}${bar}${C.reset} ${count}`);
      }
    }

    // Most active files
    const fileCountMap = new Map<string, number>();
    for (const line of filesRaw.trim().split('\n').filter(Boolean)) {
      fileCountMap.set(line, (fileCountMap.get(line) || 0) + 1);
    }
    const topFiles = [...fileCountMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    if (topFiles.length > 0) {
      console.log(`\n  ${C.bold}Most Active Files:${C.reset}`);
      for (const [file, count] of topFiles) {
        console.log(`    ${C.yellow}${count}x${C.reset} ${file}`);
      }
    }
  } catch (e: unknown) {
    errHint(`Failed to generate summary: ${(e as Error).message}`);
  }
}

// ── Main Entry ──────────────────────────────────────────────────────

export function diffCmd(args: string[]): void {
  const vaultPath = getVaultPath();
  ensureRepo(vaultPath);

  const sub = args[0];

  // No args → show working tree diff
  if (!sub) {
    workingDiff(vaultPath);
    return;
  }

  switch (sub) {
    case 'log':
    case 'history':
      return logCmd(vaultPath, args.slice(1));

    case 'show':
    case 'commit':
      return showCommit(vaultPath, args[1]);

    case 'stat':
    case 'stats':
    case 'shortstat':
      return stat(vaultPath, args.slice(1));

    case 'blame':
    case 'annotate':
      return blame(vaultPath, args[1]);

    case 'between':
    case 'compare':
      return between(vaultPath, args[1], args[2]);

    case 'files':
    case 'changed':
      return files(vaultPath, args.slice(1));

    case 'summary':
    case 'evolution':
    case 'overview':
      return summary(vaultPath, args.slice(1));

    default:
      // Assume it's a file path
      workingDiff(vaultPath, sub);
  }
}
