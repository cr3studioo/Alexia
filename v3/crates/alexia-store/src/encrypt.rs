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

/// What the marker says. No key material: only that a key belongs to this database.
const MARKER_TEXT: &str = "This Alexia database is meant to be encrypted. Its key is in the \
                           keychain: service alexia, account _core.store_key.\n";

/// `alexia.db.keyed`: "this database is meant to be encrypted". `encrypt` writes it before it
/// stores the key, so a stored key always has a marker beside the database it is for.
pub(crate) fn marker(path: &Path) -> PathBuf {
    with_suffix(path, ".keyed")
}

/// Writes the marker and fsyncs it.
fn write_marker(path: &Path) -> Result<()> {
    let mut f = fs::File::create(marker(path))?;
    f.write_all(MARKER_TEXT.as_bytes())?;
    f.sync_all()?;
    Ok(())
}

/// `alexia.db.plain` is the whole plain database when `encrypt` stopped after the swap and before
/// the shred. Shreds it and its -wal/-shm, naming the file (never its content) in one warning;
/// true when there was one. Only for an encrypted `path`: then the leftover is not the database.
pub(crate) fn shred_plain_leftover(path: &Path) -> bool {
    let plain = with_suffix(path, ".plain");
    if !plain.exists() {
        return false;
    }
    tracing::warn!(
        file = %plain.display(),
        "an interrupted encryption left a plain copy of the database; shredding it"
    );
    shred(&plain);
    for side in ["-wal", "-shm"] {
        shred(&with_suffix(&plain, side));
    }
    true
}

/// Write the marker, generate a key, store it, `sqlcipher_export` into `alexia.db.enc`, verify
/// every table's row count, swap atomically, overwrite then delete the plain file and its
/// -wal/-shm. Refuses if the hub is running (the file is locked) or a key is already stored
/// without the marker. A stored key with the marker is an `encrypt` that was cut short: this
/// finishes it with that key.
///
/// The overwrite is best effort: on an SSD (wear levelling) or a copy-on-write or journaling file
/// system the old plain blocks can survive on the disk. It makes the plain data unreadable
/// through the file system, nothing more.
pub fn encrypt(path: &Path) -> Result<()> {
    if !path.is_file() {
        return Err(refused("There is no database to encrypt."));
    }
    if Store::is_encrypted(path)? {
        shred_plain_leftover(path);
        return Err(refused("The database is already encrypted."));
    }
    const EXISTS: &str = "A database key already exists, so the database was not encrypted again.";
    let stored = secrets::get(OWNER, KEY)?;
    let resume = stored.is_some() && marker(path).is_file();
    if stored.is_some() && !resume {
        return Err(refused(EXISTS));
    }
    let enc = with_suffix(path, ".enc");
    let plain = with_suffix(path, ".plain");
    // The database is plain here, so a `.plain` is at most a second name for it (the cut came
    // between the hard link and the swap): remove, never shred.
    for leftover in [&enc, &plain] {
        if leftover.exists() {
            fs::remove_file(leftover)?;
        }
    }

    let hex = match stored {
        // A resume: the key the cut-short `encrypt` stored.
        Some(hex) if raw_key(&hex).is_some() => hex,
        Some(_) => return Err(refused(EXISTS)),
        None => {
            // std has no CSPRNG; getrandom is the OS RNG.
            let mut bytes = [0u8; 32];
            getrandom::getrandom(&mut bytes)
                .map_err(|_| refused("The system's random number generator failed."))?;
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            // The marker first: a crash after it leaves a key that `encrypt` can finish with.
            write_marker(path)?;
            if let Err(e) = secrets::set(OWNER, KEY, &hex) {
                let _ = fs::remove_file(marker(path));
                return Err(e);
            }
            hex
        }
    };

    if let Err(e) = export_and_swap(path, &enc, &plain, &hex) {
        // Nothing was swapped: the plain file is still the database. A key this call made goes,
        // and its marker after it (a marker alone is harmless, a key alone is not). On a resume
        // the key was the owner's before this call, so both stay.
        let _ = fs::remove_file(&enc);
        let _ = fs::remove_file(&plain);
        if !resume {
            let _ = secrets::delete(OWNER, KEY);
            let _ = fs::remove_file(marker(path));
        }
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
        let raw = raw_key(hex).expect("the key was checked to be 64 hex digits");
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
pub(crate) fn shred(path: &Path) {
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
