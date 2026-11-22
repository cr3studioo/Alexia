// SPDX-License-Identifier: AGPL-3.0-only
//! Wires everything together on the Windows PC; CLI. The Agent is the brain (P2-38).
//!
//! The hub never names a plugin: ids come from manifests at runtime.

mod latency;
mod media;
mod watchdog;

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::{Caps, FastChat};
use alexia_core::checker::Checker;
use alexia_core::gpu::{self, GpuEvent};
use alexia_core::helpers::Helpers;
use alexia_core::lane::Lanes;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::subscription::{Cli, SubscriptionCli};
use alexia_core::tools::McpTooling;
use alexia_core::undo::UndoTool;
use alexia_core::{free, resume, Budget, Limits, Provider, Urgency};
use alexia_core::{Bus, Event};
use alexia_gateway::{channels, Asker, ChannelSet, Gateway, GatewayConfig};
use alexia_mcp::{EventSink, HostConfig, McpHost, NoUpcalls, PluginId, PluginState, Timings};
use alexia_scheduler::Scheduler;
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
  alexia-hub secret import-v2 [--overwrite]        copy v2's secrets on this PC into v3 (v2 untouched)
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
        ([Some("secret"), Some("import-v2"), flags @ ..], _)
            if matches!(flags, [] | [Some("--overwrite")]) =>
        {
            return secret_import_v2(!flags.is_empty());
        }
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

/// Store → bus → host, not started. The enabled list is kv `_core`/`enabled`; absent means all.
fn open(layout: &Layout) -> Res<(Hub, Vec<PluginId>)> {
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
    Ok((Hub { store, host, bus }, enabled))
}

