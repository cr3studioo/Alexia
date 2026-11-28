// SPDX-License-Identifier: AGPL-3.0-only
//! (P4-03) Migration 5's tables: paired devices, the Mac's fallback turns synced once, guests.

use rusqlite::{params, OptionalExtension};

use crate::{DeviceRow, Error, GuestRow, Ms, Result, Store};

const DEVICE_COLS: &str =
    "id, name, endpoint, role, platform, hello, hints, paired_at, last_seen, revoked_at";
const GUEST_COLS: &str = "id, name, channel, chat, added_at, removed_at";

/// A row with its two JSON columns still text; parsed after, so a bad one is `Error::Json`.
type RawDevice = (DeviceRow, String, String);

fn device_raw(r: &rusqlite::Row) -> rusqlite::Result<RawDevice> {
    Ok((
        DeviceRow {
            id: r.get(0)?,
            name: r.get(1)?,
            endpoint: r.get(2)?,
            role: r.get(3)?,
            platform: r.get(4)?,
            hello: serde_json::Value::Null,
            hints: serde_json::Value::Null,
            paired_at: r.get(7)?,
            last_seen: r.get(8)?,
            revoked_at: r.get(9)?,
        },
        r.get(5)?,
        r.get(6)?,
    ))
}

fn device_parse((mut d, hello, hints): RawDevice) -> Result<DeviceRow> {
    d.hello = serde_json::from_str(&hello)?;
    d.hints = serde_json::from_str(&hints)?;
    Ok(d)
}

