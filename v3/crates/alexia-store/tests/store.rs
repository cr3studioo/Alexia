// SPDX-License-Identifier: AGPL-3.0-only
use std::path::PathBuf;

use alexia_store::*;
use rusqlite::Connection;
use serde_json::json;

/// A fresh, empty folder per test under the system temp dir.
fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("alexia-store-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))
        .unwrap()
}

fn text(s: &str) -> MessageBody {
    serde_json::from_value(json!({ "content": s })).unwrap()
}

const TABLES: &[&str] = &[
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
    "attachment_leases",
    "imports",
];

#[test]
fn open_creates_file_and_migrates() {
    let db = temp("creates").join("nested").join("alexia.db");
    let store = Store::open(&db).unwrap();
    assert!(db.exists());
    store
        .transaction(|tx| {
            assert_eq!(pragma_i64(tx, "user_version"), 1);
            assert_eq!(pragma_i64(tx, "application_id"), 1095522355);
            let mode: String = tx.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
            assert_eq!(mode, "wal");
            for t in TABLES {
                let n: i64 = tx.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [t],
                    |r| r.get(0),
                )?;
                assert_eq!(n, 1, "table {t} missing");
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn reopen_is_idempotent() {
    let db = temp("reopen").join("alexia.db");
    drop(Store::open(&db).unwrap());
    let store = Store::open(&db).unwrap();
    let v = store
        .transaction(|tx| Ok(pragma_i64(tx, "user_version")))
        .unwrap();
    assert_eq!(v, 1);
}

#[test]
fn refuses_newer_schema() {
    let db = temp("newer").join("alexia.db");
    drop(Store::open(&db).unwrap());
    Connection::open(&db)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    assert!(matches!(Store::open(&db), Err(Error::Refused(_))));
}

#[test]
fn refuses_foreign_file() {
    let dir = temp("foreign");
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("alexia.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 11;",
        )
        .unwrap();
        assert_eq!(pragma_i64(&conn, "application_id"), 0);
    }
    match Store::open(&db) {
        Err(Error::Refused(m)) => assert_eq!(m, "This file is not an Alexia v3 database."),
        other => panic!("expected Refused, got {:?}", other.map(|_| ())),
    }
}

#[test]
fn sessions_and_history() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_session(Some("first")).unwrap();
    let b = store.create_session(None).unwrap();
    // `a` is older by id; writing to it must lift it above `b` on time, not on a tie.
    std::thread::sleep(std::time::Duration::from_millis(5));

    let bodies: Vec<MessageBody> = (0..5).map(|i| text(&format!("m{i}"))).collect();
    let mut ids = Vec::new();
    for (i, body) in bodies.iter().enumerate() {
        let (role, model) = if i % 2 == 0 {
            (Role::User, None)
        } else {
            (Role::Assistant, Some("m-1"))
        };
        ids.push(store.append(a, role, model, body).unwrap());
    }

    let all = store.history(a, None).unwrap();
    assert_eq!(all.len(), 5);
    assert_eq!(all.iter().map(|m| m.id).collect::<Vec<_>>(), ids);
    assert_eq!(
        all.iter().map(|m| m.body.clone()).collect::<Vec<_>>(),
        bodies
    );
    assert_eq!(all[0].role, Role::User);
    assert_eq!(all[1].role, Role::Assistant);
    assert_eq!(all[1].model.as_deref(), Some("m-1"));
    assert!(all.iter().all(|m| m.session == a && m.at > 0));

    let last2 = store.history(a, Some(2)).unwrap();
    assert_eq!(last2.iter().map(|m| m.id).collect::<Vec<_>>(), ids[3..]);
    assert!(store.history(b, None).unwrap().is_empty());

    let list = store.sessions().unwrap();
    assert_eq!(list.iter().map(|s| s.id).collect::<Vec<_>>(), [a, b]);
    assert_eq!(list[0].title.as_deref(), Some("first"));
    assert!(list[0].updated_at > list[0].created_at);

    store.set_title(b, "renamed").unwrap();
    let list = store.sessions().unwrap();
    assert_eq!(list[1].title.as_deref(), Some("renamed"));
}

#[test]
fn delete_session_cascades() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_session(None).unwrap();
    let keep = store.create_session(None).unwrap();
    store.append(a, Role::User, None, &text("gone")).unwrap();
    store.append(keep, Role::User, None, &text("kept")).unwrap();
    store.delete_session(a).unwrap();
    let left: i64 = store
        .transaction(|tx| Ok(tx.query_row("SELECT count(*) FROM messages", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(left, 1);
    assert_eq!(store.sessions().unwrap().len(), 1);
    assert_eq!(store.history(keep, None).unwrap().len(), 1);
}

#[test]
fn kv_and_settings() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.kv_get("_core", "k").unwrap(), None);
    store.kv_set("_core", "k", &json!({"a": [1, 2]})).unwrap();
    assert_eq!(
        store.kv_get("_core", "k").unwrap(),
        Some(json!({"a": [1, 2]}))
    );
    store.kv_set("_core", "k", &json!("two")).unwrap();
    assert_eq!(store.kv_get("_core", "k").unwrap(), Some(json!("two")));
    assert_eq!(store.kv_get("other", "k").unwrap(), None);
    store.kv_delete("_core", "k").unwrap();
    assert_eq!(store.kv_get("_core", "k").unwrap(), None);

    store.set_setting("x", "a", &json!(1)).unwrap();
    store.set_setting("x", "b", &json!(true)).unwrap();
    store.set_setting("y", "a", &json!("not x")).unwrap();
    store.set_setting("x", "a", &json!(2)).unwrap();
    let x = store.settings("x").unwrap();
    assert_eq!(serde_json::Value::Object(x), json!({"a": 2, "b": true}));
    assert!(store.settings("z").unwrap().is_empty());
}

#[test]
fn ledger_rows() {
    let store = Store::open_in_memory().unwrap();
    let at: Ms = 1_700_000_000_123;
    store.record_request("p", at).unwrap();
    store.record_request("p", at + 1_000).unwrap();
    let count = |span: &str, bucket: i64| -> i64 {
        store
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT count FROM provider_usage WHERE provider = 'p' AND span = ? AND bucket = ?",
                    rusqlite::params![span, bucket],
                    |r| r.get(0),
                )?)
            })
            .unwrap()
    };
    assert_eq!(count("minute", at / 60_000), 2);
    assert_eq!(count("day", at / 86_400_000), 2);

    store
        .record_usage(&Usage {
            at,
            session: Some(SessionId(7)),
            plugin: Some("pl".into()),
            model: "m".into(),
            asked: Some("auto".into()),
            provider: "p".into(),
            tokens_in: 10,
            tokens_out: 20,
            cost: 0.5,
            run_id: Some("r1".into()),
            writing_ms: Some(1234),
        })
        .unwrap();
    store
        .record_try(&Try {
            at,
            provider: "p".into(),
            model: "m".into(),
            outcome: "ok".into(),
            status: 200,
            source: "chat".into(),
            waited_ms: Some(321),
        })
        .unwrap();

    store
        .transaction(|tx| {
            let u = tx.query_row(
                "SELECT at, session_id, plugin, model, provider, tokens_in, tokens_out, cost, run_id, asked, writing FROM usage",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, f64>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, Option<String>>(9)?,
                        r.get::<_, Option<i64>>(10)?,
                    ))
                },
            )?;
            assert_eq!(
                u,
                (
                    at,
                    Some(7),
                    Some("pl".into()),
                    "m".into(),
                    "p".into(),
                    10,
                    20,
                    0.5,
                    Some("r1".into()),
                    Some("auto".into()),
                    Some(1234)
                )
            );
            let t = tx.query_row(
                "SELECT at, provider, model, outcome, status, source, waited FROM tries",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                    ))
                },
            )?;
            assert_eq!(
                t,
                (at, "p".into(), "m".into(), "ok".into(), 200, "chat".into(), Some(321))
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn sqlite_vec_is_available() {
    let store = Store::open_in_memory().unwrap();
    let nearest: Vec<i64> = store
        .transaction(|tx| {
            tx.execute_batch(
                "CREATE VIRTUAL TABLE t USING vec0(v float[3]);
                 INSERT INTO t (rowid, v) VALUES (1, '[10, 10, 10]'), (2, '[1, 1, 1]');",
            )?;
            let mut stmt = tx.prepare(
                "SELECT rowid FROM t WHERE v MATCH '[0, 0, 0]' ORDER BY distance LIMIT 2",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .unwrap();
    assert_eq!(nearest, [2, 1]);
}

#[test]
fn transaction_rolls_back_on_error() {
    let store = Store::open_in_memory().unwrap();
    let out: Result<()> = store.transaction(|tx| {
        tx.execute(
            "INSERT INTO kv (ns, key, value) VALUES ('_core', 'k', '1')",
            [],
        )?;
        Err(Error::Invalid("stop".into()))
    });
    assert!(matches!(out, Err(Error::Invalid(_))));
    assert_eq!(store.kv_get("_core", "k").unwrap(), None);
}
