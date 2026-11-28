// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-06: installing a plugin folder (EX-12) and adding an MCP server that is not one
//! (v2 `servers.ts`). Both arrive installed and not enabled; a server is unreviewed until the
//! owner trusts it. The manifests here are written at test time.

mod scratch;
use scratch::Scratch;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use alexia_mcp::{Error, HostConfig, McpHost, NoUpcalls, PluginId, PluginState, Timings};
use alexia_store::{Layout, Store};
use serde_json::{json, Value};

const FIXTURE: &str = env!("CARGO_BIN_EXE_mcp-fixture");

fn host(root: &Path, store: Arc<Store>) -> McpHost {
    let cfg = HostConfig {
        layout: Layout::new(root.join("data")),
        plugin_dirs: vec![root.join("ext")],
        node: PathBuf::from("node"),
        timings: Timings::default(),
        dial: None,
    };
    McpHost::new(cfg, store, Arc::new(NoUpcalls), Arc::new(|_| {}))
}

/// `<root>/src/<id>/`: a plugin folder with the fixture in it and a nested file, outside the
/// extensions dir.
fn source(root: &Path, id: &str, manifest: Value) -> PathBuf {
    let dir = root.join("src").join(id);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, dir.join(exe)).unwrap();
    std::fs::write(dir.join("assets").join("note.txt"), "hello").unwrap();
    std::fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    dir
}

fn manifest(id: &str) -> Value {
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    json!({
        "manifest_version": 1,
        "id": id,
        "name": format!("Plugin {id}"),
        "summary": "A plugin that exists for tests.",
        "version": "0.1.0",
        "license": "AGPL-3.0-only",
        "entry": { "run": exe, "args": ["greet"] },
        "alexia_protocol": 2,
        "mcp_protocol": "2025-11-25"
    })
}

fn refusal(r: Result<PluginId, Error>) -> String {
    match r {
        Err(Error::Refused(s)) => s,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn install_folder_copies_and_scans_disabled() {
    let root = Scratch::new("install-ok");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let h = host(&root, store.clone());
    h.start(&[]).await.unwrap();
    let from = source(&root, "copied", manifest("copied"));

    let id = h.install_folder(&from).await.unwrap();
    assert_eq!(id, PluginId("copied".into()));
    let copied = root.join("ext").join("copied");
    assert!(copied.join("plugin.json").is_file());
    assert_eq!(
        std::fs::read_to_string(copied.join("assets").join("note.txt")).unwrap(),
        "hello"
    );
    assert!(
        from.join("plugin.json").is_file(),
        "the source is left as it was"
    );

    let status = h.plugins();
    let p = status.iter().find(|p| p.id == id).expect("scanned in");
    assert!(!p.enabled, "installed, not enabled");
    assert_eq!(p.state, PluginState::Stopped);
    assert_eq!(h.plugin_dir(&id).unwrap().path, copied);
    assert!(h.tools().await.is_empty(), "nothing offered until enabled");

    // A new id this host has not seen is unreviewed (P2-62), and known from now on.
    let unreviewed: Vec<String> =
        serde_json::from_value(store.kv_get("_core", "unreviewed").unwrap().unwrap()).unwrap();
    assert!(unreviewed.contains(&"copied".to_owned()));

    // Enabled, it runs from the copy.
    h.set_enabled(&id, true).await.unwrap();
    let tools = h.tools().await;
    assert!(tools
        .iter()
        .any(|t| t.plugin == id && t.tool.name == "greet"));
    assert_eq!(h.tool_names(&id).unwrap(), vec!["greet", "secret_tool"]);

    // The same id again is refused with v2's sentence.
    let again = refusal(h.install_folder(&from).await);
    assert_eq!(
        again,
        "copied is already installed. Delete it first to replace it."
    );

    // remove = purge plus the folder and the slot.
    h.remove(&id).await.unwrap();
    assert!(!copied.exists());
    assert!(h.plugins().iter().all(|p| p.id != id));
    h.shutdown().await;
}

#[tokio::test]
async fn install_refuses_bad_manifest() {
    let root = Scratch::new("install-bad");
    let h = host(&root, Arc::new(Store::open_in_memory().unwrap()));
    h.start(&[]).await.unwrap();
    let ext = root.join("ext");

    // Not there; a file; no plugin.json; an unknown field; an id that is not the folder's.
    let missing = refusal(h.install_folder(&root.join("nowhere")).await);
    assert!(missing.starts_with("There is no folder at "), "{missing}");
    let file = root.join("a-file.txt");
    std::fs::write(&file, "x").unwrap();
    let not_dir = refusal(h.install_folder(&file).await);
    assert!(not_dir.ends_with("is a file. Point at the folder that holds plugin.json."));
    let empty = root.join("src").join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(
        refusal(h.install_folder(&empty).await),
        "empty has no readable plugin.json"
    );
    let mut typo = manifest("typo");
    typo["tols"] = json!([]);
    let typo = source(&root, "typo", typo);
    let said = refusal(h.install_folder(&typo).await);
    assert!(said.contains("unknown field “tols”"), "{said}");
    let other = source(&root, "named", manifest("other-name"));
    assert_eq!(
        refusal(h.install_folder(&other).await),
        "named's plugin.json calls it \"other-name\""
    );
    assert_eq!(
        refusal(h.install_folder(Path::new("  ")).await),
        "Type or paste the path of a plugin folder first."
    );

    // A link inside the folder is refused, never followed.
    let linked = source(&root, "linked", manifest("linked"));
    let outside = root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "not yours").unwrap();
    if link_dir(&outside, &linked.join("escape")) {
        let said = refusal(h.install_folder(&linked).await);
        assert!(said.contains("holds a link"), "{said}");
    }

    // Nothing was copied for any of them.
    let copied: Vec<_> = std::fs::read_dir(&ext)
        .map(|d| d.filter_map(Result::ok).map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(copied.is_empty(), "{copied:?}");
    assert!(h.plugins().is_empty());
}

/// A directory link at `link` to `target`: a junction on Windows (no privilege needed), a
/// symlink elsewhere. False when the system would not make one.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success());
        assert!(made, "a junction could not be made for the test");
        made
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }
}

