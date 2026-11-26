// SPDX-License-Identifier: AGPL-3.0-only
//! Approvals (CH-07): asks the owner yes/no in the chat a run came from, or in the window
//! when the run is the window's and the window is watching it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use alexia_core::{Bus, DraftFrame, Elicitation, Elicited, Event, Origin, Question, RunId};
use alexia_store::{now_ms, Store};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{Channel, ChatRef, Outbound};

/// The channels the gateway polls and the asker asks in. Cheap to clone; shared.
#[derive(Clone, Default)]
pub struct ChannelSet(Arc<std::sync::RwLock<Vec<Arc<dyn Channel>>>>);

impl ChannelSet {
    pub fn new() -> ChannelSet {
        ChannelSet::default()
    }

    pub fn add(&self, c: Arc<dyn Channel>) {
        self.0.write().unwrap_or_else(|e| e.into_inner()).push(c);
    }

    pub fn all(&self) -> Vec<Arc<dyn Channel>> {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// v2 `ANSWER_WAIT`.
const ANSWER_WAIT: Duration = Duration::from_secs(10 * 60);
const NO_ANSWER: &str = "— no answer, so I didn't";
/// After an elicitation's wait: the plugin hears `cancel`, so nothing was done.
const NO_ANSWER_ELICIT: &str = "— no answer, so nothing was done";
/// The longest elicitation prompt (with its ` (#id)`) asked in one chat message; a longer one
/// is sent first (channels split long text) and asked about after.
const ASK_MAX: usize = 3_500;
/// Who answered, on the approval row, when it was the window.
const WINDOW: &str = "window";

/// The questions put to the owner at Alexia's window (v2 serve.ts `pending`). Each run the
/// window is watching has its frame stream attached; at most one question is open at a time,
/// and the next waits for it. Cheap to clone; shared.
#[derive(Clone, Default)]
pub struct WindowQuestions(Arc<WindowInner>);

#[derive(Default)]
struct WindowInner {
    state: Mutex<WindowState>,
    /// Held while a question is open, so the next one waits its turn.
    turn: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct WindowState {
    streams: HashMap<RunId, mpsc::Sender<DraftFrame>>,
    open: Option<OpenQuestion>,
    asked: u64,
}

struct OpenQuestion {
    id: u64,
    run: RunId,
    reply: oneshot::Sender<WindowReply>,
}

/// What the window said to an open question: the owner's Approve / Deny, or Stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowReply {
    Owner(bool),
    /// Stop was pressed: no for a `confirm`, a cancel for an elicitation.
    Stopped,
}

/// Clears the open question when its `ask` ends, however it ends (answered elsewhere,
/// cancelled, timed out), unless another has taken its place.
struct Closing<'a> {
    window: &'a WindowQuestions,
    id: u64,
}

impl Drop for Closing<'_> {
    fn drop(&mut self) {
        let mut s = self.window.state();
        if s.open.as_ref().is_some_and(|o| o.id == self.id) {
            s.open = None;
        }
    }
}

impl WindowQuestions {
    pub fn new() -> WindowQuestions {
        WindowQuestions::default()
    }

    fn state(&self) -> MutexGuard<'_, WindowState> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The window's stream for `run`: its questions are asked there from now on.
    pub fn attach(&self, run: RunId, frames: mpsc::Sender<DraftFrame>) {
        self.state().streams.insert(run, frames);
    }

    /// The window stopped watching `run`. A question of that run that is open gets no answer
    /// here (never a yes): the asker takes it to the primary chat.
    pub fn detach(&self, run: RunId) {
        let mut s = self.state();
        s.streams.remove(&run);
        if s.open.as_ref().is_some_and(|o| o.run == run) {
            s.open = None;
        }
    }

    /// Whether the window is watching `run` (attached, and its stream still open).
    pub fn attached(&self, run: RunId) -> bool {
        self.state()
            .streams
            .get(&run)
            .is_some_and(|tx| !tx.is_closed())
    }

    /// Sends `DraftFrame::Ask` on `run`'s stream and waits for `answer` or `cancel_open`.
    /// None if the run is not attached, is detached while waiting, or `cancel` fires.
    pub async fn ask(
        &self,
        run: RunId,
        question: &str,
        cancel: &CancellationToken,
    ) -> Option<bool> {
        self.ask_told(run, question, cancel)
            .await
            .map(|r| r == WindowReply::Owner(true))
    }

