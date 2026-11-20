// SPDX-License-Identifier: AGPL-3.0-only
//! P1-11: the gateway loop against a scripted channel, brain and media.
//!
//! Real time throughout: the crate has no `tokio/test-util`, so `time::pause` is not available.
//! Every wait is bounded by `until` (30 s); every timing assertion is a lower bound or an order,
//! except the two the spec pins (ack ≤ 10 ms, ≤ 5 drafts over 1 s, shutdown ≤ 3 s plus slack).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Budget, Bus, DraftFrame, DraftSink, Event, Lane, OutFile, Phase, Reply,
    Span, Turn,
};
use alexia_gateway::{
    Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InFile, InKind, Inbound, Media,
    MsgRef, Outbound, Result,
};
use alexia_store::{Content, Store};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, sleep_until, Instant};
use tokio_util::sync::CancellationToken;

// ---- fake channel ----

#[derive(Clone, Debug, PartialEq)]
enum What {
    /// `next()` is about to return this many messages.
    Next(usize),
    React(String),
    Typing,
    Send(String),
    Draft(Option<String>),
}

#[derive(Clone, Debug)]
struct Call {
    at: Instant,
    chat: String,
    what: What,
}

struct FakeChannel {
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    log: Mutex<Vec<Call>>,
    /// The next `draft(Some(..))` answers `RateLimited { retry_after_ms }`.
    rate_limit_next: Mutex<Option<u64>>,
    /// How long `react` and `typing` take.
    delay: Mutex<Duration>,
    /// `react` / `typing` calls that have started and not yet returned.
    in_flight: AtomicUsize,
}

impl FakeChannel {
    fn note(&self, chat: &str, what: What) {
        self.log.lock().unwrap().push(Call {
            at: Instant::now(),
            chat: chat.to_string(),
            what,
        });
    }
    /// A slow call: in flight for `delay`, logged at its end.
    async fn slow(&self, chat: &str, what: What) {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let delay = *self.delay.lock().unwrap();
        // Zero = no await at all, so the existing timing tests see the old fake.
        if !delay.is_zero() {
            sleep(delay).await;
        }
        self.note(chat, what);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
    fn calls(&self) -> Vec<Call> {
        self.log.lock().unwrap().clone()
    }
    fn sent(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c.what {
                What::Send(t) => Some(t),
                _ => None,
            })
            .collect()
    }
    /// `draft(Some(..))` calls: when, and the text.
    fn drafts(&self) -> Vec<(Instant, String)> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c.what {
                What::Draft(Some(t)) => Some((c.at, t)),
                _ => None,
            })
            .collect()
    }
    fn at_of(&self, what: &What) -> Option<Instant> {
        self.calls()
            .into_iter()
            .find(|c| &c.what == what)
            .map(|c| c.at)
    }
}

#[async_trait::async_trait]
impl Channel for FakeChannel {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>> {
        let mut inbox = self.inbox.lock().await;
        tokio::select! {
            _ = cancel.cancelled() => Err(Error::Cancelled),
            b = inbox.recv() => match b {
                Some(b) => {
                    self.note("", What::Next(b.len()));
                    Ok(b)
                }
                None => {
                    cancel.cancelled().await;
                    Err(Error::Cancelled)
                }
            },
        }
    }
    async fn react(&self, chat: &ChatRef, msg: &MsgRef, _emoji: &str) -> Result<()> {
        self.slow(&chat.chat, What::React(msg.id.clone())).await;
        Ok(())
    }
    async fn typing(&self, chat: &ChatRef) -> Result<()> {
        self.slow(&chat.chat, What::Typing).await;
        Ok(())
    }
    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        self.note(&chat.chat, What::Send(out.text.clone()));
        Ok(MsgRef {
            id: format!("sent-{}", out.text.len()),
        })
    }
    async fn draft(&self, chat: &ChatRef, text: Option<&str>) -> Result<()> {
        self.note(&chat.chat, What::Draft(text.map(str::to_string)));
        if text.is_some() {
            if let Some(ms) = self.rate_limit_next.lock().unwrap().take() {
                return Err(Error::RateLimited { retry_after_ms: ms });
            }
        }
        Ok(())
    }
    async fn edit(&self, _chat: &ChatRef, _msg: &MsgRef, _text: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(&self, _: &ChatRef, _: &str, _: CancellationToken) -> Result<Option<bool>> {
        Ok(None)
    }
}

// ---- fake media ----

struct FakeMedia;

