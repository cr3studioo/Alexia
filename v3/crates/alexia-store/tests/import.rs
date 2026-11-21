// SPDX-License-Identifier: AGPL-3.0-only
//! The v2 importer, against v2 files built from the fixture of v2's own migrations.
mod scratch;

use std::fs;
use std::path::{Path, PathBuf};

use alexia_store::import::{import_v2, import_v2_files, ImportReport};
use alexia_store::*;
use rusqlite::Connection;
use scratch::Scratch;
use serde_json::json;

const V2_MIGRATIONS: &str = include_str!("fixtures/v2_migrations.sql");

/// A fresh, empty folder per test, removed when the test ends.
fn temp(name: &str) -> Scratch {
    Scratch::new(&format!("import-{name}"))
}

/// v2's schema up to and including migration `upto`, as v2 opens it (WAL).
fn v2_db(root: &Path, upto: usize) -> Connection {
    fs::create_dir_all(root).unwrap();
    let conn = Connection::open(root.join("alexia.db")).unwrap();
    let _: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .unwrap();
    let marker = format!("PRAGMA user_version = {upto};");
    let end = V2_MIGRATIONS.find(&marker).unwrap() + marker.len();
    conn.execute_batch(&V2_MIGRATIONS[..end]).unwrap();
    conn
}

/// A v3 store and its layout in `root`.
fn v3(root: &Path) -> (Store, Layout) {
    (
        Store::open(&root.join("alexia.db")).unwrap(),
        Layout::new(root.to_path_buf()),
    )
}

fn count(conn: &Connection, table: &str) -> u64 {
    conn.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap() as u64
}

