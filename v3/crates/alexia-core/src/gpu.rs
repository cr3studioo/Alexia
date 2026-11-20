// SPDX-License-Identifier: AGPL-3.0-only
//! The GPU: what fits (MO-02), the load cap (MO-08), stepping aside for games (MO-09).
//!
//! Ports v2 `fit.ts` (weights + KV cache + overhead) and `nvidia.ts` (asking `nvidia-smi`). This
//! module only detects a game; the hub wires `step_aside` to stop what Alexia runs on the GPU.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use alexia_store::Store;
use regex::Regex;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const DEFAULT_HEADROOM_MB: u32 = 1536;
const POLL: Duration = Duration::from_secs(5);
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    pub vram_mb: u32,
    pub free_mb: u32,
    pub ram_mb: u32,
    pub gpu: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Fits,
    Tight,
    TooBig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fit {
    pub verdict: Verdict,
    pub gpu_layers: u32,
    pub vram_mb: u32,
}

/// v2 `fit.ts`: weights + KV cache for `context`, minus headroom.
///
/// The KV cache is padded to 256-token slots plus 10%, and the runtime needs 15% of the weights
/// (at least 1 GiB) as overhead, as in v2. `Fits` leaves 10% of the budget spare, `Tight` just
/// fits, and `TooBig` offloads as many whole layers as the budget holds (possibly none; the
/// rest runs from RAM). The budget is the free VRAM now (never more than the card's total) minus
/// `headroom_mb`.
pub fn fit(
    m: &Machine,
    model_bytes: u64,
    layers: u32,
    kv_bytes_per_token: u64,
    context: u32,
    headroom_mb: u32,
) -> Fit {
    let budget = u64::from(m.free_mb.min(m.vram_mb)).saturating_sub(u64::from(headroom_mb)) * MIB;
    let slots = u64::from(context).div_ceil(256) * 256;
    let kv = (slots as f64 * kv_bytes_per_token as f64 * 1.1).ceil() as u64;
    let overhead = GIB.max((model_bytes as f64 * 0.15).ceil() as u64);
    let need = model_bytes + kv + overhead;
    let mb = |b: u64| u32::try_from(b.div_ceil(MIB)).unwrap_or(u32::MAX);
    if need <= budget {
        let verdict = if need as f64 <= budget as f64 * 0.9 {
            Verdict::Fits
        } else {
            Verdict::Tight
        };
        return Fit {
            verdict,
            gpu_layers: layers,
            vram_mb: mb(need),
        };
    }
    let per_layer = (model_bytes + kv).div_ceil(u64::from(layers.max(1)));
    let n = (budget.saturating_sub(overhead) / per_layer.max(1)).min(u64::from(layers)) as u32;
    let used = if n == 0 {
        0
    } else {
        per_layer * u64::from(n) + overhead
    };
    Fit {
        verdict: Verdict::TooBig,
        gpu_layers: n,
        vram_mb: mb(used),
    }
}

/// One `nvidia-smi` run; `None` when it is missing, fails, or prints nothing. The command is also
/// tried by full path (v2 found it absent from a shell's short `PATH`). Warns once.
async fn smi(args: &[&str]) -> Option<String> {
    static WARNED: AtomicBool = AtomicBool::new(false);
    let mut commands = vec![PathBuf::from("nvidia-smi")];
    if cfg!(windows) {
        for (var, tail) in [
            ("SystemRoot", "System32"),
            ("ProgramW6432", "NVIDIA Corporation\\NVSMI"),
        ] {
            if let Some(base) = std::env::var_os(var) {
                commands.push(Path::new(&base).join(tail).join("nvidia-smi.exe"));
            }
        }
    }
    for exe in commands {
        let mut cmd = Command::new(&exe);
        cmd.args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(NO_WINDOW);
        let run = tokio::time::timeout(Duration::from_secs(10), cmd.output()).await;
        if let Ok(Ok(out)) = run {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            if out.status.success() && !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    if !WARNED.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            "nvidia-smi is missing or did not answer; treating this PC as having no NVIDIA GPU"
        );
    }
    None
}

/// `--query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`: the first card.
pub fn parse_machine_csv(text: &str) -> Option<(String, u32, u32)> {
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let mut f = line.split(',').map(str::trim);
    let name = f.next()?.to_string();
    let total = f.next()?.parse().ok()?;
    let free = f.next()?.parse().ok()?;
    Some((name, total, free))
}

