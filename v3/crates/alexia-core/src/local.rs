// SPDX-License-Identifier: AGPL-3.0-only
//! The managed llama.cpp runtime (MO-01, SP-17) and the local jobs D213 allows on the GPU
//! (MO-06, MO-07, the checker). P2-31 fills the runtime, P2-34 the jobs.
//!
//! Ported from v2's `packages/core/src/llama.ts`: the pinned release and its digests, the
//! `llama-server` arguments, `GET /health`, a free loopback port and a random API key per start.
//! Never resolves "latest". llama-server listening on loopback is the child's port, not the hub's.

use std::collections::hash_map::RandomState;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_store::{now_ms, Content, Layout, MessageBody, Part, Role, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::free::{Auth, FreeRow};
use crate::openai::OpenAiCompat;
use crate::router::Router;
use crate::{gpu, hf};
use crate::{ChatChunk, ChatDone, ChatRequest, Job, ModelInfo, Provider, ProviderError};

/// Digests copied from the GitHub release API for tag b11146 (source commit
/// 7fe450e19305b828c199d602c23a8337aaa1f03b), as in v2's `RUNTIME_ASSETS` / `ACCELERATOR_ASSETS`.
const VERSION: &str = "b11146";
const RELEASE_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b11146";
/// `win32-x64-cuda`, its cudart companion, and the CPU zip as the fallback.
const CUDA: (&str, &str) = (
    "llama-b11146-bin-win-cuda-12.4-x64.zip",
    "3c806a6ceccc3dae1c743ceb1a1fb2cce5b76f40bfbd4c6b7b8afb6ef45a5807",
);
const CUDART: (&str, &str) = (
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
);
const CPU: (&str, &str) = (
    "llama-b11146-bin-win-cpu-x64.zip",
    "14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1",
);
/// Expanded size bound, as v2's MAX_EXPANDED.
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
const READY: &str = ".ready";
const IDLE: Duration = Duration::from_secs(10 * 60);
const TICK: Duration = Duration::from_secs(60);
const BACKOFF: Duration = Duration::from_secs(1);
const MAX_RESTARTS: u32 = 5;
/// A server that lived this long before dying starts its restart count again.
const STABLE: Duration = Duration::from_secs(60);
const HEALTH_DEADLINE: Duration = Duration::from_secs(180);

pub struct LocalModel {
    pub id: String,
    pub path: PathBuf,
    pub mmproj: Option<PathBuf>,
    pub draft: Option<PathBuf>,
    pub context: u32,
    pub embedding: bool,
}

struct Spec {
    exe: PathBuf,
    args: Vec<String>,
}

struct Server {
    port: u16,
    key: String,
    pid: AtomicU32,
    used: Arc<Mutex<Instant>>,
    /// Chats in flight; the idle stopper never stops a server with one running.
    busy: Arc<AtomicU32>,
    stop: CancellationToken,
    dead: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
    provider: Arc<dyn Provider>,
}

/// The provider the router gets: `OpenAiCompat`, plus a stamp so the idle stopper sees use.
struct Local {
    inner: OpenAiCompat,
    used: Arc<Mutex<Instant>>,
    busy: Arc<AtomicU32>,
}

/// Counts a chat as in use for as long as it lives, even if its future is dropped.
struct InUse(Arc<AtomicU32>);

impl InUse {
    fn new(busy: &Arc<AtomicU32>) -> InUse {
        busy.fetch_add(1, Ordering::SeqCst);
        InUse(busy.clone())
    }
}

impl Drop for InUse {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Local {
    fn touch(&self) {
        *self.used.lock().unwrap() = Instant::now();
    }
}

#[async_trait::async_trait]
impl Provider for Local {
    fn id(&self) -> &str {
        self.inner.id()
    }

    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        self.touch();
        self.inner.models().await
    }

    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let _in_use = InUse::new(&self.busy);
        self.touch();
        let done = self.inner.chat(req, model, out, cancel).await;
        self.touch();
        done
    }
}

pub struct Runtime {
    layout: Layout,
    client: reqwest::Client,
    servers: Mutex<HashMap<String, Arc<Server>>>,
    /// One start or install at a time.
    starting: tokio::sync::Mutex<()>,
    /// Bumped by `stop_all`; a `serve` that began before it kills its new child instead of keeping it.
    epoch: AtomicU64,
    idle: Duration,
    tick: Duration,
    backoff: Duration,
}

impl Runtime {
    pub fn new(layout: Layout, client: reqwest::Client) -> Arc<Runtime> {
        Self::with_timing(layout, client, IDLE, TICK, BACKOFF)
    }

    /// Tests shorten the idle limit, the idle check and the restart backoff.
    #[doc(hidden)]
    pub fn with_timing(
        layout: Layout,
        client: reqwest::Client,
        idle: Duration,
        tick: Duration,
        backoff: Duration,
    ) -> Arc<Runtime> {
        Arc::new(Runtime {
            layout,
            client,
            servers: Mutex::new(HashMap::new()),
            starting: tokio::sync::Mutex::new(()),
            epoch: AtomicU64::new(0),
            idle,
            tick,
            backoff,
        })
    }

    fn dir(&self) -> PathBuf {
        self.layout.cache().join("llama").join(VERSION)
    }

