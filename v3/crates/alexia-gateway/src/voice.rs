// SPDX-License-Identifier: AGPL-3.0-only
//! Voice notes in and out (CH-05). Filled by P1-12.
#![allow(dead_code)] // stub: P1-11 calls these

use alexia_core::OutFile;
use alexia_store::Store;

use crate::{Inbound, Media};

/// Turns voice notes in `inbound.files` into text appended to `content`. Stub: returns `inbound`
/// unchanged.
pub(crate) async fn hear(_media: &dyn Media, inbound: Inbound) -> Inbound {
    inbound
}

/// Whether to answer `inbound` with a voice note. Stub: false.
pub(crate) fn wants_voice(_store: &Store, _inbound: &Inbound) -> bool {
    false
}

/// The reply as a voice note, or `None` (then text is sent). Stub: None.
pub(crate) async fn speak(_media: &dyn Media, _text: &str) -> Option<OutFile> {
    None
}
