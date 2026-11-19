// SPDX-License-Identifier: AGPL-3.0-only
//! The gateway loop: ack, merge, steer, drafts, spans (CH-03, CH-04, CH-08, CH-09, SP-09, SP-14).
//!
//! One poll task per channel fires the reaction and hands each message to its chat's actor. The
//! actor owns that chat's state (merge window, running turn, queue) and talks to its turn task
//! over channels. The turn task runs the brain, pumps drafts and delivers; the actor records.

use std::collections::HashMap;
use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alexia_core::{Brain, BrainError, Bus, DraftFrame, Event, Lane, Origin, Phase, Span};
use alexia_store::{Content, Ms, Part, SessionId, SpanRow, Store};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::sleep_until;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::ask::{Asker, Channels};
use crate::{
    voice, Channel, ChatRef, Error, GatewayConfig, InFile, InKind, Inbound, Media, Outbound, Result,
};

const SORRY: &str = "Something went wrong on my side. I've noted it.";
const HELP: &str =
    "/stop — stop what I'm doing\n/new — start a new conversation\n/help — this list";
const TYPING_EVERY: Duration = Duration::from_secs(4);
const DRAFT_CAP_MS: u64 = 2_000;
const SHUTDOWN_WAIT: Duration = Duration::from_secs(3);

pub struct Gateway {
    cfg: GatewayConfig,
    store: Arc<Store>,
    bus: Bus,
    brain: Arc<dyn Brain>,
    media: Arc<dyn Media>,
    channels: Channels,
}

/// What every task of one gateway shares.
struct Shared {
    cfg: GatewayConfig,
    store: Arc<Store>,
    bus: Bus,
    brain: Arc<dyn Brain>,
    media: Arc<dyn Media>,
}

impl Gateway {
    pub fn new(
        cfg: GatewayConfig,
        store: Arc<Store>,
        bus: Bus,
        brain: Arc<dyn Brain>,
        media: Arc<dyn Media>,
    ) -> Gateway {
        Gateway {
            cfg,
            store,
            bus,
            brain,
            media,
            channels: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub fn add(&mut self, channel: Arc<dyn Channel>) {
        self.channels
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .push(channel);
    }

    /// Runs until `cancel`, then stops polling, cancels running turns and waits at most 3 s.
    pub async fn run(self, cancel: CancellationToken) -> Result<()> {
        let says = self.bus.subscribe();
        let channels: Vec<Arc<dyn Channel>> = self
            .channels
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let g = Arc::new(Shared {
            cfg: self.cfg,
            store: self.store,
            bus: self.bus,
            brain: self.brain,
            media: self.media,
        });
        let tracker = TaskTracker::new();
        for ch in &channels {
            tracker.spawn(poll(g.clone(), ch.clone(), cancel.clone(), tracker.clone()));
        }
        tracker.spawn(say(g.clone(), channels, says, cancel.clone()));
        cancel.cancelled().await;
        tracker.close();
        if tokio::time::timeout(SHUTDOWN_WAIT, tracker.wait())
            .await
            .is_err()
        {
            tracing::warn!("gateway: some tasks did not stop within 3 s");
        }
        Ok(())
    }

    pub fn asker(&self) -> Arc<dyn alexia_core::Ask> {
        Arc::new(Asker::new(self.channels.clone(), self.store.clone()))
    }
}

fn now_ms() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Ms)
        .unwrap_or(0)
}

fn ms_since(t: Instant) -> u32 {
    t.elapsed().as_millis().min(u32::MAX as u128) as u32
}

/// When a message reached the gateway, on both clocks.
#[derive(Clone, Copy)]
struct Received {
    instant: Instant,
    ms: Ms,
}

struct Msg {
    inbound: Inbound,
    rec: Received,
}

enum ToActor {
    In(Msg),
    /// A reaction answered: `ms` = receipt → answer. `ok == false` = it failed (no span).
    Acked {
        msg: String,
        start: Ms,
        ms: u32,
        ok: bool,
    },
}

// ---- poll ----

