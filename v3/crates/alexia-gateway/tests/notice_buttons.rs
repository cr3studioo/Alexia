// SPDX-License-Identifier: AGPL-3.0-only
//! P3-12: notices reach the right chat with buttons; answers go back as `Event::Feedback`;
//! every owner message publishes `Event::Active`.
//!
//! Real time throughout; every wait is bounded by 30 s.

use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_core::{
    Brain, BrainError, Budget, Bus, DraftSink, Event, Lane, Origin, Reply, Turn, Urgency, Verdict,
};
use alexia_gateway::{
    Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InKind, Inbound, Media, MsgRef,
    Outbound, Result,
};
use alexia_store::{now_ms, Content, NewNotice, Store};
use tokio::sync::broadcast::Receiver;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;

// ---- fake channel ----

#[derive(Clone, Debug, PartialEq)]
enum What {
    Send(String),
    Notify(String, Vec<(String, String)>),
    React(String, String),
}

#[derive(Clone, Debug)]
struct Call {
    chat: String,
    what: What,
    /// The id this call's message was given (sends and notifies).
    sent_id: Option<String>,
}

struct Fake {
    name: &'static str,
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    log: Mutex<Vec<Call>>,
    next_id: AtomicUsize,
}

impl Fake {
    fn calls(&self) -> Vec<Call> {
        self.log.lock().unwrap().clone()
    }
    fn note(&self, chat: &str, what: What, sent_id: Option<String>) {
        self.log.lock().unwrap().push(Call {
            chat: chat.to_string(),
            what,
            sent_id,
        });
    }
    fn fresh(&self) -> String {
        format!("m{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1)
    }
    /// Sends and notifies, as (chat, text).
    fn said(&self) -> Vec<(String, String)> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c.what {
                What::Send(t) | What::Notify(t, _) => Some((c.chat, t)),
                What::React(..) => None,
            })
            .collect()
    }
    fn reacts(&self) -> Vec<(String, String)> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c.what {
                What::React(m, e) => Some((m, e)),
                _ => None,
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl Channel for Fake {
    fn name(&self) -> &'static str {
        self.name
    }
    fn budget(&self) -> Budget {
        Budget::CHAT
    }
    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>> {
        let mut inbox = self.inbox.lock().await;
        tokio::select! {
            _ = cancel.cancelled() => Err(Error::Cancelled),
            b = inbox.recv() => match b {
                Some(b) => Ok(b),
                None => {
                    cancel.cancelled().await;
                    Err(Error::Cancelled)
                }
            },
        }
    }
    async fn react(&self, chat: &ChatRef, msg: &MsgRef, emoji: &str) -> Result<()> {
        // The instant "seen" reaction of an ordinary message is not what these tests count.
        if emoji != "👀" {
            self.note(
                &chat.chat,
                What::React(msg.id.clone(), emoji.to_string()),
                None,
            );
        }
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> Result<()> {
        Ok(())
    }
    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        let id = self.fresh();
        self.note(&chat.chat, What::Send(out.text.clone()), Some(id.clone()));
        Ok(MsgRef { id })
    }
    async fn notify(
        &self,
        chat: &ChatRef,
        text: &str,
        buttons: &[(String, String)],
    ) -> Result<MsgRef> {
        let id = self.fresh();
        self.note(
            &chat.chat,
            What::Notify(text.to_string(), buttons.to_vec()),
            Some(id.clone()),
        );
        Ok(MsgRef { id })
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

struct NoMedia;

#[async_trait::async_trait]
impl Media for NoMedia {
    async fn transcribe(
        &self,
        _: &alexia_gateway::InFile,
        _: CancellationToken,
    ) -> Result<Option<String>> {
        Ok(None)
    }
    async fn speak(&self, _: &str, _: CancellationToken) -> Result<Option<alexia_core::OutFile>> {
        Ok(None)
    }
}

#[derive(Default)]
struct Brainy {
    turns: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Brain for Brainy {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        let text = match turn.content {
            Content::Text(t) => t,
            Content::Parts(_) => "<parts>".into(),
        };
        self.turns.lock().unwrap().push(text);
        Ok(Reply {
            text: "ok".into(),
            files: vec![],
            lane: Lane::Chat,
            model: None,
            spans: vec![],
        })
    }
}

// ---- harness ----

struct H {
    /// The first channel, "fake", primary chat "home".
    fake: Arc<Fake>,
    /// The second channel, "other", primary chat "o-home".
    other: Arc<Fake>,
    inbox: mpsc::UnboundedSender<Vec<Inbound>>,
    brain: Arc<Brainy>,
    store: Arc<Store>,
    bus: Bus,
    cancel: CancellationToken,
    run: JoinHandle<Result<()>>,
}

fn fake(name: &'static str) -> (Arc<Fake>, mpsc::UnboundedSender<Vec<Inbound>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let f = Arc::new(Fake {
        name,
        inbox: tokio::sync::Mutex::new(rx),
        log: Mutex::new(Vec::new()),
        next_id: AtomicUsize::new(0),
    });
    (f, tx)
}

