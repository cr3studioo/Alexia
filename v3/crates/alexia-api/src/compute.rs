// SPDX-License-Identifier: AGPL-3.0-only
//! The compute screen, on a hub with no paired computers (INVENTORY R1–R23, D-P2D-7).
//!
//! v2's `compute/api.ts` for the interaction computer, with nothing paired and no mesh: every
//! route that needs another computer answers v2's own refusal (`Choose a paired computer.`,
//! `That computer is not paired.`), and pairing answers that it comes with the mesh. Naming
//! `host=this` explicitly reaches this PC: its inventory from the `gpu` facts and the installed
//! models, and its one job, installing the llama.cpp engine through `Runtime`, in a queue this
//! module keeps (`LocalJobs` has none) that pauses with `LocalJobs::set_paused`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use alexia_core::{gpu, hf};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::{any, get, post, MethodRouter};
use axum::{Extension, Router};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::gate::Sent;
use crate::json;
use crate::Api;

/// v2 `THIS_HOST`: the computer the request reached.
const THIS: &str = "this";
/// kv `_core`: which computer's models the picker shows (v2 `SHOWN_KEY`).
const SHOWN_KEY: &str = "compute_shown_host";
/// kv `_core`: `{ relay?, mailbox? }` (v2 `SERVICES_KEY`).
const SERVICES_KEY: &str = "compute_services";
/// kv `_core`: the last Tailscale action asked for. Stored only: the hub does not run it.
const TAILSCALE_KEY: &str = "compute_tailscale";

const MESH: &str = "Pairing another computer comes with the mesh in a later version.";
const CHOOSE: &str = "Choose a paired computer.";
const UNPAIRED: &str = "That computer is not paired.";
const ON_COMPUTE: &str = "That is done on the computer that does the computing.";
const UNKNOWN_JOB: &str = "That compute job is not known.";
const NOT_AVAILABLE: &str = "That compute endpoint or method is not available.";

/// The one requirement this PC can install: the llama.cpp engine (P2-31's pinned build).
const ENGINE: &str = "llama-cpp";
const ENGINE_TITLE: &str = "The local engine (llama.cpp)";
/// How many jobs are kept to be asked about after they end (v2 `LOG_MAX`).
const LOG_MAX: usize = 50;
/// How long `tailscale status --json` may take (v2: 8 s).
const TAILSCALE_WAIT: Duration = Duration::from_secs(8);

/// What this screen keeps between requests: this PC's jobs and whether they are paused.
#[derive(Default)]
pub(crate) struct ComputeState {
    jobs: Mutex<Jobs>,
    /// The hardware, read once (v2: the inventory probes only on setup).
    machine: tokio::sync::OnceCell<Value>,
    /// The inventory's revision and what it was built from.
    built: Mutex<(u64, Value)>,
}

#[derive(Default)]
struct Jobs {
    /// Oldest first; at most `LOG_MAX` finished ones are kept.
    all: Vec<Job>,
    paused: bool,
}

struct Job {
    snap: Map<String, Value>,
    cancel: CancellationToken,
}

impl Job {
    fn state(&self) -> &str {
        self.snap.get("state").and_then(Value::as_str).unwrap_or("")
    }
    fn id(&self) -> &str {
        self.snap.get("id").and_then(Value::as_str).unwrap_or("")
    }
}

fn finished(state: &str) -> bool {
    matches!(state, "succeeded" | "failed" | "cancelled" | "interrupted")
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// A job id nobody else has: the clock, a counter and the process id.
fn job_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("job-{:x}-{:x}-{n}", now_ms(), std::process::id())
}

/// v2's refusal: `{ok:false, said, code}`.
fn refuse(status: u16, code: &str, said: &str) -> Response {
    json::with(status, json!({ "ok": false, "said": said, "code": code }))
}

/// Every route under `/api/compute/` that is not one of the screen's, and every method a route
/// does not take.
async fn unknown() -> Response {
    json::said(404, NOT_AVAILABLE)
}