async fn poll(
    g: Arc<Shared>,
    ch: Arc<dyn Channel>,
    cancel: CancellationToken,
    tracker: TaskTracker,
) {
    let mut actors: HashMap<String, mpsc::UnboundedSender<ToActor>> = HashMap::new();
    loop {
        let batch = tokio::select! {
            _ = cancel.cancelled() => break,
            r = ch.next(cancel.clone()) => r,
        };
        let batch = match batch {
            Ok(b) => b,
            Err(Error::Unauthorized) => {
                tracing::error!(
                    channel = ch.name(),
                    "gateway: the token was refused; polling stops"
                );
                break;
            }
            Err(Error::Cancelled) => break,
            Err(e) => {
                // The channel backs off itself; this only keeps a broken one from spinning.
                tracing::warn!(channel = ch.name(), "gateway: next() failed: {e}");
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(50)) => continue,
                }
            }
        };
        for inbound in batch {
            let rec = Received {
                instant: Instant::now(),
                ms: now_ms(),
            };
            if !inbound.from_owner {
                continue;
            }
            let tx = actor_for(&g, &ch, &inbound.chat, &cancel, &tracker, &mut actors);
            spawn_ack(&g, &ch, &inbound, rec, tx.clone());
            if tx.send(ToActor::In(Msg { inbound, rec })).is_err() {
                tracing::warn!(channel = ch.name(), "gateway: a chat actor is gone");
            }
        }
    }
}

fn actor_for(
    g: &Arc<Shared>,
    ch: &Arc<dyn Channel>,
    chat: &ChatRef,
    cancel: &CancellationToken,
    tracker: &TaskTracker,
    actors: &mut HashMap<String, mpsc::UnboundedSender<ToActor>>,
) -> mpsc::UnboundedSender<ToActor> {
    if let Some(tx) = actors.get(&chat.chat) {
        if !tx.is_closed() {
            return tx.clone();
        }
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let actor = Actor::new(g.clone(), ch.clone(), chat.clone(), cancel.clone());
    tracker.spawn(actor.run(rx));
    actors.insert(chat.chat.clone(), tx.clone());
    tx
}

/// CH-03: the reaction, in its own task, so nothing here waits on the service.
fn spawn_ack(
    g: &Arc<Shared>,
    ch: &Arc<dyn Channel>,
    inbound: &Inbound,
    rec: Received,
    tx: mpsc::UnboundedSender<ToActor>,
) {
    let (g, ch) = (g.clone(), ch.clone());
    let (chat, msg) = (inbound.chat.clone(), inbound.msg.clone());
    tokio::spawn(async move {
        let r = ch.react(&chat, &msg, &g.cfg.ack_emoji).await;
        let ms = ms_since(rec.instant);
        let ok = match r {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(channel = ch.name(), "gateway: reaction failed: {e}");
                false
            }
        };
        if ok {
            g.bus.publish(Event::Acked {
                at: now_ms(),
                origin: origin(ch.name(), &chat),
                ms,
            });
        }
        let _ = tx.send(ToActor::Acked {
            msg: msg.id,
            start: rec.ms,
            ms,
            ok,
        });
    });
}

fn origin(channel: &str, chat: &ChatRef) -> Origin {
    Origin::Channel {
        channel: channel.to_string(),
        chat: chat.chat.clone(),
    }
}

// ---- say ----

async fn say(
    g: Arc<Shared>,
    channels: Vec<Arc<dyn Channel>>,
    mut rx: tokio::sync::broadcast::Receiver<Arc<Event>>,
    cancel: CancellationToken,
) {
    loop {
        let ev = tokio::select! {
            _ = cancel.cancelled() => return,
            ev = rx.recv() => ev,
        };
        let ev = match ev {
            Ok(ev) => ev,
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("gateway: missed {n} bus events");
                continue;
            }
            Err(RecvError::Closed) => return,
        };
        let Event::Say { text, .. } = &*ev else {
            continue;
        };
        for ch in &channels {
            let chat = match g.store.primary_chat(ch.name()) {
                Ok(Some(chat)) => ChatRef { chat },
                Ok(None) => continue,
                Err(e) => {
                    tracing::error!(channel = ch.name(), "gateway: primary chat: {e}");
                    continue;
                }
            };
            if let Err(e) = ch.send(&chat, &plain(text)).await {
                tracing::warn!(channel = ch.name(), "gateway: say failed: {e}");
            }
        }
    }
}

fn plain(text: &str) -> Outbound {
    Outbound {
        text: text.to_string(),
        files: Vec::new(),
        voice: false,
    }
}

// ---- actor ----

