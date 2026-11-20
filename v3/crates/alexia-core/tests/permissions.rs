// SPDX-License-Identifier: AGPL-3.0-only
//! Ports `packages/core/test/permissions.test.ts`, plus the Windows-specific cases (P2-12).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use alexia_core::permissions::{
    boundary_ack, heard, lifts, never_touch, paths_in, roots_of, rule, save_boundaries, scope,
    within, CallAsk,
};
use alexia_core::{Blocks, Boundary, PermissionMode, Ruling, Scope};
use alexia_mcp::types::ToolAnnotations;
use alexia_store::Store;
use serde_json::{json, Map, Value};

fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var_os(var).expect("home"))
}

fn data_dir() -> PathBuf {
    home().join("AppData").join("Local").join("Alexia")
}

fn work() -> PathBuf {
    home().join("work")
}

fn scope_with(f: impl FnOnce(&mut Scope)) -> Scope {
    let mut s = Scope {
        mode: PermissionMode::AskRisky,
        roots: vec![work()],
        everywhere: false,
        boundaries: vec![],
        data_dir: data_dir(),
    };
    f(&mut s);
    s
}

fn base() -> Scope {
    scope_with(|_| {})
}

fn ann(read_only: bool, destructive: bool) -> ToolAnnotations {
    serde_json::from_value(json!({ "readOnlyHint": read_only, "destructiveHint": destructive }))
        .unwrap()
}

fn ask<'a>(tool: &'a str, a: Option<&'a ToolAnnotations>, paths: Vec<PathBuf>) -> CallAsk<'a> {
    CallAsk {
        tool,
        words: "",
        annotations: a,
        paths,
        reviewed: true,
    }
}

fn why(r: &Ruling) -> &str {
    match r {
        Ruling::Run => "",
        Ruling::Ask(s) | Ruling::Blocked(s) => s,
    }
}

fn is_ask(r: &Ruling) -> bool {
    matches!(r, Ruling::Ask(_))
}

fn is_blocked(r: &Ruling) -> bool {
    matches!(r, Ruling::Blocked(_))
}

/// A fresh, empty folder under the system temp dir.
fn temp() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "alexia-perm-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const MODES: [PermissionMode; 4] = [
    PermissionMode::AskRisky,
    PermissionMode::AskEveryTime,
    PermissionMode::WatchAndWarn,
    PermissionMode::FullTrust,
];

#[test]
fn risky_runs_read_only() {
    let r = ann(true, false);
    let w = ann(false, true);
    let reading = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    let writing = ask("notes__write", Some(&w), vec![work().join("a.txt")]);
    assert_eq!(rule(&reading, &base()), Ruling::Run);
    let asked = rule(&writing, &base());
    assert!(is_ask(&asked));
    assert!(why(&asked).contains("change or delete"));
    // Silence is not a claim of safety.
    let silent = ask("notes__poke", None, vec![]);
    assert_eq!(
        rule(&silent, &base()),
        Ruling::Ask("Alexia wants to poke. This may change something. Allow it?".into())
    );
}

#[test]
fn question_uses_plain_words_never_a_tool_id() {
    let click = CallAsk {
        words: "click on your screen",
        ..ask("computer__click", None, vec![])
    };
    assert_eq!(
        rule(&click, &base()),
        Ruling::Ask(
            "Alexia wants to click on your screen. This may change something. Allow it?".into()
        )
    );
    let every = scope_with(|s| s.mode = PermissionMode::AskEveryTime);
    assert_eq!(
        rule(&ask("computer__click", None, vec![]), &every),
        Ruling::Ask("Alexia wants to click. Allow it?".into())
    );
    // "Lists every…" fits after "Alexia wants to" with its s taken off.
    let lists = CallAsk {
        words: "lists every note",
        ..ask("notes__list", None, vec![])
    };
    assert_eq!(
        rule(&lists, &every),
        Ruling::Ask("Alexia wants to list every note. Allow it?".into())
    );
}