#[async_trait::async_trait]
impl Media for FakeMedia {
    async fn transcribe(&self, _file: &InFile) -> Result<Option<String>> {
        Ok(None)
    }
    async fn speak(&self, _text: &str) -> Result<Option<OutFile>> {
        Ok(None)
    }
}

// ---- fake brain ----

enum Outcome {
    Text(&'static str, Lane, Vec<Span>),
    Unavailable(&'static str),
}

/// Frames at fixed offsets from the call, then the outcome at `end_ms`.
struct Script {
    frames: Vec<(u64, DraftFrame)>,
    end_ms: u64,
    outcome: Outcome,
    ignore_cancel: bool,
}

impl Script {
    fn new(frames: Vec<(u64, DraftFrame)>, end_ms: u64, outcome: Outcome) -> Script {
        Script {
            frames,
            end_ms,
            outcome,
            ignore_cancel: false,
        }
    }
}

fn chat_reply(text: &'static str) -> Outcome {
    Outcome::Text(text, Lane::Chat, vec![])
}

#[derive(Default)]
struct FakeBrain {
    scripts: Mutex<VecDeque<Script>>,
    turns: Mutex<Vec<Turn>>,
    cancelled: AtomicUsize,
}

impl FakeBrain {
    fn texts(&self) -> Vec<String> {
        self.turns
            .lock()
            .unwrap()
            .iter()
            .map(|t| text_of(&t.content))
            .collect()
    }
    fn calls(&self) -> usize {
        self.turns.lock().unwrap().len()
    }
}

fn text_of(c: &Content) -> String {
    match c {
        Content::Text(t) => t.clone(),
        Content::Parts(_) => "<parts>".into(),
    }
}

#[async_trait::async_trait]
impl Brain for FakeBrain {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        self.turns.lock().unwrap().push(turn);
        let script = self.scripts.lock().unwrap().pop_front();
        let script = script.unwrap_or_else(|| Script::new(vec![], 0, chat_reply("ok")));
        let t0 = Instant::now();
        let hold = |ms: u64| {
            let cancel = cancel.clone();
            let ignore = script.ignore_cancel;
            async move {
                let at = t0 + Duration::from_millis(ms);
                if ignore {
                    sleep_until(at).await;
                    return true;
                }
                tokio::select! {
                    _ = cancel.cancelled() => false,
                    _ = sleep_until(at) => true,
                }
            }
        };
        for (at, frame) in script.frames {
            if !hold(at).await {
                self.cancelled.fetch_add(1, Ordering::SeqCst);
                return Err(BrainError::Cancelled);
            }
            let _ = draft.send(frame).await;
        }
        if !hold(script.end_ms).await {
            self.cancelled.fetch_add(1, Ordering::SeqCst);
            return Err(BrainError::Cancelled);
        }
        match script.outcome {
            Outcome::Text(text, lane, spans) => Ok(Reply {
                text: text.into(),
                files: vec![],
                lane,
                model: None,
                spans,
            }),
            Outcome::Unavailable(s) => Err(BrainError::Unavailable(s.into())),
        }
    }
}

// ---- harness ----

struct H {
    ch: Arc<FakeChannel>,
    inbox: mpsc::UnboundedSender<Vec<Inbound>>,
    brain: Arc<FakeBrain>,
    store: Arc<Store>,
    bus: Bus,
    cancel: CancellationToken,
    run: JoinHandle<Result<()>>,
}

fn cfg(merge_ms: u64) -> GatewayConfig {
    GatewayConfig {
        merge_ms,
        ..GatewayConfig::default()
    }
}

fn start(cfg: GatewayConfig, scripts: Vec<Script>) -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    start_with(cfg, scripts, store)
}

fn start_with(cfg: GatewayConfig, scripts: Vec<Script>, store: Arc<Store>) -> H {
    let (inbox, rx) = mpsc::unbounded_channel();
    let ch = Arc::new(FakeChannel {
        inbox: tokio::sync::Mutex::new(rx),
        log: Mutex::new(Vec::new()),
        rate_limit_next: Mutex::new(None),
        delay: Mutex::new(Duration::ZERO),
        in_flight: AtomicUsize::new(0),
    });
    let brain = Arc::new(FakeBrain {
        scripts: Mutex::new(scripts.into()),
        ..FakeBrain::default()
    });
    let bus = Bus::new(256);
    let channels = ChannelSet::new();
    channels.add(ch.clone());
    let gw = Gateway::with_channels(
        cfg,
        store.clone(),
        bus.clone(),
        brain.clone(),
        Arc::new(FakeMedia),
        channels,
    );
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.run(cancel.clone()));
    H {
        ch,
        inbox,
        brain,
        store,
        bus,
        cancel,
        run,
    }
}