    /// `ALEXIA_LLAMA_SERVER` wins (tests, a hand-placed build); else the receipt of an install.
    fn installed(&self) -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("ALEXIA_LLAMA_SERVER") {
            return Some(PathBuf::from(path));
        }
        let dir = self.dir();
        let rel = std::fs::read_to_string(dir.join(READY)).ok()?;
        let exe = dir.join(rel.trim());
        exe.is_file().then_some(exe)
    }

    /// Download + verify (SHA-256) + unzip into `layout.cache()/llama/b11146`, once. Progress 0..=100.
    pub async fn ensure(
        &self,
        progress: Option<mpsc::Sender<u8>>,
        cancel: CancellationToken,
    ) -> Result<PathBuf, LocalError> {
        if let Some(exe) = self.installed() {
            return Ok(exe);
        }
        if !Runtime::supported() {
            return Err(LocalError::Unsupported);
        }
        let _one = self.starting.lock().await;
        if let Some(exe) = self.installed() {
            return Ok(exe);
        }
        let root = self.layout.cache().join("llama");
        let part = root.join(format!("{VERSION}.part"));
        let _ = tokio::fs::remove_dir_all(&part).await;
        tokio::fs::create_dir_all(&part).await.map_err(io)?;

        let cuda = async {
            let url = format!("{RELEASE_URL}/{}", CUDA.0);
            self.install_archive(&url, CUDA.1, &part, (0, 39), progress.as_ref(), &cancel)
                .await?;
            let url = format!("{RELEASE_URL}/{}", CUDART.0);
            self.install_archive(&url, CUDART.1, &part, (39, 100), progress.as_ref(), &cancel)
                .await
        }
        .await;
        match cuda {
            Ok(()) => {}
            // A network failure falls back to the CPU build; a bad digest or a cancel does not.
            Err(LocalError::Download(_)) => {
                let _ = tokio::fs::remove_dir_all(&part).await;
                tokio::fs::create_dir_all(&part).await.map_err(io)?;
                let url = format!("{RELEASE_URL}/{}", CPU.0);
                let cpu = self
                    .install_archive(&url, CPU.1, &part, (0, 100), progress.as_ref(), &cancel)
                    .await;
                if let Err(e) = cpu {
                    let _ = tokio::fs::remove_dir_all(&part).await;
                    return Err(e);
                }
            }
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&part).await;
                return Err(e);
            }
        }

        let exe = find_exe(&part)
            .ok_or_else(|| LocalError::Install("the download has no llama-server in it".into()))?;
        let rel = exe.strip_prefix(&part).unwrap_or(&exe).to_owned();
        std::fs::write(part.join(READY), rel.to_string_lossy().as_bytes()).map_err(io)?;
        let dir = self.dir();
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::rename(&part, &dir).await.map_err(io)?;
        if let Some(tx) = &progress {
            let _ = tx.send(100).await;
        }
        Ok(dir.join(rel))
    }

    /// Download `url` to a temp file, check its SHA-256, then unzip into `dest`. Progress is
    /// scaled into `range`. Public only so the tests can feed it their own archive and digest.
    #[doc(hidden)]
    pub async fn install_archive(
        &self,
        url: &str,
        sha256: &str,
        dest: &Path,
        range: (u8, u8),
        progress: Option<&mpsc::Sender<u8>>,
        cancel: &CancellationToken,
    ) -> Result<(), LocalError> {
        let tmp = dest.join(format!(".download-{}.zip", std::process::id()));
        let got = self.fetch(url, sha256, &tmp, range, progress, cancel).await;
        let result = match got {
            Ok(()) => {
                let (zip, to) = (tmp.clone(), dest.to_owned());
                tokio::task::spawn_blocking(move || unzip(&zip, &to))
                    .await
                    .map_err(|e| LocalError::Install(e.to_string()))
                    .and_then(|r| r)
            }
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&tmp).await;
        result
    }

    async fn fetch(
        &self,
        url: &str,
        sha256: &str,
        path: &Path,
        (lo, hi): (u8, u8),
        progress: Option<&mpsc::Sender<u8>>,
        cancel: &CancellationToken,
    ) -> Result<(), LocalError> {
        let dl = |e: reqwest::Error| LocalError::Download(e.without_url().to_string());
        let sent = tokio::select! {
            r = self.client.get(url).send() => r,
            () = cancel.cancelled() => return Err(LocalError::Cancelled),
        };
        let mut resp = sent.map_err(dl)?.error_for_status().map_err(dl)?;
        let total = resp.content_length();
        let mut file = tokio::fs::File::create(path).await.map_err(io)?;
        let mut hasher = Sha256::new();
        let mut got: u64 = 0;
        loop {
            let chunk = tokio::select! {
                c = resp.chunk() => c,
                () = cancel.cancelled() => return Err(LocalError::Cancelled),
            };
            let Some(bytes) = chunk.map_err(dl)? else {
                break;
            };
            hasher.update(&bytes);
            file.write_all(&bytes).await.map_err(io)?;
            got += bytes.len() as u64;
            if let (Some(tx), Some(total)) = (progress, total.filter(|t| *t > 0)) {
                let span = u64::from(hi - lo);
                let _ = tx.send(lo + (span * got.min(total) / total) as u8).await;
            }
        }
        file.flush().await.map_err(io)?;
        drop(file);
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !digest.eq_ignore_ascii_case(sha256) {
            let _ = tokio::fs::remove_file(path).await;
            return Err(LocalError::BadDigest);
        }
        Ok(())
    }

    /// Start (or reuse) a server for `model`; `gpu_layers` from `gpu::fit` (P2-32). Returns a Provider
    /// whose id is `local:<model.id>`.
    pub async fn serve(
        &self,
        model: &LocalModel,
        gpu_layers: u32,
    ) -> Result<Arc<dyn Provider>, LocalError> {
        let _one = self.starting.lock().await;
        let epoch = self.epoch.load(Ordering::SeqCst);
        // Reuse under the servers lock, so the idle stopper's re-check sees the fresh `used`.
        let stale = match self.servers.lock().unwrap().get(&model.id) {
            Some(s) if !s.dead.load(Ordering::SeqCst) && !s.stop.is_cancelled() => {
                *s.used.lock().unwrap() = Instant::now();
                return Ok(s.provider.clone());
            }
            other => other.is_some(),
        };
        if stale {
            self.stop_server(&model.id).await;
        }
        let exe = self.installed().ok_or(LocalError::NotInstalled)?;
        let port = free_port().map_err(io)?;
        let key = random_key();
        let spec = Spec {
            args: server_args(model, gpu_layers, port, &key),
            exe,
        };
        let (mut child, job) = spawn(&spec).map_err(|e| LocalError::Start(e.to_string()))?;
        let up = wait_healthy(&self.client, &mut child, port, &self.epoch, epoch).await;
        if let Err(e) = up {
            job.kill();
            let _ = child.kill().await;
            return Err(e);
        }
        let used = Arc::new(Mutex::new(Instant::now()));
        let busy = Arc::new(AtomicU32::new(0));
        let row = FreeRow {
            id: format!("local:{}", model.id),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            models_path: Some("/models".into()),
            headers: Vec::new(),
            auth: Auth::Required,
            all_free: true,
            rpm: None,
            rpd: None,
            router: false,
        };
        let provider: Arc<dyn Provider> = Arc::new(Local {
            inner: OpenAiCompat::new(row, Some(key.clone()), self.client.clone()),
            used: used.clone(),
            busy: busy.clone(),
        });
        let server = Arc::new(Server {
            port,
            key,
            pid: AtomicU32::new(child.id().unwrap_or(0)),
            used,
            busy,
            stop: CancellationToken::new(),
            dead: AtomicBool::new(false),
            task: Mutex::new(None),
            provider: provider.clone(),
        });
        {
            // stop_all bumps the epoch before it lists the servers under this lock, so checking
            // the epoch here, with the insert, closes the gap after wait_healthy's last check.
            let mut servers = self.servers.lock().unwrap();
            if self.epoch.load(Ordering::SeqCst) == epoch {
                let task =
                    tokio::spawn(supervise(spec, (child, job), server.clone(), self.backoff));
                *server.task.lock().unwrap() = Some(task);
                servers.insert(model.id.clone(), server);
                return Ok(provider);
            }
        }
        job.kill();
        let _ = child.kill().await;
        Err(LocalError::Start("everything was stopped meanwhile".into()))
    }

    async fn stop_server(&self, model_id: &str) {
        let server = self.servers.lock().unwrap().remove(model_id);
        shutdown(server).await;
    }

    pub async fn stop(&self, model_id: &str) {
        self.stop_server(model_id).await;
    }

    /// D213 / MO-09: stop everything now.
    pub async fn stop_all(&self) {
        // Not the `starting` lock (an install can hold it for minutes): a serve that is still
        // starting sees the new epoch, kills its child and fails.
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let ids: Vec<String> = self.servers.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop_server(&id).await;
        }
    }

    pub fn pids(&self) -> Vec<u32> {
        let servers = self.servers.lock().unwrap();
        let mut pids: Vec<u32> = servers
            .values()
            .map(|s| s.pid.load(Ordering::SeqCst))
            .filter(|p| *p != 0)
            .collect();
        pids.sort_unstable();
        pids
    }

    /// Idle stopper: every minute, stop servers unused for 10 minutes.
    pub async fn run(&self, cancel: CancellationToken) {
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(self.tick) => {}
            }
            let ids: Vec<String> = self.servers.lock().unwrap().keys().cloned().collect();
            for id in ids {
                // Checked and removed under one lock: a serve or chat since then keeps it.
                let server = {
                    let mut servers = self.servers.lock().unwrap();
                    let idle = servers.get(&id).is_some_and(|s| {
                        s.busy.load(Ordering::SeqCst) == 0
                            && s.used.lock().unwrap().elapsed() >= self.idle
                    });
                    if idle {
                        servers.remove(&id)
                    } else {
                        None
                    }
                };
                if server.is_some() {
                    tracing::info!(model = %id, "local model idle, stopping its server");
                    shutdown(server).await;
                }
            }
        }
    }

    /// `POST /v1/embeddings` on the running server of `model_id` (llama-server `--embedding`).
    /// One vector per text, in order. Counts as use, so the idle stopper leaves it be.
    pub async fn embed(
        &self,
        model_id: &str,
        texts: &[String],
        cancel: &CancellationToken,
    ) -> Result<Vec<Vec<f32>>, LocalError> {
        let server = self
            .servers
            .lock()
            .unwrap()
            .get(model_id)
            .cloned()
            .ok_or_else(|| LocalError::Start("the model is not running".into()))?;
        let _in_use = InUse::new(&server.busy);
        *server.used.lock().unwrap() = Instant::now();
        let bad = |e: &dyn std::fmt::Display| LocalError::Start(e.to_string());
        let send = self
            .client
            .post(format!("http://127.0.0.1:{}/v1/embeddings", server.port))
            .bearer_auth(&server.key)
            .timeout(Duration::from_secs(120))
            .json(&serde_json::json!({"model": model_id, "input": texts}))
            .send();
        let resp = tokio::select! {
            r = send => r,
            () = cancel.cancelled() => return Err(LocalError::Cancelled),
        };
        let body: serde_json::Value = resp
            .map_err(|e| bad(&e.without_url()))?
            .error_for_status()
            .map_err(|e| bad(&e.without_url()))?
            .json()
            .await
            .map_err(|e| bad(&e.without_url()))?;
        *server.used.lock().unwrap() = Instant::now();
        let mut rows: Vec<(u64, Vec<f32>)> = Vec::new();
        for (at, row) in body["data"].as_array().into_iter().flatten().enumerate() {
            let vector: Option<Vec<f32>> = row["embedding"]
                .as_array()
                .and_then(|v| v.iter().map(|x| x.as_f64().map(|f| f as f32)).collect());
            let vector = vector.ok_or_else(|| bad(&"the model sent a malformed vector"))?;
            rows.push((row["index"].as_u64().unwrap_or(at as u64), vector));
        }
        rows.sort_by_key(|r| r.0);
        if rows.len() != texts.len() {
            return Err(bad(&"the model sent the wrong number of vectors"));
        }
        Ok(rows.into_iter().map(|r| r.1).collect())
    }

    /// Whether the llama.cpp runtime is on this computer (installed, or `ALEXIA_LLAMA_SERVER`).
    pub fn ready(&self) -> bool {
        self.installed().is_some()
    }

    /// The pinned llama.cpp release.
    pub fn version() -> &'static str {
        VERSION
    }

    /// Whether this computer has a llama.cpp build to download (64-bit Windows).
    pub fn supported() -> bool {
        cfg!(all(windows, target_arch = "x86_64"))
    }

    /// The models whose servers are running, by id.
    pub fn running(&self) -> Vec<String> {
        let servers = self.servers.lock().unwrap();
        let mut ids: Vec<String> = servers
            .iter()
            .filter(|(_, s)| !s.dead.load(Ordering::SeqCst) && !s.stop.is_cancelled())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// The port a model's server listens on (tests).
    #[doc(hidden)]
    pub fn port(&self, model_id: &str) -> Option<u16> {
        self.servers.lock().unwrap().get(model_id).map(|s| s.port)
    }
}