/// A route whose other methods answer [`unknown`] rather than the window's empty 404.
fn route(m: MethodRouter<Arc<Api>>) -> MethodRouter<Arc<Api>> {
    m.fallback(unknown)
}

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/compute/role", route(get(role_get).post(role_post)))
        .route("/api/compute/role/cancel", route(post(role_cancel)))
        .route("/api/compute/hosts", route(get(hosts)))
        .route(
            "/api/compute/tailscale",
            route(get(tailscale_get).post(tailscale_post)),
        )
        .route("/api/compute/discover", route(get(discover)))
        .route("/api/compute/pair/start", route(post(pair_start)))
        .route("/api/compute/pair", route(get(pair_get)))
        .route("/api/compute/pair/cancel", route(post(pair_cancel)))
        .route("/api/compute/unpair", route(post(unpair)))
        .route("/api/compute/inventory", route(get(inventory)))
        .route("/api/compute/status", route(get(status)))
        .route("/api/compute/select", route(post(select)))
        .route("/api/compute/setup/install", route(post(install)))
        .route("/api/compute/queue", route(get(queue)))
        .route("/api/compute/job", route(get(job)))
        .route("/api/compute/jobs", route(get(jobs)))
        .route("/api/compute/jobs/cancel", route(post(cancel)))
        .route("/api/compute/pause", route(post(pause)))
        .route(
            "/api/compute/services",
            route(get(services_get).post(services_post)),
        )
        .route("/api/compute/window/close", route(post(window_close)))
        .route("/api/compute/{*rest}", any(unknown))
}

/// `/api/state`'s `compute` (v2 `compute.api.state()`): this computer is the one you talk to,
/// with nothing paired and no connection service to pair through (D-P2D-7).
pub(crate) fn state(_api: &Api) -> Value {
    json!({ "role": "interaction", "available": false, "hosts": [] })
}

// ---- which computer ----

/// v2 `asked()`: the host a GET names in its query, a POST in its body. `""` is none.
fn asked(v: Option<&Value>) -> Result<Option<String>, Box<Response>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(Box::new(refuse(400, "refused", "Supply a valid host."))),
    }
}

fn asked_query(q: &HashMap<String, String>) -> Result<Option<String>, Box<Response>> {
    asked(q.get("host").map(|h| Value::String(h.clone())).as_ref())
}

/// v2 `paired()`, with nothing paired: no host is v2's 400, any other name its 404. `this`,
/// named outright, is this PC.
fn this_pc(host: Option<String>) -> Result<(), Box<Response>> {
    match host.as_deref() {
        None => Err(Box::new(refuse(400, "refused", CHOOSE))),
        Some(THIS) => Ok(()),
        Some(_) => Err(Box::new(refuse(404, "unpaired", UNPAIRED))),
    }
}

// ---- role ----

/// v2 GET role: no switch is ever under way, and nothing is waited on.
async fn role_get() -> Response {
    json::ok(json!({ "role": "interaction", "active": 0 }))
}

async fn role_post(Extension(Sent(sent)): Extension<Sent>) -> Response {
    match sent.get("role").and_then(Value::as_str) {
        Some("interaction") => json::ok(json!({
            "ok": true,
            "note": "This computer is already in that role."
        })),
        Some("compute") => refuse(409, "refused", MESH),
        _ => refuse(400, "refused", "Choose Interaction or Compute."),
    }
}

/// v2 `RoleSwitching.stop()` with nothing waiting.
async fn role_cancel() -> Response {
    json::with(
        409,
        json!({ "ok": false, "note": "No role switch is waiting." }),
    )
}

// ---- hosts, pairing ----

async fn hosts() -> Response {
    json::ok(json!({ "hosts": [], "selected": THIS, "available": false }))
}

async fn discover() -> Response {
    json::ok(json!({ "found": [] }))
}

/// v2 `pair()` on the interaction computer: the code is asked for first; with one there is
/// nothing to pair through yet.
async fn pair_start(Extension(Sent(sent)): Extension<Sent>) -> Response {
    let code = sent
        .get("code")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if code.is_empty() || code.chars().count() > 200 {
        return refuse(
            400,
            "refused",
            "Type the code the other computer is showing.",
        );
    }
    refuse(409, "refused", MESH)
}

