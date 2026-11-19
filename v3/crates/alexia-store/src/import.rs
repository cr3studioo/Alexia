// SPDX-License-Identifier: AGPL-3.0-only
//! The v2 importer (INTERFACES.md §6): a copy of a v2 data folder into this store, once.
//!
//! The database half is one transaction. The file half copies, never moves, and can be repeated
//! on its own (`import_v2_files`). Secrets are never read or written here.
//!
//! A hub that has run its plugins already has their `p_*` tables, created empty at plugin
//! start. A hub table with v2's name and no rows is dropped in the import's transaction and
//! made again from v2's definition; one that holds rows refuses the import, so nothing the hub
//! wrote is lost.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use crate::{is_ident, is_plugin_id, now_ms, Error, Layout, MessageBody, Result, Store};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ImportReport {
    pub v2_schema: i64,
    pub rows: Vec<(String, u64)>,
    pub files: u64,
    pub skipped: Vec<String>,
}

/// The newest v2 schema this build knows.
const V2_LATEST: i64 = 11;

/// v2 core tables copied by column name, parents before children (foreign keys are on).
const CORE_TABLES: &[&str] = &[
    "kv",
    "settings",
    "sessions",
    "messages",
    "provider_usage",
    "usage",
    "tries",
    "seen",
    "runs",
    "attachments",
];
/// v2 tables known and deliberately left behind: a lease is a live authorization, not
/// history; `strikes` existed only at v2 6.
const LEFT_BEHIND: &[&str] = &["attachment_leases", "strikes"];
/// Keyed config: a hub may have written some before importing; v2's value wins.
const REPLACED: &[&str] = &["kv", "settings"];

fn refused(s: &str) -> Error {
    Error::Refused(s.into())
}

fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn ro_uri(path: &Path) -> Result<String> {
    Ok(uri(&std::path::absolute(path)?.to_string_lossy()))
}

/// `file:/C:/…?mode=ro`, `file:////server/share/…?mode=ro` or `file:/home/…?mode=ro`: forward
/// slashes, the Windows `\\?\` and `\\?\UNC\` prefixes dropped, `%`, `?`, `#` escaped.
fn uri(path: &str) -> String {
    let s = path.replace('\\', "/");
    let s = match (s.strip_prefix("//?/UNC/"), s.strip_prefix("//?/")) {
        (Some(unc), _) => format!("//{unc}"),
        (None, Some(local)) => local.to_owned(),
        (None, None) => s,
    };
    let s = s
        .replace('%', "%25")
        .replace('?', "%3F")
        .replace('#', "%23");
    if s.starts_with("//") {
        format!("file://{s}?mode=ro")
    } else if s.starts_with('/') {
        format!("file:{s}?mode=ro")
    } else {
        format!("file:/{s}?mode=ro")
    }
}

/// §6, all of it: checks, one transaction, the `imports` row, then the files.
pub fn import_v2(store: &Store, v2_root: &Path, v3: &Layout) -> Result<ImportReport> {
    let db = v2_root.join("alexia.db");
    if !db.is_file() {
        return Err(refused("There is no Alexia database in that folder."));
    }
    // The one read-write open of the copy: checks, then fold any WAL into the file.
    let v2_schema = {
        let v2 = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let app_id: i64 = v2.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        if app_id != 0 {
            return Err(refused("That folder holds a v3 database, not a v2 one."));
        }
        let version: i64 = v2.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            return Err(refused("That database is empty."));
        }
        if !(1..=V2_LATEST).contains(&version) {
            return Err(refused(
                "This v2 data is from a newer Alexia than the importer knows.",
            ));
        }
        v2.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        version
    };

    let mut skipped = Vec::new();
    let (import_id, mut report) = {
        let mut conn = store.conn();
        conn.execute("ATTACH DATABASE ? AS v2", [ro_uri(&db)?])?;
        let out = copy_db(&mut conn, v2_root, v2_schema);
        let detached = conn.execute_batch("DETACH DATABASE v2");
        let out = out?;
        detached?;
        out
    };

    // After commit: a failure here leaves the row written; `import_v2_files` repeats it.
    report.files = copy_files(v2_root, v3, &mut skipped)?;
    report.skipped.append(&mut skipped);
    store.conn().execute(
        "UPDATE imports SET report = ? WHERE id = ?",
        params![serde_json::to_string(&report)?, import_id],
    )?;
    Ok(report)
}

/// The file half only, for repeating after a copy failure. Never touches the database.
pub fn import_v2_files(v2_root: &Path, v3: &Layout) -> Result<u64> {
    copy_files(v2_root, v3, &mut Vec::new())
}

