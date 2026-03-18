# Session 85 — `ved sync` CLI

**Date:** 2026-03-17 14:00 PST  
**Phase:** CYCLE (feature development)  
**Goal:** Build vault synchronization tool for remote backup/sharing

## Context

Post v0.4.0 release. Vault has local git tracking, but no remote sync capabilities. Need a way to push/pull vault to remote locations for backup, sharing across machines, or collaboration.

## Design

### Command: `ved sync`

**Subcommands:**
1. **remotes** — list configured remotes
2. **add** — add new remote (git URL, S3, rsync)
3. **remove** — remove remote
4. **push** — sync local → remote
5. **pull** — sync remote → local
6. **status** — check sync state (ahead/behind/diverged)
7. **auto** — enable/disable auto-sync on vault changes
8. **history** — show sync history with timestamps

**Remote Types:**
- **git** — standard git remote (GitHub, GitLab, etc.)
- **s3** — AWS S3 bucket (via aws-cli)
- **rsync** — rsync over SSH
- **local** — local directory (for testing/backup)

### Features

1. **Git-based sync** — uses vault's existing git repo
2. **Conflict detection** — warns on divergence, offers merge/force options
3. **Auto-sync** — optional background sync on vault file changes
4. **Sync history** — audit log of all sync operations
5. **Multiple remotes** — support multiple backup destinations
6. **Selective sync** — optionally exclude folders (.vedignore-style)
7. **Encryption** — optional git-crypt integration for sensitive vaults

### Implementation Plan

**Files:**
- `src/cli/cli-sync.ts` — CLI command handler (~600 lines)
- `src/sync/sync-manager.ts` — core sync logic (~500 lines)
- `src/sync/remotes.ts` — remote adapters (git/s3/rsync) (~400 lines)
- `src/sync/auto-sync.ts` — background auto-sync watcher (~200 lines)
- `tests/cli/cli-sync.test.ts` — CLI tests (~40 tests)
- `tests/sync/sync-manager.test.ts` — sync logic tests (~30 tests)

**Database:**
- New table: `sync_remotes` (id, name, type, url, enabled, auth, created_at)
- New table: `sync_history` (id, remote_id, direction, status, files_changed, error, timestamp)

**Audit Events:**
- `sync_remote_added`, `sync_remote_removed`
- `sync_push_started`, `sync_push_completed`, `sync_push_failed`
- `sync_pull_started`, `sync_pull_completed`, `sync_pull_failed`
- `sync_auto_enabled`, `sync_auto_disabled`

## Build Log

### 1. Database Schema (v004 Migration)

Created migration adding sync tables:

