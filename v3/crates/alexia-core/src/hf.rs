// SPDX-License-Identifier: AGPL-3.0-only
//! Hugging Face import and GGUF split files (MO-13).
//!
//! Ported from v2: `packages/core/src/gguf.ts` (`readGguf`: header parse, split group),
//! `hf.ts` (`validRepo`, `validPath`, `quantOf`, `group`, `resolveUrl`, `pages`),
//! `importModel.ts` (`importGguf`: hash, copy, verify, rename into place) and the resume logic of
//! `download.ts` (`.part` beside the target, `Range` resume, the rename is the commit, hash
//! checked before it). A file at its real path is always a whole, verified file.
//!
//! The Hugging Face token (`secrets::get("_core", "hf_token")`) is sent only to `huggingface.co`
//! (https). It is never sent to the CDN a download redirects to (reqwest drops `Authorization`
//! on a cross-host redirect) and never put in an error.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use alexia_store::{secrets, Layout, Store};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const HUB: &str = "https://huggingface.co";
const MAX_HEADER: u64 = 128 * 1024 * 1024;
const MAX_KEYS: u64 = 100_000;
const MAX_ARRAY: u64 = 10_000_000;
const MAX_PARTS: u64 = 128;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest a download may sit without a byte.
const STALL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GgufMeta {
    pub arch: String,
    pub layers: u32,
    pub context: u32,
    /// `2 * layers * kv_heads * (key_len + value_len)`, f16 cache; 0 when the header cannot say.
    pub kv_bytes_per_token: u64,
    pub bytes: u64,
    /// All split parts in order (one entry for a single file).
    pub parts: Vec<PathBuf>,
    /// This file is an `mmproj` (arch `clip`), not a text model.
    pub vision_projector: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Quant {
    pub name: String,
    pub files: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Installed {
    pub id: String,
    pub path: PathBuf,
    pub meta: GgufMeta,
    pub mmproj: Option<PathBuf>,
}

/// Each variant is a sentence the owner can read.
#[derive(Debug, thiserror::Error)]
pub enum HfError {
    #[error("{0}")]
    Invalid(String),
    #[error("This is not a usable GGUF file: {0}")]
    BadGguf(String),
    #[error("The split model is missing a part: {0}")]
    MissingPart(String),
    #[error("The split model's parts do not belong together: {0}")]
    SplitMismatch(String),
    #[error("Hugging Face requires access to this repository. Add a token and accept its access terms on Hugging Face.")]
    Access,
    #[error("Hugging Face failed: {0}")]
    Http(String),
    #[error("The repository has no complete quant called {0}.")]
    NoSuchQuant(String),
    #[error("The download of {0} did not match its checksum and was deleted.")]
    Digest(String),
    #[error("The download of {0} stopped early; it will resume where it left off.")]
    Incomplete(String),
    #[error("The import was cancelled.")]
    Cancelled,
    #[error("Could not read or write a file: {0}")]
    Io(String),
    #[error("Could not record the model: {0}")]
    Store(String),
}

fn io(e: std::io::Error) -> HfError {
    HfError::Io(e.to_string())
}
fn bad(s: &str) -> HfError {
    HfError::BadGguf(s.to_owned())
}

// ---- GGUF header (gguf.ts `parse`) ----

enum V {
    Num(u64),
    Str(String),
    Other,
}

struct Parsed {
    version: u32,
    kv: HashMap<String, V>,
}

impl Parsed {
    fn num(&self, key: &str) -> Option<u64> {
        match self.kv.get(key) {
            Some(V::Num(n)) => Some(*n),
            _ => None,
        }
    }
}

struct Header {
    r: BufReader<std::fs::File>,
    pos: u64,
    limit: u64,
}

impl Header {
    fn take(&mut self, n: u64) -> Result<(), HfError> {
        if self.pos.checked_add(n).is_none_or(|e| e > self.limit) {
            return Err(bad("truncated or oversized header"));
        }
        self.pos += n;
        Ok(())
    }
    fn bytes(&mut self, n: u64) -> Result<Vec<u8>, HfError> {
        self.take(n)?;
        let mut b = vec![0u8; n as usize];
        self.r.read_exact(&mut b).map_err(io)?;
        Ok(b)
    }
    fn skip(&mut self, n: u64) -> Result<(), HfError> {
        self.take(n)?;
        self.r.seek(SeekFrom::Current(n as i64)).map_err(io)?;
        Ok(())
    }
    fn u32(&mut self) -> Result<u32, HfError> {
        Ok(u32::from_le_bytes(
            self.bytes(4)?.try_into().unwrap_or_default(),
        ))
    }
    fn u64(&mut self) -> Result<u64, HfError> {
        Ok(u64::from_le_bytes(
            self.bytes(8)?.try_into().unwrap_or_default(),
        ))
    }
    fn string(&mut self, keep: bool, max: u64) -> Result<String, HfError> {
        let n = self.u64()?;
        if n > max {
            return Err(bad("a string is over the import limit"));
        }
        if !keep {
            self.skip(n)?;
            return Ok(String::new());
        }
        String::from_utf8(self.bytes(n)?).map_err(|_| bad("metadata is not valid UTF-8"))
    }
    fn value(&mut self, ty: u32, keep: bool) -> Result<V, HfError> {
        let width = |t: u32| match t {
            0 | 1 | 7 => Some(1),
            2 | 3 => Some(2),
            4..=6 => Some(4),
            10..=12 => Some(8),
            _ => None,
        };
        match ty {
            8 => {
                let s = self.string(keep, if keep { 4096 } else { 8 * 1024 * 1024 })?;
                Ok(if keep { V::Str(s) } else { V::Other })
            }
            9 => {
                let (elem, count) = (self.u32()?, self.u64()?);
                if count > MAX_ARRAY || elem == 9 || elem > 12 {
                    return Err(bad("unsupported or oversized array"));
                }
                if elem == 8 {
                    for _ in 0..count {
                        self.string(false, 8 * 1024 * 1024)?;
                    }
                } else {
                    self.skip(count * width(elem).ok_or_else(|| bad("bad array type"))?)?;
                }
                Ok(V::Other)
            }
            _ => {
                let w = width(ty).ok_or_else(|| bad("unknown metadata type"))?;
                let b = self.bytes(w)?;
                let mut le = [0u8; 8];
                le[..b.len()].copy_from_slice(&b);
                let raw = u64::from_le_bytes(le);
                Ok(match ty {
                    // signed ints: negative is not a size we keep
                    1 if raw > 0x7f => V::Other,
                    3 if raw > 0x7fff => V::Other,
                    5 if raw > 0x7fff_ffff => V::Other,
                    11 if raw > i64::MAX as u64 => V::Other,
                    6 | 12 | 7 => V::Other,
                    _ => V::Num(raw),
                })
            }
        }
    }
}

fn wanted(key: &str) -> bool {
    matches!(
        key,
        "general.architecture"
            | "general.type"
            | "general.alignment"
            | "split.no"
            | "split.count"
            | "split.tensors.count"
    ) || [
        ".context_length",
        ".block_count",
        ".embedding_length",
        ".attention.head_count",
        ".attention.head_count_kv",
        ".attention.key_length",
        ".attention.value_length",
    ]
    .iter()
    .any(|s| key.ends_with(s))
}

fn parse(path: &Path) -> Result<Parsed, HfError> {
    let file = std::fs::File::open(path).map_err(io)?;
    let size = file.metadata().map_err(io)?.len();
    let mut h = Header {
        r: BufReader::new(file),
        pos: 0,
        limit: size.min(MAX_HEADER),
    };
    if h.bytes(4)? != b"GGUF" {
        return Err(bad("not a little-endian GGUF file"));
    }
    let version = h.u32()?;
    if version != 2 && version != 3 {
        return Err(bad("only GGUF versions 2 and 3 are supported"));
    }
    let (_tensors, count) = (h.u64()?, h.u64()?);
    if count > MAX_KEYS {
        return Err(bad("too many metadata entries"));
    }
    let mut kv = HashMap::new();
    for _ in 0..count {
        let key = h.string(true, 1024)?;
        if !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || key.is_empty()
        {
            return Err(bad("invalid metadata key"));
        }
        let (ty, keep) = (h.u32()?, wanted(&key));
        let v = h.value(ty, keep)?;
        if keep {
            kv.insert(key, v);
        }
    }
    Ok(Parsed { version, kv })
}

fn split_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)^(.*)-(\d{5})-of-(\d{5})\.gguf$").expect("static regex"))
}

