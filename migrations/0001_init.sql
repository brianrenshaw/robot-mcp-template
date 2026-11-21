-- 0001_init.sql
-- Never edit a migration after it has been applied. To change the database, add
-- 0002_something.sql, 0003_something.sql and so on.

-- Sign-in records for chat apps (the OAuth library's storage; see src/kv.ts).
-- Tokens are stored only as hashes. expires_at is Unix seconds; NULL means no expiry.
CREATE TABLE oauth_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  metadata TEXT,
  expires_at INTEGER
);
CREATE INDEX idx_oauth_kv_expires ON oauth_kv(expires_at);

-- The example data: notes. Replace this table with whatever your project keeps.
-- Nothing is ever really deleted: a removed note gets deleted_at, so it can be brought back.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_notes_updated ON notes(updated_at);