impl H {
    fn push(&self, msgs: Vec<Inbound>) {
        self.inbox.send(msgs).unwrap();
    }
    async fn stop(self) {
        self.cancel.cancel();
        let r = tokio::time::timeout(Duration::from_secs(30), self.run).await;
        assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
    }
}

fn msg(chat: &str, id: &str, text: &str) -> Inbound {
    Inbound {
        chat: ChatRef { chat: chat.into() },
        msg: MsgRef { id: id.into() },
        kind: InKind::Message,
        from_owner: true,
        content: Content::Text(text.into()),
        files: vec![],
        at: 0,
    }
}

/// Waits (polling, at most 30 s) until `f` holds.
async fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        sleep(Duration::from_millis(2)).await;
    }
}

fn ms(d: Duration) -> u128 {
    d.as_millis()
}

// ---- CH-03 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ack_before_brain() {
    let h = start(
        cfg(50),
        vec![Script::new(vec![], 5_000, chat_reply("late"))],
    );
    let mut events = h.bus.subscribe();
    h.push(vec![msg("a", "1", "hi")]);
    until("the reaction", || {
        h.ch.at_of(&What::React("1".into())).is_some()
    })
    .await;
    let next = h.ch.at_of(&What::Next(1)).unwrap();
    let react = h.ch.at_of(&What::React("1".into())).unwrap();
    assert!(
        ms(react - next) <= 10,
        "react came {} ms after next()",
        ms(react - next)
    );
    let acked = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Event::Acked { .. } = &*events.recv().await.unwrap() {
                return;
            }
        }
    })
    .await;
    assert!(acked.is_ok(), "no Event::Acked");
    // The brain is still busy: nothing was sent yet.
    assert!(h.ch.sent().is_empty());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ack_never_waits_on_a_busy_chat() {
    let h = start(
        cfg(20),
        vec![
            Script::new(vec![], 10_000, chat_reply("a1")),
            Script::new(vec![], 10_000, chat_reply("a2")),
            Script::new(vec![], 10_000, chat_reply("b")),
        ],
    );
    h.push(vec![msg("A", "1", "first")]);
    until("the first turn", || h.brain.calls() == 1).await;
    h.push(vec![msg("A", "2", "second"), msg("B", "3", "other")]);
    until("both reactions", || {
        h.ch.at_of(&What::React("2".into())).is_some()
            && h.ch.at_of(&What::React("3".into())).is_some()
    })
    .await;
    let next = h.ch.at_of(&What::Next(2)).unwrap();
    for id in ["2", "3"] {
        let react = h.ch.at_of(&What::React(id.into())).unwrap();
        assert!(
            ms(react - next) <= 10,
            "react {id} came {} ms after next()",
            ms(react - next)
        );
    }
    h.stop().await;
}

