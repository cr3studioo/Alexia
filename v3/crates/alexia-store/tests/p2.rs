// SPDX-License-Identifier: AGPL-3.0-only
//! Migration 3: the run trace, audit log, live runs, approvals and jobs.
mod scratch;

use alexia_store::*;
use rusqlite::Connection;
use scratch::Scratch;
use serde_json::json;

/// A fresh, empty folder per test, removed when the test ends.
fn temp(name: &str) -> Scratch {
    Scratch::new(&format!("p2-{name}"))
}

fn user_version(s: &Store) -> i64 {
    s.transaction(|tx| Ok(tx.query_row("PRAGMA user_version", [], |r| r.get(0))?))
        .unwrap()
}

fn row(at: Ms, run: &str, session: Option<SessionId>, tool: &str) -> AuditRow {
    AuditRow {
        id: 0,
        at,
        run: run.into(),
        session,
        origin: r#"{"channel":"desktop"}"#.into(),
        step: 1,
        tool: tool.into(),
        plugin: Some("files".into()),
        args: r#"{"path":"notes.txt"}"#.into(),
        gate: "run".into(),
        decision: "ran".into(),
        why: None,
        ok: Some(true),
        result: Some("wrote 12 bytes".into()),
        undo: None,
        undone_at: None,
    }
}

fn live(run: &str, session: SessionId, started_at: Ms) -> LiveRunRow {
    LiveRunRow {
        run: run.into(),
        session,
        origin: r#"{"channel":"telegram"}"#.into(),
        started_at,
        touched_at: started_at,
        steps: 0,
        background: false,
        parent: None,
    }
}

#[test]
fn upgrade_from_2_keeps_rows() {
    let dir = temp("upgrade");
    let db = dir.join("alexia.db");
    // A real version-2 file: today's schema with migration 3 taken back off.
    let (session, chat) = {
        let s = Store::open(&db).unwrap();
        let id = s.create_session(Some("kept")).unwrap();
        s.save_run("r1", 10, &json!({ "steps": 1 })).unwrap();
        (id, s.channel_session("telegram", "42").unwrap())
    };
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "DROP TABLE audit; DROP TABLE live_runs; DROP TABLE approvals; \
             DROP TABLE job_runs; DROP TABLE jobs; PRAGMA user_version = 2;",
        )
        .unwrap();
    let s = Store::open(&db).unwrap();
    assert_eq!(user_version(&s), 3);
    let titles: Vec<_> = s.sessions().unwrap().into_iter().map(|x| x.id).collect();
    assert!(titles.contains(&session) && titles.contains(&chat));
    assert_eq!(s.channel_session("telegram", "42").unwrap(), chat);
    assert_eq!(s.run_body("r1").unwrap(), Some(json!({ "steps": 1 })));
    // The new tables are there and usable.
    assert!(s.audit(&row(1, "r1", Some(session), "t")).unwrap() > 0);
    assert!(s.jobs().unwrap().is_empty());
}

#[test]
fn runs_round_trip_and_upsert() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.run_body("nope").unwrap(), None);
    s.save_run("a", 10, &json!({ "v": 1 })).unwrap();
    s.save_run("b", 20, &json!({ "v": 2 })).unwrap();
    s.save_run("a", 30, &json!({ "v": 3 })).unwrap();
    assert_eq!(s.run_body("a").unwrap(), Some(json!({ "v": 3 })));
    let all = s.runs(10).unwrap();
    assert_eq!(
        all,
        vec![
            ("a".to_string(), 30, json!({ "v": 3 })),
            ("b".to_string(), 20, json!({ "v": 2 })),
        ]
    );
    assert_eq!(s.runs(1).unwrap().len(), 1);
}

#[test]
fn prune_runs_keeps_newest_and_recent() {
    let s = Store::open_in_memory().unwrap();
    for i in 0..10 {
        s.save_run(&format!("r{i}"), 100 + i, &json!(i)).unwrap();
    }
    // Keep the newest 4; nothing is older than 0.
    assert_eq!(s.prune_runs(0, 4).unwrap(), 6);
    let ids: Vec<_> = s.runs(100).unwrap().into_iter().map(|r| r.0).collect();
    assert_eq!(ids, ["r9", "r8", "r7", "r6"]);
    // Age wins too: older than 108 goes even within `keep`.
    assert_eq!(s.prune_runs(108, 200).unwrap(), 2);
    let ids: Vec<_> = s.runs(100).unwrap().into_iter().map(|r| r.0).collect();
    assert_eq!(ids, ["r9", "r8"]);
}

