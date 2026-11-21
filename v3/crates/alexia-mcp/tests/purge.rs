// SPDX-License-Identifier: AGPL-3.0-only
//! Invariant check 5: purging a plugin leaves no residue, in the database, the keychain or
//! the data folder.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use alexia_mcp::{CallCtx, CallError, HostConfig, McpHost, NoUpcalls, PluginId, Timings};
use alexia_store::{secrets, Layout, Store};
use serde_json::{json, Map, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");
const ID: &str = "purged";

fn plugin(dir: &Path) {
    let path = dir.join(ID);
    std::fs::create_dir_all(&path).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, path.join(exe)).unwrap();
    let m = json!({
        "manifest_version": 1,
        "id": ID,
        "name": "Purged",
        "summary": "A plugin that exists to be purged.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": ["storage"] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25",
        "requires": [{"cap": "fs.own_dir", "why": "To keep a file."}],
        "storage": {"namespace": ID, "tables": ["notes"]},
        "settings": [
            {"key": "state", "type": "status", "label": "State"},
            {"key": "token", "type": "password", "label": "Token"}
        ]
    });
    std::fs::write(path.join("plugin.json"), m.to_string()).unwrap();
}

/// `sqlite_master` and every table's rows, as text.
fn db_snapshot(store: &Store) -> Vec<String> {
    store
        .transaction(|tx| {
            let mut out = vec![];
            let mut stmt = tx.prepare(
                "SELECT type, name, IFNULL(sql, '') FROM sqlite_master ORDER BY type, name",
            )?;
            let master = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (kind, name, sql) in master {
                out.push(format!("{kind} {name}: {sql}"));
                if kind != "table" {
                    continue;
                }
                let quoted = name.replace('"', "\"\"");
                let mut rows = tx.prepare(&format!("SELECT * FROM \"{quoted}\" ORDER BY 1"))?;
                let n = rows.column_count();
                let lines = rows
                    .query_map([], |r| {
                        let cells = (0..n)
                            .map(|i| r.get_ref(i).map(|v| format!("{v:?}")))
                            .collect::<Result<Vec<_>, _>>()?;
                        Ok(format!("  {name}: {}", cells.join(" | ")))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                out.extend(lines);
            }
            Ok(out)
        })
        .unwrap()
}

/// Every path under `dir`, relative and sorted.
fn files(dir: &Path) -> Vec<PathBuf> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.map(Result::unwrap) {
            let p = e.path();
            out.push(p.strip_prefix(base).unwrap().to_path_buf());
            if p.is_dir() {
                walk(base, &p, out);
            }
        }
    }
    let mut out = vec![];
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test]
async fn purge_leaves_no_residue() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let root = Scratch::new("purge");
    plugin(&root.join("ext"));
    let data = root.join("data");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let cfg = HostConfig {
        layout: Layout::new(data.clone()),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
    };
    let host = McpHost::new(cfg, store.clone(), Arc::new(NoUpcalls), Arc::new(|_| {}));
    let id = PluginId(ID.into());
    // Installed but off: nothing of it exists yet.
    host.start(&[]).await.unwrap();
    let (db_before, files_before) = (db_snapshot(&store), files(&data));

    host.set_enabled(&id, true).await.unwrap();
    let call = |name: &'static str, a: Value| {
        let host = host.clone();
        let id = id.clone();
        async move {
            let r = host
                .call_tool(&id, name, args(a), CallCtx::default())
                .await
                .unwrap();
            assert_ne!(r.is_error, Some(true), "{:?}", r.content);
        }
    };
    call("remember", json!({"text": "a note"})).await;
    call("store", json!({"key": "k", "value": {"n": 1}})).await;
    host.serve_for_test(
        &id,
        "alexia/settings/set",
        json!({"key": "state", "value": "busy"}),
    )
    .await
    .unwrap();
    secrets::set(ID, "token", &format!("{}-{}", "to-be", "purged")).unwrap();
    let info = host
        .serve_for_test(&id, "alexia/host/info", json!({}))
        .await
        .unwrap();
    let own = PathBuf::from(info["paths"]["ownDir"].as_str().unwrap());
    std::fs::write(own.join("kept.txt"), "residue unless purged").unwrap();
    std::fs::write(
        PathBuf::from(info["paths"]["cacheDir"].as_str().unwrap()).join("c.bin"),
        "cache",
    )
    .unwrap();
    // The use really left something everywhere the purge has to look.
    assert_ne!(db_snapshot(&store), db_before);
    assert_ne!(files(&data), files_before);
    assert!(host.pid(&id).is_some());

    host.purge(&id).await.unwrap();

    assert_eq!(host.pid(&id), None);
    assert_eq!(db_snapshot(&store), db_before);
    assert_eq!(files(&data), files_before);
    assert_eq!(secrets::get(ID, "token").unwrap(), None);
    host.shutdown().await;
}

