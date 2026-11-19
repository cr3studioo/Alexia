// SPDX-License-Identifier: AGPL-3.0-only
//! Voice in and out for the gateway (CH-05), by capability name only.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use alexia_core::chat::Caps;
use alexia_core::OutFile;
use alexia_gateway::{InFile, Media, Result};
use alexia_mcp::{CallCtx, McpHost};
use base64::Engine;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const RENDER: &str = "voice.render";

pub struct McpMedia {
    /// The same `Arc` FastChat gets (`McpHost` implements it).
    pub caps: Arc<dyn Caps>,
    /// Only for `speak`'s audio block.
    pub host: McpHost,
    /// `layout.cache()`.
    pub cache: PathBuf,
}

/// `voice-<ms>-<n>.ogg`; `n` keeps two notes in one millisecond apart.
fn voice_name() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "voice-{}-{}.ogg",
        alexia_store::now_ms(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// The first `audio/ogg` block's bytes; `None` when there is none or the base64 is bad.
fn ogg_bytes(content: &[Value]) -> Option<Vec<u8>> {
    let block = content.iter().find(|b| {
        b.get("type").and_then(Value::as_str) == Some("audio")
            && b.get("mimeType").and_then(Value::as_str) == Some("audio/ogg")
    })?;
    let data = block.get("data")?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

#[async_trait::async_trait]
impl Media for McpMedia {
    async fn transcribe(&self, file: &InFile) -> Result<Option<String>> {
        if !self.caps.answers("voice.transcribe") {
            return Ok(None);
        }
        let mut args = serde_json::Map::new();
        args.insert("file".into(), json!(file.path.to_string_lossy()));
        let text = self
            .caps
            .call("voice.transcribe", args, CancellationToken::new())
            .await;
        if text.is_none() {
            tracing::warn!("voice.transcribe gave no text");
        }
        Ok(text)
    }

    async fn speak(&self, text: &str) -> Result<Option<OutFile>> {
        if !self.host.answers(RENDER).answers {
            return Ok(None);
        }
        let mut args = serde_json::Map::new();
        args.insert("text".into(), json!(text));
        let result = match self
            .host
            .call_capability(RENDER, args, CallCtx::default())
            .await
        {
            Ok(r) if r.is_error != Some(true) => r,
            Ok(_) => {
                tracing::warn!("voice.render reported an error");
                return Ok(None);
            }
            Err(e) => {
                tracing::warn!("voice.render failed: {e}");
                return Ok(None);
            }
        };
        let Some(bytes) = ogg_bytes(&result.content) else {
            tracing::warn!("voice.render returned no usable audio/ogg block");
            return Ok(None);
        };
        let dir = self
            .cache
            .join(RENDER.split('.').next().unwrap_or_default());
        let name = voice_name();
        let path = dir.join(&name);
        if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, bytes)) {
            tracing::warn!("couldn't save the voice note: {e}");
            return Ok(None);
        }
        Ok(Some(OutFile {
            name,
            mime: "audio/ogg".into(),
            path,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alexia_mcp::{EventSink, HostConfig, NoUpcalls, Timings};
    use alexia_store::{Layout, Store};
    use serde_json::Map;

    struct FakeCaps(Option<&'static str>);

    #[async_trait::async_trait]
    impl Caps for FakeCaps {
        fn answers(&self, cap: &str) -> bool {
            self.0.is_some() && cap == "voice.transcribe"
        }
        async fn call(
            &self,
            _: &str,
            args: Map<String, Value>,
            _: CancellationToken,
        ) -> Option<String> {
            assert!(args.contains_key("file"));
            self.0.map(str::to_owned)
        }
    }

    /// A host that was never started: nothing answers.
    fn media(name: &str, caps: FakeCaps) -> McpMedia {
        let root =
            std::env::temp_dir().join(format!("alexia-hub-media-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let layout = Layout::new(root.clone());
        let store = Arc::new(Store::open(&root.join("t.db")).unwrap());
        let cfg = HostConfig {
            layout,
            plugin_dirs: vec![],
            node: PathBuf::from("node"),
            timings: Timings::default(),
        };
        let sink: EventSink = Arc::new(|_| {});
        McpMedia {
            caps: Arc::new(caps),
            host: McpHost::new(cfg, store, Arc::new(NoUpcalls), sink),
            cache: root,
        }
    }

    fn file() -> InFile {
        InFile {
            name: "a.ogg".into(),
            mime: "audio/ogg".into(),
            path: PathBuf::from("a.ogg"),
        }
    }

    #[tokio::test]
    async fn transcribe_without_capability_is_none() {
        let m = media("none", FakeCaps(None));
        assert_eq!(m.transcribe(&file()).await.unwrap(), None);
        assert!(m.speak("hi").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn transcribe_returns_the_text() {
        let m = media("text", FakeCaps(Some("hello there")));
        assert_eq!(
            m.transcribe(&file()).await.unwrap().as_deref(),
            Some("hello there")
        );
    }

    #[test]
    fn voice_names_never_clash() {
        assert_ne!(voice_name(), voice_name());
    }

    #[test]
    fn ogg_bytes_needs_an_ogg_audio_block() {
        let ok = vec![
            json!({"type":"text","text":"x"}),
            json!({"type":"audio","mimeType":"audio/ogg","data":"T2dnUw=="}),
        ];
        assert_eq!(ogg_bytes(&ok).unwrap(), b"OggS");
        assert!(
            ogg_bytes(&[json!({"type":"audio","mimeType":"audio/wav","data":"T2dnUw=="})])
                .is_none()
        );
        assert!(ogg_bytes(&[json!({"type":"audio","mimeType":"audio/ogg","data":"!!"})]).is_none());
    }
}