/// Follows split parts: all must exist and agree, or the error names the missing one.
pub fn read_gguf(path: &Path) -> Result<GgufMeta, HfError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| HfError::Invalid("The model path has no file name.".into()))?;
    let first = parse(path)?;
    let (count, no) = (first.num("split.count"), first.num("split.no"));
    let caps = split_re().captures(name);
    let dir = path.parent().unwrap_or(Path::new("."));
    let files: Vec<PathBuf> = match (caps, count) {
        (Some(c), Some(n)) if n > 1 => {
            if n > MAX_PARTS
                || c[3].parse::<u64>().ok() != Some(n)
                || c[2].parse::<u64>().ok() != no.map(|x| x + 1)
            {
                return Err(HfError::SplitMismatch(format!(
                    "{name} disagrees with its own split metadata"
                )));
            }
            (1..=n)
                .map(|i| dir.join(format!("{}-{i:05}-of-{n:05}.gguf", &c[1])))
                .collect()
        }
        (Some(c), _) if c[3].parse::<u64>().ok() != Some(1) || count.is_some_and(|n| n > 1) => {
            return Err(HfError::SplitMismatch(format!(
                "{name} is named as a split part but its metadata says it is not"
            )))
        }
        (None, Some(n)) if n > 1 => {
            return Err(HfError::SplitMismatch(format!(
                "{name} says it is one of {n} parts but is not named like one"
            )))
        }
        _ => vec![path.to_owned()],
    };
    let n = files.len() as u64;
    let (mut head, mut bytes) = (None, 0u64);
    for (i, f) in files.iter().enumerate() {
        let part_name = f
            .file_name()
            .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
        if !f.is_file() {
            return Err(HfError::MissingPart(part_name));
        }
        let p = parse(f)?;
        let h: &Parsed = head.get_or_insert(parse(&files[0])?);
        let same_arch = p.kv.get("general.architecture").and_then(|v| match v {
            V::Str(s) => Some(s),
            _ => None,
        }) == h.kv.get("general.architecture").and_then(|v| match v {
            V::Str(s) => Some(s),
            _ => None,
        });
        if n > 1
            && (!same_arch
                || p.version != h.version
                || p.num("split.count") != Some(n)
                || p.num("split.no") != Some(i as u64))
        {
            return Err(HfError::SplitMismatch(format!(
                "{part_name} does not match the first part"
            )));
        }
        bytes += std::fs::metadata(f).map_err(io)?.len();
    }
    let h = head.ok_or_else(|| bad("no parts"))?;
    let Some(V::Str(arch)) = h.kv.get("general.architecture") else {
        return Err(bad("the model architecture is missing"));
    };
    if arch.is_empty()
        || arch.len() > 64
        || !arch
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
    {
        return Err(bad("the model architecture is invalid"));
    }
    if let Some(V::Str(t)) = h.kv.get("general.type") {
        if t != "model" {
            return Err(bad("adapters are not standalone models"));
        }
    }
    let g = |s: &str| h.num(&format!("{arch}.{s}"));
    let small = |v: Option<u64>| v.and_then(|x| u32::try_from(x).ok()).unwrap_or(0);
    let (layers, context) = (small(g("block_count")), small(g("context_length")));
    let heads = g("attention.head_count").unwrap_or(0);
    let kv_heads = match h.kv.get(&format!("{arch}.attention.head_count_kv")) {
        None => heads,
        Some(V::Num(n)) => *n,
        Some(_) => 0,
    };
    let emb = g("embedding_length").unwrap_or(0);
    let each = |k: &str| g(k).unwrap_or(emb.checked_div(heads).unwrap_or(0));
    let kv_bytes = 2u64
        .saturating_mul(u64::from(layers))
        .saturating_mul(kv_heads)
        .saturating_mul(each("attention.key_length") + each("attention.value_length"));
    Ok(GgufMeta {
        vision_projector: arch == "clip",
        arch: arch.clone(),
        layers,
        context,
        kv_bytes_per_token: kv_bytes,
        bytes,
        parts: files,
    })
}

