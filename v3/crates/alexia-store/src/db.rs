// SPDX-License-Identifier: AGPL-3.0-only
//! The one database file: opening, migrating, sessions, history, kv, settings, the ledger.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::migrations::{APPLICATION_ID, MIGRATIONS};
use crate::{encrypt, secrets};
use crate::{
    now_ms, ApprovalRow, AuditRow, Error, JobRow, LiveRunRow, Message, MessageBody, MessageId,
    MuteRow, Ms, NewNotice, NoticeRow, Result, Role, Session, SessionId, SpanRow, Try, TryRow,
    Usage,
};

/// sqlite-vec is a C extension; registering it is one FFI call, so this module (and only this
/// module) opts out of the workspace's `unsafe_code = "deny"`.
#[allow(unsafe_code)]
mod vec_ext {
    use std::os::raw::{c_char, c_int};
    use std::sync::Once;

    use rusqlite::ffi::{sqlite3, sqlite3_api_routines, sqlite3_auto_extension};

    type Init =
        unsafe extern "C" fn(*mut sqlite3, *mut *mut c_char, *const sqlite3_api_routines) -> c_int;

    /// Every connection opened after this has sqlite-vec loaded (SP-15).
    pub(super) fn register() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            // SAFETY: `sqlite3_vec_init` is the extension's entry point and has exactly the
            // `Init` signature; the crate declares it without arguments only because it is
            // meant to be passed to `sqlite3_auto_extension`, as its README does.
            unsafe {
                let init = std::mem::transmute::<unsafe extern "C" fn(), Init>(
                    sqlite_vec::sqlite3_vec_init,
                );
                sqlite3_auto_extension(Some(init));
            }
        });
    }
}

// ponytail: one connection behind a mutex (INTERFACES.md §2.1). A reader pool if contention shows.
pub struct Store {
    conn: Mutex<Connection>,
}

/// `record_request`'s bucket for `span` ("minute" or "day") at `at`.
fn bucket(span: &str, at: Ms) -> Result<Ms> {
    match span {
        "minute" => Ok(at.div_euclid(60_000)),
        "day" => Ok(at.div_euclid(24 * 60 * 60 * 1000)),
        _ => Err(Error::Invalid(format!(
            "A request span is \"minute\" or \"day\", not \"{span}\"."
        ))),
    }
}

fn insert_session(tx: &rusqlite::Transaction, title: &str) -> Result<SessionId> {
    let at = now_ms();
    tx.execute(
        "INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)",
        params![title, at, at],
    )?;
    Ok(SessionId(tx.last_insert_rowid()))
}

