// SPDX-License-Identifier: AGPL-3.0-only
//! Channels: instant ack, merging, drafts, delivery.

mod channel;
pub use channel::*;
mod gateway;
pub use gateway::Gateway;
mod ask;
pub use ask::{Asker, ChannelSet, WindowQuestions};
pub mod channels;
mod voice;
