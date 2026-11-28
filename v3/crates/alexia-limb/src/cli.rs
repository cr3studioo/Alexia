// SPDX-License-Identifier: AGPL-3.0-only
//! `alexia-limb <command>`: the argument parser and every command. Plain sentences on stdout;
//! a failure is one sentence on stderr and exit 1.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_mcp::{HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_mesh::node::{Node, NodeConfig};
use alexia_mesh::ops::HubOp;
use alexia_mesh::pair::{parse_pair_uri, BAD_URI};
use alexia_mesh::{DeviceId, Hello, Reach, Role, KEYCHAIN_LIMB};
use alexia_store::{DeviceRow, Layout, Store};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::serve::{self, Facts};
use crate::service;

const USAGE: &str = "\
usage:
  alexia-limb run                         serve this device's plugins to the paired hub
  alexia-limb pair \"<alexia-pair:1?...>\"  pair with the hub that shows this code
  alexia-limb unpair                      forget the hub
  alexia-limb status                      this device, its hub and its plugins
  alexia-limb plugins                     the plugins found on this device
  alexia-limb plugins enable|disable <id> switch one on or off
  alexia-limb install | uninstall         start the limb with this device, or stop that";

/// kv namespace and key of the enabled plugin ids. Absent: none (the limb enables nothing by default).
const KV_NS: &str = "_limb";
const KV_ENABLED: &str = "enabled";
/// How often the limb reports presence and re-reads its enabled plugins.
const TICK: Duration = Duration::from_secs(30);
/// How long `status` waits to learn how the hub is reached.
const REACH_WAIT: Duration = Duration::from_secs(20);

type Res<T> = Result<T, String>;

/// The limb's data folder: `limb` inside the data folder, never the hub's own (D-P4-6).
pub fn layout() -> Layout {
    Layout::new(alexia_store::data_dir().join("limb"))
}

/// Where plugins are found: the limb's `extensions`, then `ALEXIA_PLUGINS_DIR` if set.
pub fn plugin_dirs(layout: &Layout) -> Vec<PathBuf> {
    let mut dirs = vec![layout.extensions()];
    dirs.extend(std::env::var_os("ALEXIA_PLUGINS_DIR").map(PathBuf::from));
    dirs
}

/// "windows", "macos", …
pub const PLATFORM: &str = std::env::consts::OS;

/// Parse `args` (without the program name) and run the command.
pub async fn main(args: &[String]) -> ExitCode {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match words.as_slice() {
        ["run"] => run().await,
        ["pair", uri] => pair(uri).await,
        ["unpair"] => unpair().await,
        ["status"] => status().await,
        ["plugins"] => plugins(),
        ["plugins", verb @ ("enable" | "disable"), id] => switch(id, *verb == "enable"),
        ["install"] => service::install(),
        ["uninstall"] => service::uninstall(),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(sentence) => {
            eprintln!("{sentence}");
            ExitCode::FAILURE
        }
    }
}

fn open_store(layout: &Layout) -> Res<Arc<Store>> {
    Store::open(&layout.db())
        .map(Arc::new)
        .map_err(|e| format!("The limb's data could not be opened ({e})."))
}

/// What this device is called on the hub: its host name.
pub fn device_name() -> String {
    let mut cmd = std::process::Command::new("hostname");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "This device".into())
}

async fn start_node(store: Arc<Store>) -> Res<Arc<Node>> {
    let cfg = NodeConfig {
        keychain: KEYCHAIN_LIMB.into(),
        name: device_name(),
        role: Role::Limb,
        ephemeral: false,
        extra_addresses: vec![],
    };
    Node::start(cfg, store).await.map_err(|e| e.to_string())
}

/// The paired hubs (there is normally one).
fn hubs(store: &Store) -> Res<Vec<DeviceRow>> {
    let devices = store
        .devices()
        .map_err(|e| format!("The limb's devices could not be read ({e})."))?;
    Ok(devices.into_iter().filter(|d| d.role == "hub").collect())
}

