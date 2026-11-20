// SPDX-License-Identifier: AGPL-3.0-only
//! The P1 subcommands of `alexia-hub`, run as the owner runs them.
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn hub(name: &str) -> Command {
    let root = std::env::temp_dir().join(format!("alexia-hub-p1-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (data, plugins) = (root.join("data"), root.join("plugins"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugins).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_alexia-hub"));
    c.env("ALEXIA_V3_DATA", PathBuf::from(&data))
        .env("ALEXIA_PLUGINS_DIR", plugins)
        .env("ALEXIA_SECRETS_IN_MEMORY", "1")
        .env_remove("ALEXIA_HUB_STOP_ON_EOF")
        .env_remove("ALEXIA_V2_ROOT")
        .env_remove("ALEXIA_V2_URL");
    c
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

/// Runs `c` with `input` on stdin and waits.
fn run_with(mut c: Command, input: &str) -> Output {
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    child.wait_with_output().unwrap()
}

fn secret_list(name: &str) -> Vec<String> {
    let mut c = hub(name);
    c.args(["secret", "list"]);
    let o = run_with(c, "");
    assert!(o.status.success(), "{}", err(&o));
    out(&o).lines().map(str::to_owned).collect()
}

#[test]
fn secret_list_names_keys_only() {
    let keys = secret_list("list");
    assert!(keys.iter().any(|k| k.starts_with("provider_")), "{keys:?}");
    assert!(keys.iter().any(|k| k == "telegram_bot_token"), "{keys:?}");
    assert!(
        keys.iter()
            .all(|k| !k.is_empty() && !k.contains(char::is_whitespace)),
        "{keys:?}"
    );
}

/// The real hub never runs with the in-memory backend, so `set` and `clear` refuse it. The value
/// on stdin must not come back out either.
#[test]
fn secret_set_refuses_in_memory() {
    let key = secret_list("set-list").remove(0);
    let value = "correct-horse-battery-staple-7731";
    for verb in ["set", "clear"] {
        let mut c = hub(&format!("mem-{verb}"));
        c.args(["secret", verb, &key]);
        let o = run_with(c, &format!("{value}\n"));
        assert_eq!(o.status.code(), Some(1), "{verb}: {}", err(&o));
        assert!(
            err(&o).contains("Secrets are in memory for tests"),
            "{}",
            err(&o)
        );
        assert!(
            err(&o).contains("Unset ALEXIA_SECRETS_IN_MEMORY"),
            "{}",
            err(&o)
        );
        assert!(!out(&o).contains("Saved.") && !out(&o).contains("Cleared."));
        assert!(!out(&o).contains(value) && !err(&o).contains(value));
    }
}

#[test]
fn secret_set_refuses_unknown_key() {
    let mut c = hub("unknown");
    c.args(["secret", "set", "not_a_key"]);
    let o = run_with(c, "whatever\n");
    assert!(!o.status.success());
    assert!(err(&o).contains("not a known key"), "{}", err(&o));
    assert!(err(&o).contains("telegram_bot_token"), "{}", err(&o));
}

/// A pasted token in the key position (argv) or on stdin must not be echoed.
#[test]
fn secret_set_unknown_key_does_not_echo() {
    let pasted = "pasted-token-in-the-key-place-4417";
    let on_stdin = "stdin-text-that-must-stay-quiet-9082";
    let mut c = hub("echo");
    c.args(["secret", "set", pasted]);
    let o = run_with(c, &format!("{on_stdin}\n"));
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));
    assert!(err(&o).contains("not a known key"), "{}", err(&o));
    for text in [pasted, on_stdin] {
        assert!(!out(&o).contains(text) && !err(&o).contains(text), "{text}");
    }
}

#[test]
fn pair_with_no_channel_prints_nothing() {
    let mut c = hub("pair");
    c.arg("pair");
    let o = run_with(c, "");
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).is_empty(), "{}", out(&o));
}

#[test]
fn latency_with_no_turns_check_fails() {
    let mut c = hub("latency");
    c.args(["latency", "--check"]);
    let o = run_with(c, "");
    assert_eq!(o.status.code(), Some(1), "{}{}", out(&o), err(&o));
    let all = format!("{}{}", out(&o), err(&o));
    assert!(all.contains("Only 0 turns recorded"), "{all}");
}

#[test]
fn run_without_channel_says_so_and_stops() {
    let mut c = hub("run");
    c.env("ALEXIA_HUB_STOP_ON_EOF", "1").arg("run");
    // run_with closes stdin right after spawning, which is the stop signal.
    let o = run_with(c, "");
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).contains("No channel is set up"), "{}", out(&o));
    assert!(out(&o).contains("Stopped."), "{}", out(&o));
}

fn data_of(c: &Command) -> PathBuf {
    c.get_envs()
        .find(|(k, _)| *k == "ALEXIA_V3_DATA")
        .and_then(|(_, v)| v.map(PathBuf::from))
        .unwrap()
}

fn db_of(c: &Command) -> PathBuf {
    alexia_store::Layout::new(data_of(c)).db()
}

#[test]
fn run_error_after_boot_still_stops_cleanly() {
    let mut c = hub("run-error");
    let db = db_of(&c);
    // Opening the store runs the migrations; then break `store.sessions()`.
    drop(alexia_store::Store::open(&db).unwrap());
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("ALTER TABLE sessions RENAME TO sessions_gone", [])
        .unwrap();
    c.env("ALEXIA_HUB_STOP_ON_EOF", "1").arg("run");
    let o = run_with(c, "");
    assert_eq!(o.status.code(), Some(1), "{}{}", out(&o), err(&o));
    assert!(err(&o).contains("sessions"), "{}", err(&o));
    assert!(out(&o).contains("Stopped."), "{}", out(&o));
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM kv WHERE ns = '_core' AND key = 'hub_clean_stop'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "no clean-stop marker was written");
}

#[test]
fn run_prunes_old_spans_at_boot() {
    let mut c = hub("run-prune");
    let db = db_of(&c);
    let now = alexia_store::now_ms();
    let span = |turn: &str, at| alexia_store::SpanRow {
        turn: turn.into(),
        at,
        origin: "test".into(),
        lane: "fast".into(),
        name: "total".into(),
        start: at,
        ms: 5,
    };
    {
        let store = alexia_store::Store::open(&db).unwrap();
        let day = 24 * 60 * 60 * 1000;
        store
            .record_spans(&[span("old", now - 31 * day), span("new", now)])
            .unwrap();
    }
    c.env("ALEXIA_HUB_STOP_ON_EOF", "1").arg("run");
    let o = run_with(c, "");
    assert!(o.status.success(), "{}", err(&o));
    let conn = rusqlite::Connection::open(&db).unwrap();
    let turns: Vec<String> = conn
        .prepare("SELECT turn FROM spans")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(turns, ["new"]);
}

#[test]
fn latency_rejects_non_text_args() {
    #[cfg(windows)]
    let bad = {
        use std::os::windows::ffi::OsStringExt;
        std::ffi::OsString::from_wide(&[0xD800])
    };
    #[cfg(unix)]
    let bad = {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::OsStr::from_bytes(b"\xff").to_owned()
    };
    let mut c = hub("latency-bad");
    let data = data_of(&c);
    c.args(["latency", "--html"]).arg(bad);
    let o = run_with(c, "");
    assert_eq!(o.status.code(), Some(2), "{}{}", out(&o), err(&o));
    assert!(
        err(&o).contains("The arguments to latency must be text."),
        "{}",
        err(&o)
    );
    assert_eq!(std::fs::read_dir(&data).unwrap().count(), 0);
}