    /// As `ask`, telling Stop apart from the owner's Deny.
    async fn ask_told(
        &self,
        run: RunId,
        question: &str,
        cancel: &CancellationToken,
    ) -> Option<WindowReply> {
        let _turn = tokio::select! {
            t = self.0.turn.lock() => t,
            _ = cancel.cancelled() => return None,
        };
        let (tx, mut rx) = oneshot::channel();
        let (frames, id) = {
            let mut s = self.state();
            let frames = s.streams.get(&run)?.clone();
            s.asked += 1;
            let id = s.asked;
            s.open = Some(OpenQuestion { id, run, reply: tx });
            (frames, id)
        };
        let _closing = Closing { window: self, id };
        tokio::select! {
            sent = frames.send(DraftFrame::Ask(question.to_string())) => {
                if sent.is_err() {
                    return None;
                }
            }
            a = &mut rx => return a.ok(),
            _ = cancel.cancelled() => return None,
        }
        tokio::select! {
            a = rx => a.ok(),
            _ = cancel.cancelled() => None,
        }
    }

    /// The owner's answer from the window (`/api/approve`). True if a question was open.
    pub fn answer(&self, allowed: bool) -> bool {
        let open = self.state().open.take();
        open.is_some_and(|o| o.reply.send(WindowReply::Owner(allowed)).is_ok())
    }

    /// Stop was pressed (`/api/stop`): the open question, if any, answers no (an
    /// elicitation is cancelled instead).
    pub fn cancel_open(&self) {
        let open = self.state().open.take();
        if let Some(o) = open {
            let _ = o.reply.send(WindowReply::Stopped);
        }
    }
}

pub struct Asker {
    channels: ChannelSet,
    store: Arc<Store>,
    /// Answers from other chats arrive as `Event::Answered`.
    bus: Bus,
    /// Where an `Origin::Window` run is asked while the window watches it.
    window: Option<WindowQuestions>,
}

impl Asker {
    pub fn new(channels: ChannelSet, store: Arc<Store>, bus: Bus) -> Arc<Asker> {
        Arc::new(Asker {
            channels,
            store,
            bus,
            window: None,
        })
    }

    /// As `new`, with the window's questions: a window run it watches is asked there.
    pub fn with_window(
        channels: ChannelSet,
        store: Arc<Store>,
        bus: Bus,
        window: WindowQuestions,
    ) -> Arc<Asker> {
        Arc::new(Asker {
            channels,
            store,
            bus,
            window: Some(window),
        })
    }

    pub fn window(&self) -> Option<WindowQuestions> {
        self.window.clone()
    }

    /// The channel and chat to ask in, or `None` (then the answer is no).
    fn target(&self, origin: &Origin) -> Option<(Arc<dyn Channel>, ChatRef)> {
        let channels = self.channels.all();
        match origin {
            Origin::Channel { channel, chat } => channels
                .iter()
                .find(|c| c.name() == channel)
                .map(|c| (c.clone(), ChatRef { chat: chat.clone() })),
            // A scheduled or resumed run has no chat of its own, and a window nobody is
            // watching cannot answer: the first channel's primary chat.
            Origin::Scheduler { .. } | Origin::Window => {
                channels
                    .iter()
                    .find_map(|c| match self.store.primary_chat(c.name()) {
                        Ok(chat) => chat.map(|chat| (c.clone(), ChatRef { chat })),
                        Err(e) => {
                            tracing::error!(channel = c.name(), "ask: primary chat: {e}");
                            None
                        }
                    })
            }
            Origin::Desktop => None,
        }
    }

    /// Record `answer`; the first answer wins, so when someone got there first use theirs.
    /// Returns the answer that stands and who gave it.
    fn settle(&self, id: i64, answer: bool, via: &str) -> (bool, String) {
        match self.store.approval_answer(id, answer, via, now_ms()) {
            Ok(true) => {
                self.bus.publish(Event::Answered {
                    at: now_ms(),
                    approval: id,
                    answer,
                });
                (answer, via.to_string())
            }
            Ok(false) => self.stored(id).unwrap_or((false, via.to_string())),
            Err(e) => {
                tracing::error!("ask: record answer: {e}");
                (answer, via.to_string())
            }
        }
    }

    /// The stored answer, if the row has one.
    fn stored(&self, id: i64) -> Option<(bool, String)> {
        match self.store.approval(id) {
            Ok(Some(r)) => r.answer.map(|a| (a, r.via.unwrap_or_default())),
            Ok(None) => None,
            Err(e) => {
                tracing::error!("ask: read approval: {e}");
                None
            }
        }
    }
}

