// SPDX-License-Identifier: AGPL-3.0-only
//! P2D-09: what the Local models screen adds to `hf` and `local` — a download that can be
//! cancelled and carried on, Hugging Face search and repo preview read from recorded answers,
//! the owner's context size, and the cleanup suggestions. Hugging Face is a loopback server
//! here: nothing leaves the computer.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod scratch;
use scratch::Scratch;

use alexia_core::catalog::Catalog;
use alexia_core::gpu::Machine;
use alexia_core::hf::{self, Format, HfError};
use alexia_core::local::{self, LocalJobs, ModelError, ModelNotes, Runtime};
use alexia_core::router::Router;
use alexia_core::Job;
use alexia_store::{now_ms, Layout, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
const WAIT: Duration = Duration::from_secs(60);
const COMMIT: &str = "89abcdef0123456789abcdef0123456789abcdef";

// ---- a GGUF header ----

fn s(out: &mut Vec<u8>, v: &str) {
    out.extend((v.len() as u64).to_le_bytes());
    out.extend(v.as_bytes());
}

/// A llama header (32 layers, 4096 context, 8 KV heads of 128) and `pad` bytes of body.
fn llama(pad: usize) -> Vec<u8> {
    let u32s = [
        ("llama.block_count", 32u32),
        ("llama.context_length", 4096),
        ("llama.embedding_length", 4096),
        ("llama.attention.head_count", 32),
        ("llama.attention.head_count_kv", 8),
    ];
    let mut o = b"GGUF".to_vec();
    o.extend(3u32.to_le_bytes());
    o.extend(0u64.to_le_bytes());
    o.extend((u32s.len() as u64 + 1).to_le_bytes());
    s(&mut o, "general.architecture");
    o.extend(8u32.to_le_bytes());
    s(&mut o, "llama");
    for (k, v) in u32s {
        s(&mut o, k);
        o.extend(4u32.to_le_bytes());
        o.extend(v.to_le_bytes());
    }
    o.extend((0..pad).map(|i| (i % 251) as u8));
    o
}

fn hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ok() {
        assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---- a stand-in for Hugging Face ----

struct Hub {
    model: Vec<u8>,
    /// The first whole-file request sends half the bytes, then holds the connection open.
    stall_once: AtomicBool,
    /// `/api/models?…` answers this (a recorded search page).
    search: Value,
    /// `/api/models/o/m` answers this (with `sha` set to `COMMIT`).
    meta: Value,
    log: Mutex<Vec<String>>,
}

fn http(status: &str, kind: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend(body);
    out
}

async fn serve(hub: Arc<Hub>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let hub = hub.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut b = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut b).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend(&b[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&head).into_owned();
                hub.log.lock().unwrap().push(head.clone());
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                let range = head.lines().find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("range: bytes=")
                        .and_then(|r| r.trim_end_matches('-').parse::<usize>().ok())
                });
                let json = |v: &Value| http("200 OK", "application/json", v.to_string().as_bytes());
                let reply = if path.starts_with("/api/models?") {
                    json(&hub.search)
                } else if path == "/api/models/o/m" {
                    let mut meta = hub.meta.clone();
                    meta["sha"] = json!(COMMIT);
                    json(&meta)
                } else if path.starts_with(&format!("/api/models/o/m/tree/{COMMIT}")) {
                    json(&json!([
                        {"type": "file", "path": "README.md", "size": 10},
                        {"type": "file", "path": "m-Q4_K_M.gguf", "size": hub.model.len(),
                         "lfs": {"size": hub.model.len(), "oid": hex(&hub.model)}},
                    ]))
                } else if path == format!("/o/m/resolve/{COMMIT}/m-Q4_K_M.gguf") {
                    let body = &hub.model;
                    match range {
                        Some(from) => {
                            let rest = &body[from..];
                            let mut out = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len() - 1,
                                body.len(),
                                rest.len()
                            )
                            .into_bytes();
                            out.extend(rest);
                            out
                        }
                        None if hub.stall_once.swap(false, Ordering::SeqCst) => {
                            let mut out = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .into_bytes();
                            out.extend(&body[..body.len() / 2]);
                            let _ = sock.write_all(&out).await;
                            let _ = sock.flush().await;
                            // Hold the rest back until the client gives up on it.
                            tokio::time::sleep(Duration::from_secs(300)).await;
                            return;
                        }
                        None => http("200 OK", "application/octet-stream", body),
                    }
                } else {
                    http("404 Not Found", "text/plain", b"")
                };
                let _ = sock.write_all(&reply).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    base
}

