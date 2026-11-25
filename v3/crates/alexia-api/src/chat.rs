// SPDX-License-Identifier: AGPL-3.0-only
//! Chat in the window: the stream, stop, approve, commands, "That wasn't her" (INVENTORY
//! C1–C5).
//!
//! A port of v2 serve.ts `reply` (3577–3975) without its paid, pause and preview-cost
//! branches (D-P2D-6), and of the routes beside it. The turn is answered by the hub's one
//! brain (`api.parts.brain`, the `Lanes`) with `Origin::Window`, so the window and Telegram share
//! one history store and one set of tools. The brain's `DraftFrame`s become v2's SSE frames.
//!
//! The window's questions are real approvals (P2D-03): every run of the turn is attached to
//! `WindowQuestions` as it starts (its `Event::RunStarted`), and detached when the turn ends or
//! the stream closes, after which an open question goes to the primary chat. A closed stream
//! is never an Allow.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::util::{kv, lock, megabytes, mime_of, safe_name};
use alexia_core::bus::RunOutcome;
use alexia_core::{
    BrainError, DraftFrame, Event, InFile, Lane, Origin, Phase, Reply, RunId, Steer, StepFrame,
    Turn,
};
use alexia_store::{now_ms, Content, Role, SessionId};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Router};
use base64::Engine;
use serde_json::{json, Map, Value};
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;

use crate::gate::Sent;
use crate::json;
use crate::{learned, local_models, Api, BusyGuard};

/// v2 `STILL_ANSWERING`.
const STILL_ANSWERING: &str = "Alexia is still answering — wait for her or press Stop.";
/// v2's other 423 sentence, while the mode switch runs.
const MODE_SWITCHING: &str = "Wait for the mode switch to finish before sending a message.";
/// v2 `attach.ts` limits.
const MOST_FILES: usize = 8;
const MOST_PER_FILE: usize = 25 * 1024 * 1024;
const MOST_TOGETHER: usize = 40 * 1024 * 1024;
/// v2 `CORE_CAPABILITIES`.
const CAPTURE: &str = "memory.capture";
const FINISHED: &str = "reply.finished";
const NOT_HER: &str = "persona.not_her";
/// The builtin that opens a skill (`prompt.rs`), v2 `SKILL_TOOL`.
const SKILL_TOOL: &str = "skill";
/// How many frames may wait for a slow window before the brain waits for it.
const FRAMES: usize = 256;

/// What this screen keeps between requests.
#[derive(Default)]
pub(crate) struct ChatState {
    /// The window's run, while one is going: Stop cancels it (v2 `task`).
    live: Mutex<Option<CancellationToken>>,
    /// The answer "That wasn't her" was last pressed on, for the line typed after (v2 `pressed`).
    pressed: Mutex<Option<Pressed>>,
}

#[derive(Clone)]
struct Pressed {
    session: SessionId,
    answer: String,
    asked: Option<String>,
}

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/chat", post(chat))
        .route("/api/stop", post(stop))
        .route("/api/approve", post(approve))
        .route("/api/command", post(command))
        .route("/api/not-her", post(not_her))
}

// ---- /api/chat ----

/// Clears the live run when the turn ends, however it ends.
struct Live(Arc<Api>);

impl Drop for Live {
    fn drop(&mut self) {
        *lock(&self.0.chat.live) = None;
    }
}

/// One answer at a time, whoever asked for it (v2 serve.ts 3281–3297): refused with a
/// sentence rather than queued.
fn refused_busy(api: &Api) -> Option<Response> {
    let switching = !local_models::transition(api).is_null();
    let running = lock(&api.chat.live).is_some();
    if api.busy() || running || local_models::busy(api) || switching {
        let said = if switching {
            MODE_SWITCHING
        } else {
            STILL_ANSWERING
        };
        return Some(json::with(
            423,
            json!({ "ok": false, "busy": true, "said": said }),
        ));
    }
    None
}

