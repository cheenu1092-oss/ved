/**
 * `ved snapshot` — Vault point-in-time snapshots.
 *
 * Lightweight named snapshots using git tags with YAML metadata.
 * Different from `ved backup` (full tar.gz archives) — snapshots are
 * zero-cost git references marking knowledge evolution milestones.
 *
 * Subcommands:
 *   ved snapshot                          — List all snapshots (default)
 *   ved snapshot create <name> [-m <msg>] — Create a named snapshot
 *   ved snapshot show <name>              — Show snapshot details
 *   ved snapshot diff <name> [<name2>]    — Diff snapshot vs HEAD or another snapshot
 *   ved snapshot restore <name>           — Restore vault to a snapshot (creates backup first)
 *   ved snapshot delete <name>            — Delete a snapshot
 *   ved snapshot export <name> [path]     — Export snapshot state as tar.gz
 *
 * Aliases: ved snap, ved checkpoint
 *
 * @module cli-snapshot
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './core/config.js';

// ── Constants ───────────────────────────────────────────────────────

const TAG_PREFIX = 'ved-snap/';

// ── Helpers ─────────────────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (args[i].startsWith('-') && args[i].length === 2) {
      const key = args[i].slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

function git(vaultPath: string, gitArgs: string[], throwOnError = true): string {
  try {
    return execFileSync('git', gitArgs, {
      cwd: vaultPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (err: any) {
    if (throwOnError) throw err;
    return '';
  }
}

function getVaultPath(): string {
  const config = loadConfig();
  return config.memory?.vaultPath ?? join(process.env.HOME ?? '~', '.ved', 'vault');
}

function ensureGitRepo(vaultPath: string): void {
  if (!existsSync(join(vaultPath, '.git'))) {
    console.error(`Error: Vault at ${vaultPath} is not a git repository.`);
    console.error('Run: cd <vault> && git init');
    process.exit(1);
  }
}

function validateSnapshotName(name: string): void {
  if (!name) {
    console.error('Error: Snapshot name is required.');
    process.exit(1);
  }
  // Prevent path traversal and special chars
  if (/[\/\\.\s:~^?*\[\]@{}]/.test(name) || name.includes('..')) {
    console.error(`Error: Invalid snapshot name "${name}".`);
    console.error('Names must be alphanumeric with hyphens/underscores only.');
    process.exit(1);
  }
  if (name.length > 128) {
    console.error('Error: Snapshot name must be 128 characters or less.');
    process.exit(1);
  }
}

function tagName(name: string): string {
  return `${TAG_PREFIX}${name}`;
}

function snapshotNameFromTag(tag: string): string {
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

interface SnapshotInfo {
  name: string;
  tag: string;
  hash: string;
  date: Date;
  message: string;
  tagger: string;
}

function listSnapshots(vaultPath: string): SnapshotInfo[] {
  const raw = git(vaultPath, [
    'tag', '-l', `${TAG_PREFIX}*`,
    '--sort=-creatordate',
    '--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso)\t%(subject)\t%(taggername)',
  ], false);

  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map(line => {
    const [tag, hash, dateStr, message, tagger] = line.split('\t');
    return {
      name: snapshotNameFromTag(tag),
      tag,
      hash: hash ?? '',
      date: new Date(dateStr ?? ''),
      message: message ?? '',
      tagger: tagger ?? '',
    };
  });
}

function countVaultFiles(vaultPath: string): number {
  try {
    const output = git(vaultPath, ['ls-files', '--', '*.md'], false);
    return output ? output.split('\n').filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

// ── Subcommands ─────────────────────────────────────────────────────

function listCmd(vaultPath: string): void {
  const snapshots = listSnapshots(vaultPath);

  if (snapshots.length === 0) {
    console.log('No snapshots found.');
    console.log('');
    console.log('Create one with: ved snapshot create <name> -m "description"');
    return;
  }

  console.log(`Snapshots (${snapshots.length}):`);
  console.log('');

  const nameWidth = Math.max(10, ...snapshots.map(s => s.name.length));

  for (const snap of snapshots) {
    const name = snap.name.padEnd(nameWidth);
    const time = relativeTime(snap.date).padEnd(8);
    const hash = snap.hash.slice(0, 7);
    const msg = snap.message || '(no description)';
    console.log(`  ${name}  ${hash}  ${time}  ${msg}`);
  }
}

function createCmd(vaultPath: string, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  validateSnapshotName(name);

  const tag = tagName(name);

  // Check if tag already exists
  const existing = git(vaultPath, ['tag', '-l', tag], false);
  if (existing) {
    console.error(`Error: Snapshot "${name}" already exists.`);
    console.error(`Delete it first: ved snapshot delete ${name}`);
    process.exit(1);
  }

  // Commit any uncommitted changes first
  const status = git(vaultPath, ['status', '--porcelain'], false);
  if (status) {
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', `Pre-snapshot commit for ${name}`]);
    console.log('Committed uncommitted changes before snapshot.');
  }

  const message = (flags['m'] ?? flags['message'] ?? `Snapshot: ${name}`) as string;

  // Create annotated tag with metadata
  const fileCount = countVaultFiles(vaultPath);
  const fullMessage = `${message}\n\nved-snapshot-meta:\n  files: ${fileCount}\n  created: ${new Date().toISOString()}`;

  git(vaultPath, ['tag', '-a', tag, '-m', fullMessage]);

  const hash = git(vaultPath, ['rev-parse', '--short', tag]);
  console.log(`✓ Snapshot "${name}" created at ${hash}`);
  console.log(`  ${fileCount} vault files captured`);
  if (message !== `Snapshot: ${name}`) {
    console.log(`  Message: ${message}`);
  }
}

function showCmd(vaultPath: string, args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: ved snapshot show <name>');
    process.exit(1);
  }

  const tag = tagName(name);
  const existing = git(vaultPath, ['tag', '-l', tag], false);
  if (!existing) {
    console.error(`Error: Snapshot "${name}" not found.`);
    process.exit(1);
  }

  // Get tag info
  const tagInfo = git(vaultPath, ['tag', '-v', tag], false);
  const hash = git(vaultPath, ['rev-parse', tag]);
  const shortHash = hash.slice(0, 7);

  // Get commit date
  const dateStr = git(vaultPath, [
    'log', '-1', '--format=%ci', tag,
  ]);

  // Count files at that point
  const filesAtSnapshot = git(vaultPath, [
    'ls-tree', '-r', '--name-only', tag, '--', '*.md',
  ], false);
  const fileCount = filesAtSnapshot ? filesAtSnapshot.split('\n').filter(Boolean).length : 0;

  // Get size of tree
  const treeSize = git(vaultPath, [
    'diff', '--stat', `${tag}..HEAD`,
  ], false);

  console.log(`Snapshot: ${name}`);
  console.log(`Tag:      ${tag}`);
  console.log(`Commit:   ${shortHash} (${hash})`);
  console.log(`Date:     ${dateStr}`);
  console.log(`Files:    ${fileCount} markdown files`);
  console.log('');

  // Show tag message
  const messageLines = tagInfo.split('\n');
  const msgStart = messageLines.findIndex(l => l === '') + 1;
  if (msgStart > 0 && msgStart < messageLines.length) {
    console.log('Message:');
    for (let i = msgStart; i < messageLines.length; i++) {
      console.log(`  ${messageLines[i]}`);
    }
    console.log('');
  }

  // Show drift from HEAD
  if (treeSize) {
    console.log('Changes since snapshot:');
    for (const line of treeSize.split('\n')) {
      console.log(`  ${line}`);
    }
  } else {
    console.log('No changes since this snapshot (HEAD is at snapshot).');
  }
}

function diffCmd(vaultPath: string, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const name1 = positional[0];
  const name2 = positional[1]; // optional, defaults to HEAD

  if (!name1) {
    console.error('Usage: ved snapshot diff <name> [<name2>]');
    console.error('  Compare snapshot to HEAD, or two snapshots.');
    process.exit(1);
  }

  const tag1 = tagName(name1);
  const existing1 = git(vaultPath, ['tag', '-l', tag1], false);
  if (!existing1) {
    console.error(`Error: Snapshot "${name1}" not found.`);
    process.exit(1);
  }

  let ref2 = 'HEAD';
  let label2 = 'HEAD';
  if (name2) {
    const tag2 = tagName(name2);
    const existing2 = git(vaultPath, ['tag', '-l', tag2], false);
    if (!existing2) {
      console.error(`Error: Snapshot "${name2}" not found.`);
      process.exit(1);
    }
    ref2 = tag2;
    label2 = name2;
  }

  const stat = flags['stat'] === true;

  if (stat) {
    const output = git(vaultPath, ['diff', '--stat', tag1, ref2], false);
    console.log(`Changes: ${name1} → ${label2}`);
    console.log('');
    if (output) {
      console.log(output);
    } else {
      console.log('No differences.');
    }
    return;
  }

  const output = git(vaultPath, ['diff', tag1, ref2], false);
  if (!output) {
    console.log(`No differences between "${name1}" and ${label2}.`);
    return;
  }

  console.log(`Diff: ${name1} → ${label2}`);
  console.log('');

  // Color-code output
  for (const line of output.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      console.log(`\x1b[32m${line}\x1b[0m`);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      console.log(`\x1b[31m${line}\x1b[0m`);
    } else if (line.startsWith('@@')) {
      console.log(`\x1b[36m${line}\x1b[0m`);
    } else if (line.startsWith('diff ')) {
      console.log(`\x1b[1m${line}\x1b[0m`);
    } else {
      console.log(line);
    }
  }
}

function restoreCmd(vaultPath: string, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];

  if (!name) {
    console.error('Usage: ved snapshot restore <name>');
    console.error('  Restores vault to the snapshot state (creates safety snapshot first).');
    process.exit(1);
  }

  const tag = tagName(name);
  const existing = git(vaultPath, ['tag', '-l', tag], false);
  if (!existing) {
    console.error(`Error: Snapshot "${name}" not found.`);
    process.exit(1);
  }

  const force = flags['force'] === true;

  // Check for uncommitted changes
  const status = git(vaultPath, ['status', '--porcelain'], false);
  if (status && !force) {
    console.error('Error: Uncommitted changes in vault. Commit or stash them first.');
    console.error('  Or use --force to discard changes.');
    process.exit(1);
  }

  // Create a safety snapshot before restoring
  const safetyName = `pre-restore-${Date.now()}`;
  const safetyTag = tagName(safetyName);

  if (status) {
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', `Pre-restore commit (restoring to ${name})`]);
  }
  git(vaultPath, ['tag', '-a', safetyTag, '-m', `Safety snapshot before restoring to ${name}`]);
  console.log(`Safety snapshot "${safetyName}" created.`);

  // Restore: remove all tracked files, then checkout from snapshot
  // This ensures files added after the snapshot are removed
  const trackedFiles = git(vaultPath, ['ls-files'], false);
  if (trackedFiles) {
    git(vaultPath, ['rm', '-rf', '--cached', '.']);
    // Remove working tree files (but not .git)
    for (const file of trackedFiles.split('\n').filter(Boolean)) {
      try {
        const fullPath = join(vaultPath, file);
        if (existsSync(fullPath)) {
          execFileSync('rm', ['-f', fullPath], { stdio: 'pipe' });
        }
      } catch { /* ignore individual file removal failures */ }
    }
  }
  // Checkout all files from the snapshot
  git(vaultPath, ['checkout', tag, '--', '.']);
  git(vaultPath, ['add', '-A']);
  // Only commit if there are changes
  const postStatus = git(vaultPath, ['status', '--porcelain'], false);
  if (postStatus) {
    git(vaultPath, ['commit', '-m', `Restored vault to snapshot "${name}"`]);
  }

  const fileCount = countVaultFiles(vaultPath);
  console.log(`✓ Vault restored to snapshot "${name}"`);
  console.log(`  ${fileCount} files in restored state`);
  console.log(`  To undo: ved snapshot restore ${safetyName}`);
}

