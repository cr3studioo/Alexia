// SPDX-License-Identifier: AGPL-3.0-only
//! The gateway loop: ack, merge, steer, drafts, spans (CH-03, CH-04, CH-08, CH-09, SP-09, SP-14).
//!
//! One poll task per channel fires the reaction and hands each message to its chat's actor. The
//! actor owns that chat's state (merge window, running turn, queue) and talks to its turn task
//! over channels. The turn task runs the brain, pumps drafts and delivers; the actor records.
//!
//! P4-33 (TR-11): a guest's chat has an actor and a session of its own, kept apart from the
//! owner's: it never joins a handoff, never moves `current_session`, and nothing unprompted
//! (a `Say`, a notice, the followed face) is ever sent to it.

use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use alexia_core::permissions::guest_of;
use alexia_core::{
    ms_since, Brain, BrainError, Bus, DraftFrame, Event, Lane, Origin, Phase, Span, Steer, Urgency,
    Verdict,
};
use alexia_store::{now_ms, Content, Ms, Part, SessionId, SpanRow, Store};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::ask::ChannelSet;
use crate::{
    voice, Channel, ChatRef, Error, GatewayConfig, InFile, InKind, Inbound, Media, MsgRef,
    Outbound, Result,
};

const SORRY: &str = "Something went wrong on my side. I've noted it.";
const HELP: &str =
    "/stop — stop what I'm doing\n/new — start a new conversation\n/help — this list";
const TYPING_EVERY: Duration = Duration::from_secs(4);
const DRAFT_CAP_MS: u64 = 2_000;
/// How many steer messages can wait for the brain before the old cancel path takes over.
const STEER_CAP: usize = 32;
const SHUTDOWN_WAIT: Duration = Duration::from_secs(3);

/// Where the owner is now, as an origin to deliver to (`Origin::Channel { channel, chat }`,
/// e.g. `{ "device", "<device id>" }` or `{ "telegram", "<chat>" }`), or None to deliver as before.
pub type Follow = Arc<dyn Fn() -> Option<Origin> + Send + Sync>;

/// A message from another face of the owner within this long of the last one continues the
/// same conversation (HB-04, D-P4-8).
pub const HANDOFF_MS: i64 = 30 * 60 * 1000;

/// The channel the hub registers for the owner's devices; each of its chats is a device id.
const DEVICE: &str = "device";

/// The owner's window as a face (`Origin::Window`): this channel name, and its one chat.
const WINDOW: &str = "window";
const WINDOW_CHAT: &str = "main";

/// A chat on a channel: (channel name, chat).
type Key = (&'static str, String);

/// Who answers where, and where the owner was last heard. In memory only.
#[derive(Default)]
struct Routes {
    /// The actor answering each chat. A handoff moves an actor to the chat the owner moved to.
    actors: HashMap<Key, Answering>,
    /// Each guest chat's actor. Apart from `actors`, so no handoff or `moved_to` can find one.
    guests: HashMap<Key, mpsc::UnboundedSender<ToActor>>,
    /// The chat of the owner's last turn, and when it was.
    last: Option<(Key, Ms)>,
    /// Set by `run`, so `moved_to` can start an actor. Weak: `Shared` holds this table.
    live: Option<(Weak<Shared>, CancellationToken)>,
    /// How many actors have been started: the next one's id.
    started: u64,
}

/// One chat's actor, as the table knows it.
struct Answering {
    id: u64,
    tx: mpsc::UnboundedSender<ToActor>,
    /// The session it answers in; `None` until it has read its first message.
    session: Option<SessionId>,
}

impl Routes {
    /// Starts an actor for `chat` and puts it in the table, in place of any other there.
    /// `joined` is a session it takes over; `None` = the chat's own.
    fn start(
        &mut self,
        g: &Arc<Shared>,
        ch: Arc<dyn Channel>,
        chat: ChatRef,
        joined: Option<SessionId>,
        cancel: &CancellationToken,
    ) -> mpsc::UnboundedSender<ToActor> {
        let (tx, rx) = mpsc::unbounded_channel();
        let key: Key = (ch.name(), chat.chat.clone());
        self.started += 1;
        let mut actor = Actor::new(g.clone(), ch, chat, cancel.clone());
        actor.id = self.started;
        actor.joined = joined;
        g.tracker.spawn(actor.run(rx));
        let entry = Answering {
            id: self.started,
            tx: tx.clone(),
            session: joined,
        };
        self.actors.insert(key, entry);
        tx
    }
}

/// Where a turn's words go: the face the owner is on now. The actor moves it on a handoff.
#[derive(Clone)]
struct Face(Arc<Mutex<(Arc<dyn Channel>, ChatRef)>>);

impl Face {
    fn new(ch: Arc<dyn Channel>, chat: ChatRef) -> Face {
        Face(Arc::new(Mutex::new((ch, chat))))
    }
    fn get(&self) -> (Arc<dyn Channel>, ChatRef) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn set(&self, ch: Arc<dyn Channel>, chat: ChatRef) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = (ch, chat);
    }
}