#[cfg(windows)]
async fn ram_mb() -> u32 {
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
    ])
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .creation_flags(NO_WINDOW);
    match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .map_or(0, |b| u32::try_from(b / MIB).unwrap_or(u32::MAX)),
        _ => 0,
    }
}

#[cfg(not(windows))]
async fn ram_mb() -> u32 {
    let meminfo = tokio::fs::read_to_string("/proc/meminfo")
        .await
        .unwrap_or_default();
    meminfo
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))
        .and_then(|r| r.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
        .map_or(0, |kb| u32::try_from(kb / 1024).unwrap_or(u32::MAX))
}

/// `nvidia-smi --query-gpu=…` and `--query-compute-apps=…`, plus `-q -x` for graphics processes.
/// `None` when there is no NVIDIA GPU (or no driver).
pub async fn machine() -> Option<Machine> {
    let text = smi(&[
        "--query-gpu=name,memory.total,memory.free",
        "--format=csv,noheader,nounits",
    ])
    .await?;
    let (name, vram_mb, free_mb) = parse_machine_csv(&text)?;
    Some(Machine {
        vram_mb,
        free_mb,
        ram_mb: ram_mb().await,
        gpu: Some(name),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuProc {
    pub pid: u32,
    /// Empty when the driver would not say (`[Insufficient Permissions]`).
    pub exe: PathBuf,
    pub graphics: bool,
    /// 0 when the driver reports `[N/A]` (always so under WDDM).
    pub mb: u32,
}

fn mb_of(s: &str) -> u32 {
    s.trim().parse().unwrap_or(0)
}

fn exe_of(s: &str) -> PathBuf {
    let s = s.trim();
    if s.starts_with('[') {
        PathBuf::new()
    } else {
        PathBuf::from(s)
    }
}

/// `--query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`.
pub fn parse_compute_csv(text: &str) -> Vec<GpuProc> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.splitn(3, ',');
            let pid = f.next()?.trim().parse().ok()?;
            Some(GpuProc {
                pid,
                exe: exe_of(f.next()?),
                graphics: false,
                mb: mb_of(f.next()?),
            })
        })
        .collect()
}

/// `nvidia-smi -q -x`: every `<process_info>`; a `<type>` containing `G` is a graphics process
/// (`G` or `C+G`).
pub fn parse_xml_processes(xml: &str) -> Vec<GpuProc> {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    let block =
        BLOCK.get_or_init(|| Regex::new(r"(?s)<process_info>(.*?)</process_info>").unwrap());
    let tag = |body: &str, name: &str| -> Option<String> {
        let open = format!("<{name}>");
        let start = body.find(&open)? + open.len();
        let end = body[start..].find(&format!("</{name}>"))? + start;
        Some(body[start..end].trim().to_string())
    };
    block
        .captures_iter(xml)
        .filter_map(|c| {
            let b = &c[1];
            let mb = tag(b, "used_memory")
                .and_then(|m| m.split_whitespace().next().map(mb_of))
                .unwrap_or(0);
            Some(GpuProc {
                pid: tag(b, "pid")?.parse().ok()?,
                exe: exe_of(&tag(b, "process_name").unwrap_or_default()),
                graphics: tag(b, "type").is_some_and(|t| t.contains('G')),
                mb,
            })
        })
        .collect()
}

/// Everything using the GPU now; empty when there is no `nvidia-smi`.
pub async fn processes() -> Vec<GpuProc> {
    let Some(xml) = smi(&["-q", "-x"]).await else {
        return Vec::new();
    };
    let mut all = parse_xml_processes(&xml);
    let csv = smi(&[
        "--query-compute-apps=pid,process_name,used_memory",
        "--format=csv,noheader,nounits",
    ])
    .await
    .unwrap_or_default();
    for p in parse_compute_csv(&csv) {
        if !all.iter().any(|q| q.pid == p.pid) {
            all.push(p);
        }
    }
    all
}

