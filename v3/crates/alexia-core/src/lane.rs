// SPDX-License-Identifier: AGPL-3.0-only
//! P1-07: the lane classifier and the Lanes brain.
//!
//! `lane` is rules only (Alexia.md *The model router*: "rules plus manual override"). A wrong
//! `Chat` guess is cheap: the chat brain answers `NeedsTask` and `Lanes` hands the turn on. A
//! wrong `Task` guess is the slow path, so borderline rules stay out.

use std::sync::Arc;
use std::time::Instant;

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
    if let Content::Parts(parts) = content {
        if parts.iter().any(|p| matches!(p, Part::Image { .. })) {
            return Lane::Task;
        }
    }
    let text = content.text();
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
        let began = Instant::now();
        let picked = lane(&turn.content);
        let mut spans = vec![Span::since("lane", began, began)];
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        // The inner brain measures from when it was handed the turn: `handed` is that moment.
        let (answered, handed, result) = match picked {
            Lane::Chat => {
                let t_chat = Instant::now();
                match self
                    .chat
                    .reply(turn.clone(), draft.clone(), cancel.clone())
                    .await
                {
                    Err(BrainError::NeedsTask) => {
                        spans.push(Span::since("chat-escalated", began, t_chat));
                        if cancel.is_cancelled() {
                            return Err(BrainError::Cancelled);
                        }
                        // Nothing reached the draft (P1-08), so the task brain gets the same sink.
                        let t_task = Instant::now();
                        (Lane::Task, t_task, self.task.reply(turn, draft, cancel).await)
                    }
                    other => (Lane::Chat, t_chat, other),
                }
            }
            other => {
                let t_task = Instant::now();
                (other, t_task, self.task.reply(turn, draft, cancel).await)
            }
        };
        let mut reply = result?;
        reply.lane = answered;
        let shift = handed.saturating_duration_since(began).as_millis() as Ms;
        spans.extend(reply.spans.drain(..).map(|mut s| {
            s.start = s.start.saturating_add(shift);
            s
        }));
        reply.spans = spans;
        Ok(reply)
    }
}