/// What the owner calls a face: the channel, or the device id for "device".
fn face_name(channel: &str, chat: &str) -> String {
    if channel == DEVICE {
        chat.to_string()
    } else {
        channel.to_string()
    }
}

/// A clone is a handle on the same gateway: the hub keeps one to ask where the owner is
/// (`current_session`, `moved_to`) while `run` consumes another.
#[derive(Clone)]
pub struct Gateway {
    cfg: GatewayConfig,
    store: Arc<Store>,
    bus: Bus,
    brain: Arc<dyn Brain>,
    media: Arc<dyn Media>,
    channels: ChannelSet,
    follow: Arc<Mutex<Option<Follow>>>,
    routes: Arc<Mutex<Routes>>,
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
    follow: Arc<Mutex<Option<Follow>>>,
    routes: Arc<Mutex<Routes>>,
}

impl Gateway {
    /// The P2 constructor: the set (and the asker built on it) exist before the gateway.
    pub fn with_channels(
        cfg: GatewayConfig,
        store: Arc<Store>,
        bus: Bus,
        brain: Arc<dyn Brain>,
        media: Arc<dyn Media>,
        channels: ChannelSet,
    ) -> Gateway {
        Gateway {
            cfg,
            store,
            bus,
            brain,
            media,
            channels,
            follow: Arc::new(Mutex::new(None)),
            routes: Arc::default(),
        }
    }

    /// The owner's conversation of the last `within_ms`, if any: its session and the face it is on.
    pub fn current_session(&self, within_ms: i64) -> Option<(SessionId, Origin)> {
        let routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        let (key, at) = routes.last.as_ref()?;
        if now_ms().saturating_sub(*at) > within_ms {
            return None;
        }
        let session = routes.actors.get(key)?.session?;
        let chat = ChatRef {
            chat: key.1.clone(),
        };
        Some((session, origin(key.0, &chat)))
    }

    /// The owner wrote into `session` from `origin`: that session now continues there, as after
    /// a handoff between channels. A turn in flight delivers to the new face, and the old one is
    /// told "Continued on <face>.". Does nothing unless `run` is running, or when `origin` is
    /// neither the window nor a configured channel.
    pub fn moved_to(&self, session: SessionId, origin: Origin) {
        let channels = self.channels.all();
        let named = |name: &str| channels.iter().find(|c| c.name() == name).cloned();
        let face = match origin {
            // No channel shows the window: what is delivered there stays in the session.
            Origin::Window => {
                let ch = named(WINDOW).unwrap_or_else(|| Arc::new(Unshown));
                let chat = ChatRef {
                    chat: WINDOW_CHAT.to_string(),
                };
                Some((ch, chat))
            }
            Origin::Channel { channel, chat } => named(&channel).map(|ch| (ch, ChatRef { chat })),
            Origin::Desktop | Origin::Scheduler { .. } => None,
        };
        let Some((ch, chat)) = face else {
            tracing::warn!("gateway: moved_to: not a face the gateway knows");
            return;
        };
        let key: Key = (ch.name(), chat.chat.clone());
        let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        let running = routes
            .live
            .as_ref()
            .filter(|(_, cancel)| !cancel.is_cancelled())
            .and_then(|(g, cancel)| Some((g.upgrade()?, cancel.clone())));
        let Some((g, cancel)) = running else {
            tracing::warn!("gateway: moved_to: the gateway is not running");
            return;
        };
        let was = routes.last.replace((key.clone(), now_ms())).map(|l| l.0);
        // The actor holding the session: the one the owner was last on, else the one already
        // on the new face, else any.
        let holds = |k: &Key| {
            routes
                .actors
                .get(k)
                .is_some_and(|a| a.session == Some(session) && !a.tx.is_closed())
        };
        let holder = was
            .filter(holds)
            .or_else(|| Some(key.clone()).filter(holds))
            .or_else(|| routes.actors.keys().find(|k| holds(k)).cloned());
        match holder.and_then(|k| routes.actors.remove(&k)) {
            Some(actor) => {
                if actor.tx.send(ToActor::Move { ch, chat }).is_err() {
                    tracing::warn!("gateway: a chat actor is gone");
                }
                // An actor this displaces finishes what it has and ends.
                routes.actors.insert(key, actor);
            }
            None => {
                routes.start(&g, ch, chat, Some(session), &cancel);
            }
        }
    }

    /// Asks `follow` where the owner is before saying something unprompted (HB-06).
    pub fn set_follow(&self, follow: Follow) {
        *self.follow.lock().unwrap_or_else(|e| e.into_inner()) = Some(follow);
    }

    pub fn add(&mut self, channel: Arc<dyn Channel>) {
        self.channels.add(channel);
    }