/// Which question is asked: a run's `confirm` or a plugin's elicitation. They differ in how
/// long the owner has in the chat after the window lets go, what Stop and a withdrawn
/// question mean, and the timeout note.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Confirm,
    Elicit,
}

impl Kind {
    fn no_answer(self) -> &'static str {
        match self {
            Kind::Confirm => NO_ANSWER,
            Kind::Elicit => NO_ANSWER_ELICIT,
        }
    }
}

/// What the chat is sent: `before` (an elicitation too long for one question), then `ask`
/// with the buttons.
struct ChatText {
    before: Option<String>,
    ask: String,
}

/// How the approvals row of an elicitation was settled, as the plugin hears it: the owner's
/// Approve / Deny, else cancel. Every `via` that is not an owner's answer is a cancel, and
/// so is anything unexpected (fail closed).
fn elicited((answer, via): (bool, String)) -> Elicited {
    match via.as_str() {
        "timeout" | "cancelled" | "restart" | "failed" | "nowhere" | "" => Elicited::Cancel,
        _ if answer => Elicited::Accept,
        _ => Elicited::Decline,
    }
}

#[async_trait::async_trait]
impl alexia_core::Ask for Asker {
    /// True only on the owner's Approve; deny, no answer, an error or nowhere to ask is false.
    /// Every question is an `approvals` row, answerable from any chat until it times out.
    async fn confirm(
        &self,
        origin: &Origin,
        question: &Question,
        cancel: CancellationToken,
    ) -> bool {
        if *origin == Origin::Window {
            if let Some(w) = self
                .window
                .as_ref()
                .filter(|w| w.attached(question.run.clone()))
            {
                let rx = self.bus.subscribe();
                let Some(id) = self.open(origin, question) else {
                    return false;
                };
                let asked = Asked {
                    id,
                    run: question.run.clone(),
                    kind: Kind::Confirm,
                    deadline: tokio::time::Instant::now() + ANSWER_WAIT,
                };
                let text = confirm_text(question, id);
                return self
                    .in_window(w, origin, &asked, &question.text, text, rx, cancel)
                    .await
                    .0;
            }
        }
        let Some((ch, chat)) = self.target(origin) else {
            return false;
        };
        // Subscribe first, so an instant `/approve` cannot be missed.
        let rx = self.bus.subscribe();
        let Some(id) = self.open(origin, question) else {
            return false;
        };
        let asked = Asked {
            id,
            run: question.run.clone(),
            kind: Kind::Confirm,
            deadline: tokio::time::Instant::now() + ANSWER_WAIT,
        };
        let text = confirm_text(question, id);
        self.in_chat(ch, chat, &asked, text, rx, cancel).await.0
    }

    /// (P3-36) A plugin's yes/no form: in the window watching `e.run`, else the chat
    /// `target(origin)` gives, else `Cancel` at once (no row, nothing sent). The row holds
    /// only a generic text, never the form's message. Approve → Accept, Deny → Decline;
    /// no answer in `e.wait`, Stop, `cancel`, a message that could not be sent → Cancel.
    async fn elicit(
        &self,
        origin: &Origin,
        e: &Elicitation,
        cancel: CancellationToken,
    ) -> Elicited {
        if cancel.is_cancelled() {
            return Elicited::Cancel;
        }
        let window = match origin {
            Origin::Window => self.window.as_ref().filter(|w| w.attached(e.run.clone())),
            _ => None,
        };
        let chat = self.target(origin);
        if window.is_none() && chat.is_none() {
            return Elicited::Cancel;
        }
        let row = Question {
            run: e.run.clone(),
            text: format!("{} ({}) asks you to confirm something.", e.name, e.plugin),
            detail: None,
        };
        // Subscribe first, so an instant `/approve` cannot be missed.
        let rx = self.bus.subscribe();
        let Some(id) = self.open(origin, &row) else {
            return Elicited::Cancel;
        };
        let asked = Asked {
            id,
            run: e.run.clone(),
            kind: Kind::Elicit,
            deadline: tokio::time::Instant::now() + e.wait,
        };
        let text = elicit_text(e, id);
        let settled = match (window, chat) {
            (Some(w), _) => {
                self.in_window(w, origin, &asked, &e.prompt(), text, rx, cancel.clone())
                    .await
            }
            (None, Some((ch, chat))) => {
                self.in_chat(ch, chat, &asked, text, rx, cancel.clone())
                    .await
            }
            (None, None) => self.settle(id, false, "nowhere"),
        };
        // A yes that lands as the question is withdrawn is not acted on.
        if cancel.is_cancelled() {
            return Elicited::Cancel;
        }
        elicited(settled)
    }
}

