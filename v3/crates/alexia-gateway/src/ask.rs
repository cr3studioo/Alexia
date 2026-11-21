// SPDX-License-Identifier: AGPL-3.0-only
//! Approvals (CH-07): asks the owner yes/no in the chat a run came from.

use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Bus, Event, Origin, Question};
use alexia_store::{now_ms, Store};
use tokio::sync::broadcast::error::RecvError;
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

pub struct Asker {
    channels: ChannelSet,
    store: Arc<Store>,
    /// Answers from other chats arrive as `Event::Answered`.
    bus: Bus,
}

impl Asker {
    pub fn new(channels: ChannelSet, store: Arc<Store>, bus: Bus) -> Arc<Asker> {
        Arc::new(Asker {
            channels,
            store,
            bus,
        })
    }

    /// The channel and chat to ask in, or `None` (then the answer is no).
    fn target(&self, origin: &Origin) -> Option<(Arc<dyn Channel>, ChatRef)> {
        let channels = self.channels.all();
        match origin {
            Origin::Channel { channel, chat } => channels
                .iter()
                .find(|c| c.name() == channel)
                .map(|c| (c.clone(), ChatRef { chat: chat.clone() })),
            // A scheduled or resumed run has no chat of its own: the first channel's primary chat.
            Origin::Scheduler { .. } => {
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
        let Some((ch, chat)) = self.target(origin) else {
            return false;
        };
        // Subscribe first, so an instant `/approve` cannot be missed.
        let mut rx = self.bus.subscribe();
        let origin_json = serde_json::to_string(origin).unwrap_or_else(|_| "{}".into());
        let id = match self.store.approval_open(
            &question.run.0,
            &origin_json,
            &question.text,
            question.detail.as_deref(),
            now_ms(),
        ) {
            Ok(id) => id,
            Err(e) => {
                tracing::error!("ask: open approval: {e}");
                return false;
            }
        };
        let text = match &question.detail {
            Some(d) => format!(
                "{}

{d} (#{id})",
                question.text
            ),
            None => format!("{} (#{id})", question.text),
        };
        let ask = cancel.child_token();
        let buttons = ch.ask(&chat, &text, ask.clone());
        tokio::pin!(buttons);
        let timer = tokio::time::sleep(ANSWER_WAIT);
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
                            break self.settle(id, false, ch.name());
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
                        self.note(&*ch, &chat, NO_ANSWER).await;
                    }
                    ask.cancel();
                    return a;
                }
                _ = cancel.cancelled() => return false, // the row stays unanswered
            }
        };
        ask.cancel();
        // ponytail: an answer by this chat's own buttons gets no note ("Approved here") because
        // `Channel::ask` returns no MsgRef to edit and a follow-up would reach the turn's chat
        // before its reply; add the edit once `ask` hands back the message.
        if via != ch.name() {
            let verb = if answer { "Approved" } else { "Denied" };
            self.note(&*ch, &chat, &format!("— {verb} from {via}"))
                .await;
        }
        answer
    }
}

impl Asker {
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