    /// Runs until `cancel`, then stops polling, cancels running turns and waits at most 3 s.
    pub async fn run(self, cancel: CancellationToken) -> Result<()> {
        let says = self.bus.subscribe();
        let channels = self.channels.all();
        let tracker = TaskTracker::new();
        let g = Arc::new(Shared {
            cfg: self.cfg,
            store: self.store,
            bus: self.bus,
            brain: self.brain,
            media: self.media,
            tracker: tracker.clone(),
            follow: self.follow,
            routes: self.routes,
        });
        g.routes.lock().unwrap_or_else(|e| e.into_inner()).live =
            Some((Arc::downgrade(&g), cancel.clone()));
        for ch in &channels {
            tracker.spawn(poll(g.clone(), ch.clone(), cancel.clone()));
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
    /// The channel it came in on.
    ch: Arc<dyn Channel>,
    inbound: Inbound,
    rec: Received,
    /// The owner is back from another face after more than `HANDOFF_MS`: this chat returns to
    /// its own session.
    own_session: bool,
}

enum ToActor {
    In(Msg),
    /// `moved_to`: the owner took this conversation to another face.
    Move {
        ch: Arc<dyn Channel>,
        chat: ChatRef,
    },
    /// A reaction answered: `ms` = receipt → answer. `ok == false` = it failed (no span).
    Acked {
        msg: String,
        rec: Instant,
        ms: u32,
        ok: bool,
    },
}

// ---- poll ----

async fn poll(g: Arc<Shared>, ch: Arc<dyn Channel>, cancel: CancellationToken) {
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
                // P4-33: only a chat positively known as a guest's is heard; anyone else is not.
                if inbound.kind == InKind::Message
                    && inbound.button.is_none()
                    && guest_chat(&g.store, ch.name(), &inbound.chat)
                {
                    let (chat, msg) = (inbound.chat.clone(), inbound.msg.clone());
                    let msg_in = Msg {
                        ch: ch.clone(),
                        inbound,
                        rec,
                        own_session: false,
                    };
                    let tx = route_guest(&g, msg_in, &cancel);
                    spawn_ack(&g, &ch, chat, msg, rec, tx);
                }
                continue;
            }
            // ME-17: any word from the owner, on any channel, is a sign they are up.
            g.bus.publish(Event::Active {
                at: now_ms(),
                via: ch.name().to_string(),
            });
            if let Some((notice, verb)) = notice_answer(&g.store, ch.name(), &inbound) {
                let (g, ch) = (g.clone(), ch.clone());
                let reply = inbound.button.is_none();
                g.tracker.clone().spawn(async move {
                    answer_notice(&g, &*ch, &inbound, notice, verb, reply).await;
                });
                continue;
            }
            if inbound.button.is_some() {
                // A button this gateway does not know: nothing to answer, and never a turn.
                continue;
            }
            let (chat, msg) = (inbound.chat.clone(), inbound.msg.clone());
            let msg_in = Msg {
                ch: ch.clone(),
                inbound,
                rec,
                own_session: false,
            };
            let tx = route(&g, msg_in, &cancel);
            spawn_ack(&g, &ch, chat, msg, rec, tx);
        }
    }
}

/// Hands a message to the actor that answers its chat, and returns that actor.
///
/// HB-04: a message from another face of the owner within `HANDOFF_MS` of the last one takes the
/// conversation with it: the actor holding it moves to this chat. Otherwise every chat has its
/// own actor and session.
fn route(
    g: &Arc<Shared>,
    mut msg: Msg,
    cancel: &CancellationToken,
) -> mpsc::UnboundedSender<ToActor> {
    let at = match msg.inbound.at {
        at if at > 0 => at,
        _ => msg.rec.ms,
    };
    let key: Key = (msg.ch.name(), msg.inbound.chat.chat.clone());
    // Held until the message is sent, so an actor hears its messages in the order they moved it.
    let mut routes = g.routes.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((from, then)) = routes.last.replace((key.clone(), at)) {
        if face_name(from.0, &from.1) != face_name(key.0, &key.1) {
            if at.saturating_sub(then) > HANDOFF_MS {
                msg.own_session = true;
            } else if let Some(actor) = routes.actors.remove(&from) {
                // An actor this displaces finishes what it has and ends.
                routes.actors.insert(key.clone(), actor);
            }
        }
    }
    let tx = match routes.actors.get(&key) {
        Some(a) if !a.tx.is_closed() => a.tx.clone(),
        _ => {
            let chat = msg.inbound.chat.clone();
            routes.start(g, msg.ch.clone(), chat, None, cancel)
        }
    };
    if tx.send(ToActor::In(msg)).is_err() {
        tracing::warn!("gateway: a chat actor is gone");
    }
    tx
}

