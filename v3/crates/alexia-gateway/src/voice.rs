// SPDX-License-Identifier: AGPL-3.0-only
//! Voice notes in and out (CH-05).

use alexia_core::OutFile;
use alexia_store::{Content, Part, Store};

use tokio_util::sync::CancellationToken;

use crate::{Inbound, Media};

const DEAF: &str =
    "[a voice note I couldn't listen to: nothing installed here turns speech into text]";
/// Longer replies go as text: a three-minute voice note is not a reply.
const SPEAK_MAX_CHARS: usize = 1_000;

fn is_audio(mime: &str) -> bool {
    mime.starts_with("audio/")
}

fn append(content: &mut Content, text: &str) {
    match content {
        Content::Text(t) if t.is_empty() => *t = text.to_string(),
        Content::Text(t) => {
            t.push('\n');
            t.push_str(text);
        }
        Content::Parts(parts) => parts.push(Part::Text {
            text: text.to_string(),
        }),
    }
}

/// Turns voice notes in `inbound.files` into text appended to `content`, as if typed. The audio
/// files stay in `files` so `wants_voice` can see them.
pub(crate) async fn hear(
    media: &dyn Media,
    mut inbound: Inbound,
    cancel: &CancellationToken,
) -> Inbound {
    for file in inbound.files.iter().filter(|f| is_audio(&f.mime)) {
        let text = match media.transcribe(file, cancel.child_token()).await {
            Ok(Some(t)) => t,
            Ok(None) => DEAF.to_string(),
            Err(e) => {
                tracing::warn!(file = %file.name, "voice: transcribe failed: {e}");
                DEAF.to_string()
            }
        };
        append(&mut inbound.content, &text);
    }
    inbound
}

/// Whether to answer `inbound` with a voice note: kv `_core/voice_replies`, default "mirror".
pub(crate) fn wants_voice(store: &Store, inbound: &Inbound) -> bool {
    let setting = match store.kv_get("_core", "voice_replies") {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("voice: voice_replies: {e}");
            None
        }
    };
    match setting
        .as_ref()
        .and_then(|v| v.as_str())
        .unwrap_or("mirror")
    {
        "always" => true,
        "never" => false,
        _ => inbound.files.iter().any(|f| is_audio(&f.mime)),
    }
}

/// The reply as an `audio/ogg` voice note, or `None` (then text is sent).
pub(crate) async fn speak(
    media: &dyn Media,
    text: &str,
    cancel: &CancellationToken,
) -> Option<OutFile> {
    if text.chars().count() > SPEAK_MAX_CHARS {
        return None;
    }
    match media.speak(text, cancel.child_token()).await {
        Ok(Some(f)) if f.mime == "audio/ogg" => Some(f),
        Ok(Some(f)) => {
            tracing::warn!(mime = %f.mime, "voice: speech is not audio/ogg; sending text");
            None
        }
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("voice: speak failed: {e}");
            None
        }
    }
}
