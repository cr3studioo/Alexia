// SPDX-License-Identifier: AGPL-3.0-only
//! The one database file: opening, migrating, sessions, history, kv, settings, the ledger.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::migrations::{APPLICATION_ID, MIGRATIONS};
use crate::{
    Error, Message, MessageBody, MessageId, Ms, Result, Role, Session, SessionId, Try, Usage,
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

/// Unix epoch milliseconds, now.
fn now() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as Ms)
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
        if version > MIGRATIONS.len() as i64 {
            return Err(Error::Refused(
                "This database is from a newer Alexia than this one.".into(),
            ));
        }
        // After the checks, so a refused file is left exactly as it was.
        if wal {
            let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
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
        let at = now();
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
        let at = now();
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
            ("minute", at.div_euclid(60_000)),
            ("day", at.div_euclid(24 * 60 * 60 * 1000)),
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
}