#[tokio::test]
async fn purge_disables_before_deleting() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let root = Scratch::new("purge-off");
    plugin(&root.join("ext"));
    let layout = Layout::new(root.join("data"));
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
    };
    let store = Arc::new(Store::open_in_memory().unwrap());
    let host = McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}));
    let id = PluginId(ID.into());
    host.start(std::slice::from_ref(&id)).await.unwrap();
    let r = host
        .call_tool(
            &id,
            "remember",
            args(json!({"text": "a note"})),
            CallCtx::default(),
        )
        .await
        .unwrap();
    assert_ne!(r.is_error, Some(true), "{:?}", r.content);
    host.serve_for_test(&id, "alexia/host/info", json!({}))
        .await
        .unwrap();
    let own = layout.own_dir(ID);
    assert!(own.exists());

    host.purge(&id).await.unwrap();

    // Off, not merely stopped: a late call is refused instead of respawning the plugin.
    let late = host
        .call_tool(
            &id,
            "remember",
            args(json!({"text": "late"})),
            CallCtx::default(),
        )
        .await;
    assert!(matches!(late, Err(CallError::Off { .. })), "{late:?}");
    assert_eq!(host.pid(&id), None);
    assert!(!own.exists());
    host.shutdown().await;
}

#[test]
fn purge_continues_after_a_secret_fails() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let owner = "purge-partial";
    for k in ["first", "last"] {
        secrets::set(owner, k, "x").unwrap();
    }
    // The middle key is refused (not a valid key); the ones around it must still go.
    let keys = [
        "first".to_string(),
        "NOT A KEY".to_string(),
        "last".to_string(),
    ];
    assert!(secrets::delete_all(owner, &keys).is_err());
    assert_eq!(secrets::get(owner, "first").unwrap(), None);
    assert_eq!(secrets::get(owner, "last").unwrap(), None);
}

#[tokio::test]
async fn purge_removes_cache_dir_when_data_dir_fails() {
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    let root = Scratch::new("purge-fail");
    plugin(&root.join("ext"));
    let layout = Layout::new(root.join("data"));
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
    };
    let host = McpHost::new(
        cfg,
        Arc::new(Store::open_in_memory().unwrap()),
        Arc::new(NoUpcalls),
        Arc::new(|_| {}),
    );
    host.start(&[]).await.unwrap();
    // A file where the data dir should be: remove_dir_all refuses it, and it is not NotFound.
    let own = layout.own_dir(ID);
    std::fs::create_dir_all(own.parent().unwrap()).unwrap();
    std::fs::write(&own, "not a directory").unwrap();
    let cache = layout.cache().join(ID);
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("c.bin"), "cache").unwrap();

    let r = host.purge(&PluginId(ID.into())).await;

    assert!(r.is_err(), "the data dir failure is returned");
    assert!(!cache.exists(), "the cache dir is removed anyway");
    host.shutdown().await;
}