// ---- CH-09 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quick_messages_merge() {
    // A wide window, so a slow machine still lands the second message inside it.
    let h = start(cfg(1_500), vec![]);
    h.push(vec![msg("a", "1", "hello")]);
    sleep(Duration::from_millis(200)).await;
    h.push(vec![msg("a", "2", "are you there?")]);
    until("the reply", || h.ch.sent().contains(&"ok".to_string())).await;
    assert_eq!(h.brain.texts(), vec!["hello\nare you there?".to_string()]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn message_before_visible_text_restarts_merged() {
    let h = start(
        cfg(20),
        vec![
            Script::new(
                vec![(0, DraftFrame::Phase(Phase::Thinking))],
                10_000,
                chat_reply("never"),
            ),
            Script::new(vec![], 0, chat_reply("both")),
        ],
    );
    h.push(vec![msg("a", "1", "one")]);
    until("the phase in the draft", || !h.ch.drafts().is_empty()).await;
    h.push(vec![msg("a", "2", "two")]);
    until("the merged reply", || h.ch.sent().contains(&"both".into())).await;
    assert_eq!(
        h.brain.texts(),
        vec!["one".to_string(), "one\ntwo".to_string()]
    );
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(h.ch.sent(), vec!["both".to_string()]);
    h.stop().await;
}

// ---- CH-08 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn message_during_visible_task_steers() {
    let h = start(
        cfg(20),
        vec![
            Script::new(
                vec![
                    (0, DraftFrame::Phase(Phase::Tool)),
                    (10, DraftFrame::Delta("Looking up flights".into())),
                ],
                10_000,
                Outcome::Text("never", Lane::Task, vec![]),
            ),
            Script::new(vec![], 0, Outcome::Text("Rome it is", Lane::Task, vec![])),
        ],
    );
    h.push(vec![msg("a", "1", "find flights")]);
    until("the text in the draft", || {
        h.ch.drafts().iter().any(|(_, t)| t == "Looking up flights")
    })
    .await;
    h.push(vec![msg("a", "2", "to Rome")]);
    until("the steered reply", || {
        h.ch.sent().contains(&"Rome it is".into())
    })
    .await;
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.ch.sent(),
        vec!["Looking up flights…".to_string(), "Rome it is".to_string()]
    );
    assert_eq!(
        h.brain.texts(),
        vec!["find flights".to_string(), "to Rome".to_string()]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn steer_after_restart_sends_no_bare_ellipsis() {
    let h = start(
        cfg(20),
        vec![
            Script::new(
                vec![
                    (0, DraftFrame::Phase(Phase::Tool)),
                    (10, DraftFrame::Delta("Draft one".into())),
                    (400, DraftFrame::Restart),
                ],
                10_000,
                Outcome::Text("never", Lane::Task, vec![]),
            ),
            Script::new(vec![], 0, Outcome::Text("Rome it is", Lane::Task, vec![])),
        ],
    );
    h.push(vec![msg("a", "1", "find flights")]);
    until("the restart shown", || {
        let d = h.ch.drafts();
        let first = d.iter().position(|(_, t)| t == "Draft one");
        first.is_some_and(|i| d[i..].iter().any(|(_, t)| t == "Working…"))
    })
    .await;
    h.push(vec![msg("a", "2", "to Rome")]);
    until("the steered reply", || {
        h.ch.sent().contains(&"Rome it is".into())
    })
    .await;
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(h.ch.sent(), vec!["Rome it is".to_string()]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn message_during_visible_chat_queues() {
    let h = start(
        cfg(20),
        vec![
            Script::new(
                vec![(0, DraftFrame::Delta("Hello".into()))],
                1_500,
                chat_reply("Hello there"),
            ),
            Script::new(vec![], 0, chat_reply("Second")),
        ],
    );
    h.push(vec![msg("a", "1", "hi")]);
    until("the text in the draft", || {
        h.ch.drafts().iter().any(|(_, t)| t == "Hello")
    })
    .await;
    h.push(vec![msg("a", "2", "and another thing")]);
    until("the queued reply", || {
        h.ch.sent().contains(&"Second".into())
    })
    .await;
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 0);
    assert_eq!(
        h.ch.sent(),
        vec!["Hello there".to_string(), "Second".to_string()]
    );
    assert_eq!(
        h.brain.texts(),
        vec!["hi".to_string(), "and another thing".to_string()]
    );
    h.stop().await;
}

// ---- CH-08 into the agent loop (P2-07) ----

/// A brain that says `Steerable`. The first call either reads `turn.steer` until something is
/// there (`takes`), or ignores it until `release` is set. Later calls answer "second" at once.
struct SteerBrain {
    takes: bool,
    release: AtomicBool,
    /// Set a second after `Steerable` was sent, so the gateway has surely seen the frame.
    ready: AtomicBool,
    calls: Mutex<Vec<String>>,
    steered: Mutex<Vec<String>>,
    cancelled: AtomicUsize,
    token_cancelled_at_end: AtomicBool,
}

impl SteerBrain {
    fn new(takes: bool) -> Arc<SteerBrain> {
        Arc::new(SteerBrain {
            takes,
            release: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            calls: Mutex::new(Vec::new()),
            steered: Mutex::new(Vec::new()),
            cancelled: AtomicUsize::new(0),
            token_cancelled_at_end: AtomicBool::new(false),
        })
    }
}

fn reply_of(text: &str) -> Reply {
    Reply {
        text: text.into(),
        files: vec![],
        lane: Lane::Task,
        model: None,
        spans: vec![],
    }
}

#[async_trait::async_trait]
impl Brain for SteerBrain {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        let first = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(text_of(&turn.content));
            calls.len() == 1
        };
        if !first {
            return Ok(reply_of("second"));
        }
        let _ = draft.send(DraftFrame::Steerable).await;
        sleep(Duration::from_secs(1)).await;
        self.ready.store(true, Ordering::SeqCst);
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            if cancel.is_cancelled() {
                self.cancelled.fetch_add(1, Ordering::SeqCst);
                return Err(BrainError::Cancelled);
            }
            if self.takes {
                let got = turn.steer.take().await;
                if !got.is_empty() {
                    self.steered.lock().unwrap().extend(got.iter().map(text_of));
                    self.token_cancelled_at_end
                        .store(cancel.is_cancelled(), Ordering::SeqCst);
                    return Ok(reply_of("done"));
                }
            } else if self.release.load(Ordering::SeqCst) {
                return Ok(reply_of("first"));
            }
            assert!(Instant::now() < end, "the steer test brain timed out");
            sleep(Duration::from_millis(10)).await;
        }
    }
}

