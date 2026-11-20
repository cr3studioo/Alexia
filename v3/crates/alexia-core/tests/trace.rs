// SPDX-License-Identifier: AGPL-3.0-only
//! Trace, runs and the audit log (P2-19). Fake secrets are built at run time.

use std::sync::Arc;

use alexia_core::bus::{Event, RunOutcome};
use alexia_core::trace::{activity, replay, Trace};
use alexia_core::{Bus, Origin, Phase, RunEnd, RunId, Step, ToolOutcome};
use alexia_store::{Ms, SessionId, Store};
use serde_json::{json, Value};

fn fake_key() -> String {
    format!("{}{}", "sk-or-v1-", "9f2a8c7b6d5e4f3a2b1c0d9e")
}

fn setup() -> (Arc<Store>, Bus, SessionId) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let session = store.create_session(Some("t")).unwrap();
    (store, Bus::new(64), session)
}

fn begin(store: &Arc<Store>, bus: &Bus, session: SessionId, run: &str) -> Trace {
    Trace::begin(
        store.clone(),
        bus.clone(),
        RunId(run.into()),
        session,
        Origin::Desktop,
        false,
        None,
    )
    .unwrap()
}

fn outcome(text: &str, ok: bool) -> ToolOutcome {
    ToolOutcome {
        text: text.into(),
        ok,
        files: vec![],
        final_text: None,
        undo: None,
        card: None,
    }
}

fn step(n: u32, name: &str, args: Value, out: Option<ToolOutcome>) -> Step {
    let Value::Object(args) = args else {
        panic!("args must be an object")
    };
    Step {
        n,
        name: name.into(),
        args,
        outcome: out,
    }
}

fn live(store: &Store) -> usize {
    store.live_runs().unwrap().len()
}

#[test]
fn one_audit_row_per_call() {
    let (store, bus, session) = setup();
    let t = begin(&store, &bus, session, "r1");
    for n in 1..=3 {
        let s = step(
            n,
            "files__read",
            json!({ "path": "a.txt" }),
            Some(outcome("ok", true)),
        );
        t.step(&s);
        t.audited(&s, Some("files"), "run", "ran", None).unwrap();
    }
    t.end(&RunEnd::Answered).unwrap();
    let rows = store.audit_for_run("r1").unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows.iter().map(|r| r.step).collect::<Vec<_>>(), [1, 2, 3]);
    assert!(rows.iter().all(|r| r.gate == "run" && r.ok == Some(true)));
}

#[test]
fn live_row_while_running_gone_after() {
    let (store, bus, session) = setup();
    let t = begin(&store, &bus, session, "r2");
    assert_eq!(live(&store), 1);
    t.step(&step(1, "x", json!({}), None));
    assert_eq!(store.live_runs().unwrap()[0].steps, 1);
    t.end(&RunEnd::Stopped).unwrap();
    assert_eq!(live(&store), 0);
    assert!(store.run_body("r2").unwrap().is_some());
}

/// Every text column of every table, as one string: the raw SELECT the spec asks for.
fn everything(store: &Store) -> String {
    store
        .transaction(|tx| {
            let tables: Vec<String> = {
                let mut q = tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
                let rows = q.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<_, _>>()?
            };
            let mut all = String::new();
            for t in tables {
                let cols: Vec<String> = {
                    let mut q =
                        tx.prepare(&format!("SELECT name FROM pragma_table_info('{t}')"))?;
                    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
                    rows.collect::<Result<_, _>>()?
                };
                if cols.is_empty() {
                    continue;
                }
                let cast: Vec<String> = cols
                    .iter()
                    .map(|c| format!("coalesce(CAST(\"{c}\" AS TEXT), '')"))
                    .collect();
                let sql = format!("SELECT {} FROM \"{t}\"", cast.join(" || ' ' || "));
                let Ok(mut q) = tx.prepare(&sql) else {
                    continue;
                };
                let Ok(rows) = q.query_map([], |r| r.get::<_, String>(0)) else {
                    continue;
                };
                for row in rows.flatten() {
                    all.push_str(&row);
                    all.push('\n');
                }
            }
            Ok(all)
        })
        .unwrap()
}

#[test]
fn secrets_never_written() {
    let (store, bus, session) = setup();
    let key = fake_key();
    let mut rx = bus.subscribe();
    let t = begin(&store, &bus, session, "r3");
    t.note(&format!("using {key}"));
    let s = step(
        1,
        "http__post",
        json!({ "auth": format!("Bearer {key}"), "nested": { "k": [key.clone()] } }),
        Some(outcome(&format!("echo {key} done"), true)),
    );
    t.step(&s);
    t.audited(&s, None, "run", "ran", Some(&format!("because {key}")))
        .unwrap();
    t.end(&RunEnd::Refused(format!("failed with {key}")))
        .unwrap();

    let dump = everything(&store);
    assert!(
        dump.contains("[redacted]"),
        "the dump should show redaction happened"
    );
    assert!(dump.contains("audit") || dump.contains("http__post"));
    assert!(!dump.contains(&key), "a key reached the database");
    assert!(!dump.contains("9f2a8c7b6d5e4f3a2b1c0d9e"));
    while let Ok(e) = rx.try_recv() {
        assert!(!format!("{e:?}").contains("9f2a8c7b6d5e4f3a2b1c0d9e"));
    }
}

