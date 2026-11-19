// SPDX-License-Identifier: AGPL-3.0-only
//! The gateway loop: ack, merge, steer, drafts, spans (CH-03, CH-04, CH-08, CH-09, SP-09, SP-14).
//!
//! One poll task per channel fires the reaction and hands each message to its chat's actor. The
//! actor owns that chat's state (merge window, running turn, queue) and talks to its turn task
//! over channels. The turn task runs the brain, pumps drafts and delivers; the actor records.

use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use alexia_core::{Brain, BrainError, Bus, DraftFrame, Event, Lane, Origin, Phase, Span};
use alexia_store::{now_ms, Content, Ms, Part, SessionId, SpanRow, Store};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, Instant};
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
    /// Every task the gateway starts, so `run` can wait for all of them.
    tracker: TaskTracker,
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
        let tracker = TaskTracker::new();
        let g = Arc::new(Shared {
            cfg: self.cfg,
            store: self.store,
            bus: self.bus,
            brain: self.brain,
            media: self.media,
            tracker: tracker.clone(),
        });
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

fn ms_since(t: Instant) -> u32 {
    t.elapsed().as_millis().min(u32::MAX as u128) as u32
}

/// A span's `start`: ms from the turn's first receipt to `t`.
fn offset(first: Instant, t: Instant) -> Ms {
    t.saturating_duration_since(first).as_millis() as Ms
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
        rec: Instant,
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
            biased;
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
    let tracker = g.tracker.clone();
    tracker.spawn(async move {
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
            rec: rec.instant,
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
    /// The turn's first receipt, which span starts count from.
    first: Instant,
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
    deadline: Option<Instant>,
    /// Messages waiting for a visible chat reply to be delivered.
    queued: Vec<Msg>,
    running: Option<Running>,
    /// Reactions that answered before their turn was recorded: (receipt, ms), `None` = failed.
    acks: HashMap<String, Option<(Instant, u32)>>,
    /// Recorded turns whose reaction has not answered yet, by message id.
    late: HashMap<String, TurnMeta>,
    /// Dropped (cancelled) messages whose reaction has not answered yet; it is ignored.
    gone: HashSet<String>,
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
            gone: HashSet::new(),
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
                    Some(ToActor::Acked { msg, rec, ms, ok }) => self.acked(msg, rec, ms, ok),
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
                self.deadline = Some(at);
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
            let end = r.handle.await;
            if let Ok(TurnEnd::Cancelled { drafted }) = &end {
                // After a `Restart` nothing may be left to keep.
                if !drafted.trim().is_empty() {
                    let kept = format!("{}…", drafted.trim_end());
                    if let Err(e) = self.ch.send(&self.chat, &plain(&kept)).await {
                        tracing::warn!("gateway: keeping the draft failed: {e}");
                    }
                }
                let _ = self.ch.draft(&self.chat, None).await;
            }
            self.finished(r.msgs, end);
            self.start(vec![msg]);
        } else {
            self.queued.push(msg);
        }
    }

    async fn stop(&mut self, msg: Msg) {
        if let Some(r) = self.running.take() {
            r.cancel.cancel();
            let end = r.handle.await;
            let delivered = matches!(end, Ok(TurnEnd::Finished { .. }));
            self.finished(r.msgs, end);
            if !delivered {
                let _ = self.ch.draft(&self.chat, None).await;
            }
        }
        self.deadline = None;
        let dropped: Vec<Msg> = self.window.drain(..).chain(self.queued.drain(..)).collect();
        delete_files(&dropped);
        self.forget(&dropped);
        self.command(msg, "Stopped.").await;
    }

    /// Answers a command the gateway handles itself, and records it as a `command` turn.
    async fn command(&mut self, msg: Msg, reply: &str) {
        let t = Instant::now();
        if let Err(e) = self.ch.send(&self.chat, &plain(reply)).await {
            tracing::warn!("gateway: command reply failed: {e}");
        }
        let spans = vec![Span {
            name: "deliver",
            start: offset(msg.rec.instant, t),
            ms: ms_since(t),
        }];
        delete_files(std::slice::from_ref(&msg));
        self.record(&[msg], Lane::Command, spans);
    }

    fn acked(&mut self, msg: String, rec: Instant, ms: u32, ok: bool) {
        if let Some(meta) = self.late.remove(&msg) {
            if ok {
                let row = row(&meta, "ack", offset(meta.first, rec), ms as i64);
                if let Err(e) = self.g.store.record_spans(&[row]) {
                    tracing::error!("gateway: recording a span: {e}");
                }
            }
        } else if !self.gone.remove(&msg) {
            self.acks.insert(msg, ok.then_some((rec, ms)));
        }
    }

    /// Messages dropped without a recorded turn: their reactions are not kept.
    fn forget(&mut self, msgs: &[Msg]) {
        for m in msgs {
            if self.acks.remove(&m.inbound.msg.id).is_none() {
                self.gone.insert(m.inbound.msg.id.clone());
            }
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
                self.forget(&msgs);
                let (ch, chat) = (self.ch.clone(), self.chat.clone());
                self.g
                    .tracker
                    .spawn(async move { ch.send(&chat, &plain(SORRY)).await });
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
            // Off the tracker on purpose: the actor awaits this handle on cancel.
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
            Ok(TurnEnd::Cancelled { .. }) => self.forget(&msgs),
            Err(e) => {
                tracing::error!("gateway: a turn panicked: {e}");
                self.forget(&msgs);
            }
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
            first: first.rec.instant,
            origin: serde_json::to_string(&origin(self.ch.name(), &self.chat)).unwrap_or_default(),
            lane: lane_name(lane).to_string(),
        };
        for m in msgs {
            match self.acks.remove(&m.inbound.msg.id) {
                Some(Some((rec, ms))) => spans.push(Span {
                    name: "ack",
                    start: offset(meta.first, rec),
                    ms,
                }),
                Some(None) => {}
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

async fn wait(deadline: Option<Instant>) {
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
        let off = |t: Instant| offset(self.first.instant, t);
        let hear_t = Instant::now();
        let inbound = tokio::select! {
            _ = self.cancel.cancelled() => return TurnEnd::Cancelled { drafted: String::new() },
            i = voice::hear(&*g.media, self.inbound.clone()) => i,
        };
        if voiced {
            spans.push(Span {
                name: "hear",
                start: off(hear_t),
                ms: ms_since(hear_t),
            });
        }

        let turn = alexia_core::Turn {
            session: self.session,
            origin: origin.clone(),
            content: inbound.content.clone(),
            received_at: self.first.ms,
        };
        spans.push(Span {
            name: "merge",
            start: 0,
            ms: ms_since(self.first.instant),
        });
        g.bus.publish(Event::Received {
            at: now_ms(),
            origin,
            session: self.session,
        });

        let brain_t = Instant::now();
        let brain_start = off(brain_t);
        let (tx, frames) = mpsc::channel(64);
        // Its own task: a slow draft call never stalls the brain, and on cancel the brain keeps
        // running until it has stopped its own work (the v2 bridge POSTs /api/stop).
        let (brain, cancel) = (g.brain.clone(), self.cancel.clone());
        // Off the tracker on purpose: the pump aborts it 3 s after cancel.
        let handle = tokio::spawn(async move { brain.reply(turn, tx, cancel).await });
        let mut pump = Pump::new(&self, frames);
        let result = pump.run(handle).await;
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
            let t = Instant::now();
            let note = voice::speak(&*g.media, &reply.text).await;
            spans.push(Span {
                name: "speak",
                start: off(t),
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
        let t = Instant::now();
        let sent = self.ch.send(&self.chat, &out).await;
        spans.push(Span {
            name: "deliver",
            start: offset(self.first.instant, t),
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
    tracker: TaskTracker,
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
            tracker: t.g.tracker.clone(),
        }
    }

    async fn run(
        &mut self,
        mut brain: JoinHandle<std::result::Result<alexia_core::Reply, BrainError>>,
    ) -> std::result::Result<alexia_core::Reply, BrainError> {
        let mut open = true;
        let mut typing_at = Instant::now();
        // Set once cancelled: how long the brain gets to stop by itself.
        let mut give_up: Option<Instant> = None;
        loop {
            let next = if give_up.is_none() {
                self.next_at()
            } else {
                None
            };
            tokio::select! {
                biased;
                r = &mut brain => {
                    if give_up.is_some() {
                        return Err(BrainError::Cancelled);
                    }
                    return r.unwrap_or_else(|e| {
                        tracing::error!("gateway: the brain panicked: {e}");
                        Err(BrainError::Unavailable(SORRY.to_string()))
                    });
                }
                _ = self.cancel.cancelled(), if give_up.is_none() => {
                    give_up = Some(Instant::now() + SHUTDOWN_WAIT);
                }
                _ = wait(give_up) => {
                    tracing::warn!("gateway: the brain did not stop within 3 s");
                    brain.abort();
                    return Err(BrainError::Cancelled);
                }
                _ = sleep_until(typing_at), if !self.shown && give_up.is_none() => {
                    let (ch, chat) = (self.ch.clone(), self.chat.clone());
                    self.tracker.spawn(async move { ch.typing(&chat).await });
                    typing_at += TYPING_EVERY;
                }
                f = self.frames.recv(), if open => match f {
                    Some(f) => self.frame(f),
                    None => open = false,
                },
                _ = wait(next) => self.send().await,
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

    struct Quiet;

    #[async_trait::async_trait]
    impl Channel for Quiet {
        fn name(&self) -> &'static str {
            "quiet"
        }
        fn budget(&self) -> alexia_core::Budget {
            alexia_core::Budget::CHAT
        }
        async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>> {
            cancel.cancelled().await;
            Err(Error::Cancelled)
        }
        async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
            Ok(())
        }
        async fn typing(&self, _: &ChatRef) -> Result<()> {
            Ok(())
        }
        async fn send(&self, _: &ChatRef, _: &Outbound) -> Result<MsgRef> {
            Ok(MsgRef { id: "s".into() })
        }
        async fn draft(&self, _: &ChatRef, _: Option<&str>) -> Result<()> {
            Ok(())
        }
        async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
            Ok(())
        }
        async fn ask(&self, _: &ChatRef, _: &str, _: CancellationToken) -> Result<Option<bool>> {
            Ok(None)
        }
    }

    #[async_trait::async_trait]
    impl Media for Quiet {
        async fn transcribe(&self, _: &InFile) -> Result<Option<String>> {
            Ok(None)
        }
        async fn speak(&self, _: &str) -> Result<Option<alexia_core::OutFile>> {
            Ok(None)
        }
    }

    /// Uses a tool, writes, then waits to be cancelled.
    struct Busy;

    #[async_trait::async_trait]
    impl Brain for Busy {
        async fn reply(
            &self,
            _: alexia_core::Turn,
            draft: alexia_core::DraftSink,
            cancel: CancellationToken,
        ) -> std::result::Result<alexia_core::Reply, BrainError> {
            let _ = draft.send(DraftFrame::Phase(Phase::Tool)).await;
            let _ = draft.send(DraftFrame::Delta("x".into())).await;
            cancel.cancelled().await;
            Err(BrainError::Cancelled)
        }
    }

    fn said(id: &str, text: &str) -> Msg {
        let mut m = msg(Content::Text(text.into()), None);
        m.inbound.msg.id = id.into();
        m
    }

    async fn until_visible(a: &Actor) {
        let r = a.running.as_ref().expect("running");
        for _ in 0..3_000 {
            if r.visible.load(Ordering::SeqCst) && r.tasky.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the draft never became visible");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn acks_are_dropped_after_a_steer_and_a_stop() {
        let g = Arc::new(Shared {
            cfg: GatewayConfig::default(),
            store: Arc::new(Store::open_in_memory().unwrap()),
            bus: Bus::new(16),
            brain: Arc::new(Busy),
            media: Arc::new(Quiet),
            tracker: TaskTracker::new(),
        });
        let chat = ChatRef { chat: "1".into() };
        let mut a = Actor::new(g, Arc::new(Quiet), chat, CancellationToken::new());
        let now = Instant::now();

        // Steer: the reaction to "1" answered before its turn was cancelled.
        a.acked("1".into(), now, 3, true);
        a.start(vec![said("1", "go")]);
        until_visible(&a).await;
        a.inbound(said("2", "steer")).await;
        assert!(a.acks.is_empty() && a.gone.is_empty());

        // Stop: "2"'s reaction answers after its turn is gone and is ignored.
        until_visible(&a).await;
        a.inbound(said("3", "/stop")).await;
        a.acked("2".into(), now, 3, true);
        a.acked("3".into(), now, 3, true);
        assert!(a.acks.is_empty() && a.gone.is_empty() && a.late.is_empty());
    }
}
