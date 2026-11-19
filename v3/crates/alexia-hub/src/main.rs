// SPDX-License-Identifier: AGPL-3.0-only
//! Wires everything together on the Windows PC; CLI; the v2 bridge.
//!
//! The hub never names a plugin: ids come from manifests at runtime.

mod bridge;
mod latency;
mod watchdog;

use std::collections::HashSet;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use alexia_core::{Bus, Event};
use alexia_mcp::{
    discover, EventSink, HostConfig, Manifest, McpHost, NoUpcalls, PluginId, PluginState, Timings,
};
use alexia_store::import::{import_v2, import_v2_files};
use alexia_store::{data_dir, secrets, Layout, Store};
use tokio_util::sync::CancellationToken;

const USAGE: &str = "usage:
  alexia-hub run                                   start everything; Ctrl+C stops it cleanly
  alexia-hub tools                                 load plugins, print every enabled plugin's tools
  alexia-hub plugins                               print the status of every plugin found
  alexia-hub import-v2 [--files-only] <v2-folder>  import a v2 data folder";

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

/// Every plugin found in `dirs`, the first folder holding an id winning.
fn discovered(dirs: &[PathBuf]) -> Vec<Manifest> {
    let mut seen = HashSet::new();
    dirs.iter()
        .flat_map(|d| discover(d))
        .filter_map(|r| r.ok())
        .map(|p| p.manifest)
        .filter(|m| seen.insert(m.id.clone()))
        .collect()
}

struct Hub {
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
        None => discovered(&dirs)
            .into_iter()
            .map(|m| PluginId(m.id))
            .collect(),
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
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), sink);
    host.start(&enabled).await?;
    Ok(Hub { host, bus })
}

async fn run() -> Res<()> {
    let layout = Layout::new(data_dir());
    let hub = boot(&layout).await?;
    let root = CancellationToken::new();
    // Test hook: with ALEXIA_HUB_STOP_ON_EOF=1, stdin reaching EOF behaves like Ctrl+C
    // (a real Ctrl+C can't be sent to a child on Windows without unsafe code).
    if std::env::var_os("ALEXIA_HUB_STOP_ON_EOF").is_some_and(|v| v == "1") {
        let stop = root.clone();
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            stop.cancel();
        });
    }
    println!("Alexia hub is running. Press Ctrl+C to stop.");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = root.cancelled() => {}
    }
    hub.host.shutdown().await;
    hub.bus.publish(Event::ShuttingDown);
    println!("Stopped.");
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
    for m in discovered(&plugin_dirs(&layout)) {
        for key in m.password_keys() {
            if matches!(secrets::get(&m.id, &key), Ok(None)) {
                println!("secret missing\t{}.{key}", m.id);
            }
        }
    }
    Ok(())
}
