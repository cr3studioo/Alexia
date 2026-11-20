// SPDX-License-Identifier: AGPL-3.0-only
//! `"run": "wasm"` (P2-24): a plugin in the in-process sandbox behaves like a process plugin
//! to the host, and gets only what it declared.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::{
    CallCtx, CallError, EventSink, HostConfig, McpHost, NoUpcalls, PluginEvent, PluginId,
    PluginState, Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};

const MCP_FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wasm-hello.wasm"
);
const README: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/wasm-hello/README.md");

fn root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-wasm-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn manifest(id: &str, entry: Value, extra: Value) -> Value {
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": entry,
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    m
}

/// `<root>/ext/<id>/{plugin.json, plugin.wasm}`.
fn wasm_plugin(root: &Path, id: &str, extra: Value) {
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::copy(WASM, path.join("plugin.wasm")).unwrap();
    let m = manifest(id, json!({"run": "wasm", "args": ["plugin.wasm"]}), extra);
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

/// The same, for the process fixture (kept outside the plugin folder).
fn process_plugin(root: &Path, id: &str, arg: &str) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = Path::new(MCP_FIXTURE)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    if !bin.join(exe).exists() {
        std::fs::copy(MCP_FIXTURE, bin.join(exe)).unwrap();
    }
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let m = manifest(
        id,
        json!({"run": format!("../../bin/{exe}"), "args": [arg]}),
        json!({}),
    );
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

fn timings() -> Timings {
    Timings {
        // Compiling the module in a debug build can take seconds.
        start_ms: 60_000,
        heartbeat_ms: 1_000,
        idle_ms: 60_000,
        backoff_ms: 50,
        max_backoff_ms: 2_000,
        crash_window_ms: 60_000,
        crash_limit: 3,
        exit_grace_ms: 2_000,
        ..Timings::default()
    }
}

type Log = Arc<Mutex<Vec<PluginEvent>>>;

struct Fx {
    host: McpHost,
    events: Log,
    layout: Layout,
}

impl Fx {
    fn new(root: &Path, t: Timings) -> Fx {
        let events: Log = Arc::default();
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |e| events.lock().unwrap().push(e))
        };
        let layout = Layout::new(root.join("data"));
        let cfg = HostConfig {
            layout: Layout::new(root.join("data")),
            plugin_dirs: vec![root.join("ext")],
            node: PathBuf::from("node"),
            timings: t,
        };
        let store = Arc::new(Store::open_in_memory().unwrap());
        Fx {
            host: McpHost::new(cfg, store, Arc::new(NoUpcalls), sink),
            events,
            layout,
        }
    }

    fn count(&self, f: impl Fn(&PluginEvent) -> bool) -> usize {
        self.events.lock().unwrap().iter().filter(|e| f(e)).count()
    }

    async fn call(&self, plugin: &str, tool: &str, a: Value) -> Result<String, CallError> {
        let args: Map<String, Value> = a.as_object().unwrap().clone();
        let r = self
            .host
            .call_tool(&id(plugin), tool, args, CallCtx::default())
            .await?;
        Ok(r.content[0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    fn state(&self, plugin: &str) -> Option<PluginState> {
        self.host
            .plugins()
            .into_iter()
            .find(|p| p.id.0 == plugin)
            .map(|p| p.state)
    }

    /// Event kinds in order, without pids or exit codes (a wasm guest has neither).
    fn kinds(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| match e {
                PluginEvent::Loaded { .. } => "loaded".into(),
                PluginEvent::Refused { .. } => "refused".into(),
                PluginEvent::Started { .. } => "started".into(),
                PluginEvent::Stopped { reason, .. } => format!("stopped {reason:?}"),
                PluginEvent::Crashed { .. } => "crashed".into(),
                PluginEvent::Unhealthy { .. } => "unhealthy".into(),
                PluginEvent::ToolsChanged { .. } => "tools-changed".into(),
                PluginEvent::Removed { .. } => "removed".into(),
            })
            .collect()
    }
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn crashed(e: &PluginEvent) -> bool {
    matches!(e, PluginEvent::Crashed { .. })
}

async fn eventually(secs: u64, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f()
}

// ---- the committed binary is the one the README describes ----

/// FIPS 180-4, by hand: the crate has no hash dependency and the test needs one digest.
fn sha256(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for (i, b) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for (a, b) in h.iter_mut().zip(v) {
            *a = a.wrapping_add(b);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[test]
fn sha256_matches_known_digests() {
    assert_eq!(
        sha256(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn fixture_binary_matches_the_readme_hash() {
    let readme = std::fs::read_to_string(README).unwrap();
    let recorded = readme
        .lines()
        .find(|l| l.starts_with("SHA-256 of"))
        .and_then(|l| l.split('`').nth(3))
        .expect("the README records the hash in backticks");
    let actual = sha256(&std::fs::read(WASM).unwrap());
    assert_eq!(
        actual, recorded,
        "tests/fixtures/wasm-hello.wasm is stale: rebuild it as the README says"
    );
}

// ---- behaviour ----

#[tokio::test]
async fn wasm_plugin_lists_and_calls() {
    let r = root("calls");
    wasm_plugin(&r, "hello", json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("hello")]).await.unwrap();

    let tools = fx.host.tools().await;
    let names: Vec<&str> = tools.iter().map(|t| t.tool.name.as_str()).collect();
    assert_eq!(names, ["hello", "hang", "trap", "read_file", "alloc"]);
    assert!(tools.iter().all(|t| t.plugin == id("hello")));
    assert_eq!(
        fx.call("hello", "hello", json!({"who": "Sam"}))
            .await
            .unwrap(),
        "Hello, Sam."
    );
    assert_eq!(fx.state("hello"), Some(PluginState::Running));
    fx.host.shutdown().await;
    assert_eq!(fx.count(crashed), 0);
}

#[tokio::test]
async fn trap_is_a_crash() {
    let r = root("trap");
    wasm_plugin(&r, "hello", json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("hello")]).await.unwrap();

    let err = fx.call("hello", "trap", json!({})).await.unwrap_err();
    assert!(matches!(err, CallError::Gone), "{err:?}");
    assert!(eventually(30, || fx.count(crashed) == 1).await);
    // The next call starts a fresh instance.
    assert_eq!(
        fx.call("hello", "hello", json!({"who": "again"}))
            .await
            .unwrap(),
        "Hello, again."
    );
    // Crashes count toward crash_limit: two more, and it is switched off.
    for _ in 0..2 {
        let err = fx.call("hello", "trap", json!({})).await.unwrap_err();
        assert!(matches!(err, CallError::Gone), "{err:?}");
    }
    assert!(eventually(30, || fx.state("hello") == Some(PluginState::Unhealthy)).await);
    let err = fx.call("hello", "hello", json!({})).await.unwrap_err();
    assert!(matches!(err, CallError::Off { .. }), "{err:?}");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn hang_is_killed_by_heartbeat() {
    let r = root("hang");
    wasm_plugin(&r, "hello", json!({}));
    let heartbeat = 1_000;
    let fx = Fx::new(
        &r,
        Timings {
            heartbeat_ms: heartbeat,
            ..timings()
        },
    );
    fx.host.start(&[id("hello")]).await.unwrap();
    fx.host.tools().await;

    let t = Instant::now();
    let err = fx.call("hello", "hang", json!({})).await.unwrap_err();
    let took = t.elapsed();
    assert!(
        matches!(err, CallError::Gone | CallError::Timeout),
        "{err:?}"
    );
    assert!(
        took < Duration::from_millis(heartbeat * 20),
        "took {took:?}"
    );
    assert!(eventually(30, || fx.count(crashed) == 1).await);
    let order: Vec<String> = fx
        .kinds()
        .into_iter()
        .filter(|k| k.starts_with("stopped") || k == "crashed")
        .collect();
    assert_eq!(order, ["stopped Heartbeat", "crashed"]);
    // The spinning instance really ended: a new one answers.
    assert_eq!(
        fx.call("hello", "hello", json!({"who": "x"}))
            .await
            .unwrap(),
        "Hello, x."
    );
    fx.host.shutdown().await;
}

/// `<data>/<id>/note.txt` (the plugin's own dir) and `<root>/secret.txt`.
fn plant(fx: &Fx, root: &Path, id: &str) {
    let own = fx.layout.own_dir(id);
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join("note.txt"), "inside").unwrap();
    std::fs::write(root.join("secret.txt"), "outside").unwrap();
}

#[tokio::test]
async fn no_file_outside_own_dir() {
    let r = root("outside");
    wasm_plugin(
        &r,
        "hello",
        json!({"requires": [{"cap": "fs.own_dir", "why": "To keep its notes."}]}),
    );
    let fx = Fx::new(&r, timings());
    plant(&fx, &r, "hello");
    fx.host.start(&[id("hello")]).await.unwrap();

    assert_eq!(
        fx.call("hello", "read_file", json!({"path": "/data/note.txt"}))
            .await
            .unwrap(),
        "inside"
    );
    let secret = r.join("secret.txt");
    let secret = secret.to_str().unwrap();
    for path in [
        "/data/../secret.txt",
        "../secret.txt",
        "/secret.txt",
        "/data/../../secret.txt",
        secret,
    ] {
        let got = fx
            .call("hello", "read_file", json!({ "path": path }))
            .await
            .unwrap();
        assert_ne!(got, "outside", "{path} escaped the own dir");
        assert_ne!(got, "inside", "{path}");
    }
    fx.host.shutdown().await;
}

#[tokio::test]
async fn no_own_dir_without_require() {
    let r = root("norequire");
    wasm_plugin(&r, "hello", json!({}));
    let fx = Fx::new(&r, timings());
    plant(&fx, &r, "hello");
    fx.host.start(&[id("hello")]).await.unwrap();

    let got = fx
        .call("hello", "read_file", json!({"path": "/data/note.txt"}))
        .await
        .unwrap();
    assert_ne!(got, "inside", "the own dir was mounted without fs.own_dir");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn memory_limit_enforced() {
    let r = root("memory");
    wasm_plugin(&r, "hello", json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("hello")]).await.unwrap();

    assert_eq!(
        fx.call("hello", "alloc", json!({"mb": 16})).await.unwrap(),
        "16777216"
    );
    // Over the 128 MB cap: the allocation fails and the instance dies.
    let err = fx
        .call("hello", "alloc", json!({"mb": 512}))
        .await
        .unwrap_err();
    assert!(matches!(err, CallError::Gone), "{err:?}");
    assert!(eventually(30, || fx.count(crashed) == 1).await);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn deleted_folder_removes() {
    let r = root("deleted");
    wasm_plugin(&r, "hello", json!({}));
    let fx = Fx::new(
        &r,
        Timings {
            heartbeat_ms: 300,
            ..timings()
        },
    );
    fx.host.start(&[id("hello")]).await.unwrap();
    fx.call("hello", "hello", json!({})).await.unwrap();

    // The module is already loaded, so the folder can go while it runs.
    std::fs::remove_dir_all(r.join("ext").join("hello")).unwrap();
    let removed = |e: &PluginEvent| matches!(e, PluginEvent::Removed { .. });
    assert!(eventually(30, || fx.count(removed) == 1).await);
    assert!(fx.host.tools().await.is_empty());
    assert!(fx.host.plugins().is_empty());
    assert_eq!(fx.host.pid(&id("hello")), None);
    assert_eq!(fx.count(crashed), 0);
    fx.host.shutdown().await;
}

/// Event order for one scenario: start, then one call that answers, or one that kills it.
async fn scenario(r: &Path, plugin: &str, tool: &str, crash: bool) -> Vec<String> {
    let fx = Fx::new(r, timings());
    fx.host.start(&[id(plugin)]).await.unwrap();
    if crash {
        let err = fx.call(plugin, tool, json!({})).await.unwrap_err();
        assert!(matches!(err, CallError::Gone), "{err:?}");
        assert!(eventually(30, || fx.count(crashed) == 1).await);
    } else {
        fx.call(plugin, tool, json!({"who": "a"})).await.unwrap();
    }
    fx.host.shutdown().await;
    fx.kinds()
}

#[tokio::test]
async fn same_events_as_process_plugin() {
    let r = root("events");
    process_plugin(&r, "proc-ok", "greet");
    process_plugin(&r, "proc-bad", "exit");
    wasm_plugin(&r, "wasm-ok", json!({}));
    wasm_plugin(&r, "wasm-bad", json!({}));

    let proc_ok = scenario(&r, "proc-ok", "greet", false).await;
    let wasm_ok = scenario(&r, "wasm-ok", "hello", false).await;
    assert_eq!(wasm_ok, proc_ok);
    assert_eq!(proc_ok.last().map(String::as_str), Some("stopped Shutdown"));

    let proc_bad = scenario(&r, "proc-bad", "exit", true).await;
    let wasm_bad = scenario(&r, "wasm-bad", "trap", true).await;
    assert_eq!(wasm_bad, proc_bad);
    assert!(wasm_bad.contains(&"crashed".to_string()));
}