#[test]
fn each_mode_does_what_its_sentence_says() {
    let r = ann(true, false);
    let w = ann(false, true);
    let reading = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    let writing = ask("notes__write", Some(&w), vec![work().join("a.txt")]);
    let mode = |m| scope_with(|s| s.mode = m);
    assert!(is_ask(&rule(&reading, &mode(PermissionMode::AskEveryTime))));
    assert_eq!(
        rule(&writing, &mode(PermissionMode::WatchAndWarn)),
        Ruling::Run
    );
    assert_eq!(
        rule(&writing, &mode(PermissionMode::FullTrust)),
        Ruling::Run
    );
}

#[test]
fn never_touch_survives_full_trust() {
    let r = ann(true, false);
    let keys = ask(
        "files__read",
        Some(&r),
        vec![home().join(".ssh").join("id_ed25519")],
    );
    for m in MODES {
        let s = scope_with(|s| {
            s.mode = m;
            s.everywhere = true;
        });
        let ruling = rule(&keys, &s);
        assert!(is_blocked(&ruling), "mode {m:?}: {ruling:?}");
        assert!(why(&ruling).contains("never-touch list"));
    }
}

#[test]
fn own_database_is_never_touched() {
    assert!(never_touch(&data_dir().join("alexia.db"), &data_dir()));
    assert!(!never_touch(&work().join("notes.txt"), &data_dir()));
}

#[test]
fn list_is_built_from_this_machine() {
    let system = if cfg!(windows) {
        PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"))
    } else {
        Path::new(std::path::MAIN_SEPARATOR_STR).join("etc")
    };
    assert!(never_touch(&system.join("anything"), &data_dir()));
    if cfg!(windows) {
        let app = PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"));
        assert!(never_touch(
            &app.join("Microsoft").join("Protect").join("x"),
            &data_dir()
        ));
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA"));
        assert!(never_touch(
            &local.join("Microsoft").join("Credentials").join("x"),
            &data_dir()
        ));
    }
}

#[test]
fn sibling_with_shared_prefix_is_not_inside() {
    assert!(!within(&home().join("work"), &home().join("work-notes")));
    assert!(within(
        &home().join("work"),
        &home().join("work").join("notes")
    ));
    assert!(within(&work(), &work()));
}

#[test]
fn dotdot_cannot_escape() {
    let sneaky = work().join("..").join(".ssh");
    assert!(!within(&work(), &sneaky));
    assert!(never_touch(&sneaky.join("id_ed25519"), &data_dir()));
    // Deeper, through folders that do not exist.
    let deeper = work()
        .join("a")
        .join("b")
        .join("..")
        .join("..")
        .join("..")
        .join(".aws")
        .join("credentials");
    assert!(never_touch(&deeper, &data_dir()));
    let r = ann(true, false);
    let s = scope_with(|s| {
        s.mode = PermissionMode::FullTrust;
        s.everywhere = true;
    });
    assert!(is_blocked(&rule(
        &ask("files__read", Some(&r), vec![deeper]),
        &s
    )));
    // `..` that stays inside is still inside.
    assert!(within(&work(), &work().join("a").join("..").join("b")));
}

#[test]
fn case_insensitive_on_windows() {
    let upper = PathBuf::from(work().to_string_lossy().to_uppercase()).join("x.txt");
    assert_eq!(within(&work(), &upper), cfg!(windows));
    let ssh = PathBuf::from(home().join(".SSH").to_string_lossy().to_uppercase()).join("ID");
    assert_eq!(never_touch(&ssh, &data_dir()), cfg!(windows));
}

