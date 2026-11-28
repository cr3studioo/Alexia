// SPDX-License-Identifier: AGPL-3.0-only
//! P3-04: migration 4, the notices queue, the owner's mutes, and what she did on her own.
mod scratch;

use alexia_store::*;
use rusqlite::Connection;
use scratch::Scratch;

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
        )?)
    })
    .unwrap()
        == 1
}

fn n<'a>(key: &'a str, text: &'a str, urgency: &'a str) -> NewNotice<'a> {
    NewNotice {
        key,
        source: "test.source",
        text,
        why: "Because.",
        urgency,
        due_at: None,
        not_before: None,
    }
}

#[test]
fn migrates_to_4() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(user_version(&s), 5);
    assert!(has_table(&s, "notices") && has_table(&s, "mutes"));

    // A real version-3 file: today's schema with migration 4 taken back off.
    let dir = Scratch::new("notices-upgrade");
    let db = dir.join("alexia.db");
    let session = {
        let s = Store::open(&db).unwrap();
        s.audit(&audit(7, r#"{"kind":"window"}"#, "run")).unwrap();
        s.create_session(Some("kept")).unwrap()
    };
    Connection::open(&db)
        .unwrap()
        .execute_batch("DROP TABLE devices; DROP TABLE fallback_sync; DROP TABLE guests; DROP TABLE notices; DROP TABLE mutes; PRAGMA user_version = 3;")
        .unwrap();
    let s = Store::open(&db).unwrap();
    assert_eq!(user_version(&s), 5);
    assert!(s.sessions().unwrap().iter().any(|x| x.id == session));
    assert_eq!(s.audit_for_run("r7").unwrap().len(), 1);
    assert!(s.notice_upsert(&n("k", "t", "low"), 1).unwrap().1);
}

#[test]
fn upsert_dedupes_live_rows() {
    let s = Store::open_in_memory().unwrap();
    let (a, created) = s.notice_upsert(&n("c:1", "first", "normal"), 10).unwrap();
    assert!(created);
    let (b, created) = s.notice_upsert(&n("c:1", "second", "normal"), 20).unwrap();
    assert!(!created);
    assert_eq!(a, b);
    let live = s.notices_live().unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].text, "second");
    assert_eq!(live[0].created_at, 10);
    assert_eq!(live[0].updated_at, 20);
    assert_eq!(live[0].state, "new");
}

#[test]
fn upsert_never_lowers_urgency() {
    let s = Store::open_in_memory().unwrap();
    let (id, _) = s.notice_upsert(&n("c:1", "t", "high"), 1).unwrap();
    s.notice_upsert(&n("c:1", "t", "low"), 2).unwrap();
    assert_eq!(s.notice(id).unwrap().unwrap().urgency, "high");
    s.notice_upsert(&n("c:1", "t", "urgent"), 3).unwrap();
    assert_eq!(s.notice(id).unwrap().unwrap().urgency, "urgent");
}

#[test]
fn done_row_lets_a_new_one_live() {
    let s = Store::open_in_memory().unwrap();
    let (a, _) = s.notice_upsert(&n("c:1", "t", "low"), 1).unwrap();
    assert!(s.notice_set(a, "done", None, 2).unwrap());
    let (b, created) = s.notice_upsert(&n("c:1", "t", "low"), 3).unwrap();
    assert!(created);
    assert_ne!(a, b);
    assert_eq!(s.notices_live().unwrap().len(), 1);
    assert_eq!(s.notice(a).unwrap().unwrap().state, "done");
}

#[test]
fn invalid_urgency_refused() {
    let s = Store::open_in_memory().unwrap();
    assert!(matches!(
        s.notice_upsert(&n("c:1", "t", "loud"), 1),
        Err(Error::Invalid(_))
    ));
    assert!(s.notices_live().unwrap().is_empty());
}

