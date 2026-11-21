// SPDX-License-Identifier: AGPL-3.0-only
//! P2-33: GGUF headers, split groups, quant grouping, and a resumable verified download.
//! GGUF headers are built here; the "Hugging Face" is a local HTTP server. No network.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use alexia_core::hf::{
    self, group_rows, import_file, import_repo_at, quants_at, read_gguf, token_for, HfError,
};
use alexia_store::Layout;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

// ---- synthetic GGUF ----

enum Kv<'a> {
    U32(u32),
    Str(&'a str),
    Strs(&'a [&'a str]),
    Floats(usize),
    U64(u64),
}

fn s(out: &mut Vec<u8>, v: &str) {
    out.extend((v.len() as u64).to_le_bytes());
    out.extend(v.as_bytes());
}

/// A header with no tensors, padded with `pad` bytes of body.
fn gguf(kvs: &[(&str, Kv)], pad: usize) -> Vec<u8> {
    let mut o = b"GGUF".to_vec();
    o.extend(3u32.to_le_bytes());
    o.extend(0u64.to_le_bytes());
    o.extend((kvs.len() as u64).to_le_bytes());
    for (k, v) in kvs {
        s(&mut o, k);
        match v {
            Kv::U32(n) => {
                o.extend(4u32.to_le_bytes());
                o.extend(n.to_le_bytes());
            }
            Kv::Str(t) => {
                o.extend(8u32.to_le_bytes());
                s(&mut o, t);
            }
            Kv::U64(n) => {
                o.extend(10u32.to_le_bytes());
                o.extend(n.to_le_bytes());
            }
            Kv::Strs(a) => {
                o.extend(9u32.to_le_bytes());
                o.extend(8u32.to_le_bytes());
                o.extend((a.len() as u64).to_le_bytes());
                for t in *a {
                    s(&mut o, t);
                }
            }
            Kv::Floats(n) => {
                o.extend(9u32.to_le_bytes());
                o.extend(6u32.to_le_bytes());
                o.extend((*n as u64).to_le_bytes());
                o.extend(vec![0u8; n * 4]);
            }
        }
    }
    o.extend((0..pad).map(|i| (i % 251) as u8));
    o
}

fn llama(split: Option<(u32, u32)>, pad: usize) -> Vec<u8> {
    let mut kv = vec![
        ("general.architecture", Kv::Str("llama")),
        ("general.name", Kv::Str("tiny")),
        ("llama.block_count", Kv::U32(32)),
        ("llama.context_length", Kv::U32(4096)),
        ("llama.embedding_length", Kv::U32(4096)),
        ("llama.attention.head_count", Kv::U32(32)),
        ("llama.attention.head_count_kv", Kv::U32(8)),
        ("tokenizer.ggml.tokens", Kv::Strs(&["<s>", "a", "b"])),
        ("tokenizer.ggml.scores", Kv::Floats(3)),
    ];
    if let Some((no, count)) = split {
        kv.push(("split.no", Kv::U32(no)));
        kv.push(("split.count", Kv::U32(count)));
    }
    gguf(&kv, pad)
}

fn mmproj() -> Vec<u8> {
    gguf(&[("general.architecture", Kv::Str("clip"))], 64)
}