// ---- hf.ts ----

fn re(cell: &'static OnceLock<Regex>, p: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(p).expect("static regex"))
}

fn valid_repo(id: &str) -> Result<(), HfError> {
    static SEG: OnceLock<Regex> = OnceLock::new();
    let seg = re(&SEG, r"^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$");
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|s| {
            s.len() > 96
                || !seg.is_match(s)
                || s.contains("..")
                || s.contains("--")
                || s.to_ascii_lowercase().ends_with(".git")
        })
    {
        return Err(HfError::Invalid(
            "Use a Hugging Face repository name in the form owner/model.".into(),
        ));
    }
    Ok(())
}

/// These names also become local paths: refuse traversal and Windows aliases.
fn valid_path(p: &str) -> Result<(), HfError> {
    static RESERVED: OnceLock<Regex> = OnceLock::new();
    let reserved = re(&RESERVED, r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)");
    if p.is_empty()
        || p.chars()
            .any(|c| c.is_control() || "\\%<>:\"|?*".contains(c))
        || p.split('/').any(|s| {
            s.is_empty() || s == "." || s == ".." || s.ends_with(['.', ' ']) || reserved.is_match(s)
        })
    {
        return Err(HfError::Invalid(
            "The repository contains an unsafe file path.".into(),
        ));
    }
    Ok(())
}

