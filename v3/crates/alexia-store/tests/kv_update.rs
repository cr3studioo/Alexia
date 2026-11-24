// SPDX-License-Identifier: AGPL-3.0-only
//! P3-00: `Store::kv_update` is one atomic read-modify-write (P2D review L3).

use std::path::PathBuf;
use std::sync::Arc;

use alexia_store::Store;
use serde_json::{json, Value};

fn temp(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "alexia-kv-update-{name}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn concurrent_appends_all_kept() {
    let dir = temp("concurrent");
    let store = Arc::new(Store::open(&dir.join("alexia.db")).unwrap());
    let threads: Vec<_> = (0..16)
        .map(|n| {
            let store = store.clone();
            std::thread::spawn(move || {
                store
                    .kv_update("_core", "list", |now| {
                        let mut list: Vec<i64> = now
                            .and_then(|v| serde_json::from_value(v).ok())
                            .unwrap_or_default();
                        // Widen the window a lost update would need.
                        std::thread::yield_now();
                        list.push(n);
                        Some(json!(list))
                    })
                    .unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let mut got: Vec<i64> =
        serde_json::from_value(store.kv_get("_core", "list").unwrap().unwrap()).unwrap();
    got.sort_unstable();
    assert_eq!(got, (0..16).collect::<Vec<_>>());
    drop(store);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn none_deletes() {
    let store = Store::open_in_memory().unwrap();
    store.kv_set("ns", "k", &json!([1])).unwrap();
    let wrote = store.kv_update("ns", "k", |_| None).unwrap();
    assert_eq!(wrote, None);
    assert_eq!(store.kv_get("ns", "k").unwrap(), None);
}

#[test]
fn absent_is_none() {
    let store = Store::open_in_memory().unwrap();
    let mut seen: Option<Option<Value>> = None;
    let wrote = store
        .kv_update("ns", "missing", |now| {
            seen = Some(now);
            Some(json!("made"))
        })
        .unwrap();
    assert_eq!(seen, Some(None));
    assert_eq!(wrote, Some(json!("made")));
    assert_eq!(store.kv_get("ns", "missing").unwrap(), Some(json!("made")));
}