/// No pairing is ever open.
async fn pair_get() -> Response {
    json::ok(json!({}))
}

async fn pair_cancel() -> Response {
    json::ok(json!({ "ok": true }))
}

/// Nothing is paired, so whatever is named is not.
async fn unpair() -> Response {
    refuse(404, "unpaired", UNPAIRED)
}

async fn select(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    match sent.get("host") {
        Some(Value::String(h)) if h == THIS => {}
        Some(Value::String(_)) => return refuse(404, "unpaired", UNPAIRED),
        _ => return refuse(400, "refused", CHOOSE),
    }
    if let Err(e) = api.parts.store.kv_set("_core", SHOWN_KEY, &json!(THIS)) {
        return refuse(500, "refused", &e.to_string());
    }
    json::ok(json!({ "ok": true }))
}

// ---- what this PC is and has ----

/// v2 `HostMachine` from `gpu::machine()` (nvidia-smi). What it cannot read is 0.
async fn machine() -> Value {
    let m = gpu::machine().await;
    const MIB: u64 = 1024 * 1024;
    let ram = m.as_ref().map_or(0, |m| u64::from(m.ram_mb) * MIB);
    let gpus: Vec<Value> = m
        .iter()
        .filter_map(|m| {
            m.gpu.as_ref().map(|name| {
                json!({
                    "name": name,
                    "vramBytes": u64::from(m.vram_mb) * MIB,
                    "freeVramBytes": u64::from(m.free_mb) * MIB,
                })
            })
        })
        .collect();
    let budget = m.as_ref().map_or(ram, |m| {
        if m.vram_mb > 0 {
            u64::from(m.vram_mb) * MIB
        } else {
            ram
        }
    });
    let chip = std::env::var("PROCESSOR_IDENTIFIER")
        .ok()
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| std::env::consts::ARCH.to_owned());
    let mut out = json!({
        "platform": platform(),
        "arch": arch(),
        "chip": chip.trim(),
        "appleSilicon": cfg!(all(target_os = "macos", target_arch = "aarch64")),
        "ramBytes": ram,
        "freeDiskBytes": 0,
        "diskKnown": false,
        "budgetBytes": budget,
        "cpuCores": std::thread::available_parallelism().map_or(1, |n| n.get()),
    });
    if !gpus.is_empty() {
        out["gpus"] = Value::Array(gpus);
    } else if m.is_none() {
        out["gpuProbeError"] = json!("No NVIDIA graphics card answered.");
    }
    out
}

/// Node's `process.platform` names, as v2 reported them.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// Node's `process.arch` names.
fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// Whether the llama.cpp engine is in place: `ALEXIA_LLAMA_SERVER`, or an install receipt
/// (`.ready` naming an existing file) under `cache/llama/<build>/`, as `Runtime` leaves it.
fn engine_installed(api: &Api) -> bool {
    if std::env::var_os("ALEXIA_LLAMA_SERVER").is_some() {
        return true;
    }
    let root = api.parts.layout.cache().join("llama");
    let Ok(dirs) = std::fs::read_dir(&root) else {
        return false;
    };
    dirs.flatten().any(|d| {
        let dir: PathBuf = d.path();
        let is_part = dir.extension().is_some_and(|e| e == "part");
        !is_part
            && std::fs::read_to_string(dir.join(".ready"))
                .is_ok_and(|rel| dir.join(rel.trim()).is_file())
    })
}

fn is_embedding(arch: &str) -> bool {
    arch.contains("bert") || arch.contains("embedding")
}

/// v2 `HostModel`s: the installed models (not the vision projectors), and whether each is
/// running now.
fn models(api: &Api) -> Vec<Value> {
    hf::installed(&api.parts.store)
        .into_iter()
        .filter(|i| !i.meta.vision_projector)
        .map(|i| {
            let embedding = is_embedding(&i.meta.arch);
            let mut modality = vec!["text"];
            if i.mmproj.is_some() {
                modality.push("image");
            }
            let name = i.id.rsplit('/').next().unwrap_or(&i.id).to_owned();
            json!({
                "id": i.id,
                "name": name,
                "engine": "llama.cpp",
                "context": i.meta.context,
                "supportsTools": !embedding,
                "modality": if embedding { vec!["embedding"] } else { modality },
                "diskBytes": i.meta.bytes,
                "loaded": api.parts.runtime.port(&i.id).is_some(),
            })
        })
        .collect()
}