async fn chat(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    if let Some(r) = refused_busy(&api) {
        return r;
    }
    let Some(guard) = api.try_busy() else {
        return json::with(
            423,
            json!({ "ok": false, "busy": true, "said": STILL_ANSWERING }),
        );
    };
    let session = api.session();
    let store = &api.parts.store;

    let again = sent.get("again") == Some(&Value::Bool(true));
    let typed = sent
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // v2's shell sends `files`; `uploads` is the same list under the name INTERFACES uses.
    let uploads: Vec<Value> = sent
        .get("files")
        .or_else(|| sent.get("uploads"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // The question that stopped, asked again: refused when there is nothing left to answer.
    let text = if again {
        let history = match store.history(session, None) {
            Ok(h) => h,
            Err(e) => return json::said(500, &e.to_string()),
        };
        let question = history.iter().rev().find(|m| m.role == Role::User);
        let answered = history.last().is_some_and(|m| {
            m.role == Role::Assistant && m.body.calls.as_ref().is_none_or(Vec::is_empty)
        });
        match question {
            Some(q) if !answered => q
                .body
                .typed
                .clone()
                .unwrap_or_else(|| q.body.content.text()),
            _ => return json::empty(409),
        }
    } else {
        typed
    };
    // A file with nothing typed is a whole message; nothing at all is not.
    if !again && text.is_empty() && uploads.is_empty() {
        return json::empty(400);
    }
    // ME-17: a message from the window is a sign the owner is up.
    api.parts.bus.publish(Event::Active {
        at: now_ms(),
        via: "window".to_string(),
    });
    if sent.get("private") == Some(&Value::Bool(true)) {
        if let Err(e) = crate::private::mark(&api.parts.store, session) {
            tracing::warn!("chat: could not mark the conversation private: {e}");
        }
    }

    let cancel = CancellationToken::new();
    *lock(&api.chat.live) = Some(cancel.clone());
    let live = Live(api.clone());
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(FRAMES);
    tokio::spawn(reply(
        api.clone(),
        Out { tx, gone: false },
        Asked {
            session,
            text,
            uploads,
        },
        cancel,
        (guard, live),
    ));
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}

/// What the window sent, read.
struct Asked {
    session: SessionId,
    text: String,
    uploads: Vec<Value>,
}

/// The SSE stream to the window. Once the window has gone, frames are dropped.
struct Out {
    tx: mpsc::Sender<Result<Bytes, Infallible>>,
    gone: bool,
}

impl Out {
    /// `data: <json>\n\n`. False once the window has gone.
    async fn say(&mut self, v: Value) -> bool {
        if !self.gone {
            let frame = Bytes::from(format!("data: {v}\n\n"));
            self.gone = self.tx.send(Ok(frame)).await.is_err();
        }
        !self.gone
    }
}

/// The turn, from the uploads to the `done` frame (v2 `reply`).
async fn reply(
    api: Arc<Api>,
    mut out: Out,
    asked: Asked,
    cancel: CancellationToken,
    _held: (BusyGuard, Live),
) {
    let Asked {
        session,
        text,
        uploads,
    } = asked;
    let private = crate::private::is_private(&api.parts.store, session);

    // The documents, before anything else: reading is the first wait after sending a file.
    let mut files = Vec::new();
    if !uploads.is_empty() {
        out.say(json!({ "phase": { "kind": "reading" } })).await;
        let (kept, refused) = receive(&uploads, &api.parts.layout.uploads());
        if !refused.is_empty() {
            out.say(json!({ "note": refused.join(" ") })).await;
        }
        files = kept;
    }

    let turn = Turn {
        session,
        origin: Origin::Window,
        content: Content::Text(text.clone()),
        files: files.clone(),
        received_at: now_ms(),
        steer: Steer::none(),
    };

    let window = api.parts.asker.window();
    // Subscribed before the brain starts, so no `RunStarted` of this turn is missed.
    let mut bus = api.parts.bus.subscribe();
    let (draft, mut frames) = mpsc::channel::<DraftFrame>(FRAMES);
    let brain = api.parts.brain.clone();
    let mut answering = {
        let (draft, cancel) = (draft.clone(), cancel.clone());
        tokio::spawn(async move { brain.reply(turn, draft, cancel).await })
    };
    let mut pump = Pump {
        api: api.clone(),
        runs: Vec::new(),
        first_end: None,
        steps: 0,
        tool: None,
    };

    let mut bus_open = true;
    let result = loop {
        tokio::select! {
            biased;
            e = bus.recv(), if bus_open => match e {
                Ok(e) => {
                    let attach = window.as_ref().filter(|_| !out.gone).map(|w| (w, &draft));
                    pump.event(&e, session, attach);
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => bus_open = false,
            },
            Some(f) = frames.recv() => {
                for v in pump.frame(f) {
                    if !out.say(v).await {
                        // The window let go: its questions go to the primary chat from now on.
                        pump.detach(window.as_ref());
                    }
                }
            }
            // The window let go between frames (mid-question, say): detach now, so its open
            // question goes to the primary chat rather than waiting on nobody.
            () = out.tx.closed(), if !out.gone => {
                out.gone = true;
                pump.detach(window.as_ref());
            }
            r = &mut answering => break r,
        }
    };
    // What the brain said before it returned is already queued; the window's hold on the
    // draft goes with the detach, so nothing more can arrive.
    pump.detach(window.as_ref());
    drop(draft);
    loop {
        match bus.try_recv() {
            Ok(e) => pump.event(&e, session, None),
            Err(TryRecvError::Lagged(_)) => {}
            Err(_) => break,
        }
    }
    while let Ok(f) = frames.try_recv() {
        for v in pump.frame(f) {
            out.say(v).await;
        }
    }
    // Written, read, gone (v2 `discard`): the reading is in the conversation now.
    for f in &files {
        let _ = std::fs::remove_file(&f.path);
    }

    match result {
        Ok(Ok(r)) => {
            let ended = match pump.first_end {
                Some(RunOutcome::Limit) => "limit",
                _ => "answered",
            };
            answered(&api, &mut out, &text, session, private, &r, &pump, ended).await;
        }
        Ok(Err(BrainError::Cancelled)) => {
            out.say(done("", pump.steps, "stopped")).await;
        }
        Ok(Err(e)) => {
            out.say(json!({ "error": e.to_string() })).await;
        }
        Err(e) => {
            tracing::error!("chat: the answer stopped unexpectedly: {e}");
            out.say(json!({ "error": "The answer stopped unexpectedly." }))
                .await;
        }
    }
}

/// After an answer: the learn offer, the hand-off to memory and to whatever presents answers,
/// then `done` (v2 serve.ts 3898–3960).
#[allow(clippy::too_many_arguments)]
async fn answered(
    api: &Arc<Api>,
    out: &mut Out,
    text: &str,
    session: SessionId,
    private: bool,
    r: &Reply,
    pump: &Pump,
    ended: &str,
) {
    if ended == "answered" && !private {
        if let Some(v) = learned::offer(api, session, text, pump.steps as usize, &r.text) {
            out.say(json!({ "learn": v })).await;
        }
    }
    // Fire and forget; credentials never make the trip. Not for a private conversation. The
    // chat lane hands its exchange to memory itself, so only the task lane's goes from here.
    if ended == "answered" && !r.text.trim().is_empty() && !private {
        let mut caps = vec![FINISHED];
        if r.lane != Lane::Chat {
            caps.insert(0, CAPTURE);
        }
        let exchange = exchange(text, &r.text);
        for cap in caps {
            let (host, args) = (api.parts.host.clone(), exchange.clone());
            tokio::spawn(async move {
                if host.answers(cap).answers {
                    let ctx = alexia_mcp::CallCtx::default();
                    let _ = host.call_capability(cap, args, ctx).await;
                }
            });
        }
    }
    out.say(done(r.model.as_deref().unwrap_or(""), pump.steps, ended))
        .await;
}

/// v2 `exchange()`: what was said and answered, redacted, with the time.
fn exchange(said: &str, answered: &str) -> Map<String, Value> {
    let mut args = Map::new();
    args.insert("said".into(), alexia_mcp::redact(said, &[]).into());
    args.insert("answered".into(), alexia_mcp::redact(answered, &[]).into());
    args.insert("at".into(), now_ms().into());
    args
}

/// The `done` frame. v3 never pays (D-P2D-6): the figures are zero.
fn done(model: &str, steps: u32, ended: &str) -> Value {
    json!({ "done": {
        "model": model,
        "spent": 0,
        "cap": 0,
        "today": { "spent": 0, "allowance": 0 },
        "steps": steps,
        "ended": ended,
    }})
}

/// Turns the brain's frames into the window's, and follows the turn's runs on the bus.
struct Pump {
    api: Arc<Api>,
    /// The runs of this turn, attached to the window's questions.
    runs: Vec<RunId>,
    /// How the turn's first run ended.
    first_end: Option<RunOutcome>,
    steps: u32,
    /// The tool the last step named, for the `tool` phase.
    tool: Option<String>,
}

impl Pump {
    /// A run of this turn started: its questions are asked in the window (`attach`: the
    /// window's questions and this turn's draft; None once the window has gone).
    fn event(
        &mut self,
        e: &Event,
        session: SessionId,
        attach: Option<(&alexia_gateway::WindowQuestions, &mpsc::Sender<DraftFrame>)>,
    ) {
        match e {
            Event::RunStarted {
                run,
                session: s,
                origin: Origin::Window,
                ..
            } if *s == session && !self.runs.contains(run) => {
                if let Some((w, draft)) = attach {
                    w.attach(run.clone(), draft.clone());
                }
                self.runs.push(run.clone());
            }
            Event::RunEnded { run, outcome, .. } if self.runs.first() == Some(run) => {
                self.first_end.get_or_insert(*outcome);
            }
            _ => {}
        }
    }

    /// Lets go of every run: an open question of theirs goes to the primary chat.
    fn detach(&self, window: Option<&alexia_gateway::WindowQuestions>) {
        if let Some(w) = window {
            for run in &self.runs {
                w.detach(run.clone());
            }
        }
    }

    /// One `DraftFrame` as v2's frames: none for one the window does not draw, two for a
    /// learned skill opening (the step, then `learned`).
    fn frame(&mut self, f: DraftFrame) -> Vec<Value> {
        vec![match f {
            DraftFrame::Delta(s) => json!({ "delta": s }),
            DraftFrame::Restart => json!({ "restart": true }),
            DraftFrame::Phase(p) => json!({ "phase": phase(p, self.tool.as_deref()) }),
            DraftFrame::Steerable => return Vec::new(),
            DraftFrame::Note(s) => json!({ "note": s }),
            DraftFrame::Ask(s) => json!({ "ask": s }),
            DraftFrame::Step(s) => return self.step(s),
        }]
    }

    fn step(&mut self, s: StepFrame) -> Vec<Value> {
        let StepFrame {
            n,
            name,
            args,
            progress,
            outcome,
        } = s;
        if let Some(o) = outcome {
            self.steps += 1;
            let files = self.api.offers.keep(&o.files);
            let mut step = json!({ "n": n, "name": name, "text": o.text, "ok": o.ok });
            if !files.is_empty() {
                step["files"] = Value::Array(files);
            }
            return vec![json!({ "step": step })];
        }
        if let Some(p) = progress {
            return vec![json!({ "step": { "n": n, "name": name, "progress": p } })];
        }
        self.tool = Some(name.clone());
        let args = args.unwrap_or_else(|| json!({}));
        // Attribution at the moment it fires: a learned skill can be wrong.
        let opened = if name == SKILL_TOOL {
            args.get("name").and_then(Value::as_str).unwrap_or("")
        } else {
            ""
        }
        .to_owned();
        let mut out = vec![json!({ "step": { "n": n, "name": name, "args": args } })];
        if learned_skill(&self.api, &opened) {
            out.push(json!({ "learned": opened }));
        }
        out
    }
}

/// v2's `Phase` (router.ts): the kind, and what the window's status line names. v3's phases
/// carry no model, so the line names "a model".
fn phase(p: Phase, tool: Option<&str>) -> Value {
    const MODEL: &str = "a model";
    match p {
        Phase::Choosing => json!({ "kind": "choosing" }),
        Phase::Asking => json!({ "kind": "asking", "model": MODEL }),
        Phase::Retrying => json!({ "kind": "retrying", "model": MODEL, "attempt": 1 }),
        Phase::Backup => json!({
            "kind": "backup", "model": MODEL, "behind": "the first model", "why": "busy"
        }),
        Phase::Thinking => json!({ "kind": "thinking", "model": MODEL }),
        Phase::Writing => json!({ "kind": "writing", "model": MODEL }),
        Phase::Tool => json!({ "kind": "tool", "name": tool.unwrap_or("a tool") }),
    }
}

/// A learned skill is a folder under the data's skills folder (P2D-07 owns the list).
fn learned_skill(api: &Api, name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', '.'])
        && api.parts.layout.skills().join(name).is_dir()
}

// ---- uploads (v2 attach.ts) ----

/// v2 `receive`: writes what arrived under `dir` and says what would not fit, one sentence
/// each. One oversized file does not lose the others.
fn receive(uploads: &[Value], dir: &std::path::Path) -> (Vec<InFile>, Vec<String>) {
    let mut kept = Vec::new();
    let mut refused = Vec::new();
    let mut together = 0usize;
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!("chat: uploads folder: {e}");
    }
    let at = now_ms();
    for (n, upload) in uploads.iter().take(MOST_FILES).enumerate() {
        let called = safe_name(upload.get("name").and_then(Value::as_str).unwrap_or(""));
        let data = upload.get("data").and_then(Value::as_str).unwrap_or("");
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) else {
            refused.push(format!("{called} did not arrive in one piece."));
            continue;
        };
        if bytes.is_empty() {
            refused.push(format!("{called} is empty."));
            continue;
        }
        if bytes.len() > MOST_PER_FILE {
            refused.push(format!(
                "{called} is {}, and {} is the most one file may be.",
                megabytes(bytes.len()),
                megabytes(MOST_PER_FILE)
            ));
            continue;
        }
        if together + bytes.len() > MOST_TOGETHER {
            refused.push(format!(
                "{called} did not fit — {} is the most that can be attached at once.",
                megabytes(MOST_TOGETHER)
            ));
            continue;
        }
        together += bytes.len();
        let ext: String = called
            .rfind('.')
            .filter(|i| *i > 0)
            .map(|i| called[i..].chars().take(16).collect())
            .unwrap_or_default();
        let path: PathBuf = dir.join(format!("{at}-{n}{ext}"));
        if let Err(e) = std::fs::write(&path, &bytes) {
            tracing::warn!("chat: could not keep an upload: {e}");
            refused.push(format!("{called} did not arrive in one piece."));
            continue;
        }
        let mime = upload
            .get("type")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map_or_else(|| mime_of(&called).to_owned(), str::to_owned);
        kept.push(InFile {
            name: called,
            mime,
            path,
        });
    }
    if uploads.len() > MOST_FILES {
        refused.push(format!(
            "Only the first {MOST_FILES} files were attached — that is the most one message may carry."
        ));
    }
    (kept, refused)
}

// ---- /api/stop, /api/approve ----

/// Works mid-step, always; an open question is settled as a no on the way out.
async fn stop(State(api): State<Arc<Api>>) -> Response {
    let live = lock(&api.chat.live).clone();
    if let Some(c) = &live {
        c.cancel();
    }
    if let Some(w) = api.parts.asker.window() {
        w.cancel_open();
    }
    json::ok(json!({ "stopping": live.is_some() }))
}

async fn approve(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let allowed = sent.get("allowed") == Some(&Value::Bool(true));
    let ok = api.parts.asker.window().is_some_and(|w| w.answer(allowed));
    json::ok(json!({ "ok": ok }))
}

// ---- /api/command ----

/// v2 serve.ts 2396–2445 through `commands::run` with `Origin::Window`. `/new` gives the
/// window a new conversation.
async fn command(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let input = sent
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let typed = input.trim().trim_start_matches('/').trim_start();
    let word = typed.split_whitespace().next().unwrap_or("").to_owned();
    let manifests: Vec<_> = api
        .parts
        .host
        .manifests()
        .into_iter()
        .map(|d| d.manifest)
        .collect();
    let listed = alexia_core::commands::list(&manifests);
    let known = listed
        .iter()
        .any(|c| c.name == word || c.alias.as_deref() == Some(word.as_str()));

    let turn = Turn {
        session: api.session(),
        origin: Origin::Window,
        content: Content::Text(format!("/{typed}")),
        files: Vec::new(),
        received_at: now_ms(),
        steer: Steer::none(),
    };
    let ran = alexia_core::commands::run(&api.parts.agent, &turn, CancellationToken::new()).await;
    let mut body = match ran {
        Ok(r) => json!({ "ok": known, "note": r.text }),
        Err(e) => json!({ "ok": false, "note": e.to_string() }),
    };
    if known && word == "help" {
        body["data"] = listed
            .iter()
            .map(|c| json!({ "name": c.name, "summary": c.summary }))
            .collect();
    }
    if known && word == "new" && body["ok"] == json!(true) {
        let moved = api
            .parts
            .store
            .create_session(None)
            .map_err(crate::Error::from)
            .and_then(|id| api.set_session(id));
        match moved {
            Ok(()) => body["moved"] = json!(true),
            Err(e) => {
                body["ok"] = json!(false);
                body["note"] = json!(e.to_string());
            }
        }
    }
    let transition = local_models::transition(&api);
    if !transition.is_null() {
        body["modeTransition"] = transition;
    }
    body["setup"] = setup(&api);
    body["pins"] = pins(&api);
    json::ok(body)
}

/// v2 `setup()` (serve.ts 820–848), read from the same kv keys.
fn setup(api: &Api) -> Value {
    let name = kv(api, "display_name")
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Alexia".into());
    let mode = kv(api, "mode");
    json!({
        "done": mode.is_some(),
        "name": name,
        "mode": mode.and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "combined".into()),
        "theme": kv(api, "theme").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "system".into()),
        "glass": kv(api, "glass").filter(Value::is_number).unwrap_or_else(|| json!(60)),
        "glassLook": kv(api, "glass_look").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "auto".into()),
        "updates": kv(api, "updates_auto").and_then(|v| v.as_bool()).unwrap_or(true),
    })
}

