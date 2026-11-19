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

#[test]
fn secret_set_reads_stdin_and_never_prints_it() {
    let key = secret_list("set-list").remove(0);
    let value = "correct-horse-battery-staple-7731";
    let mut c = hub("set");
    c.args(["secret", "set", &key]);
    let o = run_with(c, &format!("{value}\n"));
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).contains("Saved."));
    assert!(!out(&o).contains(value) && !err(&o).contains(value));
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
