// SPDX-License-Identifier: AGPL-3.0-only
//! P1-04: the OpenAI-compatible provider (streamed chat, SSE parsed by hand).
//!
//! Never logs a key, a header value or a message body: provider id, model, status and timings.

use std::time::{Duration, Instant};

use alexia_store::{Content, MessageBody, Part, Role};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::free::{anonymous_key, Auth, FreeRow};
use crate::{ChatChunk, ChatDone, ChatRequest, ModelInfo, Provider, ProviderError};

/// v2's `PATIENCE` (D163): to the first byte, and between chunks once it has started.
const FIRST_BYTE: Duration = Duration::from_secs(30);
const BETWEEN: Duration = Duration::from_secs(20);

pub struct OpenAiCompat {
    row: FreeRow,
    key: Option<String>,
    client: reqwest::Client,
    first_byte: Duration,
    between: Duration,
}

impl OpenAiCompat {
    pub fn new(row: FreeRow, key: Option<String>, client: reqwest::Client) -> OpenAiCompat {
        Self::with_timeouts(row, key, client, FIRST_BYTE, BETWEEN)
    }

    #[doc(hidden)]
    pub fn with_timeouts(
        row: FreeRow,
        key: Option<String>,
        client: reqwest::Client,
        first_byte: Duration,
        between: Duration,
    ) -> OpenAiCompat {
        OpenAiCompat {
            row,
            key,
            client,
            first_byte,
            between,
        }
    }

    pub fn row(&self) -> &FreeRow {
        &self.row
    }

    /// true when `auth` is None/Optional or a key is present.
    pub fn usable(&self) -> bool {
        self.row.auth != Auth::Required || self.key.is_some()
    }

    /// v2's `reaching`: the address and the credential (the stored key, else the row's
    /// published anonymous one). A `{account}` row's key is `account_id:api_token`, split once
    /// on the first colon.
    fn reaching(&self) -> Result<(String, Option<&str>), ProviderError> {
        if !self.row.base_url.contains("{account}") {
            if self.row.auth == Auth::Required && self.key.is_none() {
                return Err(ProviderError::NeedsKey);
            }
            let key = self.key.as_deref().or_else(|| anonymous_key(&self.row.id));
            return Ok((self.row.base_url.clone(), key));
        }
        let Some(key) = self.key.as_deref() else {
            return Err(ProviderError::NeedsKey);
        };
        match key.split_once(':') {
            Some((account, token)) if !account.is_empty() && !token.is_empty() => Ok((
                self.row.base_url.replace("{account}", account),
                Some(token),
            )),
            _ => Err(ProviderError::Refused(format!(
                "{} puts an account id in its address, so its key is two things joined by a colon — account_id:api_token.",
                self.row.id
            ))),
        }
    }

    fn request(
        &self,
        method: reqwest::Method,
        url: &str,
        key: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut req = self.client.request(method, url);
        for (name, value) in &self.row.headers {
            req = req.header(name, value);
        }
        // A blank key sends no header at all: a wrong one 403s where none degrades (v2, OVHcloud).
        if let Some(key) = key {
            req = req.bearer_auth(key);
        }
        req
    }

    /// What a refusal means, as v2 reads it (`provider.ts`). Whether a key was *stored* decides
    /// 401/403: an anonymous key refused is a row that wants the person's own key.
    async fn refusal(&self, response: reqwest::Response) -> ProviderError {
        let had_key = self.key.is_some();
        let status = response.status().as_u16();
        let retry_after_ms = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(|s| s.saturating_mul(1000));
        tracing::debug!(provider = %self.row.id, status, "refused");
        match status {
            429 | 503 => ProviderError::Busy { retry_after_ms },
            401 | 403 if !had_key => ProviderError::NeedsKey,
            401 | 403 => ProviderError::Refused("the key was refused".into()),
            _ => {
                let body = tokio::time::timeout(self.between, response.text())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                let said = said(&body);
                match status {
                    400 | 404 | 422 => ProviderError::Refused(said),
                    _ => ProviderError::Other(format!("{} said {status}: {said}", self.row.id)),
                }
            }
        }
    }
}

