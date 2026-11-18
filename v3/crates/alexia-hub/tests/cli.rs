// SPDX-License-Identifier: AGPL-3.0-only
//! The `alexia-hub` binary, run as the owner runs it.
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const V2_MIGRATIONS: &str = include_str!("../../alexia-store/tests/fixtures/v2_migrations.sql");

/// A fresh data folder and plugin folder per test.
struct Env {
    data: PathBuf,
    plugins: PathBuf,
}

fn env(name: &str) -> Env {
    let root = std::env::temp_dir().join(format!("alexia-hub-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (data, plugins) = (root.join("data"), root.join("plugins"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&plugins).unwrap();
    Env { data, plugins }
}

fn hub(env: &Env) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_alexia-hub"));
    c.env("ALEXIA_V3_DATA", &env.data)
        .env("ALEXIA_PLUGINS_DIR", &env.plugins)
        .env("ALEXIA_SECRETS_IN_MEMORY", "1")
        .env_remove("ALEXIA_HUB_STOP_ON_EOF");
    c
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

/// The `mcp-fixture` binary next to the test binary's `deps` folder.
fn fixture_exe() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join(format!("mcp-fixture{}", std::env::consts::EXE_SUFFIX));
    assert!(path.is_file(), "run `cargo build --workspace --bins` first");
    path
}

/// `<plugins>/<id>/plugin.json` running a copy of the fixture in `greet` mode.
fn fixture_plugin(env: &Env, id: &str) {
    let dir = env.plugins.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let src = fixture_exe();
    let exe = src.file_name().unwrap().to_str().unwrap();
    std::fs::copy(&src, dir.join(exe)).unwrap();
    let manifest = serde_json::json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": ["greet"] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
}

#[test]
fn no_args_prints_usage_and_exits_2() {
    let o = hub(&env("noargs")).output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(err(&o).contains("usage:"));
    assert!(out(&o).is_empty());
}

#[test]
fn tools_with_no_plugins_prints_nothing() {
    let o = hub(&env("tools-none")).arg("tools").output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o), "");
}

#[test]
fn plugins_with_no_plugins_prints_nothing() {
    let o = hub(&env("plugins-none")).arg("plugins").output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o), "");
}

#[test]
fn tools_lists_a_fixture_plugin() {
    let e = env("tools-fixture");
    fixture_plugin(&e, "demo");
    let o = hub(&e).arg("tools").output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    let text = out(&o);
    assert!(text.contains("demo\tgreet\t"), "{text}");
    let secret = text
        .lines()
        .find(|l| l.contains("\tsecret_tool\t"))
        .unwrap_or_else(|| panic!("no secret_tool line in {text}"));
    assert!(secret.ends_with("(hidden)"), "{secret}");
    assert!(!text
        .lines()
        .any(|l| l.contains("\tgreet\t") && l.ends_with("(hidden)")));

    let o = hub(&e).arg("plugins").output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).starts_with("demo\t"), "{}", out(&o));
    assert!(out(&o).contains("\t0.1.0\tenabled"), "{}", out(&o));
}

#[test]
fn enabled_list_is_respected() {
    let e = env("enabled");
    fixture_plugin(&e, "demo");
    let layout = alexia_store::Layout::new(e.data.clone());
    let store = alexia_store::Store::open(&layout.db()).unwrap();
    store
        .kv_set("_core", "enabled", &serde_json::json!([]))
        .unwrap();
    drop(store);
    let o = hub(&e).arg("tools").output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o), "");
    let o = hub(&e).arg("plugins").output().unwrap();
    assert!(
        out(&o).contains("demo\tstopped\t0.1.0\tdisabled"),
        "{}",
        out(&o)
    );
}

#[test]
fn import_v2_refuses_a_missing_folder() {
    let e = env("import-missing");
    let o = hub(&e)
        .arg("import-v2")
        .arg(e.data.join("no-such-v2"))
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(
        err(&o).contains("There is no Alexia database in that folder."),
        "{}",
        err(&o)
    );
}

#[test]
fn import_v2_imports_a_v2_file() {
    let e = env("import-v2");
    let v2 = e.data.parent().unwrap().join("v2");
    std::fs::create_dir_all(&v2).unwrap();
    {
        let conn = rusqlite::Connection::open(v2.join("alexia.db")).unwrap();
        conn.execute_batch(V2_MIGRATIONS).unwrap();
        conn.execute_batch(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (1, 't', 1, 2);
             INSERT INTO messages (id, session_id, role, model, body, at)
               VALUES (1, 1, 'user', NULL, '{\"content\":\"hi\"}', 1);",
        )
        .unwrap();
    }
    let o = hub(&e).arg("import-v2").arg(&v2).output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).contains("imported messages\t1"), "{}", out(&o));
    assert!(out(&o).contains("files\t"), "{}", out(&o));

    let o = hub(&e).arg("import-v2").arg(&v2).output().unwrap();
    assert_eq!(o.status.code(), Some(1), "{}", out(&o));
    assert!(!err(&o).is_empty());
}

#[test]
fn run_starts_and_stops() {
    let e = env("run");
    let mut child = hub(&e)
        .arg("run")
        .env("ALEXIA_HUB_STOP_ON_EOF", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let first = lines.next().and_then(|l| l.ok());
        let _ = tx.send(first);
        let rest: Vec<String> = lines.map_while(|l| l.ok()).collect();
        let _ = tx.send(Some(rest.join("\n")));
    });
    let first = rx.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(
        first.as_deref(),
        Some("Alexia hub is running. Press Ctrl+C to stop.")
    );
    drop(child.stdin.take()); // EOF = Ctrl+C
    let rest = rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap();
    assert_eq!(rest.trim(), "Stopped.");
    let status = child.wait().unwrap();
    assert!(status.success());
}