fn hub(model: Vec<u8>, stall: bool) -> Arc<Hub> {
    Arc::new(Hub {
        model,
        stall_once: AtomicBool::new(stall),
        search: Value::Null,
        meta: json!({}),
        log: Mutex::new(Vec::new()),
    })
}

// ---- import: cancel, then carry on ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_cancel_keeps_partial() {
    let model = llama(400_000);
    let h = hub(model.clone(), true);
    let base = serve(h.clone()).await;
    let dir = Scratch::new("p2d-cancel");
    let layout = Layout::new(dir.to_path_buf());
    let cancel = CancellationToken::new();
    let (tx, mut rx) = mpsc::channel(4096);
    let task = {
        let (base, layout, cancel) = (base.clone(), Layout::new(layout.root.clone()), cancel.clone());
        tokio::spawn(async move {
            hf::import_cancellable_at(
                &base,
                "o/m",
                None,
                "Q4_K_M",
                &layout,
                &client(),
                cancel,
                tx,
                None,
            )
            .await
        })
    };
    // Half the file arrives, then the server goes quiet: progress says so in bytes.
    let total = model.len() as u64;
    let mut seen = (0, 0);
    let deadline = Instant::now() + WAIT;
    while seen.0 < total / 4 {
        assert!(Instant::now() < deadline, "no progress: {seen:?}");
        if let Ok(Some(p)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
            assert!(p.0 >= seen.0, "progress went back: {p:?} after {seen:?}");
            seen = p;
        }
    }
    assert_eq!(seen.1, total, "the total is the file's size");
    cancel.cancel();
    let first = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert!(matches!(first, Err(HfError::Cancelled)), "{first:?}");

    // What arrived is kept beside the target as `.part`; the model itself is not there.
    let q4 = layout.cache().join("models").join("o/m").join("Q4_K_M");
    let part = q4.join("m-Q4_K_M.gguf.part");
    until("the partial file", || {
        std::fs::metadata(&part).is_ok_and(|m| m.len() > 0)
    })
    .await;
    let kept = std::fs::metadata(&part).unwrap().len();
    assert!(kept < total, "kept {kept} of {total}");
    assert!(!q4.join("m-Q4_K_M.gguf").exists());

    // Installing again asks only for the rest, and the result is the whole, checked file.
    let (tx, mut rx) = mpsc::channel(4096);
    let done = hf::import_cancellable_at(
        &base,
        "o/m",
        None,
        "Q4_K_M",
        &layout,
        &client(),
        CancellationToken::new(),
        tx,
        None,
    )
    .await
    .unwrap();
    let log = h.log.lock().unwrap().join("\n").to_ascii_lowercase();
    assert!(log.contains(&format!("range: bytes={kept}-")), "{log}");
    assert_eq!(std::fs::read(&done.path).unwrap(), model);
    assert!(!part.exists());
    assert_eq!(done.id, "o/m:Q4_K_M");
    let mut last = (0, 0);
    while let Ok(p) = rx.try_recv() {
        last = p;
    }
    assert_eq!(last, (total, total), "the last reading is the whole file");
}

// ---- search and repo preview, from recorded answers ----

