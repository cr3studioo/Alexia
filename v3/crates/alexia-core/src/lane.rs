// SPDX-License-Identifier: AGPL-3.0-only
//! P1-07: the lane classifier and the Lanes brain.
//!
//! `lane` is rules only (Alexia.md *The model router*: "rules plus manual override"). A wrong
//! `Chat` guess is cheap: the chat brain answers `NeedsTask` and `Lanes` hands the turn on. A
//! wrong `Task` guess is the slow path, so borderline rules stay out.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alexia_store::{Content, Ms, Part};
use tokio_util::sync::CancellationToken;

use crate::{Brain, BrainError, DraftSink, Lane, Reply, Span, Turn};

const MAX_CHARS: usize = 400;
const MAX_LINES: usize = 3;

const URL: &[&str] = &["http://", "https://", "www."];

/// Imperatives and requests about the world, matched at word boundaries.
const WORDS: &[&str] = &[
    "remind",
    "remember",
    "schedule",
    "search",
    "look up",
    "find",
    "open",
    "send",
    "email",
    "call",
    "book",
    "buy",
    "order",
    "download",
    "install",
    "run",
    "create",
    "make",
    "write a",
    "draft",
    "summarise",
    "summarize",
    "translate",
    "convert",
    "set a timer",
    "set an alarm",
    "turn on",
    "turn off",
    "what's on",
    "weather",
    "news",
    "price",
    "latest",
    "today's",
    "tomorrow's",
    "calendar",
    "file",
    "folder",
    "screenshot",
    "my screen",
    // the owner's Czech
    "připomeň",
    "najdi",
    "pošli",
    "otevři",
    "napiš",
    "vyhledej",
    "počasí",
    "zprávy",
    "kalendář",
    // questions the model can't answer without looking
    "what time",
    "how much is",
    "who won",
    "is it raining",
];

/// `Command` for a leading `/`; `Task` when any rule fires; else `Chat`.
pub fn lane(content: &Content) -> Lane {
    let text = match content {
        Content::Text(t) => t.clone(),
        Content::Parts(parts) => {
            let mut text = String::new();
            for p in parts {
                match p {
                    Part::Image { .. } => return Lane::Task,
                    Part::Text { text: t } => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
            }
            text
        }
    };
    let text = text.trim();
    if text.starts_with('/') {
        return Lane::Command;
    }
    if text.chars().count() > MAX_CHARS || text.lines().count() > MAX_LINES {
        return Lane::Task;
    }
    let low = text.to_lowercase().replace('\u{2019}', "'");
    let task = URL.iter().any(|u| low.contains(u))
        || WORDS.iter().any(|w| word_at(&low, w).is_some())
        || word_at(&low, "did").is_some_and(|i| word_at(&low[i..], "reply").is_some());
    if task {
        Lane::Task
    } else {
        Lane::Chat
    }
}

/// Byte offset of the first `pat` in `text` with no letter or digit on either side.
fn word_at(text: &str, pat: &str) -> Option<usize> {
    text.match_indices(pat).map(|(i, _)| i).find(|&i| {
        let before = text[..i].chars().next_back();
        let after = text[i + pat.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// The `Brain` the gateway holds: chat turns to the fast chat brain, the rest to the task brain.
pub struct Lanes {
    chat: Arc<dyn Brain>,
    task: Arc<dyn Brain>,
}

impl Lanes {
    pub fn new(chat: Arc<dyn Brain>, task: Arc<dyn Brain>) -> Lanes {
        Lanes { chat, task }
    }
}

#[async_trait::async_trait]
impl Brain for Lanes {
    /// Chat → `chat.reply`; on `Err(NeedsTask)` → `task.reply` with the same turn and draft.
    /// Command and Task → `task.reply`. `Reply.spans` start with `"lane"`, then
    /// `"chat-escalated"` if the chat brain gave up; `Reply.lane` is the lane that answered.
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        let start = now();
        let t0 = Instant::now();
        let picked = lane(&turn.content);
        let mut spans = vec![span("lane", start, t0.elapsed())];
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        let (answered, result) = match picked {
            Lane::Chat => {
                let chat_start = now();
                let t1 = Instant::now();
                match self
                    .chat
                    .reply(turn.clone(), draft.clone(), cancel.clone())
                    .await
                {
                    Err(BrainError::NeedsTask) => {
                        spans.push(span("chat-escalated", chat_start, t1.elapsed()));
                        if cancel.is_cancelled() {
                            return Err(BrainError::Cancelled);
                        }
                        // Nothing reached the draft (P1-08), so the task brain gets the same sink.
                        (Lane::Task, self.task.reply(turn, draft, cancel).await)
                    }
                    other => (Lane::Chat, other),
                }
            }
            other => (other, self.task.reply(turn, draft, cancel).await),
        };
        let mut reply = result?;
        reply.lane = answered;
        spans.append(&mut reply.spans);
        reply.spans = spans;
        Ok(reply)
    }
}

fn now() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as Ms)
}

fn span(name: &'static str, start: Ms, took: Duration) -> Span {
    Span {
        name,
        start,
        ms: u32::try_from(took.as_millis()).unwrap_or(u32::MAX),
    }
}