fn refusal(r: Result<ImportReport>) -> String {
    match r {
        Err(Error::Refused(s)) => s,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

const ALREADY: &str = "This hub already has conversations, so v2 data was not imported over them.";

/// The v2 file `imports_a_full_v2_file` describes.
fn full_v2(root: &Path) -> Connection {
    let c = v2_db(root, 11);
    c.execute_batch(
        r#"
INSERT INTO sessions (id, title, created_at, updated_at, image_ordinal) VALUES
  (1, 'First', 10, 20, 0), (2, 'Second', 30, 40, 1);
INSERT INTO messages (id, session_id, role, model, body, at) VALUES
  (1, 1, 'user', NULL, '{"content":"hello"}', 11),
  (2, 1, 'assistant', 'm1', '{"content":"","calls":[{"id":"c1","name":"recall","arguments":"{}"}]}', 12),
  (3, 1, 'tool', NULL, '{"content":"found","callId":"c1"}', 13),
  (4, 1, 'assistant', 'm1', '{"content":[{"type":"text","text":"done"}]}', 14),
  (5, 2, 'user', NULL, '{"content":[{"type":"text","text":"pic"},{"type":"image","url":"data:image/png;base64,AA=="}],"later":{"a":1}}', 31);
INSERT INTO kv (ns, key, value) VALUES ('_core', 'mode', '"auto"'), ('memory', 'last', '1');
INSERT INTO settings (plugin, key, value) VALUES ('_core', 'display_name', '"V"'), ('memory', 'depth', '3');
INSERT INTO provider_usage VALUES ('groq', 'day', 5, 7);
INSERT INTO usage (at, session_id, plugin, model, provider, tokens_in, tokens_out, cost, run_id, asked, writing)
  VALUES (12, 1, NULL, 'm1', 'groq', 10, 20, 0.5, 'r1', 'm1', 300);
INSERT INTO tries VALUES (12, 'groq', 'm1', 'ok', 200, 'chat', 40);
INSERT INTO seen VALUES ('groq', 'm1', 1, 1, NULL);
INSERT INTO runs VALUES ('r1', 12, '{"steps":[]}');
INSERT INTO attachments VALUES ('a1', 2, 1, 'image_1', 'p.png', 'image/png', 1, 1, 9, 'ff', '2/a1.png', 'upload', 'ready', 31);
INSERT INTO attachment_leases VALUES ('l1', 2, '["a1"]', 'live', 32);
CREATE TABLE IF NOT EXISTS p_memory_notes (rowid INTEGER PRIMARY KEY);
ALTER TABLE p_memory_notes ADD COLUMN text TEXT;
INSERT INTO p_memory_notes (text) VALUES ('likes tea'), ('lives in Prague'), ('has a cat');
"#,
    )
    .unwrap();
    c
}

#[test]
fn imports_a_full_v2_file() {
    let dir = temp("full");
    drop(full_v2(&dir.join("v2")));
    let (store, layout) = v3(&dir.join("v3"));
    let report = import_v2(&store, &dir.join("v2"), &layout).unwrap();
    assert_eq!(report.v2_schema, 11);

    let v2 = Connection::open(dir.join("v2").join("alexia.db")).unwrap();
    let main = Connection::open(layout.db()).unwrap();
    let tables: Vec<&str> = report.rows.iter().map(|(t, _)| t.as_str()).collect();
    for t in [
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
        "p_memory_notes",
    ] {
        assert!(tables.contains(&t), "{t} missing from {:?}", report.rows);
    }
    for (t, n) in &report.rows {
        assert_eq!(*n, count(&v2, t), "v2 {t}");
        // kv also holds the tables record the importer adds.
        let extra = u64::from(t == "kv");
        assert_eq!(count(&main, t), n + extra, "v3 {t}");
    }
    assert_eq!(count(&main, "messages"), 5);
    assert_eq!(count(&main, "p_memory_notes"), 3);
    assert_eq!(count(&main, "attachment_leases"), 0);
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);

    let body = |c: &Connection| -> String {
        c.query_row("SELECT body FROM messages WHERE id = 5", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(body(&main), body(&v2));

    let history = store.history(SessionId(1), None).unwrap();
    let ids: Vec<i64> = history.iter().map(|m| m.id.0).collect();
    assert_eq!(ids, [1, 2, 3, 4]);
    let roles: Vec<Role> = history.iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        [Role::User, Role::Assistant, Role::Tool, Role::Assistant]
    );
    assert_eq!(history[0].body.content, Content::Text("hello".into()));
    assert_eq!(history[1].body.calls.as_ref().unwrap()[0].name, "recall");
    assert_eq!(history[2].body.call_id.as_deref(), Some("c1"));
    assert_eq!(history[1].model.as_deref(), Some("m1"));

    let notes = store.select("memory", "notes", &Select::default()).unwrap();
    let texts: Vec<&str> = notes.iter().map(|r| r["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["likes tea", "lives in Prague", "has a cat"]);
    assert_eq!(
        store.kv_get("_core", "tables:memory").unwrap(),
        Some(json!(["notes"]))
    );
    assert_eq!(store.kv_get("_core", "mode").unwrap(), Some(json!("auto")));
    assert_eq!(store.settings("memory").unwrap()["depth"], json!(3));

    let saved: String = main
        .query_row("SELECT report FROM imports", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<ImportReport>(&saved).unwrap(),
        report
    );
}

#[test]
fn imports_an_old_v2_file() {
    let dir = temp("old");
    let c = v2_db(&dir.join("v2"), 4);
    c.execute_batch(
        "INSERT INTO sessions VALUES (1, 't', 1, 2);
         INSERT INTO messages VALUES (1, 1, 'user', NULL, '{\"content\":\"hi\"}', 1);
         INSERT INTO usage (at, session_id, plugin, model, provider, tokens_in, tokens_out, cost)
           VALUES (1, 1, NULL, 'm', 'p', 1, 2, 0.0);",
    )
    .unwrap();
    drop(c);
    let (store, layout) = v3(&dir.join("v3"));
    let report = import_v2(&store, &dir.join("v2"), &layout).unwrap();
    assert_eq!(report.v2_schema, 4);

    let main = Connection::open(layout.db()).unwrap();
    let ordinal: i64 = main
        .query_row("SELECT image_ordinal FROM sessions WHERE id = 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(ordinal, 0);
    let (run_id, asked, writing): (Option<String>, Option<String>, Option<i64>) = main
        .query_row("SELECT run_id, asked, writing FROM usage", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!((run_id, asked, writing), (None, None, None));
    assert_eq!(store.history(SessionId(1), None).unwrap().len(), 1);
}

#[test]
fn refuses_in_order() {
    let dir = temp("refuses");
    let (store, layout) = v3(&dir.join("v3"));

    let none = dir.join("none");
    fs::create_dir_all(&none).unwrap();
    assert_eq!(
        refusal(import_v2(&store, &none, &layout)),
        "There is no Alexia database in that folder."
    );

    let v3_file = dir.join("v3file");
    drop(Store::open(&v3_file.join("alexia.db")).unwrap());
    assert_eq!(
        refusal(import_v2(&store, &v3_file, &layout)),
        "That folder holds a v3 database, not a v2 one."
    );

    let empty = dir.join("empty");
    fs::create_dir_all(&empty).unwrap();
    drop(Connection::open(empty.join("alexia.db")).unwrap());
    assert_eq!(
        refusal(import_v2(&store, &empty, &layout)),
        "That database is empty."
    );

    let newer = dir.join("newer");
    v2_db(&newer, 11)
        .execute_batch("PRAGMA user_version = 12;")
        .unwrap();
    assert_eq!(
        refusal(import_v2(&store, &newer, &layout)),
        "This v2 data is from a newer Alexia than the importer knows."
    );

    let good = dir.join("good");
    drop(v2_db(&good, 11));
    store.create_session(Some("already here")).unwrap();
    assert_eq!(refusal(import_v2(&store, &good, &layout)), ALREADY);
}

#[test]
fn second_import_is_refused() {
    let dir = temp("twice");
    drop(full_v2(&dir.join("v2")));
    let (store, layout) = v3(&dir.join("v3"));
    import_v2(&store, &dir.join("v2"), &layout).unwrap();
    assert_eq!(
        refusal(import_v2(&store, &dir.join("v2"), &layout)),
        ALREADY
    );

    // An import with no sessions in it still counts.
    let dir = temp("twice-empty");
    drop(v2_db(&dir.join("v2"), 11));
    let (store, layout) = v3(&dir.join("v3"));
    import_v2(&store, &dir.join("v2"), &layout).unwrap();
    assert_eq!(
        refusal(import_v2(&store, &dir.join("v2"), &layout)),
        ALREADY
    );
}

#[test]
fn bad_body_is_copied_and_listed() {
    let dir = temp("badbody");
    let c = v2_db(&dir.join("v2"), 11);
    c.execute_batch(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (1, 't', 1, 2);
         INSERT INTO messages VALUES (7, 1, 'user', NULL, 'not json', 1);
         INSERT INTO messages VALUES (8, 1, 'user', NULL, '{\"content\":\"fine\"}', 2);",
    )
    .unwrap();
    drop(c);
    let (store, layout) = v3(&dir.join("v3"));
    let report = import_v2(&store, &dir.join("v2"), &layout).unwrap();

    let main = Connection::open(layout.db()).unwrap();
    let body: String = main
        .query_row("SELECT body FROM messages WHERE id = 7", [], |r| r.get(0))
        .unwrap();
    assert_eq!(body, "not json");
    let listed: Vec<&String> = report
        .skipped
        .iter()
        .filter(|s| s.starts_with("message "))
        .collect();
    assert_eq!(listed.len(), 1, "{:?}", report.skipped);
    assert!(listed[0].starts_with("message 7:"));
}

/// The four files `copies_files_not_moves` puts in v2.
fn v2_files(v2: &Path) -> [PathBuf; 4] {
    let files = [
        v2.join("plugins").join("memory").join("x.txt"),
        v2.join("skills").join("a").join("SKILL.md"),
        v2.join("uploads").join("1").join("p.png"),
        v2.join("cache").join("c"),
    ];
    for f in &files {
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, f.to_string_lossy().as_bytes()).unwrap();
    }
    files
}

#[test]
fn copies_files_not_moves() {
    let dir = temp("files");
    let v2 = dir.join("v2");
    drop(v2_db(&v2, 11));
    let files = v2_files(&v2);
    let (store, layout) = v3(&dir.join("v3"));
    let report = import_v2(&store, &v2, &layout).unwrap();
    assert_eq!(report.files, 3);

    for f in &files[..3] {
        let rel = f.strip_prefix(&v2).unwrap();
        assert!(f.exists(), "{} gone from v2", f.display());
        assert_eq!(
            fs::read(layout.root.join(rel)).unwrap(),
            fs::read(f).unwrap()
        );
    }
    assert!(layout.own_dir("memory").join("x.txt").exists());
    assert!(layout.skills().join("a").join("SKILL.md").exists());
    assert!(layout.uploads().join("1").join("p.png").exists());
    assert!(!layout.cache().exists());
    assert!(files[3].exists());
}

#[test]
fn files_only_repeats_the_copy() {
    let dir = temp("filesonly");
    let v2 = dir.join("v2");
    drop(v2_db(&v2, 11));
    v2_files(&v2);
    let (store, layout) = v3(&dir.join("v3"));
    import_v2(&store, &v2, &layout).unwrap();

    let skill = layout.skills().join("a").join("SKILL.md");
    fs::remove_file(&skill).unwrap();
    assert_eq!(import_v2_files(&v2, &layout).unwrap(), 1);
    assert!(skill.exists());
    // Nothing is copied over a file already there.
    assert_eq!(import_v2_files(&v2, &layout).unwrap(), 0);
}

#[test]
fn wal_is_checkpointed() {
    let dir = temp("wal");
    let live = dir.join("live");
    let writer = full_v2(&live);
    // A second connection held open stops the WAL being folded in when the writer closes.
    let held = Connection::open(live.join("alexia.db")).unwrap();
    let _: i64 = held
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .unwrap();

    let copy = dir.join("copy");
    fs::create_dir_all(&copy).unwrap();
    for f in ["alexia.db", "alexia.db-wal"] {
        fs::copy(live.join(f), copy.join(f)).unwrap();
    }
    assert!(fs::metadata(copy.join("alexia.db-wal")).unwrap().len() > 0);
    drop(writer);
    drop(held);

    let (store, layout) = v3(&dir.join("v3"));
    let report = import_v2(&store, &copy, &layout).unwrap();
    let rows: std::collections::BTreeMap<&str, u64> =
        report.rows.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    assert_eq!(rows["sessions"], 2);
    assert_eq!(rows["messages"], 5);
    assert_eq!(rows["p_memory_notes"], 3);
    assert_eq!(rows["attachments"], 1);
    assert_eq!(store.history(SessionId(2), None).unwrap().len(), 1);
}

#[test]
fn empty_hub_table_is_replaced() {
    let dir = temp("hub-empty");
    drop(full_v2(&dir.join("v2")));
    let (store, layout) = v3(&dir.join("v3"));
    // What a plugin start does on a fresh hub: the table exists, empty.
    store.create_tables("memory", &["notes".into()]).unwrap();
    let report = import_v2(&store, &dir.join("v2"), &layout).unwrap();

    let rows: std::collections::BTreeMap<&str, u64> =
        report.rows.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    assert_eq!(rows["p_memory_notes"], 3);
    let notes = store.select("memory", "notes", &Select::default()).unwrap();
    assert_eq!(notes.len(), 3);
    assert_eq!(notes[0]["text"], json!("likes tea"));
}

#[test]
fn filled_hub_table_is_refused() {
    let dir = temp("hub-filled");
    drop(full_v2(&dir.join("v2")));
    let (store, layout) = v3(&dir.join("v3"));
    store.create_tables("memory", &["notes".into()]).unwrap();
    let main = Connection::open(layout.db()).unwrap();
    main.execute_batch("INSERT INTO p_memory_notes DEFAULT VALUES")
        .unwrap();
    assert_eq!(
        refusal(import_v2(&store, &dir.join("v2"), &layout)),
        "This hub already has rows in a table named p_memory_notes, so v2 data was not \
         imported over them."
    );
    // All or nothing: the hub's row is still the only one, and nothing else came in.
    assert_eq!(count(&main, "p_memory_notes"), 1);
    assert_eq!(count(&main, "sessions"), 0);
    assert_eq!(count(&main, "imports"), 0);
}

#[test]
fn plugin_table_may_reference_a_later_one() {
    let dir = temp("fk");
    let c = v2_db(&dir.join("v2"), 11);
    c.execute_batch(
        "INSERT INTO kv (ns, key, value) VALUES ('memory', 'last', '1');
         CREATE TABLE p_memory_a (rowid INTEGER PRIMARY KEY, b INTEGER REFERENCES p_memory_b(rowid));
         CREATE TABLE p_memory_b (rowid INTEGER PRIMARY KEY, text TEXT);
         INSERT INTO p_memory_b VALUES (1, 'parent');
         INSERT INTO p_memory_a VALUES (1, 1);",
    )
    .unwrap();
    drop(c);
    let (store, layout) = v3(&dir.join("v3"));
    import_v2(&store, &dir.join("v2"), &layout).unwrap();

    let main = Connection::open(layout.db()).unwrap();
    let b: i64 = main
        .query_row("SELECT b FROM p_memory_a WHERE rowid = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(b, 1);
    assert_eq!(count(&main, "p_memory_b"), 1);
}
