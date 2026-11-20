// SPDX-License-Identifier: AGPL-3.0-only
//! TR-09: converting a plain `alexia.db` to SQLCipher in place. Off by default: only an explicit
//! call (`alexia-hub encrypt`, P2-38) ever runs this. The key is never logged, printed or put in
//! an `Error`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::{secrets, Error, Result, Store};

/// The key's place in the keychain: service `alexia`, account `_core.store_key`.
pub(crate) const OWNER: &str = "_core";
pub(crate) const KEY: &str = "store_key";

/// `PRAGMA key` / `ATTACH … KEY` value for a stored key: SQLCipher's raw-key form, so no KDF
/// runs at open. `None` if what is stored is not 64 hex digits.
pub(crate) fn raw_key(hex: &str) -> Option<String> {
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("x'{hex}'"))
}

fn refused(s: &str) -> Error {
    Error::Refused(s.into())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Generate a key, store it, `sqlcipher_export` into `alexia.db.enc`, verify every table's row
/// count, swap atomically, overwrite then delete the plain file and its -wal/-shm. Refuses if the
/// hub is running (the file is locked) or the key already exists.
///
/// The overwrite is best effort: on an SSD (wear levelling) or a copy-on-write or journaling file
/// system the old plain blocks can survive on the disk. It makes the plain data unreadable
/// through the file system, nothing more.
pub fn encrypt(path: &Path) -> Result<()> {
    if !path.is_file() {
        return Err(refused("There is no database to encrypt."));
    }
    if Store::is_encrypted(path)? {
        return Err(refused("The database is already encrypted."));
    }
    if secrets::get(OWNER, KEY)?.is_some() {
        return Err(refused(
            "A database key already exists, so the database was not encrypted again.",
        ));
    }
    let enc = with_suffix(path, ".enc");
    let plain = with_suffix(path, ".plain");
    for leftover in [&enc, &plain] {
        if leftover.exists() {
            fs::remove_file(leftover)?;
        }
    }

    // std has no CSPRNG; getrandom is the OS RNG.
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| refused("The system's random number generator failed."))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    secrets::set(OWNER, KEY, &hex)?;

    if let Err(e) = export_and_swap(path, &enc, &plain, &hex) {
        // Nothing was swapped: the plain file is still the database, so the key must go.
        let _ = fs::remove_file(&enc);
        let _ = fs::remove_file(&plain);
        let _ = secrets::delete(OWNER, KEY);
        return Err(e);
    }
    shred(&plain);
    for side in ["-wal", "-shm"] {
        shred(&with_suffix(path, side));
    }
    Ok(())
}

fn export_and_swap(path: &Path, enc: &Path, plain: &Path, hex: &str) -> Result<()> {
    {
        let conn = Connection::open(path)?;
        // No waiting: a running hub holds the file, and that is a refusal, not a delay.
        conn.busy_timeout(std::time::Duration::ZERO)?;
        // Held until this connection closes, so nothing writes between export and swap.
        let locked = conn
            .query_row("PRAGMA locking_mode = EXCLUSIVE", [], |_| Ok(()))
            .and_then(|_| conn.execute_batch("BEGIN EXCLUSIVE; COMMIT;"));
        if let Err(e) = locked {
            return Err(match e.sqlite_error_code() {
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                    refused("The database is in use. Stop the hub, then encrypt it.")
                }
                _ => e.into(),
            });
        }
        let raw = raw_key(hex).expect("a generated key is 64 hex digits");
        conn.execute(
            "ATTACH DATABASE ?1 AS enc KEY ?2",
            [enc.to_string_lossy().as_ref(), raw.as_str()],
        )?;
        conn.query_row("SELECT sqlcipher_export('enc')", [], |_| Ok(()))?;
        // sqlcipher_export copies schema and rows only.
        for pragma in ["user_version", "application_id"] {
            let v: i64 = conn.query_row(&format!("PRAGMA main.{pragma}"), [], |r| r.get(0))?;
            conn.execute_batch(&format!("PRAGMA enc.{pragma} = {v}"))?;
        }
        let mut stmt = conn.prepare(
            "SELECT name FROM main.sqlite_master WHERE type = 'table' \
             AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
        )?;
        let tables = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for t in tables {
            let q = format!("\"{}\"", t.replace('"', "\"\""));
            let count = |schema: &str| -> rusqlite::Result<i64> {
                conn.query_row(&format!("SELECT count(*) FROM {schema}.{q}"), [], |r| {
                    r.get(0)
                })
            };
            if count("main")? != count("enc")? {
                return Err(refused(
                    "The encrypted copy did not match the database, so nothing was changed.",
                ));
            }
        }
        conn.execute_batch("DETACH DATABASE enc")?;
    }
    // A second name for the plain bytes, so they can be overwritten after the swap.
    fs::hard_link(path, plain)?;
    fs::rename(enc, path)?;
    Ok(())
}

/// Overwrite with zeros, flush, delete. Best effort; a missing file is fine.
fn shred(path: &Path) {
    let Ok(len) = fs::metadata(path).map(|m| m.len()) else {
        return;
    };
    if let Ok(mut f) = OpenOptions::new().write(true).open(path) {
        let zeros = vec![0u8; 64 * 1024];
        let mut left = len;
        while left > 0 {
            let n = left.min(zeros.len() as u64) as usize;
            if f.write_all(&zeros[..n]).is_err() {
                break;
            }
            left -= n as u64;
        }
        let _ = f.sync_all();
    }
    let _ = fs::remove_file(path);
}
