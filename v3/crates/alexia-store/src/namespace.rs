// SPDX-License-Identifier: AGPL-3.0-only
//! Plugin namespaces (storage.md): `p_<ns>_<table>` tables, the `where` grammar, and purge.
//!
//! No value from a plugin is ever concatenated into SQL. Identifiers are validated, then
//! double-quoted; values are always `?` parameters.

use std::collections::BTreeSet;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::{
    is_ident, is_plugin_id, Cond, DeleteScope, Dir, Error, Result, Row, Scalar, Select, Store,
    Where,
};

/// The kv namespace and key prefix of the record of which tables belong to which ns.
const CORE: &str = "_core";

fn check_ns(ns: &str) -> Result<()> {
    if is_plugin_id(ns) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("{ns} is not a usable namespace.")))
    }
}

fn check_ident(name: &str) -> Result<()> {
    if is_ident(name) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("{name} is not a usable name.")))
    }
}

/// `p_<ns>_<table>`, every `-` in `ns` replaced by `_`. Validated, so safe to quote.
fn physical(ns: &str, table: &str) -> Result<String> {
    check_ns(ns)?;
    check_ident(table)?;
    Ok(format!("p_{}_{table}", ns.replace('-', "_")))
}

/// A validated identifier, quoted. Callers only pass names that passed `physical`/`is_ident`.
fn q(name: &str) -> String {
    format!("\"{name}\"")
}

fn record_key(ns: &str) -> String {
    format!("tables:{ns}")
}

fn declared(conn: &Connection, ns: &str) -> Result<BTreeSet<String>> {
    let text: Option<String> = conn
        .query_row(
            "SELECT value FROM kv WHERE ns = ? AND key = ?",
            params![CORE, record_key(ns)],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match text {
        Some(t) => serde_json::from_str(&t)?,
        None => BTreeSet::new(),
    })
}

/// The physical name of a table this ns created, or `OutOfNamespace`.
fn owned(conn: &Connection, ns: &str, table: &str) -> Result<String> {
    let name = physical(ns, table)?;
    if !declared(conn, ns)?.contains(table) {
        return Err(Error::OutOfNamespace(format!(
            "{table} is not one of this plugin's tables."
        )));
    }
    Ok(name)
}

fn columns(conn: &Connection, name: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", q(name)))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(cols.collect::<rusqlite::Result<_>>()?)
}

/// Checks every name before the unwritten early return, so a malformed column fails even there.
fn check_idents<'a>(names: impl IntoIterator<Item = &'a String>) -> Result<()> {
    names.into_iter().try_for_each(|n| check_ident(n))
}

/// The columns `create_tables` makes. A table with no others has never had a row.
const CREATED: &[&str] = &["rowid"];

/// The table's columns, or `None` if it is unwritten (v2 `#unwritten`): declared, but no row
/// has added a column yet. Such a table has no rows, so reading, changing and deleting from
/// it are all nothing, whatever columns the query names. A typo in a column of a table that
/// has rows still fails loudly.
fn written(conn: &Connection, name: &str) -> Result<Option<Vec<String>>> {
    let cols = columns(conn, name)?;
    let only_created = cols.iter().all(|c| CREATED.contains(&c.as_str()));
    Ok((!only_created).then_some(cols))
}

/// storage.md: integer or bool → INTEGER, other number → REAL, everything else → TEXT.
fn column_type(v: &Json) -> &'static str {
    match v {
        Json::Bool(_) => "INTEGER",
        Json::Number(n) if n.is_i64() || n.is_u64() => "INTEGER",
        Json::Number(_) => "REAL",
        _ => "TEXT",
    }
}

fn encode(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(i64::from(*b)),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or(f64::NAN)),
        },
        Json::String(s) => Value::Text(s.clone()),
        Json::Array(_) | Json::Object(_) => Value::Text(v.to_string()),
    }
}

fn scalar(s: &Scalar) -> Value {
    match s {
        Scalar::Null => Value::Null,
        Scalar::Bool(b) => Value::Integer(i64::from(*b)),
        Scalar::Num(n) => encode(&Json::Number(n.clone())),
        Scalar::Str(s) => Value::Text(s.clone()),
    }
}

/// Adds a column for every key of `row` the table does not have yet.
fn grow(conn: &Connection, name: &str, row: &Row) -> Result<()> {
    let existing = columns(conn, name)?;
    for (key, value) in row {
        check_ident(key)?;
        if !existing.iter().any(|c| c == key) {
            conn.execute_batch(&format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                q(name),
                q(key),
                column_type(value)
            ))?;
        }
    }
    Ok(())
}