struct SteerHarness {
    ch: Arc<FakeChannel>,
    inbox: mpsc::UnboundedSender<Vec<Inbound>>,
    cancel: CancellationToken,
    run: JoinHandle<Result<()>>,
}

/// The same fake channel and store, with any brain.
fn start_brain(brain: Arc<dyn Brain>) -> SteerHarness {
    let (inbox, rx) = mpsc::unbounded_channel();
    let ch = Arc::new(FakeChannel {
        inbox: tokio::sync::Mutex::new(rx),
        log: Mutex::new(Vec::new()),
        rate_limit_next: Mutex::new(None),
        delay: Mutex::new(Duration::ZERO),
        in_flight: AtomicUsize::new(0),
    });
    let channels = ChannelSet::new();
    channels.add(ch.clone());
    let gw = Gateway::with_channels(
        cfg(20),
        Arc::new(Store::open_in_memory().unwrap()),
        Bus::new(256),
        brain,
        Arc::new(FakeMedia),
        channels,
    );
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.run(cancel.clone()));
    SteerHarness {
        ch,
        inbox,
        cancel,
        run,
    }
}

impl SteerHarness {
    fn push(&self, m: Inbound) {
        self.inbox.send(vec![m]).unwrap();
    }
    async fn stop(self) {
        self.cancel.cancel();
        let r = tokio::time::timeout(Duration::from_secs(30), self.run).await;
        assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn message_mid_task_steers_without_cancel() {
    let brain = SteerBrain::new(true);
    let h = start_brain(brain.clone());
    h.push(msg("a", "1", "one"));
    until("the brain to be ready", || {
        brain.ready.load(Ordering::SeqCst)
    })
    .await;
    h.push(msg("a", "2", "two"));
    until("the reply", || h.ch.sent().contains(&"done".to_string())).await;
    assert_eq!(*brain.steered.lock().unwrap(), vec!["two".to_string()]);
    assert!(!brain.token_cancelled_at_end.load(Ordering::SeqCst));
    assert_eq!(brain.cancelled.load(Ordering::SeqCst), 0);
    // One turn only: the steered message started nothing of its own.
    assert_eq!(*brain.calls.lock().unwrap(), vec!["one".to_string()]);
    // The reaction rule is unchanged: the steered message got its reaction too.
    assert!(h.ch.at_of(&What::React("2".into())).is_some());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leftover_after_end_becomes_a_turn() {
    let brain = SteerBrain::new(false);
    let h = start_brain(brain.clone());
    h.push(msg("a", "1", "one"));
    until("the brain to be ready", || {
        brain.ready.load(Ordering::SeqCst)
    })
    .await;
    h.push(msg("a", "2", "two"));
    until("the steered reaction", || {
        h.ch.at_of(&What::React("2".into())).is_some()
    })
    .await;
    // Let the actor hand it over before the run ends without reading it.
    sleep(Duration::from_secs(1)).await;
    brain.release.store(true, Ordering::SeqCst);
    until("both replies", || h.ch.sent().len() == 2).await;
    assert_eq!(h.ch.sent(), vec!["first".to_string(), "second".to_string()]);
    assert_eq!(
        *brain.calls.lock().unwrap(),
        vec!["one".to_string(), "two".to_string()]
    );
    assert_eq!(brain.cancelled.load(Ordering::SeqCst), 0);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_lane_still_restarts() {
    let h = start(
        cfg(20),
        vec![
            Script::new(
                vec![(0, DraftFrame::Phase(Phase::Thinking))],
                10_000,
                chat_reply("never"),
            ),
            Script::new(vec![], 0, chat_reply("again")),
        ],
    );
    h.push(vec![msg("a", "1", "one")]);
    until("the phase in the draft", || !h.ch.drafts().is_empty()).await;
    h.push(vec![msg("a", "2", "two")]);
    until("the restarted reply", || {
        h.ch.sent().contains(&"again".into())
    })
    .await;
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.brain.texts(),
        vec!["one".to_string(), "one\ntwo".to_string()]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_still_stops_a_steerable_run() {
    let brain = SteerBrain::new(false);
    let h = start_brain(brain.clone());
    h.push(msg("a", "1", "one"));
    until("the brain to be ready", || {
        brain.ready.load(Ordering::SeqCst)
    })
    .await;
    h.push(msg("a", "2", "/stop"));
    until("Stopped.", || h.ch.sent().contains(&"Stopped.".to_string())).await;
    until("the brain to see the cancel", || {
        brain.cancelled.load(Ordering::SeqCst) == 1
    })
    .await;
    assert_eq!(h.ch.sent(), vec!["Stopped.".to_string()]);
    assert_eq!(brain.calls.lock().unwrap().len(), 1);
    h.stop().await;
}

// ---- commands ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_cancels() {
    let long = || Script::new(vec![], 10_000, chat_reply("never"));
    let h = start(cfg(20), vec![long(), long()]);
    h.push(vec![msg("a", "1", "write me a novel")]);
    until("the first turn", || h.brain.calls() == 1).await;
    h.push(vec![msg("a", "2", "/stop")]);
    until("Stopped.", || h.ch.sent().len() == 1).await;
    assert_eq!(h.ch.sent(), vec!["Stopped.".to_string()]);
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 1);

    // The service's own stop (InKind::Stop) does the same.
    h.push(vec![msg("a", "3", "another")]);
    until("the second turn", || h.brain.calls() == 2).await;
    let mut stop = msg("a", "4", "");
    stop.kind = InKind::Stop;
    h.push(vec![stop]);
    until("Stopped. again", || h.ch.sent().len() == 2).await;
    assert_eq!(h.brain.cancelled.load(Ordering::SeqCst), 2);
    assert!(!h.ch.sent().contains(&"never".to_string()));
    // Neither command reached the brain.
    assert_eq!(h.brain.calls(), 2);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slash_new_makes_a_new_session() {
    let h = start(cfg(20), vec![]);
    h.push(vec![msg("a", "1", "hi")]);
    until("the first reply", || h.ch.sent().len() == 1).await;
    h.push(vec![msg("a", "2", "/new")]);
    until("New conversation.", || h.ch.sent().len() == 2).await;
    assert_eq!(h.ch.sent()[1], "New conversation.");
    h.push(vec![msg("a", "3", "/help")]);
    until("the help", || h.ch.sent().len() == 3).await;
    let help = &h.ch.sent()[2];
    assert_eq!(help.lines().count(), 3);
    for c in ["/stop", "/new", "/help"] {
        assert!(help.contains(c), "{help}");
    }
    h.push(vec![msg("a", "4", "hi again")]);
    until("the second reply", || h.ch.sent().len() == 4).await;
    let sessions: Vec<_> = h
        .brain
        .turns
        .lock()
        .unwrap()
        .iter()
        .map(|t| t.session)
        .collect();
    assert_eq!(sessions.len(), 2, "commands reached the brain");
    assert_ne!(sessions[0], sessions[1]);
    assert_eq!(h.store.channel_session("fake", "a").unwrap(), sessions[1]);
    // Other slash commands are v2's: they go to the brain as text.
    h.push(vec![msg("a", "5", "/model")]);
    until("the brain", || h.brain.calls() == 3).await;
    assert_eq!(h.brain.texts()[2], "/model");
    h.stop().await;
}

// ---- CH-04, SP-14 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drafts_are_paced_and_back_off() {
    // 50 deltas over 1 s, each at a fixed offset so timer granularity cannot stretch it.
    let fifty = (1..=50)
        .map(|i| (i * 20, DraftFrame::Delta("x".into())))
        .collect();
    // Then 40 deltas over 4 s, with the first draft rate limited.
    let forty = (1..=40)
        .map(|i| (i * 100, DraftFrame::Delta("y".into())))
        .collect();
    let h = start(
        cfg(20),
        vec![
            Script::new(fifty, 1_000, chat_reply("paced")),
            Script::new(forty, 4_000, chat_reply("backed off")),
        ],
    );
    h.push(vec![msg("a", "1", "go")]);
    until("the first reply", || h.ch.sent().len() == 1).await;
    let paced = h.ch.drafts();
    assert!(
        (2..=5).contains(&paced.len()),
        "{} drafts over 1 s",
        paced.len()
    );
    for w in paced.windows(2) {
        assert!(
            ms(w[1].0 - w[0].0) >= 300,
            "drafts {} ms apart",
            ms(w[1].0 - w[0].0)
        );
    }
    // The draft keeps the whole text so far.
    assert!(paced.iter().all(|(_, t)| t.chars().all(|c| c == 'x')));
    assert!(paced.windows(2).all(|w| w[1].1.len() > w[0].1.len()));

    *h.ch.rate_limit_next.lock().unwrap() = Some(1_000);
    h.push(vec![msg("a", "2", "again")]);
    until("the second reply", || h.ch.sent().len() == 2).await;
    let backed: Vec<_> = h.ch.drafts().into_iter().skip(paced.len()).collect();
    assert!(backed.len() >= 3, "{} drafts", backed.len());
    let gap1 = ms(backed[1].0 - backed[0].0);
    let gap2 = ms(backed[2].0 - backed[1].0);
    assert!(
        gap1 >= 1_000,
        "retried after {gap1} ms, not after retry_after"
    );
    assert!(gap2 >= 600, "interval {gap2} ms, not doubled");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn phase_shows_before_text() {
    let h = start(
        cfg(20),
        vec![Script::new(
            vec![
                (0, DraftFrame::Phase(Phase::Choosing)),
                (400, DraftFrame::Phase(Phase::Thinking)),
                (800, DraftFrame::Phase(Phase::Tool)),
                (1_200, DraftFrame::Phase(Phase::Backup)),
                (1_600, DraftFrame::Delta("Here".into())),
                (2_000, DraftFrame::Phase(Phase::Thinking)),
                (2_400, DraftFrame::Restart),
                (2_800, DraftFrame::Delta("Again".into())),
            ],
            3_200,
            chat_reply("Again"),
        )],
    );
    h.push(vec![msg("a", "1", "hi")]);
    until("the reply", || h.ch.sent().len() == 1).await;
    let shown: Vec<String> = h.ch.drafts().into_iter().map(|(_, t)| t).collect();
    assert_eq!(
        shown,
        vec![
            "Choosing a model…",
            "Thinking…",
            "Working…",
            "Trying another model…",
            "Here",
            // A phase after text leaves the text standing; a restart clears it.
            "Thinking…",
            "Again",
        ]
    );
    // Typing went out before the first draft; the draft is cleared after delivery.
    let calls = h.ch.calls();
    let typing = calls.iter().position(|c| c.what == What::Typing).unwrap();
    let first = calls
        .iter()
        .position(|c| matches!(c.what, What::Draft(Some(_))))
        .unwrap();
    assert!(typing <= first);
    let sent = calls
        .iter()
        .position(|c| c.what == What::Send("Again".into()))
        .unwrap();
    assert!(calls[sent..].iter().any(|c| c.what == What::Draft(None)));
    h.stop().await;
}

// ---- SP-09 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spans_cover_the_turn() {
    let h = start(
        cfg(20),
        vec![Script::new(
            vec![],
            50,
            Outcome::Text(
                "done",
                Lane::Task,
                vec![Span {
                    name: "bridge",
                    start: 5,
                    ms: 40,
                }],
            ),
        )],
    );
    let mut events = h.bus.subscribe();
    h.push(vec![msg("a", "7", "do it")]);
    until("the spans", || {
        let rows = h.store.last_turns(10).unwrap();
        ["ack", "merge", "brain", "bridge", "deliver"]
            .iter()
            .all(|n| rows.iter().any(|r| r.name == *n))
    })
    .await;
    let rows = h.store.last_turns(10).unwrap();
    assert!(rows.iter().all(|r| r.turn == "fake:a:7"), "{rows:?}");
    assert!(rows.iter().all(|r| r.lane == "task"));
    // `at` is the receipt time; every `start` is ms after it (the test runs well under 30 s).
    let at = rows[0].at;
    assert!(
        rows.iter()
            .all(|r| r.at == at && (0..30_000).contains(&r.start)),
        "{rows:?}"
    );
    let named = |n: &str| rows.iter().find(|r| r.name == n).unwrap();
    assert_eq!(named("merge").start, 0);
    assert!(
        named("brain").start >= 20,
        "brain starts after the merge window"
    );
    assert!(named("deliver").start >= named("brain").start + 50);
    let brain = rows.iter().find(|r| r.name == "brain").unwrap();
    let bridge = rows.iter().find(|r| r.name == "bridge").unwrap();
    assert_eq!(bridge.start, brain.start + 5, "brain spans not shifted");
    assert_eq!(bridge.ms, 40);
    assert!(rows.iter().all(|r| r.name != "hear" && r.name != "speak"));

    let mut saw = (false, false);
    while saw != (true, true) {
        let ev = tokio::time::timeout(Duration::from_secs(30), events.recv())
            .await
            .expect("bus events")
            .unwrap();
        match &*ev {
            Event::Received { .. } => saw.0 = true,
            Event::Delivered { lane, spans, .. } => {
                assert!(saw.0, "Delivered before Received");
                assert_eq!(*lane, Lane::Task);
                assert!(spans.iter().any(|s| s.name == "deliver"));
                saw.1 = true;
            }
            _ => {}
        }
    }
    h.stop().await;
}

// ---- Say ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn say_goes_to_primary_chat() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    store.channel_session("fake", "home").unwrap();
    store.channel_session("fake", "other").unwrap();
    let h = start_with(cfg(20), vec![], store);
    // Let the gateway subscribe.
    sleep(Duration::from_millis(100)).await;
    h.bus.publish(Event::Say {
        at: 0,
        text: "Your train leaves in 10 minutes.".into(),
        urgency: alexia_core::Urgency::Normal,
        job: None,
    });
    until("the say", || !h.ch.sent().is_empty()).await;
    let calls = h.ch.calls();
    let sends: Vec<_> = calls
        .iter()
        .filter(|c| matches!(c.what, What::Send(_)))
        .collect();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].chat, "home");
    assert_eq!(
        sends[0].what,
        What::Send("Your train leaves in 10 minutes.".into())
    );
    h.stop().await;
}