fn valid_revision(r: &str) -> Result<(), HfError> {
    if r.is_empty()
        || r.contains("..")
        || r.starts_with(['.', '/', '-'])
        || !r
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        || r.split('/').any(|s| s.is_empty() || s == ".")
    {
        return Err(HfError::Invalid("Invalid Hugging Face revision.".into()));
    }
    Ok(())
}

fn is_commit(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn enc(seg: &str) -> String {
    seg.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Downloads are pinned to a full commit; every path segment is encoded.
fn resolve_url(base: &str, repo: &str, commit: &str, path: &str) -> Result<String, HfError> {
    valid_repo(repo)?;
    if !is_commit(commit) {
        return Err(HfError::Invalid(
            "A download must be pinned to a full commit hash.".into(),
        ));
    }
    valid_path(path)?;
    let p: Vec<String> = path.split('/').map(enc).collect();
    Ok(format!(
        "{base}/{repo}/resolve/{}/{}",
        commit.to_ascii_lowercase(),
        p.join("/")
    ))
}

/// The GGUF quant token of a weights file name; projectors and non-GGUF give `None`.
pub fn quant_of(path: &str) -> Option<String> {
    static STEM: OnceLock<Regex> = OnceLock::new();
    static Q: OnceLock<Regex> = OnceLock::new();
    let base = path.rsplit('/').next().unwrap_or("");
    let lower = base.to_ascii_lowercase();
    if !lower.ends_with(".gguf") || lower.contains("mmproj") || lower.contains("projector") {
        return None;
    }
    let stem = re(&STEM, r"(?i)(?:-\d+-of-\d+)?\.gguf$").replace(base, "");
    // The whole token, so Q6_K_L and UD-Q4_K_XL never collapse into Q6_K / Q4_K.
    re(
        &Q,
        r"(?i)(?:^|[-._])((?:UD-)?(?:IQ\d|Q\d)(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32)(?:$|[-.])",
    )
    .captures(&stem)
    .map(|c| c[1].to_ascii_uppercase())
}

#[derive(Clone, PartialEq)]
struct File {
    name: String,
    bytes: u64,
    /// From HF's LFS info; absent for a file that is not in LFS.
    sha256: Option<String>,
}

fn file_of(row: &Value) -> Option<File> {
    let (path, lfs) = (row["path"].as_str()?, &row["lfs"]);
    let bytes = lfs["size"].as_u64().or(row["size"].as_u64())?;
    if bytes == 0
        || lfs["size"]
            .as_u64()
            .zip(row["size"].as_u64())
            .is_some_and(|(a, b)| a != b)
    {
        return None;
    }
    // Git blob ids and Xet hashes are not SHA-256 content checksums.
    let sha256 = lfs["oid"]
        .as_str()
        .filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    Some(File {
        name: path.to_owned(),
        bytes,
        sha256,
    })
}

/// Group by filename stem and directory; never join shards of different builds. One complete
/// build per quant: a whole file first, then the shorter path. Smallest quant first.
fn group(rows: &[Value]) -> Result<Vec<(String, Vec<File>)>, HfError> {
    struct Build {
        quant: String,
        of: u32,
        files: BTreeMap<u32, File>,
        invalid: bool,
        key: String,
    }
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let split_re = re(&SPLIT, r"(?i)-(\d+)-of-(\d+)\.gguf$");
    let mut builds: BTreeMap<String, Build> = BTreeMap::new();
    let mut seen: HashMap<String, File> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();
    for row in rows {
        let Some(path) = row["path"].as_str() else {
            continue;
        };
        if row["type"] != "file" || !path.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        valid_path(path)?;
        let (Some(quant), Some(file)) = (quant_of(path), file_of(row)) else {
            continue;
        };
        if let Some(prev) = seen.get(path) {
            if *prev != file {
                ambiguous.insert(path.to_owned());
            }
            continue;
        }
        seen.insert(path.to_owned(), file.clone());
        let split = split_re.captures(path);
        // A shard-looking name that failed the split parser must not become a whole model.
        if split.is_none() && path.to_ascii_lowercase().contains("-of-") {
            continue;
        }
        let (index, of) = split.as_ref().map_or((1, 1), |c| {
            (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0))
        });
        if index < 1 || of < 1 || index > of {
            continue;
        }
        let key = split.map_or_else(
            || path.to_owned(),
            |c| path[..c.get(0).map_or(0, |m| m.start())].to_owned(),
        );
        let b = builds.entry(key.clone()).or_insert(Build {
            quant,
            of,
            files: BTreeMap::new(),
            invalid: false,
            key,
        });
        if b.of != of || b.files.contains_key(&index) {
            b.invalid = true;
        }
        b.files.insert(index, file);
    }
    let mut ok: Vec<&Build> = builds
        .values()
        .filter(|b| {
            !b.invalid
                && b.files.len() == b.of as usize
                && b.files.values().all(|f| !ambiguous.contains(&f.name))
        })
        .collect();
    ok.sort_by(|a, b| (a.of > 1, a.key.len(), &a.key).cmp(&(b.of > 1, b.key.len(), &b.key)));
    let mut out: BTreeMap<String, Vec<File>> = BTreeMap::new();
    for b in ok {
        out.entry(b.quant.clone())
            .or_insert_with(|| b.files.values().cloned().collect());
    }
    let mut v: Vec<_> = out.into_iter().collect();
    v.sort_by(|a, b| {
        let bytes = |f: &Vec<File>| f.iter().map(|x| x.bytes).sum::<u64>();
        bytes(&a.1).cmp(&bytes(&b.1)).then_with(|| a.0.cmp(&b.0))
    });
    Ok(v)
}

fn quants_of(groups: Vec<(String, Vec<File>)>) -> Vec<Quant> {
    groups
        .into_iter()
        .map(|(name, files)| Quant {
            name,
            bytes: files.iter().map(|f| f.bytes).sum(),
            files: files.into_iter().map(|f| f.name).collect(),
        })
        .collect()
}

/// Quants from a repo listing (`/api/models/<repo>/tree` rows), as v2's `group`.
#[doc(hidden)]
pub fn group_rows(rows: &[Value]) -> Result<Vec<Quant>, HfError> {
    group(rows).map(quants_of)
}

/// The header to send to `url`: the token goes to https://huggingface.co and nowhere else.
#[doc(hidden)]
pub fn token_for(url: &str, token: Option<&str>) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    (u.scheme() == "https" && u.host_str() == Some("huggingface.co"))
        .then(|| token.map(|t| format!("Bearer {t}")))?
}

