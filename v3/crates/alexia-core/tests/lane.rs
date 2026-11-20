// SPDX-License-Identifier: AGPL-3.0-only
//! P1-07: the lane classifier and the Lanes brain, with fake brains.

use std::sync::{Arc, Mutex};

use alexia_core::lane::{lane, Lanes};
use alexia_core::{Brain, BrainError, DraftSink, InFile, Lane, Origin, Reply, Span, Turn};
use alexia_store::{Content, Part, SessionId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn text(s: &str) -> Content {
    Content::Text(s.into())
}

#[test]
fn greetings_are_chat() {
    for s in [
        "hi",
        "thanks!",
        "dobré ráno",
        "how are you?",
        "haha ok",
        "what do you think about cats",
    ] {
        assert_eq!(lane(&text(s)), Lane::Chat, "{s}");
    }
}

#[test]
fn tasks_are_tasks() {
    for s in [
        "remind me at 5 to call mum",
        "search for flights to Rome",
        "https://example.com",
        "připomeň mi zítra nákup",
        "what's the weather tomorrow",
        "What\u{2019}s on tonight",
        "did Petr reply?",
        "WHO WON the match",
    ] {
        assert_eq!(lane(&text(s)), Lane::Task, "{s}");
    }
}

#[test]
fn words_match_only_at_word_boundaries() {
    for s in ["I'm running late", "a profile pic", "the reopening was fun"] {
        assert_eq!(lane(&text(s)), Lane::Chat, "{s}");
    }
}

#[test]
fn slash_is_command() {
    assert_eq!(lane(&text("/stop")), Lane::Command);
}

#[test]
fn image_is_task() {
    let c = Content::Parts(vec![
        Part::Text { text: "hi".into() },
        Part::Image {
            url: "data:image/png;base64,AAAA".into(),
        },
    ]);
    assert_eq!(lane(&c), Lane::Task);
    let c = Content::Parts(vec![Part::Text { text: "hi".into() }]);
    assert_eq!(lane(&c), Lane::Chat);
}

#[test]
fn long_is_task() {
    let lorem = "lorem ipsum dolor sit amet ".repeat(20);
    let s: String = lorem.chars().take(401).collect();
    assert_eq!(lane(&text(&s)), Lane::Task);
    let s: String = lorem.chars().take(400).collect();
    assert_eq!(lane(&text(&s)), Lane::Chat);
    assert_eq!(lane(&text("a\nb\nc\nd")), Lane::Task);
    assert_eq!(lane(&text("a\nb\nc")), Lane::Chat);
}

// ---- fake brains ----

enum Says {
    Answer,
    NeedsTask,
    /// Answers `Cancelled` when the token is cancelled, like a real brain.
    HonoursCancel,
}

struct Fake {
    says: Says,
    lane: Lane,
    seen: Mutex<Vec<String>>,
}

impl Fake {
    fn new(says: Says, lane: Lane) -> Arc<Fake> {
        Arc::new(Fake {
            says,
            lane,
            seen: Mutex::new(Vec::new()),
        })
    }
    fn calls(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Brain for Fake {
    async fn reply(
        &self,
        turn: Turn,
        _: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let Content::Text(t) = &turn.content else {
            panic!("fakes take text")
        };
        self.seen.lock().unwrap().push(t.clone());
        match self.says {
            Says::NeedsTask => return Err(BrainError::NeedsTask),
            Says::HonoursCancel if cancel.is_cancelled() => return Err(BrainError::Cancelled),
            _ => {}
        }
        Ok(Reply {
            text: format!("ok: {t}"),
            files: Vec::new(),
            lane: self.lane,
            model: None,
            spans: vec![Span {
                name: "inner",
                start: 0,
                ms: 1,
            }],
        })
    }
}

fn turn(s: &str) -> Turn {
    Turn {
        session: SessionId(1),
        origin: Origin::Desktop,
        content: text(s),
        files: Vec::new(),
        received_at: 0,
        steer: alexia_core::Steer::none(),
    }
}

async fn ask(lanes: &Lanes, s: &str, cancel: CancellationToken) -> Result<Reply, BrainError> {
    let (tx, _rx) = mpsc::channel(8);
    lanes.reply(turn(s), tx, cancel).await
}

fn names(r: &Reply) -> Vec<&'static str> {
    r.spans.iter().map(|s| s.name).collect()
}

#[tokio::test]
async fn lanes_routes_chat_to_chat_brain() {
    let chat = Fake::new(Says::Answer, Lane::Chat);
    let task = Fake::new(Says::Answer, Lane::Task);
    let lanes = Lanes::new(chat.clone(), task.clone());
    let r = ask(&lanes, "hi", CancellationToken::new()).await.unwrap();
    assert_eq!(r.text, "ok: hi");
    assert_eq!(r.lane, Lane::Chat);
    assert_eq!(names(&r), ["lane", "inner"]);
    assert_eq!(chat.calls(), ["hi"]);
    assert!(task.calls().is_empty());
}

#[tokio::test]
async fn file_is_task() {
    let chat = Fake::new(Says::Answer, Lane::Chat);
    let task = Fake::new(Says::Answer, Lane::Task);
    let lanes = Lanes::new(chat.clone(), task.clone());
    let mut t = turn("hi");
    t.files.push(InFile {
        name: "a.pdf".into(),
        mime: "application/pdf".into(),
        path: "a.pdf".into(),
    });
    let (tx, _rx) = mpsc::channel(8);
    let r = lanes.reply(t, tx, CancellationToken::new()).await.unwrap();
    assert_eq!(r.lane, Lane::Task);
    assert!(chat.calls().is_empty());
    assert_eq!(task.calls(), ["hi"]);
}

#[tokio::test]
async fn lanes_routes_task_to_task_brain() {
    let chat = Fake::new(Says::Answer, Lane::Chat);
    let task = Fake::new(Says::Answer, Lane::Task);
    let lanes = Lanes::new(chat.clone(), task.clone());
    let r = ask(&lanes, "search for flights", CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(r.lane, Lane::Task);
    assert_eq!(names(&r), ["lane", "inner"]);
    let r = ask(&lanes, "/stop", CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(r.lane, Lane::Command);
    assert!(chat.calls().is_empty());
    assert_eq!(task.calls(), ["search for flights", "/stop"]);
}

#[tokio::test]
async fn needs_task_escalates_once() {
    let chat = Fake::new(Says::NeedsTask, Lane::Chat);
    let task = Fake::new(Says::Answer, Lane::Task);
    let lanes = Lanes::new(chat.clone(), task.clone());
    let r = ask(
        &lanes,
        "what do you think about cats",
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(chat.calls(), ["what do you think about cats"]);
    assert_eq!(task.calls(), ["what do you think about cats"]);
    assert_eq!(r.lane, Lane::Task);
    assert_eq!(names(&r), ["lane", "chat-escalated", "inner"]);
}

#[tokio::test]
async fn cancel_passes_through() {
    let chat = Fake::new(Says::HonoursCancel, Lane::Chat);
    let task = Fake::new(Says::Answer, Lane::Task);
    let lanes = Lanes::new(chat.clone(), task.clone());
    let cancel = CancellationToken::new();
    cancel.cancel();
    for s in ["hi", "search for flights"] {
        let r = ask(&lanes, s, cancel.clone()).await;
        assert!(matches!(r, Err(BrainError::Cancelled)), "{s}: {r:?}");
    }
    assert!(task.calls().is_empty());
}

/// Sleeps, then answers `NeedsTask` (the chat brain) or one `{start: 0, ms: 10}` span.
struct Slow {
    sleep_ms: u64,
    escalate: bool,
}

#[async_trait::async_trait]
impl Brain for Slow {
    async fn reply(
        &self,
        _: Turn,
        _: DraftSink,
        _: CancellationToken,
    ) -> Result<Reply, BrainError> {
        tokio::time::sleep(std::time::Duration::from_millis(self.sleep_ms)).await;
        if self.escalate {
            return Err(BrainError::NeedsTask);
        }
        Ok(Reply {
            text: "done".into(),
            files: Vec::new(),
            lane: Lane::Task,
            model: None,
            spans: vec![Span {
                name: "task-work",
                start: 0,
                ms: 10,
            }],
        })
    }
}

#[tokio::test]
async fn escalated_task_spans_start_after_the_chat_attempt() {
    let chat = Arc::new(Slow {
        sleep_ms: 200,
        escalate: true,
    });
    let task = Arc::new(Slow {
        sleep_ms: 0,
        escalate: false,
    });
    let lanes = Lanes::new(chat, task);
    let r = ask(&lanes, "hi", CancellationToken::new()).await.unwrap();
    assert_eq!(names(&r), ["lane", "chat-escalated", "task-work"]);
    let escalated = &r.spans[1];
    assert!(escalated.ms >= 200, "{:?}", r.spans);
    let work = &r.spans[2];
    assert!(
        work.start >= 200 && work.start < 60_000,
        "task span not shifted past the chat attempt: {:?}",
        r.spans
    );
    assert_eq!(work.ms, 10);
    assert!(r.spans.iter().all(|s| s.start < 60_000), "{:?}", r.spans);
}
