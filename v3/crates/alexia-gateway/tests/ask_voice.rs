// SPDX-License-Identifier: AGPL-3.0-only
//! P1-12: approvals (CH-07) and voice notes (CH-05), through the public `Gateway` API.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use alexia_core::{
    Ask, Brain, BrainError, Budget, Bus, DraftSink, JobId, Lane, Origin, OutFile, Question, Reply,
    RunId, Turn,
};
use alexia_gateway::{
    Asker, Channel, ChannelSet, ChatRef, Error, Gateway, GatewayConfig, InFile, InKind, Inbound,
    Media, MsgRef, Outbound, Result,
};
use alexia_store::{Content, Store};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;

// ---- fake channel ----

#[derive(Clone, Copy)]
enum Answer {
    Yes,
    No,
    /// Never answers; returns `None` once cancelled.
    Hang,
}

struct FakeChannel {
    inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<Inbound>>>,
    answer: Answer,
    asks: Mutex<Vec<(String, String)>>,
    sent: Mutex<Vec<(String, Outbound)>>,
}

impl FakeChannel {
    fn asks(&self) -> Vec<(String, String)> {
        self.asks.lock().unwrap().clone()
    }
    fn sent(&self) -> Vec<(String, Outbound)> {
        self.sent.lock().unwrap().clone()
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
                Some(b) => Ok(b),
                None => {
                    cancel.cancelled().await;
                    Err(Error::Cancelled)
                }
            },
        }
    }
    async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn typing(&self, _: &ChatRef) -> Result<()> {
        Ok(())
    }
    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        self.sent
            .lock()
            .unwrap()
            .push((chat.chat.clone(), out.clone()));
        Ok(MsgRef { id: "sent".into() })
    }
    async fn draft(&self, _: &ChatRef, _: Option<&str>) -> Result<()> {
        Ok(())
    }
    async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> Result<()> {
        Ok(())
    }
    async fn ask(
        &self,
        chat: &ChatRef,
        text: &str,
        cancel: CancellationToken,
    ) -> Result<Option<bool>> {
        self.asks
            .lock()
            .unwrap()
            .push((chat.chat.clone(), text.to_string()));
        match self.answer {
            Answer::Yes => Ok(Some(true)),
            Answer::No => Ok(Some(false)),
            Answer::Hang => {
                cancel.cancelled().await;
                Ok(None)
            }
        }
    }
}

// ---- fake media ----

struct FakeMedia {
    heard: Option<&'static str>,
    spoke: Mutex<Vec<String>>,
    /// Transcription waits for its token instead of answering.
    slow: bool,
    started: std::sync::atomic::AtomicBool,
    cancelled: std::sync::atomic::AtomicBool,
}

fn ogg() -> OutFile {
    OutFile {
        name: "reply.ogg".into(),
        mime: "audio/ogg".into(),
        path: PathBuf::from("reply.ogg"),
    }
}

#[async_trait::async_trait]
impl Media for FakeMedia {
    async fn transcribe(
        &self,
        _file: &InFile,
        cancel: CancellationToken,
    ) -> Result<Option<String>> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.slow {
            self.started.store(true, SeqCst);
            // The gateway may drop this future the moment Stop lands; the guard still sees it.
            struct Seen<'a>(&'a std::sync::atomic::AtomicBool, &'a CancellationToken);
            impl Drop for Seen<'_> {
                fn drop(&mut self) {
                    if self.1.is_cancelled() {
                        self.0.store(true, SeqCst);
                    }
                }
            }
            let _seen = Seen(&self.cancelled, &cancel);
            cancel.cancelled().await;
            return Err(Error::Cancelled);
        }
        Ok(self.heard.map(str::to_string))
    }
    async fn speak(&self, text: &str, _: CancellationToken) -> Result<Option<OutFile>> {
        self.spoke.lock().unwrap().push(text.to_string());
        Ok(Some(ogg()))
    }
}

// ---- fake brain ----

/// Records each turn; asks the gateway's asker first when `ask` is set, and replies "yes"/"no",
/// else replies `text`.
struct FakeBrain {
    asker: OnceLock<Arc<dyn Ask>>,
    ask: bool,
    text: String,
    turns: Mutex<Vec<Turn>>,
}