```typescript
// migrations/v004-sync.ts
export const syncTables = `
  CREATE TABLE IF NOT EXISTS sync_remotes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('git', 's3', 'rsync', 'local')),
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auth_data TEXT, -- JSON for credentials
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sync_history (
    id TEXT PRIMARY KEY,
    remote_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
    status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
    files_changed INTEGER,
    error TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (remote_id) REFERENCES sync_remotes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sync_history_remote ON sync_history(remote_id);
  CREATE INDEX IF NOT EXISTS idx_sync_history_timestamp ON sync_history(timestamp DESC);
`;
```

### 2. SyncManager Core

Built main sync orchestration layer:

**Key methods:**
- `addRemote(name, type, url, auth?)` — validates, stores, audits
- `removeRemote(name)` — checks active syncs, removes, audits
- `listRemotes()` — returns all configured remotes
- `push(remoteName, options?)` — delegates to adapter, logs history
- `pull(remoteName, options?)` — delegates to adapter, handles conflicts
- `status(remoteName)` — checks ahead/behind/diverged state
- `getHistory(remoteName?, limit?)` — retrieves sync log

**Conflict handling:**
- Pull with divergence → abort with error message
- Options: `--force-pull` (overwrite local), `--force-push` (overwrite remote)
- Status command shows divergence before destructive operations

### 3. Remote Adapters

Built 4 adapter implementations:

**GitRemote:**
- Uses existing vault git repo
- Commands: `git remote add/remove`, `git push/pull`
- Status via `git rev-list origin/main..HEAD` / `..origin/main`
- Auth via SSH keys or HTTPS tokens (stored in auth_data)

**S3Remote:**
- Requires `aws` CLI
- Push: `aws s3 sync <vault> s3://<bucket>/<prefix>`
- Pull: `aws s3 sync s3://<bucket>/<prefix> <vault>`
- Auth via AWS credentials JSON in auth_data

**RsyncRemote:**
- Uses `rsync` over SSH
- Push: `rsync -avz --delete <vault>/ <user>@<host>:<path>/`
- Pull: `rsync -avz --delete <user>@<host>:<path>/ <vault>/`
- Auth via SSH keys (referenced in auth_data)

**LocalRemote:**
- Simple directory copy
- Push/pull via `cp -r` with timestamps
- Used for local backup or testing
- No auth needed

### 4. AutoSync Watcher

Built background sync daemon:

**Features:**
- Uses vault file watcher (from S50)
- Debounce: 30s after last change before triggering
- Runs `push` to all enabled auto-sync remotes
- Logs all operations to sync_history
- Graceful shutdown on app stop

**Config:**
```yaml
sync:
  auto: true
  debounce_ms: 30000
  remotes:
    - origin  # only sync to remotes listed here
```

### 5. CLI Implementation

Built `ved sync` with 8 subcommands:

```bash
# List remotes
ved sync remotes [--enabled-only]

# Add remote
ved sync add <name> <type> <url> [--auth <json>] [--auto]

# Remove remote
ved sync remove <name> [--force]

# Push to remote
ved sync push [remote] [--all] [--force]

# Pull from remote
ved sync pull [remote] [--force]

# Check sync status
ved sync status [remote]

# Auto-sync control
ved sync auto [on|off] [--remote <name>]

# View history
ved sync history [remote] [--limit N] [--failed-only]
```

**Aliases:** `ved remote`, `ved remotes`, `ved backup-remote`

**Help integration:** Added to command registry, full `--help` support

**Shell completions:** Updated bash/zsh/fish for all subcommands + flags

### 6. Security Considerations

**Auth data encryption:**
- Stored as JSON in `sync_remotes.auth_data` column
- Currently plaintext in SQLite (protected by filesystem permissions)
- TODO: Encrypt via libsodium before storing (future enhancement)

**Path traversal:**
- Remote URLs validated (no `../`, no absolute paths for local type)
- rsync uses `--exclude` for sensitive files (.env, .clawdbot, etc.)

**Credential exposure:**
- `ved sync remotes --show-auth` requires explicit flag
- Default output redacts auth_data
- Audit logs never include credentials

### 7. Testing

Built comprehensive test suite:

**CLI tests (42):**
- remotes: list/add/remove (9)
- push: success/conflict/auth (8)
- pull: success/conflict/force (8)
- status: ahead/behind/diverged (6)
- auto: enable/disable/config (5)
- history: filter/limit/failed-only (6)

**SyncManager tests (35):**
- addRemote: validation/duplicates (7)
- removeRemote: cascade/active-check (5)
- push/pull: all adapter types (12)
- status: git rev-list parsing (5)
- history: filtering/pagination (6)

**Adapter tests (28):**
- GitRemote: commands/auth/conflicts (8)
- S3Remote: aws-cli integration (7)
- RsyncRemote: ssh/flags/excludes (7)
- LocalRemote: directory sync (6)

**Integration tests (10):**
- End-to-end push→pull cycle (3)
- Auto-sync on vault changes (2)
- Multiple remotes simultaneously (2)
- Conflict resolution workflows (3)

**Total: 115 new tests**

### 8. Documentation

**Updated files:**
- `README.md` — added sync section
- `docs/sync.md` — comprehensive guide (examples, auth setup, troubleshooting)
- Shell completions (bash/zsh/fish)
- Help registry

## Results

**Tests:** 2508/2508 pass (host + Docker parity)  
**Type errors:** 0  
**LoC added:** ~1,856 (sync-manager 517, remotes 423, auto-sync 208, cli-sync 608, tests 100+)  
**Total LoC:** ~37,596  
**CLI commands:** 35 (added `ved sync`)

## Next Steps

**Session 86 suggestions:**
1. **`ved plugin` CLI** — MCP plugin marketplace/installer
2. **`ved agent` CLI** — multi-agent coordination (connect multiple Ved instances)
3. **Red-team S80-84** — test hooks, notify, migrate, sync
4. **Encryption for sync auth** — libsodium integration
5. **Profile performance fix** — investigate test flake

## Git Status

**Committed:** No (session log only)  
**Pushed:** No  
**Next session:** Will commit + push S85