/// A Windows Job Object with KILL_ON_JOB_CLOSE (copied from alexia-mcp's `job.rs`, with the
/// few kernel32 calls declared here because alexia-core has no `windows-sys`): llama-server dies
/// with its job, and with the hub. Elsewhere a no-op.
#[allow(unsafe_code)]
mod job {
    #[cfg(windows)]
    use std::ffi::c_void;

    #[cfg(windows)]
    #[repr(C)]
    struct Basic {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[cfg(windows)]
    #[repr(C)]
    struct Extended {
        basic: Basic,
        io_counters: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[cfg(windows)]
    pub struct Job(*mut c_void);

    // SAFETY: a job handle is a kernel object handle, usable from any thread.
    #[cfg(windows)]
    unsafe impl Send for Job {}
    #[cfg(windows)]
    unsafe impl Sync for Job {}

    #[cfg(windows)]
    impl Job {
        pub fn new() -> std::io::Result<Job> {
            const EXTENDED_LIMIT_INFORMATION: i32 = 9;
            const KILL_ON_JOB_CLOSE: u32 = 0x2000;
            // SAFETY: null attributes and name are allowed; the handle is checked before use.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Job(handle);
            // SAFETY: all-zero is a valid "no limits" value for this plain C struct.
            let mut info: Extended = unsafe { std::mem::zeroed() };
            info.basic.limit_flags = KILL_ON_JOB_CLOSE;
            // SAFETY: `info` lives across the call and the size matches its type.
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    EXTENDED_LIMIT_INFORMATION,
                    std::ptr::from_ref(&info).cast(),
                    std::mem::size_of::<Extended>() as u32,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }

        pub fn assign(&self, child: &tokio::process::Child) -> std::io::Result<()> {
            let Some(process) = child.raw_handle() else {
                return Err(std::io::Error::other("the process already exited"));
            };
            // SAFETY: both handles are open; the child owns its handle.
            if unsafe { AssignProcessToJobObject(self.0, process.cast()) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn kill(&self) {
            // SAFETY: the handle is open until drop.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    #[cfg(windows)]
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is open and owned; closing it kills what is left.
            unsafe { CloseHandle(self.0) };
        }
    }

    #[cfg(not(windows))]
    pub struct Job;

    #[cfg(not(windows))]
    impl Job {
        pub fn new() -> std::io::Result<Job> {
            Ok(Job)
        }

        pub fn assign(&self, _child: &tokio::process::Child) -> std::io::Result<()> {
            Ok(())
        }

        pub fn kill(&self) {}
    }
}

async fn shutdown(server: Option<Arc<Server>>) {
    if let Some(s) = server {
        s.stop.cancel();
        let task = s.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

/// What llama-server may see of the hub's environment (as v2): no provider keys, no LLAMA_*
/// controls, no loader injection.
const CHILD_ENV: [&str; 8] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
];

fn io(e: std::io::Error) -> LocalError {
    LocalError::Install(e.to_string())
}

fn server_args(model: &LocalModel, gpu_layers: u32, port: u16, key: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "--model",
        &model.path.to_string_lossy(),
        "--alias",
        &model.id,
        "--ctx-size",
        &model.context.to_string(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--parallel",
        "1",
        "--jinja",
        "--api-key",
        key,
        "--no-webui",
        "--n-gpu-layers",
        &gpu_layers.to_string(),
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if let Some(m) = &model.mmproj {
        a.extend(["--mmproj".into(), m.to_string_lossy().into_owned()]);
    }
    if let Some(d) = &model.draft {
        // SP-17: the draft sits on the GPU as far as the same fit allows.
        a.extend([
            "--model-draft".into(),
            d.to_string_lossy().into_owned(),
            "-ngld".into(),
            gpu_layers.to_string(),
        ]);
    }
    if model.embedding {
        a.push("--embedding".into());
    }
    a
}

fn spawn(spec: &Spec) -> std::io::Result<(Child, job::Job)> {
    let mut cmd = Command::new(&spec.exe);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env_clear();
    for name in CHILD_ENV {
        if let Some(v) = std::env::var_os(name) {
            cmd.env(name, v);
        }
    }
    if let Some(dir) = spec.exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let job = job::Job::new()?;
    let mut child = cmd.spawn()?;
    if let Err(e) = job.assign(&child) {
        let _ = child.start_kill();
        return Err(e);
    }
    Ok((child, job))
}

/// Keeps the child alive: restarts it on the same port and key after a crash, with a doubling
/// delay, and gives up after `MAX_RESTARTS` quick deaths (`dead`, so `serve` starts a new one).
async fn supervise(spec: Spec, first: (Child, job::Job), server: Arc<Server>, backoff: Duration) {
    let mut next = Some(first);
    let mut fails = 0u32;
    loop {
        let (mut child, job) = match next.take() {
            Some(c) => c,
            None => match spawn(&spec) {
                Ok(c) => c,
                Err(_) => {
                    fails += 1;
                    if fails > MAX_RESTARTS || !pause(&server.stop, delay(backoff, fails)).await {
                        break;
                    }
                    continue;
                }
            },
        };
        server.pid.store(child.id().unwrap_or(0), Ordering::SeqCst);
        let started = Instant::now();
        tokio::select! {
            () = server.stop.cancelled() => {
                job.kill();
                let _ = child.kill().await;
                server.pid.store(0, Ordering::SeqCst);
                return;
            }
            _ = child.wait() => {}
        }
        job.kill();
        server.pid.store(0, Ordering::SeqCst);
        if started.elapsed() >= STABLE {
            fails = 0;
        }
        fails += 1;
        tracing::warn!(port = server.port, fails, "llama-server exited, restarting");
        if fails > MAX_RESTARTS || !pause(&server.stop, delay(backoff, fails)).await {
            break;
        }
    }
    if !server.stop.is_cancelled() {
        server.dead.store(true, Ordering::SeqCst);
    }
}

fn delay(base: Duration, fails: u32) -> Duration {
    (base * 2u32.saturating_pow(fails.saturating_sub(1))).min(Duration::from_secs(30))
}

/// Sleeps; false when stopped meanwhile.
async fn pause(stop: &CancellationToken, d: Duration) -> bool {
    tokio::select! {
        () = stop.cancelled() => false,
        () = tokio::time::sleep(d) => true,
    }
}

async fn wait_healthy(
    client: &reqwest::Client,
    child: &mut Child,
    port: u16,
    epoch: &AtomicU64,
    began: u64,
) -> Result<(), LocalError> {
    let url = format!("http://127.0.0.1:{port}/health");
    let start = Instant::now();
    loop {
        if epoch.load(Ordering::SeqCst) != began {
            return Err(LocalError::Start("everything was stopped meanwhile".into()));
        }
        if child.try_wait().map_err(io)?.is_some() {
            return Err(LocalError::Exited);
        }
        let ok = match client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r
                .json::<serde_json::Value>()
                .await
                .is_ok_and(|v| v["status"] == "ok"),
            _ => false,
        };
        if ok {
            return Ok(());
        }
        if start.elapsed() > HEALTH_DEADLINE {
            return Err(LocalError::NotReady);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn free_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(l.local_addr()?.port())
}

/// 128 bits: OS-seeded `RandomState` hashes of the clock and a counter, folded through SHA-256.
/// ponytail: no rand crate here; the key only guards a loopback port, swap for getrandom if a
/// dependency is ever added.
fn random_key() -> String {
    let mut h = Sha256::new();
    for i in 0..4u64 {
        let mut s = RandomState::new().build_hasher();
        s.write_u64(i);
        s.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        );
        h.update(s.finish().to_le_bytes());
    }
    h.finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn find_exe(dir: &Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(f) = find_exe(&p) {
                return Some(f);
            }
        } else if matches!(
            p.file_name().and_then(|n| n.to_str()),
            Some("llama-server.exe" | "llama-server")
        ) {
            return Some(p);
        }
    }
    None
}

/// Unzip into `dest`. An entry with `..`, a root or a drive in its path is refused, and so is an
/// archive that expands past `MAX_EXPANDED`.
fn unzip(zip_path: &Path, dest: &Path) -> Result<(), LocalError> {
    let bad = |e: &dyn std::fmt::Display| LocalError::Install(e.to_string());
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(zip_path).map_err(io)?).map_err(|e| bad(&e))?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| bad(&e))?;
        let name = entry.name().to_owned();
        let Some(rel) = entry.enclosed_name() else {
            return Err(LocalError::UnsafeArchive(name));
        };
        if name.contains('\\') || name.contains(':') || name.starts_with('/') {
            return Err(LocalError::UnsafeArchive(name));
        }
        total += entry.size();
        if total > MAX_EXPANDED {
            return Err(LocalError::Install("the download expands too large".into()));
        }
        let to = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&to).map_err(io)?;
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        let mut out = std::fs::File::create(&to).map_err(io)?;
        std::io::copy(&mut entry, &mut out).map_err(io)?;
    }
    Ok(())
}

/// Each variant is a sentence the owner can read.
#[derive(Debug, thiserror::Error)]
pub enum LocalError {
    #[error("Local models need Windows on a 64-bit PC for now, so this computer cannot run them.")]
    Unsupported,
    #[error(
        "The local engine (llama.cpp) is not installed yet. Install it from Local models first."
    )]
    NotInstalled,
    #[error("The local engine could not be downloaded: {0}")]
    Download(String),
    #[error(
        "The local engine download did not match its published checksum, so it was thrown away."
    )]
    BadDigest,
    #[error("The local engine download holds an unsafe file path ({0}), so it was refused.")]
    UnsafeArchive(String),
    #[error("The local engine could not be installed: {0}")]
    Install(String),
    #[error("The local engine install was stopped.")]
    Cancelled,
    #[error("The local model could not be started: {0}")]
    Start(String),
    #[error("The local model's server stopped while it was starting.")]
    Exited,
    #[error("The local model's server did not become ready in time.")]
    NotReady,
}