#[test]
fn audit_round_trip() {
    let s = Store::open_in_memory().unwrap();
    let mut a = row(5, "run-1", Some(SessionId(7)), "files.write");
    a.id = 999; // ignored
    a.why = Some("asked".into());
    a.undo = Some(r#"{"tool":"files.delete"}"#.into());
    a.ok = None;
    let id = s.audit(&a).unwrap();
    assert_ne!(id, 999);
    let b = row(6, "run-1", None, "web.fetch");
    let id_b = s.audit(&b).unwrap();
    s.audit(&row(7, "run-2", None, "other")).unwrap();

    let got = s.audit_for_run("run-1").unwrap();
    assert_eq!(got, vec![AuditRow { id, ..a }, AuditRow { id: id_b, ..b }]);
    assert!(s.audit_for_run("missing").unwrap().is_empty());
}

#[test]
fn audit_search_by_tool_and_result() {
    let s = Store::open_in_memory().unwrap();
    let tools = |v: Vec<AuditRow>| v.into_iter().map(|r| r.tool).collect::<Vec<_>>();
    let mut x = row(1, "r", None, "calendar.add");
    x.result = Some("booked dentist".into());
    s.audit(&x).unwrap();
    let mut y = row(2, "r", None, "mail.send");
    y.result = Some("sent to the dentist".into());
    s.audit(&y).unwrap();
    let mut z = row(3, "r", None, "files.read");
    z.why = Some("blocked by the owner's rule".into());
    s.audit(&z).unwrap();
    assert_eq!(
        tools(s.audit_search("owner's rule", 10).unwrap()),
        ["files.read"]
    );

    assert_eq!(
        tools(s.audit_search("calendar", 10).unwrap()),
        ["calendar.add"]
    );
    // By result text, newest first.
    assert_eq!(
        tools(s.audit_search("dentist", 10).unwrap()),
        ["mail.send", "calendar.add"]
    );
    assert_eq!(s.audit_search("dentist", 1).unwrap().len(), 1);
    // By args and why.
    assert_eq!(s.audit_search("notes.txt", 10).unwrap().len(), 3);
    // LIKE wildcards in the query are literal.
    assert!(s.audit_search("%", 10).unwrap().is_empty());
    assert!(s.audit_search("mail_send", 10).unwrap().is_empty());
}

#[test]
fn last_undoable_skips_undone_and_other_sessions() {
    let s = Store::open_in_memory().unwrap();
    let (me, other) = (SessionId(1), SessionId(2));
    let undoable = |at, session| {
        let mut r = row(at, "r", Some(session), "files.write");
        r.undo = Some(format!(r#"{{"at":{at}}}"#));
        r
    };
    assert_eq!(s.last_undoable(me).unwrap(), None);
    let old = s.audit(&undoable(1, me)).unwrap();
    let newer = s.audit(&undoable(2, me)).unwrap();
    s.audit(&row(3, "r", Some(me), "no-undo")).unwrap();
    s.audit(&undoable(4, other)).unwrap();

    assert_eq!(s.last_undoable(me).unwrap().unwrap().id, newer);
    s.mark_undone(newer, 50).unwrap();
    let r = s.audit_for_run("r").unwrap();
    assert_eq!(
        r.iter().find(|r| r.id == newer).unwrap().undone_at,
        Some(50)
    );
    assert_eq!(s.last_undoable(me).unwrap().unwrap().id, old);
    s.mark_undone(old, 51).unwrap();
    assert_eq!(s.last_undoable(me).unwrap(), None);
    assert_eq!(s.last_undoable(other).unwrap().unwrap().at, 4);
}

#[test]
fn live_runs_round_trip() {
    let s = Store::open_in_memory().unwrap();
    let id = s.create_session(None).unwrap();
    let mut b = live("b", id, 20);
    b.background = true;
    b.parent = Some("a".into());
    s.live_begin(&b).unwrap();
    s.live_begin(&live("a", id, 10)).unwrap();
    assert!(s.live_touch("a", 3, 15).unwrap());

    let got = s.live_runs().unwrap();
    let mut a = live("a", id, 10);
    a.steps = 3;
    a.touched_at = 15;
    assert_eq!(got, vec![a, b]);
    s.live_end("a").unwrap();
    assert_eq!(s.live_runs().unwrap().len(), 1);
    // A live run must belong to a real session.
    assert!(s.live_begin(&live("c", SessionId(9999), 1)).is_err());
}

#[test]
fn live_touch_reports_no_row() {
    let s = Store::open_in_memory().unwrap();
    let id = s.create_session(None).unwrap();
    assert!(!s.live_touch("ghost", 1, 5).unwrap());
    s.live_begin(&live("a", id, 10)).unwrap();
    assert!(!s.live_touch("ghost", 1, 5).unwrap());
    assert!(s.live_touch("a", 2, 12).unwrap());
    s.live_end("a").unwrap();
    assert!(!s.live_touch("a", 3, 15).unwrap());
    assert!(s.live_runs().unwrap().is_empty());
}

#[test]
fn deleting_session_cascades_live_runs_not_audit() {
    let s = Store::open_in_memory().unwrap();
    let gone = s.create_session(None).unwrap();
    let kept = s.create_session(None).unwrap();
    s.live_begin(&live("x", gone, 1)).unwrap();
    s.live_begin(&live("y", kept, 2)).unwrap();
    s.audit(&row(1, "x", Some(gone), "t")).unwrap();
    s.delete_session(gone).unwrap();
    let left: Vec<_> = s.live_runs().unwrap().into_iter().map(|r| r.run).collect();
    assert_eq!(left, ["y"]);
    // The audit log outlives the conversation.
    assert_eq!(s.audit_for_run("x").unwrap().len(), 1);
}

#[test]
fn approvals_round_trip_and_first_answer_wins() {
    let s = Store::open_in_memory().unwrap();
    let a = s
        .approval_open("r1", "{}", "Send the mail?", Some("to: bob"), 10)
        .unwrap();
    let b = s.approval_open("r2", "{}", "Delete it?", None, 11).unwrap();
    assert_eq!(
        s.approval(a).unwrap(),
        Some(ApprovalRow {
            id: a,
            run: "r1".into(),
            origin: "{}".into(),
            text: "Send the mail?".into(),
            detail: Some("to: bob".into()),
            asked_at: 10,
            answered_at: None,
            answer: None,
            via: None,
        })
    );
    let pending: Vec<_> = s
        .approvals_pending()
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(pending, [a, b]);

    assert!(s.approval_answer(a, true, "telegram", 20).unwrap());
    assert!(!s.approval_answer(a, false, "desktop", 21).unwrap());
    let got = s.approval(a).unwrap().unwrap();
    assert_eq!(
        (got.answer, got.answered_at, got.via.as_deref()),
        (Some(true), Some(20), Some("telegram"))
    );
    let pending: Vec<_> = s
        .approvals_pending()
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(pending, [b]);
    assert!(!s.approval_answer(12345, true, "desktop", 22).unwrap());
    assert_eq!(s.approval(12345).unwrap(), None);
}

#[test]
fn jobs_round_trip() {
    let s = Store::open_in_memory().unwrap();
    let a = s
        .job_add(
            r#"{"every":"1d"}"#,
            "water the plants",
            "low",
            "{}",
            Some(100),
            1,
        )
        .unwrap();
    let b = s
        .job_add(r#"{"at":5}"#, "call mum", "high", "{}", None, 2)
        .unwrap();
    s.job_set_next(b, Some(500)).unwrap();
    assert_eq!(
        s.jobs().unwrap(),
        vec![
            JobRow {
                id: a,
                trigger: r#"{"every":"1d"}"#.into(),
                prompt: "water the plants".into(),
                urgency: "low".into(),
                origin: "{}".into(),
                created_at: 1,
                next_at: Some(100),
                cancelled_at: None,
            },
            JobRow {
                id: b,
                trigger: r#"{"at":5}"#.into(),
                prompt: "call mum".into(),
                urgency: "high".into(),
                origin: "{}".into(),
                created_at: 2,
                next_at: Some(500),
                cancelled_at: None,
            },
        ]
    );
    s.job_set_next(a, None).unwrap();
    assert_eq!(s.jobs().unwrap()[0].next_at, None);

    s.job_ran(a, 100, Some("run-9"), "ok").unwrap();
    s.job_ran(a, 200, None, "skipped").unwrap();
    let runs: Vec<(i64, Ms, Option<String>, String)> = s
        .transaction(|tx| {
            let mut st =
                tx.prepare("SELECT job_id, at, run_id, outcome FROM job_runs ORDER BY id")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .unwrap();
    assert_eq!(
        runs,
        vec![
            (a, 100, Some("run-9".into()), "ok".into()),
            (a, 200, None, "skipped".into())
        ]
    );
    assert!(
        s.job_ran(9999, 1, None, "ok").is_err(),
        "job_runs needs a real job"
    );

    assert!(s.job_cancel(a, 300).unwrap());
    assert!(!s.job_cancel(a, 301).unwrap());
    assert!(!s.job_cancel(9999, 301).unwrap());
    let left: Vec<_> = s.jobs().unwrap().into_iter().map(|j| j.id).collect();
    assert_eq!(left, [b]);
}