/// A guest's message: to that chat's own actor, which answers in that chat's own session. Not
/// `route`: a guest never moves the owner's conversation, `last` or the followed face.
fn route_guest(
    g: &Arc<Shared>,
    msg: Msg,
    cancel: &CancellationToken,
) -> mpsc::UnboundedSender<ToActor> {
    let key: Key = (msg.ch.name(), msg.inbound.chat.chat.clone());
    let mut routes = g.routes.lock().unwrap_or_else(|e| e.into_inner());
    let tx = match routes.guests.get(&key) {
        Some(tx) if !tx.is_closed() => tx.clone(),
        _ => {
            let (tx, rx) = mpsc::unbounded_channel();
            routes.started += 1;
            let mut actor = Actor::new(
                g.clone(),
                msg.ch.clone(),
                msg.inbound.chat.clone(),
                cancel.clone(),
            );
            actor.id = routes.started;
            g.tracker.spawn(actor.run(rx));
            routes.guests.insert(key, tx.clone());
            tx
        }
    };
    if tx.send(ToActor::In(msg)).is_err() {
        tracing::warn!("gateway: a guest's chat actor is gone");
    }
    tx
}

/// The chat is a live guest's, and its channel already has a primary chat that is not it, so
/// the guest's session can never become the one Alexia speaks in unprompted. A store error is
/// not a guest.
fn guest_chat(store: &Store, channel: &str, chat: &ChatRef) -> bool {
    if guest_of(store, &origin(channel, chat)).is_none() {
        return false;
    }
    match store.primary_chat(channel) {
        Ok(Some(primary)) if primary != chat.chat => true,
        Ok(_) => {
            tracing::warn!(
                channel,
                "gateway: a guest wrote before the owner's chat was known"
            );
            false
        }
        Err(e) => {
            tracing::error!(channel, "gateway: primary chat: {e}");
            false
        }
    }
}

/// Nothing unprompted goes to this chat: it is a guest's, or that cannot be told (a store error
/// is a guest here, so a notice is never shown to one).
fn not_for_owner(store: &Store, channel: &str, chat: &str) -> bool {
    match store.guest_of(channel, chat) {
        Ok(g) => g.is_some(),
        Err(e) => {
            tracing::error!(channel, "gateway: guests could not be read: {e}");
            true
        }
    }
}

