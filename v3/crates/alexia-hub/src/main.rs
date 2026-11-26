// SPDX-License-Identifier: AGPL-3.0-only
//! Wires everything together on the Windows PC; CLI. The Agent is the brain (P2-38).
//!
//! The hub never names a plugin: ids come from manifests at runtime.

mod latency;
mod media;
mod proactive;
mod watchdog;

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use alexia_api::{Api, ApiParts};
use alexia_core::agent::{Agent, AgentParts};
use alexia_core::catalog::Catalog;
use alexia_core::chat::{Caps, FastChat};
use alexia_core::checker::Checker;
use alexia_core::commands::{self, QuickNotes};
use alexia_core::gpu::{self, GpuEvent};
use alexia_core::helpers::Helpers;
use alexia_core::lane::Lanes;
use alexia_core::local::{LocalJobs, Runtime};
use alexia_core::permissions;
use alexia_core::prompt::Skills;
use alexia_core::router::Router;
use alexia_core::subscription::{Cli, SubscriptionCli};
use alexia_core::tools::{namespaced, McpTooling};
use alexia_core::undo::UndoTool;
use alexia_core::{free, hf, resume, trace, Brain, Budget, Job, Limits, Provider, Urgency};
use alexia_core::{Bus, Event};
use alexia_gateway::{channels, Asker, ChannelSet, Gateway, GatewayConfig};
use alexia_mcp::{EventSink, HostConfig, McpHost, NoUpcalls, PluginId, PluginState, Timings};
use alexia_scheduler::Scheduler;
use alexia_store::import::{import_v2, import_v2_files};
use alexia_store::{data_dir, now_ms, secrets, Layout, Store};
use proactive::HostSources;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

