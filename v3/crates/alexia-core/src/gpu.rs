// SPDX-License-Identifier: AGPL-3.0-only
//! The GPU: what fits (MO-02), the load cap (MO-08), stepping aside for games (MO-09).
//!
//! Ports v2 `fit.ts` (weights + KV cache + overhead) and `nvidia.ts` (asking `nvidia-smi`). This
//! module only detects a game; the hub turns `GpuEvent::StepAside` into stopping what Alexia runs on the GPU.

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
use tokio::sync::mpsc;
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
            // pid is the first field and memory the last; the name between may hold commas.
            let (pid, rest) = l.split_once(',')?;
            let mut f = rest.rsplitn(2, ',');
            let mb = mb_of(f.next()?);
            Some(GpuProc {
                pid: pid.trim().parse().ok()?,
                exe: exe_of(f.next()?),
                graphics: false,
                mb,
            })
        })
        .collect()
}

/// Decode `&amp; &lt; &gt; &quot; &apos;` and numeric `&#N;` / `&#xH;`; anything else stays as is.
fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let decoded = rest.find(';').filter(|&e| e <= 10).and_then(|e| {
            let c = match &rest[1..e] {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                n => {
                    let n = n.strip_prefix('#')?;
                    let v = match n.strip_prefix(['x', 'X']) {
                        Some(h) => u32::from_str_radix(h, 16),
                        None => n.parse(),
                    };
                    char::from_u32(v.ok()?)?
                }
            };
            Some((c, e + 1))
        });
        match decoded {
            Some((c, n)) => {
                out.push(c);
                rest = &rest[n..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out + rest
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
        Some(xml_unescape(body[start..end].trim()))
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

/// A `.reg` file as `reg export` writes it: UTF-16LE, usually with a BOM.
#[doc(hidden)]
pub fn decode_reg(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_start_matches('\u{feff}')
        .to_string()
}

/// The string value `name` from `.reg` text: `"name"="C:\\Games"` -> `C:\Games`.
#[doc(hidden)]
pub fn reg_string(text: &str, name: &str) -> Option<String> {
    let head = format!("\"{name}\"=\"");
    let v = text
        .lines()
        .find_map(|l| l.trim().strip_prefix(&head))?
        .strip_suffix('"')?;
    let mut out = String::new();
    let mut it = v.chars();
    while let Some(c) = it.next() {
        out.push(if c == '\\' { it.next()? } else { c });
    }
    Some(out)
}

/// `reg export` into a temp file (UTF-16, so a non-ASCII path survives; `reg query` speaks the
/// OEM code page).
#[cfg(windows)]
fn reg_export(key: &str) -> String {
    use std::os::windows::process::CommandExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    // One file per call: two calls at once (two threads, two tests) must not share an export.
    static N: AtomicU64 = AtomicU64::new(0);
    // reg.exe itself fails now and then ("Unable to write to the file") when several run at
    // once, even into different files: one at a time in this process, and a retry for others.
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let n = N.fetch_add(1, Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("alexia-reg-{}-{n}.reg", std::process::id()));
    let export = || {
        std::process::Command::new("reg")
            .arg("export")
            .arg(key)
            .arg(&file)
            .arg("/y")
            .creation_flags(NO_WINDOW)
            .output()
            .is_ok_and(|o| o.status.success())
    };
    let ok = (0..3).any(|i| {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        export()
    });
    let text = if ok {
        std::fs::read(&file)
            .map(|b| decode_reg(&b))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let _ = std::fs::remove_file(&file);
    text
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
    let reg = reg_export("HKCU\\Software\\Valve\\Steam");
    let steam = reg_string(&reg, "SteamPath").map(PathBuf::from);
    if let Some(steam) = steam {
        let vdf = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf"))
            .unwrap_or_default();
        out.extend(steam_dirs(&steam, &vdf));
    }
    let Some(data) = std::env::var_os("ProgramData") else {
        return out;
    };
    let manifests = Path::new(&data).join(r"Epic\EpicGamesLauncher\Data\Manifests");
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

/// Polls in a row with no game before `game_over`: one missed poll, or one failed `nvidia-smi`,
/// must not make a running game look finished.
const QUIET_POLLS: u32 = 3;

type Source = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Vec<GpuProc>> + Send>> + Send + Sync>;

/// What the watcher tells the hub; the hub does the async work (`Runtime::stop_all`,
/// `McpHost::hold`, `LocalJobs::set_paused`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GpuEvent {
    /// A game started. `procs` is the GPU process list the decision was made on, so the hub
    /// finds the plugins on the GPU (`McpHost::pid`) without running nvidia-smi again.
    StepAside { procs: Vec<GpuProc> },
    /// The game ended (three quiet polls in a row).
    GameOver,
}

pub struct Watch {
    store: Arc<Store>,
    ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync>,
    source: Source,
    every: Duration,
}

impl Watch {
    /// Polls every 5 s; sends `StepAside` once when a game starts, `GameOver` once when it ends.
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

    /// Runs until `cancel`, or until `events` has no receiver. `StepAside` carries the process
    /// list the decision was made on; nothing restarts after a game: `GameOver` only reports it.
    pub async fn run(self, cancel: CancellationToken, events: mpsc::Sender<GpuEvent>) {
        let mut playing = false;
        let mut quiet = 0;
        loop {
            let procs = tokio::select! {
                () = cancel.cancelled() => return,
                () = events.closed() => return,
                p = (self.source)() => p,
            };
            let store = self.store.clone();
            let dirs = tokio::task::spawn_blocking(move || game_dirs(&store))
                .await
                .unwrap_or_default();
            let ours = (self.ours)();
            let now = procs.iter().any(|p| is_game(p, &dirs, &ours));
            quiet = if now { 0 } else { quiet + 1 };
            let event = if now && !playing {
                playing = true;
                Some(GpuEvent::StepAside { procs })
            } else if playing && quiet >= QUIET_POLLS {
                playing = false;
                Some(GpuEvent::GameOver)
            } else {
                None
            };
            if let Some(event) = event {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    sent = events.send(event) => if sent.is_err() { return },
                }
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                () = events.closed() => return,
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