#[test]
fn symlink_out_of_a_root_is_outside() {
    let root = temp().join("root");
    let away = temp();
    std::fs::create_dir_all(&root).unwrap();
    let link = root.join("link");
    #[cfg(windows)]
    {
        // A junction needs no privilege, unlike a symlink.
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&away)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J failed");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&away, &link).unwrap();

    assert!(!within(&root, &link.join("file.txt")));
    assert!(within(&away, &link.join("file.txt")));
    // The real folder itself is inside.
    std::fs::create_dir_all(root.join("real")).unwrap();
    assert!(within(&root, &root.join("real").join("new.txt")));

    let s = scope_with(|s| s.roots = vec![root.clone()]);
    let r = ann(true, false);
    let ruling = rule(
        &ask("files__read", Some(&r), vec![link.join("file.txt")]),
        &s,
    );
    assert!(
        why(&ruling).contains("outside the folders you chose"),
        "{ruling:?}"
    );
}

#[test]
fn outside_scope_asks() {
    let r = ann(true, false);
    let elsewhere = ask(
        "notes__read",
        Some(&r),
        vec![home().join("Desktop").join("taxes.pdf")],
    );
    let ruling = rule(&elsewhere, &base());
    assert!(is_ask(&ruling));
    assert!(why(&ruling).contains("outside the folders you chose"));
    // No roots at all is nothing in scope.
    assert!(is_ask(&rule(&elsewhere, &scope_with(|s| s.roots.clear()))));
    // Everywhere was chosen deliberately and warned about.
    assert_eq!(
        rule(&elsewhere, &scope_with(|s| s.everywhere = true)),
        Ruling::Run
    );
}

#[test]
fn unreviewed_is_destructive() {
    let r = ann(true, false);
    let claimed = CallAsk {
        reviewed: false,
        ..ask("notes__read", Some(&r), vec![work().join("a.txt")])
    };
    let asked = rule(&claimed, &base());
    assert!(why(&asked).contains("change or delete"), "{asked:?}");
    let bounded = scope_with(|s| {
        s.boundaries = vec![Boundary {
            said: "never delete anything".into(),
            blocks: Blocks::Destructive,
            at: 0,
        }]
    });
    assert!(is_blocked(&rule(&claimed, &bounded)));
}

#[test]
fn boundary_blocks_destructive() {
    let boundary = heard("please don’t delete anything in there", 5).unwrap();
    assert_eq!(boundary.blocks, Blocks::Destructive);
    assert_eq!(boundary.at, 5);
    let r = ann(true, false);
    let w = ann(false, true);
    let reading = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    let writing = ask("notes__write", Some(&w), vec![work().join("a.txt")]);

    let s = scope_with(|s| s.boundaries = vec![boundary.clone()]);
    let ruling = rule(&writing, &s);
    assert!(is_blocked(&ruling));
    assert!(why(&ruling).contains("don’t delete anything"));
    assert!(why(&ruling).contains("lift it"));

    let trusted = scope_with(|s| {
        s.mode = PermissionMode::FullTrust;
        s.boundaries = vec![boundary.clone()];
    });
    assert!(is_blocked(&rule(&writing, &trusted)));
    // "don't delete" is not "don't do anything".
    assert_eq!(rule(&reading, &s), Ruling::Run);
}

#[test]
fn boundary_everything_blocks_reads() {
    let boundary = heard("Don't touch anything", 0).unwrap();
    assert_eq!(boundary.blocks, Blocks::Everything);
    let r = ann(true, false);
    let reading = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    let s = scope_with(|s| {
        s.mode = PermissionMode::FullTrust;
        s.boundaries = vec![boundary];
    });
    assert!(is_blocked(&rule(&reading, &s)));
}

#[test]
fn ack_says_it_is_a_default_not_a_guarantee() {
    let b = heard("never delete anything", 0).unwrap();
    assert!(boundary_ack(&b).contains("not something the operating system enforces"));
    assert!(boundary_ack(&b).contains("delete or change"));
    let all = heard("don't do anything", 0).unwrap();
    assert!(boundary_ack(&all).contains("I will not do anything"));
}

