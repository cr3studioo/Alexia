// SPDX-License-Identifier: AGPL-3.0-only
//! The one database file: opening, migrating, sessions, history, kv, settings, the ledger.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::migrations::{APPLICATION_ID, MIGRATIONS};
use crate::{
    now_ms, Error, Message, MessageBody, MessageId, Ms, Result, Role, Session, SessionId, SpanRow,
    Try, TryRow, Usage,
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
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        vec_ext::register();
        Self::init(Connection::open(path)?, true)
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