#[tokio::test]
async fn add_server_hosted_unreviewed() {
    let root = Scratch::new("server-add");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let h = host(&root, store.clone());
    h.start(&[]).await.unwrap();

    // v2's refusals.
    let bad = |r| refusal(r);
    assert_eq!(
        bad(h.add_server("", "", FIXTURE, &[]).await),
        "Give it a name first — lowercase letters, digits and hyphens."
    );
    assert_eq!(
        bad(h.add_server("Bad_Id", "", FIXTURE, &[]).await),
        "“Bad_Id” is not a usable name — lowercase letters, digits and hyphens."
    );
    assert_eq!(
        bad(h.add_server("tidy", "", "  ", &[]).await),
        "There is no command to run."
    );

    let id = h
        .add_server("tidy", "Tidy server", FIXTURE, &["greet".into()])
        .await
        .unwrap();
    assert_eq!(id.0, "tidy");
    assert_eq!(
        bad(h.add_server("tidy", "", FIXTURE, &[]).await),
        "Something called “tidy” is already installed."
    );

    let p = h.plugins().into_iter().find(|p| p.id == id).unwrap();
    assert_eq!(p.name, "Tidy server");
    assert!(!p.enabled, "added, not enabled");
    let dir = h.plugin_dir(&id).unwrap();
    assert_eq!(
        dir.manifest.summary,
        "MCP server. Not an Alexia plugin. Not reviewed by us."
    );
    assert!(dir.manifest.settings.is_empty() && dir.manifest.requires.is_empty());
    assert!(
        !dir.path.starts_with(root.join("ext")),
        "not a plugin folder"
    );

    // Hosted like a plugin, every tool unreviewed until the owner's word.
    h.set_enabled(&id, true).await.unwrap();
    let tools = h.tools().await;
    let greet = tools
        .iter()
        .find(|t| t.plugin == id && t.tool.name == "greet")
        .expect("the server's tools are listed");
    assert!(!greet.reviewed);
    h.set_reviewed(&id, true).unwrap();
    assert!(h.tools().await.iter().all(|t| t.plugin != id || t.reviewed));

    // Removing it takes it out of the list.
    h.remove(&id).await.unwrap();
    assert!(h.servers().is_empty());
    assert!(h.plugins().iter().all(|p| p.id != id));
    h.shutdown().await;
}

#[tokio::test]
async fn servers_persist() {
    let root = Scratch::new("server-persist");
    let store = Arc::new(Store::open_in_memory().unwrap());
    {
        let h = host(&root, store.clone());
        h.start(&[]).await.unwrap();
        h.add_server("keeper", "", FIXTURE, &["greet".into()])
            .await
            .unwrap();
        let list = h.servers();
        assert_eq!(list.len(), 1);
        assert_eq!(
            (
                list[0].id.as_str(),
                list[0].name.as_str(),
                list[0].run.as_str()
            ),
            ("keeper", "keeper", FIXTURE)
        );
        assert_eq!(list[0].args, vec!["greet".to_owned()]);
        h.shutdown().await;
    }
    // kv `_core`/`servers`, as the spec names it.
    let kept = store.kv_get("_core", "servers").unwrap().unwrap();
    assert_eq!(
        kept,
        json!([{"id": "keeper", "name": "keeper", "run": FIXTURE, "args": ["greet"]}])
    );

    // A new host on the same store hosts it again, enabled when the hub says so, still
    // unreviewed, with no folder of its own in the extensions dir.
    std::fs::remove_dir_all(root.join("data").join("servers")).unwrap();
    let h = host(&root, store.clone());
    let id = PluginId("keeper".into());
    h.start(std::slice::from_ref(&id)).await.unwrap();
    assert_eq!(h.servers().len(), 1);
    let p = h.plugins().into_iter().find(|p| p.id == id).unwrap();
    assert!(p.enabled);
    let tools = h.tools().await;
    assert!(tools.iter().any(|t| t.plugin == id && !t.reviewed));
    assert!(!root.join("ext").join("keeper").exists());
    h.shutdown().await;
}