/// v2 `HostInventory` for this PC.
async fn this_inventory(api: &Api) -> Value {
    let machine = api.compute.machine.get_or_init(machine).await.clone();
    let installed = engine_installed(api);
    let models = models(api);
    let setup: Vec<Value> = if installed {
        vec![]
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        vec![json!({
            "id": ENGINE, "kind": "runtime", "title": ENGINE_TITLE,
            "detail": "Runs models on this computer.",
            "action": "install", "blocks": ["text"],
        })]
    } else {
        vec![json!({
            "id": ENGINE, "kind": "runtime", "title": ENGINE_TITLE,
            "action": "instructions",
            "instructions": alexia_core::local::LocalError::Unsupported.to_string(),
            "blocks": ["text"],
        })]
    };
    let capabilities = vec![json!({
        "cap": "text",
        "summary": "Chat and text work with a model on this computer.",
        "weight": "heavy",
        "ready": installed && !models.is_empty(),
    })];
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "This computer".to_owned());
    let content = json!({
        "name": name,
        "appVersion": api.parts.app_version,
        "machine": machine,
        "models": models,
        "capabilities": capabilities,
        "setup": setup,
    });
    // v2: the revision moves only when what is said changes.
    let revision = {
        let mut built = lock(&api.compute.built);
        if built.0 == 0 || built.1 != content {
            built.0 += 1;
            built.1 = content.clone();
        }
        built.0
    };
    let mut out = content;
    out["revision"] = json!(revision);
    out
}

async fn inventory(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = asked_query(&q).and_then(this_pc) {
        return *r;
    }
    json::ok(json!({ "inventory": this_inventory(&api).await, "connection": "direct" }))
}

/// v2 falls back to the selected host, which with nothing paired is this one: its 400. Only
/// `host=this` named outright is this PC, which the request reached directly.
async fn status(Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = asked_query(&q).and_then(this_pc) {
        return *r;
    }
    json::ok(json!({ "connection": "direct", "label": "Direct" }))
}

// ---- this PC's jobs ----

/// v2 `QueueSnapshot`.
fn queue_of(jobs: &Jobs) -> Value {
    let running = jobs
        .all
        .iter()
        .find(|j| matches!(j.state(), "preparing" | "running" | "cancelling"));
    let waiting: Vec<&Map<String, Value>> = jobs
        .all
        .iter()
        .filter(|j| j.state() == "queued")
        .map(|j| &j.snap)
        .collect();
    let mut q = json!({ "waiting": waiting, "paused": jobs.paused });
    if let Some(r) = running {
        q["running"] = Value::Object(r.snap.clone());
    }
    q
}

/// Drops the oldest finished jobs past `LOG_MAX`.
fn prune(jobs: &mut Jobs) {
    while jobs.all.len() > LOG_MAX {
        match jobs.all.iter().position(|j| finished(j.state())) {
            Some(at) => {
                jobs.all.remove(at);
            }
            None => break,
        }
    }
}

fn set(api: &Api, id: &str, f: impl FnOnce(&mut Map<String, Value>)) {
    let mut jobs = lock(&api.compute.jobs);
    if let Some(j) = jobs.all.iter_mut().find(|j| j.id() == id) {
        f(&mut j.snap);
    }
}

