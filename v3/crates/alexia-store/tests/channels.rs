// SPDX-License-Identifier: AGPL-3.0-only
//! Migration 2: channel chats, spans, and the router's read-back of tries and request counts.
mod scratch;

use std::path::Path;

use alexia_store::*;
use rusqlite::Connection;
use scratch::Scratch;

/// A fresh, empty folder per test, removed when the test ends.
fn temp(name: &str) -> Scratch {
    Scratch::new(&format!("channels-{name}"))
}

fn user_version(s: &Store) -> i64 {
    s.transaction(|tx| Ok(tx.query_row("PRAGMA user_version", [], |r| r.get(0))?))
        .unwrap()
}

fn has_table(s: &Store, name: &str) -> bool {
    s.transaction(|tx| {
        Ok(tx.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            [name],
            |r| r.get::<_, i64>(0),
        )? == 1)
    })
    .unwrap()
}

fn primaries(s: &Store, channel: &str) -> Vec<String> {
    s.transaction(|tx| {
        let mut st =
            tx.prepare("SELECT chat FROM channel_chats WHERE channel = ? AND is_primary = 1")?;
        let rows = st.query_map([channel], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })
    .unwrap()
}

fn span(turn: &str, at: Ms, name: &str, start: Ms) -> SpanRow {
    SpanRow {
        turn: turn.into(),
        at,
        origin: r#"{"channel":"telegram"}"#.into(),
        lane: "chat".into(),
        name: name.into(),
        start,
        ms: 7,
    }
}

fn a_try(at: Ms, model: &str) -> Try {
    Try {
        at,
        provider: "groq".into(),
        model: model.into(),
        outcome: "ok".into(),
        status: 200,
        source: "chat".into(),
        waited_ms: Some(120),
    }
}

#[test]
fn migration_2_applies() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(user_version(&s), 3);
    assert!(has_table(&s, "channel_chats"));
    assert!(has_table(&s, "spans"));
}

#[test]
fn upgrade_from_1() {
    let dir = temp("upgrade");
    let db = dir.join("alexia.db");
    // A real v1 file: migration 1's schema, with migrations 2 and 3 taken back off.
    {
        let s = Store::open(&db).unwrap();
        s.create_session(Some("kept")).unwrap();
    }
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "DROP TABLE channel_chats; DROP TABLE spans; DROP TABLE audit; DROP TABLE live_runs; \
             DROP TABLE approvals; DROP TABLE job_runs; DROP TABLE jobs; PRAGMA user_version = 1;",
        )
        .unwrap();
    let s = Store::open(&db).unwrap();
    assert_eq!(user_version(&s), 3);
    assert!(has_table(&s, "channel_chats") && has_table(&s, "spans"));
    let sessions = s.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].title.as_deref(), Some("kept"));
}

#[test]
fn channel_session_is_stable() {
    let s = Store::open_in_memory().unwrap();
    let a = s.channel_session("telegram", "100").unwrap();
    assert_eq!(s.channel_session("telegram", "100").unwrap(), a);
    let b = s.channel_session("telegram", "200").unwrap();
    assert_ne!(a, b);
    let titles: Vec<_> = s.sessions().unwrap().into_iter().map(|x| x.title).collect();
    assert_eq!(titles, [Some("telegram".into()), Some("telegram".into())]);
}

#[test]
fn first_chat_is_primary() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.primary_chat("telegram").unwrap(), None);
    s.channel_session("telegram", "100").unwrap();
    s.channel_session("telegram", "200").unwrap();
    s.channel_session("slack", "c1").unwrap();
    assert_eq!(s.primary_chat("telegram").unwrap().as_deref(), Some("100"));
    assert_eq!(primaries(&s, "telegram"), ["100"]);
    assert_eq!(primaries(&s, "slack"), ["c1"]);
}

#[test]
fn set_primary_moves_it() {
    let s = Store::open_in_memory().unwrap();
    s.channel_session("telegram", "100").unwrap();
    s.channel_session("telegram", "200").unwrap();
    s.set_primary_chat("telegram", "200").unwrap();
    assert_eq!(primaries(&s, "telegram"), ["200"]);
    assert_eq!(s.primary_chat("telegram").unwrap().as_deref(), Some("200"));
    // An unseen chat is refused and the primary stays where it was.
    assert!(matches!(
        s.set_primary_chat("telegram", "999"),
        Err(Error::Invalid(_))
    ));
    assert_eq!(primaries(&s, "telegram"), ["200"]);
}

#[test]
fn new_channel_session_replaces() {
    let s = Store::open_in_memory().unwrap();
    let old = s.channel_session("telegram", "100").unwrap();
    let new = s.new_channel_session("telegram", "100").unwrap();
    assert_ne!(old, new);
    assert_eq!(s.channel_session("telegram", "100").unwrap(), new);
    assert!(s.sessions().unwrap().iter().any(|x| x.id == old));
    // The chat stays the primary it was.
    assert_eq!(primaries(&s, "telegram"), ["100"]);
}

#[test]
fn spans_round_trip_and_order() {
    let s = Store::open_in_memory().unwrap();
    // Inserted out of order on purpose: turns by `at`, rows by `start`.
    let rows = vec![
        span("t3", 3000, "reply", 3050),
        span("t3", 3000, "route", 3010),
        span("t1", 1000, "route", 1010),
        span("t2", 2000, "reply", 2040),
        span("t2", 2000, "route", 2005),
    ];
    s.record_spans(&rows).unwrap();
    let got = s.last_turns(2).unwrap();
    assert_eq!(
        got,
        vec![
            span("t2", 2000, "route", 2005),
            span("t2", 2000, "reply", 2040),
            span("t3", 3000, "route", 3010),
            span("t3", 3000, "reply", 3050),
        ]
    );
    assert_eq!(s.last_turns(10).unwrap().len(), 5);
    assert!(s.last_turns(0).unwrap().is_empty());
}