/// Who a turn's rows belong to; kept until its reactions have answered.
#[derive(Clone)]
struct TurnMeta {
    turn: String,
    at: Ms,
    origin: String,
    lane: String,
}

struct Running {
    cancel: CancellationToken,
    /// A `Delta` has reached the draft.
    visible: Arc<AtomicBool>,
    /// The brain used a tool, so this is the task lane (the chat lane has none).
    tasky: Arc<AtomicBool>,
    handle: JoinHandle<TurnEnd>,
    msgs: Vec<Msg>,
}

enum TurnEnd {
    Cancelled {
        drafted: String,
    },
    Finished {
        lane: Lane,
        session: SessionId,
        spans: Vec<Span>,
    },
}

struct Actor {
    g: Arc<Shared>,
    ch: Arc<dyn Channel>,
    chat: ChatRef,
    cancel: CancellationToken,
    /// Messages inside the merge window.
    window: Vec<Msg>,
    deadline: Option<tokio::time::Instant>,
    /// Messages waiting for a visible chat reply to be delivered.
    queued: Vec<Msg>,
    running: Option<Running>,
    /// Reactions that answered before their turn was recorded.
    acks: HashMap<String, (Ms, u32)>,
    /// Recorded turns whose reaction has not answered yet, by message id.
    late: HashMap<String, TurnMeta>,
}

