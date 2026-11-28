// SPDX-License-Identifier: AGPL-3.0-only
//! P4-31 (TR-11, D-P4-12): the guest rule. Who a guest is, and what a guest's turn may do:
//! only listed tools, never anything that would ask the owner, never the owner's folders.

use std::path::PathBuf;

use alexia_core::permissions::{
    guest, guest_of, never_touch_list, rule, scope, CallAsk, Guest, GUEST_BLOCKED,
};
use alexia_core::{JobId, Origin, PermissionMode, Ruling, Scope};
use alexia_mcp::types::ToolAnnotations;
use alexia_store::Store;
use serde_json::json;

/// A sha256 hex stand-in: 64 copies of one hex digit.
fn hash(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}

fn chat(id: &str) -> Origin {
    Origin::Channel {
        channel: "telegram".into(),
        chat: id.into(),
    }
}

/// Eva added and holding telegram chat `chat-1`.
fn store_with_eva() -> (Store, i64) {
    let s = Store::open_in_memory().unwrap();
    let id = s.guest_add("Eva", "telegram", &hash('a'), 10).unwrap();
    s.guest_claim("telegram", &hash('a'), "chat-1")
        .unwrap()
        .unwrap();
    (s, id)
}

fn scope_with(mode: PermissionMode, guest_tools: &[&str]) -> Scope {
    Scope {
        mode,
        roots: Vec::new(),
        everywhere: true,
        boundaries: Vec::new(),
        data_dir: std::env::temp_dir().join("alexia-guest-test-data"),
        silent: Vec::new(),
        local_only: false,
        guest_tools: guest_tools.iter().map(|s| s.to_string()).collect(),
    }
}

fn ann(v: serde_json::Value) -> ToolAnnotations {
    serde_json::from_value(v).unwrap()
}

fn asking<'a>(tool: &'a str, a: &'a ToolAnnotations, paths: Vec<PathBuf>) -> CallAsk<'a> {
    CallAsk {
        tool,
        words: "",
        annotations: Some(a),
        paths,
        reviewed: true,
    }
}

/// What the loop does for a guest: `rule`, then `guest`.
fn ruled(ask: &CallAsk, scope: &Scope) -> Ruling {
    guest(ask, scope, rule(ask, scope))
}

fn blocked() -> Ruling {
    Ruling::Blocked(GUEST_BLOCKED.into())
}

#[test]
fn owner_origin_is_not_guest() {
    let (s, _) = store_with_eva();
    for origin in [
        Origin::Desktop,
        Origin::Window,
        Origin::Scheduler { job: JobId(1) },
        chat("chat-2"),
        Origin::Channel {
            channel: "whatsapp".into(),
            chat: "chat-1".into(),
        },
    ] {
        assert_eq!(guest_of(&s, &origin), None, "{origin:?}");
    }
}

#[test]
fn guest_origin_found() {
    let (s, id) = store_with_eva();
    assert_eq!(
        guest_of(&s, &chat("chat-1")),
        Some(Guest {
            id,
            name: "Eva".into()
        })
    );
}

#[test]
fn removed_guest_is_not_guest() {
    let (s, id) = store_with_eva();
    assert!(s.guest_remove(id, 20).unwrap());
    assert_eq!(guest_of(&s, &chat("chat-1")), None);
}

#[test]
fn empty_list_blocks_all() {
    let read = ann(json!({"readOnlyHint": true}));
    let s = scope_with(PermissionMode::FullTrust, &[]);
    assert_eq!(ruled(&asking("notes__look", &read, vec![]), &s), blocked());
    // And the default the store gives, with nothing saved, is that empty list.
    let store = Store::open_in_memory().unwrap();
    assert!(scope(&store, &s.data_dir).guest_tools.is_empty());
}

#[test]
fn scope_reads_guest_tools() {
    let store = Store::open_in_memory().unwrap();
    store
        .kv_set("_core", "guest_tools", &json!(["weather__today"]))
        .unwrap();
    let s = scope(&store, &std::env::temp_dir());
    assert_eq!(s.guest_tools, vec!["weather__today".to_string()]);
    // Malformed reads as empty: a guest then only talks.
    store.kv_set("_core", "guest_tools", &json!("all")).unwrap();
    assert!(scope(&store, &std::env::temp_dir()).guest_tools.is_empty());
}

