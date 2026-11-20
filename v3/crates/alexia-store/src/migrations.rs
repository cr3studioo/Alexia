// SPDX-License-Identifier: AGPL-3.0-only
//! Forward-only schema migrations. Index + 1 is the `user_version`. Never edit or remove one
//! that has merged (INTERFACES.md §5.3).

/// 0x414C5833, 'ALX3': refuses to be mistaken for a v2 file.
pub(crate) const APPLICATION_ID: i32 = 1095522355;

pub(crate) const MIGRATIONS: &[&str] = &[
    // 1 — INTERFACES.md §5.1, without the trailing `PRAGMA user_version` (the runner sets it).
    r#"
PRAGMA application_id = 1095522355;   -- 0x414C5833, 'ALX3': refuses to be mistaken for a v2 file

-- core's settings and small values. ns "_core" is core's; a plugin's kv uses its plugin id.
CREATE TABLE kv (
  ns    TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,            -- JSON
  PRIMARY KEY (ns, key)
);
-- every non-secret setting value; plugin = plugin id or "_core". Secrets are in Credential Manager.
CREATE TABLE settings (
  plugin TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,           -- JSON
  PRIMARY KEY (plugin, key)
);

CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  image_ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  model      TEXT,
  body       TEXT NOT NULL,       -- JSON MessageBody (§2.1)
  at         INTEGER NOT NULL
);
CREATE INDEX messages_by_session ON messages (session_id, id);

-- the router's ledgers
CREATE TABLE provider_usage (
  provider TEXT NOT NULL,
  span     TEXT NOT NULL,         -- 'minute' | 'day'
  bucket   INTEGER NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (provider, span, bucket)
);
CREATE TABLE usage (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  session_id INTEGER,             -- no FK: the ledger outlives a deleted conversation
  plugin     TEXT,
  model      TEXT NOT NULL,
  provider   TEXT NOT NULL,
  tokens_in  INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost       REAL NOT NULL,
  run_id     TEXT,
  asked      TEXT,
  writing    INTEGER              -- ms, first sign of life → last byte
);
CREATE INDEX usage_at ON usage (at);
CREATE INDEX usage_by_run ON usage (run_id);
CREATE TABLE tries (
  at       INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model    TEXT NOT NULL,
  outcome  TEXT NOT NULL,         -- v2's Outcome strings
  status   INTEGER NOT NULL,
  source   TEXT NOT NULL,         -- 'chat' | 'plugin' | 'test' | 'person'
  waited   INTEGER                -- ms to first sign of life
);
CREATE INDEX tries_at ON tries (at);
CREATE TABLE seen (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  list_known INTEGER NOT NULL,
  gone_at    INTEGER,
  PRIMARY KEY (provider, model)
);

-- run history (the trace), newest 200 / 30 days
CREATE TABLE runs (
  id   TEXT PRIMARY KEY,
  at   INTEGER NOT NULL,
  body TEXT NOT NULL              -- JSON, credentials stripped before writing
);
CREATE INDEX runs_at ON runs (at);

-- pictures that stay with their conversation; files under uploads\<session>\
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  label        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mime         TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  file         TEXT NOT NULL,     -- relative to uploads\
  origin       TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX attachments_session ON attachments (session_id);
CREATE TABLE attachment_leases (
  id             TEXT PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  attachment_ids TEXT NOT NULL,   -- JSON array
  state          TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- v3's own: one row per v2 import, so it happens once
CREATE TABLE imports (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  v2_schema   INTEGER NOT NULL,   -- the v2 file's user_version
  report      TEXT NOT NULL       -- JSON ImportReport
);
"#,
    // 2 — channel chats (CH-01) and latency spans (SP-09).
    r#"
CREATE TABLE channel_chats (
  channel    TEXT NOT NULL,
  chat       TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, chat)
);
-- SP-09. One row per timed stage. `turn` groups the stages of one message.
CREATE TABLE spans (
  turn   TEXT NOT NULL,
  at     INTEGER NOT NULL,      -- when the turn was received (ms)
  origin TEXT NOT NULL,         -- JSON Origin
  lane   TEXT NOT NULL,         -- 'command' | 'chat' | 'task'
  name   TEXT NOT NULL,
  start  INTEGER NOT NULL,      -- ms
  ms     INTEGER NOT NULL
);
CREATE INDEX spans_at ON spans (at);
CREATE INDEX spans_turn ON spans (turn);
"#,
    // 3 — audit log (TR-08), live runs, approvals inbox, scheduled jobs (AC-08..12, SP-13).
    r#"
-- one row per tool call. args and result arrive redacted; the store never redacts.
CREATE TABLE audit (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  run_id     TEXT NOT NULL,
  session_id INTEGER,             -- no FK: the log outlives a deleted conversation
  origin     TEXT NOT NULL,       -- JSON Origin
  step       INTEGER NOT NULL,
  tool       TEXT NOT NULL,
  plugin     TEXT,
  args       TEXT NOT NULL,       -- JSON, redacted before it gets here
  gate       TEXT NOT NULL,       -- 'run' | 'ask' | 'blocked' | 'checker'
  decision   TEXT NOT NULL,       -- 'ran' | 'approved' | 'denied' | 'blocked' | 'unanswered'
  why        TEXT,
  ok         INTEGER,
  result     TEXT,                -- redacted, at most 2000 chars
  undo       TEXT,                -- JSON UndoCall or NULL
  undone_at  INTEGER
);
CREATE INDEX audit_run ON audit (run_id);
CREATE INDEX audit_at ON audit (at);
CREATE TABLE live_runs (
  run_id     TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  origin     TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL,
  steps      INTEGER NOT NULL,
  background INTEGER NOT NULL,
  parent     TEXT
);
CREATE TABLE approvals (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL,
  origin      TEXT NOT NULL,
  text        TEXT NOT NULL,
  detail      TEXT,
  asked_at    INTEGER NOT NULL,
  answered_at INTEGER,
  answer      INTEGER,
  via         TEXT
);
CREATE INDEX approvals_open ON approvals (answered_at);
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  trigger      TEXT NOT NULL,     -- JSON Trigger
  prompt       TEXT NOT NULL,
  urgency      TEXT NOT NULL,
  origin       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  next_at      INTEGER,
  cancelled_at INTEGER
);
CREATE TABLE job_runs (
  id      INTEGER PRIMARY KEY,
  job_id  INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  run_id  TEXT,
  outcome TEXT NOT NULL
);
"#,
];