impl Actor {
    fn new(
        g: Arc<Shared>,
        ch: Arc<dyn Channel>,
        chat: ChatRef,
        cancel: CancellationToken,
    ) -> Actor {
        Actor {
            g,
            ch,
            chat,
            cancel,
            window: Vec::new(),
            deadline: None,
            queued: Vec::new(),
            running: None,
            acks: HashMap::new(),
            late: HashMap::new(),
        }
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<ToActor>) {
        loop {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    if let Some(r) = self.running.take() {
                        r.cancel.cancel();
                        let _ = r.handle.await;
                    }
                    return;
                }
                m = rx.recv() => match m {
                    Some(ToActor::In(msg)) => self.inbound(msg).await,
                    Some(ToActor::Acked { msg, start, ms, ok }) => self.acked(msg, start, ms, ok),
                    None => return,
                },
                end = join(&mut self.running) => {
                    let r = self.running.take().expect("joined a running turn");
                    self.finished(r.msgs, end);
                    if !self.queued.is_empty() {
                        let msgs = std::mem::take(&mut self.queued);
                        self.start(msgs);
                    }
                }
                _ = wait(self.deadline) => {
                    self.deadline = None;
                    let msgs = std::mem::take(&mut self.window);
                    self.start(msgs);
                }
            }
        }
    }

    async fn inbound(&mut self, msg: Msg) {
        let text = match &msg.inbound.content {
            Content::Text(t) => t.trim().to_string(),
            Content::Parts(_) => String::new(),
        };
        if msg.inbound.kind == InKind::Stop || text == "/stop" {
            return self.stop(msg).await;
        }
        if text == "/new" || text == "/help" {
            let reply = if text == "/new" {
                match self
                    .g
                    .store
                    .new_channel_session(self.ch.name(), &self.chat.chat)
                {
                    Ok(_) => "New conversation.",
                    Err(e) => {
                        tracing::error!("gateway: new session: {e}");
                        SORRY
                    }
                }
            } else {
                HELP
            };
            return self.command(msg, reply).await;
        }
        let Some(running) = &self.running else {
            if self.window.is_empty() {
                let at = msg.rec.instant + Duration::from_millis(self.g.cfg.merge_ms);
                self.deadline = Some(at.into());
            }
            self.window.push(msg);
            return;
        };
        if !running.visible.load(Ordering::SeqCst) {
            // CH-09: nothing shown yet, so start over with everything said so far.
            let r = self.running.take().expect("running");
            r.cancel.cancel();
            let end = r.handle.await;
            let mut msgs = r.msgs;
            if let Ok(TurnEnd::Finished { .. }) = &end {
                // It finished before it saw the cancel: it was delivered, this one is new.
                self.finished(msgs, end);
                msgs = Vec::new();
            }
            msgs.push(msg);
            self.start(msgs);
        } else if running.tasky.load(Ordering::SeqCst) {
            // CH-08: steer. Keep what was written, then answer the new message.
            let r = self.running.take().expect("running");
            r.cancel.cancel();
            match r.handle.await {
                Ok(TurnEnd::Cancelled { drafted }) => {
                    let kept = format!("{}…", drafted.trim_end());
                    if let Err(e) = self.ch.send(&self.chat, &plain(&kept)).await {
                        tracing::warn!("gateway: keeping the draft failed: {e}");
                    }
                    let _ = self.ch.draft(&self.chat, None).await;
                    delete_files(&r.msgs);
                }
                end => self.finished(r.msgs, end),
            }
            self.start(vec![msg]);
        } else {
            self.queued.push(msg);
        }
    }

    async fn stop(&mut self, msg: Msg) {
        if let Some(r) = self.running.take() {
            r.cancel.cancel();
            let end = r.handle.await;
            if let Ok(TurnEnd::Finished { .. }) = &end {
                self.finished(r.msgs, end);
            } else {
                delete_files(&r.msgs);
                let _ = self.ch.draft(&self.chat, None).await;
            }
        }
        self.deadline = None;
        delete_files(&self.window);
        delete_files(&self.queued);
        self.window.clear();
        self.queued.clear();
        self.command(msg, "Stopped.").await;
    }

    /// Answers a command the gateway handles itself, and records it as a `command` turn.
    async fn command(&mut self, msg: Msg, reply: &str) {
        let start = now_ms();
        let t = Instant::now();
        if let Err(e) = self.ch.send(&self.chat, &plain(reply)).await {
            tracing::warn!("gateway: command reply failed: {e}");
        }
        let spans = vec![Span {
            name: "deliver",
            start,
            ms: ms_since(t),
        }];
        delete_files(std::slice::from_ref(&msg));
        self.record(&[msg], Lane::Command, spans);
    }

    fn acked(&mut self, msg: String, start: Ms, ms: u32, ok: bool) {
        match self.late.remove(&msg) {
            Some(meta) if ok => {
                let row = row(&meta, "ack", start, ms as i64);
                if let Err(e) = self.g.store.record_spans(&[row]) {
                    tracing::error!("gateway: recording a span: {e}");
                }
            }
            Some(_) => {}
            None if ok => {
                self.acks.insert(msg, (start, ms));
            }
            None => {}
        }
    }

    fn start(&mut self, msgs: Vec<Msg>) {
        if msgs.is_empty() {
            return;
        }
        let name = self.ch.name();
        let session = match self.g.store.channel_session(name, &self.chat.chat) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("gateway: channel session: {e}");
                delete_files(&msgs);
                let (ch, chat) = (self.ch.clone(), self.chat.clone());
                tokio::spawn(async move { ch.send(&chat, &plain(SORRY)).await });
                return;
            }
        };
        let cancel = self.cancel.child_token();
        let visible = Arc::new(AtomicBool::new(false));
        let tasky = Arc::new(AtomicBool::new(false));
        let ctx = TurnCtx {
            g: self.g.clone(),
            ch: self.ch.clone(),
            chat: self.chat.clone(),
            inbound: merge(&msgs),
            first: msgs[0].rec,
            session,
            cancel: cancel.clone(),
            visible: visible.clone(),
            tasky: tasky.clone(),
        };
        self.running = Some(Running {
            cancel,
            visible,
            tasky,
            handle: tokio::spawn(ctx.run()),
            msgs,
        });
    }

    fn finished(
        &mut self,
        msgs: Vec<Msg>,
        end: std::result::Result<TurnEnd, tokio::task::JoinError>,
    ) {
        delete_files(&msgs);
        match end {
            Ok(TurnEnd::Finished {
                lane,
                session,
                spans,
            }) => {
                let meta = self.record(&msgs, lane, spans.clone());
                self.g.bus.publish(Event::Delivered {
                    at: meta.at,
                    origin: origin(self.ch.name(), &self.chat),
                    session,
                    lane,
                    spans,
                });
            }
            Ok(TurnEnd::Cancelled { .. }) => {}
            Err(e) => tracing::error!("gateway: a turn panicked: {e}"),
        }
    }

    /// One `record_spans` per turn: the turn's own spans plus every reaction that has answered.
    fn record(&mut self, msgs: &[Msg], lane: Lane, mut spans: Vec<Span>) -> TurnMeta {
        let first = &msgs[0];
        let meta = TurnMeta {
            turn: format!(
                "{}:{}:{}",
                self.ch.name(),
                self.chat.chat,
                first.inbound.msg.id
            ),
            at: first.rec.ms,
            origin: serde_json::to_string(&origin(self.ch.name(), &self.chat)).unwrap_or_default(),
            lane: lane_name(lane).to_string(),
        };
        for m in msgs {
            match self.acks.remove(&m.inbound.msg.id) {
                Some((start, ms)) => spans.push(Span {
                    name: "ack",
                    start,
                    ms,
                }),
                None => {
                    self.late.insert(m.inbound.msg.id.clone(), meta.clone());
                }
            }
        }
        let rows: Vec<SpanRow> = spans
            .iter()
            .map(|s| row(&meta, s.name, s.start, s.ms as i64))
            .collect();
        if let Err(e) = self.g.store.record_spans(&rows) {
            tracing::error!("gateway: recording spans: {e}");
        }
        meta
    }
}