/// CH-03: the reaction, in its own task, so nothing here waits on the service.
fn spawn_ack(
    g: &Arc<Shared>,
    ch: &Arc<dyn Channel>,
    chat: ChatRef,
    msg: MsgRef,
    rec: Received,
    tx: mpsc::UnboundedSender<ToActor>,
) {
    let (g, ch) = (g.clone(), ch.clone());
    let tracker = g.tracker.clone();
    tracker.spawn(async move {
        let r = ch.react(&chat, &msg, &g.cfg.ack_emoji).await;
        let ms = ms_since(rec.instant.into_std());
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
    if channel == WINDOW {
        return Origin::Window;
    }
    Origin::Channel {
        channel: channel.to_string(),
        chat: chat.chat.clone(),
    }
}

/// The window's face when no "window" channel is registered. It shows nothing: the window reads
/// the conversation from its session.
struct Unshown;

#[async_trait::async_trait]
impl Channel for Unshown {
    fn name(&self) -> &'static str {
        WINDOW
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
        Ok(MsgRef { id: String::new() })
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

// ---- say ----

/// The kv namespace and key prefix that map a notice's chat message back to the notice.
const CORE: &str = "_core";
const NOTICE_MSG: &str = "notice_msg";
const NOTICE_MSG_INDEX: &str = "notice_msg_index";
const NOTICE_MSG_KEEP: usize = 500;
/// "Later" brings a notice back after this long.
const LATER_MS: Ms = 3 * 60 * 60 * 1000;

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
        let Event::Say {
            text,
            urgency,
            notice,
            to,
            ..
        } = &*ev
        else {
            continue;
        };
        let text = match urgency {
            Urgency::Urgent => format!("‼️ {text}"),
            Urgency::High => format!("❗ {text}"),
            Urgency::Low | Urgency::Normal => text.clone(),
        };
        let buttons = notice.map(|id| (id, notice_buttons(&g.store, id)));
        // HB-06: unprompted words go where the owner is.
        let followed = match to {
            None => followed_face(&g, &channels),
            Some(_) => None,
        };
        // The urgent copies already out, so a fallback does not repeat them.
        let mut reached: Vec<Key> = Vec::new();
        if let Some((ch, chat)) = followed {
            let there = say_to(&g, &*ch, &chat, &text, &buttons).await;
            if *urgency == Urgency::Urgent {
                // Urgent ones also reach the messenger (Telegram): the primary chat of every
                // channel that is not a device.
                for (m, primary) in say_targets(&g.store, &channels, None) {
                    if m.name() == DEVICE || (m.name() == ch.name() && primary == chat) {
                        continue;
                    }
                    if say_to(&g, &*m, &primary, &text, &buttons).await {
                        reached.push((m.name(), primary.chat));
                    }
                }
            }
            if there {
                continue;
            }
            // The followed face did not take it: deliver as before.
        }
        for (ch, chat) in say_targets(&g.store, &channels, to.as_ref()) {
            let had_it = reached
                .iter()
                .any(|(name, c)| *name == ch.name() && *c == chat.chat);
            if !had_it {
                say_to(&g, &*ch, &chat, &text, &buttons).await;
            }
        }
    }
}

/// The channel and chat `follow` names, when that channel is configured. Otherwise the window,
/// when the conversation moved there within `HANDOFF_MS` and a "window" channel can show it.
fn followed_face(g: &Shared, channels: &[Arc<dyn Channel>]) -> Option<(Arc<dyn Channel>, ChatRef)> {
    let named = |name: &str| channels.iter().find(|c| c.name() == name).cloned();
    let follow = g.follow.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(Origin::Channel { channel, chat }) = follow.and_then(|f| f()) {
        if let Some(ch) = named(&channel) {
            return Some((ch, ChatRef { chat }));
        }
    }
    let routes = g.routes.lock().unwrap_or_else(|e| e.into_inner());
    let ((channel, chat), at) = routes.last.as_ref()?;
    if *channel != WINDOW || now_ms().saturating_sub(*at) > HANDOFF_MS {
        return None;
    }
    Some((named(WINDOW)?, ChatRef { chat: chat.clone() }))
}

/// Says `text` in one chat, with the notice's buttons where the channel has them.
async fn say_to(
    g: &Shared,
    ch: &dyn Channel,
    chat: &ChatRef,
    text: &str,
    buttons: &Option<(i64, Vec<(String, String)>)>,
) -> bool {
    // P4-33: never a guest, whoever named the chat (`to`, `follow`, a primary).
    if not_for_owner(&g.store, ch.name(), &chat.chat) {
        return false;
    }
    let sent = match buttons {
        Some((id, b)) => ch.notify(chat, text, b).await.map(|m| Some((m, *id))),
        None => ch.send(chat, &plain(text)).await.map(|_| None),
    };
    match sent {
        Ok(Some((msg, id))) => {
            remember(&g.store, ch.name(), &chat.chat, &msg.id, id);
            true
        }
        Ok(None) => true,
        Err(e) => {
            tracing::warn!(channel = ch.name(), "gateway: say failed: {e}");
            false
        }
    }
}

/// Where a `Say` goes: the chat it names when that channel is configured, else every
/// channel's primary chat (`Window` and `Desktop` show nothing unprompted in P3).
fn say_targets(
    store: &Store,
    channels: &[Arc<dyn Channel>],
    to: Option<&Origin>,
) -> Vec<(Arc<dyn Channel>, ChatRef)> {
    if let Some(Origin::Channel { channel, chat }) = to {
        if let Some(ch) = channels.iter().find(|c| c.name() == channel) {
            return vec![(ch.clone(), ChatRef { chat: chat.clone() })];
        }
    }
    let mut out = Vec::new();
    for ch in channels {
        match store.primary_chat(ch.name()) {
            Ok(Some(chat)) => out.push((ch.clone(), ChatRef { chat })),
            Ok(None) => {}
            Err(e) => tracing::error!(channel = ch.name(), "gateway: primary chat: {e}"),
        }
    }
    out
}

/// Thanks / Not useful / Later / Why?, and Done when it is something to do (not a pattern).
fn notice_buttons(store: &Store, id: i64) -> Vec<(String, String)> {
    let button = |label: &str, verb: &str| (label.to_string(), format!("n:{id}:{verb}"));
    let mut row = vec![
        button("Thanks", "useful"),
        button("Not useful", "not"),
        button("Later", "later"),
        button("Why?", "why"),
    ];
    match store.notice(id) {
        Ok(Some(n)) if n.source != "pattern" => row.push(button("Done", "done")),
        Ok(_) => {}
        Err(e) => tracing::warn!("gateway: reading notice {id}: {e}"),
    }
    row
}

/// Remembers which notice a chat message carries; only the newest 500 are kept.
fn remember(store: &Store, channel: &str, chat: &str, msg: &str, notice: i64) {
    let key = format!("{NOTICE_MSG}.{channel}.{chat}.{msg}");
    let mut dropped: Vec<String> = Vec::new();
    let r = store
        .kv_set(CORE, &key, &serde_json::json!(notice))
        .and_then(|()| {
            store.kv_update(CORE, NOTICE_MSG_INDEX, |cur| {
                let mut keys: Vec<String> = cur
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                keys.retain(|k| *k != key);
                keys.push(key.clone());
                if keys.len() > NOTICE_MSG_KEEP {
                    let extra = keys.len() - NOTICE_MSG_KEEP;
                    dropped = keys.drain(..extra).collect();
                }
                Some(serde_json::json!(keys))
            })
        });
    if let Err(e) = r {
        tracing::warn!("gateway: remembering a notice message: {e}");
        return;
    }
    for k in dropped {
        if let Err(e) = store.kv_delete(CORE, &k) {
            tracing::warn!("gateway: forgetting a notice message: {e}");
        }
    }
}

// ---- notice feedback ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verb {
    Seen,
    Useful,
    Not,
    Later,
    Why,
    Done,
    Mute,
}