/// Context sizes the three jobs run with (capped by what the model supports).
const VISION_CTX: u32 = 8192;
const CHECK_CTX: u32 = 8192;
const EMBED_CTX: u32 = 2048;
const DRAFT_CTX: u32 = 2048;
const DESCRIBE: &str = "Describe this picture so someone who cannot see it understands it: what it shows, the layout, colours, people and objects. Then write \"Text in the picture:\" and copy every piece of text in it exactly as written (OCR). If there is no text, write \"Text in the picture: none\".";
const BLIND: &str = "[A picture was here, but Alexia cannot look at pictures right now.]";

fn is_embedding(arch: &str) -> bool {
    arch.contains("bert") || arch.contains("embedding")
}

fn job_key(job: Job) -> &'static str {
    match job {
        Job::Vision => "vision",
        Job::Check => "check",
        _ => "local",
    }
}

/// The three GPU jobs D213 allows besides chat: vision (MO-06), embeddings (MO-07, pinned under
/// `Job::Local`) and the checker's model (TR-02). Each starts its model on demand through the
/// `Runtime`, which stops it after 10 idle minutes; `set_paused` (a game is running) makes every
/// method give up at once.
pub struct LocalJobs {
    runtime: Arc<Runtime>,
    store: Arc<Store>,
    router: Arc<Router>,
    paused: AtomicBool,
    /// Image hash -> description, for this session.
    seen: Mutex<HashMap<String, String>>,
    /// Tests stand in for `nvidia-smi`.
    machine: Mutex<Option<gpu::Machine>>,
}

impl LocalJobs {
    pub fn new(runtime: Arc<Runtime>, store: Arc<Store>, router: Arc<Router>) -> Arc<LocalJobs> {
        Arc::new(LocalJobs {
            runtime,
            store,
            router,
            paused: AtomicBool::new(false),
            seen: Mutex::new(HashMap::new()),
            machine: Mutex::new(None),
        })
    }