fn row(meta: &TurnMeta, name: &str, start: Ms, ms: i64) -> SpanRow {
    SpanRow {
        turn: meta.turn.clone(),
        at: meta.at,
        origin: meta.origin.clone(),
        lane: meta.lane.clone(),
        name: name.to_string(),
        start,
        ms,
    }
}

fn lane_name(lane: Lane) -> &'static str {
    match lane {
        Lane::Command => "command",
        Lane::Chat => "chat",
        Lane::Task => "task",
    }
}

async fn join(
    running: &mut Option<Running>,
) -> std::result::Result<TurnEnd, tokio::task::JoinError> {
    match running {
        Some(r) => (&mut r.handle).await,
        None => pending().await,
    }
}

async fn wait(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => sleep_until(d).await,
        None => pending().await,
    }
}

fn delete_files(msgs: &[Msg]) {
    for f in msgs.iter().flat_map(|m| &m.inbound.files) {
        if let Err(e) = std::fs::remove_file(&f.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("gateway: deleting {}: {e}", f.path.display());
            }
        }
    }
}

/// Texts joined by "\n", other parts after them, files concatenated.
fn merge(msgs: &[Msg]) -> Inbound {
    let mut inbound = msgs[0].inbound.clone();
    if msgs.len() == 1 {
        return inbound;
    }
    let mut texts = Vec::new();
    let mut others = Vec::new();
    let mut files: Vec<InFile> = Vec::new();
    for m in msgs {
        match &m.inbound.content {
            Content::Text(t) => texts.push(t.clone()),
            Content::Parts(parts) => {
                for p in parts {
                    match p {
                        Part::Text { text } => texts.push(text.clone()),
                        other => others.push(other.clone()),
                    }
                }
            }
        }
        files.extend(m.inbound.files.iter().cloned());
    }
    let text = texts.join("\n");
    inbound.content = if others.is_empty() {
        Content::Text(text)
    } else {
        let mut parts = Vec::new();
        if !text.is_empty() {
            parts.push(Part::Text { text });
        }
        parts.extend(others);
        Content::Parts(parts)
    };
    inbound.files = files;
    inbound
}

// ---- turn ----

struct TurnCtx {
    g: Arc<Shared>,
    ch: Arc<dyn Channel>,
    chat: ChatRef,
    inbound: Inbound,
    first: Received,
    session: SessionId,
    cancel: CancellationToken,
    visible: Arc<AtomicBool>,
    tasky: Arc<AtomicBool>,
}