fn unreviewed(store: &Store) -> Vec<String> {
    store
        .kv_get("_core", "unreviewed")
        .unwrap()
        .map(|v| serde_json::from_value(v).unwrap())
        .unwrap_or_default()
}

fn known(store: &Store) -> Vec<String> {
    store
        .kv_get("_core", "known_plugins")
        .unwrap()
        .map(|v| serde_json::from_value(v).unwrap())
        .unwrap_or_default()
}

/// (P2-62) Trust belongs to the folder the owner reviewed: deleted and installed again under
/// the same id, from anywhere, the plugin is unreviewed until the owner says otherwise.
#[tokio::test]
async fn reinstall_after_delete_is_unreviewed() {
    let root = Scratch::new("reinstall");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let h = host(&root, store.clone());
    h.start(&[]).await.unwrap();
    let id = PluginId("again".into());

    let first = source(&root, "again", manifest("again"));
    h.install_folder(&first).await.unwrap();
    h.set_reviewed(&id, true).unwrap();
    assert!(!unreviewed(&store).contains(&id.0), "the owner trusted it");
    assert!(known(&store).contains(&id.0));

    h.remove(&id).await.unwrap();
    assert!(
        !known(&store).contains(&id.0),
        "a removed plugin is no longer known"
    );

    // A different folder under the reviewed id.
    let other = root.join("elsewhere");
    std::fs::create_dir_all(&other).unwrap();
    let second = source(&other, "again", manifest("again"));
    std::fs::write(second.join("assets").join("note.txt"), "something else").unwrap();
    h.install_folder(&second).await.unwrap();
    assert!(
        unreviewed(&store).contains(&id.0),
        "installed again, it starts over unreviewed"
    );
    assert!(known(&store).contains(&id.0));
    h.set_enabled(&id, true).await.unwrap();
    let tools = h.tools().await;
    assert!(tools.iter().any(|t| t.plugin == id));
    assert!(tools.iter().filter(|t| t.plugin == id).all(|t| !t.reviewed));

    // And one dropped into the plugin dir by hand and found by a later scan is new as well.
    h.remove(&id).await.unwrap();
    h.set_reviewed(&id, true).unwrap();
    h.shutdown().await;
    let dropped = root.join("ext").join("again");
    std::fs::create_dir_all(dropped.join("assets")).unwrap();
    let exe = Path::new(FIXTURE).file_name().unwrap().to_str().unwrap();
    std::fs::copy(FIXTURE, dropped.join(exe)).unwrap();
    std::fs::write(dropped.join("plugin.json"), manifest("again").to_string()).unwrap();
    let h = host(&root, store.clone());
    h.start(&[]).await.unwrap();
    assert!(unreviewed(&store).contains(&id.0));
    h.shutdown().await;
}

/// Two installs of one id at once: exactly one wins, the other is refused with v2's sentence,
/// and the winner's folder is whole (the loser never removes it).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_installs_of_one_id() {
    let root = Scratch::new("install-race");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let h = host(&root, store.clone());
    h.start(&[]).await.unwrap();
    // Two source folders with the same id, each with enough files that a copy takes a while.
    let mut froms = vec![];
    for side in ["a", "b"] {
        let base = root.join(side);
        std::fs::create_dir_all(&base).unwrap();
        let from = source(&base, "racer", manifest("racer"));
        for i in 0..200 {
            std::fs::write(from.join("assets").join(format!("f{i}.txt")), side).unwrap();
        }
        froms.push(from);
    }
    for round in 0..5 {
        let id = PluginId("racer".into());
        let (ha, hb) = (h.clone(), h.clone());
        let (fa, fb) = (froms[0].clone(), froms[1].clone());
        let a = tokio::spawn(async move { ha.install_folder(&fa).await });
        let b = tokio::spawn(async move { hb.install_folder(&fb).await });
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        let (won, lost) = match (&a, &b) {
            (Ok(_), Err(_)) => ("a", b),
            (Err(_), Ok(_)) => ("b", a),
            other => panic!("round {round}: expected one install, got {other:?}"),
        };
        assert_eq!(
            refusal(lost),
            "racer is already installed. Delete it first to replace it."
        );
        let dest = root.join("ext").join("racer");
        assert!(dest.join("plugin.json").is_file(), "round {round}");
        for i in 0..200 {
            assert_eq!(
                std::fs::read_to_string(dest.join("assets").join(format!("f{i}.txt"))).unwrap(),
                won,
                "round {round}: the folder is the winner's, whole"
            );
        }
        assert!(h.plugin_dir(&id).is_some());
        h.remove(&id).await.unwrap();
        assert!(!dest.exists());
    }
    h.shutdown().await;
}