#[test]
fn invalid_state_refused() {
    let s = Store::open_in_memory().unwrap();
    let (id, _) = s.notice_upsert(&n("c:1", "t", "low"), 1).unwrap();
    assert!(matches!(
        s.notice_set(id, "forgotten", None, 2),
        Err(Error::Invalid(_))
    ));
    assert!(!s.notice_set(id + 100, "done", None, 2).unwrap());
}

#[test]
fn said_counts_and_records_via() {
    let s = Store::open_in_memory().unwrap();
    let (id, _) = s.notice_upsert(&n("c:1", "t", "low"), 1).unwrap();
    s.notice_said(id, r#"{"kind":"window"}"#, 5).unwrap();
    s.notice_said(id, "telegram", 9).unwrap();
    let row = s.notice(id).unwrap().unwrap();
    assert_eq!(row.state, "said");
    assert_eq!(row.times_said, 2);
    assert_eq!(row.said_at, Some(9));
    assert_eq!(row.said_via.as_deref(), Some("telegram"));
    // Still live: said is not finished.
    assert_eq!(s.notices_live().unwrap().len(), 1);
}

#[test]
fn seen_records_feedback() {
    let s = Store::open_in_memory().unwrap();
    let (id, _) = s.notice_upsert(&n("c:1", "t", "low"), 1).unwrap();
    assert!(s.notice_seen(id, None, 4).unwrap());
    assert!(s.notice_seen(id, Some("not_useful"), 6).unwrap());
    let row = s.notice(id).unwrap().unwrap();
    assert_eq!(row.seen_at, Some(4));
    assert_eq!(row.feedback.as_deref(), Some("not_useful"));
    assert!(matches!(
        s.notice_seen(id, Some("meh"), 7),
        Err(Error::Invalid(_))
    ));
    let since = s.notices_since(0, 10).unwrap();
    assert_eq!(since.len(), 1);
}

#[test]
fn mutes_expire() {
    let s = Store::open_in_memory().unwrap();
    let forever = s.mute_add("test.source", None, None, 1).unwrap();
    s.mute_add("test.source", Some("gym"), Some(100), 1)
        .unwrap();
    assert_eq!(s.mutes(50).unwrap().len(), 2);
    let now: Vec<i64> = s.mutes(200).unwrap().iter().map(|m| m.id).collect();
    assert_eq!(now, [forever]);
    assert!(s.mute_remove(forever).unwrap());
    assert!(!s.mute_remove(forever).unwrap());
    assert!(s.mutes(200).unwrap().is_empty());
}

fn audit(at: Ms, origin: &str, decision: &str) -> AuditRow {
    AuditRow {
        id: 0,
        at,
        run: format!("r{at}"),
        session: None,
        origin: origin.into(),
        step: 1,
        tool: "fixture__note".into(),
        plugin: None,
        args: "{}".into(),
        gate: "run".into(),
        decision: decision.into(),
        why: None,
        ok: Some(true),
        result: None,
        undo: None,
        undone_at: None,
    }
}

#[test]
fn audit_scheduled_since_only_scheduler_ran() {
    let s = Store::open_in_memory().unwrap();
    let sched = r#"{"kind":"scheduler","job":3}"#;
    let window = r#"{"kind":"window"}"#;
    s.audit(&audit(10, sched, "run")).unwrap();
    s.audit(&audit(11, sched, "denied")).unwrap();
    s.audit(&audit(12, window, "run")).unwrap();
    s.audit(&audit(13, sched, "approved")).unwrap();
    s.audit(&audit(14, sched, "blocked")).unwrap();
    s.audit(&audit(15, sched, "ran")).unwrap();
    s.audit(&audit(16, window, "ran")).unwrap();
    s.audit(&audit(5, sched, "run")).unwrap();
    let got: Vec<Ms> = s
        .audit_scheduled_since(10)
        .unwrap()
        .iter()
        .map(|r| r.at)
        .collect();
    // The agent records a call that went ahead as "run" (or "approved" after a question); undo
    // records "ran". Window rows, refusals and rows before `at` are not hers.
    assert_eq!(got, [10, 13, 15]);
}
