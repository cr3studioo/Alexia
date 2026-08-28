-- SPDX-License-Identifier: AGPL-3.0-only
-- The whole registry. Two tables and a reason column, which is the entire product:
-- a list with a revoke button.
--
-- No ratings, no download counts, no search ranking, no analytics. Those are what turn a
-- registry into a product with a growth problem, and the brief is a list.

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  version TEXT NOT NULL,
  license TEXT NOT NULL,
  author TEXT,
  -- Where the .tgz is. The registry stores no bytes: it says where and what to check.
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  -- Detached ed25519 over the sha256 hex, base64. Optional, and its absence is shown.
  signature TEXT,
  alexia_protocol INTEGER NOT NULL,
  mcp_protocol TEXT NOT NULL,
  -- The author's own sentences, verbatim, so the walkthrough can be drawn before download.
  requires TEXT NOT NULL DEFAULT '[]',
  provides TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  -- The revoke button. Set, and every client that asks is told, now.
  revoked_at INTEGER,
  revoked_reason TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  license TEXT,
  author TEXT,
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
);
