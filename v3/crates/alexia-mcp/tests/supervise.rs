// SPDX-License-Identifier: AGPL-3.0-only
//! Supervision against the `mcp-fixture` binary: crashes are contained and backed off, three
//! of them switch a plugin off, hangs are killed, idle lazy plugins stop, a deleted folder
//! takes its plugin's tools with it (INTERFACES.md §7, invariants 3 and 4).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_mcp::{
    CallCtx, CallError, EventSink, HostConfig, McpHost, NoUpcalls, PluginEvent, PluginId,
    PluginState, StopReason, Timings,
};
use alexia_store::{Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const HEARTBEAT_MS: u64 = 500;
const IDLE_MS: u64 = 1_000;
const BACKOFF_MS: u64 = 50;

fn root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("alexia-sup-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// `<root>/ext/<id>/plugin.json`. The fixture lives in `<root>/bin`, outside the plugin
/// folder, so the folder can be deleted while the process runs.
fn plugin(root: &Path, id: &str, args: &[&str], extra: Value) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    if !bin.join(exe).exists() {
        std::fs::copy(FIXTURE, bin.join(exe)).unwrap();
    }
    let path = root.join("ext").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let mut m = json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": format!("../../bin/{exe}"), "args": args },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

fn timings() -> Timings {
    Timings {
        heartbeat_ms: HEARTBEAT_MS,
        idle_ms: IDLE_MS,
        backoff_ms: BACKOFF_MS,
        max_backoff_ms: 2_000,
        crash_window_ms: 60_000,
        crash_limit: 3,
        exit_grace_ms: 2_000,
        ..Timings::default()
    }
}

type Log = Arc<Mutex<Vec<(Instant, PluginEvent)>>>;

struct Fx {
    host: McpHost,
    events: Log,
}

impl Fx {
    fn new(root: &Path, t: Timings) -> Fx {
        let events: Log = Arc::default();
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |e| events.lock().unwrap().push((Instant::now(), e)))
        };
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
        }
    }

    /// Times of the events `f` picks.
    fn times(&self, f: impl Fn(&PluginEvent) -> bool) -> Vec<Instant> {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .filter(|(_, e)| f(e))
            .map(|(t, _)| *t)
            .collect()
    }

    fn count(&self, f: impl Fn(&PluginEvent) -> bool) -> usize {
        self.times(f).len()
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
}

fn id(s: &str) -> PluginId {
    PluginId(s.into())
}

fn crashed(e: &PluginEvent) -> bool {
    matches!(e, PluginEvent::Crashed { .. })
}

fn started(e: &PluginEvent) -> bool {
    matches!(e, PluginEvent::Started { .. })
}

/// Polls `f` until it holds or `secs` pass.
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

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    }
}

async fn gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !alive(pid)
}

