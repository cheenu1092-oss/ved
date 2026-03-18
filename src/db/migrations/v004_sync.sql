-- ============================================================
-- Ved Database Schema v004 — Vault Sync
-- File: src/db/migrations/v004_sync.sql
-- ============================================================

-- ============================================================
-- SYNC_REMOTES — Configured sync remote endpoints
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_remotes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK(type IN ('git', 's3', 'rsync', 'local')),
  url         TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  auth_data   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- SYNC_HISTORY — Sync operation log
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_history (
  id            TEXT PRIMARY KEY,
  remote_id     TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
  status        TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
  files_changed INTEGER,
  error         TEXT,
  timestamp     INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (remote_id) REFERENCES sync_remotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_history_remote ON sync_history(remote_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_timestamp ON sync_history(timestamp DESC);