fn hf_token() -> Option<String> {
    secrets::get("_core", "hf_token")
        .ok()
        .flatten()
        .filter(|t| !t.is_empty())
}

fn get(client: &reqwest::Client, url: &str, token: Option<&str>) -> reqwest::RequestBuilder {
    let mut r = client.get(url);
    if let Some(mut h) =
        token_for(url, token).and_then(|h| reqwest::header::HeaderValue::from_str(&h).ok())
    {
        h.set_sensitive(true);
        r = r.header(reqwest::header::AUTHORIZATION, h);
    }
    r
}

fn net(e: reqwest::Error) -> HfError {
    // Transport errors can carry URLs and headers: say only the kind.
    HfError::Http(e.without_url().to_string())
}

fn status_error(s: reqwest::StatusCode) -> HfError {
    if s == 401 || s == 403 {
        HfError::Access
    } else {
        HfError::Http(format!("it answered {s}. Please try again."))
    }
}

async fn json(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<(Value, Option<String>), HfError> {
    let resp = get(client, url, token)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(net)?;
    if !resp.status().is_success() {
        return Err(status_error(resp.status()));
    }
    let link = resp
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|l| l.to_str().ok())
        .map(str::to_owned);
    Ok((resp.json().await.map_err(net)?, link))
}

/// The `rel="next"` URL of a Link header; it must stay on the same host and path.
fn next_page(link: &str, current: &str) -> Result<Option<String>, HfError> {
    let cur = reqwest::Url::parse(current).map_err(|_| HfError::Http("bad pagination".into()))?;
    for entry in link.split(", <").map(|e| e.trim_start_matches('<')) {
        if !entry
            .replace(' ', "")
            .to_ascii_lowercase()
            .contains("rel=\"next\"")
        {
            continue;
        }
        let target = entry.split('>').next().unwrap_or("");
        let u = cur
            .join(target)
            .map_err(|_| HfError::Http("bad pagination URL".into()))?;
        if u.origin() != cur.origin() || u.path() != cur.path() {
            return Err(HfError::Http(
                "it returned an unsafe pagination link.".into(),
            ));
        }
        return Ok(Some(u.into()));
    }
    Ok(None)
}

async fn pages(
    client: &reqwest::Client,
    first: String,
    token: Option<&str>,
) -> Result<Vec<Value>, HfError> {
    let (mut rows, mut next, mut n) = (Vec::new(), Some(first), 0);
    while let Some(url) = next {
        n += 1;
        if n > 1000 {
            return Err(HfError::Http("its pagination did not finish.".into()));
        }
        let (body, link) = json(client, &url, token).await?;
        rows.extend(
            body.as_array()
                .ok_or_else(|| HfError::Http("it returned an invalid listing.".into()))?
                .iter()
                .cloned(),
        );
        next = match link {
            Some(l) => next_page(&l, &url)?,
            None => None,
        };
    }
    Ok(rows)
}