/// Starts the engine install for each queued job, unless paused. One runs at a time.
fn admit(api: &Arc<Api>) {
    let next = {
        let mut jobs = lock(&api.compute.jobs);
        if jobs.paused
            || jobs
                .all
                .iter()
                .any(|j| matches!(j.state(), "preparing" | "running" | "cancelling"))
        {
            return;
        }
        let Some(j) = jobs.all.iter_mut().find(|j| j.state() == "queued") else {
            return;
        };
        j.snap.insert("state".into(), json!("running"));
        j.snap.insert("startedAt".into(), json!(now_ms()));
        (j.id().to_owned(), j.cancel.clone())
    };
    let (id, cancel) = next;
    let api = api.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<u8>(16);
        let progress = {
            let (api, id) = (api.clone(), id.clone());
            async move {
                while let Some(p) = rx.recv().await {
                    set(&api, &id, |s| {
                        s.insert(
                            "progress".into(),
                            json!({ "progress": p, "total": 100, "message": "Downloading the local engine." }),
                        );
                    });
                }
            }
        };
        let (done, ()) = tokio::join!(api.parts.runtime.ensure(Some(tx), cancel.clone()), progress);
        set(&api, &id, |s| {
            s.insert("finishedAt".into(), json!(now_ms()));
            match done {
                Ok(_) => {
                    s.insert("state".into(), json!("succeeded"));
                }
                Err(_) if cancel.is_cancelled() => {
                    s.insert("state".into(), json!("cancelled"));
                }
                Err(e) => {
                    s.insert("state".into(), json!("failed"));
                    s.insert(
                        "failure".into(),
                        json!({ "code": "worker-failure", "message": e.to_string() }),
                    );
                }
            }
        });
        admit(&api);
    });
}

async fn install(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let requirement = match sent.get("requirement").and_then(Value::as_str) {
        Some(r) if !r.is_empty() && r.chars().count() <= 200 => r.to_owned(),
        _ => return refuse(400, "refused", "Supply a valid requirement."),
    };
    if let Err(r) = asked(sent.get("host")).and_then(this_pc) {
        return *r;
    }
    if requirement != ENGINE || engine_installed(&api) {
        return refuse(404, "not-found", "That setup requirement is not known.");
    }
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return refuse(
            409,
            "refused",
            "That requirement has to be done by a person on that computer.",
        );
    }
    let snap = {
        let mut jobs = lock(&api.compute.jobs);
        if jobs
            .all
            .iter()
            .any(|j| !finished(j.state()) && j.snap.get("label") == Some(&json!(ENGINE_TITLE)))
        {
            return refuse(
                409,
                "refused",
                "That requirement is already being installed.",
            );
        }
        let mut snap = Map::new();
        snap.insert("id".into(), json!(job_id()));
        snap.insert("kind".into(), json!("setup"));
        snap.insert("weight".into(), json!("light"));
        snap.insert("state".into(), json!("queued"));
        snap.insert("label".into(), json!(ENGINE_TITLE));
        snap.insert("createdAt".into(), json!(now_ms()));
        jobs.all.push(Job {
            snap: snap.clone(),
            cancel: CancellationToken::new(),
        });
        prune(&mut jobs);
        snap
    };
    admit(&api);
    let id = snap.get("id").cloned().unwrap_or(Value::Null);
    let now = lock(&api.compute.jobs)
        .all
        .iter()
        .find(|j| Some(j.id()) == id.as_str())
        .map_or(snap, |j| j.snap.clone());
    json::ok(json!({ "ok": true, "job": now }))
}

async fn queue(State(api): State<Arc<Api>>, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = asked_query(&q).and_then(this_pc) {
        return *r;
    }
    json::ok(json!({ "queue": queue_of(&lock(&api.compute.jobs)) }))
}

fn valid_job(v: Option<&str>) -> Option<&str> {
    v.filter(|j| !j.is_empty() && j.chars().count() <= 200)
}

async fn job(State(api): State<Arc<Api>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(id) = valid_job(q.get("job").map(String::as_str)) else {
        return refuse(400, "refused", "Supply a valid job.");
    };
    if let Err(r) = asked_query(&q).and_then(this_pc) {
        return *r;
    }
    let jobs = lock(&api.compute.jobs);
    match jobs.all.iter().find(|j| j.id() == id) {
        Some(j) => json::ok(json!({ "job": j.snap })),
        None => refuse(404, "not-found", UNKNOWN_JOB),
    }
}