#[test]
fn record_spans_is_one_transaction() {
    let s = Store::open_in_memory().unwrap();
    s.transaction(|tx| {
        tx.execute_batch(
            "CREATE TRIGGER no_bad BEFORE INSERT ON spans WHEN NEW.name = 'bad' \
             BEGIN SELECT RAISE(ABORT, 'bad'); END;",
        )?;
        Ok(())
    })
    .unwrap();
    let rows = [span("t1", 1, "ok", 1), span("t1", 1, "bad", 2)];
    assert!(s.record_spans(&rows).is_err());
    assert!(s.last_turns(10).unwrap().is_empty());
}

#[test]
fn prune_spans_deletes_old() {
    let s = Store::open_in_memory().unwrap();
    s.record_spans(&[
        span("old", 1000, "route", 1000),
        span("old", 1000, "reply", 1001),
        span("new", 5000, "route", 5000),
    ])
    .unwrap();
    assert_eq!(s.prune_spans(5000).unwrap(), 2);
    assert_eq!(
        s.last_turns(10).unwrap(),
        [span("new", 5000, "route", 5000)]
    );
    assert_eq!(s.prune_spans(5000).unwrap(), 0);
}

#[test]
fn tries_since_filters() {
    let s = Store::open_in_memory().unwrap();
    s.record_try(&a_try(900, "before")).unwrap();
    s.record_try(&a_try(1500, "later")).unwrap();
    s.record_try(&a_try(1000, "at")).unwrap();
    let got = s.tries_since(1000).unwrap();
    let models: Vec<_> = got.iter().map(|t| t.model.as_str()).collect();
    assert_eq!(models, ["at", "later"]);
    assert_eq!(
        got[0],
        TryRow {
            at: 1000,
            provider: "groq".into(),
            model: "at".into(),
            outcome: "ok".into(),
            status: 200,
            waited_ms: Some(120),
        }
    );
}

#[test]
fn request_count_reads_buckets() {
    let s = Store::open_in_memory().unwrap();
    let at: Ms = 1_700_000_000_000;
    for i in 0..3 {
        s.record_request("groq", at + i).unwrap();
    }
    assert_eq!(s.request_count("groq", "minute", at).unwrap(), 3);
    assert_eq!(s.request_count("groq", "day", at).unwrap(), 3);
    assert_eq!(s.request_count("other", "day", at).unwrap(), 0);
    let day = 24 * 60 * 60 * 1000;
    assert_eq!(s.request_count("groq", "day", at + day).unwrap(), 0);
    assert_eq!(s.request_count("groq", "minute", at + day).unwrap(), 0);
    assert!(matches!(
        s.request_count("groq", "hour", at),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn delete_session_cascades_channel_chat() {
    let s = Store::open_in_memory().unwrap();
    let id = s.channel_session("telegram", "100").unwrap();
    s.delete_session(id).unwrap();
    assert_eq!(s.primary_chat("telegram").unwrap(), None);
    let rows: i64 = s
        .transaction(|tx| Ok(tx.query_row("SELECT count(*) FROM channel_chats", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 0);
    // Seen again, the chat gets a live session and is the channel's primary again.
    let fresh = s.channel_session("telegram", "100").unwrap();
    assert!(s.sessions().unwrap().iter().any(|x| x.id == fresh));
    assert_eq!(primaries(&s, "telegram"), ["100"]);
}

#[test]
fn env_secret_wins() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    assert_eq!(
        secrets::env_name("_core", "telegram_bot_token"),
        "ALEXIA_SECRET__CORE_TELEGRAM_BOT_TOKEN"
    );
    assert_eq!(
        secrets::env_name("my-plugin", "key_2"),
        "ALEXIA_SECRET_MY_PLUGIN_KEY_2"
    );
    let var = secrets::env_name("_core", "provider_groq");
    assert_eq!(var, "ALEXIA_SECRET__CORE_PROVIDER_GROQ");

    secrets::set("_core", "provider_groq", "from-keychain").unwrap();
    std::env::set_var(&var, "from-env");
    assert_eq!(
        secrets::get("_core", "provider_groq").unwrap().as_deref(),
        Some("from-env")
    );
    // Empty counts as unset.
    std::env::set_var(&var, "");
    assert_eq!(
        secrets::get("_core", "provider_groq").unwrap().as_deref(),
        Some("from-keychain")
    );
    std::env::remove_var(&var);
    secrets::delete("_core", "provider_groq").unwrap();
}

// ---- db.rs follow-ups ----

#[test]
fn negative_user_version_is_refused() {
    let dir = temp("negative");
    let db = dir.join("alexia.db");
    drop(Store::open(&db).unwrap());
    Connection::open(&db)
        .unwrap()
        .pragma_update(None, "user_version", -1)
        .unwrap();
    match Store::open(&db) {
        Err(Error::Refused(m)) => assert!(m.contains("damaged"), "{m}"),
        other => panic!("expected Refused, got {:?}", other.map(|_| ())),
    }
}

#[test]
fn wal_not_taken_is_refused() {
    // SQLite opens ":memory:" as an in-memory database, whose journal mode stays "memory".
    match Store::open(Path::new(":memory:")) {
        Err(Error::Refused(m)) => assert!(m.contains("write-ahead"), "{m}"),
        other => panic!("expected Refused, got {:?}", other.map(|_| ())),
    }
}