struct Plan {
    commit: String,
    quant: String,
    files: Vec<File>,
    mmproj: Option<File>,
}

/// Pin the revision to a commit, list its files.
async fn listing(
    base: &str,
    repo: &str,
    revision: Option<&str>,
    client: &reqwest::Client,
    token: Option<&str>,
) -> Result<(String, Vec<Value>), HfError> {
    valid_repo(repo)?;
    let suffix = match revision {
        Some(r) => {
            valid_revision(r)?;
            format!("/revision/{}", r.replace('/', "%2F"))
        }
        None => String::new(),
    };
    let (meta, _) = json(client, &format!("{base}/api/models/{repo}{suffix}"), token).await?;
    let commit = meta["sha"]
        .as_str()
        .filter(|s| is_commit(s))
        .ok_or_else(|| HfError::Http("it did not provide a full commit hash.".into()))?
        .to_ascii_lowercase();
    if revision.is_some_and(|r| is_commit(r) && !r.eq_ignore_ascii_case(&commit)) {
        return Err(HfError::Http(
            "it returned a different commit than requested.".into(),
        ));
    }
    let rows = pages(
        client,
        format!("{base}/api/models/{repo}/tree/{commit}?recursive=true"),
        token,
    )
    .await?;
    Ok((commit, rows))
}

#[doc(hidden)]
pub async fn quants_at(
    base: &str,
    repo: &str,
    revision: Option<&str>,
    client: &reqwest::Client,
    token: Option<&str>,
) -> Result<Vec<Quant>, HfError> {
    let (_, rows) = listing(base, repo, revision, client, token).await?;
    group_rows(&rows)
}

/// The quants a repo offers, complete builds only (a split with a missing shard is left out).
pub async fn quants(
    repo: &str,
    revision: Option<&str>,
    client: &reqwest::Client,
) -> Result<Vec<Quant>, HfError> {
    quants_at(HUB, repo, revision, client, hf_token().as_deref()).await
}

fn plan_for(commit: String, rows: Vec<Value>, quant: &str) -> Result<Plan, HfError> {
    let (quant, files) = group(&rows)?
        .into_iter()
        .find(|(q, _)| q.eq_ignore_ascii_case(quant))
        .ok_or_else(|| HfError::NoSuchQuant(quant.to_owned()))?;
    // The projector in the same folder as the first weights file; f16 over the rest.
    let dir = files[0]
        .name
        .rsplit_once('/')
        .map_or("", |(d, _)| d)
        .to_owned();
    let mut proj: Vec<File> = rows
        .iter()
        .filter(|r| r["type"] == "file")
        .filter_map(file_of)
        .filter(|f| {
            let l = f.name.to_ascii_lowercase();
            l.ends_with(".gguf")
                && f.name.rsplit_once('/').map_or("", |(d, _)| d) == dir
                && l.rsplit('/')
                    .next()
                    .is_some_and(|b| b.starts_with("mmproj"))
        })
        .collect();
    proj.sort_by_key(|f| {
        let l = f.name.to_ascii_lowercase();
        (!l.contains("f16") || l.contains("bf16"), l)
    });
    Ok(Plan {
        commit,
        quant,
        mmproj: proj.into_iter().next(),
        files,
    })
}

// ---- download.ts: resumable, verified fetch ----

fn hex(d: impl AsRef<[u8]>) -> String {
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_file(path: &Path, upto: Option<u64>) -> std::io::Result<Sha256> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut left = upto.unwrap_or(u64::MAX);
    while left > 0 {
        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(h)
}

struct Progress<'a> {
    tx: Option<&'a mpsc::Sender<u8>>,
    total: u64,
    done: u64,
    told: Option<u8>,
}

impl Progress<'_> {
    async fn add(&mut self, n: u64) {
        self.done += n;
        let pct = (self.done.min(self.total) * 100)
            .checked_div(self.total)
            .unwrap_or(100) as u8;
        if let Some(tx) = self.tx {
            if self.told != Some(pct) {
                self.told = Some(pct);
                let _ = tx.send(pct).await;
            }
        }
    }
}