/// Newest first, as v2's job log.
async fn jobs(State(api): State<Arc<Api>>, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = asked_query(&q).and_then(this_pc) {
        return *r;
    }
    let jobs = lock(&api.compute.jobs);
    let all: Vec<&Map<String, Value>> = jobs.all.iter().rev().map(|j| &j.snap).collect();
    json::ok(json!({ "jobs": all }))
}

/// v2 `scheduler.cancel`: a waiting job leaves the queue, a running one is told to stop and
/// is `cancelling` until it has; a finished one is answered as it is.
async fn cancel(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let Some(id) = valid_job(sent.get("job").and_then(Value::as_str)) else {
        return refuse(400, "refused", "Supply a valid job.");
    };
    if let Err(r) = asked(sent.get("host")).and_then(this_pc) {
        return *r;
    }
    let mut jobs = lock(&api.compute.jobs);
    let Some(j) = jobs.all.iter_mut().find(|j| j.id() == id) else {
        return refuse(404, "not-found", UNKNOWN_JOB);
    };
    match j.state() {
        "queued" => {
            j.snap.insert("state".into(), json!("cancelled"));
            j.snap.insert("finishedAt".into(), json!(now_ms()));
        }
        "preparing" | "running" => {
            j.snap.insert("state".into(), json!("cancelling"));
        }
        _ => {}
    }
    j.cancel.cancel();
    json::ok(json!({ "ok": true, "job": j.snap }))
}

/// v2 `only('compute')`: refused here unless `host=this` names this PC, whose local jobs
/// (`LocalJobs`) and queue then pause or resume.
async fn pause(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    match asked(sent.get("host")) {
        Ok(Some(h)) if h == THIS => {}
        Ok(_) => return refuse(409, "refused", ON_COMPUTE),
        Err(r) => return *r,
    }
    let Some(paused) = sent.get("paused").and_then(Value::as_bool) else {
        return refuse(400, "refused", "Say whether this computer is paused.");
    };
    api.parts.jobs.set_paused(paused);
    lock(&api.compute.jobs).paused = paused;
    if !paused {
        admit(&api);
    }
    json::ok(json!({ "ok": true }))
}

// ---- connection settings ----

/// v2 `savedServices`.
fn saved_services(api: &Api) -> Map<String, Value> {
    let kept = api
        .parts
        .store
        .kv_get("_core", SERVICES_KEY)
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let mut out = Map::new();
    for name in ["relay", "mailbox"] {
        if let Some(s) = kept
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            out.insert(name.into(), json!(s));
        }
    }
    out
}

fn services_answer(api: &Api) -> Response {
    let mut saved = saved_services(api);
    let defaults = saved.is_empty();
    saved.insert("defaults".into(), json!(defaults));
    json::ok(Value::Object(saved))
}

async fn services_get(State(api): State<Arc<Api>>) -> Response {
    services_answer(&api)
}

async fn services_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    let mut kept = Map::new();
    for name in ["relay", "mailbox"] {
        match sent.get(name) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s.is_empty() => {}
            Some(Value::String(s))
                if s.len() <= 2048
                    && reqwest::Url::parse(s.split(',').next().unwrap_or("").trim()).is_ok() =>
            {
                kept.insert(name.into(), json!(s.trim()));
            }
            Some(_) => {
                return refuse(400, "refused", &format!("Supply a valid {name} address."));
            }
        }
    }
    if let Err(e) = api
        .parts
        .store
        .kv_set("_core", SERVICES_KEY, &Value::Object(kept))
    {
        return refuse(500, "refused", &e.to_string());
    }
    services_answer(&api)
}

/// v2 `only('compute')`: the window of the computer you talk to is not let go of from here.
async fn window_close() -> Response {
    refuse(409, "refused", ON_COMPUTE)
}

// ---- Tailscale ----

/// v2 `candidates()`: the app's own place first, then `PATH`.
fn tailscale_cli() -> Option<PathBuf> {
    let named = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let mut all = Vec::new();
    if cfg!(windows) {
        let pf = std::env::var_os("ProgramFiles")
            .map_or_else(|| PathBuf::from("C:\\Program Files"), PathBuf::from);
        all.push(pf.join("Tailscale").join(named));
    } else if cfg!(target_os = "macos") {
        all.push(PathBuf::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ));
    }
    if let Some(path) = std::env::var_os("PATH") {
        all.extend(std::env::split_paths(&path).map(|d| d.join(named)));
    }
    all.into_iter().find(|p| p.is_file())
}