function deleteCmd(vaultPath: string, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];

  if (!name) {
    console.error('Usage: ved snapshot delete <name>');
    process.exit(1);
  }

  const tag = tagName(name);
  const existing = git(vaultPath, ['tag', '-l', tag], false);
  if (!existing) {
    console.error(`Error: Snapshot "${name}" not found.`);
    process.exit(1);
  }

  // Prevent deleting safety snapshots without --force
  if (name.startsWith('pre-restore-') && flags['force'] !== true) {
    console.error('Error: This is a safety snapshot. Use --force to delete it.');
    process.exit(1);
  }

  git(vaultPath, ['tag', '-d', tag]);
  console.log(`✓ Snapshot "${name}" deleted.`);
}

function exportCmd(vaultPath: string, args: string[]): void {
  const { positional } = parseArgs(args);
  const name = positional[0];
  const outputPath = positional[1];

  if (!name) {
    console.error('Usage: ved snapshot export <name> [output-path]');
    process.exit(1);
  }

  const tag = tagName(name);
  const existing = git(vaultPath, ['tag', '-l', tag], false);
  if (!existing) {
    console.error(`Error: Snapshot "${name}" not found.`);
    process.exit(1);
  }

  const filename = outputPath ?? `ved-snapshot-${name}.tar.gz`;

  // Use git archive to create the tarball at that tag's state
  execFileSync('git', ['archive', '--format=tar.gz', '--prefix=ved-snapshot/', '-o', filename, tag], {
    cwd: vaultPath,
    stdio: 'pipe',
    timeout: 60_000,
  });

  const size = statSync(join(vaultPath, filename)).size;
  const sizeKB = (size / 1024).toFixed(1);

  console.log(`✓ Exported snapshot "${name}" to ${filename} (${sizeKB} KB)`);
}