async fn start() -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    store.channel_session("fake", "home").unwrap();
    store.set_primary_chat("fake", "home").unwrap();
    store.channel_session("other", "o-home").unwrap();
    store.set_primary_chat("other", "o-home").unwrap();
    let (fake, inbox) = fake("fake");
    let (other, _keep) = fake_other();
    let brain = Arc::new(Brainy::default());
    let bus = Bus::new(256);
    let channels = ChannelSet::new();
    channels.add(fake.clone());
    channels.add(other.clone());
    let gw = Gateway::with_channels(
        GatewayConfig {
            merge_ms: 20,
            ..GatewayConfig::default()
        },
        store.clone(),
        bus.clone(),
        brain.clone(),
        Arc::new(NoMedia),
        channels,
    );
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.run(cancel.clone()));
    // Let the gateway subscribe to the bus.
    sleep(Duration::from_millis(200)).await;
    H {
        fake,
        other,
        inbox,
        brain,
        store,
        bus,
        cancel,
        run,
    }
}

fn fake_other() -> (Arc<Fake>, mpsc::UnboundedSender<Vec<Inbound>>) {
    fake("other")
}

impl H {
    fn push(&self, m: Inbound) {
        self.inbox.send(vec![m]).unwrap();
    }
    async fn stop(self) {
        self.cancel.cancel();
        let r = tokio::time::timeout(Duration::from_secs(30), self.run).await;
        assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
    }
    fn notice(&self, source: &str) -> i64 {
        let n = NewNotice {
            key: "k:1",
            source,
            text: "The bin goes out tonight.",
            why: "You put it in your notes on Monday.",
            urgency: "normal",
            due_at: None,
            not_before: None,
        };
        self.store.notice_upsert(&n, now_ms()).unwrap().0
    }
    fn say(&self, text: &str, urgency: Urgency, notice: Option<i64>, to: Option<Origin>) {
        self.bus.publish(Event::Say {
            at: 0,
            text: text.into(),
            urgency,
            job: None,
            notice,
            to,
        });
    }
}

fn inbound(chat: &str, id: &str, text: &str) -> Inbound {
    Inbound {
        chat: ChatRef { chat: chat.into() },
        msg: MsgRef { id: id.into() },
        kind: InKind::Message,
        from_owner: true,
        content: Content::Text(text.into()),
        files: vec![],
        at: 0,
        button: None,
        reply_to: None,
    }
}

fn pressed(chat: &str, msg: &str, data: &str) -> Inbound {
    Inbound {
        button: Some(data.into()),
        content: Content::Text(String::new()),
        ..inbound(chat, msg, "")
    }
}

fn reply_to(chat: &str, id: &str, text: &str, to: &str) -> Inbound {
    Inbound {
        reply_to: Some(MsgRef { id: to.into() }),
        ..inbound(chat, id, text)
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        sleep(Duration::from_millis(5)).await;
    }
}