/// `open` → `start`, for the verbs that only look at plugins (`tools`, `plugins`).
async fn boot(layout: &Layout) -> Res<Hub> {
    let (hub, enabled) = open(layout)?;
    hub.host.start(&enabled).await?;
    Ok(hub)
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
    if secrets::in_memory() {
        eprintln!("Secrets are in memory (ALEXIA_SECRETS_IN_MEMORY is set): nothing is read from or saved to the keychain.");
    }
    let layout = Layout::new(data_dir());
    // §2.6 steps 1 and 2: store → bus → host with `NoUpcalls`, not started yet.
    let (hub, enabled) = open(&layout)?;
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
    let result = serve(&hub, &enabled, &layout, &root, &tracker).await;
    // Every exit after `open` ends here, so plugin children stop and the next boot sees a clean stop.
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

/// INTERFACES §2.6 steps 3 to 11, in that order (steps 1 and 2 are `open`).
async fn serve(
    hub: &Hub,
    enabled: &[PluginId],
    layout: &Layout,
    root: &CancellationToken,
    tracker: &TaskTracker,
) -> Res<()> {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    let (store, bus, host) = (hub.store.clone(), hub.bus.clone(), hub.host.clone());

    // 3. Providers → catalog → router (+ signed-in subscription CLIs) → channels → asker → checker.
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
    register_subscriptions(&router).await;
    let channels = ChannelSet::new();
    for c in channels::configured(store.clone(), layout) {
        channels.add(c);
    }
    let asker = Asker::new(channels.clone(), store.clone(), bus.clone());
    let checker = Arc::new(Checker::new(None));

    // 4. Tooling with no builtins yet: the ones below need the agent.
    let tooling = Arc::new(McpTooling::new(host.clone(), vec![]));

    // 5. The agent.
    let caps: Arc<dyn Caps> = Arc::new(host.clone());
    let agent = Agent::new(AgentParts {
        router: router.clone(),
        tools: tooling.clone(),
        store: store.clone(),
        bus: bus.clone(),
        ask: asker,
        checker: checker.clone(),
        caps: caps.clone(),
        layout: Layout::new(layout.root.clone()),
        limits: Limits::default(),
        host: host.clone(),
    });

    // 6. The builtins that hold a `Weak` back-reference, then the scheduler's.
    tooling.add_builtin(Helpers::new(&agent));
    tooling.add_builtin(UndoTool::new(&agent));
    let scheduler = Scheduler::new(store.clone(), bus.clone(), agent.clone());
    tooling.add_builtin(scheduler.tools());

    // 7. Residents spawned from here on get the agent's offers.
    host.set_upcalls(agent.clone());
    host.start(enabled).await?;

    // 8. Skills: the data folder's and each enabled plugin's declared folders (filled by `start`).
    let mut skill_dirs = vec![layout.skills()];
    for p in host.manifests() {
        skill_dirs.extend(p.manifest.skills.iter().map(|f| p.path.join(f)));
    }
    let (skills, problems) = Skills::load(&skill_dirs);
    for p in problems {
        tracing::warn!(folder = %p.dir.display(), "a skill was not loaded: {}", p.why);
    }
    tooling.add_builtin(Arc::new(skills));

    // 9. Local models.
    let runtime = Runtime::new(Layout::new(layout.root.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime.clone(), store.clone(), router.clone());
    agent.set_local_jobs(jobs.clone());
    {
        // Starting the checker's model can take a while; boot does not wait for it.
        let (jobs, checker) = (jobs.clone(), checker.clone());
        tracker.spawn(async move {
            if let Some(model) = jobs.checker_model().await {
                checker.set_model(Some(model));
            }
        });
    }
    {
        let (c, runtime) = (root.child_token(), runtime.clone());
        tracker.spawn(async move { runtime.run(c).await });
    }

    // 10. Chat to the fast lane, the rest to the agent.
    let fast_chat = Arc::new(FastChat::new(
        router,
        caps.clone(),
        store.clone(),
        Budget::CHAT,
    ));
    let lanes = Arc::new(Lanes::new(fast_chat.clone(), agent.clone()));
    let media = Arc::new(media::McpMedia {
        caps,
        host: host.clone(),
        cache: layout.cache(),
    });
    if channels.all().is_empty() {
        println!(
            "No channel is set up. Run `alexia-hub secret set <key>` with one of: {}",
            channels::secret_keys().join(", ")
        );
    }
    let gateway = Gateway::with_channels(
        GatewayConfig::default(),
        store.clone(),
        bus.clone(),
        lanes,
        media,
        channels,
    );
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
    {
        let c = root.child_token();
        tracker.spawn(async move {
            if let Err(e) = gateway.run(c).await {
                tracing::error!("the gateway stopped: {e}");
            }
        });
    }

    // 11. Scheduler → resumed runs → GPU watch → catalog news.
    {
        let c = root.child_token();
        tracker.spawn(async move {
            if let Err(e) = scheduler.run(c).await {
                tracing::error!("the scheduler stopped: {e}");
            }
        });
    }
    let resumed = resume::resume_all(agent.clone(), tracker, root.child_token()).await;
    if resumed > 0 {
        tracing::info!("{resumed} unfinished runs picked up again");
    }
    watch_gpu(tracker, root, &store, host, runtime, jobs);
    {
        let (bus, catalog) = (bus.clone(), catalog.clone());
        every(tracker, root, Duration::from_secs(600), move || {
            if let Some(text) = news_text(&catalog.news()) {
                bus.publish(Event::Say {
                    at: now_ms(),
                    text,
                    urgency: Urgency::Normal,
                    job: None,
                });
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

/// §2.6 step 3 (review 6 #10, MO-05): each installed, signed-in subscription CLI becomes a
/// (not local) provider, so a `subscription:<cli>` pin can be used. Missing or signed out: skipped.
async fn register_subscriptions(router: &Router) {
    for cli in [Cli::ClaudeCode, Cli::Codex] {
        let Some(found) = SubscriptionCli::find(cli) else {
            tracing::info!("{cli:?} is not installed; skipped");
            continue;
        };
        match found.check().await {
            Ok(()) => {
                tracing::info!("{} registered", found.id());
                router.set_provider(Arc::new(found), false);
            }
            Err(why) => tracing::info!("{cli:?} skipped: {why}"),
        }
    }
}

/// The GPU watch (P2-62) and the loop that acts on it: a game steps every local model and every
/// plugin on the GPU aside until it ends.
fn watch_gpu(
    tracker: &TaskTracker,
    root: &CancellationToken,
    store: &Arc<Store>,
    host: McpHost,
    runtime: Arc<Runtime>,
    jobs: Arc<LocalJobs>,
) {
    let ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync> = {
        let (host, runtime) = (host.clone(), runtime.clone());
        Arc::new(move || {
            let mut pids = runtime.pids();
            pids.extend(host.plugins().iter().filter_map(|p| host.pid(&p.id)));
            pids
        })
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    tracker.spawn(gpu::Watch::new(store.clone(), ours).run(root.child_token(), tx));
    let cancel = root.child_token();
    tracker.spawn(async move {
        loop {
            let event = tokio::select! {
                () = cancel.cancelled() => return,
                e = rx.recv() => match e { Some(e) => e, None => return },
            };
            match event {
                GpuEvent::StepAside { procs } => {
                    jobs.set_paused(true);
                    runtime.stop_all().await;
                    let on_gpu: Vec<PluginId> = host
                        .plugins()
                        .into_iter()
                        .map(|p| p.id)
                        .filter(|id| {
                            host.pid(id)
                                .is_some_and(|pid| procs.iter().any(|g| g.pid == pid))
                        })
                        .collect();
                    host.hold(&on_gpu).await;
                }
                GpuEvent::GameOver => {
                    host.release();
                    jobs.set_paused(false);
                }
            }
        }
    });
}

/// The catalog's new models as one sentence; None when there are none.
fn news_text(news: &[alexia_core::catalog::Candidate]) -> Option<String> {
    if news.is_empty() {
        return None;
    }
    let names: Vec<String> = news
        .iter()
        .map(|c| format!("{} ({})", c.model, c.provider))
        .collect();
    Some(format!("New free models I can use: {}.", names.join(", ")))
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
    Err(format!("That is not a known key. Known keys: {}", keys.join(", ")).into())
}

/// With the in-memory backend on, a `set` or `clear` would be lost when this process exits.
fn refuse_in_memory() -> Res<()> {
    if secrets::in_memory() {
        return Err("Secrets are in memory for tests, so nothing would be saved. Unset ALEXIA_SECRETS_IN_MEMORY.".into());
    }
    Ok(())
}

fn secret_set(key: &str) -> Res<()> {
    use std::io::IsTerminal;
    known_key(key)?;
    refuse_in_memory()?;
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
    refuse_in_memory()?;
    secrets::delete("_core", key)?;
    println!("Cleared.");
    Ok(())
}

/// `secret import-v2`: copies v2's Credential Manager vault into v3's store. Names only, never values.
fn secret_import_v2(overwrite: bool) -> ExitCode {
    let blob = match secrets::read_v2_vault() {
        Ok(Some(b)) => b,
        Ok(None) => {
            println!("No v2 secrets found on this PC.");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let vault = match secrets::V2Vault::parse(&blob) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let mut expected: Vec<(String, String)> = secret_keys()
        .into_iter()
        .map(|k| ("_core".to_owned(), k))
        .collect();
    for m in McpHost::scan(&plugin_dirs(&Layout::new(data_dir())))
        .into_values()
        .map(|d| d.manifest)
    {
        expected.extend(m.password_keys().into_iter().map(|k| (m.id.clone(), k)));
    }
    let r = secrets::import_v2(&vault, channels::v2_secret_names(), &expected, overwrite);
    r.copied.iter().for_each(|n| println!("copied\t{n}"));
    r.kept.iter().for_each(|n| {
        println!("kept\t{n} (v3 already has one; --overwrite replaces it)");
    });
    r.not_in_v2.iter().for_each(|n| println!("not in v2\t{n}"));
    r.unusable.iter().for_each(|n| println!("unusable\t{n}"));
    r.failed.iter().for_each(|n| println!("failed\t{n}"));
    println!(
        "{} copied, {} kept, {} not in v2.",
        r.copied.len(),
        r.kept.len(),
        r.not_in_v2.len()
    );
    if r.failed.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
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
