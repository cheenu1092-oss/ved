/**
 * `ved tag` — Vault tagging CLI.
 *
 * Manage tags on Obsidian vault files. Tags live in YAML frontmatter as arrays.
 *
 * Subcommands:
 *   list                          List all tags with file counts
 *   show <tag>                    Show all files with a specific tag
 *   add <file> <tag> [<tag>...]   Add tag(s) to a vault file
 *   remove <file> <tag> [<tag>...]  Remove tag(s) from a vault file
 *   rename <old> <new>            Rename a tag across the entire vault
 *   set <file> <tag> [<tag>...]   Replace all tags on a file
 *   clear <file>                  Remove all tags from a file
 *   orphans                       Find files with no tags
 *   stats                         Tag statistics and distribution
 *   find <tag> [<tag>...]         Find files matching ALL given tags (intersection)
 *
 * Aliases: tags, label, labels
 *
 * @module cli-tag
 */

import type { VedApp } from './app.js';
import { checkHelp } from './cli-help.js';
import { errHint, errUsage } from './errors.js';

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeTag(tag: string): string {
  // Strip leading # if present, lowercase, trim
  return tag.replace(/^#/, '').toLowerCase().trim();
}

function validateTagName(tag: string): string | null {
  if (!tag || tag.length === 0) return 'Tag cannot be empty';
  if (tag.length > 64) return 'Tag cannot exceed 64 characters';
  if (/\s/.test(tag)) return 'Tag cannot contain whitespace';
  if (/[[\]{}|\\<>]/.test(tag)) return 'Tag contains invalid characters';
  return null;
}

function resolveFilePath(app: VedApp, input: string): string | null {
  const vault = app.memory.vault;

  // Try exact path first
  try {
    vault.readFile(input);
    return input;
  } catch { /* not found */ }

  // Try with .md extension
  if (!input.endsWith('.md')) {
    try {
      vault.readFile(input + '.md');
      return input + '.md';
    } catch { /* not found */ }
  }

  // Try in common folders
  const folders = ['entities', 'concepts', 'decisions', 'daily'];
  for (const folder of folders) {
    const path = `${folder}/${input}`;
    try {
      vault.readFile(path);
      return path;
    } catch { /* not found */ }

    if (!input.endsWith('.md')) {
      try {
        vault.readFile(path + '.md');
        return path + '.md';
      } catch { /* not found */ }
    }
  }

  return null;
}

function getFileTags(app: VedApp, relPath: string): string[] {
  const file = app.memory.vault.readFile(relPath);
  const tags = file.frontmatter?.['tags'];
  if (Array.isArray(tags)) {
    return tags.map((t: unknown) => String(t).toLowerCase());
  }
  return [];
}

// ── Subcommands ────────────────────────────────────────────────────────

async function tagList(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  const index = app.memory.vault.getIndex();

  if (index.tags.size === 0) {
    console.log('\n  No tags found in vault.\n');
    return;
  }

  // Sort options
  const sortByCount = args.includes('--count') || args.includes('-c');

  const entries = [...index.tags.entries()];
  if (sortByCount) {
    entries.sort((a, b) => b[1].size - a[1].size);
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  console.log(`\n  🏷️  Tags (${entries.length}):\n`);
  for (const [tag, files] of entries) {
    const count = files.size;
    console.log(`    #${tag.padEnd(30)} ${count} file${count === 1 ? '' : 's'}`);
  }
  console.log();
}

async function tagShow(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  const tagName = normalizeTag(args[0] || '');
  if (!tagName) {
    errUsage('ved tag show <tag>');
    return;
  }

  const files = app.memory.vault.findByTag(tagName);

  if (files.length === 0) {
    console.log(`\n  No files tagged #${tagName}.\n`);
    return;
  }

  console.log(`\n  🏷️  #${tagName} (${files.length} file${files.length === 1 ? '' : 's'}):\n`);
  const sorted = [...files].sort();
  for (const f of sorted) {
    console.log(`    ${f}`);
  }
  console.log();
}

async function tagAdd(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  if (args.length < 2) {
    errUsage('ved tag add <file> <tag> [<tag>...]');
    return;
  }

  const fileInput = args[0];
  const relPath = resolveFilePath(app, fileInput);
  if (!relPath) {
    errHint(`File not found: ${fileInput}`);
    return;
  }

  const newTags = args.slice(1).map(normalizeTag);
  for (const tag of newTags) {
    const err = validateTagName(tag);
    if (err) {
      errHint(`Invalid tag "${tag}": ${err}`);
      return;
    }
  }

  const existingTags = getFileTags(app, relPath);
  const toAdd = newTags.filter(t => !existingTags.includes(t));

  if (toAdd.length === 0) {
    console.log(`  ℹ All tags already present on ${relPath}`);
    return;
  }

  const merged = [...existingTags, ...toAdd];
  app.memory.vault.updateFile(relPath, {
    frontmatter: { tags: merged },
  });

  console.log(`  ✓ Added ${toAdd.map(t => '#' + t).join(', ')} to ${relPath}`);
}

async function tagRemove(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  if (args.length < 2) {
    errUsage('ved tag remove <file> <tag> [<tag>...]');
    return;
  }

  const fileInput = args[0];
  const relPath = resolveFilePath(app, fileInput);
  if (!relPath) {
    errHint(`File not found: ${fileInput}`);
    return;
  }

  const tagsToRemove = args.slice(1).map(normalizeTag);
  const existingTags = getFileTags(app, relPath);
  const remaining = existingTags.filter(t => !tagsToRemove.includes(t));
  const removed = tagsToRemove.filter(t => existingTags.includes(t));

  if (removed.length === 0) {
    console.log(`  ℹ None of the specified tags found on ${relPath}`);
    return;
  }

  app.memory.vault.updateFile(relPath, {
    frontmatter: { tags: remaining.length > 0 ? remaining : [] },
  });

  console.log(`  ✓ Removed ${removed.map(t => '#' + t).join(', ')} from ${relPath}`);
}

async function tagRename(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  if (args.length < 2) {
    errUsage('ved tag rename <old-tag> <new-tag>');
    return;
  }

  const oldTag = normalizeTag(args[0]);
  const newTag = normalizeTag(args[1]);

  const oldErr = validateTagName(oldTag);
  if (oldErr) {
    errHint(`Invalid old tag "${oldTag}": ${oldErr}`);
    return;
  }
  const newErr = validateTagName(newTag);
  if (newErr) {
    errHint(`Invalid new tag "${newTag}": ${newErr}`);
    return;
  }

  if (oldTag === newTag) {
    console.log('  ℹ Old and new tag are the same');
    return;
  }

  const files = app.memory.vault.findByTag(oldTag);
  if (files.length === 0) {
    console.log(`  ℹ No files tagged #${oldTag}`);
    return;
  }

  const dryRun = args.includes('--dry-run');

  let updated = 0;
  for (const relPath of files) {
    const existing = getFileTags(app, relPath);
    const newTags = existing.map(t => t === oldTag ? newTag : t);
    // Deduplicate (in case newTag already exists on file)
    const deduped = [...new Set(newTags)];

    if (!dryRun) {
      app.memory.vault.updateFile(relPath, {
        frontmatter: { tags: deduped },
      });
    }
    updated++;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would rename #${oldTag} → #${newTag} in ${updated} file${updated === 1 ? '' : 's'}`);
  } else {
    console.log(`  ✓ Renamed #${oldTag} → #${newTag} in ${updated} file${updated === 1 ? '' : 's'}`);
  }
}

async function tagSet(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  if (args.length < 2) {
    errUsage('ved tag set <file> <tag> [<tag>...]');
    return;
  }

  const fileInput = args[0];
  const relPath = resolveFilePath(app, fileInput);
  if (!relPath) {
    errHint(`File not found: ${fileInput}`);
    return;
  }

  const tags = args.slice(1).map(normalizeTag);
  for (const tag of tags) {
    const err = validateTagName(tag);
    if (err) {
      errHint(`Invalid tag "${tag}": ${err}`);
      return;
    }
  }

  // Deduplicate
  const deduped = [...new Set(tags)];

  app.memory.vault.updateFile(relPath, {
    frontmatter: { tags: deduped },
  });

  console.log(`  ✓ Set tags on ${relPath}: ${deduped.map(t => '#' + t).join(', ')}`);
}

async function tagClear(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  if (args.length < 1) {
    errUsage('ved tag clear <file>');
    return;
  }

  const fileInput = args[0];
  const relPath = resolveFilePath(app, fileInput);
  if (!relPath) {
    errHint(`File not found: ${fileInput}`);
    return;
  }

  const existing = getFileTags(app, relPath);
  if (existing.length === 0) {
    console.log(`  ℹ ${relPath} has no tags`);
    return;
  }

  app.memory.vault.updateFile(relPath, {
    frontmatter: { tags: [] },
  });

  console.log(`  ✓ Cleared ${existing.length} tag${existing.length === 1 ? '' : 's'} from ${relPath}`);
}

async function tagOrphans(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  const allFiles = app.memory.vault.listFiles();
  const orphans: string[] = [];

  for (const relPath of allFiles) {
    // Skip daily notes (they typically don't need tags)
    const skipDaily = args.includes('--include-daily') ? false : relPath.startsWith('daily/');
    if (skipDaily) continue;

    const tags = getFileTags(app, relPath);
    if (tags.length === 0) {
      orphans.push(relPath);
    }
  }

  if (orphans.length === 0) {
    console.log('\n  ✓ All vault files have tags.\n');
    return;
  }

  console.log(`\n  📎 Untagged files (${orphans.length}):\n`);
  const sorted = orphans.sort();
  for (const f of sorted) {
    console.log(`    ${f}`);
  }
  console.log();
}

async function tagStats(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  const index = app.memory.vault.getIndex();
  const allFiles = app.memory.vault.listFiles();
  const taggedFiles = new Set<string>();

  for (const [, files] of index.tags) {
    for (const f of files) {
      taggedFiles.add(f);
    }
  }

  const totalTags = index.tags.size;
  const totalFiles = allFiles.length;
  const taggedCount = taggedFiles.size;
  const untaggedCount = totalFiles - taggedCount;

  // Tag distribution
  const counts = [...index.tags.entries()].map(([tag, files]) => ({
    tag,
    count: files.size,
  }));
  counts.sort((a, b) => b.count - a.count);

  const totalAssignments = counts.reduce((sum, c) => sum + c.count, 0);
  const avgPerFile = taggedCount > 0 ? (totalAssignments / taggedCount).toFixed(1) : '0';
  const avgPerTag = totalTags > 0 ? (totalAssignments / totalTags).toFixed(1) : '0';

  // Singleton tags (used on only 1 file)
  const singletons = counts.filter(c => c.count === 1);

  console.log('\n  📊 Tag Statistics:\n');
  console.log(`    Total tags:        ${totalTags}`);
  console.log(`    Total files:       ${totalFiles}`);
  console.log(`    Tagged files:      ${taggedCount} (${totalFiles > 0 ? ((taggedCount / totalFiles) * 100).toFixed(0) : 0}%)`);
  console.log(`    Untagged files:    ${untaggedCount}`);
  console.log(`    Tag assignments:   ${totalAssignments}`);
  console.log(`    Avg tags/file:     ${avgPerFile}`);
  console.log(`    Avg files/tag:     ${avgPerTag}`);
  console.log(`    Singleton tags:    ${singletons.length}`);

  if (counts.length > 0) {
    console.log('\n  🔝 Top tags:\n');
    const top = counts.slice(0, 10);
    for (const { tag, count } of top) {
      const bar = '█'.repeat(Math.min(count, 40));
      console.log(`    #${tag.padEnd(25)} ${String(count).padStart(4)}  ${bar}`);
    }
  }

  if (singletons.length > 0 && singletons.length <= 10) {
    console.log('\n  ⚠️  Singleton tags (consider merging):\n');
    for (const { tag } of singletons) {
      console.log(`    #${tag}`);
    }
  }

  console.log();
}

async function tagFind(app: VedApp, args: string[]): Promise<void> {
  if (checkHelp('tag', args)) return;

  const tagArgs = args.filter(a => !a.startsWith('--'));
  if (tagArgs.length === 0) {
    errUsage('ved tag find <tag> [<tag>...]');
    return;
  }

  const tags = tagArgs.map(normalizeTag);
  for (const tag of tags) {
    const err = validateTagName(tag);
    if (err) {
      errHint(`Invalid tag "${tag}": ${err}`);
      return;
    }
  }

  // Start with files matching first tag, then intersect
  let result: string[] = [];
  let first = true;
  for (const tag of tags) {
    const files = app.memory.vault.findByTag(tag);
    if (first) {
      result = [...files];
      first = false;
    } else {
      const fileSet = new Set(files);
      result = result.filter(f => fileSet.has(f));
    }
  }

  const matches = [...result].sort();
  const anyMode = args.includes('--any');
  let finalMatches = matches;

  if (anyMode) {
    // Union instead of intersection
    const union = new Set<string>();
    for (const tag of tags) {
      for (const f of app.memory.vault.findByTag(tag)) {
        union.add(f);
      }
    }
    finalMatches = [...union].sort();
  }

  if (finalMatches.length === 0) {
    const mode = anyMode ? 'any of' : 'all of';
    console.log(`\n  No files matching ${mode} ${tags.map(t => '#' + t).join(', ')}.\n`);
    return;
  }

  const label = anyMode ? 'any' : 'all';
  console.log(`\n  🔍 Files matching ${label} of ${tags.map(t => '#' + t).join(', ')} (${finalMatches.length}):\n`);
  for (const f of finalMatches) {
    const fileTags = getFileTags(app, f);
    const tagStr = fileTags.map(t => '#' + t).join(' ');
    console.log(`    ${f}  [${tagStr}]`);
  }
  console.log();
}

// ── Main Entry ─────────────────────────────────────────────────────────

export async function tagCommand(app: VedApp, args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  const rest = args.slice(1);

  switch (sub) {
    case 'list':
    case 'ls':
      return tagList(app, rest);
    case 'show':
    case 'get':
    case 'info':
      return tagShow(app, rest);
    case 'add':
      return tagAdd(app, rest);
    case 'remove':
    case 'rm':
    case 'delete':
    case 'del':
      return tagRemove(app, rest);
    case 'rename':
    case 'mv':
    case 'move':
      return tagRename(app, rest);
    case 'set':
    case 'replace':
      return tagSet(app, rest);
    case 'clear':
      return tagClear(app, rest);
    case 'orphans':
    case 'untagged':
      return tagOrphans(app, rest);
    case 'stats':
    case 'statistics':
      return tagStats(app, rest);
    case 'find':
    case 'search':
    case 'filter':
      return tagFind(app, rest);
    case '--help':
    case '-h':
      checkHelp('tag', ['--help']);
      return;
    default:
      // If it looks like a tag name, treat as `show`
      if (sub && !sub.startsWith('-')) {
        return tagShow(app, [sub, ...rest]);
      }
      errHint(`Unknown subcommand: ${sub}`);
      errUsage('ved tag <subcommand> — run "ved tag --help" for usage');
  }
}