/// Fetch one file into `dest`: `.part` beside it, `Range` resume, hash before the rename.
async fn fetch(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    f: &File,
    dest: &Path,
    prog: &mut Progress<'_>,
    cancel: &CancellationToken,
) -> Result<(), HfError> {
    let part = PathBuf::from(format!("{}.part", dest.display()));
    if let Ok(m) = std::fs::metadata(dest) {
        // A finished file is reused only if it is still the right bytes.
        let hash = hash_file(dest, None).map_err(io)?;
        if m.len() == f.bytes
            && f.sha256
                .as_deref()
                .is_none_or(|s| s == hex(hash.finalize()))
        {
            prog.add(f.bytes).await;
            return Ok(());
        }
        std::fs::remove_file(dest).map_err(io)?;
    }
    let mut have = std::fs::metadata(&part).map_or(0, |m| m.len());
    if have > f.bytes {
        std::fs::remove_file(&part).map_err(io)?;
        have = 0;
    }
    let mut hasher = if have > 0 {
        hash_file(&part, Some(have)).map_err(io)?
    } else {
        Sha256::new()
    };
    if have < f.bytes {
        let mut req = get(client, url, token);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut resp = tokio::select! {
            r = req.send() => r.map_err(net)?,
            () = cancel.cancelled() => return Err(HfError::Cancelled),
        };
        let s = resp.status();
        if have > 0 && s == reqwest::StatusCode::PARTIAL_CONTENT {
            let ok = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with(&format!("bytes {have}-")));
            if !ok {
                return Err(HfError::Http("it resumed from the wrong place.".into()));
            }
        } else if s == reqwest::StatusCode::OK {
            // The server ignored Range (or there was nothing to resume): start over.
            have = 0;
            hasher = Sha256::new();
        } else {
            return Err(status_error(s));
        }
        let mut out = if have > 0 {
            tokio::fs::OpenOptions::new().append(true).open(&part).await
        } else {
            tokio::fs::File::create(&part).await
        }
        .map_err(io)?;
        prog.add(have).await;
        loop {
            let chunk = tokio::select! {
                c = tokio::time::timeout(STALL, resp.chunk()) => c,
                () = cancel.cancelled() => return Err(HfError::Cancelled),
            };
            let chunk = match chunk {
                Err(_) => return Err(HfError::Http("it stopped sending data.".into())),
                // A cut connection keeps what arrived: the next call resumes from it.
                Ok(Err(_)) => break,
                Ok(Ok(c)) => c,
            };
            let Some(bytes) = chunk else { break };
            hasher.update(&bytes);
            out.write_all(&bytes).await.map_err(io)?;
            prog.add(bytes.len() as u64).await;
        }
        out.flush().await.map_err(io)?;
    } else {
        prog.add(f.bytes).await;
    }
    let len = std::fs::metadata(&part).map_err(io)?.len();
    if len < f.bytes {
        return Err(HfError::Incomplete(f.name.clone()));
    }
    if len > f.bytes
        || f.sha256
            .as_deref()
            .is_some_and(|s| s != hex(hasher.finalize()))
    {
        let _ = std::fs::remove_file(&part);
        return Err(HfError::Digest(f.name.clone()));
    }
    std::fs::rename(&part, dest).map_err(io)
}

fn installed_id(repo: &str, quant: &str) -> String {
    format!("{repo}:{quant}")
}

#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub async fn import_repo_at(
    base: &str,
    repo: &str,
    quant: &str,
    layout: &Layout,
    client: &reqwest::Client,
    progress: Option<mpsc::Sender<u8>>,
    cancel: CancellationToken,
    token: Option<&str>,
) -> Result<Installed, HfError> {
    valid_repo(repo)?;
    if quant.is_empty()
        || !quant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(HfError::Invalid("That is not a quant name.".into()));
    }
    let (commit, rows) = tokio::select! {
        r = listing(base, repo, None, client, token) => r?,
        () = cancel.cancelled() => return Err(HfError::Cancelled),
    };
    let plan = plan_for(commit, rows, quant)?;
    let dir = layout.cache().join("models").join(repo).join(&plan.quant);
    std::fs::create_dir_all(&dir).map_err(io)?;
    let all: Vec<&File> = plan.files.iter().chain(plan.mmproj.as_ref()).collect();
    let mut prog = Progress {
        tx: progress.as_ref(),
        total: all.iter().map(|f| f.bytes).sum(),
        done: 0,
        told: None,
    };
    for f in &all {
        let name = f.name.rsplit('/').next().unwrap_or(&f.name);
        let url = resolve_url(base, repo, &plan.commit, &f.name)?;
        fetch(client, &url, token, f, &dir.join(name), &mut prog, &cancel).await?;
    }
    let local = |f: &File| dir.join(f.name.rsplit('/').next().unwrap_or(&f.name));
    let path = local(&plan.files[0]);
    let meta = read_gguf(&path)?;
    Ok(Installed {
        id: installed_id(repo, &plan.quant),
        path,
        meta,
        mmproj: plan.mmproj.as_ref().map(local),
    })
}

