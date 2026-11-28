// SPDX-License-Identifier: AGPL-3.0-only
//! Ports `packages/core/test/permissions.test.ts`, plus the Windows-specific cases (P2-12).

use std::path::{Path, PathBuf};

mod scratch;
use scratch::Scratch;

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
        silent: Vec::new(),
        local_only: false,
        guest_tools: Vec::new(),
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

/// A fresh, empty folder under the system temp dir, removed on drop.
fn temp() -> Scratch {
    Scratch::new("perm")
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
    // Silence is not a claim of safety: with no annotations MCP's destructiveHint is true.
    let silent = ask("notes__poke", None, vec![]);
    assert_eq!(
        rule(&silent, &base()),
        Ruling::Ask("Alexia wants to poke. This may change or delete something. Allow it?".into())
    );
}

#[test]
fn question_uses_plain_words_never_a_tool_id() {
    let click = CallAsk {
        words: "click on your screen",
        ..ask("demo__click", None, vec![])
    };
    assert_eq!(
        rule(&click, &base()),
        Ruling::Ask(
            "Alexia wants to click on your screen. This may change or delete something. Allow it?"
                .into()
        )
    );
    let every = scope_with(|s| s.mode = PermissionMode::AskEveryTime);
    assert_eq!(
        rule(&ask("demo__click", None, vec![]), &every),
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
    let top = temp();
    let root = top.join("root");
    let away = temp();
    std::fs::create_dir_all(&root).unwrap();
    let link = root.join("link");
    #[cfg(windows)]
    {
        // A junction needs no privilege, unlike a symlink.
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&*away)
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

/// A folder link at `link` to `target`, which need not exist: a junction on Windows (no
/// privilege needed), a symlink on Unix.
fn dir_link(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(out.status.success(), "mklink /J failed: {out:?}");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn dangling_link_out_of_a_root_is_outside() {
    let top = temp();
    let root = top.join("root");
    std::fs::create_dir_all(&root).unwrap();
    let away = temp();
    let gone = away.join("gone");
    std::fs::create_dir_all(&gone).unwrap();
    let link = root.join("link");
    dir_link(&link, &gone);
    std::fs::remove_dir(&gone).unwrap();
    assert!(std::fs::canonicalize(&link).is_err(), "link should dangle");

    assert!(!within(&root, &link));
    assert!(!within(&root, &link.join("new.txt")));
    assert!(within(&away, &link.join("new.txt")));

    // A dangling link into a never-touch folder is never-touch.
    let data = temp();
    let link2 = root.join("into-data");
    dir_link(&link2, &data.join("not-yet"));
    assert!(std::fs::canonicalize(&link2).is_err(), "link should dangle");
    assert!(never_touch(&link2.join("alexia.db"), &data));
    assert!(never_touch(&link2, &data));

    // And into the system folder, which this test cannot create things in.
    let system = if cfg!(windows) {
        PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32")
    } else {
        Path::new(std::path::MAIN_SEPARATOR_STR).join("etc")
    };
    let link3 = root.join("into-system");
    dir_link(
        &link3,
        &system.join(format!("alexia-gone-{}", std::process::id())),
    );
    assert!(std::fs::canonicalize(&link3).is_err(), "link should dangle");
    assert!(never_touch(&link3.join("new.dll"), &data));
    assert!(!within(&root, &link3.join("new.dll")));
}

#[test]
fn link_loop_is_outside_and_never_touch() {
    let root = temp();
    let (a, b) = (root.join("a"), root.join("b"));
    dir_link(&a, &b);
    dir_link(&b, &a);
    assert!(!within(&root, &a.join("x")));
    let other = temp();
    assert!(never_touch(&a.join("x"), &other));
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
fn empty_root_does_not_widen_scope() {
    let r = ann(true, false);
    let elsewhere = ask(
        "notes__read",
        Some(&r),
        vec![home().join("Desktop").join("taxes.pdf")],
    );
    // Set directly on the Scope: `within` itself must refuse an empty parent.
    let direct = scope_with(|s| s.roots.push(PathBuf::new()));
    assert!(is_ask(&rule(&elsewhere, &direct)));
    assert!(!within(Path::new(""), &home()));

    // Read from v2 kv: empty and blank roots are dropped.
    let store = Store::open_in_memory().unwrap();
    store
        .kv_set(
            "_core",
            "scope",
            &json!({ "roots": ["", "   ", work().to_string_lossy()] }),
        )
        .unwrap();
    let saved = scope(&store, &data_dir());
    assert_eq!(saved.roots, vec![work()]);
    assert!(is_ask(&rule(&elsewhere, &saved)));
    let inside = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    assert_eq!(rule(&inside, &saved), Ruling::Run);
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

#[cfg(windows)]
#[test]
fn trailing_dot_segment_is_never_touch() {
    // `.aws` does not exist at this spelling; Windows opens `.aws.` as `.aws`.
    let sneaky = home().join(".aws.").join("credentials");
    assert!(never_touch(&sneaky, &data_dir()));
    // `std::path::absolute` already trims dots on a plain path; a verbatim path keeps them.
    let verbatim = PathBuf::from(format!(r"\\?\{}", sneaky.display()));
    assert!(never_touch(&verbatim, &data_dir()));
}

#[cfg(windows)]
#[test]
fn trailing_space_segment_is_never_touch() {
    let sneaky = home().join(".aws ").join("credentials");
    assert!(never_touch(&sneaky, &data_dir()));
}

#[test]
fn one_bad_boundary_keeps_the_rest() {
    let good = heard("don’t delete anything", 7).unwrap();
    let store = Store::open_in_memory().unwrap();
    store
        .kv_set("_core", "boundaries", &json!([{ "said": 5 }, good.clone()]))
        .unwrap();
    let s = scope(&store, &data_dir());
    assert_eq!(s.boundaries.len(), 1);
    let w = ann(false, true);
    let writing = ask("notes__write", Some(&w), vec![]);
    assert!(is_blocked(&rule(&writing, &s)));
}

// ---- P2-46: fail closed ----

fn dont_delete() -> Scope {
    scope_with(|s| {
        s.mode = PermissionMode::FullTrust;
        s.everywhere = true;
        s.boundaries = vec![heard("don't delete anything", 0).unwrap()];
    })
}

/// A store whose `kv` table is gone, so every kv read errors.
fn broken_store() -> Store {
    let store = Store::open_in_memory().unwrap();
    store
        .kv_set(
            "_core",
            "scope",
            &json!({ "mode": "full-trust", "everywhere": true }),
        )
        .unwrap();
    store
        .transaction(|tx| {
            tx.execute_batch("DROP TABLE kv")?;
            Ok(())
        })
        .unwrap();
    assert!(
        store.kv_get("_core", "scope").is_err(),
        "kv read should fail"
    );
    store
}

#[test]
fn kv_error_gives_closed_scope() {
    let s = scope(&broken_store(), &data_dir());
    assert_eq!(s.mode, PermissionMode::AskEveryTime);
    assert!(s.roots.is_empty() && !s.everywhere);
    assert_eq!(s.boundaries.len(), 1);
    assert_eq!(s.boundaries[0].blocks, Blocks::Everything);
    assert_eq!(s.data_dir, data_dir());
}

#[test]
fn closed_scope_blocks_everything() {
    let s = scope(&broken_store(), &data_dir());
    let r = ann(true, false);
    for call in [
        ask("notes__read", Some(&r), vec![]),
        ask("files__delete", None, vec![]),
    ] {
        let ruling = rule(&call, &s);
        assert!(is_blocked(&ruling), "{ruling:?}");
        assert!(why(&ruling).contains("could not read your permissions"));
    }
    // A path is outside the (empty) scope, which is checked first: asked, never run.
    let pathed = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    assert!(is_ask(&rule(&pathed, &s)));
}

#[test]
fn unannotated_delete_blocked_by_boundary() {
    let delete = ask("files__delete", None, vec![work().join("a.txt")]);
    assert!(is_blocked(&rule(&delete, &dont_delete())));
    // Annotations that say nothing about destruction are silence too.
    let blank: ToolAnnotations = serde_json::from_value(json!({})).unwrap();
    let delete = ask("files__delete", Some(&blank), vec![]);
    assert!(is_blocked(&rule(&delete, &dont_delete())));
}

#[test]
fn destructive_hint_false_runs() {
    let safe: ToolAnnotations =
        serde_json::from_value(json!({ "destructiveHint": false })).unwrap();
    let call = ask("notes__append", Some(&safe), vec![work().join("a.txt")]);
    assert_eq!(rule(&call, &dont_delete()), Ruling::Run);
    assert_eq!(
        rule(&call, &base()),
        Ruling::Ask("Alexia wants to append. This may change something. Allow it?".into())
    );
}

#[test]
fn read_only_hint_not_destructive() {
    let r: ToolAnnotations = serde_json::from_value(json!({ "readOnlyHint": true })).unwrap();
    let call = ask("notes__read", Some(&r), vec![work().join("a.txt")]);
    assert_eq!(rule(&call, &dont_delete()), Ruling::Run);
    assert_eq!(rule(&call, &base()), Ruling::Run);
}

fn args(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

/// `C:\Users\me` → `file:///C:/Users/me`, `/home/me` → `file:///home/me`.
fn uri_of(p: &Path) -> String {
    let slashed = p.to_string_lossy().replace('\\', "/");
    let slashed = slashed.trim_start_matches('/');
    format!("file:///{slashed}")
}

#[test]
fn file_uri_meets_never_touch() {
    let base_uri = uri_of(&home());
    let keys = home().join(".ssh").join("id_rsa");
    let r = ann(true, false);
    for uri in [
        format!("{base_uri}/.ssh/id_rsa"),
        // `%2E` is `.`: decoded before the check.
        format!("{base_uri}/%2Essh/id_rsa"),
        format!("file://localhost{}", &base_uri["file://".len()..]) + "/.ssh/id_rsa",
    ] {
        let found = paths_in(&args(json!({ "path": uri })));
        assert_eq!(found.len(), 1, "{uri}: {found:?}");
        assert!(within(&keys, &found[0]), "{uri} → {found:?}");
        let ruling = rule(&ask("files__read", Some(&r), found), &dont_delete());
        assert!(
            why(&ruling).contains("never-touch list"),
            "{uri}: {ruling:?}"
        );
    }
    // Another machine's file is not a path here.
    assert!(paths_in(&args(json!({ "u": "file://server/share/x" }))).is_empty());
}

#[test]
fn tilde_path_meets_never_touch() {
    let r = ann(true, false);
    for p in ["~/.ssh/id_rsa", r"~\.ssh\id_rsa"] {
        let found = paths_in(&args(json!({ "path": p })));
        if cfg!(windows) || p.starts_with("~/") {
            assert_eq!(found.len(), 1, "{p}: {found:?}");
            let ruling = rule(&ask("files__read", Some(&r), found), &dont_delete());
            assert!(why(&ruling).contains("never-touch list"), "{p}: {ruling:?}");
        }
    }
    // `~user` is someone else's home: not expanded, so not absolute.
    assert!(paths_in(&args(json!({ "path": "~bob/x" }))).is_empty());
}

#[test]
fn env_var_path_meets_scope() {
    let (var, written) = if cfg!(windows) {
        ("APPDATA", r"%APPDATA%\notes\a.txt")
    } else {
        ("HOME", "$HOME/notes/a.txt")
    };
    let value = PathBuf::from(std::env::var_os(var).expect(var));
    let r = ann(true, false);
    let found = paths_in(&args(json!({ "path": written })));
    assert_eq!(found, vec![value.join("notes").join("a.txt")]);
    // Outside the chosen folder: asked, not run.
    let ruling = rule(&ask("notes__read", Some(&r), found.clone()), &base());
    assert!(
        why(&ruling).contains("outside the folders you chose"),
        "{ruling:?}"
    );
    // Inside it: runs.
    let inside = scope_with(|s| s.roots = vec![value.clone()]);
    assert_eq!(
        rule(&ask("notes__read", Some(&r), found), &inside),
        Ruling::Run
    );
    // `${VAR}` too, and an unset variable stays as written, so it is not a path.
    let braced = format!("${{{var}}}/notes/a.txt");
    assert_eq!(paths_in(&args(json!({ "p": braced }))).len(), 1);
    assert!(paths_in(&args(json!({ "p": "$ALEXIA_SURELY_UNSET_VAR/x" }))).is_empty());
    assert!(paths_in(&args(json!({ "p": "%ALEXIA_SURELY_UNSET_VAR%/x" }))).is_empty());
}

/// Every URI must land on the key file and be blocked as never-touch.
fn assert_uris_meet_never_touch(uris: &[String]) {
    let keys = home().join(".ssh").join("id_rsa");
    let r = ann(true, false);
    for uri in uris {
        let found = paths_in(&args(json!({ "path": uri })));
        assert_eq!(found.len(), 1, "{uri}: {found:?}");
        assert!(within(&keys, &found[0]), "{uri} → {found:?}");
        let ruling = rule(&ask("files__read", Some(&r), found), &dont_delete());
        assert!(
            why(&ruling).contains("never-touch list"),
            "{uri}: {ruling:?}"
        );
    }
}

#[test]
fn upper_case_file_uri_meets_never_touch() {
    let rest = &uri_of(&home())["file:".len()..];
    assert_uris_meet_never_touch(&[
        format!("FILE:{rest}/.ssh/id_rsa"),
        format!("File:{rest}/.ssh/id_rsa"),
        format!("FILE://LOCALHOST{}/.ssh/id_rsa", &rest["//".len()..]),
    ]);
    // Another host stays another host, whatever the case.
    assert!(paths_in(&args(json!({ "u": "FILE://server/share/x" }))).is_empty());
}

#[test]
fn one_slash_file_uri_meets_never_touch() {
    // `file:///C:/x` → `file:/C:/x`; `file:///home/x` → `file:/home/x` (RFC 8089).
    let rest = &uri_of(&home())["file://".len()..];
    assert_uris_meet_never_touch(&[
        format!("file:{rest}/.ssh/id_rsa"),
        format!("FILE:{rest}/%2Essh/id_rsa"),
    ]);
}

#[test]
fn unclosed_var_absolute_path_still_checked() {
    let r = ann(true, false);
    // `C:\Users\x\.ssh\${oops`: the `${` is never closed.
    let written = home().join(".ssh").join("${oops").display().to_string();
    let found = paths_in(&args(json!({ "path": written })));
    assert_eq!(found.len(), 1, "{written}: {found:?}");
    let ruling = rule(&ask("files__read", Some(&r), found), &dont_delete());
    assert!(why(&ruling).contains("never-touch list"), "{ruling:?}");
    // Unclosed at the start: kept as written, so still not absolute and not a path.
    assert!(paths_in(&args(json!({ "p": "${oops/x" }))).is_empty());
    assert!(paths_in(&args(json!({ "p": "%oops/x" }))).is_empty());
}

#[test]
fn unc_file_uri_judged_not_skipped() {
    // An empty host, then a UNC path: decoded as `//srv/share/x`, which looks absolute, so the
    // gate judges it (out of scope, asked) rather than dropping it as not-a-path.
    let found = paths_in(&args(json!({ "path": "file:////srv/share/x" })));
    assert_eq!(found.len(), 1, "{found:?}");
    let r = ann(true, false);
    let ruling = rule(&ask("files__read", Some(&r), found), &base());
    assert!(
        why(&ruling).contains("outside the folders you chose"),
        "{ruling:?}"
    );
}
