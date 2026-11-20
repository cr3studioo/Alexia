// SPDX-License-Identifier: AGPL-3.0-only
//! P2's shared run types (P2-01).

use std::sync::Arc;
use std::time::{Duration, Instant};

use alexia_core::{
    ms_since, Blocks, Boundary, Builtin, Job, Limits, LiveRun, PermissionMode, Produced, Ruling,
    RunEnd, RunResult, Scope, Step, Struggle, ToolCtx, ToolOutcome, ToolSpec, Tooling, UndoCall,
};

fn shared<T: Send + Sync>() {}

#[test]
fn shared_run_types_are_send_and_sync() {
    shared::<ToolSpec>();
    shared::<Produced>();
    shared::<UndoCall>();
    shared::<ToolOutcome>();
    shared::<ToolCtx>();
    shared::<Step>();
    shared::<Ruling>();
    shared::<Boundary>();
    shared::<Scope>();
    shared::<Struggle>();
    shared::<Job>();
    shared::<RunEnd>();
    shared::<RunResult>();
    shared::<LiveRun>();
    shared::<Limits>();
    shared::<Arc<dyn Tooling>>();
    shared::<Arc<dyn Builtin>>();
}

#[test]
fn limits_default_to_v2s_steps_and_no_spend() {
    let l = Limits::default();
    assert_eq!(l.max_steps, 24);
    assert_eq!(l.background_steps, 200);
    assert_eq!(l.helper_steps, 12);
}

#[test]
fn job_names_are_the_pin_keys() {
    let names: Vec<String> = [
        Job::Chat,
        Job::Plan,
        Job::Step,
        Job::Code,
        Job::Vision,
        Job::Check,
        Job::Local,
    ]
    .iter()
    .map(|j| {
        serde_json::to_value(j)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    })
    .collect();
    assert_eq!(
        names,
        ["chat", "plan", "step", "code", "vision", "check", "local"]
    );
    let back: Job = serde_json::from_str("\"vision\"").unwrap();
    assert_eq!(back, Job::Vision);
    assert!(serde_json::from_str::<Job>("\"paid\"").is_err());
}

#[test]
fn permission_modes_and_boundaries_round_trip() {
    assert_eq!(
        serde_json::to_value(PermissionMode::AskRisky).unwrap(),
        "ask_risky"
    );
    let b = Boundary {
        said: "don't delete anything".into(),
        blocks: Blocks::Destructive,
        at: 7,
    };
    let json = serde_json::to_value(&b).unwrap();
    assert_eq!(json["blocks"], "destructive");
    assert_eq!(serde_json::from_value::<Boundary>(json).unwrap(), b);
}

#[test]
fn undo_call_is_the_meta_shape() {
    let v =
        serde_json::json!({"tool": "demo__delete", "arguments": {"id": 3}, "summary": "the entry"});
    let u: UndoCall = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(u.tool, "demo__delete");
    assert_eq!(u.arguments["id"], 3);
    assert_eq!(serde_json::to_value(&u).unwrap(), v);
}

#[test]
fn ms_since_counts_elapsed_time() {
    let t = Instant::now();
    std::thread::sleep(Duration::from_millis(20));
    let ms = ms_since(t);
    // Generous upper bound: a loaded Windows machine can stall a thread for seconds.
    assert!((20..30_000).contains(&ms), "{ms}");
}

#[test]
fn ms_since_a_future_instant_is_zero() {
    assert_eq!(ms_since(Instant::now() + Duration::from_secs(3600)), 0);
}

#[test]
fn ms_since_caps_at_u32_max() {
    // u32::MAX ms is about 49.7 days. An Instant that far back exists only when the clock's
    // origin (on Windows, boot) is older than that, so look for one a little past the cap;
    // the cap itself is also unit-tested inside `run.rs` without needing such an Instant.
    let past = Duration::from_millis(u64::from(u32::MAX) + 60_000);
    match Instant::now().checked_sub(past) {
        Some(t) => assert_eq!(ms_since(t), u32::MAX),
        None => {
            // No such Instant on this machine: the largest one we can make still fits.
            let t = Instant::now() - Duration::from_millis(1000);
            assert!(ms_since(t) >= 1000);
        }
    }
}