    /// Tests: use this machine instead of asking `nvidia-smi`.
    #[doc(hidden)]
    pub fn set_machine(&self, machine: gpu::Machine) {
        *self.machine.lock().unwrap() = Some(machine);
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// No NVIDIA GPU counts as no VRAM: nothing `Fits`, a model that must run runs from RAM.
    async fn machine(&self) -> gpu::Machine {
        let set = self.machine.lock().unwrap().clone();
        if let Some(m) = set {
            return m;
        }
        gpu::machine().await.unwrap_or(gpu::Machine {
            vram_mb: 0,
            free_mb: 0,
            ram_mb: 0,
            gpu: None,
        })
    }

    /// Step 1: the owner's pin (`local:<id>` under the job's name) wins when it names an installed
    /// model that can do the job; else vision takes the largest that fits (the smallest if none
    /// does), embeddings the smallest that fits (else the smallest), the checker the smallest that
    /// fits (else none).
    async fn pick(&self, job: Job) -> Option<(LocalModel, u32)> {
        let machine = self.machine().await;
        let headroom = gpu::headroom_mb(&self.store);
        let want = match job {
            Job::Vision => VISION_CTX,
            Job::Check => CHECK_CTX,
            _ => EMBED_CTX,
        };
        let saved = notes(&self.store);
        let ctx_of = |i: &hf::Installed, want: u32| {
            saved_context(i, &saved).unwrap_or(match i.meta.context {
                0 => want,
                c => c.min(want),
            })
        };
        let fits = |i: &hf::Installed, m: &gpu::Machine, ctx: u32| {
            gpu::fit(
                m,
                i.meta.bytes,
                i.meta.layers,
                i.meta.kv_bytes_per_token,
                ctx,
                headroom,
            )
        };
        let mut all: Vec<hf::Installed> = hf::installed(&self.store)
            .into_iter()
            .filter(|i| !i.meta.vision_projector)
            .filter(|i| match job {
                Job::Vision => i.mmproj.is_some() && !is_embedding(&i.meta.arch),
                Job::Check => !is_embedding(&i.meta.arch),
                _ => is_embedding(&i.meta.arch),
            })
            .collect();
        all.sort_by_key(|i| i.meta.bytes);
        let pins = self.router.pins().remove(job_key(job)).unwrap_or_default();
        let pinned = pins.iter().find_map(|p| {
            let id = p.strip_prefix("local:")?;
            all.iter().find(|i| i.id == id)
        });
        let ok =
            |i: &hf::Installed| fits(i, &machine, ctx_of(i, want)).verdict == gpu::Verdict::Fits;
        let chosen = match (pinned, job) {
            (Some(p), _) => p,
            (None, Job::Vision) => all.iter().rev().find(|i| ok(i)).or(all.first())?,
            (None, Job::Check) => all.iter().find(|i| ok(i))?,
            (None, _) => all.iter().find(|i| ok(i)).or(all.first())?,
        };
        let ctx = ctx_of(chosen, want);
        let f = fits(chosen, &machine, ctx);
        // SP-17: the checker gets a smaller model of its own family as the draft when what is
        // left of the GPU holds it.
        let draft = if job == Job::Check {
            let left = gpu::Machine {
                free_mb: machine.free_mb.saturating_sub(f.vram_mb),
                ..machine.clone()
            };
            all.iter()
                .filter(|d| {
                    d.id != chosen.id
                        && d.meta.arch == chosen.meta.arch
                        && d.meta.bytes < chosen.meta.bytes
                })
                .find(|d| fits(d, &left, ctx_of(d, DRAFT_CTX)).verdict == gpu::Verdict::Fits)
                .map(|d| d.path.clone())
        } else {
            None
        };
        let model = LocalModel {
            id: chosen.id.clone(),
            path: chosen.path.clone(),
            mmproj: if job == Job::Vision {
                chosen.mmproj.clone()
            } else {
                None
            },
            draft,
            context: ctx,
            embedding: job == Job::Local,
        };
        Some((model, f.gpu_layers))
    }

    /// The provider and the model id to ask it for.
    async fn start(&self, job: Job) -> Option<(Arc<dyn Provider>, String)> {
        // D213: none of the local jobs is chat.
        if !matches!(job, Job::Vision | Job::Check | Job::Local) || self.is_paused() {
            return None;
        }
        let (model, layers) = self.pick(job).await?;
        let provider = match self.runtime.serve(&model, layers).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(
                    "a local {} job could not start its model: {e}",
                    job_key(job)
                );
                return None;
            }
        };
        if self.is_paused() {
            return None;
        }
        self.router.set_provider(provider.clone(), true);
        Some((provider, model.id))
    }

    /// Starts the model for the job if needed and registers it with the router (`set_provider`, local).
    /// `None` for `Chat`, `Plan`, `Step` and `Code` (D213), when paused, or when no model is installed.
    pub async fn provider(&self, job: Job) -> Option<Arc<dyn Provider>> {
        self.start(job).await.map(|s| s.0)
    }

    /// A description of the picture plus the text in it (OCR). The same picture is described once.
    pub async fn describe(
        &self,
        image_data_url: &str,
        cancel: CancellationToken,
    ) -> Option<String> {
        if self.is_paused() {
            return None;
        }
        let hash: String = Sha256::digest(image_data_url.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if let Some(d) = self.seen.lock().unwrap().get(&hash) {
            return Some(d.clone());
        }
        let (provider, id) = self.start(Job::Vision).await?;
        let body = MessageBody {
            content: Content::Parts(vec![
                Part::Text {
                    text: DESCRIBE.into(),
                },
                Part::Image {
                    url: image_data_url.into(),
                },
            ]),
            calls: None,
            call_id: None,
            provider: None,
            notes: None,
            bad: None,
            stopped: None,
            typed: None,
            extra: serde_json::Map::new(),
        };
        let req = ChatRequest {
            messages: vec![(Role::User, body)],
            system: None,
            tools: Vec::new(),
            max_tokens: Some(1024),
        };
        let (tx, mut rx) = mpsc::channel(64);
        let collect = async {
            let mut text = String::new();
            while let Some(chunk) = rx.recv().await {
                if let ChatChunk::Text(t) = chunk {
                    text.push_str(&t);
                }
            }
            text
        };
        let (done, text) = tokio::join!(provider.chat(&req, &id, tx, cancel), collect);
        if let Err(e) = done {
            tracing::warn!("the local vision model could not describe a picture: {e}");
            return None;
        }
        let text = text.trim().to_owned();
        if text.is_empty() || self.is_paused() {
            return None;
        }
        self.seen.lock().unwrap().insert(hash, text.clone());
        Some(text)
    }

    /// One vector per text, in order. `None` when paused, when no embedding model is installed or
    /// when it fails.
    pub async fn embed(
        &self,
        texts: &[String],
        cancel: CancellationToken,
    ) -> Option<Vec<Vec<f32>>> {
        if self.is_paused() {
            return None;
        }
        let (_, id) = self.start(Job::Local).await?;
        if texts.is_empty() {
            return Some(Vec::new());
        }
        match self.runtime.embed(&id, texts, &cancel).await {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!("the local embedding model failed: {e}");
                None
            }
        }
    }

    /// For `Checker::set_model`.
    pub async fn checker_model(&self) -> Option<(Arc<dyn Provider>, String)> {
        self.start(Job::Check).await
    }

    /// While true (a game is running) every method returns None at once.
    pub fn set_paused(&self, on: bool) {
        self.paused.store(on, Ordering::SeqCst);
    }

    /// Whether a model for `job` (`Vision` or `Local` for embeddings) is installed, running or not.
    pub(crate) fn can(&self, job: Job) -> bool {
        hf::installed(&self.store).iter().any(|i| {
            !i.meta.vision_projector
                && match job {
                    Job::Vision => i.mmproj.is_some() && !is_embedding(&i.meta.arch),
                    _ => is_embedding(&i.meta.arch),
                }
        })
    }
}

/// Images described locally before a request goes to the cloud (MO-06). `None` (no local jobs
/// wired) returns the messages unchanged. With `_core.vision` = `"cloud"` the pictures stay in.
/// Otherwise every picture becomes the local model's description and OCR text; with no local
/// model (or a game running) it becomes a plain sentence saying so, so no picture leaves the PC.
pub async fn see_before_cloud(
    jobs: Option<&LocalJobs>,
    messages: Vec<(Role, MessageBody)>,
) -> Vec<(Role, MessageBody)> {
    let Some(jobs) = jobs else {
        return messages;
    };
    let cloud = jobs
        .store
        .kv_get("_core", "vision")
        .ok()
        .flatten()
        .is_some_and(|v| v == "cloud");
    if cloud {
        return messages;
    }
    let mut out = Vec::with_capacity(messages.len());
    for (role, mut body) in messages {
        if let Content::Parts(parts) = &mut body.content {
            for part in parts.iter_mut() {
                let Part::Image { url } = part else { continue };
                let text = match jobs.describe(url, CancellationToken::new()).await {
                    Some(d) => format!("[Picture: {d}]"),
                    None => BLIND.to_owned(),
                };
                *part = Part::Text { text };
            }
        }
        out.push((role, body));
    }
    out
}

// ---- P2D-09: what the Local models screen asks (MO-02, MO-13, MO-14) ----

const GIB: u64 = 1024 * 1024 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// kv `_core`/`local_model_notes`: id → [`ModelNotes`].
const NOTES: &str = "local_model_notes";
/// v2 `smoke`: one short question, answered.
const SMOKE: &str =
    "Reply with this sentence: The local model is ready to answer on this computer. /no_think";
/// v2 `contextPreview`: the smallest context offered.
const LEAST_CONTEXT: u32 = 256;
/// A model whose header names no context length gets v2's `DEFAULT_CONTEXT`.
const DEFAULT_CONTEXT: u32 = 8192;

/// What v3 keeps about an installed model besides `hf::Installed`: where it came from, what the
/// owner chose for it and how fast it answered. Every field may be missing (a model recorded
/// before the screen existed has none).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelNotes {
    pub name: Option<String>,
    /// The vetted catalog entry it was installed from.
    pub entry: Option<String>,
    pub repo: Option<String>,
    pub revision: Option<String>,
    pub quant: Option<String>,
    pub licence: Option<String>,
    pub vetted: bool,
    pub abliterated: bool,
    pub tools: bool,
    /// Brought in from a file already on disk (M11).
    pub imported: bool,
    /// The owner's context size (M5); the job's default when absent.
    pub context: Option<u32>,
    pub tokens_per_second: Option<f64>,
    pub installed_at: Option<i64>,
    pub last_used_at: Option<i64>,
}

