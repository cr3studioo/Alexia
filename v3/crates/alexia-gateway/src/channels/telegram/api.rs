// SPDX-License-Identifier: AGPL-3.0-only
//! The Telegram Bot API over HTTPS, ported from v2's `plugins/telegram/api.js`.
//!
//! The token is in every URL, so no URL is ever logged or formatted: a reqwest error becomes
//! `Error::Unreachable` without its `Display`, and `Api`'s `Debug` prints only `base`.

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{Error, Result};

/// The Bot API's own download limit.
pub const FILE_MAX: u64 = 20 * 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Whole-body timeout for file uploads and downloads (up to FILE_MAX on a slow link).
const FILE_TIMEOUT: Duration = Duration::from_secs(120);
/// The longest wait a 429 may ask for; longer answers are clamped.
const RETRY_AFTER_MAX_MS: u64 = 3_600_000;

/// The Bot API client: one kept-alive HTTPS connection pool for every call.
pub struct Api {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl std::fmt::Debug for Api {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Api").field("base", &self.base).finish()
    }
}

/// The subset of `Update` V3-1 reads; every other field is ignored.
#[derive(Clone, Debug, Deserialize)]
pub struct Update {
    pub update_id: i64,
    pub message: Option<TgMessage>,
    pub callback_query: Option<CallbackQuery>,
    pub stopped_message_generation: Option<StoppedGeneration>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TgMessage {
    pub message_id: i64,
    pub date: i64,
    pub chat: TgChat,
    pub from: Option<User>,
    pub text: Option<String>,
    pub caption: Option<String>,
    #[serde(default)]
    pub photo: Vec<PhotoSize>,
    pub voice: Option<FileRef>,
    pub audio: Option<FileRef>,
    pub document: Option<Document>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TgChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct User {
    pub id: i64,
    pub is_bot: bool,
    pub username: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PhotoSize {
    pub file_id: String,
    pub width: u32,
    pub height: u32,
    pub file_size: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FileRef {
    pub file_id: String,
    pub mime_type: Option<String>,
    pub file_size: Option<u64>,
    pub duration: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Document {
    pub file_id: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub file_size: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CallbackQuery {
    pub id: String,
    pub from: User,
    pub message: Option<TgMessage>,
    pub data: Option<String>,
}

/// The Stop button on a draft: the same `draft_id` `send_draft` chose.
#[derive(Clone, Debug, Deserialize)]
pub struct StoppedGeneration {
    pub chat: TgChat,
    pub draft_id: i64,
}

#[derive(Deserialize)]
struct Sent {
    message_id: i64,
}

#[derive(Deserialize)]
struct TgFile {
    file_path: Option<String>,
    file_size: Option<u64>,
}

/// Never formats `err`: its `Display` carries the URL, and the URL carries the token.
fn unreachable(_err: reqwest::Error) -> Error {
    Error::Unreachable
}

impl Api {
    /// `base` = "https://api.telegram.org" or the test hook `ALEXIA_TELEGRAM_API`.
    pub fn new(base: &str, token: String) -> Api {
        let client = reqwest::Client::builder()
            .pool_idle_timeout(None)
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Api {
            client,
            base: base.trim_end_matches('/').to_owned(),
            token,
        }
    }

    fn url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.base, self.token)
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, body: Value) -> Result<T> {
        let request = self.client.post(self.url(method)).json(&body);
        self.answer(method, request.timeout(CALL_TIMEOUT)).await
    }

    /// Sends and reads `{ok, result, description, parameters.retry_after}`.
    async fn answer<T: DeserializeOwned>(
        &self,
        method: &str,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let response = request.send().await.map_err(unreachable)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(unreachable)?;
        let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if (200..300).contains(&status) && answer["ok"] == true {
            return serde_json::from_value(answer["result"].clone()).map_err(|_| {
                Error::Service(format!("Telegram's answer to {method} didn't parse"))
            });
        }
        let code = answer["error_code"].as_u64().map_or(status, |c| c as u16);
        Err(match code {
            409 => Error::Conflict,
            429 => Error::RateLimited {
                retry_after_ms: answer["parameters"]["retry_after"]
                    .as_u64()
                    .unwrap_or(1)
                    .saturating_mul(1000)
                    .min(RETRY_AFTER_MAX_MS),
            },
            401 => Error::Unauthorized,
            404 if method == "getMe" => Error::Unauthorized,
            _ => Error::Service(
                answer["description"]
                    .as_str()
                    .map_or_else(|| format!("Telegram answered {status}"), str::to_owned),
            ),
        })
    }

    pub async fn get_me(&self) -> Result<User> {
        self.call("getMe", json!({})).await
    }

    /// Long poll. `timeout_s` 50 (v2's POLL_SECONDS); allowed_updates
    /// ["message","callback_query","stopped_message_generation"] as v2 sends.
    pub async fn get_updates(
        &self,
        offset: i64,
        timeout_s: u32,
        cancel: &CancellationToken,
    ) -> Result<Vec<Update>> {
        let body = json!({
            "offset": offset,
            "timeout": timeout_s,
            "allowed_updates": ["message", "callback_query", "stopped_message_generation"],
        });
        let request = self
            .client
            .post(self.url("getUpdates"))
            .json(&body)
            .timeout(Duration::from_secs(u64::from(timeout_s) + 10));
        tokio::select! {
            // Dropping the request future closes its connection.
            () = cancel.cancelled() => Err(Error::Cancelled),
            got = self.answer("getUpdates", request) => got,
        }
    }

    pub async fn set_reaction(&self, chat: i64, message: i64, emoji: &str) -> Result<()> {
        let body = json!({
            "chat_id": chat,
            "message_id": message,
            "reaction": [{"type": "emoji", "emoji": emoji}],
        });
        self.call::<Value>("setMessageReaction", body)
            .await
            .map(drop)
    }

    /// `action`: "typing", "record_voice", "upload_voice".
    pub async fn chat_action(&self, chat: i64, action: &str) -> Result<()> {
        let body = json!({"chat_id": chat, "action": action});
        self.call::<Value>("sendChatAction", body).await.map(drop)
    }

    /// One row of inline buttons, `(label, callback_data)`. Text over 4096 characters is the
    /// caller's to split; Telegram's "message is too long" comes back as `Service`.
    pub async fn send_message(
        &self,
        chat: i64,
        text: &str,
        buttons: Option<&[(String, String)]>,
        reply_to: Option<i64>,
    ) -> Result<i64> {
        let mut body = json!({"chat_id": chat, "text": text, "disable_web_page_preview": true});
        if let Some(buttons) = buttons {
            let row: Vec<Value> = buttons
                .iter()
                .map(|(label, data)| json!({"text": label, "callback_data": data}))
                .collect();
            body["reply_markup"] = json!({"inline_keyboard": [row]});
        }
        if let Some(id) = reply_to {
            body["reply_parameters"] = json!({"message_id": id});
        }
        Ok(self.call::<Sent>("sendMessage", body).await?.message_id)
    }

    pub async fn edit_message(&self, chat: i64, message: i64, text: &str) -> Result<()> {
        let body = json!({"chat_id": chat, "message_id": message, "text": text});
        self.call::<Value>("editMessageText", body).await.map(drop)
    }

    /// Takes the buttons off an answered message so it can't be answered twice.
    pub async fn remove_buttons(&self, chat: i64, message: i64) -> Result<()> {
        let body = json!({
            "chat_id": chat,
            "message_id": message,
            "reply_markup": {"inline_keyboard": []},
        });
        self.call::<Value>("editMessageReplyMarkup", body)
            .await
            .map(drop)
    }

    /// Bot API 9.x draft. `can_stop` puts the Stop button on it, which comes back as a
    /// `stopped_message_generation` update with this `draft_id`.
    pub async fn send_draft(
        &self,
        chat: i64,
        draft_id: i64,
        text: &str,
        can_stop: bool,
    ) -> Result<()> {
        let mut body = json!({"chat_id": chat, "draft_id": draft_id, "text": text});
        if can_stop {
            body["can_stop"] = json!(true);
        }
        self.call::<Value>("sendMessageDraft", body).await.map(drop)
    }

    async fn upload(&self, method: &str, form: Form) -> Result<i64> {
        let request = self
            .client
            .post(self.url(method))
            .multipart(form)
            .timeout(FILE_TIMEOUT);
        Ok(self.answer::<Sent>(method, request).await?.message_id)
    }

    /// Ogg/Opus only: anything else Telegram shows as a file, not a voice bubble.
    pub async fn send_voice(&self, chat: i64, ogg: Vec<u8>, reply_to: Option<i64>) -> Result<i64> {
        let voice = Part::bytes(ogg)
            .file_name("reply.ogg")
            .mime_str("audio/ogg")
            .map_err(|_| Error::Service("audio/ogg refused as a mime type".into()))?;
        let mut form = Form::new()
            .text("chat_id", chat.to_string())
            .part("voice", voice);
        if let Some(id) = reply_to {
            form = form.text("reply_parameters", json!({"message_id": id}).to_string());
        }
        self.upload("sendVoice", form).await
    }

    pub async fn send_document(
        &self,
        chat: i64,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<i64> {
        let part = Part::bytes(bytes).file_name(name.to_owned());
        let part = part
            .mime_str(mime)
            .map_err(|_| Error::Service(format!("not a mime type: {mime}")))?;
        let form = Form::new()
            .text("chat_id", chat.to_string())
            .part("document", part);
        self.upload("sendDocument", form).await
    }

    /// Stops the button's spinner; skipping it looks like a hung bot.
    pub async fn answer_callback(&self, id: &str, text: Option<&str>) -> Result<()> {
        let mut body = json!({"callback_query_id": id});
        if let Some(text) = text {
            body["text"] = json!(text);
        }
        self.call::<Value>("answerCallbackQuery", body)
            .await
            .map(drop)
    }

    /// getFile then download, returning the bytes. Refuses files over 20 MB (the Bot API's own
    /// limit).
    pub async fn download(&self, file_id: &str) -> Result<Vec<u8>> {
        let too_big = || Error::Service("the file is over Telegram's 20 MB limit".into());
        let file: TgFile = self.call("getFile", json!({"file_id": file_id})).await?;
        if file.file_size.is_some_and(|n| n > FILE_MAX) {
            return Err(too_big());
        }
        let path = file
            .file_path
            .ok_or_else(|| Error::Service("Telegram gave no path for that file".into()))?;
        let url = format!("{}/file/bot{}/{path}", self.base, self.token);
        let mut response = self
            .client
            .get(url)
            .timeout(FILE_TIMEOUT)
            .send()
            .await
            .map_err(unreachable)?;
        if !response.status().is_success() {
            return Err(Error::Service(format!(
                "Telegram answered {} for that file",
                response.status().as_u16()
            )));
        }
        if response.content_length().is_some_and(|n| n > FILE_MAX) {
            return Err(too_big());
        }
        // ponytail: whole file in memory (at most 20 MB); stream if the limit ever grows.
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() as u64 > FILE_MAX {
                return Err(too_big());
            }
        }
        Ok(bytes)
    }
}