/// ` WHERE a = ? AND …` (or empty) and its parameters. Every column must exist.
fn compile(filter: Option<&Where>, cols: &[String], table: &str) -> Result<(String, Vec<Value>)> {
    let mut parts = Vec::new();
    let mut params = Vec::new();
    for (col, cond) in filter.into_iter().flatten() {
        check_ident(col)?;
        if !cols.iter().any(|c| c == col) {
            return Err(Error::Invalid(format!("{col} is not a column of {table}.")));
        }
        let c = q(col);
        let op = match cond {
            Cond::Eq(v) => {
                params.push(scalar(v));
                parts.push(format!("{c} = ?"));
                continue;
            }
            Cond::Op(op) => op,
        };
        op.validate()?;
        let simple = [
            (&op.eq, "="),
            (&op.ne, "!="),
            (&op.lt, "<"),
            (&op.lte, "<="),
            (&op.gt, ">"),
            (&op.gte, ">="),
        ];
        if let Some((v, sql)) = simple.iter().find_map(|(v, s)| v.as_ref().map(|v| (v, s))) {
            params.push(scalar(v));
            parts.push(format!("{c} {sql} ?"));
        } else if let Some(vs) = &op.in_ {
            params.extend(vs.iter().map(scalar));
            let marks = vec!["?"; vs.len()].join(", ");
            parts.push(format!("{c} IN ({marks})"));
        } else if let Some(pat) = &op.like {
            params.push(Value::Text(pat.clone()));
            parts.push(format!("{c} LIKE ?"));
        } else {
            parts.push(format!("{c} IS NULL"));
        }
    }
    let sql = if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    };
    Ok((sql, params))
}

/// A column value as JSON. Text stays text, as in v2: a stored object comes back as its JSON.
fn decode(v: ValueRef<'_>) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number),
        ValueRef::Text(t) | ValueRef::Blob(t) => Json::String(String::from_utf8_lossy(t).into()),
    }
}