/// v2 `pins(store)` without `placement`; `uncensored` is always said, false unless set.
fn pins(api: &Api) -> Value {
    let mut pins = kv(api, "pins")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    pins.remove("placement");
    let uncensored = pins.get("uncensored") == Some(&Value::Bool(true));
    pins.insert("uncensored".into(), Value::Bool(uncensored));
    Value::Object(pins)
}

// ---- /api/not-her ----

/// v2 serve.ts 2982–3022: the answer pressed, and what it was answering, to `persona.not_her`.
async fn not_her(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let session = api.session();
    let line = sent
        .get("said")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(500).collect::<String>());
    // A line typed after the press is about the answer that was pressed.
    let mut pair = lock(&api.chat.pressed)
        .clone()
        .filter(|p| line.is_some() && p.session == session);
    if pair.is_none() {
        let history = match api.parts.store.history(session, None) {
            Ok(h) => h,
            Err(e) => return json::said(500, &e.to_string()),
        };
        // The latest answer, not a slash command's reply (v3 keeps those in the conversation;
        // v2 never did).
        let at = (0..history.len()).rev().find(|&i| {
            let m = &history[i];
            let command = i > 0
                && history[i - 1].role == Role::User
                && history[i - 1]
                    .body
                    .content
                    .text()
                    .trim_start()
                    .starts_with('/');
            m.role == Role::Assistant && m.body.calls.as_ref().is_none_or(Vec::is_empty) && !command
        });
        let Some(at) = at else {
            return json::ok(json!({ "ok": false, "said": "There is no answer to mark yet." }));
        };
        let asked = history[..at]
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .map(|m| {
                m.body
                    .typed
                    .clone()
                    .unwrap_or_else(|| m.body.content.text())
                    .chars()
                    .take(500)
                    .collect()
            });
        pair = Some(Pressed {
            session,
            answer: history[at].body.content.text().chars().take(2000).collect(),
            asked,
        });
    }
    let Some(pair) = pair else {
        return json::ok(json!({ "ok": false, "said": "There is no answer to mark yet." }));
    };
    *lock(&api.chat.pressed) = Some(pair.clone());
    let mut args = Map::new();
    args.insert("answer".into(), pair.answer.into());
    if let Some(a) = pair.asked {
        args.insert("asked".into(), a.into());
    }
    if let Some(l) = line {
        args.insert("said".into(), l.into());
    }
    let heard = match api
        .parts
        .host
        .call_capability(NOT_HER, args, alexia_mcp::CallCtx::default())
        .await
    {
        Ok(r) => r.is_error != Some(true),
        Err(e) => {
            tracing::warn!("not-her: {e}");
            false
        }
    };
    // Still `ok`: a press never fails on the strength of a plugin.
    json::ok(json!({ "ok": true, "heard": heard }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names_stay_in_their_folder() {
        assert_eq!(safe_name(r"..\..\Windows\evil.txt"), "evil.txt");
        assert_eq!(safe_name("a/b/../.hidden"), "hidden");
        assert_eq!(safe_name("con:fig?.md"), "config.md");
        assert_eq!(safe_name("\u{1}\u{2}"), "attachment");
        assert_eq!(safe_name(&"x".repeat(300)).len(), 120);
    }

    #[test]
    fn receive_keeps_and_refuses_with_v2_sentences() {
        let dir = std::env::temp_dir().join(format!("alexia-api-receive-{}", std::process::id()));
        let b64 = |s: &[u8]| base64::engine::general_purpose::STANDARD.encode(s);
        let mut uploads = vec![
            json!({"name": "a.txt", "data": b64(b"some text")}),
            json!({"name": "empty.txt", "data": ""}),
            json!({"name": "bad.bin", "data": "!!not base64!!"}),
            json!({"name": "pic.png", "data": b64(b"png"), "type": "image/jpeg"}),
        ];
        for i in 0..6 {
            uploads.push(json!({"name": format!("{i}.txt"), "data": b64(b"x")}));
        }
        let (kept, refused) = receive(&uploads, &dir);
        assert_eq!(kept.len(), 6, "{refused:?}");
        assert_eq!(kept[0].name, "a.txt");
        assert_eq!(kept[0].mime, "text/plain");
        assert_eq!(std::fs::read(&kept[0].path).unwrap(), b"some text");
        assert_eq!(kept[1].mime, "image/jpeg");
        assert_eq!(
            refused,
            vec![
                "empty.txt is empty.".to_owned(),
                "bad.bin did not arrive in one piece.".to_owned(),
                "Only the first 8 files were attached — that is the most one message may carry."
                    .to_owned(),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn phases_have_v2_shapes() {
        assert_eq!(phase(Phase::Choosing, None), json!({"kind": "choosing"}));
        assert_eq!(phase(Phase::Tool, Some("x__y"))["name"], "x__y");
        assert_eq!(phase(Phase::Writing, None)["kind"], "writing");
        assert!(phase(Phase::Retrying, None)["attempt"].is_number());
    }

    #[test]
    fn done_never_pays() {
        let d = done("m", 2, "answered");
        assert_eq!(d["done"]["spent"], 0);
        assert_eq!(d["done"]["cap"], 0);
        assert!(d["done"].get("paid").is_none());
        assert_eq!(d["done"]["today"], json!({"spent": 0, "allowance": 0}));
    }
}