/// kv `_limb`/`enabled`: the plugin ids switched on. Absent means none.
pub fn enabled(store: &Store) -> Res<Vec<PluginId>> {
    let unreadable = || "The list of enabled plugins is not readable.".to_string();
    match store.kv_get(KV_NS, KV_ENABLED).map_err(|_| unreadable())? {
        None => Ok(vec![]),
        Some(v) => serde_json::from_value::<Vec<String>>(v)
            .map(|ids| ids.into_iter().map(PluginId).collect())
            .map_err(|_| unreadable()),
    }
}

/// Write the enabled list: `ids`, sorted, without repeats.
pub fn set_enabled(store: &Store, ids: &[PluginId]) -> Res<()> {
    let mut list: Vec<&str> = ids.iter().map(|id| id.0.as_str()).collect();
    list.sort_unstable();
    list.dedup();
    store
        .kv_set(KV_NS, KV_ENABLED, &serde_json::json!(list))
        .map_err(|e| format!("The list of enabled plugins could not be saved ({e})."))
}

// ---- pair, unpair, status ----

async fn pair(uri: &str) -> Res<()> {
    // Before anything is opened: a bad code touches neither the store nor the keychain.
    if parse_pair_uri(uri).is_none() {
        return Err(BAD_URI.into());
    }
    let layout = layout();
    let store = open_store(&layout)?;
    let node = start_node(store).await?;
    let hello = Hello {
        role: Role::Limb,
        platform: PLATFORM.into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        wake: vec![],
    };
    let joined = node.pair_join(uri, &hello).await;
    node.close().await;
    let hub = joined.map_err(|e| e.to_string())?;
    println!("Paired with {}.", hub.name);
    Ok(())
}

async fn unpair() -> Res<()> {
    let store = open_store(&layout())?;
    let hubs = hubs(&store)?;
    if hubs.is_empty() {
        println!("This device is not paired with a hub.");
        return Ok(());
    }
    let node = start_node(store).await?;
    let mut failed = None;
    for hub in &hubs {
        match node.revoke(&DeviceId(hub.id.clone())).await {
            Ok(_) => println!("Unpaired from {}.", hub.name),
            Err(e) => failed = Some(e.to_string()),
        }
    }
    node.close().await;
    failed.map_or(Ok(()), Err)
}

async fn status() -> Res<()> {
    let layout = layout();
    let store = open_store(&layout)?;
    let node = start_node(store.clone()).await?;
    println!(
        "This device: {} ({PLATFORM}), endpoint {}.",
        node.name(),
        node.endpoint().0
    );
    let hubs = hubs(&store)?;
    if hubs.is_empty() {
        println!("Not paired with a hub.");
    }
    for hub in &hubs {
        let reach = tokio::time::timeout(REACH_WAIT, node.connect(&DeviceId(hub.id.clone()))).await;
        let how = match reach {
            Ok(Ok(Reach::Direct)) => "reached directly",
            Ok(Ok(Reach::Relayed)) => "reached through a relay",
            _ => "not reachable right now",
        };
        println!("Hub: {}, {how}.", hub.name);
    }
    node.close().await;
    print_plugins(&layout, &store)
}

// ---- plugins ----

fn print_plugins(layout: &Layout, store: &Store) -> Res<()> {
    let on = enabled(store)?;
    let found = McpHost::scan(&plugin_dirs(layout));
    if found.is_empty() {
        println!("No plugins were found on this device.");
        return Ok(());
    }
    for (id, dir) in &found {
        let state = if on.contains(id) { "on" } else { "off" };
        println!(
            "{} ({} {}): {state}.",
            id.0, dir.manifest.name, dir.manifest.version
        );
    }
    Ok(())
}

fn plugins() -> Res<()> {
    let layout = layout();
    let store = open_store(&layout)?;
    print_plugins(&layout, &store)
}

