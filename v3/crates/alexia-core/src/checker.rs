// SPDX-License-Identifier: AGPL-3.0-only
//! The safety checker (TR-02), ported from v2 `packages/core/src/checker.ts`.
//!
//! A second model, asked whether a step is about to do something the owner would not want.
//!
//! **It asks closed questions.** A small local model cannot reliably answer *is this a good
//! idea?*. It can answer *does this delete a file that existed before this task started, yes or
//! no?* So the review is a fixed list of narrow yes/no questions and nothing else.
//!
//! **It never replaces the fixed rules.** The never-touch list and the permission modes have
//! already run by the time anything here is asked. This is coverage on top, allowed to be wrong
//! in the cautious direction, because there is a floor underneath it.
//!
//! **It gives up gracefully.** Three blocks in a row, or twenty in a session, and it stops
//! deciding and goes back to asking the owner.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_store::{Content, MessageBody, Role};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{ChatChunk, ChatRequest, Provider, Ruling, Scope, Step};

/// The questions. Each is closed, about *this call*, and phrased so that `yes` is the alarming
/// answer: a model that says yes to everything fails safe, and the give-up rule catches it.
pub const QUESTIONS: &[&str] = &[
    "Does this permanently delete or overwrite something that existed before this task started?",
    "Does this send the user’s files, messages or credentials to somewhere outside this machine?",
    "Does this change a setting, install something, or run a program that was not asked for?",
];

/// How long one review may take before it counts as no answer (ask the owner).
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// How much rope before the checker admits it is not helping.
pub struct GiveUp {
    pub in_a_row: u32,
    pub in_a_session: u32,
}

pub const GIVE_UP: GiveUp = GiveUp {
    in_a_row: 3,
    in_a_session: 20,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// Consecutive blocks. Reset by anything the checker lets through.
    pub in_a_row: u32,
    pub in_a_session: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Review {
    /// One per question: `Some(true)` yes, `Some(false)` no, `None` unreadable.
    pub answers: Vec<Option<bool>>,
    pub flagged: bool,
    /// Which question failed, in words. None when nothing did.
    pub why: Option<String>,
}

type Model = Option<(Arc<dyn Provider>, String)>;

/// `model`: the local checker model (P2-34) as a Provider and its id. None: no checker can run.
pub struct Checker {
    model: Mutex<Model>,
}

impl Checker {
    pub fn new(model: Model) -> Checker {
        Checker {
            model: Mutex::new(model),
        }
    }

    pub fn set_model(&self, model: Model) {
        *self.model.lock().unwrap_or_else(|e| e.into_inner()) = model;
    }

    /// None when no model can run now; the caller then asks the owner instead. A model error,
    /// a timeout or a stop is None too, never a silent pass.
    pub async fn review(
        &self,
        step: &Step,
        task: &str,
        scope: &Scope,
        cancel: CancellationToken,
    ) -> Option<Review> {
        let (provider, model) = self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        let req = ChatRequest {
            messages: vec![(
                Role::User,
                MessageBody {
                    content: Content::Text(prompt(step, task, scope)),
                    calls: None,
                    call_id: None,
                    provider: None,
                    notes: None,
                    bad: None,
                    stopped: None,
                    typed: None,
                    extra: serde_json::Map::new(),
                },
            )],
            system: None,
            tools: Vec::new(),
            max_tokens: Some(200),
        };

        let child = cancel.child_token();
        let (tx, mut rx) = mpsc::channel(64);
        let call = provider.chat(&req, &model, tx, child.clone());
        let drain = async {
            let mut said = String::new();
            while let Some(chunk) = rx.recv().await {
                if let ChatChunk::Text(t) = chunk {
                    said.push_str(&t);
                }
            }
            said
        };
        let both = async { tokio::join!(call, drain) };
        let outcome = tokio::select! {
            r = tokio::time::timeout(TIMEOUT, both) => r.ok(),
            _ = cancel.cancelled() => None,
        };
        child.cancel();
        match outcome {
            Some((Ok(_), said)) => Some(read_answers(&said)),
            _ => None,
        }
    }
}

/// Short, closed, and it says what the answer must look like. The tool, its redacted
/// arguments and the task; never history.
fn prompt(step: &Step, task: &str, scope: &Scope) -> String {
    let args = serde_json::Value::Object(step.args.clone()).to_string();
    let (args, _) = crate::redact::redact_text(&args);
    let folders = if scope.everywhere {
        "The user has allowed every folder.".to_string()
    } else if scope.roots.is_empty() {
        "The folders the user allowed: none.".to_string()
    } else {
        let roots: Vec<String> = scope
            .roots
            .iter()
            .map(|r| r.display().to_string())
            .collect();
        format!("The folders the user allowed: {}.", roots.join(", "))
    };
    let mut lines = vec![
        "You are checking one action before it runs. Answer the questions and nothing else."
            .to_string(),
        String::new(),
        format!("The user asked: {task}"),
        format!(
            "The action is a tool called \"{}\" with these arguments:",
            step.name
        ),
        args,
        folders,
        String::new(),
        "Answer each question with exactly YES or NO, one per line, numbered:".to_string(),
    ];
    lines.extend(
        QUESTIONS
            .iter()
            .enumerate()
            .map(|(at, q)| format!("{}. {q}", at + 1)),
    );
    lines.join("\n")
}

fn has_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .any(|w| w == word)
}

