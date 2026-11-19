// SPDX-License-Identifier: AGPL-3.0-only
//! Approvals (CH-07): asks the owner yes/no in the chat a run came from.

use std::sync::Arc;
use std::time::Duration;

use alexia_core::{Origin, Question};
use alexia_store::Store;
use tokio_util::sync::CancellationToken;

use crate::{Channel, ChatRef, Outbound};

pub(crate) type Channels = Arc<std::sync::RwLock<Vec<Arc<dyn Channel>>>>;

/// v2 `ANSWER_WAIT`.
const ANSWER_WAIT: Duration = Duration::from_secs(10 * 60);
const NO_ANSWER: &str = "— no answer, so I didn't";

pub(crate) struct Asker {
    channels: Channels,
    store: Arc<Store>,
}

impl Asker {
    pub(crate) fn new(channels: Channels, store: Arc<Store>) -> Asker {
        Asker { channels, store }
    }

    /// The channel and chat to ask in, or `None` (then the answer is no).
    fn target(&self, origin: &Origin) -> Option<(Arc<dyn Channel>, ChatRef)> {
        let channels = self.channels.read().unwrap_or_else(|e| e.into_inner());
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
