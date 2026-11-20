// SPDX-License-Identifier: AGPL-3.0-only
//! P2-13: the safety checker against a scripted fake provider. No network.
//!
//! Real time: alexia-core's tokio has no `test-util`, so `timeout_asks` waits the real 20 s.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_core::checker::{
    as_ruling, counted, given_up, read_answers, Checker, Review, Tally, GIVE_UP, QUESTIONS,
};
use alexia_core::{
    ChatChunk, ChatDone, ChatRequest, ModelInfo, PermissionMode, Provider, ProviderError, Ruling,
    Scope, Step,
};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

enum Then {
    Say(&'static str),
    Fail,
    Hang,
}

struct Fake {
    then: Then,
    /// Every prompt it was sent.
    seen: Mutex<Vec<String>>,
}

impl Fake {
    fn new(then: Then) -> Arc<Fake> {
        Arc::new(Fake {
            then,
            seen: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn id(&self) -> &str {
        "fake"
    }
    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }
    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let text: Vec<String> = req.messages.iter().map(|(_, b)| b.content.text()).collect();
        self.seen.lock().unwrap().push(text.join("\n"));
        match self.then {
            Then::Say(said) => {
                // Two chunks, so the reader must join them.
                let (a, b) = said.split_at(said.len() / 2);
                out.send(ChatChunk::Text(a.into())).await.ok();
                out.send(ChatChunk::Text(b.into())).await.ok();
                Ok(ChatDone {
                    model: model.into(),
                    provider: "fake".into(),
                    tokens_in: 0,
                    tokens_out: 0,
                    cost: 0.0,
                    first_byte_ms: None,
                })
            }
            Then::Fail => Err(ProviderError::Unreachable),
            Then::Hang => {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(120)) => {}
                    _ = cancel.cancelled() => {}
                }
                Err(ProviderError::Cancelled)
            }
        }
    }
}

fn step() -> Step {
    let mut args = Map::new();
    args.insert("path".into(), Value::String("/home/me/notes.txt".into()));
    Step {
        n: 1,
        name: "delete_file".into(),
        args,
        outcome: None,
    }
}

fn scope() -> Scope {
    Scope {
        mode: PermissionMode::WatchAndWarn,
        roots: vec![PathBuf::from("/home/me")],
        everywhere: false,
        boundaries: Vec::new(),
        data_dir: PathBuf::from("/data"),
    }
}

fn checker(fake: &Arc<Fake>) -> Checker {
    Checker::new(Some((
        fake.clone() as Arc<dyn Provider>,
        "checker-1".into(),
    )))
}

async fn review(c: &Checker) -> Option<Review> {
    c.review(&step(), "tidy my notes", &scope(), CancellationToken::new())
        .await
}

fn flagged() -> Review {
    read_answers("1. YES\n2. NO\n3. NO")
}

fn clean() -> Review {
    read_answers("1. NO\n2. NO\n3. NO")
}

#[tokio::test]
async fn all_no_runs() {
    let fake = Fake::new(Then::Say("1. NO\n2. NO\n3. NO"));
    let got = review(&checker(&fake)).await.expect("a review");
    assert_eq!(got.answers, vec![Some(false); 3]);
    assert!(!got.flagged);
    assert_eq!(got.why, None);
    assert_eq!(as_ruling(&got, &step(), &Tally::default()), Ruling::Run);

    // The prompt carries the tool, its arguments and the task, plus every question; no history.
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let p = &seen[0];
    assert!(p.contains("delete_file"), "{p}");
    assert!(p.contains("notes.txt"), "{p}");
    assert!(p.contains("The user asked: tidy my notes"), "{p}");
    for q in QUESTIONS {
        assert!(p.contains(q), "{p}");
    }
}

