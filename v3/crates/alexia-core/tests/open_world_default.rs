// SPDX-License-Identifier: AGPL-3.0-only
//! P3-42 (D214, D-P3-6): MCP's default for `openWorldHint` is true, so a tool that leaves it out,
//! or has no annotations at all, reaches outside. A scheduled turn asks before it even when the
//! owner listed it, and local-only blocks it. Only an explicit `false` keeps the old rulings.
//! `proactive` is what the agent applies to an `Origin::Scheduler` turn (see `tests/silent.rs`).

use std::path::PathBuf;

use alexia_core::permissions::{local_only, proactive, CallAsk, LOCAL_ONLY_BLOCKED};
use alexia_core::{PermissionMode, Ruling, Scope};
use alexia_mcp::types::ToolAnnotations;
use serde_json::json;

fn ann(v: serde_json::Value) -> ToolAnnotations {
    serde_json::from_value(v).unwrap()
}

/// Full trust, every folder, `silent` on the owner's list.
fn scope_of(silent: &[&str], local_only: bool) -> Scope {
    Scope {
        mode: PermissionMode::FullTrust,
        roots: Vec::new(),
        everywhere: true,
        boundaries: Vec::new(),
        data_dir: PathBuf::from("/data"),
        silent: silent.iter().map(|s| s.to_string()).collect(),
        local_only,
        guest_tools: Vec::new(),
    }
}

fn asking<'a>(tool: &'a str, words: &'a str, a: Option<&'a ToolAnnotations>) -> CallAsk<'a> {
    CallAsk {
        tool,
        words,
        annotations: a,
        paths: Vec::new(),
        reviewed: true,
    }
}

const ASKED: &str = "Alexia wants to post the update on her own. Allow it?";

#[test]
fn missing_hint_asks_even_when_listed() {
    let a = ann(json!({"readOnlyHint": false}));
    let ask = asking("x__post", "posts the update", Some(&a));
    let r = proactive(&ask, &scope_of(&["x__post"], false), Ruling::Run);
    assert_eq!(r, Ruling::Ask(ASKED.into()));
}

#[test]
fn no_annotations_asks_even_when_listed() {
    let ask = asking("x__post", "posts the update", None);
    let r = proactive(&ask, &scope_of(&["x__post"], false), Ruling::Run);
    assert_eq!(r, Ruling::Ask(ASKED.into()));
}

#[test]
fn missing_hint_blocked_in_local_only() {
    let want = Ruling::Blocked(LOCAL_ONLY_BLOCKED.replace("{doing}", "post the update"));
    let on = scope_of(&[], true);
    let a = ann(json!({"readOnlyHint": true}));
    for annotations in [Some(&a), None] {
        let ask = asking("x__post", "posts the update", annotations);
        assert_eq!(local_only(&ask, &on, Ruling::Run), want);
        assert_eq!(local_only(&ask, &on, Ruling::Ask("q".into())), want);
    }
}

#[test]
fn explicit_false_still_silent() {
    let a = ann(json!({"openWorldHint": false, "readOnlyHint": false}));
    let ask = asking("x__note", "writes a note", Some(&a));
    let s = scope_of(&["x__note"], false);
    assert_eq!(proactive(&ask, &s, Ruling::Ask("q".into())), Ruling::Run);
    // And local-only leaves it alone.
    let on = scope_of(&["x__note"], true);
    assert_eq!(local_only(&ask, &on, Ruling::Run), Ruling::Run);
}

#[test]
fn explicit_false_read_only_unchanged() {
    let a = ann(json!({"openWorldHint": false, "readOnlyHint": true}));
    let ask = asking("x__look", "", Some(&a));
    let s = scope_of(&[], false);
    for ruling in [Ruling::Run, Ruling::Ask("outside".into())] {
        assert_eq!(proactive(&ask, &s, ruling.clone()), ruling);
    }
}