#[tokio::test]
async fn crasher_exit_is_contained() {
    let r = root("crasher");
    plugin(&r, "crasher", &["exit"], json!({}));
    plugin(&r, "greet", &["greet"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("crasher"), id("greet")]).await.unwrap();

    let err = fx.call("crasher", "exit", json!({})).await.unwrap_err();
    assert!(matches!(err, CallError::Gone), "{err:?}");
    let first = fx.host.pid(&id("crasher"));
    assert!(eventually(30, || fx.count(crashed) == 1).await);
    assert!(fx.events.lock().unwrap().iter().any(|(_, e)| matches!(
        e,
        PluginEvent::Crashed { plugin, exit_code: Some(3) } if plugin.0 == "crasher"
    )));

    let tools = fx.host.tools().await;
    assert!(tools
        .iter()
        .any(|t| t.plugin == id("greet") && t.tool.name == "greet"));
    assert_eq!(
        fx.call("greet", "greet", json!({"who": "Sam"}))
            .await
            .unwrap(),
        "Hello, Sam."
    );

    // An unknown tool name is answered, not exited on: the respawned process is healthy.
    fx.call("crasher", "nothing", json!({})).await.unwrap();
    let pid = fx.host.pid(&id("crasher")).expect("respawned");
    assert_ne!(Some(pid), first);
    assert_eq!(fx.count(started), 3, "crasher twice, greet once");
    assert_eq!(fx.state("crasher"), Some(PluginState::Running));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn three_crashes_mark_unhealthy() {
    let r = root("three");
    plugin(&r, "crasher", &["exit"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("crasher")]).await.unwrap();

    for _ in 0..3 {
        let err = fx.call("crasher", "exit", json!({})).await.unwrap_err();
        assert!(matches!(err, CallError::Gone), "{err:?}");
    }
    assert!(eventually(30, || fx.state("crasher") == Some(PluginState::Unhealthy)).await);
    // The event follows once the dead process is reaped.
    assert!(
        eventually(30, || fx
            .count(|e| matches!(e, PluginEvent::Unhealthy { .. }))
            == 1)
        .await
    );
    let sentence = fx
        .events
        .lock()
        .unwrap()
        .iter()
        .find_map(|(_, e)| match e {
            PluginEvent::Unhealthy { sentence, .. } => Some(sentence.clone()),
            _ => None,
        })
        .expect("an Unhealthy event");
    assert!(sentence.contains("Plugin crasher"), "{sentence}");

    let err = fx.call("crasher", "exit", json!({})).await.unwrap_err();
    assert!(
        matches!(&err, CallError::Off { sentence: s } if *s == sentence),
        "{err:?}"
    );
    assert_eq!(fx.host.pid(&id("crasher")), None);
    assert_eq!(fx.count(started), 3, "no fourth process");
    let status = fx.host.plugins().remove(0);
    assert_eq!(status.sentence.as_deref(), Some(sentence.as_str()));
    assert!(fx.host.tools().await.is_empty());

    fx.host.set_enabled(&id("crasher"), true).await.unwrap();
    assert_eq!(fx.state("crasher"), Some(PluginState::Stopped));
    fx.call("crasher", "nothing", json!({})).await.unwrap();
    assert!(fx.host.pid(&id("crasher")).is_some());
    assert_eq!(fx.state("crasher"), Some(PluginState::Running));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn backoff_delays_respawn() {
    let r = root("backoff");
    plugin(&r, "crasher", &["exit"], json!({}));
    let backoff = 200;
    let fx = Fx::new(
        &r,
        Timings {
            backoff_ms: backoff,
            ..timings()
        },
    );
    fx.host.start(&[id("crasher")]).await.unwrap();

    // A crash is no later than the moment its call came back `Gone` (stdout closed).
    let mut crashes = vec![];
    for _ in 0..2 {
        let err = fx.call("crasher", "exit", json!({})).await.unwrap_err();
        crashes.push(Instant::now());
        assert!(matches!(err, CallError::Gone), "{err:?}");
    }
    fx.call("crasher", "nothing", json!({})).await.unwrap();
    let starts = fx.times(started);
    assert_eq!(starts.len(), 3);
    assert!(eventually(30, || fx.count(crashed) == 2).await);
    let first = starts[1].duration_since(crashes[0]);
    let second = starts[2].duration_since(crashes[1]);
    assert!(first >= Duration::from_millis(backoff), "{first:?}");
    assert!(second >= Duration::from_millis(backoff * 2), "{second:?}");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn die_on_start_counts_as_crashes() {
    let r = root("die");
    plugin(&r, "dier", &["greet", "--die-on-start"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("dier")]).await.unwrap();

    for attempt in 1..=2 {
        let err = fx.call("dier", "greet", json!({})).await.unwrap_err();
        assert!(
            matches!(&err, CallError::Off { sentence } if sentence.contains("didn't start")),
            "attempt {attempt}: {err:?}"
        );
        assert_eq!(fx.state("dier"), Some(PluginState::Stopped));
    }
    let err = fx.call("dier", "greet", json!({})).await.unwrap_err();
    assert!(
        matches!(&err, CallError::Off { sentence } if sentence.contains("switched it off")),
        "{err:?}"
    );
    assert_eq!(fx.state("dier"), Some(PluginState::Unhealthy));
    assert_eq!(fx.count(|e| matches!(e, PluginEvent::Unhealthy { .. })), 1);
    assert_eq!(fx.count(started), 0);
}

#[tokio::test]
async fn resident_die_on_start_is_retried_then_switched_off() {
    let r = root("dieres");
    plugin(
        &r,
        "dier",
        &["greet", "--die-on-start"],
        json!({"lifetime": "resident"}),
    );
    let fx = Fx::new(&r, timings());
    let t = Instant::now();
    fx.host.start(&[id("dier")]).await.unwrap();
    // No calls: the host retries on its own, after 50 ms and then 100 ms.
    assert!(eventually(30, || fx.state("dier") == Some(PluginState::Unhealthy)).await);
    assert!(t.elapsed() >= Duration::from_millis(BACKOFF_MS * 3));
    assert_eq!(fx.count(|e| matches!(e, PluginEvent::Unhealthy { .. })), 1);
}

#[tokio::test]
async fn resident_crash_is_respawned_without_a_call() {
    let r = root("rescrash");
    plugin(&r, "crasher", &["exit"], json!({"lifetime": "resident"}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("crasher")]).await.unwrap();
    let first = fx.host.pid(&id("crasher")).expect("resident runs at start");

    let err = fx.call("crasher", "exit", json!({})).await.unwrap_err();
    assert!(matches!(err, CallError::Gone), "{err:?}");
    assert!(
        eventually(30, || fx
            .host
            .pid(&id("crasher"))
            .is_some_and(|p| p != first))
        .await
    );
    assert_eq!(fx.count(crashed), 1);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn hang_is_killed_by_heartbeat() {
    let r = root("hang");
    plugin(&r, "hanger", &["hang"], json!({}));
    // Longer than the other tests' heartbeat so the bound below has room on a busy machine.
    let heartbeat = 1_000;
    let fx = Fx::new(
        &r,
        Timings {
            heartbeat_ms: heartbeat,
            idle_ms: 60_000,
            ..timings()
        },
    );
    fx.host.start(&[id("hanger")]).await.unwrap();
    fx.host.tools().await;
    let pid = fx.host.pid(&id("hanger")).unwrap();

    let t = Instant::now();
    let err = fx.call("hanger", "hang", json!({})).await.unwrap_err();
    let took = t.elapsed();
    assert!(
        matches!(err, CallError::Gone | CallError::Timeout),
        "{err:?}"
    );
    assert!(took < Duration::from_millis(heartbeat * 8), "took {took:?}");
    assert!(eventually(30, || fx.count(crashed) == 1).await);
    let order: Vec<&str> = fx
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(_, e)| match e {
            PluginEvent::Stopped {
                reason: StopReason::Heartbeat,
                ..
            } => Some("stopped"),
            PluginEvent::Stopped { .. } => Some("stopped, not by the heartbeat"),
            PluginEvent::Crashed { .. } => Some("crashed"),
            _ => None,
        })
        .collect();
    assert_eq!(order, ["stopped", "crashed"]);
    assert!(gone(pid).await, "pid {pid} still running");
}

#[tokio::test]
async fn junk_does_not_kill_the_host() {
    let r = root("junk");
    plugin(&r, "junk", &["junk"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("junk")]).await.unwrap();
    let tools = fx.host.tools().await;
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].tool.name, "junk");
    // Still answering pings and calls after the flood.
    tokio::time::sleep(Duration::from_millis(HEARTBEAT_MS * 2)).await;
    assert!(fx.call("junk", "junk", json!({})).await.is_ok());
    assert_eq!(fx.count(crashed), 0);
    assert!(fx
        .host
        .log(&id("junk"))
        .iter()
        .any(|l| l.starts_with("[not json]")));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn idle_lazy_plugin_stops() {
    let r = root("idle");
    plugin(&r, "greet", &["greet"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("greet")]).await.unwrap();
    fx.call("greet", "greet", json!({"who": "a"}))
        .await
        .unwrap();
    // Take the pid from the Started event, not host.pid(): under load the idle stop can
    // fire before a live read, and a stalled spawn must still pass.
    let pid = fx
        .events
        .lock()
        .unwrap()
        .iter()
        .find_map(|(_, e)| match e {
            PluginEvent::Started { pid, .. } => Some(*pid),
            _ => None,
        })
        .unwrap();

    assert!(eventually(60, || fx.host.pid(&id("greet")).is_none()).await);
    // host.pid() clears before process::stop finishes; Stopped is emitted after it, so wait.
    let idle_stopped = || {
        fx.count(|e| {
            matches!(
                e,
                PluginEvent::Stopped {
                    reason: StopReason::Idle,
                    ..
                }
            )
        }) > 0
    };
    assert!(
        eventually(60, idle_stopped).await,
        "no Stopped{{Idle}} event; recorded events: {:#?}",
        fx.events
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| e)
            .collect::<Vec<_>>()
    );
    assert!(gone(pid).await);
    assert_eq!(fx.count(crashed), 0);

    assert_eq!(
        fx.call("greet", "greet", json!({"who": "b"}))
            .await
            .unwrap(),
        "Hello, b."
    );
    // The second call must have started a new process (a fresh Started event, new pid).
    assert_eq!(fx.count(started), 2);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn busy_lazy_plugin_does_not_idle_stop() {
    let r = root("busy");
    plugin(&r, "slow", &["vanish"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("slow")]).await.unwrap();
    // A call longer than idle_ms is not idleness.
    let ms = IDLE_MS * 4;
    assert_eq!(
        fx.call("slow", "slow", json!({ "ms": ms })).await.unwrap(),
        "done"
    );
    assert_eq!(fx.count(|e| matches!(e, PluginEvent::Stopped { .. })), 0);
    fx.host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn call_at_idle_deadline_never_gone() {
    let r = root("deadline");
    plugin(&r, "greet", &["greet"], json!({}));
    // Idle is checked on heartbeat ticks, the first one a heartbeat after the spawn. The
    // heartbeat stays at the suite's usual length; the idle is short, so that first tick idles
    // the plugin out. No exit grace: a call the idle stop overtook is killed with the process
    // at once, so it shows. The ping deadline is the heartbeat, so on a loaded machine a
    // fixture that answers a ping late is killed as hung and its calls get Gone. That says
    // nothing about the idle stop, so a loop containing a heartbeat stop is voided, not
    // counted; only clean loops count. crash_limit is unbounded so those kills never switch
    // the plugin off.
    let (heartbeat, idle) = (HEARTBEAT_MS, 100);
    let fx = Fx::new(
        &r,
        Timings {
            heartbeat_ms: heartbeat,
            idle_ms: idle,
            exit_grace_ms: 0,
            crash_limit: u32::MAX,
            ..timings()
        },
    );
    fx.host.start(&[id("greet")]).await.unwrap();
    let heartbeat_stop = |e: &PluginEvent| {
        matches!(
            e,
            PluginEvent::Stopped {
                reason: StopReason::Heartbeat,
                ..
            }
        )
    };
    let (mut clean, mut void) = (0u64, 0u64);
    for _ in 0..150 {
        if clean == 50 {
            break;
        }
        let i = clean;
        // Each loop starts from a stopped plugin, so this call spawns it and its first tick
        // (the idle stop) comes about one heartbeat from now.
        assert!(eventually(30, || fx.host.pid(&id("greet")).is_none()).await);
        let from = fx.events.lock().unwrap().len();
        let warm = fx.call("greet", "greet", json!({"who": "warm"})).await;
        // Sweep the calls below across that tick (measured at about heartbeat + 30 ms), from
        // 70 ms before to 50 ms after it.
        let gap = heartbeat - 40 + (i * 7) % 120;
        tokio::time::sleep(Duration::from_millis(gap)).await;
        let got = tokio::join!(
            fx.call("greet", "greet", json!({"who": "a"})),
            fx.call("greet", "greet", json!({"who": "b"})),
            fx.call("greet", "greet", json!({"who": "c"})),
        );
        if fx.events.lock().unwrap()[from..]
            .iter()
            .any(|(_, e)| heartbeat_stop(e))
        {
            void += 1;
            continue;
        }
        let ok = |r: &Result<String, CallError>, who: &str| {
            r.as_ref().is_ok_and(|t| *t == format!("Hello, {who}."))
        };
        if !(warm.is_ok() && ok(&got.0, "a") && ok(&got.1, "b") && ok(&got.2, "c")) {
            let events = fx.events.lock().unwrap();
            let last: Vec<_> = events.iter().rev().take(6).map(|(_, e)| e).collect();
            panic!(
                "loop {i}, gap {gap} ms, {void} voided: warm {warm:?}, {got:?}, last events {last:?}"
            );
        }
        clean += 1;
    }
    assert_eq!(
        clean, 50,
        "only {clean} clean loops in 150 ({void} voided by heartbeat stops: the machine is too loaded to test the idle deadline)"
    );
    eprintln!("call_at_idle_deadline_never_gone: {void} loops voided");
    // The sweep did cross the deadline: the plugin was idled out and started again.
    assert!(fx.count(started) > 1);
    // Every crash is one a heartbeat stop caused, none came from an idle stop.
    assert_eq!(fx.count(crashed), fx.count(heartbeat_stop));
    fx.host.shutdown().await;
}

#[tokio::test]
async fn resident_does_not_idle_stop() {
    let r = root("residle");
    plugin(&r, "greet", &["greet"], json!({"lifetime": "resident"}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("greet")]).await.unwrap();
    let pid = fx.host.pid(&id("greet")).unwrap();
    tokio::time::sleep(Duration::from_millis(IDLE_MS * 4)).await;
    assert_eq!(fx.host.pid(&id("greet")), Some(pid));
    assert_eq!(fx.count(|e| matches!(e, PluginEvent::Stopped { .. })), 0);
    fx.host.shutdown().await;
}

#[tokio::test]
async fn vanisher_folder_deleted_mid_call() {
    let r = root("vanish");
    plugin(&r, "vanisher", &["vanish"], json!({}));
    plugin(&r, "greet", &["greet"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("vanisher"), id("greet")]).await.unwrap();
    assert!(fx.host.tools().await.iter().any(|t| t.tool.name == "slow"));
    let pid = fx.host.pid(&id("vanisher")).unwrap();

    let host = fx.host.clone();
    let call = tokio::spawn(async move {
        let t = Instant::now();
        let args = json!({"ms": 20_000}).as_object().unwrap().clone();
        let r = host
            .call_tool(&id("vanisher"), "slow", args, CallCtx::default())
            .await;
        (r, t.elapsed())
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    std::fs::remove_dir_all(r.join("ext").join("vanisher")).expect("folder deletes on Windows");

    let (result, took) = call.await.unwrap();
    assert!(matches!(result, Err(CallError::Gone)), "{result:?}");
    assert!(took < Duration::from_millis(10_000), "took {took:?}");
    assert!(fx
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(_, e)| matches!(e, PluginEvent::Removed { plugin } if plugin.0 == "vanisher")));
    let tools = fx.host.tools().await;
    assert!(tools.iter().all(|t| t.plugin != id("vanisher")));
    assert!(tools.iter().any(|t| t.tool.name == "greet"));
    assert!(fx.host.plugins().iter().all(|p| p.id != id("vanisher")));
    assert!(gone(pid).await);
    assert_eq!(fx.count(crashed), 0, "a vanish is not a crash");
    fx.host.shutdown().await;
}

#[tokio::test]
async fn vanished_before_a_call_is_removed() {
    let r = root("vanishpre");
    plugin(&r, "greet", &["greet"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("greet")]).await.unwrap();
    std::fs::remove_dir_all(r.join("ext").join("greet")).unwrap();
    let err = fx.call("greet", "greet", json!({})).await.unwrap_err();
    assert!(matches!(err, CallError::Gone), "{err:?}");
    assert!(fx.host.plugins().is_empty());
    assert_eq!(fx.count(started), 0);
}

#[tokio::test]
async fn stop_is_not_a_crash() {
    let r = root("stop");
    plugin(&r, "greet", &["greet"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("greet")]).await.unwrap();
    for _ in 0..4 {
        fx.call("greet", "greet", json!({"who": "x"}))
            .await
            .unwrap();
        fx.host.stop(&id("greet")).await;
    }
    // Long enough for any watcher to have misread a stop as an exit.
    tokio::time::sleep(Duration::from_millis(HEARTBEAT_MS * 2)).await;
    assert_eq!(fx.count(crashed), 0);
    assert_ne!(fx.state("greet"), Some(PluginState::Unhealthy));
    assert_eq!(
        fx.call("greet", "greet", json!({"who": "y"}))
            .await
            .unwrap(),
        "Hello, y."
    );
    fx.host.shutdown().await;
}

/// The P0-11 review: a respawned process must not be answered from the dead one's cache.
#[tokio::test]
async fn tool_cache_is_dropped_on_crash() {
    let r = root("cache");
    plugin(&r, "crasher", &["exit"], json!({}));
    let fx = Fx::new(&r, timings());
    fx.host.start(&[id("crasher")]).await.unwrap();
    assert_eq!(fx.host.tools().await.len(), 1);
    let _ = fx.call("crasher", "exit", json!({})).await;
    assert!(eventually(30, || fx.count(crashed) == 1).await);
    // A fresh tools/list means a fresh process; a cached answer would leave it stopped.
    assert_eq!(fx.host.tools().await.len(), 1);
    assert!(fx.host.pid(&id("crasher")).is_some());
    assert_eq!(fx.count(started), 2);
    fx.host.shutdown().await;
}