/// One open question: its row, run, kind, and when its wait ends.
struct Asked {
    id: i64,
    run: RunId,
    kind: Kind,
    deadline: tokio::time::Instant,
}

/// A `confirm`'s chat message: the question, its detail, and the row id for `/approve`.
fn confirm_text(question: &Question, id: i64) -> ChatText {
    let ask = match &question.detail {
        Some(d) => format!(
            "{}

{d} (#{id})",
            question.text
        ),
        None => format!("{} (#{id})", question.text),
    };
    ChatText { before: None, ask }
}

/// An elicitation's chat message: the whole prompt with the buttons, or, when that is too
/// long for one message, the prompt first and then a short question naming the plugin again.
fn elicit_text(e: &Elicitation, id: i64) -> ChatText {
    let whole = format!("{} (#{id})", e.prompt());
    if whole.chars().count() <= ASK_MAX {
        return ChatText {
            before: None,
            ask: whole,
        };
    }
    ChatText {
        before: Some(e.prompt()),
        ask: format!(
            "{} ({}) asks: yes to the message above? (#{id})",
            e.name, e.plugin
        ),
    }
}

impl Asker {
    /// The question's `approvals` row; None (then the answer is no) if it cannot be written.
    fn open(&self, origin: &Origin, question: &Question) -> Option<i64> {
        let origin_json = serde_json::to_string(origin).unwrap_or_else(|_| "{}".into());
        match self.store.approval_open(
            &question.run.0,
            &origin_json,
            &question.text,
            question.detail.as_deref(),
            now_ms(),
        ) {
            Ok(id) => Some(id),
            Err(e) => {
                tracing::error!("ask: open approval: {e}");
                None
            }
        }
    }

    /// The question was withdrawn (`cancel`). A `confirm`'s row stays unanswered, as before;
    /// an elicitation's is settled `cancelled`, so nothing can answer it later.
    fn withdrawn(&self, asked: &Asked) -> (bool, String) {
        match asked.kind {
            Kind::Confirm => (false, "cancelled".into()),
            Kind::Elicit => self.settle(asked.id, false, "cancelled"),
        }
    }

    /// Asks in the window watching the run, showing `shown`. The row is the same as a chat's,
    /// so `/approve` from a chat answers it too. If the window lets go before answering, the
    /// question goes to the primary chat as `text`: a window closing is never a yes. Returns
    /// the answer that stands and who gave it.
    #[allow(clippy::too_many_arguments)]
    async fn in_window(
        &self,
        window: &WindowQuestions,
        origin: &Origin,
        asked: &Asked,
        shown: &str,
        text: ChatText,
        mut rx: broadcast::Receiver<Arc<Event>>,
        cancel: CancellationToken,
    ) -> (bool, String) {
        let id = asked.id;
        {
            let answer = window.ask_told(asked.run.clone(), shown, &cancel);
            tokio::pin!(answer);
            let timer = tokio::time::sleep_until(asked.deadline);
            tokio::pin!(timer);
            loop {
                tokio::select! {
                    a = &mut answer => match a {
                        Some(WindowReply::Owner(a)) => return self.settle(id, a, WINDOW),
                        // Stop: a run's question is a no, a plugin's is withdrawn.
                        Some(WindowReply::Stopped) => {
                            return match asked.kind {
                                Kind::Confirm => self.settle(id, false, WINDOW),
                                Kind::Elicit => self.settle(id, false, "cancelled"),
                            };
                        }
                        None if cancel.is_cancelled() => return self.withdrawn(asked),
                        None => break, // detached: ask in the primary chat instead
                    },
                    e = rx.recv() => match e {
                        Ok(e) => {
                            if matches!(*e, Event::Answered { approval, .. } if approval == id) {
                                if let Some(a) = self.stored(id) {
                                    return a;
                                }
                            }
                        }
                        Err(RecvError::Lagged(_)) => {
                            if let Some(a) = self.stored(id) {
                                return a;
                            }
                        }
                        Err(RecvError::Closed) => rx = self.bus.subscribe(),
                    },
                    _ = &mut timer => return self.settle(id, false, "timeout"),
                    _ = cancel.cancelled() => return self.withdrawn(asked),
                }
            }
        }
        match self.target(origin) {
            Some((ch, chat)) => {
                // A run's question gets the full wait again in the chat, as before; a
                // plugin's call has only the time that is left.
                let deadline = match asked.kind {
                    Kind::Confirm => tokio::time::Instant::now() + ANSWER_WAIT,
                    Kind::Elicit => asked.deadline,
                };
                let asked = Asked {
                    id,
                    run: asked.run.clone(),
                    kind: asked.kind,
                    deadline,
                };
                self.in_chat(ch, chat, &asked, text, rx, cancel).await
            }
            None => {
                tracing::warn!(
                    "ask: the window let go of a question and there is no chat to ask in"
                );
                self.settle(id, false, "nowhere")
            }
        }
    }

    /// Asks in `chat` with buttons; `/approve` from anywhere answers it too. Returns the
    /// answer that stands and who gave it.
    async fn in_chat(
        &self,
        ch: Arc<dyn Channel>,
        chat: ChatRef,
        asked: &Asked,
        text: ChatText,
        mut rx: broadcast::Receiver<Arc<Event>>,
        cancel: CancellationToken,
    ) -> (bool, String) {
        let id = asked.id;
        if let Some(before) = text.before {
            let out = Outbound {
                text: before,
                files: Vec::new(),
                voice: false,
            };
            let sent = tokio::select! {
                r = ch.send(&chat, &out) => r,
                _ = cancel.cancelled() => return self.withdrawn(asked),
            };
            if let Err(e) = sent {
                // The owner never saw it, so they cannot answer it.
                tracing::warn!(channel = ch.name(), "ask: {e}");
                return self.settle(id, false, "failed");
            }
        }
        let ask = cancel.child_token();
        let buttons = ch.ask(&chat, &text.ask, ask.clone());
        tokio::pin!(buttons);
        let timer = tokio::time::sleep_until(asked.deadline);
        tokio::pin!(timer);
        let mut buttons_done = false;

        let (answer, via) = loop {
            tokio::select! {
                r = &mut buttons, if !buttons_done => {
                    buttons_done = true;
                    match r {
                        Ok(Some(a)) => break self.settle(id, a, ch.name()),
                        Ok(None) => {} // the buttons gave up; `/approve` and the timer remain
                        Err(e) => {
                            tracing::warn!(channel = ch.name(), "ask: {e}");
                            // A plugin's question the owner never saw is withdrawn, not a no.
                            let via = match asked.kind {
                                Kind::Confirm => ch.name(),
                                Kind::Elicit => "failed",
                            };
                            break self.settle(id, false, via);
                        }
                    }
                }
                e = rx.recv() => match e {
                    Ok(e) => {
                        if matches!(*e, Event::Answered { approval, .. } if approval == id) {
                            if let Some(a) = self.stored(id) {
                                break a;
                            }
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        if let Some(a) = self.stored(id) {
                            break a;
                        }
                    }
                    Err(RecvError::Closed) => {
                        // Nobody can publish any more; the buttons and the timer still decide.
                        rx = self.bus.subscribe();
                    }
                },
                _ = &mut timer => {
                    let (a, via) = self.settle(id, false, "timeout");
                    if via == "timeout" {
                        // ponytail: `Channel::ask` returns no MsgRef, so this follows the question
                        // instead of editing it; edit in place once `ask` hands back the message.
                        self.note(&*ch, &chat, asked.kind.no_answer()).await;
                    }
                    ask.cancel();
                    return (a, via);
                }
                _ = cancel.cancelled() => {
                    ask.cancel();
                    return self.withdrawn(asked);
                }
            }
        };
        ask.cancel();
        // ponytail: an answer by this chat's own buttons gets no note ("Approved here") because
        // `Channel::ask` returns no MsgRef to edit and a follow-up would reach the turn's chat
        // before its reply; add the edit once `ask` hands back the message.
        if via != ch.name() && via != "failed" {
            let verb = if answer { "Approved" } else { "Denied" };
            self.note(&*ch, &chat, &format!("— {verb} from {via}"))
                .await;
        }
        (answer, via)
    }

    async fn note(&self, ch: &dyn Channel, chat: &ChatRef, text: &str) {
        let out = Outbound {
            text: text.into(),
            files: Vec::new(),
            voice: false,
        };
        if let Err(e) = ch.send(chat, &out).await {
            tracing::warn!(channel = ch.name(), "ask: note: {e}");
        }
    }
}
