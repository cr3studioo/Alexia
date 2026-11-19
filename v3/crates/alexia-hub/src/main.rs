// SPDX-License-Identifier: AGPL-3.0-only
//! Wires everything together on the Windows PC; CLI; the v2 bridge.
//!
//! The hub never names a plugin: ids come from manifests at runtime.

mod bridge;
mod latency;
mod media;
mod watchdog;

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use alexia_core::catalog::Catalog;
use alexia_core::chat::{Caps, FastChat};
use alexia_core::lane::Lanes;
use alexia_core::router::Router;
use alexia_core::{free, Brain, BrainError, Budget, DraftSink, Provider, Reply, Turn, Urgency};
use alexia_core::{Bus, Event};
use alexia_gateway::{channels, Gateway, GatewayConfig};
use alexia_mcp::{EventSink, HostConfig, McpHost, NoUpcalls, PluginId, PluginState, Timings};
use alexia_store::import::{import_v2, import_v2_files};
use alexia_store::{data_dir, now_ms, secrets, Layout, Store};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

const USAGE: &str = "usage:
  alexia-hub run                                   start everything; Ctrl+C stops it cleanly
  alexia-hub tools                                 load plugins, print every enabled plugin's tools
  alexia-hub plugins                               print the status of every plugin found
  alexia-hub import-v2 [--files-only] <v2-folder>  import a v2 data folder
  alexia-hub secret set|clear <key>                store (value asked, never shown) or remove a secret
  alexia-hub secret list                           the key names that can be set
  alexia-hub pair                                  print the pairing code of each unpaired channel
  alexia-hub latency [--last N] [--html FILE] [--check]  the latency dashboard
  alexia-hub install | uninstall                   start the hub at boot (Windows Task Scheduler)";

type Res<T> = Result<T, Box<dyn Error>>;