/// v2 `isTailnet`: 100.64.0.0/10, or fd7a:115c:a1e0::/48.
fn is_tailnet(ip: &str) -> bool {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() == 4 && parts[0] == "100" {
        return parts[1]
            .parse::<u8>()
            .is_ok_and(|b| (64..=127).contains(&b));
    }
    ip.to_ascii_lowercase().starts_with("fd7a:115c:a1e0:")
}

/// v2 `parseStatus`: `tailscale status --json`, in the screen's shape.
pub(crate) fn parse_tailscale(text: &str) -> Value {
    let Ok(said) = serde_json::from_str::<Value>(text) else {
        return json!({
            "phase": "unavailable",
            "said": "Tailscale is installed but did not answer. Open the Tailscale app once, then try again.",
            "peers": [],
        });
    };
    let name = |one: &Value| -> String {
        let host = one.get("HostName").and_then(Value::as_str).unwrap_or("");
        let dns = one
            .get("DNSName")
            .and_then(Value::as_str)
            .and_then(|d| d.split('.').next())
            .unwrap_or("");
        let n = if !host.is_empty() {
            host
        } else if !dns.is_empty() {
            dns
        } else {
            "device"
        };
        n.chars().take(60).collect()
    };
    let ips = |one: &Value| -> Vec<String> {
        one.get("TailscaleIPs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|ip| is_tailnet(ip))
            .take(4)
            .map(str::to_owned)
            .collect()
    };
    let peers: Vec<Value> = said
        .get("Peer")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.values())
        .map(|one| {
            json!({
                "name": name(one),
                "os": one.get("OS").and_then(Value::as_str).unwrap_or(""),
                "ips": ips(one),
                "online": one.get("Online") == Some(&Value::Bool(true)),
            })
        })
        .collect();
    match said.get("BackendState").and_then(Value::as_str) {
        Some("Running") => {
            let online = peers.iter().filter(|p| p["online"] == json!(true)).count();
            let self_ = said.get("Self").cloned().unwrap_or(Value::Null);
            json!({
                "phase": "running",
                "said": format!(
                    "Connected to Tailscale. {online} other computer{} online on it.",
                    if online == 1 { " is" } else { "s are" }
                ),
                "self": { "name": name(&self_), "ips": ips(&self_) },
                "peers": peers,
            })
        }
        Some("NeedsLogin" | "NeedsMachineAuth") => {
            let mut out = json!({ "phase": "needs-login", "said": "Tailscale needs you to sign in once.", "peers": [] });
            if let Some(url) = said
                .get("AuthURL")
                .and_then(Value::as_str)
                .filter(|u| u.starts_with("https://"))
            {
                out["loginUrl"] = json!(url);
            }
            out
        }
        Some("Starting") => {
            json!({ "phase": "starting", "said": "Tailscale is starting.", "peers": peers })
        }
        Some("Stopped") => {
            json!({ "phase": "stopped", "said": "Tailscale is installed but switched off.", "peers": [] })
        }
        _ => {
            json!({ "phase": "stopped", "said": "Tailscale is installed but not running.", "peers": [] })
        }
    }
}

/// v2 `Tailscale.status()`: not installed, or what `tailscale status --json` says. Run with no
/// console window; a status that is not running still prints JSON with a non-zero exit.
async fn tailscale_status() -> Value {
    let Some(cli) = tailscale_cli() else {
        return json!({
            "phase": "not-installed",
            "said": "Tailscale is not installed on this computer.",
            "peers": [],
        });
    };
    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(["status", "--json"])
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(TAILSCALE_WAIT, cmd.output()).await;
    let text = match out {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).trim().to_owned(),
        _ => String::new(),
    };
    parse_tailscale(if text.is_empty() { "{}" } else { &text })
}