fn columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info({})", q(table)))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(cols.collect::<rusqlite::Result<_>>()?)
}

/// The database half, in one transaction. Returns the `imports` row id and the report so far.
fn copy_db(conn: &mut Connection, v2_root: &Path, v2_schema: i64) -> Result<(i64, ImportReport)> {
    // Immediate: the write lock is held from this check to commit, so no session slips in.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let taken: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM imports) OR EXISTS (SELECT 1 FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    if taken {
        return Err(refused(
            "This hub already has conversations, so v2 data was not imported over them.",
        ));
    }
    // v2's `p_*` tables may reference each other in any order; checked once, at commit.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    let mut rows = Vec::new();
    let mut skipped = Vec::new();

    let v2_tables: Vec<(String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT name, sql FROM v2.sqlite_master WHERE type = 'table' \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )?;
        let r = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        r.collect::<rusqlite::Result<_>>()?
    };
    let present: BTreeSet<&str> = v2_tables.iter().map(|(n, _)| n.as_str()).collect();

    for &table in CORE_TABLES {
        if !present.contains(table) {
            continue;
        }
        let mine = columns(&tx, "main", table)?;
        let cols: Vec<String> = columns(&tx, "v2", table)?
            .into_iter()
            .filter(|c| mine.contains(c))
            .map(|c| q(&c))
            .collect();
        let cols = cols.join(", ");
        let verb = if REPLACED.contains(&table) {
            "INSERT OR REPLACE"
        } else {
            "INSERT"
        };
        let n = tx.execute(
            &format!(
                "{verb} INTO main.{t} ({cols}) SELECT {cols} FROM v2.{t}",
                t = q(table)
            ),
            [],
        )?;
        rows.push((table.to_owned(), n as u64));
    }

    if present.contains("messages") {
        let mut stmt = tx.prepare("SELECT id, body FROM v2.messages ORDER BY id")?;
        let bodies = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for b in bodies {
            let (id, body) = b?;
            if serde_json::from_str::<MessageBody>(&body).is_err() {
                skipped.push(format!(
                    "message {id}: its body is not a v2 message; copied as it was"
                ));
            }
        }
    }

    // Plugin ids, read from the v2 data: kv namespaces, settings owners, plugin folders.
    let mut ids = BTreeSet::new();
    for sql in [
        "SELECT DISTINCT ns FROM v2.kv",
        "SELECT DISTINCT plugin FROM v2.settings",
    ] {
        let mut stmt = tx.prepare(sql)?;
        let r = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
        for id in r {
            ids.extend(id?);
        }
    }
    for dir in ["plugins", "extensions"] {
        if let Ok(entries) = fs::read_dir(v2_root.join(dir)) {
            for e in entries.flatten() {
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    ids.extend(e.file_name().to_str().map(str::to_owned));
                }
            }
        }
    }
    ids.retain(|id| is_plugin_id(id));

    // Every `p_*` table is created before any is filled: an insert needs its parent to exist.
    let mut plugin_tables = Vec::new();
    for (name, sql) in &v2_tables {
        if CORE_TABLES.contains(&name.as_str()) || LEFT_BEHIND.contains(&name.as_str()) {
            continue;
        }
        let (true, Some(sql)) = (name.starts_with("p_") && is_ident(name), sql) else {
            skipped.push(format!(
                "{name}: not a v2 table the importer knows; not copied"
            ));
            continue;
        };
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?)",
            [name],
            |r| r.get(0),
        )?;
        if exists {
            let filled: bool = tx.query_row(
                &format!("SELECT EXISTS (SELECT 1 FROM main.{})", q(name)),
                [],
                |r| r.get(0),
            )?;
            if filled {
                return Err(Error::Refused(format!(
                    "This hub already has rows in a table named {name}, so v2 data was not \
                     imported over them."
                )));
            }
            tx.execute_batch(&format!("DROP TABLE main.{}", q(name)))?;
        }
        // Unqualified CREATE lands in main. `execute` refuses a second statement.
        tx.execute(sql, [])?;
        let indexes: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT sql FROM v2.sqlite_master WHERE type = 'index' AND tbl_name = ? \
                 AND sql IS NOT NULL",
            )?;
            let r = stmt.query_map([name], |r| r.get(0))?;
            r.collect::<rusqlite::Result<_>>()?
        };
        for sql in indexes {
            tx.execute(&sql, [])?;
        }
        plugin_tables.push(name);
    }

    let mut owned: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for name in plugin_tables {
        // `WHERE true` turns off SQLite's table-to-table copy, which skips the deferred
        // foreign-key count a parent's rows must settle; without it a child copied first
        // still fails at commit.
        let n = tx.execute(
            &format!(
                "INSERT INTO main.{t} SELECT * FROM v2.{t} WHERE true",
                t = q(name)
            ),
            [],
        )?;
        rows.push((name.clone(), n as u64));

        // The longest plugin id whose `p_<id with _>_` prefixes the name owns it.
        let owner = ids
            .iter()
            .filter_map(|id| {
                let rest = name.strip_prefix(&format!("p_{}_", id.replace('-', "_")))?;
                (!rest.is_empty()).then_some((id, rest))
            })
            .max_by_key(|(id, _)| id.len());
        match owner {
            Some((id, rest)) => {
                owned.entry(id.clone()).or_default().insert(rest.to_owned());
            }
            None => skipped.push(format!(
                "{name}: not attributable to a plugin; copied, but no plugin owns it"
            )),
        }
    }

    // The record P0-05's namespaces and purge read: kv `_core` / `tables:<ns>`.
    for (ns, tables) in owned {
        let key = format!("tables:{ns}");
        let old: Option<String> = tx
            .query_row(
                "SELECT value FROM kv WHERE ns = '_core' AND key = ?",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        let mut record: BTreeSet<String> = match old {
            Some(t) => serde_json::from_str(&t)?,
            None => BTreeSet::new(),
        };
        record.extend(tables);
        tx.execute(
            "INSERT INTO kv (ns, key, value) VALUES ('_core', ?, ?) \
             ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value",
            params![key, serde_json::to_string(&record)?],
        )?;
    }

    let report = ImportReport {
        v2_schema,
        rows,
        files: 0,
        skipped,
    };
    let at = now_ms();
    tx.execute(
        "INSERT INTO imports (at, v2_schema, report) VALUES (?, ?, ?)",
        params![at, v2_schema, serde_json::to_string(&report)?],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok((id, report))
}

/// §6's file table. Existing destination files are left alone and listed in `skipped`.
fn copy_files(v2_root: &Path, v3: &Layout, skipped: &mut Vec<String>) -> Result<u64> {
    let mut n = 0;
    for (dir, dest) in [("plugins", true), ("extensions", false)] {
        let Ok(entries) = fs::read_dir(v2_root.join(dir)) else {
            continue;
        };
        for e in entries {
            let e = e?;
            let name = e.file_name();
            match name.to_str() {
                Some(id) if e.file_type()?.is_dir() => {
                    let to = if dest {
                        v3.own_dir(id)
                    } else {
                        v3.extensions().join(id)
                    };
                    n += copy_tree(&e.path(), &to, skipped)?;
                }
                _ => skipped.push(format!("{}: not a plugin folder", e.path().display())),
            }
        }
    }
    n += copy_tree(&v2_root.join("skills"), &v3.skills(), skipped)?;
    n += copy_tree(&v2_root.join("uploads"), &v3.uploads(), skipped)?;
    Ok(n)
}

/// Copies every file under `from` that `to` lacks. A missing `from` copies nothing.
fn copy_tree(from: &Path, to: &Path, skipped: &mut Vec<String>) -> Result<u64> {
    let Ok(entries) = fs::read_dir(from) else {
        return Ok(0);
    };
    let mut n = 0;
    for e in entries {
        let e = e?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        let kind = e.file_type()?;
        if kind.is_dir() {
            n += copy_tree(&src, &dst, skipped)?;
        } else if !kind.is_file() {
            skipped.push(format!("{}: not a plain file; not copied", src.display()));
        } else if dst.exists() {
            skipped.push(format!("{}: already there; left alone", dst.display()));
        } else {
            fs::create_dir_all(to)?;
            fs::copy(&src, &dst)?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::uri;

    #[test]
    fn uri_of_a_drive_path() {
        assert_eq!(
            uri(r"C:\Users\v\a b\alexia.db"),
            "file:/C:/Users/v/a b/alexia.db?mode=ro"
        );
    }

    #[test]
    fn uri_of_a_verbatim_path() {
        assert_eq!(
            uri(r"\\?\C:\data\100%\alexia.db"),
            "file:/C:/data/100%25/alexia.db?mode=ro"
        );
    }

    #[test]
    fn uri_of_a_unc_path() {
        let want = "file:////server/share/v2/alexia.db?mode=ro";
        assert_eq!(uri(r"\\server\share\v2\alexia.db"), want);
        assert_eq!(uri(r"\\?\UNC\server\share\v2\alexia.db"), want);
    }

    #[test]
    fn uri_of_a_unix_path() {
        assert_eq!(
            uri("/home/v/#1/alexia.db"),
            "file:/home/v/%231/alexia.db?mode=ro"
        );
    }
}