#[tokio::main]
async fn main() -> ExitCode {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let words: Vec<Option<&str>> = args.iter().map(|a| a.to_str()).collect();
    let result = match (words.as_slice(), args.as_slice()) {
        ([Some("run")], _) => run().await,
        ([Some("tools")], _) => tools().await,
        ([Some("plugins")], _) => plugins().await,
        ([Some("secret"), Some("list")], _) => {
            secret_keys().iter().for_each(|k| println!("{k}"));
            Ok(())
        }
        ([Some("secret"), Some("set"), Some(k)], _) => secret_set(k),
        ([Some("secret"), Some("clear"), Some(k)], _) => secret_clear(k),
        ([Some("pair")], _) => pair(),
        ([Some("latency"), rest @ ..], _) => return latency(rest),
        ([Some("install")], _) => watchdog::install().map_err(Into::into),
        ([Some("uninstall")], _) => watchdog::uninstall().map_err(Into::into),
        ([Some("import-v2"), Some("--files-only"), _], [_, _, folder]) => import(folder, true),
        ([Some("import-v2"), w], [_, folder]) if *w != Some("--files-only") => {
            import(folder, false)
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// `ALEXIA_NODE`, else `node` on PATH, else the literal `node`.
fn node() -> PathBuf {
    if let Some(p) = std::env::var_os("ALEXIA_NODE") {
        return PathBuf::from(p);
    }
    let name = format!("node{}", std::env::consts::EXE_SUFFIX);
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join(&name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn plugin_dirs(layout: &Layout) -> Vec<PathBuf> {
    let mut dirs = vec![layout.extensions()];
    dirs.extend(std::env::var_os("ALEXIA_PLUGINS_DIR").map(PathBuf::from));
    dirs
}

struct Hub {
    store: Arc<Store>,
    host: McpHost,
    bus: Bus,
}

/// Logs every plugin event at info, from the moment the bus exists.
fn log_plugin_events(bus: &Bus) {
    let mut rx = bus.subscribe();
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match rx.recv().await {
                Ok(e) => {
                    if let Event::Plugin(p) = &*e {
                        tracing::info!("{p:?}");
                    }
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Store → bus → host → `start`. The enabled list is kv `_core`/`enabled`; absent means all.
async fn boot(layout: &Layout) -> Res<Hub> {
    let store = Arc::new(Store::open(&layout.db())?);
    let dirs = plugin_dirs(layout);
    let enabled: Vec<PluginId> = match store.kv_get("_core", "enabled")? {
        Some(v) => serde_json::from_value::<Vec<String>>(v)
            .map_err(|_| "The list of enabled plugins is not readable.")?
            .into_iter()
            .map(PluginId)
            .collect(),
        None => McpHost::scan(&dirs).into_keys().collect(),
    };
    let bus = Bus::new(1024);
    log_plugin_events(&bus);
    let sink: EventSink = {
        let bus = bus.clone();
        Arc::new(move |e| bus.publish(Event::Plugin(e)))
    };
    let cfg = HostConfig {
        layout: Layout::new(layout.root.clone()),
        plugin_dirs: dirs,
        node: node(),
        timings: Timings::default(),
    };
    let host = McpHost::new(cfg, store.clone(), Arc::new(NoUpcalls), sink);
    host.start(&enabled).await?;
    Ok(Hub { store, host, bus })
}

/// The task brain when v2 core isn't configured.
struct NoTaskBrain;

#[async_trait::async_trait]
impl Brain for NoTaskBrain {
    async fn reply(
        &self,
        _: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        Err(BrainError::Unavailable(
            "Tasks need v2 core on this PC. Set ALEXIA_V2_ROOT and restart.".into(),
        ))
    }
}

/// Runs `f` every `period`, first after one period, until `root` is cancelled.
fn every(
    tracker: &TaskTracker,
    root: &CancellationToken,
    period: Duration,
    f: impl Fn() + Send + 'static,
) {
    let cancel = root.child_token();
    tracker.spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tick.tick() => f(),
            }
        }
    });
}

/// Spawns the gap announcement. It waits 500 ms, unless `root` is cancelled first.
fn announce_gap(tracker: &TaskTracker, root: &CancellationToken, bus: Bus, text: String) {
    let cancel = root.child_token();
    tracker.spawn(async move {
        tokio::select! {
            _ = cancel.cancelled() => {}
            // ponytail: fixed pause so the gateway has subscribed to the bus; an event bus has no replay.
            _ = tokio::time::sleep(Duration::from_millis(500)) => bus.publish(Event::Say {
                at: now_ms(),
                text,
                urgency: Urgency::Normal,
                job: None,
            }),
        }
    });
}

async fn run() -> Res<()> {
    let layout = Layout::new(data_dir());
    let hub = boot(&layout).await?;
    let root = CancellationToken::new();
    {
        let stop = root.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                stop.cancel()
            }
        });
    }
    // Test hook: with ALEXIA_HUB_STOP_ON_EOF=1, stdin reaching EOF behaves like Ctrl+C
    // (a real Ctrl+C can't be sent to a child on Windows without unsafe code).
    if std::env::var_os("ALEXIA_HUB_STOP_ON_EOF").is_some_and(|v| v == "1") {
        let stop = root.clone();
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            stop.cancel();
        });
    }
    let tracker = TaskTracker::new();
    let result = serve(&hub, &layout, &root, &tracker).await;
    // Every exit after `boot` ends here, so plugin children stop and the next boot sees a clean stop.
    root.cancel();
    tracker.close();
    // The heartbeat must be done before `clean_stop`, or a late tick looks like a crash.
    if tokio::time::timeout(Duration::from_secs(5), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("some tasks did not stop within 5 s");
    }
    hub.host.shutdown().await;
    watchdog::clean_stop(&hub.store, now_ms());
    hub.bus.publish(Event::ShuttingDown);
    println!("Stopped.");
    result
}