/// Download into `layout.cache()/models/<repo>/<quant>/`, resumable, SHA-256 from HF's LFS info.
/// Split files are downloaded together; an `mmproj*.gguf` beside them comes too (MO-06).
pub async fn import_repo(
    repo: &str,
    quant: &str,
    layout: &Layout,
    client: &reqwest::Client,
    progress: Option<mpsc::Sender<u8>>,
    cancel: CancellationToken,
) -> Result<Installed, HfError> {
    import_repo_at(
        HUB,
        repo,
        quant,
        layout,
        client,
        progress,
        cancel,
        hf_token().as_deref(),
    )
    .await
}

// ---- importModel.ts: a file already on disk ----

/// Copy `src` to `dst`, returning the SHA-256 of what was read.
fn copy_hashed(src: &Path, dst: &Path) -> Result<String, HfError> {
    let mut input = std::fs::File::open(src).map_err(io)?;
    let mut out = std::fs::File::create(dst).map_err(io)?;
    let (mut h, mut buf) = (Sha256::new(), vec![0u8; 1 << 20]);
    loop {
        let n = input.read(&mut buf).map_err(io)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(io)?;
    }
    out.sync_all().map_err(io)?;
    Ok(hex(h.finalize()))
}

/// An `mmproj*.gguf` beside the model that really is a projector.
fn sibling_mmproj(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.to_ascii_lowercase().starts_with("mmproj")
                    && n.to_ascii_lowercase().ends_with(".gguf")
            })
        })
        .collect();
    found.sort();
    found
        .into_iter()
        .find(|p| read_gguf(p).is_ok_and(|m| m.vision_projector))
}

/// Bring a GGUF (all its split parts) from disk into the hub. `copy` puts a verified copy under
/// `cache/models/local/<hash>/`; otherwise the file is used where it lies.
pub fn import_file(path: &Path, layout: &Layout, copy: bool) -> Result<Installed, HfError> {
    let src = std::fs::canonicalize(path).map_err(io)?;
    let meta = read_gguf(&src)?;
    if meta.vision_projector {
        return Err(HfError::Invalid(
            "That file is a vision projector, not a model. Import the model it belongs to.".into(),
        ));
    }
    let mmproj = src.parent().and_then(sibling_mmproj);
    if !copy {
        let id = hex(Sha256::digest(src.to_string_lossy().as_bytes()));
        return Ok(Installed {
            id: format!("local/{}", &id[..16]),
            path: meta.parts[0].clone(),
            meta,
            mmproj,
        });
    }
    let root = layout.cache().join("models").join("local");
    let staging = root.join(format!(".import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(io)?;
    let done = (|| {
        let mut group = Sha256::new();
        for p in meta.parts.iter().chain(mmproj.iter()) {
            let name = p.file_name().ok_or_else(|| bad("a part has no name"))?;
            let to = staging.join(name);
            let want = copy_hashed(p, &to)?;
            let got = hex(hash_file(&to, None).map_err(io)?.finalize());
            if want != got {
                return Err(HfError::Io("the copy does not match the source".into()));
            }
            if mmproj.as_ref().is_none_or(|m| m != p) {
                group.update(want.as_bytes());
            }
        }
        Ok(hex(group.finalize()))
    })();
    let id = match done {
        Ok(id) => id[..24].to_owned(),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let final_dir = root.join(&id);
    if final_dir.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    } else {
        std::fs::rename(&staging, &final_dir).map_err(io)?;
    }
    let first = final_dir.join(meta.parts[0].file_name().unwrap_or_default());
    Ok(Installed {
        id: format!("local/{id}"),
        meta: read_gguf(&first)?,
        path: first,
        mmproj: mmproj.and_then(|m| m.file_name().map(|n| final_dir.join(n))),
    })
}

// ---- the record ----

/// Record a model as installed (kv `_core`/`local_models`, replacing the same id).
pub fn record(store: &Store, model: &Installed) -> Result<(), HfError> {
    let mut all = installed_all(store);
    all.retain(|i| i.id != model.id);
    all.push(model.clone());
    let value = serde_json::to_value(all).map_err(|e| HfError::Store(e.to_string()))?;
    store
        .kv_set("_core", "local_models", &value)
        .map_err(|e| HfError::Store(e.to_string()))
}

fn installed_all(store: &Store) -> Vec<Installed> {
    store
        .kv_get("_core", "local_models")
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// kv `_core`/`local_models`; a model whose files have gone from disk is not listed.
pub fn installed(store: &Store) -> Vec<Installed> {
    let mut all = installed_all(store);
    all.retain(|i| i.meta.parts.iter().all(|p| p.is_file()));
    all
}