#[async_trait::async_trait]
impl Brain for FakeBrain {
    async fn reply(
        &self,
        turn: Turn,
        _draft: DraftSink,
        cancel: CancellationToken,
    ) -> std::result::Result<Reply, BrainError> {
        let origin = turn.origin.clone();
        self.turns.lock().unwrap().push(turn);
        let text = if self.ask {
            let q = Question {
                run: RunId("run-1".into()),
                text: "Buy it?".into(),
                detail: Some("£12".into()),
            };
            let asker = self.asker.get().expect("asker set").clone();
            if asker.confirm(&origin, &q, cancel).await {
                "yes".to_string()
            } else {
                "no".to_string()
            }
        } else {
            self.text.clone()
        };
        Ok(Reply {
            text,
            files: vec![],
            lane: Lane::Chat,
            model: None,
            spans: vec![],
        })
    }
}

// ---- harness ----

struct H {
    ch: Arc<FakeChannel>,
    media: Arc<FakeMedia>,
    brain: Arc<FakeBrain>,
    asker: Arc<dyn Ask>,
    inbox: mpsc::UnboundedSender<Vec<Inbound>>,
    cancel: CancellationToken,
    run: JoinHandle<Result<()>>,
}

struct Setup {
    answer: Answer,
    ask: bool,
    reply: String,
    heard: Option<&'static str>,
    voice_replies: Option<&'static str>,
    /// A primary chat on the "fake" channel, set before the gateway starts.
    primary: Option<&'static str>,
    slow_media: bool,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            answer: Answer::Yes,
            ask: false,
            reply: "ok".into(),
            heard: Some("hello"),
            voice_replies: None,
            primary: None,
            slow_media: false,
        }
    }
}

fn start(s: Setup) -> H {
    let store = Arc::new(Store::open_in_memory().unwrap());
    if let Some(v) = s.voice_replies {
        store
            .kv_set("_core", "voice_replies", &serde_json::json!(v))
            .unwrap();
    }
    if let Some(chat) = s.primary {
        store.channel_session("fake", chat).unwrap();
        store.set_primary_chat("fake", chat).unwrap();
    }
    let (inbox, rx) = mpsc::unbounded_channel();
    let ch = Arc::new(FakeChannel {
        inbox: tokio::sync::Mutex::new(rx),
        answer: s.answer,
        asks: Mutex::new(Vec::new()),
        sent: Mutex::new(Vec::new()),
    });
    let media = Arc::new(FakeMedia {
        heard: s.heard,
        spoke: Mutex::new(Vec::new()),
        slow: s.slow_media,
        started: Default::default(),
        cancelled: Default::default(),
    });
    let brain = Arc::new(FakeBrain {
        asker: OnceLock::new(),
        ask: s.ask,
        text: s.reply,
        turns: Mutex::new(Vec::new()),
    });
    let bus = Bus::new(64);
    let channels = ChannelSet::new();
    channels.add(ch.clone());
    let asker: Arc<dyn Ask> = Asker::new(channels.clone(), store.clone(), bus.clone());
    let _ = brain.asker.set(asker.clone());
    let gw = Gateway::with_channels(
        GatewayConfig {
            merge_ms: 10,
            ..GatewayConfig::default()
        },
        store,
        bus,
        brain.clone(),
        media.clone(),
        channels,
    );
    let cancel = CancellationToken::new();
    let run = tokio::spawn(gw.run(cancel.clone()));
    H {
        ch,
        media,
        brain,
        asker,
        inbox,
        cancel,
        run,
    }
}

impl H {
    fn push(&self, m: Inbound) {
        self.inbox.send(vec![m]).unwrap();
    }
    fn turn_texts(&self) -> Vec<String> {
        self.brain
            .turns
            .lock()
            .unwrap()
            .iter()
            .map(|t| match &t.content {
                Content::Text(t) => t.clone(),
                Content::Parts(_) => "<parts>".into(),
            })
            .collect()
    }
    /// The first message sent to `chat`, waiting at most 30 s.
    async fn reply_in(&self, chat: &str) -> Outbound {
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some((_, out)) = self.ch.sent().into_iter().find(|(c, _)| c == chat) {
                return out;
            }
            assert!(Instant::now() < end, "timed out waiting for a reply");
            sleep(Duration::from_millis(5)).await;
        }
    }
    async fn stop(self) {
        self.cancel.cancel();
        let r = tokio::time::timeout(Duration::from_secs(30), self.run).await;
        assert!(matches!(r, Ok(Ok(Ok(())))), "the gateway did not stop");
    }
}