async fn serve(
    hub: &Hub,
    layout: &Layout,
    root: &CancellationToken,
    tracker: &TaskTracker,
) -> Res<()> {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    let (store, bus, host) = (hub.store.clone(), hub.bus.clone(), hub.host.clone());

    let free_providers = free::configured();
    let rows = free_providers.iter().map(|p| p.row().clone()).collect();
    let providers: Vec<Arc<dyn Provider>> = free_providers
        .into_iter()
        .map(|p| Arc::new(p) as Arc<dyn Provider>)
        .collect();
    let catalog = Arc::new(Catalog::new(
        providers.clone(),
        rows,
        layout.cache().join("v3-free-models.json"),
    ));
    let router = Arc::new(Router::new(providers, catalog.clone(), store.clone()));
    let caps: Arc<dyn Caps> = Arc::new(host.clone());
    let fast_chat = Arc::new(FastChat::new(
        router,
        caps.clone(),
        store.clone(),
        Budget::CHAT,
    ));
    let bridge = bridge::V2Config::from_env().map(|mut cfg| {
        cfg.node = node();
        if let Some(n) = std::env::var("ALEXIA_V2_DATA_NAME")
            .ok()
            .filter(|n| !n.is_empty())
        {
            cfg.data_name = n;
        }
        Arc::new(bridge::V2Bridge::new(cfg, store.clone()))
    });
    let task_brain: Arc<dyn Brain> = match &bridge {
        Some(b) => b.clone(),
        None => Arc::new(NoTaskBrain),
    };
    let lanes = Arc::new(Lanes::new(fast_chat.clone(), task_brain));
    let media = Arc::new(media::McpMedia {
        caps,
        host: host.clone(),
        cache: layout.cache(),
    });
    let mut gateway = Gateway::new(
        GatewayConfig::default(),
        store.clone(),
        bus.clone(),
        lanes,
        media,
    );
    let channels = channels::configured(store.clone(), layout);
    if channels.is_empty() {
        println!(
            "No channel is set up. Run `alexia-hub secret set <key>` with one of: {}",
            channels::secret_keys().join(", ")
        );
    }
    for c in channels {
        gateway.add(c);
    }
    if let Some(b) = &bridge {
        b.set_ask(gateway.asker());
    }
    for (channel, code) in channels::pairing_codes(&store)? {
        println!("Send {code} to the {channel} bot to pair it.");
    }
    // ponytail: no store accessor for the `imports` table (store is off-limits here); an import
    // that created no sessions would still print this line.
    if store.sessions()?.is_empty() {
        println!("Import v2 first (`alexia-hub import-v2`).");
    }
    let gap = watchdog::offline_gap(&store, now_ms());

    {
        let c = root.child_token();
        let catalog = catalog.clone();
        tracker.spawn(async move { catalog.run(c).await });
    }
    if let Some(b) = bridge {
        let c = root.child_token();
        tracker.spawn(async move { b.run(c).await });
    }
    {
        let c = root.child_token();
        tracker.spawn(async move {
            if let Err(e) = gateway.run(c).await {
                tracing::error!("the gateway stopped: {e}");
            }
        });
    }
    tracker.spawn(watchdog::heartbeat(store.clone(), root.child_token()));
    let invalidate = fast_chat.clone();
    every(tracker, root, Duration::from_secs(600), move || {
        invalidate.invalidate()
    });
    let prune = store.clone();
    let prune = move || {
        if let Err(e) = prune.prune_spans(now_ms().saturating_sub(30 * DAY_MS)) {
            tracing::warn!("pruning old spans failed: {e}");
        }
    };
    prune();
    every(tracker, root, Duration::from_millis(DAY_MS as u64), prune);
    if let Some(text) = gap {
        announce_gap(tracker, root, bus, text);
    }

    println!("Alexia hub is running. Press Ctrl+C to stop.");
    root.cancelled().await;
    Ok(())
}

/// Every key `secret` accepts: the channels' keys and one `provider_<id>` per free provider.
fn secret_keys() -> Vec<String> {
    channels::secret_keys()
        .iter()
        .map(|k| (*k).to_owned())
        .chain(
            free::ladder()
                .into_iter()
                .map(|r| format!("provider_{}", r.id)),
        )
        .collect()
}

fn known_key(key: &str) -> Res<()> {
    let keys = secret_keys();
    if keys.iter().any(|k| k == key) {
        return Ok(());
    }
    Err(format!(
        "'{key}' is not a known key. Known keys: {}",
        keys.join(", ")
    )
    .into())
}

fn secret_set(key: &str) -> Res<()> {
    use std::io::IsTerminal;
    known_key(key)?;
    let value = if std::io::stdin().is_terminal() {
        rpassword::prompt_password("Paste the value (it won't be shown): ")?
    } else {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        line
    };
    let value = value.trim();
    if value.is_empty() {
        return Err("No value was given; nothing was saved.".into());
    }
    secrets::set("_core", key, value)?;
    println!("Saved.");
    Ok(())
}