/// A button's `n:<notice id>:<verb>`.
fn parse_button(data: &str) -> Option<(i64, Verb)> {
    let mut it = data.split(':');
    let (Some("n"), Some(id), Some(verb), None) = (it.next(), it.next(), it.next(), it.next())
    else {
        return None;
    };
    let verb = match verb {
        "seen" => Verb::Seen,
        "useful" => Verb::Useful,
        "not" => Verb::Not,
        "later" => Verb::Later,
        "why" => Verb::Why,
        "done" => Verb::Done,
        _ => return None,
    };
    Some((id.parse().ok()?, verb))
}

/// A short reply that is itself the answer (case-insensitive, trimmed).
fn parse_reply(text: &str) -> Option<Verb> {
    Some(match text.trim().to_lowercase().as_str() {
        "done" | "hotovo" => Verb::Done,
        "later" | "not now" | "později" => Verb::Later,
        "stop" | "stop these" => Verb::Mute,
        "thanks" | "díky" => Verb::Useful,
        _ => return None,
    })
}

/// The notice and verb this inbound answers: a notice button, or a one-word reply to a
/// remembered notice message. Anything else is not feedback.
fn notice_answer(store: &Store, channel: &str, inbound: &Inbound) -> Option<(i64, Verb)> {
    if let Some(data) = &inbound.button {
        return parse_button(data);
    }
    let reply = inbound.reply_to.as_ref()?;
    let Content::Text(text) = &inbound.content else {
        return None;
    };
    let verb = parse_reply(text)?;
    let key = format!("{NOTICE_MSG}.{channel}.{}.{}", inbound.chat.chat, reply.id);
    match store.kv_get(CORE, &key) {
        Ok(Some(v)) => Some((v.as_i64()?, verb)),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("gateway: reading a notice message: {e}");
            None
        }
    }
}

/// "14:05 UTC": the gateway has no time zone of its own.
fn clock(at: Ms) -> String {
    let minutes = at.div_euclid(60_000);
    format!(
        "{:02}:{:02} UTC",
        minutes.div_euclid(60).rem_euclid(24),
        minutes.rem_euclid(60)
    )
}

