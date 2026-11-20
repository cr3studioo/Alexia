// SPDX-License-Identifier: AGPL-3.0-only
//! Approvals (CH-07): asks the owner yes/no in the chat a run came from.

use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Bus, Origin, Question};
use alexia_store::Store;
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
    /// Held for P2-29: answers from other chats arrive as `Event::Answered`.
    #[allow(dead_code)]
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
            // A scheduled job has no chat of its own: the first channel's primary chat.
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
}

#[async_trait::async_trait]
impl alexia_core::Ask for Asker {
    /// True only on the owner's Approve; deny, no answer, an error or nowhere to ask is false.
    async fn confirm(
        &self,
        origin: &Origin,
        question: &Question,
        cancel: CancellationToken,
    ) -> bool {
        let Some((ch, chat)) = self.target(origin) else {
            return false;
        };
        let text = match &question.detail {
            Some(d) => format!("{}\n\n{d}", question.text),
            None => question.text.clone(),
        };
        let ask = cancel.child_token();
        match tokio::time::timeout(ANSWER_WAIT, ch.ask(&chat, &text, ask.clone())).await {
            Ok(Ok(answer)) => answer == Some(true),
            Ok(Err(e)) => {
                tracing::warn!(channel = ch.name(), "ask: {e}");
                false
            }
            Err(_) => {
                ask.cancel();
                // ponytail: `Channel::ask` returns no MsgRef, so this follows the question
                // instead of editing it; edit in place once `ask` hands back the message.
                let out = Outbound {
                    text: NO_ANSWER.into(),
                    files: Vec::new(),
                    voice: false,
                };
                if let Err(e) = ch.send(&chat, &out).await {
                    tracing::warn!(channel = ch.name(), "ask: no-answer note: {e}");
                }
                false
            }
        }
    }
}
