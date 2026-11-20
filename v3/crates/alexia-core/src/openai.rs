// SPDX-License-Identifier: AGPL-3.0-only
//! P1-04: the OpenAI-compatible provider (streamed chat, SSE parsed by hand).
//!
//! Never logs a key, a header value or a message body: provider id, model, status and timings.

use std::time::{Duration, Instant};

use alexia_store::{Content, MessageBody, Part, Role, ToolCall};
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

/// OpenAI's name rule is `^[a-zA-Z0-9_-]{1,64}$`; core names may hold `.` and be longer.
/// Wrong characters become `_`; a name that is too long, or lands on one already taken in this
/// request, is cut and gets a short hash of the original so two long names never collide.
fn wire_name(name: &str, taken: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let base: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = if base.is_empty() {
        "_".to_owned()
    } else {
        base
    };
    if base.chars().count() <= 64 && !taken.contains(&base) {
        return base;
    }
    let h = Sha256::digest(name.as_bytes());
    let keep: String = base.chars().take(64 - 9).collect();
    format!("{keep}_{:02x}{:02x}{:02x}{:02x}", h[0], h[1], h[2], h[3])
}

/// The words of a turn, images left out.
fn plain(content: &Content) -> String {
    match content {
        Content::Text(t) => t.clone(),
        Content::Parts(ps) => ps
            .iter()
            .filter_map(|p| match p {
                Part::Text { text } => Some(text.as_str()),
                Part::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn content_value(content: &Content) -> Value {
    match content {
        Content::Text(text) => json!(text),
        Content::Parts(parts) => parts
            .iter()
            .map(|p| match p {
                Part::Text { text } => json!({"type": "text", "text": text}),
                Part::Image { url } => json!({"type": "image_url", "image_url": {"url": url}}),
            })
            .collect(),
    }
}

/// v2: an empty `arguments` is `{}`.
fn args(arguments: &str) -> &str {
    if arguments.trim().is_empty() {
        "{}"
    } else {
        arguments
    }
}

/// Port of v2 `provider.ts` `toWire` (`calls` -> `tool_calls`, `callId` -> `tool_call_id`).
/// `names` pairs each request tool's wire name with its core name. A tool turn whose call id no
/// earlier assistant turn made is sent as a user note, so a strict provider never sees a result
/// without a call (v2 P1-24).
fn wire_messages(messages: &[(Role, MessageBody)], names: &[(String, String)]) -> Vec<Value> {
    let to_wire = |name: &str| {
        names
            .iter()
            .find(|(_, core)| core == name)
            .map_or_else(|| wire_name(name, &[]), |(wire, _)| wire.clone())
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::with_capacity(messages.len());
    for (role, body) in messages {
        let content = content_value(&body.content);
        out.push(match role {
            Role::System => json!({"role": "system", "content": content}),
            Role::User => json!({"role": "user", "content": content}),
            Role::Assistant => {
                let mut m = json!({"role": "assistant", "content": content});
                if let Some(calls) = body.calls.as_ref().filter(|c| !c.is_empty()) {
                    seen.extend(calls.iter().map(|c| c.id.as_str()));
                    m["tool_calls"] = calls
                        .iter()
                        .map(|c| {
                            json!({
                                "id": c.id,
                                "type": "function",
                                "function": {"name": to_wire(&c.name), "arguments": args(&c.arguments)},
                            })
                        })
                        .collect();
                }
                m
            }
            Role::Tool => match body.call_id.as_deref().filter(|id| seen.contains(id)) {
                Some(id) => {
                    json!({"role": "tool", "tool_call_id": id, "content": plain(&body.content)})
                }
                None => json!({
                    "role": "user",
                    "content": format!("A tool answered: {}", plain(&body.content)),
                }),
            },
        });
    }
    out
}

/// One streamed call, pieced together from `delta.tool_calls[i]` (v2 `chat`'s `calls[index]`).
#[derive(Default)]
struct Piece {
    id: String,
    name: String,
    arguments: String,
}

/// A slow reader must not hold off a cancel.
async fn emit(
    out: &mpsc::Sender<ChatChunk>,
    cancel: &CancellationToken,
    chunk: ChatChunk,
) -> Result<(), ProviderError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ProviderError::Cancelled),
        sent = out.send(chunk) => sent.map_err(|_| ProviderError::Cancelled), // nobody is listening
    }
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
        // The key first: a keyless no-list row is NeedsKey, not an answer that offers its seed.
        let (base, key) = self.reaching()?;
        let Some(path) = &self.row.models_path else {
            return Ok(Vec::new());
        };
        let response = self
            .request(reqwest::Method::GET, &format!("{base}{path}"), key)
            .timeout(self.first_byte)
            .send()
            .await
            .map_err(sent_error)?;
        if !response.status().is_success() {
            // Only a key problem may drop the cache: a moved or broken list endpoint
            // (400/404/422) is Other here, so the catalog keeps what it had.
            let status = response.status().as_u16();
            return Err(match self.refusal(response).await {
                ProviderError::Refused(said) if matches!(status, 400 | 404 | 422) => {
                    ProviderError::Other(format!("{} said {status}: {said}", self.row.id))
                }
                e => e,
            });
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
        let (base, key) = self.reaching()?;
        let mut names: Vec<(String, String)> = Vec::with_capacity(req.tools.len());
        for t in &req.tools {
            let taken: Vec<String> = names.iter().map(|(w, _)| w.clone()).collect();
            names.push((wire_name(&t.name, &taken), t.name.clone()));
        }
        let mut messages = Vec::with_capacity(req.messages.len() + 1);
        if let Some(system) = &req.system {
            messages.push(json!({"role": "system", "content": system}));
        }
        messages.extend(wire_messages(&req.messages, &names));
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
        // v2 `asFunction`.
        if !req.tools.is_empty() {
            body["tools"] = req
                .tools
                .iter()
                .zip(&names)
                .map(|(t, (wire, _))| {
                    json!({"type": "function", "function": {
                        "name": wire,
                        "description": t.description.as_deref().unwrap_or(""),
                        "parameters": if t.input_schema.is_null() {
                            json!({"type": "object", "properties": {}})
                        } else {
                            t.input_schema.clone()
                        },
                    }})
                })
                .collect();
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
        let mut pieces: std::collections::BTreeMap<u64, Piece> = Default::default();
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
                    emit(&out, &cancel, chunk).await?;
                }
                // Keyed by index: id and name arrive once, arguments in fragments.
                if let Some(calls) = delta["tool_calls"].as_array() {
                    for (n, call) in calls.iter().enumerate() {
                        first_byte_ms.get_or_insert(sent.elapsed().as_millis() as u32);
                        let at = pieces
                            .entry(call["index"].as_u64().unwrap_or(n as u64))
                            .or_default();
                        if let Some(id) = call["id"].as_str().filter(|s| !s.is_empty()) {
                            at.id = id.to_owned();
                        }
                        if let Some(name) =
                            call["function"]["name"].as_str().filter(|s| !s.is_empty())
                        {
                            at.name = name.to_owned();
                        }
                        if let Some(a) = call["function"]["arguments"].as_str() {
                            at.arguments.push_str(a);
                        }
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
        for (index, p) in pieces {
            if p.name.is_empty() {
                continue;
            }
            // An unknown wire name goes through unchanged: the loop reports an unknown tool.
            let name = names
                .iter()
                .find(|(wire, _)| *wire == p.name)
                .map_or(p.name, |(_, core)| core.clone());
            let id = if p.id.is_empty() {
                format!("call_{index}")
            } else {
                p.id
            };
            let arguments = args(&p.arguments).to_owned();
            let call = ToolCall {
                id,
                name,
                arguments,
            };
            emit(&out, &cancel, ChatChunk::ToolCall(call)).await?;
        }
        done.first_byte_ms = first_byte_ms;
        tracing::debug!(provider = %self.row.id, model = %done.model, first_byte_ms, ms = sent.elapsed().as_millis() as u64, "done");
        Ok(done)
    }
}