/// Every physical name another namespace has recorded.
fn others(conn: &Connection, ns: &str) -> Result<BTreeSet<String>> {
    let mut stmt =
        conn.prepare("SELECT key, value FROM kv WHERE ns = ? AND key LIKE 'tables:%'")?;
    let rows = stmt.query_map([CORE], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut names = BTreeSet::new();
    for r in rows {
        let (key, value) = r?;
        let other = &key["tables:".len()..];
        if other != ns {
            for t in serde_json::from_str::<BTreeSet<String>>(&value)? {
                names.insert(physical(other, &t)?);
            }
        }
    }
    Ok(names)
}

fn to_i64(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

impl Store {
    /// Creates each table empty and records it in kv `_core` / `tables:<ns>`.
    pub fn create_tables(&self, ns: &str, tables: &[String]) -> Result<()> {
        let names = tables
            .iter()
            .map(|t| physical(ns, t))
            .collect::<Result<Vec<_>>>()?;
        self.transaction(|tx| {
            // `a`/`b_x` and `a-b`/`x` are both `p_a_b_x`: a new name must be free.
            let mine = declared(tx, ns)?;
            let taken = others(tx, ns)?;
            for (table, name) in tables.iter().zip(&names) {
                if mine.contains(table) {
                    continue;
                }
                let exists: bool = tx.query_row(
                    "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = ?)",
                    [name],
                    |r| r.get(0),
                )?;
                if exists || taken.contains(name) {
                    return Err(Error::Invalid(format!("{table} is already taken.")));
                }
            }
            for name in &names {
                tx.execute_batch(&format!(
                    "CREATE TABLE IF NOT EXISTS {} (rowid INTEGER PRIMARY KEY)",
                    q(name)
                ))?;
            }
            let mut record = mine;
            record.extend(tables.iter().cloned());
            tx.execute(
                "INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) \
                 ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value",
                params![CORE, record_key(ns), serde_json::to_string(&record)?],
            )?;
            Ok(())
        })
    }

    pub fn insert(&self, ns: &str, table: &str, row: &Row) -> Result<i64> {
        if row.contains_key("rowid") {
            return Err(Error::Invalid(
                "rowid is set by core, not by an insert.".into(),
            ));
        }
        if row.is_empty() {
            return Err(Error::Invalid("There is nothing to insert.".into()));
        }
        self.transaction(|tx| {
            let name = owned(tx, ns, table)?;
            grow(tx, &name, row)?;
            let keys: Vec<String> = row.keys().map(|k| q(k)).collect();
            let marks = vec!["?"; keys.len()].join(", ");
            tx.execute(
                &format!(
                    "INSERT INTO {} ({}) VALUES ({marks})",
                    q(&name),
                    keys.join(", ")
                ),
                params_from_iter(row.values().map(encode)),
            )?;
            Ok(tx.last_insert_rowid())
        })
    }

    pub fn select(&self, ns: &str, table: &str, query: &Select) -> Result<Vec<Row>> {
        let conn = self.conn();
        let name = owned(&conn, ns, table)?;
        check_idents(query.filter.iter().flat_map(|w| w.keys()))?;
        check_idents(query.order.iter().map(|(c, _)| c))?;
        let Some(cols) = written(&conn, &name)? else {
            return Ok(Vec::new());
        };
        let (clause, mut params) = compile(query.filter.as_ref(), &cols, table)?;
        let mut order = Vec::new();
        for (col, dir) in &query.order {
            check_ident(col)?;
            if !cols.iter().any(|c| c == col) {
                return Err(Error::Invalid(format!("{col} is not a column of {table}.")));
            }
            let d = match dir {
                Dir::Asc => "ASC",
                Dir::Desc => "DESC",
            };
            order.push(format!("{} {d}", q(col)));
        }
        let mut sql = format!("SELECT * FROM {}{clause}", q(&name));
        if !order.is_empty() {
            sql += &format!(" ORDER BY {}", order.join(", "));
        }
        if query.limit.is_some() || query.offset.is_some() {
            // SQLite needs LIMIT for OFFSET; -1 is "all of them".
            sql += " LIMIT ? OFFSET ?";
            params.push(Value::Integer(query.limit.map_or(-1, to_i64)));
            params.push(Value::Integer(query.offset.map_or(0, to_i64)));
        }
        let mut stmt = conn.prepare(&sql)?;
        let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        let rows = stmt.query_map(params_from_iter(params), |r| {
            let mut row = Row::new();
            for (i, n) in names.iter().enumerate() {
                row.insert(n.clone(), decode(r.get_ref(i)?));
            }
            Ok(row)
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn update(&self, ns: &str, table: &str, set: &Row, filter: &Where) -> Result<u64> {
        if filter.is_empty() {
            return Err(Error::Invalid("update needs a where.".into()));
        }
        if set.is_empty() {
            return Err(Error::Invalid("update needs something to set.".into()));
        }
        self.transaction(|tx| {
            let name = owned(tx, ns, table)?;
            check_idents(filter.keys().chain(set.keys()))?;
            if written(tx, &name)?.is_none() {
                return Ok(0);
            }
            grow(tx, &name, set)?;
            let cols = columns(tx, &name)?;
            let (clause, wparams) = compile(Some(filter), &cols, table)?;
            let assign: Vec<String> = set.keys().map(|k| format!("{} = ?", q(k))).collect();
            let mut params: Vec<Value> = set.values().map(encode).collect();
            params.extend(wparams);
            let n = tx.execute(
                &format!("UPDATE {} SET {}{clause}", q(&name), assign.join(", ")),
                params_from_iter(params),
            )?;
            Ok(n as u64)
        })
    }

    pub fn delete(&self, ns: &str, table: &str, scope: DeleteScope<'_>) -> Result<u64> {
        let filter = match scope {
            DeleteScope::Where(w) if w.is_empty() => {
                return Err(Error::Invalid(
                    "delete needs a where; deleting every row is all.".into(),
                ))
            }
            DeleteScope::Where(w) => Some(w),
            DeleteScope::All => None,
        };
        let conn = self.conn();
        let name = owned(&conn, ns, table)?;
        check_idents(filter.into_iter().flat_map(|w| w.keys()))?;
        let Some(cols) = written(&conn, &name)? else {
            return Ok(0);
        };
        let (clause, params) = compile(filter, &cols, table)?;
        let n = conn.execute(
            &format!("DELETE FROM {}{clause}", q(&name)),
            params_from_iter(params),
        )?;
        Ok(n as u64)
    }

    pub fn count(&self, ns: &str, table: &str, filter: Option<&Where>) -> Result<u64> {
        let conn = self.conn();
        let name = owned(&conn, ns, table)?;
        check_idents(filter.into_iter().flat_map(|w| w.keys()))?;
        let Some(cols) = written(&conn, &name)? else {
            return Ok(0);
        };
        let (clause, params) = compile(filter, &cols, table)?;
        let n: i64 = conn.query_row(
            &format!("SELECT count(*) FROM {}{clause}", q(&name)),
            params_from_iter(params),
            |r| r.get(0),
        )?;
        Ok(n as u64)
    }

    /// v2's answer (open question G1): refused, always.
    pub fn raw(&self, _ns: &str, _sql: &str, _params: &[Scalar]) -> Result<Vec<Row>> {
        Err(Error::OutOfNamespace("Raw SQL is not available.".into()))
    }

    /// In one transaction: the tables recorded for `ns`, that record, the plugin's kv and
    /// settings. Only recorded tables are dropped; create_tables refuses shared names.
    pub fn purge(&self, plugin: &str, ns: Option<&str>) -> Result<()> {
        self.transaction(|tx| {
            if let Some(ns) = ns {
                for table in declared(tx, ns)? {
                    tx.execute_batch(&format!(
                        "DROP TABLE IF EXISTS {}",
                        q(&physical(ns, &table)?)
                    ))?;
                }
                tx.execute(
                    "DELETE FROM kv WHERE ns = ? AND key = ?",
                    params![CORE, record_key(ns)],
                )?;
            }
            tx.execute("DELETE FROM kv WHERE ns = ?", [plugin])?;
            tx.execute("DELETE FROM settings WHERE plugin = ?", [plugin])?;
            Ok(())
        })
    }
}