#[test]
fn listed_read_only_runs() {
    let read = ann(json!({"readOnlyHint": true}));
    let not_destructive = ann(json!({"readOnlyHint": false, "destructiveHint": false}));
    let s = scope_with(PermissionMode::FullTrust, &["weather__today", "notes__jot"]);
    assert_eq!(
        ruled(&asking("weather__today", &read, vec![]), &s),
        Ruling::Run
    );
    assert_eq!(
        ruled(&asking("notes__jot", &not_destructive, vec![]), &s),
        Ruling::Run
    );
    // Listed is not enough when it is someone else's tool id.
    assert_eq!(
        ruled(&asking("weather__alerts", &read, vec![]), &s),
        blocked()
    );
}

#[test]
fn listed_destructive_blocked() {
    let s = scope_with(PermissionMode::FullTrust, &["files__delete", "x__silent"]);
    let destructive = ann(json!({"readOnlyHint": false, "destructiveHint": true}));
    assert_eq!(
        ruled(&asking("files__delete", &destructive, vec![]), &s),
        blocked()
    );
    // No hint is destructive (MCP's default), and so is an unreviewed plugin's "read-only".
    let silent = ann(json!({}));
    assert_eq!(ruled(&asking("x__silent", &silent, vec![]), &s), blocked());
    let read = ann(json!({"readOnlyHint": true}));
    let mut unreviewed = asking("x__silent", &read, vec![]);
    unreviewed.reviewed = false;
    assert_eq!(ruled(&unreviewed, &s), blocked());
}

#[test]
fn ask_becomes_block() {
    // Ask every time: `rule` asks for everything; a guest's turn never reaches the owner.
    let read = ann(json!({"readOnlyHint": true}));
    let s = scope_with(PermissionMode::AskEveryTime, &["weather__today"]);
    let ask = asking("weather__today", &read, vec![]);
    assert!(matches!(rule(&ask, &s), Ruling::Ask(_)));
    assert_eq!(ruled(&ask, &s), blocked());
    // Ask risky: a listed tool that writes would ask, so it is blocked too.
    let write = ann(json!({"readOnlyHint": false, "destructiveHint": false}));
    let s = scope_with(PermissionMode::AskRisky, &["notes__jot"]);
    let ask = asking("notes__jot", &write, vec![]);
    assert!(matches!(rule(&ask, &s), Ruling::Ask(_)));
    assert_eq!(ruled(&ask, &s), blocked());
    // Whatever question came in.
    assert_eq!(guest(&ask, &s, Ruling::Ask("Allow it?".into())), blocked());
}

#[test]
fn paths_always_blocked() {
    let read = ann(json!({"readOnlyHint": true}));
    // Everywhere and Full trust: `rule` would run it. A guest gets no folders.
    let s = scope_with(PermissionMode::FullTrust, &["files__read"]);
    let path = std::env::temp_dir().join("shared.txt");
    let ask = asking("files__read", &read, vec![path]);
    assert_eq!(rule(&ask, &s), Ruling::Run);
    assert_eq!(ruled(&ask, &s), blocked());
}

#[test]
fn never_touch_still_blocked() {
    let read = ann(json!({"readOnlyHint": true}));
    let s = scope_with(PermissionMode::FullTrust, &["files__read"]);
    let forbidden = never_touch_list(&s.data_dir)[0].join("alexia.db");
    let ask = asking("files__read", &read, vec![forbidden.clone()]);
    assert!(matches!(rule(&ask, &s), Ruling::Blocked(_)));
    // Still blocked, and the guest hears the one sentence, not the owner's folder.
    let r = ruled(&ask, &s);
    assert_eq!(r, blocked());
    assert!(!format!("{r:?}").contains(&*forbidden.to_string_lossy()));
    assert_eq!(
        guest(&ask, &s, Ruling::Blocked("You said “never”.".into())),
        blocked()
    );
}
