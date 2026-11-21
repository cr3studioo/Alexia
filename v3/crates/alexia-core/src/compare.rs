// SPDX-License-Identifier: AGPL-3.0-only
//! Compare two models on one question (MO-10). Producing and presenting only: keeping one
//! answer is `commands.rs`'s job (it asks A/B through the agent's asker).

use std::time::Instant;

use alexia_store::now_ms;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::catalog::Candidate;
use crate::redact::redact_request_known;
use crate::router::{outcome, Attribution, Needs, Router};
use crate::{ms_since, ChatChunk, ChatRequest, ProviderError};

pub struct Compared {
    /// (model, text). When `a_failed` the text is a "(no answer: ...)" note, not an answer.
    pub a: (String, String),
    pub b: (String, String),
    pub a_failed: bool,
    pub b_failed: bool,
}

/// One candidate's full answer, recorded in the router's tries like a race entry.
async fn ask(
    router: &Router,
    c: &Candidate,
    req: &ChatRequest,
    cancel: CancellationToken,
) -> Result<String, ProviderError> {
    let provider = router
        .provider(&c.provider)
        .ok_or_else(|| ProviderError::Other(format!("{} is not available", c.provider)))?;
    // TR-04: a cloud model gets the redacted copy, a local one the request as is.
    let req = if router.is_local(&c.provider) {
        req.clone()
    } else {
        redact_request_known(req, &router.known_secrets()).0
    };
    router.record_request(&c.provider);
    let (tx, mut rx) = mpsc::channel(64);
    let started = Instant::now();
    let chat = provider.chat(&req, &c.model, tx, cancel.clone());
    // The first chunk's time, as the race records it: the score reads it as time to first byte.
    let collect = async {
        let (mut text, mut first) = (String::new(), None);
        while let Some(chunk) = rx.recv().await {
            first.get_or_insert_with(|| ms_since(started));
            if let ChatChunk::Text(t) = chunk {
                text.push_str(&t);
            }
        }
        (text, first)
    };
    // `chat` drops its sender when it returns, which ends `collect`.
    let (result, (text, first)) = tokio::join!(chat, collect);
    let total = ms_since(started);
    let first = first.unwrap_or(total);
    match result {
        Ok(done) => {
            router.record_answer(c, &done, first, total, now_ms(), &Attribution::default());
            Ok(text)
        }
        Err(e) => {
            // A cancel is the owner's, not the provider's: no try, as the race does.
            if !matches!(e, ProviderError::Cancelled) && !cancel.is_cancelled() {
                router.record_try(c, outcome(&e), Some(total));
            }
            Err(e)
        }
    }
}

/// Two different providers, run fully in parallel (not a hedge: both finish).
pub async fn compare(
    router: &Router,
    req: &ChatRequest,
    cancel: CancellationToken,
) -> Result<Compared, ProviderError> {
    let list = router.ranked_for(now_ms(), &Needs::of(req));
    let Some(first) = list.first() else {
        return Err(ProviderError::Other(
            "No free model can answer right now.".into(),
        ));
    };
    let Some(second) = list.iter().find(|c| c.provider != first.provider) else {
        return Err(ProviderError::Other(
            "Comparing needs free models from two different providers, and only one can answer right now."
                .into(),
        ));
    };
    let (ra, rb) = tokio::join!(
        ask(router, first, req, cancel.clone()),
        ask(router, second, req, cancel.clone())
    );
    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    let (ra, rb) = match (ra, rb) {
        (Err(e), Err(_)) => return Err(e),
        both => both,
    };
    // One failed: its slot says so, the other answer is still shown.
    let fill = |c: &Candidate, r: Result<String, ProviderError>| match r {
        Ok(text) => ((c.model.clone(), text), false),
        Err(e) => ((c.model.clone(), format!("(no answer: {e})")), true),
    };
    let ((a, a_failed), (b, b_failed)) = (fill(first, ra), fill(second, rb));
    Ok(Compared {
        a,
        b,
        a_failed,
        b_failed,
    })
}

/// The reply text with both answers and the question "Keep A or B?"
pub fn present(c: &Compared) -> String {
    format!(
        "**A** ({})\n{}\n\n**B** ({})\n{}\n\nKeep A or B?",
        c.a.0,
        c.a.1.trim(),
        c.b.0,
        c.b.1.trim()
    )
}