/// Every model's notes.
pub fn notes(store: &Store) -> BTreeMap<String, ModelNotes> {
    store
        .kv_get("_core", NOTES)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Change one model's notes (`None` drops them).
pub fn set_notes(
    store: &Store,
    id: &str,
    change: impl FnOnce(Option<ModelNotes>) -> Option<ModelNotes>,
) -> Result<(), ModelError> {
    let mut all = notes(store);
    if let Some(n) = change(all.remove(id)) {
        all.insert(id.to_owned(), n);
    }
    let value = serde_json::to_value(all).map_err(|e| ModelError::Store(e.to_string()))?;
    store
        .kv_set("_core", NOTES, &value)
        .map_err(|e| ModelError::Store(e.to_string()))
}

/// The owner's context for `i`, when one is saved and still inside what the model holds.
fn saved_context(i: &hf::Installed, all: &BTreeMap<String, ModelNotes>) -> Option<u32> {
    let c = all.get(&i.id)?.context?;
    (LEAST_CONTEXT..=context_max(i)).contains(&c).then_some(c)
}

/// The longest context the model's header allows (v2 `DEFAULT_CONTEXT` when it names none).
pub fn context_max(i: &hf::Installed) -> u32 {
    match i.meta.context {
        0 => DEFAULT_CONTEXT,
        c => c,
    }
}

/// What a model runs with when the owner chose nothing: its job's context, capped by the model.
fn default_context(i: &hf::Installed) -> u32 {
    let want = if is_embedding(&i.meta.arch) {
        EMBED_CTX
    } else {
        CHECK_CTX
    };
    context_max(i).min(want)
}

/// v2 `fit.ts` `needBytes`: weights, the f16 KV cache for `context` (256-token slots plus 10%)
/// and the runner's overhead (15% of the weights, at least 1 GiB). What `gpu::fit` judges.
pub fn need_bytes(model_bytes: u64, kv_bytes_per_token: u64, context: u32) -> u64 {
    let slots = u64::from(context).div_ceil(256) * 256;
    let kv = (slots as f64 * kv_bytes_per_token as f64 * 1.1).ceil() as u64;
    let overhead = GIB.max((model_bytes as f64 * 0.15).ceil() as u64);
    model_bytes + kv + overhead
}

/// v2's verdict words.
pub fn verdict_name(v: gpu::Verdict) -> &'static str {
    match v {
        gpu::Verdict::Fits => "fits",
        gpu::Verdict::Tight => "tight",
        gpu::Verdict::TooBig => "too-big",
    }
}

/// The card as a whole (its total memory, not what is free this second): what the screen
/// judges a model against.
pub fn whole_card(m: &gpu::Machine) -> gpu::Machine {
    gpu::Machine {
        free_mb: m.vram_mb,
        ..m.clone()
    }
}

/// v2 `contextPreview` (the GET context answer).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSettings {
    pub context: u32,
    pub context_max: u32,
    pub need_bytes: u64,
    pub verdict: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub drafts: Vec<Draft>,
    pub kv_options: Vec<String>,
}

/// A draft model the owner may choose. v3 picks the checker's draft itself (SP-17), so the
/// screen is offered none.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Draft {
    pub id: String,
    pub name: String,
}

/// v2 `smoke`'s answer: how fast a short local answer came, when enough tokens were timed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Benchmark {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_second: Option<f64>,
}

/// One line of v2 `maintenance`'s `cleanup`: a model not used for 30 days, or a file under the
/// models folder that no installed model owns (id `file:<path inside the folder>`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub name: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    pub reason: String,
}

/// What `remove` took away.
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    pub name: String,
    /// Bytes deleted from the disk; 0 for a model whose files were left where they lie.
    pub freed: u64,
    /// Its files were under the models folder (a download or a copy), so they were deleted.
    pub owned: bool,
}

/// Each variant is a sentence the owner can read.
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("That model is not installed or its files are missing.")]
    NotInstalled,
    #[error("{0}")]
    Invalid(String),
    #[error("This context exceeds the available memory budget.")]
    TooBig,
    #[error("A game is using the graphics card, so local models are paused until it closes.")]
    Paused,
    #[error("The measurement was cancelled.")]
    Cancelled,
    #[error("The model started but said nothing back.")]
    Silent,
    #[error(transparent)]
    Local(#[from] LocalError),
    #[error("The model could not answer: {0}")]
    Answer(String),
    #[error("Could not change the files: {0}")]
    Io(String),
    #[error("Could not record the change: {0}")]
    Store(String),
}

/// The pin a local model is chosen by.
pub fn pin_of(id: &str) -> String {
    format!("local:{id}")
}

/// The jobs D213 lets this model do (never chat): embeddings for an embedding model, the
/// checker for a text model, and vision too when its projector came with it.
pub fn jobs_for(i: &hf::Installed) -> Vec<Job> {
    if i.meta.vision_projector {
        Vec::new()
    } else if is_embedding(&i.meta.arch) {
        vec![Job::Local]
    } else if i.mmproj.is_some() {
        vec![Job::Vision, Job::Check]
    } else {
        vec![Job::Check]
    }
}

/// The router's name for a job (`router::job_name`, which is private there).
pub fn job_name(job: Job) -> &'static str {
    match job {
        Job::Chat => "chat",
        Job::Plan => "plan",
        Job::Step => "step",
        Job::Code => "code",
        Job::Vision => "vision",
        Job::Check => "check",
        Job::Local => "local",
    }
}

fn job_named(name: &str) -> Option<Job> {
    [
        Job::Chat,
        Job::Plan,
        Job::Step,
        Job::Code,
        Job::Vision,
        Job::Check,
        Job::Local,
    ]
    .into_iter()
    .find(|j| job_name(*j) == name)
}

impl LocalJobs {
    /// The machine the screen judges against: the test's, else `nvidia-smi`'s (none: no VRAM).
    pub async fn machine_now(&self) -> gpu::Machine {
        self.machine().await
    }

    /// The models folder downloads and copies live in.
    pub fn models_dir(&self) -> PathBuf {
        self.runtime.layout.cache().join("models")
    }

    /// The runtime the jobs start their models on.
    pub fn runtime(&self) -> &Arc<Runtime> {
        &self.runtime
    }

    /// Whether a game has paused the local jobs.
    pub fn paused(&self) -> bool {
        self.is_paused()
    }

    /// An installed model (not a projector) whose files are all there.
    pub fn installed_one(&self, id: &str) -> Result<hf::Installed, ModelError> {
        hf::installed(&self.store)
            .into_iter()
            .find(|i| i.id == id && !i.meta.vision_projector)
            .ok_or(ModelError::NotInstalled)
    }

    /// The context `i` runs with now: the owner's, else its job's default.
    pub fn context_of(&self, i: &hf::Installed) -> u32 {
        saved_context(i, &notes(&self.store)).unwrap_or_else(|| default_context(i))
    }

    /// M4: what `context` tokens would cost this model on this card (its current context when
    /// `None`). v3 runs the cache at f16 and chooses drafts itself, so those are the only offers.
    pub async fn context(
        &self,
        id: &str,
        context: Option<u32>,
    ) -> Result<ContextSettings, ModelError> {
        let i = self.installed_one(id)?;
        let max = context_max(&i);
        let context = context.unwrap_or_else(|| self.context_of(&i));
        if !(LEAST_CONTEXT..=max).contains(&context) {
            return Err(ModelError::Invalid(format!(
                "Choose a context from {LEAST_CONTEXT} to {max} tokens."
            )));
        }
        let m = whole_card(&self.machine().await);
        let f = gpu::fit(
            &m,
            i.meta.bytes,
            i.meta.layers,
            i.meta.kv_bytes_per_token,
            context,
            gpu::headroom_mb(&self.store),
        );
        let known = i.meta.kv_bytes_per_token > 0;
        Ok(ContextSettings {
            context,
            context_max: max,
            need_bytes: need_bytes(i.meta.bytes, i.meta.kv_bytes_per_token, context),
            // v2: an unknown cache layout can never be said to fit comfortably.
            verdict: match f.verdict {
                gpu::Verdict::Fits if !known => "tight",
                v => verdict_name(v),
            }
            .to_owned(),
            note: (!known).then(|| {
                "KV layout is unknown; memory is a cautious allowance. Check the runner before use."
                    .to_owned()
            }),
            drafts: Vec::new(),
            kv_options: vec!["f16".to_owned()],
        })
    }