/// The provider's own message (`error.message` when it is JSON), first 200 characters.
fn said(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.trim().to_owned());
    message.chars().take(200).collect()
}

fn sent_error(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() {
        ProviderError::Busy {
            retry_after_ms: None,
        }
    } else {
        ProviderError::Unreachable
    }
}

fn wire(role: &Role, body: &MessageBody) -> Value {
    let role = match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let content = match &body.content {
        Content::Text(text) => json!(text),
        Content::Parts(parts) => parts
            .iter()
            .map(|p| match p {
                Part::Text { text } => json!({"type": "text", "text": text}),
                Part::Image { url } => json!({"type": "image_url", "image_url": {"url": url}}),
            })
            .collect(),
    };
    json!({"role": role, "content": content})
}

/// `"0"`, `0` and `0.0` are all zero; anything else (absent included) is not.
fn is_zero(v: &Value) -> bool {
    match v {
        Value::String(s) => s.parse::<f64>() == Ok(0.0),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

#[async_trait::async_trait]
impl Provider for OpenAiCompat {
    fn id(&self) -> &str {
        &self.row.id
    }

    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let Some(path) = &self.row.models_path else {
            return Ok(Vec::new());
        };
        let (base, key) = self.reaching()?;
        let response = self
            .request(reqwest::Method::GET, &format!("{base}{path}"), key)
            .timeout(self.first_byte)
            .send()
            .await
            .map_err(sent_error)?;
        if !response.status().is_success() {
            return Err(self.refusal(response).await);
        }
        let list: Value = response.json().await.map_err(|_| {
            ProviderError::Other(format!(
                "{} sent a model list that is not JSON",
                self.row.id
            ))
        })?;
        // OpenAI's `{data: [...]}`, or Ollama's `{models: [...]}`.
        let rows = list["data"]
            .as_array()
            .or_else(|| list["models"].as_array())
            .cloned()
            .unwrap_or_default();
        Ok(rows
            .iter()
            .filter_map(|m| {
                let id = m["id"].as_str().or_else(|| m["name"].as_str())?.to_owned();
                let free = self.row.all_free
                    || id.ends_with(":free")
                    || (is_zero(&m["pricing"]["prompt"]) && is_zero(&m["pricing"]["completion"]));
                let tools = m["supported_parameters"]
                    .as_array()
                    .is_some_and(|p| p.iter().any(|p| p == "tools"));
                let vision = m["architecture"]["input_modalities"]
                    .as_array()
                    .is_some_and(|p| p.iter().any(|p| p == "image"));
                let context = m["context_length"]
                    .as_u64()
                    .map_or(8192, |c| c.min(u32::MAX as u64) as u32);
                Some(ModelInfo {
                    id,
                    context,
                    free,
                    tools,
                    vision,
                })
            })
            .collect())
    }

    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        // ponytail: no tool calls on the fast path; V3-2's agent loop adds them.
        if !req.tools.is_empty() {
            return Err(ProviderError::Other(
                "tools are not sent on this path".into(),
            ));
        }
        let (base, key) = self.reaching()?;
        let mut messages = Vec::with_capacity(req.messages.len() + 1);
        if let Some(system) = &req.system {
            messages.push(json!({"role": "system", "content": system}));
        }
        messages.extend(req.messages.iter().map(|(role, body)| wire(role, body)));
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            // The only way to be told what a streamed answer cost (v2).
            "stream_options": {"include_usage": true},
        });
        if let Some(max) = req.max_tokens {
            body["max_tokens"] = json!(max);
        }

        let sent = Instant::now();
        let first_deadline = tokio::time::Instant::now() + self.first_byte;
        let busy = || ProviderError::Busy {
            retry_after_ms: None,
        };
        let send = self
            .request(
                reqwest::Method::POST,
                &format!("{base}/chat/completions"),
                key,
            )
            .json(&body)
            .send();
        let mut response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
            r = tokio::time::timeout_at(first_deadline, send) => r.map_err(|_| busy())?.map_err(sent_error)?,
        };
        let status = response.status().as_u16();
        tracing::debug!(provider = %self.row.id, model, status, ms = sent.elapsed().as_millis() as u64, "answered");
        if !response.status().is_success() {
            return Err(self.refusal(response).await);
        }

        let mut buf: Vec<u8> = Vec::new();
        let mut first_byte_ms: Option<u32> = None;
        let mut finished = false;
        let mut done = ChatDone {
            model: model.to_owned(),
            provider: self.row.id.clone(),
            tokens_in: 0,
            tokens_out: 0,
            cost: 0.0,
            first_byte_ms: None,
        };
        'read: loop {
            let deadline = if first_byte_ms.is_some() {
                tokio::time::Instant::now() + self.between
            } else {
                first_deadline
            };
            // Dropping `response` on return closes the connection.
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                c = tokio::time::timeout_at(deadline, response.chunk()) => c.map_err(|_| busy())?,
            };
            let Ok(Some(chunk)) = chunk else {
                break; // the stream ended, or broke
            };
            buf.extend_from_slice(&chunk);
            while let Some(at) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=at).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(data) = line.trim().strip_prefix("data:") else {
                    continue; // blank lines, `event:`, `: keep-alive`
                };
                let data = data.trim();
                if data == "[DONE]" {
                    finished = true;
                    break 'read;
                }
                let Ok(frame) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if frame.get("error").is_some_and(|e| !e.is_null()) {
                    return Err(ProviderError::Other(format!(
                        "{} stopped partway: {}",
                        self.row.id,
                        said(data)
                    )));
                }
                if let Some(m) = frame["model"].as_str() {
                    done.model = m.to_owned();
                }
                if let Some(usage) = frame.get("usage").filter(|u| u.is_object()) {
                    done.tokens_in = usage["prompt_tokens"].as_i64().unwrap_or(0);
                    done.tokens_out = usage["completion_tokens"].as_i64().unwrap_or(0);
                }
                let choice = &frame["choices"][0];
                // v2: `finish_reason: "error"` is the provider saying the answer failed.
                if choice["finish_reason"] == "error" {
                    return Err(ProviderError::Other(format!(
                        "{} dropped the answer: it said the answer failed",
                        self.row.id
                    )));
                }
                if !choice["finish_reason"].is_null() {
                    finished = true;
                }
                let delta = &choice["delta"];
                let reasoning = delta["reasoning"]
                    .as_str()
                    .or_else(|| delta["reasoning_content"].as_str())
                    .filter(|s| !s.is_empty());
                let text = delta["content"].as_str().filter(|s| !s.is_empty());
                for chunk in [
                    reasoning.map(|s| ChatChunk::Reasoning(s.to_owned())),
                    text.map(|s| ChatChunk::Text(s.to_owned())),
                ]
                .into_iter()
                .flatten()
                {
                    first_byte_ms.get_or_insert(sent.elapsed().as_millis() as u32);
                    // A slow reader must not hold off a cancel.
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                        sent = out.send(chunk) => if sent.is_err() {
                            return Err(ProviderError::Cancelled); // nobody is listening any more
                        },
                    }
                }
            }
        }
        // v2 D158: a stream that just ends is a connection that closed under an answer.
        if !finished {
            return Err(ProviderError::Other(format!(
                "{} dropped the answer before it finished",
                self.row.id
            )));
        }
        done.first_byte_ms = first_byte_ms;
        tracing::debug!(provider = %self.row.id, model = %done.model, first_byte_ms, ms = sent.elapsed().as_millis() as u64, "done");
        Ok(done)
    }
}