fn temp(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!(
        "alexia-hf-{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

// ---- headers ----

#[test]
fn reads_metadata() {
    let d = temp("meta");
    let p = d.join("m.gguf");
    let bytes = llama(None, 100);
    std::fs::write(&p, &bytes).unwrap();
    let m = read_gguf(&p).unwrap();
    assert_eq!(m.arch, "llama");
    assert_eq!((m.layers, m.context), (32, 4096));
    // 2 * layers * kv_heads * (key + value), key = value = 4096 / 32
    assert_eq!(m.kv_bytes_per_token, 2 * 32 * 8 * (128 + 128));
    assert_eq!(m.bytes, bytes.len() as u64);
    assert_eq!(m.parts, vec![p.clone()]);
    assert!(!m.vision_projector);

    let q = d.join("mmproj-f16.gguf");
    std::fs::write(&q, mmproj()).unwrap();
    assert!(read_gguf(&q).unwrap().vision_projector);

    let junk = d.join("junk.gguf");
    std::fs::write(&junk, b"not a model at all").unwrap();
    assert!(matches!(read_gguf(&junk), Err(HfError::BadGguf(_))));
    let cut = d.join("cut.gguf");
    std::fs::write(&cut, &bytes[..40]).unwrap();
    assert!(read_gguf(&cut).is_err());
}

#[test]
fn split_parts_followed() {
    let d = temp("split");
    let (a, b) = (
        d.join("m-00001-of-00002.gguf"),
        d.join("m-00002-of-00002.gguf"),
    );
    std::fs::write(&a, llama(Some((0, 2)), 10)).unwrap();
    std::fs::write(&b, llama(Some((1, 2)), 20)).unwrap();
    // from either part, the whole group comes back in order
    for start in [&a, &b] {
        let m = read_gguf(start).unwrap();
        assert_eq!(m.parts, vec![a.clone(), b.clone()]);
        let total = std::fs::metadata(&a).unwrap().len() + std::fs::metadata(&b).unwrap().len();
        assert_eq!(m.bytes, total);
        assert_eq!(m.layers, 32);
    }
}

/// What `gguf-split` writes into parts 2..N: split keys only, no general.*.
fn split_tail(no: u32, count: u32, tensors: u32, pad: usize) -> Vec<u8> {
    gguf(
        &[
            ("split.no", Kv::U32(no)),
            ("split.count", Kv::U32(count)),
            ("split.tensors.count", Kv::U32(tensors)),
        ],
        pad,
    )
}

fn split_head(tensors: u32) -> Vec<u8> {
    gguf(
        &[
            ("general.architecture", Kv::Str("llama")),
            ("llama.block_count", Kv::U32(32)),
            ("llama.context_length", Kv::U32(4096)),
            ("llama.embedding_length", Kv::U32(4096)),
            ("llama.attention.head_count", Kv::U32(32)),
            ("split.no", Kv::U32(0)),
            ("split.count", Kv::U32(2)),
            ("split.tensors.count", Kv::U32(tensors)),
        ],
        10,
    )
}

#[test]
fn split_tail_without_general_keys_accepted() {
    let d = temp("tail");
    let (a, b) = (
        d.join("m-00001-of-00002.gguf"),
        d.join("m-00002-of-00002.gguf"),
    );
    std::fs::write(&a, split_head(7)).unwrap();
    std::fs::write(&b, split_tail(1, 2, 7, 20)).unwrap();
    for start in [&a, &b] {
        let m = read_gguf(start).unwrap();
        assert_eq!(m.arch, "llama");
        assert_eq!(m.parts, vec![a.clone(), b.clone()]);
    }
    // parts that disagree on the tensor total are refused
    std::fs::write(&b, split_tail(1, 2, 8, 20)).unwrap();
    assert!(matches!(read_gguf(&a), Err(HfError::SplitMismatch(_))));
}

#[test]
fn huge_key_length_is_a_parse_error() {
    let d = temp("huge");
    let p = d.join("m.gguf");
    let big = Kv::U64(u64::MAX);
    std::fs::write(
        &p,
        gguf(
            &[
                ("general.architecture", Kv::Str("llama")),
                ("llama.attention.head_count", Kv::U32(1)),
                ("llama.attention.key_length", big),
                ("llama.attention.value_length", Kv::U64(u64::MAX)),
            ],
            8,
        ),
    )
    .unwrap();
    assert!(matches!(read_gguf(&p), Err(HfError::BadGguf(_))));
}

#[test]
fn missing_part_named() {
    let d = temp("missing");
    let a = d.join("m-00001-of-00002.gguf");
    std::fs::write(&a, llama(Some((0, 2)), 10)).unwrap();
    match read_gguf(&a) {
        Err(HfError::MissingPart(n)) => assert_eq!(n, "m-00002-of-00002.gguf"),
        other => panic!("expected the missing part, got {other:?}"),
    }
    // the sentence the owner reads names it too
    assert!(read_gguf(&a)
        .unwrap_err()
        .to_string()
        .contains("m-00002-of-00002.gguf"));

    // parts that disagree are refused
    let b = d.join("m-00002-of-00002.gguf");
    std::fs::write(&b, llama(Some((0, 2)), 10)).unwrap(); // says it is part 1 again
    assert!(matches!(read_gguf(&a), Err(HfError::SplitMismatch(_))));
}

#[test]
fn quant_grouping_like_v2() {
    let f = |p: &str, n: u64| json!({"type": "file", "path": p, "size": n});
    let lfs = |p: &str, n: u64| json!({"type": "file", "path": p, "size": n, "lfs": {"size": n, "oid": "a".repeat(64)}});
    let rows = vec![
        lfs("m-Q4_K_M.gguf", 400),
        lfs("m-Q6_K.gguf", 600),
        lfs("m-Q6_K_L.gguf", 650),
        lfs("m-UD-Q4_K_XL.gguf", 450),
        lfs("big/m-Q8_0-00001-of-00002.gguf", 500),
        lfs("big/m-Q8_0-00002-of-00002.gguf", 400),
        // a split with a shard missing is not offered
        lfs("m-Q5_K_M-00001-of-00002.gguf", 300),
        // a whole Q3_K_M wins over a split build of the same quant
        lfs("m-Q3_K_M.gguf", 900),
        lfs("s/m-Q3_K_M-00001-of-00002.gguf", 100),
        lfs("s/m-Q3_K_M-00002-of-00002.gguf", 100),
        lfs("mmproj-F16.gguf", 50),
        lfs("m-BF16.gguf", 2000),
        f("README.md", 5),
        json!({"type": "directory", "path": "big"}),
    ];
    let got: Vec<(String, Vec<String>, u64)> = group_rows(&rows)
        .unwrap()
        .into_iter()
        .map(|q| (q.name, q.files, q.bytes))
        .collect();
    let names: Vec<&str> = got.iter().map(|g| g.0.as_str()).collect();
    // smallest first; Q6_K_L and UD-Q4_K_XL stay whole tokens; Q5_K_M and mmproj are absent
    assert_eq!(
        names,
        [
            "Q4_K_M",
            "UD-Q4_K_XL",
            "Q6_K",
            "Q6_K_L",
            "Q3_K_M",
            "Q8_0",
            "BF16"
        ]
    );
    let q8 = got.iter().find(|g| g.0 == "Q8_0").unwrap();
    assert_eq!(
        q8.1,
        [
            "big/m-Q8_0-00001-of-00002.gguf",
            "big/m-Q8_0-00002-of-00002.gguf"
        ]
    );
    assert_eq!(q8.2, 900);
    assert_eq!(
        got.iter().find(|g| g.0 == "Q3_K_M").unwrap().1,
        ["m-Q3_K_M.gguf"]
    );
    assert_eq!(
        hf::quant_of("x/model-Q4_K_M-00001-of-00003.gguf").as_deref(),
        Some("Q4_K_M")
    );
    assert_eq!(hf::quant_of("mmproj-Q8_0.gguf"), None);
    // an unsafe path in the listing refuses the repo
    assert!(group_rows(&[lfs("../evil-Q4_K_M.gguf", 5)]).is_err());
}

// ---- a local "Hugging Face" ----

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

struct Hub {
    files: Vec<(String, Vec<u8>)>,
    /// Serve the first un-ranged model request cut at half.
    cut_once: AtomicBool,
    /// Serve altered bytes of the right length.
    corrupt: bool,
    log: Mutex<Vec<String>>,
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
                let json = |v: serde_json::Value| {
                    let b = v.to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
                        b.len()
                    )
                    .into_bytes()
                };
                let reply = if path == "/api/models/o/m" {
                    json(json!({"sha": COMMIT}))
                } else if path.starts_with(&format!("/api/models/o/m/tree/{COMMIT}")) {
                    json(serde_json::Value::Array(
                        hub.files
                            .iter()
                            .map(|(n, b)| {
                                json!({"type": "file", "path": n, "size": b.len(),
                                       "lfs": {"size": b.len(), "oid": hex(b)}})
                            })
                            .collect(),
                    ))
                } else if let Some(name) = path.strip_prefix(&format!("/o/m/resolve/{COMMIT}/")) {
                    let Some((_, body)) = hub.files.iter().find(|(n, _)| n == name) else {
                        let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        return;
                    };
                    let mut body = body.clone();
                    if hub.corrupt {
                        let last = body.len() - 1;
                        body[last] ^= 0xff;
                    }
                    let from = range.unwrap_or(0);
                    let rest = &body[from..];
                    let mut out = if range.is_some() {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len() - 1,
                            body.len(),
                            rest.len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            rest.len()
                        )
                    }
                    .into_bytes();
                    if range.is_none()
                        && !name.contains("mmproj")
                        && hub.cut_once.swap(false, Ordering::SeqCst)
                    {
                        out.extend(&rest[..rest.len() / 2]);
                    } else {
                        out.extend(rest);
                    }
                    out
                } else {
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_vec()
                };
                let _ = sock.write_all(&reply).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    base
}