async fn tailscale_get() -> Response {
    json::ok(json!({ "tailscale": tailscale_status().await }))
}

/// v2's three actions. The hub keeps the one asked for and runs none of them (no mesh yet):
/// the answer is Tailscale as it is.
async fn tailscale_post(
    State(api): State<Arc<Api>>,
    Extension(Sent(sent)): Extension<Sent>,
) -> Response {
    let action = match sent.get("action").and_then(Value::as_str) {
        Some(a @ ("install" | "start" | "login")) => a,
        _ => return refuse(400, "refused", "Choose install, start or login."),
    };
    let kept = json!({ "action": action, "at": now_ms() });
    if let Err(e) = api.parts.store.kv_set("_core", TAILSCALE_KEY, &kept) {
        return refuse(500, "refused", &e.to_string());
    }
    json::ok(json!({ "tailscale": tailscale_status().await }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailnet_addresses() {
        assert!(is_tailnet("100.64.0.1"));
        assert!(is_tailnet("100.127.255.255"));
        assert!(!is_tailnet("100.63.0.1"));
        assert!(!is_tailnet("100.128.0.1"));
        assert!(!is_tailnet("192.168.1.2"));
        assert!(is_tailnet("FD7A:115C:A1E0::1"));
    }

    #[test]
    fn tailscale_status_parsed_as_v2() {
        assert_eq!(parse_tailscale("not json")["phase"], "unavailable");
        assert_eq!(parse_tailscale("{}")["phase"], "stopped");
        assert_eq!(
            parse_tailscale(r#"{"BackendState":"Stopped"}"#)["said"],
            "Tailscale is installed but switched off."
        );
        let login = parse_tailscale(
            r#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/x"}"#,
        );
        assert_eq!(login["phase"], "needs-login");
        assert_eq!(login["loginUrl"], "https://login.tailscale.com/a/x");
        let plain = parse_tailscale(r#"{"BackendState":"NeedsLogin","AuthURL":"http://x"}"#);
        assert!(plain.get("loginUrl").is_none());
        let running = parse_tailscale(
            r#"{"BackendState":"Running",
                "Self":{"HostName":"desk","TailscaleIPs":["100.70.1.2","10.0.0.1"]},
                "Peer":{"a":{"DNSName":"lap.tail.ts.net.","OS":"macOS","TailscaleIPs":["100.70.1.3"],"Online":true},
                        "b":{"HostName":"old","Online":false}}}"#,
        );
        assert_eq!(running["phase"], "running");
        assert_eq!(
            running["said"],
            "Connected to Tailscale. 1 other computer is online on it."
        );
        assert_eq!(
            running["self"],
            json!({ "name": "desk", "ips": ["100.70.1.2"] })
        );
        let peers = running["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 2);
        assert!(peers
            .iter()
            .any(|p| p["name"] == "lap" && p["online"] == true));
    }

    #[test]
    fn hosts_resolve_as_v2_paired() {
        assert_eq!(this_pc(None).unwrap_err().status(), 400);
        assert_eq!(this_pc(Some("abc".into())).unwrap_err().status(), 404);
        assert!(this_pc(Some(THIS.into())).is_ok());
        assert_eq!(asked(Some(&json!(""))).unwrap(), None);
        assert_eq!(asked(Some(&json!(3))).unwrap_err().status(), 400);
    }

    #[test]
    fn finished_jobs_pruned_oldest_first() {
        let mut jobs = Jobs::default();
        let job = |id: usize, state: &str| {
            let mut snap = Map::new();
            snap.insert("id".into(), json!(format!("j{id}")));
            snap.insert("state".into(), json!(state));
            Job {
                snap,
                cancel: CancellationToken::new(),
            }
        };
        jobs.all.push(job(0, "running"));
        for i in 1..=LOG_MAX {
            jobs.all.push(job(i, "succeeded"));
        }
        prune(&mut jobs);
        assert_eq!(jobs.all.len(), LOG_MAX);
        assert_eq!(jobs.all[0].id(), "j0");
        assert_eq!(jobs.all[1].id(), "j2");
    }
}