// ---- errors ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unavailable_sentence_is_sent() {
    let h = start(
        cfg(20),
        vec![Script::new(
            vec![],
            0,
            Outcome::Unavailable("No model is free right now."),
        )],
    );
    h.push(vec![msg("a", "1", "hi")]);
    until("the sentence", || !h.ch.sent().is_empty()).await;
    assert_eq!(h.ch.sent(), vec!["No model is free right now.".to_string()]);
    h.stop().await;
}

// ---- shutdown ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_within_3s() {
    // A brain that ignores its cancel token: the gateway must still return.
    let mut stuck = Script::new(vec![], 60_000, chat_reply("never"));
    stuck.ignore_cancel = true;
    let h = start(cfg(20), vec![stuck]);
    h.push(vec![msg("a", "1", "hi")]);
    until("the turn", || h.brain.calls() == 1).await;
    let t = Instant::now();
    h.cancel.cancel();
    let r = tokio::time::timeout(Duration::from_secs(30), h.run).await;
    let took = t.elapsed();
    assert!(matches!(r, Ok(Ok(Ok(())))));
    assert!(took < Duration::from_millis(4_000), "took {took:?}");
    assert!(!h.ch.sent().contains(&"never".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_channel_call_after_run_returns() {
    let h = start(
        cfg(20),
        vec![Script::new(vec![], 60_000, chat_reply("never"))],
    );
    *h.ch.delay.lock().unwrap() = Duration::from_millis(800);
    h.push(vec![msg("a", "1", "hi")]);
    // Both the reaction and the first typing call are in flight.
    until("the turn and slow calls", || {
        h.brain.calls() == 1 && h.ch.in_flight.load(Ordering::SeqCst) >= 2
    })
    .await;
    h.cancel.cancel();
    let r = tokio::time::timeout(Duration::from_secs(30), h.run).await;
    assert!(matches!(r, Ok(Ok(Ok(())))));
    assert_eq!(h.ch.in_flight.load(Ordering::SeqCst), 0);
    let calls = h.ch.calls();
    assert!(calls.iter().any(|c| c.what == What::React("1".into())));
    assert!(calls.iter().any(|c| c.what == What::Typing));
    sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        h.ch.calls().len(),
        calls.len(),
        "a channel call after run returned"
    );
}

// ---- documents (P1-26) ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn documents_reach_the_brain_voice_does_not() {
    let h = start(cfg(20), vec![]);
    let mut m = msg("a", "1", "read this");
    m.files = vec![
        InFile {
            name: "report.pdf".into(),
            mime: "application/pdf".into(),
            path: "no-such-dir/report.pdf".into(),
        },
        InFile {
            name: "voice.ogg".into(),
            mime: "audio/ogg".into(),
            path: "no-such-dir/voice.ogg".into(),
        },
    ];
    h.push(vec![m]);
    until("the brain call", || h.brain.calls() == 1).await;
    {
        let turns = h.brain.turns.lock().unwrap();
        let files = &turns[0].files;
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files[0].name, "report.pdf");
        assert_eq!(files[0].mime, "application/pdf");
    }
    h.stop().await;
}