    /// M5: keep `context` for `id`. A server running it is stopped, so its next start uses it.
    /// Refused when it does not fit the card at all.
    pub async fn set_context(
        &self,
        id: &str,
        context: u32,
    ) -> Result<ContextSettings, ModelError> {
        let preview = self.context(id, Some(context)).await?;
        if preview.verdict == "too-big" {
            return Err(ModelError::TooBig);
        }
        set_notes(&self.store, id, |n| {
            Some(ModelNotes {
                context: Some(context),
                ..n.unwrap_or_default()
            })
        })?;
        self.runtime.stop(id).await;
        Ok(preview)
    }

    /// M12: start the model and time a short answer on this computer. Never the cloud: the
    /// question goes to the model's own llama-server. Embedding models do not write answers.
    pub async fn benchmark(
        &self,
        id: &str,
        cancel: CancellationToken,
    ) -> Result<Benchmark, ModelError> {
        let i = self.installed_one(id)?;
        if is_embedding(&i.meta.arch) {
            return Err(ModelError::Invalid(
                "Embedding models do not write answers, so there is no speed to measure.".into(),
            ));
        }
        if self.is_paused() {
            return Err(ModelError::Paused);
        }
        let context = self.context_of(&i);
        let m = self.machine().await;
        let f = gpu::fit(
            &m,
            i.meta.bytes,
            i.meta.layers,
            i.meta.kv_bytes_per_token,
            context,
            gpu::headroom_mb(&self.store),
        );
        let model = LocalModel {
            id: i.id.clone(),
            path: i.path.clone(),
            mmproj: None,
            draft: None,
            context,
            embedding: false,
        };
        let provider = tokio::select! {
            p = self.runtime.serve(&model, f.gpu_layers) => p?,
            () = cancel.cancelled() => return Err(ModelError::Cancelled),
        };
        let body = MessageBody {
            content: Content::Text(SMOKE.into()),
            calls: None,
            call_id: None,
            provider: None,
            notes: None,
            bad: None,
            stopped: None,
            typed: None,
            extra: serde_json::Map::new(),
        };
        let req = ChatRequest {
            messages: vec![(Role::User, body)],
            system: None,
            tools: Vec::new(),
            max_tokens: Some(64),
        };
        let (tx, mut rx) = mpsc::channel(64);
        let collect = async {
            let (mut text, mut first) = (String::new(), None);
            while let Some(chunk) = rx.recv().await {
                if let ChatChunk::Text(t) = chunk {
                    first.get_or_insert_with(Instant::now);
                    text.push_str(&t);
                }
            }
            (text, first)
        };
        let (done, (text, first)) =
            tokio::join!(provider.chat(&req, &i.id, tx, cancel.clone()), collect);
        if cancel.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        let done = done.map_err(|e| ModelError::Answer(e.to_string()))?;
        if text.trim().is_empty() {
            return Err(ModelError::Silent);
        }
        let seconds = first.map_or(0.0, |t| t.elapsed().as_secs_f64());
        let tokens_per_second = (done.tokens_out > 0 && seconds >= 0.01)
            .then(|| (done.tokens_out as f64 / seconds * 10.0).round() / 10.0);
        set_notes(&self.store, id, |n| {
            let n = n.unwrap_or_default();
            Some(ModelNotes {
                tokens_per_second: tokens_per_second.or(n.tokens_per_second),
                last_used_at: Some(now_ms()),
                ..n
            })
        })?;
        Ok(Benchmark { tokens_per_second })
    }

    /// Model ids some job is pinned to.
    pub fn pinned_ids(&self) -> HashSet<String> {
        self.router
            .pins()
            .into_values()
            .flatten()
            .filter_map(|p| p.strip_prefix("local:").map(str::to_owned))
            .collect()
    }

    /// Pin `i` to every job D213 lets it do (never chat). The jobs, in order.
    pub fn pin(&self, i: &hf::Installed) -> Result<Vec<Job>, ModelError> {
        let jobs = jobs_for(i);
        for job in &jobs {
            self.router
                .set_pins(*job, vec![pin_of(&i.id)])
                .map_err(|e| ModelError::Store(e.to_string()))?;
        }
        Ok(jobs)
    }

    /// Start `i` for its first job now (a pinned model is warmed, as v2's mode switch loaded it).
    pub async fn warm(&self, i: &hf::Installed) -> Result<(), ModelError> {
        let job = *jobs_for(i)
            .first()
            .ok_or_else(|| ModelError::Invalid("A projector is not a model.".into()))?;
        if self.is_paused() {
            return Err(ModelError::Paused);
        }
        match self.start(job).await {
            Some((_, id)) if id == i.id => Ok(()),
            Some(_) => Err(ModelError::Invalid(
                "Another model was chosen for that job meanwhile.".into(),
            )),
            None => Err(ModelError::Answer(
                "the local engine could not start it".into(),
            )),
        }
    }

    /// M6's `cleanup`: models under the models folder nobody used for 30 days (never a pinned
    /// one), then files there that no installed model owns. Data only: nothing is deleted.
    pub fn maintenance(&self) -> Vec<Suggestion> {
        let root = self.models_dir();
        let all = hf::installed(&self.store);
        let notes = notes(&self.store);
        let pinned = self.pinned_ids();
        let now = now_ms();
        let mut out: Vec<Suggestion> = all
            .iter()
            .filter(|i| !pinned.contains(&i.id) && i.path.starts_with(&root))
            .filter_map(|i| {
                let n = notes.get(&i.id)?;
                let since = n.last_used_at.or(n.installed_at)?;
                (now - since >= 30 * DAY_MS).then(|| Suggestion {
                    id: i.id.clone(),
                    name: n.name.clone().unwrap_or_else(|| i.id.clone()),
                    bytes: files_of(i).iter().map(|f| file_len(f)).sum(),
                    last_used_at: n.last_used_at,
                    reason: "Not used in the last 30 days.".into(),
                })
            })
            .collect();
        out.extend(self.orphans(&all));
        out
    }

    /// Files under the models folder that are no installed model's part or projector.
    fn orphans(&self, all: &[hf::Installed]) -> Vec<Suggestion> {
        let root = self.models_dir();
        let owned: HashSet<PathBuf> = all.iter().flat_map(files_of).collect();
        let mut found = Vec::new();
        walk(&root, 0, &mut found);
        found.sort();
        found
            .into_iter()
            .filter(|f| !owned.contains(f))
            .filter_map(|f| {
                let rel: Vec<String> = f
                    .strip_prefix(&root)
                    .ok()?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                let name = rel.last()?.clone();
                let reason = if name.ends_with(".part") {
                    "An unfinished download that nothing is installing. Installing the same model again carries on from it."
                } else {
                    "Not part of any installed model."
                };
                Some(Suggestion {
                    id: format!("file:{}", rel.join("/")),
                    bytes: file_len(&f),
                    name,
                    last_used_at: None,
                    reason: reason.into(),
                })
            })
            .collect()
    }