#[cfg(windows)]
fn reg_query(args: &[&str]) -> String {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg")
        .arg("query")
        .args(args)
        .creation_flags(NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// The Steam folder's own `steamapps\common` plus every `"path"` in `libraryfolders.vdf`.
pub fn steam_dirs(steam: &Path, vdf: &str) -> Vec<PathBuf> {
    let mut out = vec![steam.join("steamapps").join("common")];
    for line in vdf.lines() {
        let mut q = line.split('"').skip(1).step_by(2);
        if q.next() == Some("path") {
            if let Some(p) = q.next() {
                let p = p.replace("\\\\", "\\");
                out.push(PathBuf::from(p).join("steamapps").join("common"));
            }
        }
    }
    out
}

/// Epic `*.item` manifests are JSON with an `InstallLocation`.
pub fn epic_dir(item: &str) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(item).ok()?;
    let p = v.get("InstallLocation")?.as_str()?;
    (!p.is_empty()).then(|| PathBuf::from(p))
}

#[cfg(windows)]
fn launcher_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let reg = reg_query(&["HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
    let steam = reg
        .lines()
        .find(|l| l.contains("SteamPath"))
        .and_then(|l| l.split("REG_SZ").nth(1))
        .map(|p| PathBuf::from(p.trim()));
    if let Some(steam) = steam {
        let vdf = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf"))
            .unwrap_or_default();
        out.extend(steam_dirs(&steam, &vdf));
    }
    let data = std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
    let manifests = Path::new(&data).join("Epic\\EpicGamesLauncher\\Data\\Manifests");
    if let Ok(rd) = std::fs::read_dir(manifests) {
        for e in rd.flatten() {
            if e.path().extension().is_some_and(|x| x == "item") {
                let text = std::fs::read_to_string(e.path()).ok();
                out.extend(text.and_then(|t| epic_dir(&t)));
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn launcher_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// Steam's and Epic's default libraries (from the registry/known folders) plus `_core.gpu.games`.
pub fn game_dirs(store: &Store) -> Vec<PathBuf> {
    let mut out = launcher_dirs();
    let extra = store
        .settings("_core")
        .ok()
        .and_then(|s| s.get("gpu.games").cloned());
    if let Some(serde_json::Value::Array(a)) = extra {
        out.extend(a.iter().filter_map(|v| v.as_str()).map(PathBuf::from));
    }
    out
}

fn under(exe: &Path, dir: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    let (e, d) = (norm(exe), norm(dir));
    let d = d.trim_end_matches('\\');
    !d.is_empty() && e.strip_prefix(d).is_some_and(|r| r.starts_with('\\'))
}

/// A graphics process Alexia did not start, running from a game library folder.
pub fn is_game(p: &GpuProc, dirs: &[PathBuf], ours: &[u32]) -> bool {
    p.graphics && !ours.contains(&p.pid) && dirs.iter().any(|d| under(&p.exe, d))
}

type Source = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Vec<GpuProc>> + Send>> + Send + Sync>;

pub struct Watch {
    store: Arc<Store>,
    ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync>,
    source: Source,
    every: Duration,
}

impl Watch {
    /// Polls every 5 s; on a game starting calls `step_aside` once; `game_over` once when it ends.
    pub fn new(store: Arc<Store>, ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync>) -> Watch {
        Watch {
            store,
            ours,
            source: Arc::new(|| Box::pin(processes())),
            every: POLL,
        }
    }

    /// Tests: a fake process list and a short poll.
    #[doc(hidden)]
    pub fn with_source(mut self, source: Source, every: Duration) -> Watch {
        self.source = source;
        self.every = every;
        self
    }

    /// Runs until `cancel`. Nothing restarts after a game: `game_over` only reports it.
    pub async fn run(
        self,
        cancel: CancellationToken,
        step_aside: impl Fn() + Send,
        game_over: impl Fn() + Send,
    ) {
        let mut playing = false;
        loop {
            let procs = tokio::select! {
                () = cancel.cancelled() => return,
                p = (self.source)() => p,
            };
            let store = self.store.clone();
            let dirs = tokio::task::spawn_blocking(move || game_dirs(&store))
                .await
                .unwrap_or_default();
            let ours = (self.ours)();
            let now = procs.iter().any(|p| is_game(p, &dirs, &ours));
            if now && !playing {
                step_aside();
            } else if !now && playing {
                game_over();
            }
            playing = now;
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(self.every) => {}
            }
        }
    }
}

/// `_core.gpu.headroom_mb`, default 1536.
pub fn headroom_mb(store: &Store) -> u32 {
    store
        .settings("_core")
        .ok()
        .and_then(|s| s.get("gpu.headroom_mb").and_then(serde_json::Value::as_u64))
        .map_or(DEFAULT_HEADROOM_MB, |v| {
            u32::try_from(v).unwrap_or(u32::MAX)
        })
}