/// A page of `GET /api/models?search=qwen&filter=gguf&sort=downloads&direction=-1&limit=30`
/// as Hugging Face answered it (trimmed to the fields v2 and v3 read), plus two rows that must
/// be dropped: a repeat and an id that is not `owner/name`.
fn recorded_search() -> Value {
    json!([
        {"_id": "680da718233834890aa01f51", "id": "unsloth/Qwen3-8B-GGUF", "likes": 156,
         "downloads": 83211, "trendingScore": 4, "private": false, "gated": false,
         "tags": ["transformers", "gguf", "qwen3", "base_model:Qwen/Qwen3-8B"],
         "pipeline_tag": "text-generation", "library_name": "transformers",
         "createdAt": "2025-04-28T19:37:28.000Z", "modelId": "unsloth/Qwen3-8B-GGUF"},
        {"_id": "680e2fd1a7cb34e2d4c53b3a", "id": "bartowski/Qwen_Qwen3-0.6B-GGUF", "likes": 21,
         "downloads": 40517.0, "private": false, "gated": "auto",
         "tags": ["gguf", "text-generation"], "createdAt": "2025-04-29T00:00:00.000Z",
         "modelId": "bartowski/Qwen_Qwen3-0.6B-GGUF"},
        {"_id": "67f00000000000000000000a", "modelId": "someone/qwen-manual-GGUF", "likes": -3,
         "downloads": "many", "private": false, "gated": "manual"},
        {"_id": "680da718233834890aa01f51", "id": "unsloth/Qwen3-8B-GGUF", "likes": 1,
         "downloads": 1, "gated": false},
        {"_id": "67f00000000000000000000b", "id": "../etc", "likes": 0, "downloads": 0},
        {"_id": "67f00000000000000000000c", "likes": 0, "downloads": 0}
    ])
}