    /// M14/M15: a model (its files when they are under the models folder and no other model
    /// shares them, its record, its pins, its notes), or a `file:` line of `maintenance`.
    pub async fn remove(&self, id: &str) -> Result<Removed, ModelError> {
        let root = self.models_dir();
        let all = hf::installed(&self.store);
        if let Some(rel) = id.strip_prefix("file:") {
            let orphan = self
                .orphans(&all)
                .into_iter()
                .find(|o| o.id == id)
                .ok_or(ModelError::NotInstalled)?;
            let path = rel.split('/').fold(root, |p, s| p.join(s));
            std::fs::remove_file(&path).map_err(|e| ModelError::Io(e.to_string()))?;
            return Ok(Removed {
                name: orphan.name,
                freed: orphan.bytes,
                owned: true,
            });
        }
        let one = all.iter().find(|i| i.id == id).cloned();
        let note = notes(&self.store).remove(id);
        self.runtime.stop(id).await;
        let mut freed = 0;
        let owned = one.as_ref().is_some_and(|i| i.path.starts_with(&root));
        if let Some(i) = &one {
            let shared: HashSet<PathBuf> = all
                .iter()
                .filter(|o| o.id != id)
                .flat_map(files_of)
                .collect();
            for f in files_of(i) {
                if !f.starts_with(&root) || shared.contains(&f) {
                    continue;
                }
                let len = file_len(&f);
                match std::fs::remove_file(&f) {
                    Ok(()) => freed += len,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(ModelError::Io(e.to_string())),
                }
                let _ = std::fs::remove_file(format!("{}.part", f.display()));
            }
        }
        let forgot = hf::forget(&self.store, id).map_err(|e| ModelError::Store(e.to_string()))?;
        if one.is_none() && !forgot {
            return Err(ModelError::NotInstalled);
        }
        let pin = pin_of(id);
        for (job, pins) in self.router.pins() {
            if !pins.contains(&pin) {
                continue;
            }
            if let Some(job) = job_named(&job) {
                let rest: Vec<String> = pins.into_iter().filter(|p| *p != pin).collect();
                self.router
                    .set_pins(job, rest)
                    .map_err(|e| ModelError::Store(e.to_string()))?;
            }
        }
        set_notes(&self.store, id, |_| None)?;
        Ok(Removed {
            name: note.and_then(|n| n.name).unwrap_or_else(|| id.to_owned()),
            freed,
            owned,
        })
    }
}

/// A model's files: every split part and its projector.
fn files_of(i: &hf::Installed) -> Vec<PathBuf> {
    let mut f = i.meta.parts.clone();
    if !f.contains(&i.path) {
        f.push(i.path.clone());
    }
    f.extend(i.mmproj.clone());
    f
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map_or(0, |m| m.len())
}

/// Every regular file under `dir`, a few levels deep (`models/<owner>/<repo>/<quant>/<file>`).
/// An import's staging folder (`.import-*`) is work in progress and left out.
fn walk(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        let p = e.path();
        if kind.is_dir() {
            let staging = e.file_name().to_string_lossy().starts_with(".import-");
            if depth < 6 && !staging {
                walk(&p, depth + 1, out);
            }
        } else if kind.is_file() {
            out.push(p);
        }
    }
}

/// The Local stats page's machine facts (v2 `system.ts`), read when asked. Windows asks the
/// kernel; elsewhere `/proc`, and what cannot be read is 0.
pub mod system {
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::Duration;

    use tokio::process::Command;

    /// (total, in use) physical memory, bytes.
    pub fn memory() -> (u64, u64) {
        imp::memory()
    }

    /// Percent of CPU time spent busy since the previous call (0 on the first).
    pub fn cpu_percent() -> f64 {
        static LAST: Mutex<Option<(u64, u64)>> = Mutex::new(None);
        let Some((busy, total)) = imp::cpu_times() else {
            return 0.0;
        };
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let pct = match *last {
            Some((b0, t0)) if total > t0 => {
                (busy.saturating_sub(b0) as f64 / (total - t0) as f64 * 100.0).clamp(0.0, 100.0)
            }
            _ => 0.0,
        };
        *last = Some((busy, total));
        (pct * 10.0).round() / 10.0
    }

    /// Seconds since the computer started.
    pub fn uptime() -> u64 {
        imp::uptime()
    }

    /// Free bytes on the volume holding `path`; `None` when it cannot be read.
    pub fn free_disk(path: &Path) -> Option<u64> {
        imp::free_disk(path)
    }

    pub fn cores() -> u64 {
        std::thread::available_parallelism().map_or(1, |n| n.get() as u64)
    }

    /// The processor's name, asked once.
    pub async fn cpu_model() -> String {
        static NAME: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
        NAME.get_or_init(|| async {
            run(
                "reg",
                &[
                    "query",
                    r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                    "/v",
                    "ProcessorNameString",
                ],
            )
            .await
            .lines()
            .find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().to_owned()))
            .filter(|n| !n.is_empty())
            .or_else(|| std::env::var("PROCESSOR_IDENTIFIER").ok())
            .unwrap_or_else(|| std::env::consts::ARCH.to_owned())
        })
        .await
        .clone()
    }

    /// The NVIDIA card's busy percent (`nvidia-smi`); 0 without one.
    pub async fn gpu_percent() -> f64 {
        run(
            "nvidia-smi",
            &[
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
        )
        .await
        .lines()
        .find_map(|l| l.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
    }

    async fn run(exe: &str, args: &[&str]) -> String {
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
            Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).into(),
            _ => String::new(),
        }
    }

    #[cfg(windows)]
    #[allow(unsafe_code)]
    mod imp {
        use std::os::windows::ffi::OsStrExt;
        use std::path::Path;

        #[repr(C)]
        #[derive(Default)]
        struct MemoryStatusEx {
            length: u32,
            memory_load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_page_file: u64,
            avail_page_file: u64,
            total_virtual: u64,
            avail_virtual: u64,
            avail_extended_virtual: u64,
        }

        #[repr(C)]
        #[derive(Default)]
        struct FileTime {
            low: u32,
            high: u32,
        }

        impl FileTime {
            fn ticks(&self) -> u64 {
                (u64::from(self.high) << 32) | u64::from(self.low)
            }
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
            fn GetSystemTimes(
                idle: *mut FileTime,
                kernel: *mut FileTime,
                user: *mut FileTime,
            ) -> i32;
            fn GetTickCount64() -> u64;
            fn GetDiskFreeSpaceExW(
                dir: *const u16,
                free_to_caller: *mut u64,
                total: *mut u64,
                total_free: *mut u64,
            ) -> i32;
        }

        pub fn memory() -> (u64, u64) {
            let mut m = MemoryStatusEx {
                length: std::mem::size_of::<MemoryStatusEx>() as u32,
                ..MemoryStatusEx::default()
            };
            // SAFETY: `m` is a MEMORYSTATUSEX with its length set, as the call requires.
            if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 {
                return (0, 0);
            }
            (m.total_phys, m.total_phys.saturating_sub(m.avail_phys))
        }

        /// (busy, total) in 100 ns ticks; kernel time includes idle time.
        pub fn cpu_times() -> Option<(u64, u64)> {
            let (mut idle, mut kernel, mut user) =
                (FileTime::default(), FileTime::default(), FileTime::default());
            // SAFETY: three valid FILETIME out-pointers.
            if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
                return None;
            }
            let total = kernel.ticks() + user.ticks();
            Some((total.saturating_sub(idle.ticks()), total))
        }

        pub fn uptime() -> u64 {
            // SAFETY: no arguments, no pointers.
            unsafe { GetTickCount64() } / 1000
        }

        pub fn free_disk(path: &Path) -> Option<u64> {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
            let (mut free, mut total, mut all_free) = (0u64, 0u64, 0u64);
            // SAFETY: a NUL-terminated wide string and three valid u64 out-pointers.
            let ok = unsafe {
                GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut all_free)
            };
            (ok != 0).then_some(free)
        }
    }

    #[cfg(not(windows))]
    mod imp {
        use std::path::Path;

        pub fn memory() -> (u64, u64) {
            let info = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
            let kb = |key: &str| {
                info.lines()
                    .find_map(|l| l.strip_prefix(key))
                    .and_then(|r| r.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
                    .unwrap_or(0)
                    * 1024
            };
            let total = kb("MemTotal:");
            (total, total.saturating_sub(kb("MemAvailable:")))
        }

        pub fn cpu_times() -> Option<(u64, u64)> {
            let stat = std::fs::read_to_string("/proc/stat").ok()?;
            let n: Vec<u64> = stat
                .lines()
                .next()?
                .split_whitespace()
                .skip(1)
                .filter_map(|x| x.parse().ok())
                .collect();
            let total: u64 = n.iter().sum();
            let idle = n.get(3).copied().unwrap_or(0) + n.get(4).copied().unwrap_or(0);
            Some((total.saturating_sub(idle), total))
        }

        pub fn uptime() -> u64 {
            std::fs::read_to_string("/proc/uptime")
                .ok()
                .and_then(|s| s.split('.').next().and_then(|x| x.parse().ok()))
                .unwrap_or(0)
        }

        pub fn free_disk(_path: &Path) -> Option<u64> {
            None
        }
    }
}