/// The next event `pick` accepts, within 30 s.
async fn event<T>(rx: &mut Receiver<Arc<Event>>, pick: impl Fn(&Event) -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        let left = end.saturating_duration_since(Instant::now());
        let ev = tokio::time::timeout(left, rx.recv())
            .await
            .expect("timed out waiting for an event")
            .expect("the bus closed");
        if let Some(t) = pick(&ev) {
            return t;
        }
    }
}

fn feedback(ev: &Event) -> Option<(i64, Verdict)> {
    match ev {
        Event::Feedback {
            notice, verdict, ..
        } => Some((*notice, *verdict)),
        _ => None,
    }
}

// ---- say ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn say_with_notice_has_buttons() {
    let h = start().await;
    let id = h.notice("watch");
    h.say("The bin goes out tonight.", Urgency::Normal, Some(id), None);
    until("the notice", || !h.fake.said().is_empty()).await;
    let calls = h.fake.calls();
    let What::Notify(text, buttons) = &calls[0].what else {
        panic!("not a notify: {:?}", calls[0]);
    };
    assert_eq!(calls[0].chat, "home");
    assert_eq!(text, "The bin goes out tonight.");
    let want: Vec<(String, String)> = [
        ("Thanks", "useful"),
        ("Not useful", "not"),
        ("Later", "later"),
        ("Why?", "why"),
        ("Done", "done"),
    ]
    .iter()
    .map(|(l, v)| (l.to_string(), format!("n:{id}:{v}")))
    .collect();
    assert_eq!(buttons, &want);
    assert!(buttons.iter().all(|(_, d)| d.len() <= 64));
    // The message is remembered, so a reply to it can be matched.
    let key = format!(
        "notice_msg.fake.home.{}",
        calls[0].sent_id.as_ref().unwrap()
    );
    assert_eq!(h.store.kv_get("_core", &key).unwrap(), Some(id.into()));

    // A pattern is nothing to do: no Done.
    let pattern = h
        .store
        .notice_upsert(
            &NewNotice {
                key: "k:2",
                source: "pattern",
                text: "You usually call Mum now.",
                why: "You did the last four Sundays.",
                urgency: "low",
                due_at: None,
                not_before: None,
            },
            now_ms(),
        )
        .unwrap()
        .0;
    h.say(
        "You usually call Mum now.",
        Urgency::Low,
        Some(pattern),
        None,
    );
    until("the pattern", || h.fake.said().len() == 2).await;
    let What::Notify(_, buttons) = &h.fake.calls()[1].what else {
        panic!("not a notify");
    };
    let labels: Vec<&str> = buttons.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(labels, ["Thanks", "Not useful", "Later", "Why?"]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn say_without_notice_is_plain() {
    let h = start().await;
    h.say("Your train leaves soon.", Urgency::Normal, None, None);
    until("the say", || !h.fake.said().is_empty()).await;
    assert_eq!(
        h.fake.calls()[0].what,
        What::Send("Your train leaves soon.".into())
    );
    // Nothing is remembered for a plain message.
    assert_eq!(h.store.kv_get("_core", "notice_msg_index").unwrap(), None);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn say_to_names_one_chat() {
    let h = start().await;
    h.say(
        "For the other one.",
        Urgency::Normal,
        None,
        Some(Origin::Channel {
            channel: "other".into(),
            chat: "side-chat".into(),
        }),
    );
    until("the say", || !h.other.said().is_empty()).await;
    assert_eq!(
        h.other.said(),
        [("side-chat".to_string(), "For the other one.".to_string())]
    );
    // The window and desktop have nothing unprompted: they mean the primaries. (Sent after the
    // named one, so by the time it shows, a wrongly sent first message would show too.)
    h.say(
        "To the window.",
        Urgency::Normal,
        None,
        Some(Origin::Window),
    );
    until("the window say", || h.fake.said().len() == 1).await;
    until("the window say, other", || h.other.said().len() == 2).await;
    assert_eq!(
        h.fake.said(),
        [("home".to_string(), "To the window.".to_string())]
    );
    // A channel that is not configured also falls back to the primaries.
    h.say(
        "Nobody home there.",
        Urgency::Normal,
        None,
        Some(Origin::Channel {
            channel: "nope".into(),
            chat: "x".into(),
        }),
    );
    until("the fallback", || h.fake.said().len() == 2).await;
    assert_eq!(h.fake.said()[1].0, "home");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn say_to_none_goes_to_primaries() {
    let h = start().await;
    h.say("Everyone.", Urgency::Normal, None, None);
    until("both say", || {
        !h.fake.said().is_empty() && !h.other.said().is_empty()
    })
    .await;
    assert_eq!(
        h.fake.said(),
        [("home".to_string(), "Everyone.".to_string())]
    );
    assert_eq!(
        h.other.said(),
        [("o-home".to_string(), "Everyone.".to_string())]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn urgent_prefix() {
    let h = start().await;
    for (u, text) in [
        (Urgency::Low, "low"),
        (Urgency::Normal, "normal"),
        (Urgency::High, "high"),
        (Urgency::Urgent, "urgent"),
    ] {
        h.say(text, u, None, None);
    }
    until("four says", || h.fake.said().len() == 4).await;
    let texts: Vec<String> = h.fake.said().into_iter().map(|(_, t)| t).collect();
    assert_eq!(texts, ["low", "normal", "❗ high", "‼️ urgent"]);
    h.stop().await;
}

// ---- buttons ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn button_later_publishes_feedback_and_answers_time() {
    let h = start().await;
    let id = h.notice("watch");
    let mut rx = h.bus.subscribe();
    let before = now_ms();
    h.push(pressed("home", "m1", &format!("n:{id}:later")));
    let (n, verdict) = event(&mut rx, feedback).await;
    assert_eq!(n, id);
    let Verdict::Later { until: at } = verdict else {
        panic!("not Later: {verdict:?}");
    };
    let three_hours = 3 * 60 * 60 * 1000;
    assert!(at >= before + three_hours && at <= now_ms() + three_hours);
    until("the answer", || !h.fake.said().is_empty()).await;
    let (chat, text) = h.fake.said().remove(0);
    assert_eq!(chat, "home");
    assert!(
        text.starts_with("I'll bring it up again at ") && text.ends_with(" UTC."),
        "{text}"
    );
    // A button is no turn.
    sleep(Duration::from_millis(300)).await;
    assert!(h.brain.turns.lock().unwrap().is_empty());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn button_why_answers_with_why() {
    let h = start().await;
    let id = h.notice("watch");
    let mut rx = h.bus.subscribe();
    h.push(pressed("home", "m1", &format!("n:{id}:why")));
    let (n, verdict) = event(&mut rx, feedback).await;
    assert_eq!((n, verdict), (id, Verdict::Seen));
    until("the answer", || !h.fake.said().is_empty()).await;
    assert_eq!(
        h.fake.said(),
        [(
            "home".to_string(),
            "You put it in your notes on Monday.".to_string()
        )]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn buttons_map_to_verdicts() {
    let h = start().await;
    let id = h.notice("watch");
    let mut rx = h.bus.subscribe();
    for (verb, want) in [
        ("useful", Verdict::Useful),
        ("not", Verdict::NotUseful),
        ("done", Verdict::Done),
        ("seen", Verdict::Seen),
    ] {
        h.push(pressed("home", "m1", &format!("n:{id}:{verb}")));
        assert_eq!(event(&mut rx, feedback).await, (id, want), "{verb}");
    }
    // Nothing was said back for these.
    assert!(h.fake.said().is_empty());
    h.stop().await;
}

// ---- replies ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reply_done_to_notice_is_feedback_not_a_turn() {
    let h = start().await;
    let id = h.notice("watch");
    h.say("The bin goes out tonight.", Urgency::Normal, Some(id), None);
    until("the notice", || !h.fake.said().is_empty()).await;
    let sent = h.fake.calls()[0].sent_id.clone().unwrap();
    let mut rx = h.bus.subscribe();

    h.push(reply_to("home", "u1", "  Done ", &sent));
    assert_eq!(event(&mut rx, feedback).await, (id, Verdict::Done));
    until("the thumbs up", || {
        h.fake.reacts() == [("u1".to_string(), "👍".to_string())]
    })
    .await;

    h.push(reply_to("home", "u2", "stop these", &sent));
    assert_eq!(event(&mut rx, feedback).await, (id, Verdict::Mute));
    h.push(reply_to("home", "u3", "Hotovo", &sent));
    assert_eq!(event(&mut rx, feedback).await, (id, Verdict::Done));
    h.push(reply_to("home", "u4", "díky", &sent));
    assert_eq!(event(&mut rx, feedback).await, (id, Verdict::Useful));

    // None of them reached the brain.
    sleep(Duration::from_millis(300)).await;
    assert!(h.brain.turns.lock().unwrap().is_empty());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn long_reply_goes_to_brain() {
    let h = start().await;
    let id = h.notice("watch");
    h.say("The bin goes out tonight.", Urgency::Normal, Some(id), None);
    until("the notice", || !h.fake.said().is_empty()).await;
    let sent = h.fake.calls()[0].sent_id.clone().unwrap();
    let mut rx = h.bus.subscribe();

    h.push(reply_to(
        "home",
        "u1",
        "done, but also move my 3pm please",
        &sent,
    ));
    until("the turn", || h.brain.turns.lock().unwrap().len() == 1).await;
    assert_eq!(
        h.brain.turns.lock().unwrap()[0],
        "done, but also move my 3pm please"
    );
    // A short word that replies to something else is a plain message too.
    h.push(reply_to("home", "u2", "done", "not-a-notice"));
    until("the second turn", || {
        h.brain.turns.lock().unwrap().len() == 2
    })
    .await;
    // And no feedback was published for either.
    while let Ok(ev) = rx.try_recv() {
        assert!(feedback(&ev).is_none(), "unexpected feedback: {ev:?}");
    }
    h.stop().await;
}

// ---- active ----

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_message_publishes_active() {
    let h = start().await;
    let mut rx = h.bus.subscribe();
    h.push(inbound("home", "1", "hello"));
    let via = event(&mut rx, |e| match e {
        Event::Active { via, .. } => Some(via.clone()),
        _ => None,
    })
    .await;
    assert_eq!(via, "fake");
    // A button is a sign of the owner too.
    let id = h.notice("watch");
    h.push(pressed("home", "m1", &format!("n:{id}:seen")));
    let via = event(&mut rx, |e| match e {
        Event::Active { via, .. } => Some(via.clone()),
        _ => None,
    })
    .await;
    assert_eq!(via, "fake");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpaired_chats_publish_nothing() {
    let h = start().await;
    let mut rx = h.bus.subscribe();
    let stranger = Inbound {
        from_owner: false,
        ..inbound("stranger", "1", "let me in")
    };
    let stranger_button = Inbound {
        from_owner: false,
        ..pressed("stranger", "2", "n:1:done")
    };
    h.inbox.send(vec![stranger, stranger_button]).unwrap();
    // The owner's message comes after them, so once its Active shows, theirs were seen.
    h.push(inbound("home", "3", "hello"));
    let actives = Cell::new(0);
    let feedbacks = Cell::new(0);
    let drain = |rx: &mut Receiver<Arc<Event>>| {
        while let Ok(ev) = rx.try_recv() {
            match &*ev {
                Event::Active { .. } => actives.set(actives.get() + 1),
                Event::Feedback { .. } => feedbacks.set(feedbacks.get() + 1),
                _ => {}
            }
        }
    };
    let end = Instant::now() + Duration::from_secs(30);
    while actives.get() < 1 {
        assert!(
            Instant::now() < end,
            "timed out waiting for the owner's message"
        );
        sleep(Duration::from_millis(5)).await;
        drain(&mut rx);
    }
    sleep(Duration::from_millis(300)).await;
    drain(&mut rx);
    assert_eq!((actives.get(), feedbacks.get()), (1, 0));
    assert_eq!(h.brain.turns.lock().unwrap().len(), 1);
    h.stop().await;
}