impl TurnCtx {
    async fn run(self) -> TurnEnd {
        let g = self.g.clone();
        let origin = origin(self.ch.name(), &self.chat);
        let mut spans = Vec::new();

        let voiced = self
            .inbound
            .files
            .iter()
            .any(|f| f.mime.starts_with("audio/"));
        let (hear_start, hear_t) = (now_ms(), Instant::now());
        let inbound = tokio::select! {
            _ = self.cancel.cancelled() => return TurnEnd::Cancelled { drafted: String::new() },
            i = voice::hear(&*g.media, self.inbound.clone()) => i,
        };
        if voiced {
            spans.push(Span {
                name: "hear",
                start: hear_start,
                ms: ms_since(hear_t),
            });
        }

        let turn = alexia_core::Turn {
            session: self.session,
            origin: origin.clone(),
            content: inbound.content.clone(),
            received_at: self.first.ms,
        };
        let brain_start = now_ms();
        spans.push(Span {
            name: "merge",
            start: self.first.ms,
            ms: ms_since(self.first.instant),
        });
        g.bus.publish(Event::Received {
            at: brain_start,
            origin,
            session: self.session,
        });

        let brain_t = Instant::now();
        let (tx, frames) = mpsc::channel(64);
        let fut = g.brain.reply(turn, tx, self.cancel.clone());
        let mut pump = Pump::new(&self, frames);
        let result = pump.run(fut).await;
        let drafted = pump.text;

        let reply = match result {
            Ok(r) => r,
            Err(BrainError::Cancelled) => return TurnEnd::Cancelled { drafted },
            Err(e) => {
                let text = match e {
                    BrainError::Unavailable(s) => s,
                    e => {
                        tracing::error!("gateway: the brain failed: {e}");
                        SORRY.to_string()
                    }
                };
                spans.push(Span {
                    name: "brain",
                    start: brain_start,
                    ms: ms_since(brain_t),
                });
                self.deliver(&mut spans, plain(&text)).await;
                return TurnEnd::Finished {
                    lane: Lane::Chat,
                    session: self.session,
                    spans,
                };
            }
        };
        spans.push(Span {
            name: "brain",
            start: brain_start,
            ms: ms_since(brain_t),
        });
        // The brain measures from when it was handed the turn.
        spans.extend(reply.spans.iter().map(|s| Span {
            name: s.name,
            start: brain_start + s.start,
            ms: s.ms,
        }));

        let mut out = Outbound {
            text: reply.text.clone(),
            files: reply.files.clone(),
            voice: false,
        };
        if voice::wants_voice(&g.store, &inbound) {
            let (start, t) = (now_ms(), Instant::now());
            let note = voice::speak(&*g.media, &reply.text).await;
            spans.push(Span {
                name: "speak",
                start,
                ms: ms_since(t),
            });
            if let Some(note) = note {
                out.files.push(note);
                out.voice = true;
            }
        }
        self.deliver(&mut spans, out).await;
        TurnEnd::Finished {
            lane: reply.lane,
            session: self.session,
            spans,
        }
    }

    async fn deliver(&self, spans: &mut Vec<Span>, out: Outbound) {
        let (start, t) = (now_ms(), Instant::now());
        let sent = self.ch.send(&self.chat, &out).await;
        spans.push(Span {
            name: "deliver",
            start,
            ms: ms_since(t),
        });
        if let Err(e) = sent {
            tracing::error!(channel = self.ch.name(), "gateway: delivering failed: {e}");
        }
        let _ = self.ch.draft(&self.chat, None).await;
    }
}

/// The words for a stage while nothing is written yet (v2's `status.js`).
fn phase_words(phase: Phase) -> Option<&'static str> {
    match phase {
        Phase::Choosing | Phase::Asking => Some("Choosing a model…"),
        Phase::Thinking => Some("Thinking…"),
        Phase::Tool => Some("Working…"),
        Phase::Retrying | Phase::Backup => Some("Trying another model…"),
        Phase::Writing => None,
    }
}

/// CH-04 / SP-14: the draft at the rate the service takes it.
struct Pump {
    ch: Arc<dyn Channel>,
    chat: ChatRef,
    frames: mpsc::Receiver<DraftFrame>,
    visible: Arc<AtomicBool>,
    tasky: Arc<AtomicBool>,
    cancel: CancellationToken,
    floor: Duration,
    every: Duration,
    clean: u32,
    text: String,
    status: Option<&'static str>,
    dirty: bool,
    last: Option<Instant>,
    blocked_until: Option<Instant>,
    shown: bool,
}

impl Pump {
    fn new(t: &TurnCtx, frames: mpsc::Receiver<DraftFrame>) -> Pump {
        let floor = Duration::from_millis(t.g.cfg.draft_every_ms.max(1));
        Pump {
            ch: t.ch.clone(),
            chat: t.chat.clone(),
            frames,
            visible: t.visible.clone(),
            tasky: t.tasky.clone(),
            cancel: t.cancel.clone(),
            floor,
            every: floor,
            clean: 0,
            text: String::new(),
            status: None,
            dirty: false,
            last: None,
            blocked_until: None,
            shown: false,
        }
    }