fn switch(id: &str, on: bool) -> Res<()> {
    let layout = layout();
    let store = open_store(&layout)?;
    let id = PluginId(id.into());
    let found = McpHost::scan(&plugin_dirs(&layout));
    let Some(dir) = found.get(&id) else {
        return Err(format!(
            "No plugin called {} is in this device's plugin folders.",
            id.0
        ));
    };
    let mut list = enabled(&store)?;
    list.retain(|x| *x != id);
    if on {
        list.push(id.clone());
    }
    set_enabled(&store, &list)?;
    let word = if on { "on" } else { "off" };
    println!(
        "{} is {word}. A running limb picks this up within a minute.",
        dir.manifest.name
    );
    Ok(())
}

// ---- run ----

/// `ALEXIA_NODE`, else `node` on PATH, else the literal `node`.
fn node_exe() -> PathBuf {
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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The host for `layout`: its plugin folders, no upcalls yet (P4-14), events to `changes`.
pub fn host(layout: &Layout, store: Arc<Store>, changes: broadcast::Sender<()>) -> McpHost {
    let cfg = HostConfig {
        layout: Layout::new(layout.root.clone()),
        plugin_dirs: plugin_dirs(layout),
        node: node_exe(),
        timings: Timings::default(),
        dial: None,
    };
    McpHost::new(cfg, store, Arc::new(NoUpcalls), serve::sink(changes))
}

/// Make the host's enabled plugins match kv `_limb`/`enabled` (written by `plugins enable`).
async fn sync_enabled(host: &McpHost, store: &Store) {
    let Ok(want) = enabled(store) else {
        return;
    };
    for p in host.plugins() {
        let on = want.contains(&p.id);
        if p.enabled != on {
            if let Err(e) = host.set_enabled(&p.id, on).await {
                tracing::warn!(plugin = %p.id.0, "switching a plugin failed: {e}");
            }
        }
    }
}

async fn run() -> Res<()> {
    let layout = layout();
    let store = open_store(&layout)?;
    let (changes, _) = broadcast::channel(16);
    let host = host(&layout, store.clone(), changes.clone());
    host.start(&enabled(&store)?)
        .await
        .map_err(|e| format!("The plugins could not be started ({e})."))?;
    let node = match start_node(store.clone()).await {
        Ok(node) => node,
        Err(e) => {
            host.shutdown().await;
            return Err(e);
        }
    };
    // The hub the open link is from, and that link's close switch. One link at a time.
    let current: Arc<Mutex<Option<(DeviceId, CancellationToken)>>> = Arc::default();
    let accepted = {
        let (current, host, changes) = (current.clone(), host.clone(), changes.clone());
        let device_name = node.name().to_string();
        node.accept_links(move |hub, link| {
            let old = lock(&current).replace((hub, link.closed.clone()));
            if let Some((_, old)) = old {
                old.cancel(); // a new link replaces the old one
            }
            let facts = Facts {
                device_name: device_name.clone(),
                platform: PLATFORM,
                changes: changes.clone(),
            };
            tokio::spawn(serve::serve(link, host.clone(), facts));
        })
        .await
    };
    if let Err(e) = accepted {
        node.close().await;
        host.shutdown().await;
        return Err(e.to_string());
    }
    println!(
        "The limb is running as {}. Press Ctrl+C to stop.",
        node.name()
    );
    let stop = tokio::signal::ctrl_c();
    tokio::pin!(stop);
    let mut tick = tokio::time::interval(TICK);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = tick.tick() => {
                sync_enabled(&host, &store).await;
                let hub = lock(&current)
                    .as_ref()
                    .filter(|(_, closed)| !closed.is_cancelled())
                    .map(|(hub, _)| hub.clone());
                if let Some(hub) = hub {
                    if let Some(idle) = alexia_mesh::presence::idle_now().await {
                        let op = HubOp::Presence { from: hub.clone(), idle_ms: idle.idle_ms, locked: idle.locked };
                        if let Err(e) = node.send_op(&hub, &op).await {
                            tracing::info!("presence did not reach the hub: {e}");
                        }
                    }
                }
            }
        }
    }
    if let Some((_, closed)) = lock(&current).take() {
        closed.cancel();
    }
    node.close().await;
    host.shutdown().await;
    println!("The limb stopped.");
    Ok(())
}