/// `GET /api/models/<repo>` for a GGUF repo, trimmed as above.
fn recorded_meta() -> Value {
    json!({
        "_id": "680e2fd1a7cb34e2d4c53b3a", "id": "o/m", "modelId": "o/m",
        "gated": "manual", "private": false, "downloads": 40517, "likes": 21,
        "tags": ["gguf", "license:apache-2.0", "text-generation"],
        "cardData": {"license": "apache-2.0", "base_model": "Qwen/Qwen3-0.6B"},
        "gguf": {"total": 751632384, "architecture": "qwen3", "context_length": 40960},
        "siblings": [{"rfilename": "README.md"}, {"rfilename": "m-Q4_K_M.gguf"}]
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_parses_fixture() {
    let model = llama(1000);
    let h = Arc::new(Hub {
        model: model.clone(),
        stall_once: AtomicBool::new(false),
        search: recorded_search(),
        meta: recorded_meta(),
        log: Mutex::new(Vec::new()),
    });
    let base = serve(h.clone()).await;

    let hits = hf::search_at(&base, &client(), "  qwen ", Format::Gguf, None)
        .await
        .unwrap();
    let rows: Vec<(String, u64, u64, bool)> = hits
        .iter()
        .map(|h| (h.repo.clone(), h.downloads, h.likes, h.gated))
        .collect();
    assert_eq!(
        rows,
        [
            ("unsloth/Qwen3-8B-GGUF".to_owned(), 83211, 156, false),
            ("bartowski/Qwen_Qwen3-0.6B-GGUF".to_owned(), 40517, 21, true),
            ("someone/qwen-manual-GGUF".to_owned(), 0, 0, true),
        ]
    );
    // v2's JSON keys, exactly.
    assert_eq!(
        serde_json::to_value(&hits[0]).unwrap(),
        json!({"repo": "unsloth/Qwen3-8B-GGUF", "downloads": 83211, "likes": 156, "gated": false})
    );
    let asked = h.log.lock().unwrap().join("\n");
    assert!(
        asked.contains("GET /api/models?search=qwen&filter=gguf&sort=downloads&direction=-1&limit=30 "),
        "{asked}"
    );

    // Nothing to search for asks nothing; MLX is not for this computer.
    let before = h.log.lock().unwrap().len();
    assert!(hf::search_at(&base, &client(), "   ", Format::Gguf, None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(h.log.lock().unwrap().len(), before);
    let mlx = hf::search_at(&base, &client(), "qwen", Format::Mlx, None).await;
    assert!(matches!(mlx, Err(HfError::Invalid(ref s)) if s == hf::NO_MLX), "{mlx:?}");

    // The repo preview: pinned to its commit, licence, gating, size and its complete quants.
    let p = hf::repo_at(&base, &client(), "o/m", None, Format::Gguf, None)
        .await
        .unwrap();
    assert_eq!(p.repo, "o/m");
    assert_eq!(p.revision, COMMIT);
    assert_eq!(p.licence.as_deref(), Some("apache-2.0"));
    assert!(p.gated);
    assert!((p.params.unwrap() - 0.751632384).abs() < 1e-9);
    assert_eq!(p.quants.len(), 1);
    assert_eq!(p.quants[0].quant, "Q4_K_M");
    assert_eq!(p.quants[0].bytes, model.len() as u64);
    assert_eq!(p.quants[0].files[0].sha256, hex(&model));
    let v = serde_json::to_value(&p).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["gated", "licence", "params", "quants", "repo", "revision"]
    );
    let bad = hf::repo_at(&base, &client(), "not a repo", None, Format::Gguf, None).await;
    assert!(matches!(bad, Err(HfError::Invalid(_))), "{bad:?}");
}

// ---- the local side: context and cleanup ----

struct World {
    jobs: Arc<LocalJobs>,
    store: Arc<Store>,
    router: Arc<Router>,
    layout: Layout,
    _root: Scratch,
}

fn world(name: &str, vram_mb: u32) -> World {
    let root = Scratch::new(&format!("p2d-{name}"));
    let store = Arc::new(Store::open_in_memory().unwrap());
    let catalog = Arc::new(Catalog::new(
        Vec::new(),
        Vec::new(),
        root.join("catalog.json"),
    ));
    let router = Arc::new(Router::new(Vec::new(), catalog, store.clone()));
    let layout = Layout::new(root.join("data"));
    let runtime = Runtime::new(Layout::new(layout.root.clone()), reqwest::Client::new());
    let jobs = LocalJobs::new(runtime, store.clone(), router.clone());
    jobs.set_machine(Machine {
        vram_mb,
        free_mb: vram_mb,
        ram_mb: 32_000,
        gpu: Some("Test GPU".into()),
    });
    World {
        jobs,
        store,
        router,
        layout,
        _root: root,
    }
}

/// A real GGUF under the models folder, recorded as installed; `bytes` is what its record says.
fn installed(w: &World, rel: &str, bytes: u64) -> hf::Installed {
    let dir = w.layout.cache().join("models").join(rel);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("m.gguf");
    std::fs::write(&path, llama(64)).unwrap();
    let mut meta = hf::read_gguf(&path).unwrap();
    meta.bytes = bytes;
    let i = hf::Installed {
        id: format!("{rel}:Q4_K_M"),
        path,
        meta,
        mmproj: None,
    };
    hf::record(&w.store, &i).unwrap();
    i
}

#[tokio::test]
async fn context_roundtrip() {
    let w = world("context", 8192);
    let i = installed(&w, "o/m/Q4_K_M", 2_000_000_000);

    // Nothing chosen: the checker's 8192, capped by the 4096 the header allows.
    let first = w.jobs.context(&i.id, None).await.unwrap();
    assert_eq!((first.context, first.context_max), (4096, 4096));
    assert_eq!(first.verdict, "fits");
    assert_eq!(first.kv_options, ["f16"]);
    assert!(first.drafts.is_empty());
    // 2 GB of weights, 4096 slots × 2·32·8·(128+128) bytes × 1.1, 1 GiB of overhead.
    let kv = (4096.0_f64 * 131_072.0 * 1.1).ceil() as u64;
    assert_eq!(first.need_bytes, 2_000_000_000 + kv + 1024 * 1024 * 1024);
    assert_eq!(
        serde_json::to_value(&first).unwrap()["contextMax"],
        json!(4096)
    );

    // Kept, and read back; the jobs start the model with it.
    let set = w.jobs.set_context(&i.id, 2048).await.unwrap();
    assert_eq!(set.context, 2048);
    assert_eq!(w.jobs.context(&i.id, None).await.unwrap().context, 2048);
    assert_eq!(w.jobs.context_of(&i), 2048);
    assert_eq!(local::notes(&w.store)[&i.id].context, Some(2048));

    // Out of range, unknown model, and a context the card cannot hold.
    for bad in [100, 5000] {
        let e = w.jobs.set_context(&i.id, bad).await.unwrap_err();
        assert!(
            matches!(e, ModelError::Invalid(ref s) if s == "Choose a context from 256 to 4096 tokens."),
            "{e:?}"
        );
    }
    assert!(matches!(
        w.jobs.context("nobody:Q4", None).await,
        Err(ModelError::NotInstalled)
    ));
    let small = world("context-small", 2048);
    let big = installed(&small, "o/big/Q8_0", 6_000_000_000);
    assert_eq!(
        small.jobs.context(&big.id, None).await.unwrap().verdict,
        "too-big"
    );
    assert!(matches!(
        small.jobs.set_context(&big.id, 1024).await,
        Err(ModelError::TooBig)
    ));
    assert_eq!(local::notes(&small.store).get(&big.id), None);
}

fn suggestion_ids(w: &World) -> Vec<String> {
    w.jobs.maintenance().into_iter().map(|s| s.id).collect()
}

#[tokio::test]
async fn maintenance_finds_orphan_file() {
    let w = world("maintenance", 8192);
    let kept = installed(&w, "o/m/Q4_K_M", 1000);
    let old = installed(&w, "o/old/Q4_K_M", 1000);
    let models = w.layout.cache().join("models");

    // A fresh store: nothing to suggest.
    assert!(w.jobs.maintenance().is_empty(), "{:?}", w.jobs.maintenance());

    // A file no model owns, and a download nothing is finishing.
    let stray: PathBuf = models.join("o").join("m").join("Q8_0").join("m-Q8_0.gguf");
    std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
    std::fs::write(&stray, vec![7u8; 1234]).unwrap();
    std::fs::write(models.join("o/m/Q8_0/m-Q8_0.gguf.part"), vec![7u8; 10]).unwrap();
    // An import's staging folder is work in progress, not an orphan.
    std::fs::create_dir_all(models.join("local/.import-1-0")).unwrap();
    std::fs::write(models.join("local/.import-1-0/x.gguf"), b"x").unwrap();

    // `old` was last used 40 days ago; `kept` too, but it is pinned.
    let long_ago = now_ms() - 40 * 24 * 60 * 60 * 1000;
    for i in [&kept, &old] {
        local::set_notes(&w.store, &i.id, |_| {
            Some(ModelNotes {
                name: Some(format!("Model {}", i.id)),
                installed_at: Some(long_ago),
                ..ModelNotes::default()
            })
        })
        .unwrap();
    }
    w.router
        .set_pins(Job::Check, vec![local::pin_of(&kept.id)])
        .unwrap();

    let all = w.jobs.maintenance();
    assert_eq!(
        suggestion_ids(&w),
        [
            "o/old/Q4_K_M:Q4_K_M",
            "file:o/m/Q8_0/m-Q8_0.gguf",
            "file:o/m/Q8_0/m-Q8_0.gguf.part"
        ]
    );
    assert_eq!(all[0].reason, "Not used in the last 30 days.");
    assert_eq!(all[0].name, "Model o/old/Q4_K_M:Q4_K_M");
    assert_eq!((all[1].name.as_str(), all[1].bytes), ("m-Q8_0.gguf", 1234));
    assert_eq!(all[1].reason, "Not part of any installed model.");
    assert!(all[2].reason.starts_with("An unfinished download"));
    let v = serde_json::to_value(&all[1]).unwrap();
    assert_eq!(
        v,
        json!({"id": "file:o/m/Q8_0/m-Q8_0.gguf", "name": "m-Q8_0.gguf", "bytes": 1234,
               "reason": "Not part of any installed model."})
    );

    // A cleanup line can be removed by its id; the installed files are left alone.
    let gone = w.jobs.remove("file:o/m/Q8_0/m-Q8_0.gguf").await.unwrap();
    assert_eq!(gone.freed, 1234);
    assert!(!stray.exists());
    assert!(kept.path.exists());
    assert!(matches!(
        w.jobs.remove("file:o/m/Q4_K_M/m.gguf").await,
        Err(ModelError::NotInstalled)
    ));
    assert!(Path::new(&kept.path).exists());

    // Removing the old model deletes its file, its record and its notes.
    let r = w.jobs.remove(&old.id).await.unwrap();
    assert!(r.owned);
    assert!(!old.path.exists());
    assert!(hf::installed(&w.store).iter().all(|i| i.id != old.id));
    assert_eq!(local::notes(&w.store).get(&old.id), None);
    assert_eq!(
        suggestion_ids(&w),
        ["file:o/m/Q8_0/m-Q8_0.gguf.part"]
    );
}