const USAGE: &str = "usage:
  alexia-hub run                                   start everything; Ctrl+C stops it cleanly
  alexia-hub tools                                 load plugins, print every enabled plugin's tools
  alexia-hub plugins                               print the status of every plugin found
  alexia-hub import-v2 [--files-only] <v2-folder>  import a v2 data folder
  alexia-hub secret set|clear <key>                store (value asked, never shown) or remove a secret
  alexia-hub secret set|clear <plugin>.<key>       the same for a plugin's declared `password` setting
  alexia-hub secret list                           the key names that can be set
  alexia-hub secret import-v2 [--overwrite]        copy v2's secrets on this PC into v3 (v2 untouched)
  alexia-hub pair                                  print the pairing code of each unpaired channel
  alexia-hub latency [--last N] [--html FILE] [--check]  the latency dashboard
  alexia-hub install | uninstall                   start the hub at boot (Windows Task Scheduler)
  alexia-hub activity [--last N] [TEXT]            the audited tool calls, newest first; TEXT filters
  alexia-hub runs [--last N]                       the newest runs
  alexia-hub runs show <id>                        one run, step by step, as text
  alexia-hub approvals                             the questions still waiting for an answer, with ids
  alexia-hub models [list]                         local models, whether each fits this GPU, the pins
  alexia-hub models import <repo> <quant>          download a GGUF from Hugging Face
  alexia-hub models import-file <path>             use a GGUF already on this PC
  alexia-hub models use <job> <pin>|auto           pin a job to <provider>/<model>,
                                                   subscription:<cli> or local:<id>; auto unpins
  alexia-hub models games add|remove <folder>      a folder whose programs are games (the GPU steps aside)
  alexia-hub models games list                     those folders
  alexia-hub scope add|remove <folder>             a folder Alexia may work in
  alexia-hub scope list                            those folders
  alexia-hub encrypt                               encrypt the database (stop the hub first)
  alexia-hub notices [--week | --last N]           what she raised or kept back, newest first
  alexia-hub quiet [HH:MM HH:MM [low|normal|high|urgent]]  show or set quiet hours
  alexia-hub quiet pause <minutes> | resume        only urgent things for a while
  alexia-hub brief --now [morning|evening|weekly]  ask the running hub for a brief
  alexia-hub silent list | allow <tool id> | remove <tool id>
                                                   what she may do on her own without asking
  alexia-hub mute list | remove <id>               the sources of notices you muted";

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
        ([Some("activity"), rest @ ..], _) => activity(rest),
        ([Some("runs"), Some("show"), Some(id)], _) => run_show(id),
        ([Some("runs"), rest @ ..], _) => runs(rest),
        ([Some("approvals")], _) => approvals(),
        ([Some("models")] | [Some("models"), Some("list")], _) => models_list().await,
        ([Some("models"), Some("import"), Some(repo), Some(quant)], _) => {
            models_import(repo, quant).await
        }
        ([Some("models"), Some("import-file"), _], [_, _, path]) => models_import_file(path),
        ([Some("models"), Some("use"), Some(job), Some(pin)], _) => models_use(job, pin),
        ([Some("models"), Some("games"), Some("list")], _) => games(None),
        ([Some("models"), Some("games"), Some(verb @ ("add" | "remove")), _], [.., folder]) => {
            games(Some((verb, folder.as_os_str())))
        }
        ([Some("scope"), Some("list")], _) => scope(None),
        ([Some("scope"), Some(verb @ ("add" | "remove")), _], [.., folder]) => {
            scope(Some((verb, folder.as_os_str())))
        }
        ([Some("encrypt")], _) => encrypt(),
        ([Some("notices"), rest @ ..], _) => notices(rest),
        ([Some("quiet")], _) => quiet(commands::quiet_show),
        ([Some("quiet"), Some("pause"), Some(minutes)], _) => quiet_pause(minutes),
        ([Some("quiet"), Some("resume")], _) => quiet(commands::quiet_resume),
        ([Some("quiet"), Some(from), Some(to)], _) => {
            quiet(|s, now| commands::quiet_set(s, from, to, None, now))
        }
        ([Some("quiet"), Some(from), Some(to), Some(urgency)], _) => {
            quiet(|s, now| commands::quiet_set(s, from, to, Some(urgency), now))
        }
        ([Some("brief"), Some("--now")], _) => brief_ask("morning"),
        ([Some("brief"), Some("--now"), Some(kind)], _) => brief_ask(kind),
        ([Some("silent"), Some("list")], _) => store().and_then(|s| say(commands::silent_list(&s))),
        ([Some("silent"), Some("allow"), Some(tool)], _) => silent_allow(tool).await,
        ([Some("silent"), Some("remove"), Some(tool)], _) => {
            store().and_then(|s| say(commands::silent_remove(&s, tool)))
        }
        ([Some("mute"), Some("list")], _) => {
            store().and_then(|s| say(commands::mute_list(&s, now_ms())))
        }
        ([Some("mute"), Some("remove"), Some(id)], _) => mute_remove(id),
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
                notice: None,
                to: None,
            }),
        }
    });
}