fn hub(cut: bool, corrupt: bool) -> Arc<Hub> {
    Arc::new(Hub {
        files: vec![
            ("m-Q4_K_M.gguf".into(), llama(None, 300_000)),
            ("mmproj-F16.gguf".into(), mmproj()),
        ],
        cut_once: AtomicBool::new(cut),
        corrupt,
        log: Mutex::new(Vec::new()),
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

fn files_in(d: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(d)
        .map(|r| {
            r.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[tokio::test]
async fn resume_after_cut() {
    let h = hub(true, false);
    let base = serve(h.clone()).await;
    let layout = Layout::new(temp("resume"));
    let quants = quants_at(&base, "o/m", None, &client(), None)
        .await
        .unwrap();
    assert_eq!(quants.len(), 1);
    assert_eq!(quants[0].name, "Q4_K_M");

    let first = import_repo_at(
        &base,
        "o/m",
        "Q4_K_M",
        &layout,
        &client(),
        None,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(matches!(first, Err(HfError::Incomplete(_))), "{first:?}");
    let dir = layout.cache().join("models").join("o/m").join("Q4_K_M");
    let part = dir.join("m-Q4_K_M.gguf.part");
    let kept = std::fs::metadata(&part).unwrap().len();
    let full = h.files[0].1.len() as u64;
    assert!(kept > 0 && kept < full, "kept {kept} of {full}");
    assert!(!dir.join("m-Q4_K_M.gguf").exists());

    let (tx, mut rx) = mpsc::channel(512);
    let done = import_repo_at(
        &base,
        "o/m",
        "Q4_K_M",
        &layout,
        &client(),
        Some(tx),
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    // the second call asked for the rest, not the whole file
    let log = h.log.lock().unwrap().join("\n").to_ascii_lowercase();
    assert!(log.contains(&format!("range: bytes={kept}-")), "{log}");
    assert_eq!(std::fs::read(&done.path).unwrap(), h.files[0].1);
    assert!(!part.exists());
    assert_eq!(done.id, "o/m:Q4_K_M");
    assert_eq!(done.meta.arch, "llama");
    assert_eq!(
        done.mmproj.as_ref().map(|p| std::fs::read(p).unwrap()),
        Some(h.files[1].1.clone())
    );
    let mut last = 0;
    while let Ok(p) = rx.try_recv() {
        assert!(p >= last);
        last = p;
    }
    assert_eq!(last, 100);
    assert_eq!(files_in(&dir), ["m-Q4_K_M.gguf", "mmproj-F16.gguf"]);

    // an unknown quant is said plainly
    let none = import_repo_at(
        &base,
        "o/m",
        "Q2_K",
        &layout,
        &client(),
        None,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(matches!(none, Err(HfError::NoSuchQuant(_))));
}

#[tokio::test]
async fn digest_mismatch_deleted() {
    let base = serve(hub(false, true)).await;
    let layout = Layout::new(temp("digest"));
    let r = import_repo_at(
        &base,
        "o/m",
        "Q4_K_M",
        &layout,
        &client(),
        None,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(matches!(r, Err(HfError::Digest(_))), "{r:?}");
    let dir = layout.cache().join("models").join("o/m").join("Q4_K_M");
    // neither a finished file nor a half one is left to be mistaken for a model
    assert_eq!(files_in(&dir), Vec::<String>::new());
}

#[tokio::test]
async fn token_only_to_hf() {
    let h = hub(false, false);
    let base = serve(h.clone()).await;
    let layout = Layout::new(temp("token"));
    let tok = concat!("hf_", "notarealtoken");
    import_repo_at(
        &base,
        "o/m",
        "Q4_K_M",
        &layout,
        &client(),
        None,
        CancellationToken::new(),
        Some(tok),
    )
    .await
    .unwrap();
    quants_at(&base, "o/m", None, &client(), Some(tok))
        .await
        .unwrap();
    let log = h.log.lock().unwrap().join("\n").to_ascii_lowercase();
    assert!(log.contains("get /o/m/resolve/"), "the downloads ran");
    assert!(
        !log.contains("authorization") && !log.contains("notarealtoken"),
        "{log}"
    );

    assert_eq!(
        token_for("https://huggingface.co/api/models/o/m", Some(tok)).as_deref(),
        Some(concat!("Bearer ", "hf_", "notarealtoken"))
    );
    assert_eq!(token_for("https://huggingface.co/x", None), None);
    for url in [
        "https://cdn-lfs.hf.co/repos/x",
        "http://huggingface.co/x",
        "https://huggingface.co.evil.example/x",
        "https://evil.example/huggingface.co",
        "https://user@evil.example/",
        "http://127.0.0.1:1/x",
    ] {
        assert_eq!(token_for(url, Some(tok)), None, "{url}");
    }
}

#[test]
fn import_file_copies_with_split_and_projector() {
    let d = temp("file");
    let (a, b) = (
        d.join("m-00001-of-00002.gguf"),
        d.join("m-00002-of-00002.gguf"),
    );
    std::fs::write(&a, llama(Some((0, 2)), 10)).unwrap();
    std::fs::write(&b, llama(Some((1, 2)), 20)).unwrap();
    std::fs::write(d.join("mmproj-f16.gguf"), mmproj()).unwrap();
    let layout = Layout::new(temp("home"));

    let r = import_file(&a, &layout, false).unwrap();
    // a plain path: Windows' verbatim prefix is not passed on
    let want = std::fs::canonicalize(&a).unwrap();
    let want = want.to_string_lossy();
    assert_eq!(
        r.path.to_string_lossy(),
        want.strip_prefix(r"\\?\").unwrap_or(&want)
    );
    assert!(r.mmproj.is_some());

    let c = import_file(&a, &layout, true).unwrap();
    assert!(c.path.starts_with(layout.cache()));
    assert_eq!(c.meta.parts.len(), 2);
    assert!(c
        .meta
        .parts
        .iter()
        .all(|p| p.is_file() && p.starts_with(layout.cache())));
    assert!(c.mmproj.as_ref().is_some_and(|p| p.is_file()));
    // the same file again lands in the same place
    assert_eq!(import_file(&b, &layout, true).unwrap().id, c.id);
    // a projector alone is not a model
    assert!(matches!(
        import_file(&d.join("mmproj-f16.gguf"), &layout, true),
        Err(HfError::Invalid(_))
    ));
}

#[test]
fn concurrent_copy_imports_do_not_collide() {
    let d = temp("conc");
    let layout = Arc::new(Layout::new(temp("conc-home")));
    let srcs: Vec<PathBuf> = (0..4)
        .map(|i| {
            let p = d.join(format!("m{}.gguf", i % 2));
            std::fs::write(&p, llama(None, 200_000 + (i % 2) * 7)).unwrap();
            p
        })
        .collect();
    let handles: Vec<_> = srcs
        .into_iter()
        .map(|p| {
            let layout = layout.clone();
            std::thread::spawn(move || import_file(&p, &layout, true))
        })
        .collect();
    for h in handles {
        let r = h.join().unwrap().unwrap();
        assert!(r.path.is_file());
        assert_eq!(r.meta.bytes, std::fs::metadata(&r.path).unwrap().len());
    }
}

#[test]
fn projector_added_later_is_copied() {
    let d = temp("late");
    let m = d.join("m.gguf");
    std::fs::write(&m, llama(None, 10)).unwrap();
    let layout = Layout::new(temp("late-home"));
    let first = import_file(&m, &layout, true).unwrap();
    assert!(first.mmproj.is_none());

    std::fs::write(d.join("mmproj-f16.gguf"), mmproj()).unwrap();
    let second = import_file(&m, &layout, true).unwrap();
    let proj = second.mmproj.expect("projector");
    assert!(proj.is_file() && proj.starts_with(layout.cache()));
    assert_ne!(second.id, first.id);
    // and importing it again finds the same place with the projector in it
    let third = import_file(&m, &layout, true).unwrap();
    assert_eq!(third.id, second.id);
    assert!(third.mmproj.is_some_and(|p| p.is_file()));
}

#[test]
fn installed_round_trip() {
    let d = temp("kv");
    let layout = Layout::new(d.clone());
    let p = d.join("m.gguf");
    std::fs::write(&p, llama(None, 8)).unwrap();
    let store = alexia_store::Store::open_in_memory().unwrap();
    assert!(hf::installed(&store).is_empty());
    let m = import_file(&p, &layout, false).unwrap();
    hf::record(&store, &m).unwrap();
    hf::record(&store, &m).unwrap();
    assert_eq!(hf::installed(&store), vec![m]);
    std::fs::remove_file(&p).unwrap();
    assert!(hf::installed(&store).is_empty());
}

#[cfg(windows)]
#[test]
fn import_file_path_not_verbatim() {
    let d = temp("plain");
    let a = d.join("m.gguf");
    std::fs::write(&a, llama(None, 10)).unwrap();
    std::fs::write(d.join("mmproj-f16.gguf"), mmproj()).unwrap();
    let r = import_file(&a, &Layout::new(temp("home")), false).unwrap();
    let mm = r.mmproj.unwrap();
    for p in [r.path, mm] {
        assert!(!p.to_string_lossy().starts_with(r"\\?\"), "{p:?}");
        assert!(p.is_file());
    }
}

async fn import_q4(base: &str, layout: &Layout) -> Result<hf::Installed, HfError> {
    import_repo_at(
        base,
        "o/m",
        "Q4_K_M",
        layout,
        &client(),
        None,
        CancellationToken::new(),
        None,
    )
    .await
}

fn q4_dir(layout: &Layout) -> PathBuf {
    layout.cache().join("models").join("o/m").join("Q4_K_M")
}

#[tokio::test]
async fn directory_in_place_of_model_redownloaded() {
    let h = hub(false, false);
    let base = serve(h.clone()).await;
    let layout = Layout::new(temp("dirmodel"));
    let dir = q4_dir(&layout);
    // a folder where the model file belongs, and another where a .part belongs
    std::fs::create_dir_all(dir.join("m-Q4_K_M.gguf").join("inner")).unwrap();
    std::fs::create_dir_all(dir.join("mmproj-F16.gguf.part")).unwrap();
    let done = import_q4(&base, &layout).await.unwrap();
    assert!(done.path.is_file());
    assert_eq!(std::fs::read(&done.path).unwrap(), h.files[0].1);
    assert!(done.mmproj.unwrap().is_file());
}

#[tokio::test]
async fn file_in_place_of_cache_dir_repaired() {
    let h = hub(false, false);
    let base = serve(h.clone()).await;
    let layout = Layout::new(temp("filedir"));
    let models = layout.cache().join("models").join("o");
    std::fs::create_dir_all(&models).unwrap();
    std::fs::write(models.join("m"), b"in the way").unwrap();
    let done = import_q4(&base, &layout).await.unwrap();
    assert_eq!(std::fs::read(&done.path).unwrap(), h.files[0].1);
}

/// Hashing a big existing file must not hold the only runtime thread.
#[tokio::test]
async fn hash_runs_off_the_runtime() {
    let h = hub(false, false);
    let base = serve(h.clone()).await;
    let layout = Layout::new(temp("bigmodel"));
    let dir = q4_dir(&layout);
    std::fs::create_dir_all(&dir).unwrap();
    // 256 MiB of zeros (sparse where the file system allows), the wrong size: hashed, then replaced
    let big = std::fs::File::create(dir.join("m-Q4_K_M.gguf")).unwrap();
    big.set_len(256 << 20).unwrap();
    drop(big);
    let ticks = Arc::new(AtomicU32::new(0));
    let ticker = tokio::spawn({
        let ticks = ticks.clone();
        async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                ticks.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    let started = std::time::Instant::now();
    let done = import_q4(&base, &layout).await.unwrap();
    let took = started.elapsed();
    ticker.abort();
    assert_eq!(std::fs::read(&done.path).unwrap(), h.files[0].1);
    // While a thread hashed, the runtime kept ticking: at least one tick per 100 ms (Windows
    // timers are coarse, ~15 ms). A blocked runtime manages a handful in total.
    let ticks = u128::from(ticks.load(Ordering::SeqCst));
    assert!(ticks * 100 >= took.as_millis(), "{ticks} ticks in {took:?}");
}