async fn answer_notice(
    g: &Shared,
    ch: &dyn Channel,
    inbound: &Inbound,
    notice: i64,
    verb: Verb,
    reply: bool,
) {
    let at = now_ms();
    let verdict = match verb {
        Verb::Seen | Verb::Why => Verdict::Seen,
        Verb::Useful => Verdict::Useful,
        Verb::Not => Verdict::NotUseful,
        Verb::Later => Verdict::Later {
            until: at + LATER_MS,
        },
        Verb::Done => Verdict::Done,
        Verb::Mute => Verdict::Mute,
    };
    g.bus.publish(Event::Feedback {
        at,
        notice,
        verdict,
    });
    let say = match (verb, verdict) {
        (Verb::Why, _) => Some(match g.store.notice(notice) {
            Ok(Some(n)) if !n.why.trim().is_empty() => n.why,
            Ok(_) => "I don't have a reason noted for that one.".to_string(),
            Err(e) => {
                tracing::warn!("gateway: reading notice {notice}: {e}");
                "I couldn't look that up just now.".to_string()
            }
        }),
        (_, Verdict::Later { until }) => {
            Some(format!("I'll bring it up again at {}.", clock(until)))
        }
        _ => None,
    };
    if let Some(text) = say {
        if let Err(e) = ch.send(&inbound.chat, &plain(&text)).await {
            tracing::warn!(
                channel = ch.name(),
                "gateway: answering a notice failed: {e}"
            );
        }
    }
    if reply {
        if let Err(e) = ch.react(&inbound.chat, &inbound.msg, "👍").await {
            tracing::warn!(channel = ch.name(), "gateway: reaction failed: {e}");
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
    /// The turn's messages; steered ones are appended, `steered` counts them.
    msgs: Vec<Msg>,
    /// The brain said it reads `turn.steer` (`DraftFrame::Steerable`).
    steerable: Arc<AtomicBool>,
    steer_tx: mpsc::Sender<Content>,
    /// Shares the turn's receiver, so what the brain left can be drained once it has ended.
    steer: Steer,
    steered: usize,
    /// Where this turn's words go; moved when the owner moves to another face.
    face: Face,
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
    /// Which entry of the routing table is this actor.
    id: u64,
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
    /// The session a handoff brought here; `None` = the chat's own.
    joined: Option<SessionId>,
}

impl Actor {
    fn new(
        g: Arc<Shared>,
        ch: Arc<dyn Channel>,
        chat: ChatRef,
        cancel: CancellationToken,
    ) -> Actor {
        Actor {
            id: 0,
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
            joined: None,
        }
    }

    /// The session the next turn belongs to.
    fn session(&self) -> alexia_store::Result<SessionId> {
        match self.joined {
            Some(s) => Ok(s),
            None => self
                .g
                .store
                .channel_session(self.ch.name(), &self.chat.chat),
        }
    }

    /// Tells the routing table which session this actor answers in now.
    fn note_session(&self) {
        let session = match self.session() {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("gateway: channel session: {e}");
                return;
            }
        };
        let mut routes = self.g.routes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(a) = routes.actors.values_mut().find(|a| a.id == self.id) {
            a.session = Some(session);
        }
    }

    /// HB-04: the conversation moved to `ch`/`chat`. It brings its session; a turn still
    /// running now delivers there, and the face it left is told.
    fn move_to(&mut self, ch: Arc<dyn Channel>, chat: ChatRef) {
        if ch.name() == self.ch.name() && chat == self.chat {
            return;
        }
        match self.session() {
            Ok(s) => self.joined = Some(s),
            Err(e) => tracing::error!("gateway: channel session: {e}"),
        }
        let note = format!("Continued on {}.", face_name(ch.name(), &chat.chat));
        let old_ch = std::mem::replace(&mut self.ch, ch.clone());
        let old_chat = std::mem::replace(&mut self.chat, chat.clone());
        if let Some(r) = &self.running {
            r.face.set(ch, chat);
            // Its own task: the face the owner left may be slow to answer, or gone.
            self.g.tracker.spawn(async move {
                let _ = old_ch.draft(&old_chat, None).await;
                if let Err(e) = old_ch.send(&old_chat, &plain(&note)).await {
                    tracing::warn!("gateway: handoff note failed: {e}");
                }
            });
        }
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<ToActor>) {
        // Closed once another actor has taken this chat over; what is under way still finishes.
        let mut open = true;
        while open || self.running.is_some() || self.deadline.is_some() {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    if let Some(r) = self.running.take() {
                        r.cancel.cancel();
                        let _ = r.handle.await;
                    }
                    return;
                }
                m = rx.recv(), if open => match m {
                    Some(ToActor::In(msg)) => self.inbound(msg).await,
                    Some(ToActor::Move { ch, chat }) => {
                        self.move_to(ch, chat);
                        self.note_session();
                    }
                    Some(ToActor::Acked { msg, rec, ms, ok }) => self.acked(msg, rec, ms, ok),
                    None => open = false,
                },
                end = join(&mut self.running) => {
                    let r = self.running.take().expect("joined a running turn");
                    let mut msgs = r.msgs;
                    let mut next = Vec::new();
                    if matches!(end, Ok(TurnEnd::Finished { .. })) {
                        // What the brain never took becomes a turn: nothing is lost to the end.
                        next = unread_steers(&r.steer, r.steered, &mut msgs).await;
                    }
                    self.finished(msgs, end);
                    next.append(&mut self.queued);
                    self.start(next);
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
        if msg.own_session {
            self.joined = None;
        }
        self.move_to(msg.ch.clone(), msg.inbound.chat.clone());
        let text = match &msg.inbound.content {
            Content::Text(t) => t.trim().to_string(),
            Content::Parts(_) => String::new(),
        };
        if msg.inbound.kind == InKind::Stop || text == "/stop" {
            self.note_session();
            return self.stop(msg).await;
        }
        if text == "/new" || text == "/help" {
            let reply = if text == "/new" {
                match self
                    .g
                    .store
                    .new_channel_session(self.ch.name(), &self.chat.chat)
                {
                    Ok(_) => {
                        self.joined = None;
                        "New conversation."
                    }
                    Err(e) => {
                        tracing::error!("gateway: new session: {e}");
                        SORRY
                    }
                }
            } else {
                HELP
            };
            // Before the reply goes out: who sees it may ask for the current session.
            self.note_session();
            return self.command(msg, reply).await;
        }
        self.note_session();
        if let Some(r) = &mut self.running {
            // The run takes steering: hand the message over, do not cancel. Steering carries
            // `Content` only, so a message with files takes the normal path to keep them.
            if r.steerable.load(Ordering::SeqCst)
                && msg.inbound.files.is_empty()
                && r.steer_tx.try_send(msg.inbound.content.clone()).is_ok()
            {
                r.msgs.push(msg);
                r.steered += 1;
                return;
            }
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
                let mut unread = unread_steers(&r.steer, r.steered, &mut msgs).await;
                self.finished(msgs, end);
                msgs = std::mem::take(&mut unread);
            }
            msgs.push(msg);
            self.start(msgs);
        } else if running.tasky.load(Ordering::SeqCst) {
            // CH-08: steer. Keep what was written, then answer the new message.
            let r = self.running.take().expect("running");
            r.cancel.cancel();
            let end = r.handle.await;
            let mut msgs = r.msgs;
            // Steered messages the brain never read are not part of the cancelled turn.
            let mut next = unread_steers(&r.steer, r.steered, &mut msgs).await;
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
            self.finished(msgs, end);
            next.push(msg);
            self.start(next);
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
            ms: ms_since(t.into_std()),
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
        let session = match self.session() {
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
        let face = Face::new(self.ch.clone(), self.chat.clone());
        let cancel = self.cancel.child_token();
        let visible = Arc::new(AtomicBool::new(false));
        let tasky = Arc::new(AtomicBool::new(false));
        let steerable = Arc::new(AtomicBool::new(false));
        let (steer_tx, steer) = Steer::channel(STEER_CAP);
        let ctx = TurnCtx {
            g: self.g.clone(),
            ch: self.ch.clone(),
            chat: self.chat.clone(),
            inbound: merge(&msgs),
            first: msgs[0].rec,
            session,
            face: face.clone(),
            cancel: cancel.clone(),
            visible: visible.clone(),
            tasky: tasky.clone(),
            steerable: steerable.clone(),
            steer: steer.clone(),
        };
        self.running = Some(Running {
            cancel,
            visible,
            tasky,
            // Off the tracker on purpose: the actor awaits this handle on cancel.
            handle: tokio::spawn(ctx.run()),
            msgs,
            steerable,
            steer_tx,
            steer,
            steered: 0,
            face,
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

/// Splits off the trailing steered messages the brain left in the channel (the newest ones).
async fn unread_steers(steer: &Steer, steered: usize, msgs: &mut Vec<Msg>) -> Vec<Msg> {
    let left = steer.take().await.len().min(steered);
    msgs.split_off(msgs.len() - left)
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
    /// The face the owner is on now; `ch` and `chat` are where the turn began.
    face: Face,
    cancel: CancellationToken,
    visible: Arc<AtomicBool>,
    tasky: Arc<AtomicBool>,
    steerable: Arc<AtomicBool>,
    steer: Steer,
}

impl TurnCtx {
    async fn run(self) -> TurnEnd {
        let g = self.g.clone();
        let origin = {
            let (ch, chat) = self.face.get();
            origin(ch.name(), &chat)
        };
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
            i = voice::hear(&*g.media, self.inbound.clone(), &self.cancel) => i,
        };
        // Both branches can be ready at once (media returns `Cancelled` as the token fires).
        if self.cancel.is_cancelled() {
            return TurnEnd::Cancelled {
                drafted: String::new(),
            };
        }
        if voiced {
            spans.push(Span {
                name: "hear",
                start: off(hear_t),
                ms: ms_since(hear_t.into_std()),
            });
        }

        let turn = alexia_core::Turn {
            session: self.session,
            origin: origin.clone(),
            content: inbound.content.clone(),
            // Voice notes are already text in `content` (voice::hear); the rest go to the brain,
            // which reads them during `reply`. `delete_files` still removes them after the turn.
            files: inbound
                .files
                .iter()
                .filter(|f| !f.mime.starts_with("audio/"))
                .cloned()
                .collect(),
            received_at: self.first.ms,
            steer: self.steer.clone(),
        };
        spans.push(Span {
            name: "merge",
            start: 0,
            ms: ms_since(self.first.instant.into_std()),
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
                    ms: ms_since(brain_t.into_std()),
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
            ms: ms_since(brain_t.into_std()),
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
            let note = voice::speak(&*g.media, &reply.text, &self.cancel).await;
            spans.push(Span {
                name: "speak",
                start: off(t),
                ms: ms_since(t.into_std()),
            });
            if self.cancel.is_cancelled() {
                return TurnEnd::Cancelled {
                    drafted: reply.text,
                };
            }
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
        let (ch, chat) = self.face.get();
        let sent = ch.send(&chat, &out).await;
        spans.push(Span {
            name: "deliver",
            start: offset(self.first.instant, t),
            ms: ms_since(t.into_std()),
        });
        if let Err(e) = sent {
            tracing::error!(channel = ch.name(), "gateway: delivering failed: {e}");
        }
        let _ = ch.draft(&chat, None).await;
        if ch.name() != self.ch.name() || chat != self.chat {
            // The owner moved on: clear what was left on the face they left.
            let _ = self.ch.draft(&self.chat, None).await;
        }
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
    face: Face,
    frames: mpsc::Receiver<DraftFrame>,
    visible: Arc<AtomicBool>,
    tasky: Arc<AtomicBool>,
    steerable: Arc<AtomicBool>,
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
            face: t.face.clone(),
            frames,
            visible: t.visible.clone(),
            tasky: t.tasky.clone(),
            steerable: t.steerable.clone(),
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
                    let (ch, chat) = self.face.get();
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
            DraftFrame::Steerable => {
                self.steerable.store(true, Ordering::SeqCst);
                return;
            }
            // The window's: a chat shows what it showed before (the phase and the text).
            DraftFrame::Step(_) | DraftFrame::Note(_) | DraftFrame::Ask(_) => return,
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
        let (ch, chat) = self.face.get();
        let r = ch.draft(&chat, Some(&text)).await;
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

    fn msg(content: Content, file: Option<&str>) -> Msg {
        Msg {
            ch: Arc::new(Quiet),
            own_session: false,
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
                button: None,
                reply_to: None,
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
        async fn transcribe(&self, _: &InFile, _: CancellationToken) -> Result<Option<String>> {
            Ok(None)
        }
        async fn speak(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<Option<alexia_core::OutFile>> {
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
            follow: Arc::default(),
            routes: Arc::default(),
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
