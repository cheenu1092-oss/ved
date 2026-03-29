/**
 * ved sync — Vault synchronization manager.
 *
 * Subcommands:
 *   ved sync                     — List remotes (default)
 *   ved sync remotes             — List configured remotes
 *   ved sync add <name> <type> <url>  — Add a remote
 *   ved sync remove <name>       — Remove a remote
 *   ved sync push [remote]       — Push vault to remote
 *   ved sync pull [remote]       — Pull from remote
 *   ved sync status [remote]     — Check sync state
 *   ved sync history [remote]    — Show sync history
 *
 * Aliases: ved remote, ved remotes
 *
 * @module cli-sync
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { getConfigDir } from './core/config.js';
import { SyncManager, REMOTE_TYPES, type RemoteType, type SyncRemote } from './sync.js';
import { errHint, errUsage } from './errors.js';
import { spinner } from './spinner.js';

// ── DB helpers ─────────────────────────────────────────────────────────

function openSyncDb(): { db: Database.Database; vaultDir: string } {
  const dbPath = process.env.VED_DB_PATH ?? join(
    process.env.VED_CONFIG_DIR ?? getConfigDir(),
    'ved.db'
  );
  const vaultDir = process.env.VED_VAULT_DIR ?? join(homedir(), 'ved-vault');

  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return { db, vaultDir };
}

// ── CLI Command ────────────────────────────────────────────────────────

export async function syncCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list':
    case 'remotes':
    case 'ls':
      return listRemotes(args.slice(1));
    case 'add':
    case 'create':
      return addRemote(args.slice(1));
    case 'remove':
    case 'rm':
    case 'delete':
      return removeRemote(args.slice(1));
    case 'push':
      return pushSync(args.slice(1));
    case 'pull':
      return pullSync(args.slice(1));
    case 'status':
    case 'state':
      return showStatus(args.slice(1));
    case 'history':
    case 'log':
      return showHistory(args.slice(1));
    default: {
      // Maybe it's a remote name — show status
      const { db, vaultDir } = openSyncDb();
      try {
        const mgr = new SyncManager(db, vaultDir);
        const remote = mgr.getRemote(sub);
        if (remote) {
          return showStatus([sub]);
        }
      } finally {
        db.close();
      }
      errHint(`Unknown sync subcommand: ${sub}`, 'Run "ved help" to see available commands');
      errHint('Run "ved sync --help" for usage.');
      process.exitCode = 1;
    }
  }
}

// ── Subcommands ────────────────────────────────────────────────────────

function listRemotes(args: string[]): void {
  const showAuth = args.includes('--show-auth');
  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);
    const remotes = mgr.listRemotes(showAuth);

    if (remotes.length === 0) {
      console.log('No sync remotes configured.');
      console.log('Add one: ved sync add <name> <type> <url>');
      console.log(`Types: ${REMOTE_TYPES.join(', ')}`);
      return;
    }

    console.log(`\n  Sync Remotes (${remotes.length}):\n`);
    for (const r of remotes) {
      const status = r.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
      console.log(`  ${status} ${r.name} (${r.type})`);
      console.log(`    URL: ${r.url}`);
      if (showAuth && r.authData) {
        console.log(`    Auth: ${r.authData}`);
      }
      console.log(`    Added: ${new Date(r.createdAt * 1000).toISOString()}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

function addRemote(args: string[]): void {
  // Parse flags and positional args
  let name = '';
  let type = '';
  let url = '';
  let authData: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--auth' || args[i] === '--auth-data') {
      authData = args[++i];
    } else if (!args[i].startsWith('-')) {
      positional.push(args[i]);
    }
  }

  name = positional[0] || '';
  type = positional[1] || '';
  url = positional[2] || '';

  if (!name || !type || !url) {
    errUsage('ved sync add <name> <type> <url> [--auth <data>]');
    errHint(`Types: ${REMOTE_TYPES.join(', ')}`);
    errHint('Examples:');
    errHint('  ved sync add origin git https://github.com/user/vault.git');
    errHint('  ved sync add backup local /backups/vault');
    errHint('  ved sync add s3-backup s3 s3://my-bucket/vault');
    process.exitCode = 1;
    return;
  }

  if (!REMOTE_TYPES.includes(type as RemoteType)) {
    errHint(`Invalid type: ${type}. Must be one of: ${REMOTE_TYPES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);
    const remote = mgr.addRemote(name, type as RemoteType, url, authData);
    console.log(`Remote "${remote.name}" added.`);
    console.log(`  Type: ${remote.type}`);
    console.log(`  URL:  ${remote.url}`);
  } catch (err) {
    errHint(`${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

function removeRemote(args: string[]): void {
  const name = args[0];
  if (!name) {
    errUsage('ved sync remove <name>');
    process.exitCode = 1;
    return;
  }

  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);
    const ok = mgr.removeRemote(name);
    if (!ok) {
      errHint(`Remote "${name}" not found.`, 'Check the name and try again');
      process.exitCode = 1;
      return;
    }
    console.log(`Remote "${name}" removed.`);
  } finally {
    db.close();
  }
}

function pushSync(args: string[]): void {
  const force = args.includes('--force') || args.includes('-f');
  const remoteName = args.find(a => !a.startsWith('-'));

  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);

    if (!remoteName) {
      // Push to all enabled remotes
      const remotes = mgr.listRemotes().filter(r => r.enabled);
      if (remotes.length === 0) {
        console.log('No enabled remotes configured.');
        console.log('Add one: ved sync add <name> <type> <url>');
        return;
      }
      for (const r of remotes) {
        runSync(mgr, 'push', r.name, force);
      }
      return;
    }

    runSync(mgr, 'push', remoteName, force);
  } finally {
    db.close();
  }
}

function pullSync(args: string[]): void {
  const force = args.includes('--force') || args.includes('-f');
  const remoteName = args.find(a => !a.startsWith('-'));

  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);

    if (!remoteName) {
      const remotes = mgr.listRemotes().filter(r => r.enabled);
      if (remotes.length === 0) {
        console.log('No enabled remotes configured.');
        return;
      }
      for (const r of remotes) {
        runSync(mgr, 'pull', r.name, force);
      }
      return;
    }

    runSync(mgr, 'pull', remoteName, force);
  } finally {
    db.close();
  }
}

function runSync(mgr: SyncManager, direction: 'push' | 'pull', remoteName: string, force: boolean): void {
  const arrow = direction === 'push' ? '→' : '←';
  const spin = spinner(`${arrow} ${direction} ${remoteName}...`);
  try {
    const hist = direction === 'push'
      ? mgr.push(remoteName, { force })
      : mgr.pull(remoteName, { force });
    const files = hist.filesChanged !== undefined ? ` (${hist.filesChanged} files)` : '';
    spin.succeed(`${direction} ${remoteName} done${files}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    spin.fail(`${direction} ${remoteName} failed`);
    errHint(msg);
    process.exitCode = 1;
  }
}

function showStatus(args: string[]): void {
  const remoteName = args.find(a => !a.startsWith('-'));

  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);

    const remotes = remoteName
      ? [mgr.getRemote(remoteName)].filter((r): r is SyncRemote => r !== null)
      : mgr.listRemotes();

    if (remotes.length === 0) {
      if (remoteName) {
        errHint(`Remote "${remoteName}" not found.`, 'Check the name and try again');
        process.exitCode = 1;
      } else {
        console.log('No sync remotes configured.');
      }
      return;
    }

    console.log();
    for (const r of remotes) {
      const enabledStr = r.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[90mdisabled\x1b[0m';
      console.log(`  ${r.name} (${r.type}) — ${enabledStr}`);

      if (r.enabled) {
        try {
          const state = mgr.status(r.name);
          const stateColor = state === 'synced' ? '\x1b[32m' : state === 'unknown' ? '\x1b[90m' : '\x1b[33m';
          console.log(`    State: ${stateColor}${state}\x1b[0m`);
        } catch {
          console.log(`    State: \x1b[90munknown\x1b[0m`);
        }
      }

      // Show last sync
      const hist = mgr.getHistory({ remoteName: r.name, limit: 1 });
      if (hist.length > 0) {
        const h = hist[0];
        const ts = new Date(h.timestamp * 1000).toISOString();
        const statusColor = h.status === 'completed' ? '\x1b[32m' : h.status === 'failed' ? '\x1b[31m' : '\x1b[90m';
        console.log(`    Last sync: ${h.direction} ${statusColor}${h.status}\x1b[0m @ ${ts}`);
      }
      console.log();
    }
  } finally {
    db.close();
  }
}

function showHistory(args: string[]): void {
  const remoteName = args.find(a => !a.startsWith('-'));
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] || '20', 10) : 20;
  const failedOnly = args.includes('--failed-only');

  const { db, vaultDir } = openSyncDb();
  try {
    const mgr = new SyncManager(db, vaultDir);
    const history = mgr.getHistory({ remoteName, limit, failedOnly });

    if (history.length === 0) {
      const qualifier = failedOnly ? ' failed' : '';
      console.log(remoteName
        ? `No${qualifier} sync history for remote "${remoteName}".`
        : `No${qualifier} sync history.`
      );
      return;
    }

    console.log(`\n  Sync History (${history.length}):\n`);
    for (const h of history) {
      const icon = h.status === 'completed'
        ? '\x1b[32m✓\x1b[0m'
        : h.status === 'failed'
          ? '\x1b[31m✗\x1b[0m'
          : '\x1b[33m◌\x1b[0m';
      const ts = new Date(h.timestamp * 1000).toISOString();
      const remote = h.remoteName || h.remoteId;
      const files = h.filesChanged !== undefined ? ` (${h.filesChanged} files)` : '';
      console.log(`  ${icon} ${remote} ${h.direction} ${h.status}${files}`);
      console.log(`    ${ts}`);
      if (h.error) {
        console.log(`    Error: ${h.error}`);
      }
    }
    console.log();
  } finally {
    db.close();
  }
}