fn two_step_run(store: &Arc<Store>, bus: &Bus, session: SessionId, id: &str) {
    let t = begin(store, bus, session, id);
    t.phase(Phase::Choosing);
    t.phase(Phase::Asking);
    t.model("big-model", "small-model", Some(120));
    t.note("a note");
    let a = step(
        1,
        "files__read",
        json!({ "path": "a.txt" }),
        Some(outcome("hello", true)),
    );
    t.step(&a);
    t.audited(&a, Some("files"), "run", "ran", None).unwrap();
    let b = step(
        2,
        "files__delete",
        json!({ "path": "b.txt" }),
        Some(outcome("nope", false)),
    );
    t.step(&b);
    t.audited(
        &b,
        Some("files"),
        "ask",
        "denied",
        Some("the owner said no"),
    )
    .unwrap();
    t.end(&RunEnd::Answered).unwrap();
}

#[test]
fn replay_reads_like_v2() {
    let (store, bus, session) = setup();
    two_step_run(&store, &bus, session, "r4");
    let text = replay(&store, "r4").unwrap().unwrap();
    assert!(text.starts_with("# Run r4"));
    assert!(text.contains("2 steps · finished"));
    assert!(text.contains("asked big-model, answered small-model — the router fell back"));
    assert!(text.contains("## Where the time went"));
    assert!(text.contains("## 1. files__read"));
    assert!(text.contains("## 2. files__delete"));
    assert!(text.contains("ask -> denied: the owner said no"));
    assert!(text.contains("failed"));
    assert!(replay(&store, "nope").unwrap().is_none());
}

#[test]
fn activity_finds_by_text() {
    let (store, bus, session) = setup();
    two_step_run(&store, &bus, session, "r5");
    let all = activity(&store, None, 10).unwrap();
    assert_eq!(all.len(), 2);
    let found = activity(&store, Some("b.txt"), 10).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].tool, "files__delete");
    assert_eq!(found[0].decision, "denied");
    assert_eq!(found[0].ok, Some(false));
    assert_eq!(found[0].summary, "the owner said no");
    assert_eq!(found[0].run, "r5");
    assert!(activity(&store, Some("zzz-not-there"), 10)
        .unwrap()
        .is_empty());
    assert_eq!(activity(&store, None, 1).unwrap().len(), 1);
}

#[test]
fn bus_events_in_order() {
    let (store, bus, session) = setup();
    let mut rx = bus.subscribe();
    let t = begin(&store, &bus, session, "r6");
    t.step(&step(1, "files__read", json!({ "path": "a" }), None));
    t.end(&RunEnd::Ceiling).unwrap();
    let mut seen = Vec::new();
    while let Ok(e) = rx.try_recv() {
        seen.push(match &*e {
            Event::RunStarted { run, .. } => format!("started {}", run.0),
            Event::RunStep { step, summary, .. } => {
                assert!(summary.starts_with("files__read"));
                format!("step {step}")
            }
            Event::RunEnded { outcome, .. } => {
                assert_eq!(*outcome, RunOutcome::Limit);
                "ended".to_owned()
            }
            other => panic!("unexpected {other:?}"),
        });
    }
    assert_eq!(seen, ["started r6", "step 1", "ended"]);
}

#[test]
fn prune_keeps_200() {
    let (store, bus, session) = setup();
    let base: Ms = alexia_store::now_ms();
    // 205 recent runs, written straight to the table, oldest first.
    for i in 0..205 {
        store
            .save_run(&format!("old{i}"), base - 1000 + i, &json!({ "id": i }))
            .unwrap();
    }
    begin(&store, &bus, session, "fresh")
        .end(&RunEnd::Answered)
        .unwrap();
    let kept = store.runs(1000).unwrap();
    assert_eq!(kept.len(), 200);
    assert_eq!(kept[0].0, "fresh");
    assert!(kept.iter().all(|(id, ..)| id != "old0"));
    // And anything over thirty days old goes however few there are.
    store
        .save_run("ancient", base - 31 * 24 * 3600 * 1000, &json!({}))
        .unwrap();
    begin(&store, &bus, session, "next")
        .end(&RunEnd::Answered)
        .unwrap();
    assert!(store.run_body("ancient").unwrap().is_none());
}

#[test]
fn resume_keeps_live_row_and_counts_on() {
    let (store, bus, session) = setup();
    let t = begin(&store, &bus, session, "r8");
    t.step(&step(1, "a", json!({}), None));
    t.step(&step(2, "b", json!({}), None));
    drop(t); // the process died: no `end`
    assert_eq!(live(&store), 1);

    let mut rx = bus.subscribe();
    let t = Trace::resume(
        store.clone(),
        bus.clone(),
        RunId("r8".into()),
        session,
        Origin::Desktop,
        false,
        None,
        2,
    )
    .unwrap();
    assert_eq!(live(&store), 1);
    assert_eq!(store.live_runs().unwrap()[0].steps, 2);
    assert!(matches!(&*rx.try_recv().unwrap(), Event::RunStarted { .. }));

    let s = step(1, "c", json!({}), Some(outcome("done", true)));
    let id = t.audited(&s, None, "run", "ran", None).unwrap();
    assert!(id > 0);
    assert_eq!(store.audit_for_run("r8").unwrap()[0].step, 3);
    t.end(&RunEnd::Answered).unwrap();

    assert_eq!(live(&store), 0);
    assert_eq!(store.runs(10).unwrap().len(), 1);
    let text = replay(&store, "r8").unwrap().unwrap();
    assert!(text.contains("note: Resumed after a restart at step 2."));
}