    async fn run<F>(&mut self, fut: F) -> std::result::Result<alexia_core::Reply, BrainError>
    where
        F: std::future::Future<Output = std::result::Result<alexia_core::Reply, BrainError>>,
    {
        tokio::pin!(fut);
        let mut open = true;
        let mut typing_at = Instant::now();
        loop {
            let next = self.next_at();
            tokio::select! {
                biased;
                r = &mut fut => return r,
                _ = self.cancel.cancelled() => return Err(BrainError::Cancelled),
                f = self.frames.recv(), if open => match f {
                    Some(f) => self.frame(f),
                    None => open = false,
                },
                _ = wait(next.map(Into::into)) => self.send().await,
                _ = sleep_until(typing_at.into()), if !self.shown => {
                    let (ch, chat) = (self.ch.clone(), self.chat.clone());
                    tokio::spawn(async move { ch.typing(&chat).await });
                    typing_at += TYPING_EVERY;
                }
            }
        }
    }

    fn frame(&mut self, f: DraftFrame) {
        match f {
            DraftFrame::Delta(d) => {
                if d.is_empty() {
                    return;
                }
                self.text.push_str(&d);
            }
            DraftFrame::Restart => self.text.clear(),
            DraftFrame::Phase(p) => {
                if p == Phase::Tool {
                    self.tasky.store(true, Ordering::SeqCst);
                }
                match phase_words(p) {
                    Some(w) => self.status = Some(w),
                    None => return,
                }
                if !self.text.is_empty() {
                    return;
                }
            }
        }
        self.dirty = true;
    }

    fn next_at(&self) -> Option<Instant> {
        if !self.dirty {
            return None;
        }
        let paced = self.last.map(|l| l + self.every);
        Some(match (paced, self.blocked_until) {
            (Some(a), Some(b)) => a.max(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => Instant::now(),
        })
    }

    async fn send(&mut self) {
        let text = if !self.text.is_empty() {
            self.text.clone()
        } else if let Some(s) = self.status {
            s.to_string()
        } else {
            self.dirty = false;
            return;
        };
        let r = self.ch.draft(&self.chat, Some(&text)).await;
        let now = Instant::now();
        self.last = Some(now);
        self.blocked_until = None;
        match r {
            Ok(()) => {
                self.dirty = false;
                self.shown = true;
                if !self.text.is_empty() {
                    self.visible.store(true, Ordering::SeqCst);
                }
                self.clean += 1;
                if self.clean >= 10 {
                    self.every = (self.every / 2).max(self.floor);
                    self.clean = 0;
                }
            }
            Err(Error::RateLimited { retry_after_ms }) => {
                self.blocked_until = Some(now + Duration::from_millis(retry_after_ms));
                let cap = Duration::from_millis(DRAFT_CAP_MS).max(self.floor);
                self.every = (self.every * 2).min(cap);
                self.clean = 0;
            }
            Err(e) => {
                tracing::debug!("gateway: draft failed: {e}");
                self.dirty = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MsgRef;

    fn msg(content: Content, file: Option<&str>) -> Msg {
        Msg {
            inbound: Inbound {
                chat: ChatRef { chat: "1".into() },
                msg: MsgRef { id: "1".into() },
                kind: InKind::Message,
                from_owner: true,
                content,
                files: file
                    .map(|n| InFile {
                        name: n.into(),
                        mime: "image/png".into(),
                        path: n.into(),
                    })
                    .into_iter()
                    .collect(),
                at: 0,
            },
            rec: Received {
                instant: Instant::now(),
                ms: 0,
            },
        }
    }

    #[test]
    fn merge_joins_texts_and_keeps_images_and_files() {
        let m = merge(&[
            msg(Content::Text("a".into()), Some("x")),
            msg(
                Content::Parts(vec![
                    Part::Text { text: "b".into() },
                    Part::Image {
                        url: "data:".into(),
                    },
                ]),
                Some("y"),
            ),
        ]);
        assert_eq!(
            m.content,
            Content::Parts(vec![
                Part::Text {
                    text: "a\nb".into()
                },
                Part::Image {
                    url: "data:".into()
                }
            ])
        );
        assert_eq!(m.files.len(), 2);
        let m = merge(&[
            msg(Content::Text("a".into()), None),
            msg(Content::Text("b".into()), None),
        ]);
        assert_eq!(m.content, Content::Text("a\nb".into()));
    }
}