#[test]
fn lifting_is_heard_and_ordinary_sentences_are_not_boundaries() {
    assert!(lifts("ok you can delete it"));
    assert!(lifts("forget that rule"));
    assert!(heard("what did you delete yesterday", 0).is_none());
    assert!(heard("summarise my notes", 0).is_none());
    assert!(!lifts("what did you change"));
    assert_eq!(
        heard("  dont remove files ", 0).unwrap().said,
        "dont remove files"
    );
}

#[test]
fn roots_are_file_uris_and_everywhere_invents_none() {
    let roots = roots_of(&base());
    assert_eq!(roots.len(), 1);
    assert!(roots[0].uri.starts_with("file:///"), "{}", roots[0].uri);
    assert!(!roots[0].uri.contains('\\'));
    assert_eq!(roots[0].name.as_deref(), Some("work"));
    assert_eq!(roots_of(&scope_with(|s| s.everywhere = true)).len(), 1);
    let forbidden = scope_with(|s| s.roots = vec![home().join(".ssh"), work()]);
    assert_eq!(roots_of(&forbidden).len(), 1);
    let spaced = scope_with(|s| s.roots = vec![home().join("my work")]);
    assert!(roots_of(&spaced)[0].uri.ends_with("/my%20work"));
}

#[test]
fn paths_in_finds_nested() {
    let a = work().join("a.txt");
    let b = work().join("deep").join("b.txt");
    let args: Map<String, Value> = serde_json::from_value(json!({
        "path": a.to_string_lossy(),
        "relative": "notes/c.txt",
        "url": "https://example.com/x",
        "n": 3,
        "nested": { "list": [ { "target": b.to_string_lossy() } ] },
        // Five levels down: past v2's depth limit.
        "too": { "deep": { "for": { "the": { "walk": work().join("z").to_string_lossy() } } } },
    }))
    .unwrap();
    let mut found = paths_in(&args);
    found.sort();
    let mut want = vec![a, b];
    want.sort();
    assert_eq!(found, want);
}

#[test]
fn scope_reads_v2_kv_and_defaults_safe() {
    let store = Store::open_in_memory().unwrap();
    let empty = scope(&store, &data_dir());
    assert_eq!(empty.mode, PermissionMode::AskRisky);
    assert!(empty.roots.is_empty() && !empty.everywhere && empty.boundaries.is_empty());
    assert_eq!(empty.data_dir, data_dir());

    // v2's `_core.mode` is the compute mode; it must not be mistaken for a permission mode.
    store.kv_set("_core", "mode", &json!("local")).unwrap();
    assert_eq!(scope(&store, &data_dir()).mode, PermissionMode::AskRisky);

    for (name, mode) in [
        ("every-time", PermissionMode::AskEveryTime),
        ("risky", PermissionMode::AskRisky),
        ("watch", PermissionMode::WatchAndWarn),
        ("full-trust", PermissionMode::FullTrust),
    ] {
        store
            .kv_set(
                "_core",
                "scope",
                &json!({ "mode": name, "roots": [work().to_string_lossy()], "everywhere": true }),
            )
            .unwrap();
        let s = scope(&store, &data_dir());
        assert_eq!(s.mode, mode);
        assert_eq!(s.roots, vec![work()]);
        assert!(s.everywhere);
    }
    store.kv_set("_core", "scope", &json!({})).unwrap();
    store.kv_set("_core", "mode", &json!("full-trust")).unwrap();
    assert_eq!(scope(&store, &data_dir()).mode, PermissionMode::FullTrust);

    let b = heard("never delete anything", 42).unwrap();
    save_boundaries(&store, std::slice::from_ref(&b)).unwrap();
    assert_eq!(scope(&store, &data_dir()).boundaries, vec![b]);
    // v2's stored shape, as v2 wrote it.
    assert_eq!(
        store.kv_get("_core", "boundaries").unwrap(),
        Some(json!([{ "said": "never delete anything", "blocks": "destructive", "at": 42 }]))
    );
}
