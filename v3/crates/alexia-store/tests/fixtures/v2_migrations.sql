-- v2 schema migrations 1..=11, copied verbatim from packages/core/src/store.ts
-- (MIGRATIONS) on 2026-11-18, each followed by the user_version it sets.
-- The only v2 schema the importer tests use. Never edit: it is v2 history.

-- 1
CREATE TABLE kv (ns TEXT, key TEXT, value TEXT, PRIMARY KEY (ns, key));
   CREATE TABLE settings (plugin TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin, key));
PRAGMA user_version = 1;

-- 2
CREATE TABLE sessions (
     id INTEGER PRIMARY KEY,
     title TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     model TEXT,
     body TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX messages_by_session ON messages (session_id, id);
PRAGMA user_version = 2;

-- 3
CREATE TABLE provider_usage (
     provider TEXT NOT NULL,
     span TEXT NOT NULL,
     bucket INTEGER NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (provider, span, bucket)
   );
PRAGMA user_version = 3;

-- 4
CREATE TABLE usage (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     session_id INTEGER,
     plugin TEXT,
     model TEXT NOT NULL,
     provider TEXT NOT NULL,
     tokens_in INTEGER NOT NULL,
     tokens_out INTEGER NOT NULL,
     cost REAL NOT NULL
   );
   CREATE INDEX usage_at ON usage (at);
PRAGMA user_version = 4;

-- 5
ALTER TABLE usage ADD COLUMN run_id TEXT;
   ALTER TABLE usage ADD COLUMN asked TEXT;
   CREATE INDEX usage_by_run ON usage (run_id);
PRAGMA user_version = 5;

-- 6
CREATE TABLE strikes (
     at INTEGER NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     status INTEGER NOT NULL
   );
   CREATE INDEX strikes_at ON strikes (at);
PRAGMA user_version = 6;

-- 7
CREATE TABLE tries (
     at INTEGER NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     outcome TEXT NOT NULL,
     status INTEGER NOT NULL,
     source TEXT NOT NULL
   );
   CREATE INDEX tries_at ON tries (at);
   CREATE TABLE seen (
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     first_seen INTEGER NOT NULL,
     list_known INTEGER NOT NULL,
     gone_at INTEGER,
     PRIMARY KEY (provider, model)
   );
   DROP TABLE strikes;
PRAGMA user_version = 7;

-- 8
ALTER TABLE tries ADD COLUMN waited INTEGER;
PRAGMA user_version = 8;

-- 9
ALTER TABLE usage ADD COLUMN writing INTEGER;
PRAGMA user_version = 9;

-- 10
CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     at INTEGER NOT NULL,
     body TEXT NOT NULL
   );
   CREATE INDEX runs_at ON runs (at);
PRAGMA user_version = 10;

-- 11
ALTER TABLE sessions ADD COLUMN image_ordinal INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE attachments (
     id TEXT PRIMARY KEY,
     session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     label TEXT NOT NULL,
     display_name TEXT NOT NULL,
     mime TEXT NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     file TEXT NOT NULL,
     origin TEXT NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX attachments_session ON attachments (session_id);
   CREATE TABLE attachment_leases (
     id TEXT PRIMARY KEY,
     session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
     attachment_ids TEXT NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
PRAGMA user_version = 11;