async fn run() -> Res<()> {
    if secrets::in_memory() {
        eprintln!("Secrets are in memory (ALEXIA_SECRETS_IN_MEMORY is set): nothing is read from or saved to the keychain.");
    }
    let layout = Layout::new(data_dir());
    // Before step 1: one hub per PC (D-P2D-3). Held until the process ends.
    // A second hub says so and ends cleanly (exit 0): the sign-in task restarts a hub that
    // failed, so a refusal must not count as a failure while the app's hub holds the lock.
    let _lock = match hub_lock(&layout.root) {
        Ok(lock) => lock,
        Err(e) if e.to_string() == ANOTHER_HUB => {
            eprintln!("{ANOTHER_HUB}");
            return Ok(());
        }
        Err(e) => return Err(e),
    };
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
    // With ALEXIA_HUB_STOP_ON_EOF=1, stdin reaching EOF behaves like Ctrl+C (a real Ctrl+C can't
    // be sent to a child on Windows without unsafe code). The desktop shell relies on this in
    // production: it is how quitting the app stops a hub the app started (P2D-13).
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
    // The window's address goes with the server (step 12); an app reading it now starts a new hub.
    let _ = std::fs::remove_file(window_json(&layout));
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

/// What a second `alexia-hub run` says (D-P2D-3).
const ANOTHER_HUB: &str = "Another Alexia hub is already running on this computer.";

/// `<data>/hub.lock`, opened so no other process can open it while this one runs. On Windows
/// `share_mode(0)` makes a second open fail with a sharing violation (error 32). Off Windows
/// the handle is kept and a failure is ignored.
fn hub_lock(root: &Path) -> Res<Option<std::fs::File>> {
    let path = root.join("hub.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        std::fs::create_dir_all(root)?;
        options.share_mode(0);
        match options.open(&path) {
            Ok(f) => Ok(Some(f)),
            Err(e) if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => Err(ANOTHER_HUB.into()),
            Err(e) => Err(format!("The hub's lock file could not be opened: {e}").into()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = std::fs::create_dir_all(root);
        Ok(options.open(&path).ok())
    }
}

fn window_json(layout: &Layout) -> PathBuf {
    layout.root.join("window.json")
}

/// `ALEXIA_WINDOW_PORT`, else 0 (any free port).
fn window_port() -> Res<u16> {
    match std::env::var("ALEXIA_WINDOW_PORT") {
        Ok(p) if !p.trim().is_empty() => p
            .trim()
            .parse()
            .map_err(|_| "ALEXIA_WINDOW_PORT is not a port number (0 to 65535).".into()),
        _ => Ok(0),
    }
}

/// `ALEXIA_UI_DIR` when it is an absolute folder path; else None (the page then says so).
fn ui_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("ALEXIA_UI_DIR")?);
    if dir.is_absolute() {
        Some(dir)
    } else {
        tracing::warn!("ALEXIA_UI_DIR is not an absolute path; the window's files are not served");
        None
    }
}

/// `{"port":..,"pid":..}`, written to `.tmp` and renamed so a reader never sees half of it.
/// The token is not in it.
fn write_window_json(layout: &Layout, port: u16) -> std::io::Result<()> {
    let path = window_json(layout);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::json!({ "port": port, "pid": std::process::id() });
    std::fs::write(&tmp, body.to_string())?;
    std::fs::rename(&tmp, &path)
}

/// INTERFACES §2.6 steps 3 to 12, in that order (steps 1 and 2 are `open`).
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
    let asker = Asker::with_window(
        channels.clone(),
        store.clone(),
        bus.clone(),
        alexia_gateway::WindowQuestions::default(),
    );
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
        ask: asker.clone(),
        checker: checker.clone(),
        caps: caps.clone(),
        layout: Layout::new(layout.root.clone()),
        limits: Limits::default(),
        host: host.clone(),
    });

    // 6. The builtins that hold a `Weak` back-reference, then the scheduler's.
    tooling.add_builtin(Helpers::new(&agent));
    tooling.add_builtin(UndoTool::new(&agent));
    let scheduler = Scheduler::with_sources(
        store.clone(),
        bus.clone(),
        agent.clone(),
        Arc::new(HostSources::new(host.clone())),
    );
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
    let skills = Arc::new(skills);
    tooling.add_builtin(skills.clone());

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
        router.clone(),
        caps.clone(),
        store.clone(),
        Budget::CHAT,
    ));
    let lanes = Arc::new(Lanes::new(fast_chat.clone(), agent.clone()));
    // DY-10: "+ buy milk" is a note before it is anything else.
    let brain: Arc<dyn Brain> = Arc::new(QuickNotes::new(agent.clone(), lanes));
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
        brain.clone(),
        media,
        channels.clone(),
    );
    // HB-04: the window is a face of the handoff. Its channel is registered after the chats, so
    // questions go to them first, and before the gateway runs; the api gets the clone below.
    let window = Arc::new(alexia_api::WindowChannel::new(&bus));
    channels.add(window.clone());
    let handoff = gateway.clone();
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

    // 11. Scheduler → PC activity → resumed runs → GPU watch → catalog news.
    {
        let (c, scheduler) = (root.child_token(), scheduler.clone());
        tracker.spawn(async move {
            if let Err(e) = scheduler.run(c).await {
                tracing::error!("the scheduler stopped: {e}");
            }
        });
    }
    proactive::spawn_activity_watch(bus.clone(), root.child_token());
    let resumed = resume::resume_all(agent.clone(), tracker, root.child_token()).await;
    if resumed > 0 {
        tracing::info!("{resumed} unfinished runs picked up again");
    }
    watch_gpu(
        tracker,
        root,
        &store,
        host.clone(),
        runtime.clone(),
        jobs.clone(),
    );
    {
        let (bus, catalog) = (bus.clone(), catalog.clone());
        every(tracker, root, Duration::from_secs(600), move || {
            if let Some(text) = news_text(&catalog.news()) {
                bus.publish(Event::Say {
                    at: now_ms(),
                    text,
                    urgency: Urgency::Normal,
                    job: None,
                    notice: None,
                    to: None,
                });
            }
        });
    }

    // 12. The window's API, on 127.0.0.1 only (D-P2D-2); its port in `window.json`.
    let api = Api::new(ApiParts {
        layout: Layout::new(layout.root.clone()),
        store: store.clone(),
        bus: bus.clone(),
        host,
        tooling,
        agent,
        brain,
        router,
        catalog,
        scheduler,
        asker,
        channels,
        skills,
        runtime,
        jobs,
        ui_dir: ui_dir(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
    })?;
    api.join_handoff(handoff, &window);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", window_port()?)).await?;
    let port = listener.local_addr()?.port();
    write_window_json(layout, port)?;
    {
        let c = root.child_token();
        tracker.spawn(async move {
            if let Err(e) = api.serve(listener, c).await {
                tracing::error!("the window's server stopped: {e}");
            }
        });
    }
    tracing::info!("the window answers on 127.0.0.1:{port}");

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

/// `key` as (owner, key): one of [`secret_keys`] for `_core`, or `<plugin>.<key>` for a `password`
/// setting a discovered manifest declares. Never echoes `key`: it may be a pasted token (P2-10).
fn known_key(key: &str) -> Res<(String, String)> {
    let mut keys = secret_keys();
    if keys.iter().any(|k| k == key) {
        return Ok(("_core".into(), key.into()));
    }
    for m in McpHost::scan(&plugin_dirs(&Layout::new(data_dir())))
        .into_values()
        .map(|d| d.manifest)
    {
        for k in m.password_keys() {
            let full = format!("{}.{k}", m.id);
            if full == key {
                return Ok((m.id, k));
            }
            keys.push(full);
        }
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
    let (owner, key) = known_key(key)?;
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
    secrets::set(&owner, &key, value)?;
    println!("Saved.");
    Ok(())
}

fn secret_clear(key: &str) -> Res<()> {
    let (owner, key) = known_key(key)?;
    refuse_in_memory()?;
    secrets::delete(&owner, &key)?;
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

// ---- the P2 verbs (P2-48): parsing and printing only; the work is the library's ----

fn store() -> Res<Store> {
    Ok(Store::open(&Layout::new(data_dir()).db())?)
}

/// UTC "YYYY-MM-DD HH:MM:SS" from epoch ms.
fn utc(ms: alexia_store::Ms) -> String {
    let (y, m, d, h, mi, s) = alexia_store::civil_utc(ms);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// `[--last N] words…` → (N, words).
fn last_n<'a>(rest: &[Option<&'a str>], default: u32) -> Res<(u32, Vec<&'a str>)> {
    let mut words = rest
        .iter()
        .map(|w| w.ok_or("The arguments must be text."))
        .collect::<Result<Vec<&str>, _>>()?;
    let mut n = default;
    if let Some(i) = words.iter().position(|w| *w == "--last") {
        n = words
            .get(i + 1)
            .and_then(|v| v.parse().ok())
            .filter(|n| *n > 0)
            .ok_or("--last needs a number of at least 1.")?;
        words.drain(i..=i + 1);
    }
    Ok((n, words))
}

/// AC-12: one line per audited call, newest first.
fn activity(rest: &[Option<&str>]) -> Res<()> {
    let (n, words) = last_n(rest, 50)?;
    let text = words.join(" ");
    let rows = trace::activity(&store()?, Some(text.as_str()).filter(|t| !t.is_empty()), n)?;
    if rows.is_empty() {
        println!("No tool calls recorded.");
    }
    for r in rows {
        let ok = match r.ok {
            Some(true) => "ok",
            Some(false) => "failed",
            None => "-",
        };
        println!(
            "{}\t{}\t{}\t{}\t{ok}\t{}",
            utc(r.at),
            r.run,
            r.tool,
            r.decision,
            r.summary
        );
    }
    Ok(())
}

/// TR-08: the newest runs, one line each.
fn runs(rest: &[Option<&str>]) -> Res<()> {
    let (n, words) = last_n(rest, 20)?;
    if !words.is_empty() {
        return Err(USAGE.into());
    }
    let rows = store()?.runs(n)?;
    if rows.is_empty() {
        println!("No runs recorded.");
    }
    for (id, at, body) in rows {
        let summary = trace::summary(&body);
        let first = summary.lines().next().unwrap_or("");
        println!("{id}\t{}\t{}\t{first}", utc(at), trace::ending(&body));
    }
    Ok(())
}

/// TR-08: one run replayed as text.
fn run_show(id: &str) -> Res<()> {
    match trace::replay(&store()?, id)? {
        Some(text) => {
            println!("{text}");
            Ok(())
        }
        None => Err("No run has that id. `alexia-hub runs` lists them.".into()),
    }
}

/// AC-10: the questions still waiting, with their ids.
fn approvals() -> Res<()> {
    let rows = store()?.approvals_pending()?;
    if rows.is_empty() {
        println!("No questions are waiting.");
    }
    for a in rows {
        let detail = a.detail.map(|d| format!("\t{d}")).unwrap_or_default();
        println!(
            "{}\t{}\t{}\t{}{detail}",
            a.id,
            utc(a.asked_at),
            a.run,
            a.text
        );
    }
    Ok(())
}

/// A router over no providers: enough to read and write the owner's pins.
fn pins_router(store: Arc<Store>) -> Router {
    let cache = Layout::new(data_dir()).cache().join("v3-free-models.json");
    Router::new(vec![], Arc::new(Catalog::new(vec![], vec![], cache)), store)
}

/// Installed local models with their fit on this GPU, then the pins per job.
async fn models_list() -> Res<()> {
    // ponytail: fit at an 8k context; a job that asks for more context can fit less well.
    const CTX: u32 = 8192;
    let store = Arc::new(store()?);
    let machine = gpu::machine().await;
    let headroom = gpu::headroom_mb(&store);
    match &machine {
        Some(m) => println!(
            "gpu\t{}\t{} MB free of {} MB",
            m.gpu.as_deref().unwrap_or("unknown"),
            m.free_mb,
            m.vram_mb
        ),
        None => println!("gpu\tnone found (no NVIDIA GPU or driver)"),
    }
    for i in hf::installed(&store) {
        let fit = machine.as_ref().map_or("no GPU", |gpu_now| {
            let m = &i.meta;
            let ctx = match m.context {
                0 => CTX,
                c => c.min(CTX),
            };
            match gpu::fit(
                gpu_now,
                m.bytes,
                m.layers,
                m.kv_bytes_per_token,
                ctx,
                headroom,
            )
            .verdict
            {
                gpu::Verdict::Fits => "fits",
                gpu::Verdict::Tight => "fits, tightly",
                gpu::Verdict::TooBig => "too big for the GPU",
            }
        });
        let mb = i.meta.bytes.div_ceil(1024 * 1024);
        println!("model\tlocal:{}\t{}\t{mb} MB\t{fit}", i.id, i.meta.arch);
    }
    for (job, pins) in pins_router(store).pins() {
        println!("pin\t{job}\t{}", pins.join(", "));
    }
    Ok(())
}

/// MO-13: download `repo`'s `quant` and record it.
async fn models_import(repo: &str, quant: &str) -> Res<()> {
    let layout = Layout::new(data_dir());
    let store = Store::open(&layout.db())?;
    println!("Downloading… (Ctrl+C stops; running this again resumes)");
    let client = reqwest::Client::new();
    let m = hf::import_repo(
        repo,
        quant,
        &layout,
        &client,
        None,
        CancellationToken::new(),
    )
    .await?;
    hf::record(&store, &m)?;
    println!("installed\tlocal:{}", m.id);
    Ok(())
}

/// MO-13: a GGUF already on disk, used where it lies.
fn models_import_file(path: &OsStr) -> Res<()> {
    let layout = Layout::new(data_dir());
    let store = Store::open(&layout.db())?;
    let m = hf::import_file(Path::new(path), &layout, false)?;
    hf::record(&store, &m)?;
    println!("installed\tlocal:{}", m.id);
    Ok(())
}

/// MO-14, MO-05: `auto` unpins the job; anything else becomes its one pin.
fn models_use(job: &str, pin: &str) -> Res<()> {
    let job: Job = serde_json::from_value(serde_json::json!(job))
        .map_err(|_| "Jobs are chat, plan, step, code, vision, check and local.")?;
    let store = Arc::new(store()?);
    let pins = if pin == "auto" {
        vec![]
    } else if let Some(id) = pin.strip_prefix("local:") {
        if !hf::installed(&store).iter().any(|i| i.id == id) {
            return Err("No local model has that id. `alexia-hub models` lists them.".into());
        }
        vec![pin.to_owned()]
    } else if pin
        .strip_prefix("subscription:")
        .is_some_and(|c| !c.is_empty())
        || pin
            .split_once('/')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
    {
        vec![pin.to_owned()]
    } else {
        return Err("A pin is <provider>/<model>, subscription:<cli>, local:<id> or auto.".into());
    };
    let unpinned = pins.is_empty();
    pins_router(store).set_pins(job, pins)?;
    println!(
        "{}",
        if unpinned {
            "Unpinned: the router picks."
        } else {
            "Pinned."
        }
    );
    Ok(())
}

/// `add`/`remove` one folder in `list`. A folder added must exist.
fn edit_folders(list: &mut Vec<String>, verb: &str, folder: &OsStr) -> Res<()> {
    let abs = std::path::absolute(folder)?;
    let text = abs
        .to_str()
        .ok_or("The folder's name must be text.")?
        .to_owned();
    if verb == "add" {
        if !abs.is_dir() {
            return Err("That folder does not exist.".into());
        }
        if !list.contains(&text) {
            list.push(text);
        }
    } else {
        let before = list.len();
        list.retain(|f| f != &text);
        if list.len() == before {
            return Err("That folder is not in the list.".into());
        }
    }
    Ok(())
}

/// MO-09: `_core.gpu.games`, the folders `gpu::game_dirs` adds to Steam's and Epic's.
fn games(edit: Option<(&str, &OsStr)>) -> Res<()> {
    let store = store()?;
    let mut list: Vec<String> = match store.settings("_core")?.get("gpu.games") {
        None => vec![],
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|_| "The saved game folders are not readable, so nothing was changed.")?,
    };
    if let Some((verb, folder)) = edit {
        edit_folders(&mut list, verb, folder)?;
        store.set_setting("_core", "gpu.games", &serde_json::json!(list))?;
    }
    list.iter().for_each(|f| println!("{f}"));
    Ok(())
}

/// TR-01: the `roots` of `_core.scope`; what is listed is what `permissions::scope` reads back.
fn scope(edit: Option<(&str, &OsStr)>) -> Res<()> {
    const UNREADABLE: &str = "The saved folders are not readable, so nothing was changed.";
    let layout = Layout::new(data_dir());
    let store = Store::open(&layout.db())?;
    if let Some((verb, folder)) = edit {
        if verb == "add" && permissions::never_touch(&std::path::absolute(folder)?, &layout.root) {
            return Err("That folder is on the never-touch list, so it cannot be added.".into());
        }
        let mut saved = match store.kv_get("_core", "scope")? {
            Some(serde_json::Value::Object(o)) => o,
            None | Some(serde_json::Value::Null) => serde_json::Map::new(),
            Some(_) => return Err(UNREADABLE.into()),
        };
        let mut roots: Vec<String> = match saved.get("roots") {
            None | Some(serde_json::Value::Null) => vec![],
            Some(v) => serde_json::from_value(v.clone()).map_err(|_| UNREADABLE)?,
        };
        edit_folders(&mut roots, verb, folder)?;
        saved.insert("roots".into(), serde_json::json!(roots));
        store.kv_set("_core", "scope", &serde_json::Value::Object(saved))?;
    }
    let scope = permissions::scope(&store, &layout.root);
    if scope.everywhere {
        println!("everywhere");
    }
    scope.roots.iter().for_each(|r| println!("{}", r.display()));
    Ok(())
}

/// TR-09. The library refuses while the hub holds the database.
fn encrypt() -> Res<()> {
    if secrets::in_memory() {
        eprintln!("Secrets are in memory (ALEXIA_SECRETS_IN_MEMORY is set): the key is lost when this exits.");
    }
    alexia_store::encrypt::encrypt(&Layout::new(data_dir()).db())?;
    println!(
        "Encrypted. The key is in Credential Manager; without it the database cannot be read."
    );
    Ok(())
}

// ---- the P3 verbs (P3-31): the work is core's, shared with the slash commands ----

/// Prints what a command answered; its refusal is the error.
fn say(answer: Result<String, String>) -> Res<()> {
    println!("{}", answer?);
    Ok(())
}

/// The newest notices, one line each; `--week` is everything touched in the last seven days.
fn notices(rest: &[Option<&str>]) -> Res<()> {
    const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
    let week = rest.contains(&Some("--week"));
    let (n, words) = last_n(rest, if week { u32::MAX } else { 20 })?;
    if words.iter().any(|w| *w != "--week") {
        return Err(USAGE.into());
    }
    let since = if week { now_ms() - WEEK_MS } else { 0 };
    let rows = store()?.notices_since(since, n)?;
    if rows.is_empty() {
        println!("No notices recorded.");
    }
    for r in rows {
        let text = r.text.split_whitespace().collect::<Vec<_>>().join(" ");
        println!(
            "{}\t{}\t{}\t{}\t{}\t{text}",
            r.id,
            utc(r.updated_at),
            r.state,
            r.urgency,
            r.source
        );
    }
    Ok(())
}

fn quiet(f: impl FnOnce(&Store, alexia_store::Ms) -> Result<String, String>) -> Res<()> {
    say(f(&store()?, now_ms()))
}

fn quiet_pause(minutes: &str) -> Res<()> {
    let minutes: u64 = minutes
        .parse()
        .map_err(|_| "Say how many minutes: alexia-hub quiet pause 60.")?;
    quiet(|s, now| commands::quiet_pause(s, minutes, now))
}

/// Whether a hub holds `hub.lock`. Off Windows the lock tells nothing, so one is assumed.
fn hub_running(root: &Path) -> Res<bool> {
    if cfg!(not(windows)) {
        return Ok(true);
    }
    match hub_lock(root) {
        // Taken here, so nothing held it; dropped at once.
        Ok(_) => Ok(false),
        Err(e) if e.to_string() == ANOTHER_HUB => Ok(true),
        Err(e) => Err(e),
    }
}

/// kv `_core`/`brief.ask`: the running scheduler's brief clock picks it up within a minute.
fn brief_ask(kind: &str) -> Res<()> {
    if !matches!(kind, "morning" | "evening" | "weekly") {
        return Err("A brief is morning, evening or weekly.".into());
    }
    let layout = Layout::new(data_dir());
    if !hub_running(&layout.root)? {
        return Err("The hub is not running.".into());
    }
    Store::open(&layout.db())?.kv_set(
        "_core",
        alexia_scheduler::brief::ASK,
        &serde_json::json!({ "kind": kind, "at": now_ms() }),
    )?;
    println!("Asked: the {kind} brief comes within a minute.");
    Ok(())
}

/// The tool's own annotations decide, so the plugins are started to list them.
async fn silent_allow(tool: &str) -> Res<()> {
    let hub = boot(&Layout::new(data_dir())).await?;
    let open_world = hub
        .host
        .tools()
        .await
        .iter()
        .find(|t| !t.hidden && namespaced(&t.plugin, &t.tool.name) == tool)
        .map(|t| t.tool.annotations.as_ref().and_then(|a| a.open_world_hint) == Some(true));
    hub.host.shutdown().await;
    if open_world.is_none() {
        return Err(format!(
            "No plugin has a tool called {tool}. A tool id is <plugin>__<tool>, as `alexia-hub tools` lists them; Alexia's own tools are allowed with /silent in your chat."
        )
        .into());
    }
    say(commands::silent_allow(&hub.store, tool, open_world))
}

fn mute_remove(id: &str) -> Res<()> {
    let number: i64 = id
        .trim_start_matches('#')
        .parse()
        .map_err(|_| "Say which one by its number: `alexia-hub mute list` shows them.")?;
    if !store()?.mute_remove(number)? {
        return Err("There is no mute with that number.".into());
    }
    println!("Removed.");
    Ok(())
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