fn secret_clear(key: &str) -> Res<()> {
    known_key(key)?;
    secrets::delete("_core", key)?;
    println!("Cleared.");
    Ok(())
}

fn pair() -> Res<()> {
    let store = Store::open(&Layout::new(data_dir()).db())?;
    for (channel, code) in channels::pairing_codes(&store)? {
        println!("{channel}\t{code}");
    }
    Ok(())
}

fn latency(rest: &[Option<&str>]) -> ExitCode {
    if rest.iter().any(Option::is_none) {
        eprintln!("The arguments to latency must be text.");
        return ExitCode::from(2);
    }
    let args: Vec<String> = rest.iter().flatten().map(|a| (*a).to_owned()).collect();
    let opts = match latency::parse(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match Store::open(&Layout::new(data_dir()).db()) {
        Ok(store) => ExitCode::from(u8::try_from(latency::run(&store, &opts)).unwrap_or(1)),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

async fn tools() -> Res<()> {
    let hub = boot(&Layout::new(data_dir())).await?;
    for t in hub.host.tools().await {
        let desc = t.tool.description.as_deref().unwrap_or("");
        let desc = desc.lines().next().unwrap_or("");
        let hidden = if t.hidden { "\t(hidden)" } else { "" };
        println!("{}\t{}\t{desc}{hidden}", t.plugin.0, t.tool.name);
    }
    for p in hub.host.plugins() {
        if matches!(p.state, PluginState::Refused | PluginState::Unhealthy) {
            eprintln!("! {}\t{}", p.id.0, p.sentence.unwrap_or_default());
        }
    }
    hub.host.shutdown().await;
    Ok(())
}

async fn plugins() -> Res<()> {
    let hub = boot(&Layout::new(data_dir())).await?;
    for p in hub.host.plugins() {
        let state = serde_json::to_value(&p.state)?;
        let on = if p.enabled { "enabled" } else { "disabled" };
        let sentence = p.sentence.map(|s| format!("\t{s}")).unwrap_or_default();
        println!(
            "{}\t{}\t{}\t{on}{sentence}",
            p.id.0,
            state.as_str().unwrap_or(""),
            p.version
        );
    }
    hub.host.shutdown().await;
    Ok(())
}

fn import(folder: &OsStr, files_only: bool) -> Res<()> {
    let layout = Layout::new(data_dir());
    let v2 = Path::new(folder);
    if files_only {
        if !v2.is_dir() {
            return Err("The v2 folder does not exist.".into());
        }
        println!("files\t{}", import_v2_files(v2, &layout)?);
    } else {
        let store = Store::open(&layout.db())?;
        let report = import_v2(&store, v2, &layout)?;
        for (table, rows) in &report.rows {
            println!("imported {table}\t{rows}");
        }
        println!("files\t{}", report.files);
        for item in &report.skipped {
            println!("skipped\t{item}");
        }
    }
    for m in McpHost::scan(&plugin_dirs(&layout))
        .into_values()
        .map(|d| d.manifest)
    {
        for key in m.password_keys() {
            if matches!(secrets::get(&m.id, &key), Ok(None)) {
                println!("secret missing\t{}.{key}", m.id);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real time: the hub has no tokio `test-util`.
    #[tokio::test]
    async fn gap_announcement_never_delays_stop() {
        let bus = Bus::new(16);
        let mut rx = bus.subscribe();
        let (tracker, root) = (TaskTracker::new(), CancellationToken::new());
        announce_gap(&tracker, &root, bus.clone(), "gap".into());
        root.cancel();
        tracker.close();
        tokio::time::timeout(Duration::from_millis(100), tracker.wait())
            .await
            .expect("the announcement held up the stop");
        assert!(rx.try_recv().is_err(), "a cancelled announcement was said");

        let (tracker, root) = (TaskTracker::new(), CancellationToken::new());
        announce_gap(&tracker, &root, bus, "gap".into());
        let e = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("no announcement")
            .unwrap();
        assert!(matches!(&*e, Event::Say { text, .. } if text == "gap"));
    }
}
