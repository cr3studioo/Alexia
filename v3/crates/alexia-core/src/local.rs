// SPDX-License-Identifier: AGPL-3.0-only
//! The managed llama.cpp runtime (MO-01, SP-17) and the local jobs D213 allows on the GPU
//! (MO-06, MO-07, the checker). P2-31 fills the runtime, P2-34 the jobs.
//!
//! Ported from v2's `packages/core/src/llama.ts`: the pinned release and its digests, the
//! `llama-server` arguments, `GET /health`, a free loopback port and a random API key per start.
//! Never resolves "latest". llama-server listening on loopback is the child's port, not the hub's.
#![allow(unused_variables)] // P2-34's `LocalJobs` stubs

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_store::{Layout, MessageBody, Role, Store};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::free::{Auth, FreeRow};
use crate::openai::OpenAiCompat;
use crate::router::Router;
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
        if !cfg!(all(windows, target_arch = "x86_64")) {
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
            inner: OpenAiCompat::new(row, Some(key), self.client.clone()),
            used: used.clone(),
            busy: busy.clone(),
        });
        let server = Arc::new(Server {
            port,
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

pub struct LocalJobs {
    _todo: (),
}

impl LocalJobs {
    pub fn new(runtime: Arc<Runtime>, store: Arc<Store>, router: Arc<Router>) -> Arc<LocalJobs> {
        todo!("P2-34")
    }

    /// Starts the model for the job if needed and registers it with the router (`set_provider`, local).
    pub async fn provider(&self, job: Job) -> Option<Arc<dyn Provider>> {
        todo!("P2-34")
    }

    pub async fn describe(
        &self,
        image_data_url: &str,
        cancel: CancellationToken,
    ) -> Option<String> {
        todo!("P2-34")
    }

    pub async fn embed(
        &self,
        texts: &[String],
        cancel: CancellationToken,
    ) -> Option<Vec<Vec<f32>>> {
        todo!("P2-34")
    }

    /// For `Checker::set_model`.
    pub async fn checker_model(&self) -> Option<(Arc<dyn Provider>, String)> {
        todo!("P2-34")
    }

    /// While true (a game is running) every method returns None at once.
    pub fn set_paused(&self, on: bool) {
        todo!("P2-34")
    }
}

/// Images described locally before a request goes to the cloud (MO-06). `None` (no local jobs
/// wired) returns the messages unchanged. P2-34 fills the `Some` case; until then the messages
/// are returned unchanged either way, so the agent can call this from the start.
pub async fn see_before_cloud(
    jobs: Option<&LocalJobs>,
    messages: Vec<(Role, MessageBody)>,
) -> Vec<(Role, MessageBody)> {
    let _ = jobs;
    messages
}