fn guest_row(r: &rusqlite::Row) -> rusqlite::Result<GuestRow> {
    Ok(GuestRow {
        id: r.get(0)?,
        name: r.get(1)?,
        channel: r.get(2)?,
        chat: r.get(3)?,
        added_at: r.get(4)?,
        removed_at: r.get(5)?,
    })
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl Store {
    // ---- devices (HB-02) ----

    /// Insert, or re-pair: an existing row with the same endpoint (or the same id) is replaced
    /// and un-revoked. `d.revoked_at` is ignored: a put is always a live pairing.
    pub fn device_put(&self, d: &DeviceRow) -> Result<()> {
        let hello = serde_json::to_string(&d.hello)?;
        let hints = serde_json::to_string(&d.hints)?;
        self.transaction(|tx| {
            tx.execute(
                "DELETE FROM devices WHERE endpoint = ? OR id = ?",
                [&d.endpoint, &d.id],
            )?;
            tx.execute(
                &format!(
                    "INSERT INTO devices ({DEVICE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
                ),
                params![
                    d.id,
                    d.name,
                    d.endpoint,
                    d.role,
                    d.platform,
                    hello,
                    hints,
                    d.paired_at,
                    d.last_seen
                ],
            )?;
            Ok(())
        })
    }

    /// Not revoked, by name.
    pub fn devices(&self) -> Result<Vec<DeviceRow>> {
        let conn = self.conn();
        let mut st = conn.prepare(&format!(
            "SELECT {DEVICE_COLS} FROM devices WHERE revoked_at IS NULL ORDER BY name, id"
        ))?;
        let raw = st
            .query_map([], device_raw)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(device_parse).collect()
    }

    /// Revoked or not: `revoked_at` says.
    pub fn device(&self, id: &str) -> Result<Option<DeviceRow>> {
        self.device_where("id", id)
    }

    /// Revoked or not: `revoked_at` says.
    pub fn device_by_endpoint(&self, endpoint: &str) -> Result<Option<DeviceRow>> {
        self.device_where("endpoint", endpoint)
    }

    /// `col` is one of this file's literals, never input.
    fn device_where(&self, col: &str, value: &str) -> Result<Option<DeviceRow>> {
        let raw = self
            .conn()
            .query_row(
                &format!("SELECT {DEVICE_COLS} FROM devices WHERE {col} = ?"),
                [value],
                device_raw,
            )
            .optional()?;
        raw.map(device_parse).transpose()
    }

    /// No such device is not an error: nothing changes.
    pub fn device_seen(&self, id: &str, at: Ms) -> Result<()> {
        self.conn().execute(
            "UPDATE devices SET last_seen = ? WHERE id = ?",
            params![at, id],
        )?;
        Ok(())
    }

    /// No such device is not an error: nothing changes.
    pub fn device_hints(&self, id: &str, hints: &serde_json::Value) -> Result<()> {
        self.conn().execute(
            "UPDATE devices SET hints = ? WHERE id = ?",
            params![serde_json::to_string(hints)?, id],
        )?;
        Ok(())
    }

    /// false when there is no such device or it was revoked already (the first time is kept).
    pub fn device_revoke(&self, id: &str, at: Ms) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            params![at, id],
        )?;
        Ok(n > 0)
    }

    // ---- fallback sync (HB-11) ----

    /// The local id a fallback row became, if it was synced already.
    pub fn fallback_synced(&self, device: &str, remote_id: i64) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT local_id FROM fallback_sync WHERE device = ? AND remote_id = ?",
                params![device, remote_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Idempotent: marking a (device, remote_id) pair again is a no-op and the first
    /// `local_id` stays, so a retried sync never points a remote row at a second copy.
    pub fn fallback_mark(&self, device: &str, remote_id: i64, local_id: i64, at: Ms) -> Result<()> {
        self.conn().execute(
            "INSERT OR IGNORE INTO fallback_sync (device, remote_id, local_id, at) \
             VALUES (?, ?, ?, ?)",
            params![device, remote_id, local_id, at],
        )?;
        Ok(())
    }

    // ---- guests (HB-18, TR-11) ----

    /// A guest with a one-time code; returns the row id. The code itself is never stored:
    /// `code_hash` must be its sha256 as 64 lowercase hex, else `Error::Invalid`.
    pub fn guest_add(&self, name: &str, channel: &str, code_hash: &str, at: Ms) -> Result<i64> {
        if !is_sha256_hex(code_hash) {
            return Err(Error::Invalid(
                "A guest code must be given as its sha256, 64 lowercase hex digits.".into(),
            ));
        }
        let conn = self.conn();
        conn.execute(
            "INSERT INTO guests (name, channel, code_hash, added_at) VALUES (?, ?, ?, ?)",
            params![name, channel, code_hash, at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// The guest whose unused code hashes to `code_hash` on `channel` claims `chat`; the code is
    /// spent. None when no live guest has that unused code. A removed guest that held `chat`
    /// lets go of it; a live guest that holds it already is `Error::Refused` and the code stays.
    pub fn guest_claim(
        &self,
        channel: &str,
        code_hash: &str,
        chat: &str,
    ) -> Result<Option<GuestRow>> {
        self.transaction(|tx| {
            let id: Option<i64> = tx
                .query_row(
                    "SELECT id FROM guests WHERE channel = ? AND code_hash = ? \
                     AND removed_at IS NULL",
                    [channel, code_hash],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(id) = id else { return Ok(None) };
            let taken: Option<i64> = tx
                .query_row(
                    "SELECT id FROM guests WHERE channel = ? AND chat = ? AND removed_at IS NULL",
                    [channel, chat],
                    |r| r.get(0),
                )
                .optional()?;
            if taken.is_some() {
                return Err(Error::Refused(
                    "This chat already belongs to a guest.".into(),
                ));
            }
            tx.execute(
                "UPDATE guests SET chat = NULL WHERE channel = ? AND chat = ? \
                 AND removed_at IS NOT NULL",
                [channel, chat],
            )?;
            tx.execute(
                "UPDATE guests SET chat = ?, code_hash = NULL WHERE id = ?",
                params![chat, id],
            )?;
            Ok(Some(tx.query_row(
                &format!("SELECT {GUEST_COLS} FROM guests WHERE id = ?"),
                [id],
                guest_row,
            )?))
        })
    }

    /// Not removed.
    pub fn guest_of(&self, channel: &str, chat: &str) -> Result<Option<GuestRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {GUEST_COLS} FROM guests WHERE channel = ? AND chat = ? \
                     AND removed_at IS NULL"
                ),
                [channel, chat],
                guest_row,
            )
            .optional()?)
    }

    /// Not removed, oldest first.
    pub fn guests(&self) -> Result<Vec<GuestRow>> {
        let conn = self.conn();
        let mut st = conn.prepare(&format!(
            "SELECT {GUEST_COLS} FROM guests WHERE removed_at IS NULL ORDER BY added_at, id"
        ))?;
        let rows = st.query_map([], guest_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// false when there is no such guest or it was removed already. An unused code dies with it.
    pub fn guest_remove(&self, id: i64, at: Ms) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE guests SET removed_at = ?, code_hash = NULL \
             WHERE id = ? AND removed_at IS NULL",
            params![at, id],
        )?;
        Ok(n > 0)
    }
}