// ── Main Entry ──────────────────────────────────────────────────────

export function snapshotCmd(args: string[]): void {
  const vaultPath = getVaultPath();
  ensureGitRepo(vaultPath);

  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      return listCmd(vaultPath);

    case 'create':
    case 'new':
    case 'take':
      return createCmd(vaultPath, args.slice(1));

    case 'show':
    case 'info':
      return showCmd(vaultPath, args.slice(1));

    case 'diff':
    case 'compare':
      return diffCmd(vaultPath, args.slice(1));

    case 'restore':
    case 'checkout':
      return restoreCmd(vaultPath, args.slice(1));

    case 'delete':
    case 'rm':
    case 'remove':
      return deleteCmd(vaultPath, args.slice(1));

    case 'export':
    case 'archive':
      return exportCmd(vaultPath, args.slice(1));

    default:
      // If it doesn't match a subcommand, treat as list (show all)
      // Unless it looks like a name — check if snapshot exists
      const tag = tagName(sub);
      const exists = git(vaultPath, ['tag', '-l', tag], false);
      if (exists) {
        return showCmd(vaultPath, [sub]);
      }
      console.error(`Unknown subcommand: ${sub}`);
      console.error('');
      console.error('Subcommands: list, create, show, diff, restore, delete, export');
      process.exit(1);
  }
}