fn msg(chat: &str, text: &str) -> Inbound {
    Inbound {
        chat: ChatRef { chat: chat.into() },
        msg: MsgRef { id: "1".into() },
        kind: InKind::Message,
        from_owner: true,
        content: Content::Text(text.into()),
        files: vec![],
        at: 0,
        button: None,
        reply_to: None,
    }
}

fn voice_note(chat: &str) -> Inbound {
    Inbound {
        content: Content::Text(String::new()),
        files: vec![InFile {
            name: "note.oga".into(),
            mime: "audio/ogg".into(),
            path: PathBuf::from("note.oga"),
        }],
        ..msg(chat, "")
    }
}

fn question() -> Question {
    Question {
        run: RunId("run-7".into()),
        text: "Delete the old backups?".into(),
        detail: None,
    }
}

fn in_chat(chat: &str) -> Origin {
    Origin::Channel {
        channel: "fake".into(),
        chat: chat.into(),
    }
}

// ---- CH-07 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn approval_appears_in_the_turns_chat_and_yes_is_true() {
    let h = start(Setup {
        ask: true,
        answer: Answer::Yes,
        ..Setup::default()
    });
    h.push(msg("chat-a", "buy the book"));
    let out = h.reply_in("chat-a").await;
    assert_eq!(out.text, "yes", "the brain did not see the approval");
    assert_eq!(
        h.ch.asks(),
        vec![("chat-a".to_string(), "Buy it?\n\n£12 (#1)".to_string())]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deny_and_timeout_are_false() {
    // Deny, through a turn.
    let h = start(Setup {
        ask: true,
        answer: Answer::No,
        ..Setup::default()
    });
    h.push(msg("chat-a", "buy the book"));
    assert_eq!(h.reply_in("chat-a").await.text, "no");
    assert_eq!(h.ch.asks().len(), 1);
    h.stop().await;

    // An owner who never answers: the run is cancelled, the answer is no.
    let h = start(Setup {
        answer: Answer::Hang,
        ..Setup::default()
    });
    let cancel = CancellationToken::new();
    let (asker, c) = (h.asker.clone(), cancel.clone());
    let pending = tokio::spawn(async move { asker.confirm(&in_chat("x"), &question(), c).await });
    let end = Instant::now() + Duration::from_secs(30);
    while h.ch.asks().is_empty() {
        assert!(Instant::now() < end, "never asked");
        sleep(Duration::from_millis(5)).await;
    }
    cancel.cancel();
    let r = tokio::time::timeout(Duration::from_secs(30), pending).await;
    assert!(!r.expect("confirm hung").unwrap());
    h.stop().await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn unanswered_approval_gives_up_after_ten_minutes() {
    let h = start(Setup {
        answer: Answer::Hang,
        ..Setup::default()
    });
    let asker = h.asker.clone();
    let pending = tokio::spawn(async move {
        asker
            .confirm(&in_chat("x"), &question(), CancellationToken::new())
            .await
    });
    while h.ch.asks().is_empty() {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(9 * 60 + 59)).await;
    tokio::task::yield_now().await;
    assert!(!pending.is_finished(), "gave up before ten minutes");
    assert!(h.ch.sent().is_empty(), "sent something before ten minutes");
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert!(pending.is_finished(), "still waiting after ten minutes");
    assert!(!pending.await.unwrap());
    let sent = h.ch.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "x");
    assert_eq!(sent[0].1.text, "— no answer, so I didn't");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduled_job_asks_in_the_primary_chat() {
    let origin = Origin::Scheduler { job: JobId(1) };
    let h = start(Setup {
        primary: Some("chat-p"),
        ..Setup::default()
    });
    assert!(
        h.asker
            .confirm(&origin, &question(), CancellationToken::new())
            .await
    );
    assert_eq!(
        h.ch.asks(),
        vec![(
            "chat-p".to_string(),
            "Delete the old backups? (#1)".to_string()
        )]
    );
    h.stop().await;

    // No primary chat: nowhere to ask, so no.
    let h = start(Setup::default());
    assert!(
        !h.asker
            .confirm(&origin, &question(), CancellationToken::new())
            .await
    );
    assert!(h.ch.asks().is_empty());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_origin_is_false() {
    let h = start(Setup::default());
    let q = question();
    assert!(
        !h.asker
            .confirm(&Origin::Desktop, &q, CancellationToken::new())
            .await
    );
    // A channel this gateway does not have is no, too.
    let other = Origin::Channel {
        channel: "whatsapp".into(),
        chat: "x".into(),
    };
    assert!(!h.asker.confirm(&other, &q, CancellationToken::new()).await);
    assert!(h.ch.asks().is_empty(), "asked somewhere it should not");
    h.stop().await;
}

// ---- CH-05 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn voice_note_is_transcribed_before_the_brain() {
    let h = start(Setup::default());
    h.push(voice_note("v"));
    h.reply_in("v").await;
    assert_eq!(h.turn_texts(), vec!["hello".to_string()]);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_transcriber_is_honest() {
    let h = start(Setup {
        heard: None,
        ..Setup::default()
    });
    h.push(voice_note("v"));
    h.reply_in("v").await;
    let texts = h.turn_texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("couldn't listen"), "turn text: {texts:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mirror_replies_by_voice_to_voice() {
    let h = start(Setup::default());
    h.push(voice_note("v"));
    let out = h.reply_in("v").await;
    assert!(out.voice, "a voice note was answered in text");
    assert!(
        out.files.iter().any(|f| f.mime == "audio/ogg"),
        "no ogg file: {:?}",
        out.files
    );
    // Mirror: a typed message is answered in text.
    h.push(msg("t", "typed"));
    let out = h.reply_in("t").await;
    assert!(!out.voice);
    assert!(out.files.is_empty());
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn never_and_long_replies_are_text() {
    let h = start(Setup {
        voice_replies: Some("never"),
        ..Setup::default()
    });
    h.push(voice_note("v"));
    let out = h.reply_in("v").await;
    assert!(!out.voice);
    assert!(out.files.is_empty());
    h.stop().await;

    let long = "a".repeat(1_001);
    let h = start(Setup {
        voice_replies: Some("always"),
        reply: long.clone(),
        ..Setup::default()
    });
    h.push(msg("t", "tell me everything"));
    let out = h.reply_in("t").await;
    assert!(!out.voice, "a 1 001-character reply went as a voice note");
    assert_eq!(out.text, long);
    assert!(
        h.media.spoke.lock().unwrap().is_empty(),
        "speak was called for a long reply"
    );
    h.stop().await;
}

/// P2-06: the asker is built first and handed to the brain; the gateway comes after.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn asker_before_gateway() {
    let h = start(Setup {
        ask: true,
        answer: Answer::Yes,
        ..Setup::default()
    });
    h.push(msg("7", "buy"));
    let out = h.reply_in("7").await;
    assert_eq!(out.text, "yes");
    assert_eq!(
        h.ch.asks(),
        vec![(
            "7".to_string(),
            "Buy it?

£12 (#1)"
                .to_string()
        )]
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_ends_a_slow_transcription() {
    use std::sync::atomic::Ordering::SeqCst;
    let h = start(Setup {
        slow_media: true,
        ..Setup::default()
    });
    h.push(voice_note("v"));
    let end = Instant::now() + Duration::from_secs(30);
    while !h.media.started.load(SeqCst) {
        assert!(Instant::now() < end, "transcription never started");
        sleep(Duration::from_millis(5)).await;
    }
    h.push(Inbound {
        kind: InKind::Stop,
        ..msg("v", "")
    });
    while !h.media.cancelled.load(SeqCst) {
        assert!(Instant::now() < end, "Stop did not reach the transcription");
        sleep(Duration::from_millis(5)).await;
    }
    sleep(Duration::from_millis(200)).await;
    assert!(
        h.turn_texts().is_empty(),
        "a turn reached the brain: {:?}",
        h.turn_texts()
    );
    h.stop().await;
}