/// Points (channel, chat) at `session`. A chat seen for the first time is the channel's primary
/// when the channel has no chat yet; an existing chat keeps its primary flag.
fn point_chat(
    tx: &rusqlite::Transaction,
    channel: &str,
    chat: &str,
    session: SessionId,
) -> Result<()> {
    tx.execute(
        "INSERT INTO channel_chats (channel, chat, session_id, is_primary) \
         VALUES (?1, ?2, ?3, NOT EXISTS (SELECT 1 FROM channel_chats WHERE channel = ?1)) \
         ON CONFLICT (channel, chat) DO UPDATE SET session_id = excluded.session_id",
        params![channel, chat, session.0],
    )?;
    Ok(())
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn parse_role(s: &str) -> Result<Role> {
    Ok(serde_json::from_value(serde_json::Value::String(
        s.to_owned(),
    ))?)
}

impl Store {
    /// Opens (creating if needed) the database at `path` and brings it to this build's schema.
    /// An encrypted file, or a new one beside an `alexia.db.keyed` marker, is keyed with
    /// `secrets::get("_core", "store_key")`. A new file without the marker is plain and reads no
    /// keychain; an existing plain file opens as it is. Once an encrypted file has opened, an
    /// `alexia.db.plain` an interrupted `encrypt` left beside it is shredded.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        vec_ext::register();
        let encrypted = Self::is_encrypted(path)?;
        let keyed = encrypt::marker(path).is_file();
        let key = if encrypted || (keyed && !path.exists()) {
            secrets::get(encrypt::OWNER, encrypt::KEY)?
        } else {
            None
        };
        if !encrypted
            && keyed
            && path.is_file()
            && matches!(secrets::get(encrypt::OWNER, encrypt::KEY), Ok(Some(_)))
        {
            tracing::warn!(
                "encryption of the database did not finish; `alexia-hub encrypt` will finish it"
            );
        }
        const MISSING: &str = "The database is encrypted and its key is missing or wrong.";
        let conn = Connection::open(path)?;
        match key {
            Some(hex) => {
                let raw = encrypt::raw_key(&hex).ok_or_else(|| Error::Refused(MISSING.into()))?;
                conn.pragma_update(None, "key", raw)?;
            }
            None if encrypted => return Err(Error::Refused(MISSING.into())),
            None => {}
        }
        let store = Self::init(conn, true).map_err(|e| match e {
            Error::Sqlite(ref s)
                if s.sqlite_error_code() == Some(rusqlite::ErrorCode::NotADatabase) =>
            {
                Error::Refused(MISSING.into())
            }
            e => e,
        })?;
        // After the key proved right: while it is missing, the leftover may be the owner's only
        // readable copy.
        if encrypted {
            encrypt::shred_plain_leftover(path);
        }
        Ok(store)
    }

    /// True when `path` exists and does not start with SQLite's plain header: SQLCipher
    /// encrypts the whole file, header included. A missing or empty file, or a name that is not
    /// a file at all (`:memory:`), is not encrypted.
    pub fn is_encrypted(path: &Path) -> Result<bool> {
        use std::io::Read;
        if !path.is_file() {
            return Ok(false);
        }
        let mut head = [0u8; 16];
        let n = std::fs::File::open(path)?.take(16).read(&mut head)?;
        Ok(n > 0 && head[..n] != b"SQLite format 3\0"[..n])
    }

    pub fn open_in_memory() -> Result<Store> {
        vec_ext::register();
        Self::init(Connection::open_in_memory()?, false)
    }

    fn init(mut conn: Connection, wal: bool) -> Result<Store> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(Duration::from_millis(5000))?;

        let app_id: i32 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
        // Foreign before newer: a v2 file has a high user_version too, and "not an Alexia v3
        // database" is the true sentence for it.
        if app_id != APPLICATION_ID && tables > 0 {
            return Err(Error::Refused(
                "This file is not an Alexia v3 database.".into(),
            ));
        }
        if version < 0 {
            return Err(Error::Refused(
                "This database is damaged: its schema version is negative.".into(),
            ));
        }
        if version > MIGRATIONS.len() as i64 {
            return Err(Error::Refused(
                "This database is from a newer Alexia than this one.".into(),
            ));
        }
        // After the checks, so a refused file is left exactly as it was.
        if wal {
            let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(Error::Refused(format!(
                    "The database could not switch to write-ahead logging (it is in {mode} mode)."
                )));
            }
            // WAL's standard setting: no corruption on a crash, no fsync on every commit.
            conn.pragma_update(None, "synchronous", "NORMAL")?;
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", i as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Store {
            conn: Mutex::new(conn),
        })
    }

    /// The locked connection, for other modules' `impl Store` blocks.
    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` in a transaction: committed on `Ok`, rolled back on `Err`.
    pub fn transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    // ---- sessions and history ----

    pub fn create_session(&self, title: Option<&str>) -> Result<SessionId> {
        let conn = self.conn();
        let at = now_ms();
        conn.execute(
            "INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)",
            params![title, at, at],
        )?;
        Ok(SessionId(conn.last_insert_rowid()))
    }

    /// Newest first: `updated_at` desc, then `id` desc.
    pub fn sessions(&self) -> Result<Vec<Session>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Session {
                id: SessionId(r.get(0)?),
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_title(&self, id: SessionId, title: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE sessions SET title = ? WHERE id = ?",
            params![title, id.0],
        )?;
        Ok(())
    }

    /// Removes the session; its messages and attachments go with it (ON DELETE CASCADE).
    pub fn delete_session(&self, id: SessionId) -> Result<()> {
        self.conn()
            .execute("DELETE FROM sessions WHERE id = ?", [id.0])?;
        Ok(())
    }

    /// Adds a message and marks the session as written to now.
    pub fn append(
        &self,
        id: SessionId,
        role: Role,
        model: Option<&str>,
        body: &MessageBody,
    ) -> Result<MessageId> {
        let body = serde_json::to_string(body)?;
        let at = now_ms();
        self.transaction(|tx| {
            tx.execute(
                "INSERT INTO messages (session_id, role, model, body, at) VALUES (?, ?, ?, ?, ?)",
                params![id.0, role_str(role), model, body, at],
            )?;
            let msg = MessageId(tx.last_insert_rowid());
            tx.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                params![at, id.0],
            )?;
            Ok(msg)
        })
    }

    /// The newest `limit` messages (all when `None`), oldest first.
    pub fn history(&self, id: SessionId, limit: Option<u32>) -> Result<Vec<Message>> {
        let raw: Vec<(i64, String, Option<String>, String, Ms)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT id, role, model, body, at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            )?;
            let limit = limit.map_or(-1, i64::from);
            let rows = stmt.query_map(params![id.0, limit], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        raw.into_iter()
            .rev()
            .map(|(mid, role, model, body, at)| {
                Ok(Message {
                    id: MessageId(mid),
                    session: id,
                    role: parse_role(&role)?,
                    model,
                    body: serde_json::from_str(&body)?,
                    at,
                })
            })
            .collect()
    }

    // ---- kv and settings: values are JSON text ----

    pub fn kv_get(&self, ns: &str, key: &str) -> Result<Option<serde_json::Value>> {
        let text: Option<String> = self
            .conn()
            .query_row(
                "SELECT value FROM kv WHERE ns = ? AND key = ?",
                [ns, key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(text.map(|t| serde_json::from_str(&t)).transpose()?)
    }

    pub fn kv_set(&self, ns: &str, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn().execute(
            "INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) \
             ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value",
            params![ns, key, value.to_string()],
        )?;
        Ok(())
    }

    /// Read-modify-write of one kv value inside one transaction, under the store's connection
    /// mutex: `f` gets the current value (None when absent) and returns the new one (None
    /// deletes the key). Returns what was written. No other writer can interleave (P3-00).
    pub fn kv_update(
        &self,
        ns: &str,
        key: &str,
        f: impl FnOnce(Option<serde_json::Value>) -> Option<serde_json::Value>,
    ) -> Result<Option<serde_json::Value>> {
        self.transaction(|tx| {
            let text: Option<String> = tx
                .query_row(
                    "SELECT value FROM kv WHERE ns = ? AND key = ?",
                    [ns, key],
                    |r| r.get(0),
                )
                .optional()?;
            let now = text.map(|t| serde_json::from_str(&t)).transpose()?;
            let next = f(now);
            match &next {
                Some(v) => {
                    tx.execute(
                        "INSERT INTO kv (ns, key, value) VALUES (?, ?, ?)                          ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value",
                        params![ns, key, serde_json::to_string(v)?],
                    )?;
                }
                None => {
                    tx.execute("DELETE FROM kv WHERE ns = ? AND key = ?", [ns, key])?;
                }
            }
            Ok(next)
        })
    }

    pub fn kv_delete(&self, ns: &str, key: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM kv WHERE ns = ? AND key = ?", [ns, key])?;
        Ok(())
    }

    /// Every setting of one plugin (or `"_core"`), key → value.
    pub fn settings(&self, plugin: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
        let raw: Vec<(String, String)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE plugin = ?")?;
            let rows = stmt.query_map([plugin], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        raw.into_iter()
            .map(|(k, v)| Ok((k, serde_json::from_str(&v)?)))
            .collect()
    }

    pub fn set_setting(&self, plugin: &str, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (plugin, key, value) VALUES (?, ?, ?) \
             ON CONFLICT (plugin, key) DO UPDATE SET value = excluded.value",
            params![plugin, key, value.to_string()],
        )?;
        Ok(())
    }

    // ---- the router's ledger ----

    /// One more request to `provider`, counted in its minute and its UTC day, as v2's
    /// `recordRequest` does. Older buckets of the same span are pruned, as v2 does, so the
    /// table stays the size of the number of providers.
    pub fn record_request(&self, provider: &str, at: Ms) -> Result<()> {
        let spans: [(&str, Ms); 2] = [
            ("minute", bucket("minute", at)?),
            ("day", bucket("day", at)?),
        ];
        self.transaction(|tx| {
            for (span, bucket) in spans {
                tx.execute(
                    "INSERT INTO provider_usage (provider, span, bucket, count) VALUES (?, ?, ?, 1) \
                     ON CONFLICT (provider, span, bucket) DO UPDATE SET count = count + 1",
                    params![provider, span, bucket],
                )?;
                tx.execute(
                    "DELETE FROM provider_usage WHERE provider = ? AND span = ? AND bucket < ?",
                    params![provider, span, bucket],
                )?;
            }
            Ok(())
        })
    }

    pub fn record_usage(&self, u: &Usage) -> Result<()> {
        self.conn().execute(
            "INSERT INTO usage (at, session_id, plugin, model, provider, tokens_in, tokens_out, \
             cost, run_id, asked, writing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                u.at,
                u.session.map(|s| s.0),
                u.plugin,
                u.model,
                u.provider,
                u.tokens_in,
                u.tokens_out,
                u.cost,
                u.run_id,
                u.asked,
                u.writing_ms,
            ],
        )?;
        Ok(())
    }

    pub fn record_try(&self, t: &Try) -> Result<()> {
        self.conn().execute(
            "INSERT INTO tries (at, provider, model, outcome, status, source, waited) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                t.at,
                t.provider,
                t.model,
                t.outcome,
                t.status,
                t.source,
                t.waited_ms
            ],
        )?;
        Ok(())
    }

    /// Requests counted by `record_request` in the `"minute"` or `"day"` bucket that holds `at`.
    /// 0 when there is no row.
    pub fn request_count(&self, provider: &str, span: &str, at: Ms) -> Result<u64> {
        let bucket = bucket(span, at)?;
        let n: Option<i64> = self
            .conn()
            .query_row(
                "SELECT count FROM provider_usage WHERE provider = ? AND span = ? AND bucket = ?",
                params![provider, span, bucket],
                |r| r.get(0),
            )
            .optional()?;
        Ok(n.map_or(0, |n| n.max(0) as u64))
    }

    /// Tries at or after `at`, oldest first.
    pub fn tries_since(&self, at: Ms) -> Result<Vec<TryRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT at, provider, model, outcome, status, waited FROM tries \
             WHERE at >= ? ORDER BY at, rowid",
        )?;
        let rows = stmt.query_map([at], |r| {
            Ok(TryRow {
                at: r.get(0)?,
                provider: r.get(1)?,
                model: r.get(2)?,
                outcome: r.get(3)?,
                status: r.get(4)?,
                waited_ms: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- channel chats (CH-01) ----

    /// The session for this chat, created (titled "<channel>") on first sight. The first chat
    /// ever seen on a channel becomes its primary.
    pub fn channel_session(&self, channel: &str, chat: &str) -> Result<SessionId> {
        self.transaction(|tx| {
            let known: Option<i64> = tx
                .query_row(
                    "SELECT session_id FROM channel_chats WHERE channel = ? AND chat = ?",
                    [channel, chat],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = known {
                return Ok(SessionId(id));
            }
            let id = insert_session(tx, channel)?;
            point_chat(tx, channel, chat, id)?;
            Ok(id)
        })
    }

    /// Points the chat at a fresh session (`/new`) and returns it. The old session stays.
    pub fn new_channel_session(&self, channel: &str, chat: &str) -> Result<SessionId> {
        self.transaction(|tx| {
            let id = insert_session(tx, channel)?;
            point_chat(tx, channel, chat, id)?;
            Ok(id)
        })
    }

    pub fn primary_chat(&self, channel: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT chat FROM channel_chats WHERE channel = ? AND is_primary = 1",
                [channel],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Makes `chat` the channel's one primary. `Error::Invalid` if the chat was never seen.
    pub fn set_primary_chat(&self, channel: &str, chat: &str) -> Result<()> {
        self.transaction(|tx| {
            let n = tx.execute(
                "UPDATE channel_chats SET is_primary = 1 WHERE channel = ? AND chat = ?",
                [channel, chat],
            )?;
            if n == 0 {
                return Err(Error::Invalid(
                    "That chat has not been seen on this channel.".into(),
                ));
            }
            tx.execute(
                "UPDATE channel_chats SET is_primary = 0 WHERE channel = ? AND chat <> ?",
                [channel, chat],
            )?;
            Ok(())
        })
    }

    // ---- spans (SP-09) ----

    /// All rows in one transaction.
    pub fn record_spans(&self, rows: &[SpanRow]) -> Result<()> {
        self.transaction(|tx| {
            let mut stmt = tx.prepare(
                "INSERT INTO spans (turn, at, origin, lane, name, start, ms) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )?;
            for s in rows {
                stmt.execute(params![
                    s.turn, s.at, s.origin, s.lane, s.name, s.start, s.ms
                ])?;
            }
            Ok(())
        })
    }

    /// The newest `n` turns' rows, oldest turn first, rows in `start` order.
    pub fn last_turns(&self, n: u32) -> Result<Vec<SpanRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT s.turn, s.at, s.origin, s.lane, s.name, s.start, s.ms FROM spans s \
             JOIN (SELECT turn, max(at) AS t_at FROM spans GROUP BY turn \
                   ORDER BY t_at DESC, turn DESC LIMIT ?) t ON t.turn = s.turn \
             ORDER BY t.t_at, s.turn, s.start, s.rowid",
        )?;
        let rows = stmt.query_map([n], |r| {
            Ok(SpanRow {
                turn: r.get(0)?,
                at: r.get(1)?,
                origin: r.get(2)?,
                lane: r.get(3)?,
                name: r.get(4)?,
                start: r.get(5)?,
                ms: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Deletes spans of turns received before `before` (the dashboard keeps 30 days).
    pub fn prune_spans(&self, before: Ms) -> Result<u64> {
        let n = self
            .conn()
            .execute("DELETE FROM spans WHERE at < ?", [before])?;
        Ok(n as u64)
    }
}

// ---- (P3-04) notices and mutes ----

const URGENCIES: [&str; 4] = ["low", "normal", "high", "urgent"];
const STATES: [&str; 5] = ["new", "held", "said", "done", "dropped"];

fn rank(urgency: &str) -> Result<usize> {
    URGENCIES
        .iter()
        .position(|u| *u == urgency)
        .ok_or_else(|| Error::Invalid(format!("“{urgency}” is not an urgency.")))
}

const NOTICE_COLS: &str = "id, key, source, text, why, urgency, due_at, not_before, state, \
                           created_at, updated_at, said_at, said_via, times_said, seen_at, feedback";

fn notice_row(r: &rusqlite::Row) -> rusqlite::Result<NoticeRow> {
    Ok(NoticeRow {
        id: r.get(0)?,
        key: r.get(1)?,
        source: r.get(2)?,
        text: r.get(3)?,
        why: r.get(4)?,
        urgency: r.get(5)?,
        due_at: r.get(6)?,
        not_before: r.get(7)?,
        state: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        said_at: r.get(11)?,
        said_via: r.get(12)?,
        times_said: r.get(13)?,
        seen_at: r.get(14)?,
        feedback: r.get(15)?,
    })
}

const LIVE: &str = "state IN ('new','held','said')";

impl Store {
    /// A live (new|held|said) row with the same (source, key): text, why and due_at refreshed,
    /// urgency only rises, state kept. Otherwise a new row in state "new". Returns
    /// (id, created). An invalid urgency is `Error::Invalid` before any SQL runs.
    pub fn notice_upsert(&self, n: &NewNotice, at: Ms) -> Result<(i64, bool)> {
        let wanted = rank(n.urgency)?;
        self.transaction(|tx| {
            let live: Option<(i64, String)> = tx
                .query_row(
                    &format!(
                        "SELECT id, urgency FROM notices WHERE source = ? AND key = ? AND {LIVE}"
                    ),
                    [n.source, n.key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match live {
                Some((id, had)) => {
                    let urgency = if rank(&had).unwrap_or(0) >= wanted {
                        had
                    } else {
                        n.urgency.to_string()
                    };
                    tx.execute(
                        "UPDATE notices SET text = ?, why = ?, due_at = ?, urgency = ?, \
                         updated_at = ? WHERE id = ?",
                        params![n.text, n.why, n.due_at, urgency, at, id],
                    )?;
                    Ok((id, false))
                }
                None => {
                    tx.execute(
                        "INSERT INTO notices (key, source, text, why, urgency, due_at, \
                         not_before, state, created_at, updated_at) \
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)",
                        params![
                            n.key,
                            n.source,
                            n.text,
                            n.why,
                            n.urgency,
                            n.due_at,
                            n.not_before,
                            at,
                            at
                        ],
                    )?;
                    Ok((tx.last_insert_rowid(), true))
                }
            }
        })
    }

    /// new | held | said, oldest first.
    pub fn notices_live(&self) -> Result<Vec<NoticeRow>> {
        let conn = self.conn();
        let mut st = conn.prepare(&format!(
            "SELECT {NOTICE_COLS} FROM notices WHERE {LIVE} ORDER BY created_at, id"
        ))?;
        let rows = st.query_map([], notice_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn notice(&self, id: i64) -> Result<Option<NoticeRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {NOTICE_COLS} FROM notices WHERE id = ?"),
                [id],
                notice_row,
            )
            .optional()?)
    }

    /// State said, `times_said` + 1, `said_at` and `said_via` recorded.
    pub fn notice_said(&self, id: i64, via: &str, at: Ms) -> Result<()> {
        self.conn().execute(
            "UPDATE notices SET state = 'said', times_said = times_said + 1, said_at = ?, \
             said_via = ?, updated_at = ? WHERE id = ?",
            params![at, via, at, id],
        )?;
        Ok(())
    }

    /// false when there is no such row. `state` in new|held|said|done|dropped, else
    /// `Error::Invalid` before any SQL runs.
    pub fn notice_set(&self, id: i64, state: &str, not_before: Option<Ms>, at: Ms) -> Result<bool> {
        if !STATES.contains(&state) {
            return Err(Error::Invalid(format!("“{state}” is not a notice state.")));
        }
        let n = self.conn().execute(
            "UPDATE notices SET state = ?, not_before = ?, updated_at = ? WHERE id = ?",
            params![state, not_before, at, id],
        )?;
        Ok(n > 0)
    }

    /// The owner saw it, and maybe said whether it was useful.
    pub fn notice_seen(&self, id: i64, feedback: Option<&str>, at: Ms) -> Result<bool> {
        if let Some(f) = feedback {
            if !["useful", "not_useful"].contains(&f) {
                return Err(Error::Invalid(format!("“{f}” is not notice feedback.")));
            }
        }
        let n = self.conn().execute(
            "UPDATE notices SET seen_at = COALESCE(seen_at, ?), \
             feedback = COALESCE(?, feedback), updated_at = ? WHERE id = ?",
            params![at, feedback, at, id],
        )?;
        Ok(n > 0)
    }

    /// Rows touched at or after `at`, newest first, any state.
    pub fn notices_since(&self, at: Ms, limit: u32) -> Result<Vec<NoticeRow>> {
        let conn = self.conn();
        let mut st = conn.prepare(&format!(
            "SELECT {NOTICE_COLS} FROM notices WHERE updated_at >= ? \
             ORDER BY updated_at DESC, id DESC LIMIT ?"
        ))?;
        let rows = st.query_map(params![at, limit], notice_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn mute_add(
        &self,
        source: &str,
        topic: Option<&str>,
        until: Option<Ms>,
        at: Ms,
    ) -> Result<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO mutes (source, topic, until, created_at) VALUES (?, ?, ?, ?)",
            params![source, topic, until, at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Mutes still in force at `now`: no end, or an end after `now`.
    pub fn mutes(&self, now: Ms) -> Result<Vec<MuteRow>> {
        let conn = self.conn();
        let mut st = conn.prepare(
            "SELECT id, source, topic, until, created_at FROM mutes \
             WHERE until IS NULL OR until > ? ORDER BY id",
        )?;
        let rows = st.query_map([now], |r| {
            Ok(MuteRow {
                id: r.get(0)?,
                source: r.get(1)?,
                topic: r.get(2)?,
                until: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn mute_remove(&self, id: i64) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM mutes WHERE id = ?", [id])? > 0)
    }

    /// What she did on her own since `at`, oldest first (PR-26; the brief reports it): audit
    /// rows from a scheduled task (origin JSON `{"kind":"scheduler",..}`, serde's tag) whose
    /// call went ahead. The agent records that as `run` without a question and `approved`
    /// after one (agent.rs), so both count; INTERFACES' "ran" is accepted too.
    pub fn audit_scheduled_since(&self, at: Ms) -> Result<Vec<AuditRow>> {
        let conn = self.conn();
        let mut st = conn.prepare(&format!(
            "SELECT {AUDIT_COLS} FROM audit WHERE origin LIKE '{{\"kind\":\"scheduler\"%' \
             AND decision IN ('run', 'ran', 'approved') AND at >= ? ORDER BY at, id"
        ))?;
        let rows = st.query_map([at], audit_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

const AUDIT_COLS: &str = "id, at, run_id, session_id, origin, step, tool, plugin, args, gate, \
                          decision, why, ok, result, undo, undone_at";

fn audit_row(r: &rusqlite::Row) -> rusqlite::Result<AuditRow> {
    Ok(AuditRow {
        id: r.get(0)?,
        at: r.get(1)?,
        run: r.get(2)?,
        session: r.get::<_, Option<i64>>(3)?.map(SessionId),
        origin: r.get(4)?,
        step: r.get(5)?,
        tool: r.get(6)?,
        plugin: r.get(7)?,
        args: r.get(8)?,
        gate: r.get(9)?,
        decision: r.get(10)?,
        why: r.get(11)?,
        ok: r.get(12)?,
        result: r.get(13)?,
        undo: r.get(14)?,
        undone_at: r.get(15)?,
    })
}

const LIVE_COLS: &str =
    "run_id, session_id, origin, started_at, touched_at, steps, background, parent";

fn live_row(r: &rusqlite::Row) -> rusqlite::Result<LiveRunRow> {
    Ok(LiveRunRow {
        run: r.get(0)?,
        session: SessionId(r.get(1)?),
        origin: r.get(2)?,
        started_at: r.get(3)?,
        touched_at: r.get(4)?,
        steps: r.get(5)?,
        background: r.get(6)?,
        parent: r.get(7)?,
    })
}

const APPROVAL_COLS: &str = "id, run_id, origin, text, detail, asked_at, answered_at, answer, via";

fn approval_row(r: &rusqlite::Row) -> rusqlite::Result<ApprovalRow> {
    Ok(ApprovalRow {
        id: r.get(0)?,
        run: r.get(1)?,
        origin: r.get(2)?,
        text: r.get(3)?,
        detail: r.get(4)?,
        asked_at: r.get(5)?,
        answered_at: r.get(6)?,
        answer: r.get(7)?,
        via: r.get(8)?,
    })
}

fn job_row(r: &rusqlite::Row) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: r.get(0)?,
        trigger: r.get(1)?,
        prompt: r.get(2)?,
        urgency: r.get(3)?,
        origin: r.get(4)?,
        created_at: r.get(5)?,
        next_at: r.get(6)?,
        cancelled_at: r.get(7)?,
    })
}

/// `%q%` for `LIKE … ESCAPE '\'`, with `q`'s own `%`, `_` and `\` matched literally.
fn like_pattern(q: &str) -> String {
    let mut p = String::with_capacity(q.len() + 2);
    p.push('%');
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
    }
    p.push('%');
    p
}

/// Migration 3's methods. JSON columns are opaque text, and nothing here redacts: callers hand
/// the store text that is already redacted (P2-19).
impl Store {
    // ---- runs (the trace, migration 1's table): newest 200 and 30 days kept ----

    /// Inserts or replaces run `id`. `body` must already have its credentials stripped.
    pub fn save_run(&self, id: &str, at: Ms, body: &serde_json::Value) -> Result<()> {
        self.conn().execute(
            "INSERT INTO runs (id, at, body) VALUES (?, ?, ?) \
             ON CONFLICT (id) DO UPDATE SET at = excluded.at, body = excluded.body",
            params![id, at, body.to_string()],
        )?;
        Ok(())
    }

    pub fn run_body(&self, id: &str) -> Result<Option<serde_json::Value>> {
        let text: Option<String> = self
            .conn()
            .query_row("SELECT body FROM runs WHERE id = ?", [id], |r| r.get(0))
            .optional()?;
        Ok(text.map(|t| serde_json::from_str(&t)).transpose()?)
    }

    /// The newest `limit` runs, newest first.
    pub fn runs(&self, limit: u32) -> Result<Vec<(String, Ms, serde_json::Value)>> {
        let raw: Vec<(String, Ms, String)> = {
            let conn = self.conn();
            let mut stmt =
                conn.prepare("SELECT id, at, body FROM runs ORDER BY at DESC, rowid DESC LIMIT ?")?;
            let rows = stmt.query_map([limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        raw.into_iter()
            .map(|(id, at, body)| Ok((id, at, serde_json::from_str(&body)?)))
            .collect()
    }

    /// Deletes runs older than `before` and every run past the newest `keep`. Returns how many.
    pub fn prune_runs(&self, before: Ms, keep: u32) -> Result<u64> {
        let n = self.conn().execute(
            "DELETE FROM runs WHERE at < ?1 OR rowid NOT IN \
             (SELECT rowid FROM runs ORDER BY at DESC, rowid DESC LIMIT ?2)",
            params![before, keep],
        )?;
        Ok(n as u64)
    }

    // ---- audit (TR-08) ----

    /// Appends `row` (its `id` is ignored) and returns the new id. `args` and `result` must
    /// already be redacted; the store writes them as given.
    pub fn audit(&self, row: &AuditRow) -> Result<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO audit (at, run_id, session_id, origin, step, tool, plugin, args, gate, \
             decision, why, ok, result, undo, undone_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                row.at,
                row.run,
                row.session.map(|s| s.0),
                row.origin,
                row.step,
                row.tool,
                row.plugin,
                row.args,
                row.gate,
                row.decision,
                row.why,
                row.ok,
                row.result,
                row.undo,
                row.undone_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// The run's rows in the order they were written.
    pub fn audit_for_run(&self, run: &str) -> Result<Vec<AuditRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AUDIT_COLS} FROM audit WHERE run_id = ? ORDER BY id"
        ))?;
        let rows = stmt.query_map([run], audit_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// LIKE over tool, args, why, result; newest first. `q` is matched literally. The text
    /// searched is what callers wrote, already redacted.
    pub fn audit_search(&self, q: &str, limit: u32) -> Result<Vec<AuditRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AUDIT_COLS} FROM audit WHERE tool LIKE ?1 ESCAPE '\\' \
             OR args LIKE ?1 ESCAPE '\\' OR why LIKE ?1 ESCAPE '\\' OR result LIKE ?1 ESCAPE '\\' \
             ORDER BY at DESC, id DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![like_pattern(q), limit], audit_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Newest row in `session` with undo set and undone_at NULL.
    pub fn last_undoable(&self, session: SessionId) -> Result<Option<AuditRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {AUDIT_COLS} FROM audit WHERE session_id = ? AND undo IS NOT NULL \
                     AND undone_at IS NULL ORDER BY at DESC, id DESC LIMIT 1"
                ),
                [session.0],
                audit_row,
            )
            .optional()?)
    }

    pub fn mark_undone(&self, id: i64, at: Ms) -> Result<()> {
        self.conn().execute(
            "UPDATE audit SET undone_at = ? WHERE id = ?",
            params![at, id],
        )?;
        Ok(())
    }

    // ---- live runs ----

    pub fn live_begin(&self, row: &LiveRunRow) -> Result<()> {
        self.conn().execute(
            &format!("INSERT INTO live_runs ({LIVE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
            params![
                row.run,
                row.session.0,
                row.origin,
                row.started_at,
                row.touched_at,
                row.steps,
                row.background,
                row.parent,
            ],
        )?;
        Ok(())
    }

    /// True when a row matched: the check and the update are one statement.
    pub fn live_touch(&self, run: &str, steps: u32, at: Ms) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE live_runs SET steps = ?, touched_at = ? WHERE run_id = ?",
            params![steps, at, run],
        )?;
        Ok(changed == 1)
    }

    pub fn live_end(&self, run: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM live_runs WHERE run_id = ?", [run])?;
        Ok(())
    }

    /// Oldest first.
    pub fn live_runs(&self) -> Result<Vec<LiveRunRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LIVE_COLS} FROM live_runs ORDER BY started_at, rowid"
        ))?;
        let rows = stmt.query_map([], live_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- approvals ----

    pub fn approval_open(
        &self,
        run: &str,
        origin: &str,
        text: &str,
        detail: Option<&str>,
        at: Ms,
    ) -> Result<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO approvals (run_id, origin, text, detail, asked_at) VALUES (?, ?, ?, ?, ?)",
            params![run, origin, text, detail, at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// false when it was already answered (the first answer wins), or there is no such id.
    pub fn approval_answer(&self, id: i64, answer: bool, via: &str, at: Ms) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE approvals SET answered_at = ?, answer = ?, via = ? \
             WHERE id = ? AND answered_at IS NULL",
            params![at, answer, via, id],
        )?;
        Ok(n == 1)
    }

    /// Unanswered, oldest first.
    pub fn approvals_pending(&self) -> Result<Vec<ApprovalRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {APPROVAL_COLS} FROM approvals WHERE answered_at IS NULL ORDER BY asked_at, id"
        ))?;
        let rows = stmt.query_map([], approval_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn approval(&self, id: i64) -> Result<Option<ApprovalRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {APPROVAL_COLS} FROM approvals WHERE id = ?"),
                [id],
                approval_row,
            )
            .optional()?)
    }

    // ---- jobs ----

    pub fn job_add(
        &self,
        trigger: &str,
        prompt: &str,
        urgency: &str,
        origin: &str,
        next_at: Option<Ms>,
        at: Ms,
    ) -> Result<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO jobs (trigger, prompt, urgency, origin, created_at, next_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
            params![trigger, prompt, urgency, origin, at, next_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Jobs not cancelled, oldest first.
    pub fn jobs(&self) -> Result<Vec<JobRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, trigger, prompt, urgency, origin, created_at, next_at, cancelled_at \
             FROM jobs WHERE cancelled_at IS NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([], job_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// false when the job was already cancelled or does not exist.
    pub fn job_cancel(&self, id: i64, at: Ms) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE jobs SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL",
            params![at, id],
        )?;
        Ok(n == 1)
    }

    pub fn job_set_next(&self, id: i64, next_at: Option<Ms>) -> Result<()> {
        self.conn().execute(
            "UPDATE jobs SET next_at = ? WHERE id = ?",
            params![next_at, id],
        )?;
        Ok(())
    }

    pub fn job_ran(&self, id: i64, at: Ms, run: Option<&str>, outcome: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO job_runs (job_id, at, run_id, outcome) VALUES (?, ?, ?, ?)",
            params![id, at, run, outcome],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wal_store_uses_synchronous_normal() {
        let dir = std::env::temp_dir().join(format!("alexia-store-sync-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("alexia.db")).unwrap();
        // Per connection, so it must be read through the store's own.
        let sync: i64 = store
            .conn()
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(sync, 1, "PRAGMA synchronous is not NORMAL");
    }
}