#[tokio::test]
async fn one_yes_flags_with_why() {
    let fake = Fake::new(Then::Say("1) no\n2. Yes, it uploads.\n3. NO"));
    let got = review(&checker(&fake)).await.expect("a review");
    assert_eq!(got.answers, vec![Some(false), Some(true), Some(false)]);
    assert!(got.flagged);
    assert_eq!(got.why.as_deref(), Some(QUESTIONS[1]));
    match as_ruling(&got, &step(), &Tally::default()) {
        Ruling::Ask(why) => {
            assert!(why.starts_with("The checker stopped delete_file:"), "{why}");
            assert!(why.contains(QUESTIONS[1]), "{why}");
        }
        other => panic!("a flag is an ask, never a block: {other:?}"),
    }
}

#[tokio::test]
async fn unreadable_asks() {
    let fake = Fake::new(Then::Say("I think this is probably fine."));
    let got = review(&checker(&fake)).await.expect("a review");
    assert_eq!(got.answers, vec![None; 3]);
    assert!(got.flagged, "an unclear answer is not a no");
    assert!(got.why.unwrap().contains("could not answer clearly"));

    // Two of three answered still flags.
    let partial = read_answers("1. NO\n2. NO");
    assert_eq!(partial.answers, vec![Some(false), Some(false), None]);
    assert!(partial.flagged);
    assert!(matches!(
        as_ruling(&partial, &step(), &Tally::default()),
        Ruling::Ask(_)
    ));

    // A model error is no review at all: the caller asks the owner.
    let failing = Fake::new(Then::Fail);
    assert_eq!(review(&checker(&failing)).await, None);
}

#[tokio::test]
async fn timeout_asks() {
    let fake = Fake::new(Then::Hang);
    let started = Instant::now();
    assert_eq!(review(&checker(&fake)).await, None);
    let took = started.elapsed();
    assert!(took >= Duration::from_secs(19), "gave up early: {took:?}");
    assert!(took < Duration::from_secs(80), "did not time out: {took:?}");

    // A stop from the owner ends it at once, also as None.
    let c = checker(&fake);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.cancel();
    });
    let started = Instant::now();
    assert_eq!(c.review(&step(), "t", &scope(), cancel).await, None);
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn three_in_a_row_gives_up() {
    let mut tally = Tally::default();
    for _ in 0..GIVE_UP.in_a_row - 1 {
        tally = counted(tally, &flagged());
    }
    assert!(!given_up(&tally));
    // Anything let through resets the streak, not the session count.
    tally = counted(tally, &clean());
    assert_eq!(
        tally,
        Tally {
            in_a_row: 0,
            in_a_session: 2
        }
    );
    for _ in 0..GIVE_UP.in_a_row {
        tally = counted(tally, &flagged());
    }
    assert!(given_up(&tally));
    // Given up: even a clean review asks.
    match as_ruling(&clean(), &step(), &tally) {
        Ruling::Ask(why) => assert!(why.contains("agreeing with itself"), "{why}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn twenty_in_session_gives_up() {
    let mut tally = Tally::default();
    for n in 0..GIVE_UP.in_a_session {
        assert!(!given_up(&tally), "gave up after {n}");
        tally = counted(tally, &flagged());
        // Never three in a row.
        if tally.in_a_row == 2 {
            tally = counted(tally, &clean());
        }
    }
    assert_eq!(tally.in_a_session, 20);
    assert!(tally.in_a_row < GIVE_UP.in_a_row);
    assert!(given_up(&tally));
    match as_ruling(&clean(), &step(), &tally) {
        Ruling::Ask(why) => assert!(why.contains("being useful this session"), "{why}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn no_model_is_none() {
    let c = Checker::new(None);
    assert_eq!(review(&c).await, None);

    // A model set later is used; taking it away again is None again.
    let fake = Fake::new(Then::Say("1. NO\n2. NO\n3. NO"));
    c.set_model(Some((fake.clone() as Arc<dyn Provider>, "m".into())));
    assert!(review(&c).await.is_some());
    c.set_model(None);
    assert_eq!(review(&c).await, None);
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
}