/// The answers, read strictly. An answer that cannot be read is not a no: it flags, and the
/// give-up rule stops that turning into an assistant that never does anything.
pub fn read_answers(said: &str) -> Review {
    let answers: Vec<Option<bool>> = (1..=QUESTIONS.len())
        .map(|n| {
            let (dot, paren) = (format!("{n}."), format!("{n})"));
            let line = said
                .lines()
                .map(str::trim)
                .find(|l| l.starts_with(&dot) || l.starts_with(&paren))
                .unwrap_or("")
                .to_uppercase();
            if has_word(&line, "YES") {
                Some(true)
            } else if has_word(&line, "NO") {
                Some(false)
            } else {
                None
            }
        })
        .collect();

    let why = if let Some(at) = answers.iter().position(|a| *a == Some(true)) {
        Some(QUESTIONS[at].to_string())
    } else if answers.contains(&None) {
        Some(
            "The checker could not answer clearly, and an unclear answer is not a yes.".to_string(),
        )
    } else {
        None
    };
    Review {
        answers,
        flagged: why.is_some(),
        why,
    }
}

/// The verdict as a ruling. A flag is an `Ask`, never `Blocked`: the checker is a model and can
/// be wrong; only the things that cannot be wrong block outright.
pub fn as_ruling(review: &Review, step: &Step, tally: &Tally) -> Ruling {
    if given_up(tally) {
        let what = if tally.in_a_row >= GIVE_UP.in_a_row {
            "agreeing with itself"
        } else {
            "being useful this session"
        };
        return Ruling::Ask(format!(
            "{} needs your decision — the checker has stopped {what}, so it is out of the way until you say otherwise.",
            step.name
        ));
    }
    if review.flagged {
        let why = review.why.as_deref().unwrap_or("");
        return Ruling::Ask(
            format!("The checker stopped {}: {why}", step.name)
                .trim()
                .to_string(),
        );
    }
    Ruling::Run
}

/// One review's effect on the tally. Anything let through resets the streak.
pub fn counted(tally: Tally, review: &Review) -> Tally {
    if !review.flagged {
        return Tally {
            in_a_row: 0,
            in_a_session: tally.in_a_session,
        };
    }
    Tally {
        in_a_row: tally.in_a_row + 1,
        in_a_session: tally.in_a_session + 1,
    }
}

/// Has it stopped being useful? Then it stops deciding, and the owner decides instead.
pub fn given_up(tally: &Tally) -> bool {
    tally.in_a_row >= GIVE_UP.in_a_row || tally.in_a_session >= GIVE_UP.in_a_session
}
