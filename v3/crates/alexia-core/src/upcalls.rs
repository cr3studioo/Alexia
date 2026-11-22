// SPDX-License-Identifier: AGPL-3.0-only
//! What plugins ask of core: sampling (with `alexia/tools`), elicitation, roots, attachments.
//! A port of v2 `serve.ts` `sample` / `asTask` / `asCommand` / `privately` / `declaredFor`,
//! `streaming.ts`, `router.ts` `sizeFor` / `sizedFor`, and `attachments/`. P2-34 adds the
//! host-answered capabilities.
//!
//! Where v2 and `docs/spec/wire-protocol.md` differ, the spec wins (it says what a plugin sees).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use alexia_mcp::alexia::{AttachmentsCall, PrivacyMode};
use alexia_mcp::jsonrpc::{code, RpcError};
use alexia_mcp::types::{
    ClientCapabilities, CreateMessageParams, Empty, ProgressParams, ProgressToken, Root,
};
use alexia_mcp::{HostFacts, PluginId, ProgressSink, Upcalls};
use alexia_store::{now_ms, Content, MessageBody, Part, Role, SessionId, Store};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::agent::{Agent, Task};
use crate::catalog::Candidate;
use crate::router::{Needs, StepAsk};
use crate::{
    free, permissions, Budget, ChatChunk, ChatDone, ChatRequest, DraftFrame, DraftSink, Job,
    Origin, Phase, ProviderError, Question, RunEnd, RunId, Steer, Turn,
};

const NS: &str = "_core";
const LOCAL_META: &str = "alexia/local";
const FORMAT_META: &str = "alexia/format";
const TOOLS_META: &str = "alexia/tools";
const LENGTHS_META: &str = "alexia/lengths";
const STREAM_META: &str = "alexia/stream";
/// How long a plain sampling step waits for a first byte before another model starts.
const BUDGET: Budget = Budget {
    first_byte_ms: 8_000,
};
/// v2 `STREAM_EVERY`: at most this often, gathered words go out.
const STREAM_EVERY: Duration = Duration::from_millis(200);
/// How many models one plain request may try when one answers with nothing.
const MOST_TRIES: usize = 3;
/// v2 `PLANNER` (billions) and `READS_SHORT` (tokens): below either, a model is given the short length.
const PLANNER: f32 = 7.0;
const READS_SHORT: u32 = 32_768;
const NO_LOCAL: &str = "This is answered only by a model running on this computer, and there is none — install one in Settings under Local models.";
const BUSY: &str = "The free models are all busy right now. Try again in a minute.";
const NO_FREE: &str = "No free model can answer right now.";
const NEW_ALREADY: &str = "This is already a new chat — nothing has been said in it.";
const NEW_STARTED: &str = "Started a new chat.";

fn fail(message: impl Into<String>) -> RpcError {
    RpcError::new(code::INTERNAL_ERROR, message)
}

fn bad(message: impl Into<String>) -> RpcError {
    RpcError::new(code::INVALID_PARAMS, message)
}

fn store_fail(e: impl std::fmt::Display) -> RpcError {
    tracing::warn!("an upcall could not use the store: {e}");
    fail("Alexia could not read or write that.")
}

/// The sentence a failed model call ends with.
fn sentence(e: &ProviderError) -> String {
    match e {
        ProviderError::Other(s) if !s.trim().is_empty() => s.clone(),
        ProviderError::Busy { .. } => BUSY.into(),
        _ => NO_FREE.into(),
    }
}

fn key(c: &Candidate) -> String {
    format!("{}\n{}", c.provider, c.model)
}

// ---- the request, as the router reads it ------------------------------------------------

/// MCP lets one turn carry several blocks and several kinds. Text and pictures reach the model;
/// anything else is named rather than dropped (v2 `asParts`).
fn content_of(content: &Value) -> Content {
    let blocks: Vec<&Value> = match content {
        Value::Array(a) => a.iter().collect(),
        one => vec![one],
    };
    let parts: Vec<Part> = blocks
        .into_iter()
        .map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => Part::Text {
                text: b["text"].as_str().unwrap_or_default().to_owned(),
            },
            Some("image") => Part::Image {
                url: format!(
                    "data:{};base64,{}",
                    b["mimeType"].as_str().unwrap_or("image/png"),
                    b["data"].as_str().unwrap_or_default()
                ),
            },
            Some(other) => Part::Text {
                text: format!("[{other}]"),
            },
            None => Part::Text {
                text: String::new(),
            },
        })
        .collect();
    match parts.as_slice() {
        [Part::Text { text }] => Content::Text(text.clone()),
        _ => Content::Parts(parts),
    }
}

fn body(content: Content) -> MessageBody {
    MessageBody {
        content,
        calls: None,
        call_id: None,
        provider: None,
        notes: None,
        bad: None,
        stopped: None,
        typed: None,
        extra: Map::new(),
    }
}

/// The plugin's messages, in the order sent (no system row: that is `system_prompt`).
fn asked_of(params: &CreateMessageParams) -> Vec<(Role, MessageBody)> {
    params
        .messages
        .iter()
        .map(|m| {
            let role = match m["role"].as_str() {
                Some("assistant") => Role::Assistant,
                _ => Role::User,
            };
            (role, body(content_of(&m["content"])))
        })
        .collect()
}

/// v2: a slash command is one short line with a command-shaped first word.
fn command_in(asked: &[(Role, MessageBody)]) -> Option<String> {
    let last = asked.iter().rev().find(|(r, _)| *r == Role::User)?;
    let typed = last.1.content.text().trim().to_owned();
    let rest = typed.strip_prefix('/')?;
    let first = rest.split(char::is_whitespace).next().unwrap_or_default();
    let named = first
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    (!typed.contains('\n') && named).then_some(typed)
}

/// v2 `wantsCapable`: the whole of what core reads from MCP's `modelPreferences`.
fn wants_capable(prefs: Option<&Value>) -> bool {
    let n = |k: &str| prefs.and_then(|p| p.get(k)).and_then(Value::as_f64);
    n("intelligencePriority").is_some_and(|mind| {
        mind >= 0.5
            && mind > n("costPriority").unwrap_or(0.0)
            && mind > n("speedPriority").unwrap_or(0.0)
    })
}

// ---- personality lengths (v2 router.ts `sizeFor` / `sizedFor`) --------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Size {
    Small,
    Medium,
    High,
}

impl Size {
    fn name(self) -> &'static str {
        match self {
            Size::Small => "small",
            Size::Medium => "medium",
            Size::High => "high",
        }
    }
    fn parse(s: &str) -> Option<Size> {
        match s {
            "small" => Some(Size::Small),
            "medium" => Some(Size::Medium),
            "high" => Some(Size::High),
            _ => None,
        }
    }
}

/// Which length this model is given: the weaker reader when in doubt. Nothing here is paid
/// (D212), so `High` is never the chat's answer.
// ponytail: v2 also sends the short one to a model "unknown in size whose record is doubted";
// the health record is not ported, so unknown size is medium.
fn size_for(c: &Candidate) -> Size {
    if c.size_b.is_some_and(|b| b < PLANNER)
        || (c.context > 0 && c.context < READS_SHORT)
        || c.router
    {
        Size::Small
    } else {
        Size::Medium
    }
}

struct Lengths {
    high: String,
    medium: Option<String>,
    small: Option<String>,
}

/// v2 `personalityFrom`: a length that is not a string with something in it is no length, and
/// without the long one there is no personality.
fn lengths_from(v: &Value) -> Option<Lengths> {
    let one = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some(Lengths {
        high: one("high")?,
        medium: one("medium"),
        small: one("small"),
    })
}

/// v2 `sizedFor`: what a model of this size is given, and the size that text actually is.
fn sized_for(l: &Lengths, size: Size) -> (String, Size) {
    match (size, &l.small, &l.medium) {
        (Size::Small, Some(s), _) => (s.clone(), Size::Small),
        (Size::High, _, _) => (l.high.clone(), Size::High),
        (_, _, Some(m)) => (m.clone(), Size::Medium),
        _ => (l.high.clone(), Size::High),
    }
}

// ---- alexia/stream (v2 streaming.ts) ----------------------------------------------------

fn phase_name(p: Phase) -> &'static str {
    match p {
        Phase::Choosing => "choosing",
        Phase::Asking => "asking",
        Phase::Retrying => "retrying",
        Phase::Backup => "backup",
        Phase::Thinking => "thinking",
        Phase::Writing => "writing",
        Phase::Tool => "tool",
    }
}

/// Gathers the draft into a few frames a second: the first words at once, a phase or restart
/// at once and after the words before it, and whatever is held when the draft ends. Without a
/// sink (no progress token) the draft is simply drained. The frames and the result share one
/// pipe, so the caller drops the sender and awaits this before it answers.
async fn frames(mut rx: mpsc::Receiver<DraftFrame>, sink: Option<ProgressSink>, every: Duration) {
    let Some(sink) = sink else {
        while rx.recv().await.is_some() {}
        return;
    };
    let mut count = 0.0;
    let mut say = |frame: Value| {
        count += 1.0;
        let mut meta = Map::new();
        meta.insert(STREAM_META.into(), frame);
        ProgressParams {
            // The connection puts the plugin's own token on it.
            progress_token: ProgressToken::Num(0),
            progress: count,
            total: None,
            message: None,
            meta: Some(meta),
        }
    };
    let (mut held, mut last): (String, Option<Instant>) = (String::new(), None);
    let (mut spoke, mut gap) = (false, false);
    loop {
        let next = if held.is_empty() {
            rx.recv().await
        } else {
            // Words are held only after a frame went out, so `last` is set.
            let due = last.map_or_else(Instant::now, |t| t + every);
            tokio::select! {
                f = rx.recv() => f,
                () = tokio::time::sleep_until(due) => {
                    let _ = sink.send(say(json!({ "delta": std::mem::take(&mut held) }))).await;
                    last = Some(Instant::now());
                    continue;
                }
            }
        };
        let Some(frame) = next else {
            if !held.is_empty() {
                let _ = sink.send(say(json!({ "delta": held }))).await;
            }
            return;
        };
        match frame {
            DraftFrame::Delta(t) if t.is_empty() => {}
            DraftFrame::Delta(t) => {
                // In a task with tools, the next turn's words are set apart from the last's.
                if gap {
                    held.push_str("\n\n");
                    gap = false;
                }
                held.push_str(&t);
                spoke = true;
                if last.is_none_or(|l| l.elapsed() >= every) {
                    let _ = sink
                        .send(say(json!({ "delta": std::mem::take(&mut held) })))
                        .await;
                    last = Some(Instant::now());
                }
            }
            DraftFrame::Restart => {
                (held, spoke, gap) = (String::new(), false, false);
                let _ = sink.send(say(json!({ "restart": true }))).await;
            }
            DraftFrame::Phase(p) => {
                if !held.is_empty() {
                    let _ = sink
                        .send(say(json!({ "delta": std::mem::take(&mut held) })))
                        .await;
                    last = Some(Instant::now());
                }
                gap |= p == Phase::Tool && spoke;
                let _ = sink.send(say(json!({ "phase": phase_name(p) }))).await;
            }
            DraftFrame::Steerable => {}
        }
    }
}

/// A draft sink feeding [`frames`], and the task to await once the sender is dropped.
fn streamer(progress: Option<ProgressSink>) -> (DraftSink, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(64);
    (tx, tokio::spawn(frames(rx, progress, STREAM_EVERY)))
}

/// Forwards a model's chunks to the draft and returns the words (reasoning is a phase, never text).
async fn gather(mut rx: mpsc::Receiver<ChatChunk>, draft: DraftSink) -> String {
    let (mut text, mut writing, mut thinking) = (String::new(), false, false);
    while let Some(c) = rx.recv().await {
        match c {
            ChatChunk::Text(t) => {
                if !writing {
                    writing = true;
                    let _ = draft.send(DraftFrame::Phase(Phase::Writing)).await;
                }
                text.push_str(&t);
                let _ = draft.send(DraftFrame::Delta(t)).await;
            }
            ChatChunk::Reasoning(_) if !thinking => {
                thinking = true;
                let _ = draft.send(DraftFrame::Phase(Phase::Thinking)).await;
            }
            ChatChunk::Reasoning(_) | ChatChunk::ToolCall(_) => {}
        }
    }
    text
}

fn assistant(text: String, model: &str, cut: bool) -> Value {
    json!({
        "role": "assistant",
        "content": { "type": "text", "text": text },
        "model": model,
        "stopReason": if cut { "maxTokens" } else { "endTurn" },
    })
}

/// What one plain request asks of the router.
struct How {
    job: Job,
    background: bool,
    lengths: Option<Lengths>,
    hear: Option<Size>,
}

/// What a plain request heard back.
struct Heard {
    text: String,
    done: ChatDone,
    /// With lengths: the size sent, and whether it is the one the chat would give that model.
    sent: Option<Size>,
    matched: bool,
}

impl Agent {
    fn owner_origin(&self) -> Origin {
        owner_origin(&self.parts().store)
    }

    /// v2 `conversation`: the session a plugin's own conversation lives in, made on first use.
    fn conversation(&self, plugin: &PluginId) -> Result<SessionId, RpcError> {
        let store = &self.parts().store;
        let held = format!("chat:{}", plugin.0);
        if let Some(n) = store
            .kv_get(NS, &held)
            .map_err(store_fail)?
            .and_then(|v| v.as_i64())
        {
            if store
                .sessions()
                .map_err(store_fail)?
                .iter()
                .any(|s| s.id.0 == n)
            {
                return Ok(SessionId(n));
            }
        }
        let made = store
            .create_session(Some(&self.plugin_name(plugin)))
            .map_err(store_fail)?;
        store
            .kv_set(NS, &held, &json!(made.0))
            .map_err(store_fail)?;
        Ok(made)
    }

    fn plugin_name(&self, plugin: &PluginId) -> String {
        self.host()
            .manifests()
            .into_iter()
            .find(|d| d.manifest.id == plugin.0)
            .map_or_else(|| plugin.0.clone(), |d| d.manifest.name)
    }

    /// v2 `freshFor`: `/new` typed in a plugin's conversation. An empty one is not stacked on.
    fn fresh_for(&self, plugin: &PluginId) -> Result<String, RpcError> {
        let store = &self.parts().store;
        let open = self.conversation(plugin)?;
        if store.history(open, Some(1)).map_err(store_fail)?.is_empty() {
            return Ok(NEW_ALREADY.into());
        }
        let made = store
            .create_session(Some(&self.plugin_name(plugin)))
            .map_err(store_fail)?;
        store
            .kv_set(NS, &format!("chat:{}", plugin.0), &json!(made.0))
            .map_err(store_fail)?;
        Ok(NEW_STARTED.into())
    }

    /// v2 `asCommand`: answered by core, not by a model, while a task may be running.
    async fn as_command(
        &self,
        plugin: &PluginId,
        typed: String,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        if typed == "/new" {
            return Ok(assistant(self.fresh_for(plugin)?, "", false));
        }
        let turn = Turn {
            session: self.conversation(plugin)?,
            origin: Origin::Desktop,
            content: Content::Text(typed),
            files: Vec::new(),
            received_at: now_ms(),
            steer: Steer::none(),
        };
        // Straight to the command handler: `reply` would turn a non-owner `/…` into a full
        // tool-using run that skips the Local-mode and tools checks below.
        match crate::commands::run(self, &turn, cancel).await {
            Ok(r) => Ok(assistant(r.text, "", false)),
            Err(e) => Err(fail(e.to_string())),
        }
    }

    /// v2 `privately`: one completion on this computer only, no tools, no history but what the
    /// plugin sent. A format is checked after the answer: a model that did not follow it is an
    /// error, never half an answer.
    async fn privately(
        &self,
        plugin: &PluginId,
        req: ChatRequest,
        format: Option<&Value>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let ask = StepAsk {
            job: Job::Local,
            avoid: Vec::new(),
            plugin: Some(plugin.0.clone()),
            run: None,
            session: None,
        };
        let (tx, rx) = mpsc::channel(64);
        let (sink, _) = mpsc::channel(1);
        let (done, text) = tokio::join!(
            self.parts()
                .router
                .step(&req, &ask, BUDGET, tx, cancel.clone()),
            gather(rx, sink),
        );
        let done = match done {
            Err(_) if cancel.is_cancelled() => return Err(fail("Stopped.")),
            Err(_) => return Err(fail(NO_LOCAL)),
            Ok(done) => done,
        };
        if text.trim().is_empty() {
            return Err(fail("The model on this computer gave no answer."));
        }
        if let Some(f) = format {
            if serde_json::from_str::<Value>(text.trim()).is_err() {
                return Err(fail(format!(
                    "The answer did not follow the format “{}”, so it was discarded.",
                    f["name"].as_str().unwrap_or_default()
                )));
            }
        }
        let cut = req
            .max_tokens
            .is_some_and(|m| done.tokens_out >= i64::from(m));
        Ok(assistant(text, &done.model, cut))
    }

    /// v2 `underHalf`, as a filter over `request_count`: a background request keeps off the
    /// second half of a day-limited provider's day. Returns the models it must avoid.
    fn kept_for_chat(&self, ranked: &[Candidate], now: i64) -> Vec<Candidate> {
        let ladder = free::ladder();
        ranked
            .iter()
            .filter(|c| {
                let Some(rpd) = ladder
                    .iter()
                    .find(|r| r.id == c.provider)
                    .and_then(|r| r.rpd)
                else {
                    return false;
                };
                let spent = self
                    .parts()
                    .store
                    .request_count(&c.provider, "day", now)
                    .unwrap_or(0);
                spent * 2 >= u64::from(rpd)
            })
            .cloned()
            .collect()
    }

    /// One plain request, through the router: the cheapest free model that fits, or with
    /// `Job::Plan` the strongest. With lengths, one model at a time so each is sent its own.
    async fn answer(
        &self,
        plugin: &PluginId,
        mut req: ChatRequest,
        how: How,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Heard, RpcError> {
        let router = &self.parts().router;
        let now = now_ms();
        let needs = Needs::of(&req);
        let ranked = router.ranked_for(now, &needs);
        let kept = if how.background {
            self.kept_for_chat(&ranked, now)
        } else {
            Vec::new()
        };
        if !ranked.is_empty() && kept.len() == ranked.len() {
            let mut names: Vec<&str> = kept.iter().map(|c| c.provider.as_str()).collect();
            names.sort_unstable();
            names.dedup();
            return Err(fail(format!(
                "No model can answer this just now: the rest of today's {} requests are kept for your chat.",
                names.join(" and ")
            )));
        }
        let mut avoid: Vec<String> = kept.iter().map(key).collect();
        let ask = |avoid: Vec<String>| StepAsk {
            job: how.job,
            avoid,
            plugin: Some(plugin.0.clone()),
            run: None,
            session: None,
        };
        let mut last: Option<ProviderError> = None;

        // The rungs to try one at a time, each sent its own length; or None for the router's own order.
        let rungs: Option<Vec<(Candidate, bool)>> = how.lengths.as_ref().map(|_| {
            let mut pool: Vec<Candidate> = ranked
                .iter()
                .filter(|c| !avoid.contains(&key(c)))
                .cloned()
                .collect();
            if how.job == Job::Plan {
                // A router is a different model each time: never the answer to "give me one that can write".
                pool.retain(|c| !c.router);
                pool.sort_by(|a, b| {
                    b.size_b
                        .partial_cmp(&a.size_b)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            match how.hear {
                None => pool.into_iter().map(|c| (c, true)).collect(),
                Some(want) => {
                    let given: Vec<_> = pool
                        .iter()
                        .filter(|c| size_for(c) == want)
                        .cloned()
                        .collect();
                    if !given.is_empty() {
                        given.into_iter().map(|c| (c, true)).collect()
                    } else {
                        let mut near = pool;
                        if want == Size::High {
                            near.sort_by(|a, b| {
                                b.size_b
                                    .partial_cmp(&a.size_b)
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            });
                        }
                        near.into_iter().map(|c| (c, false)).collect()
                    }
                }
            }
        });

        if let (Some(rungs), Some(lengths)) = (rungs, how.lengths.as_ref()) {
            for (rung, matched) in rungs.into_iter().take(MOST_TRIES) {
                let size = how.hear.unwrap_or_else(|| size_for(&rung));
                let (text, sent) = sized_for(lengths, size);
                req.system = Some(text);
                let others = ranked
                    .iter()
                    .filter(|c| key(c) != key(&rung))
                    .map(key)
                    .collect();
                match self.step_once(&req, ask(others), &draft, &cancel).await {
                    Ok((text, done)) if !text.trim().is_empty() => {
                        return Ok(Heard {
                            text,
                            done,
                            sent: Some(sent),
                            matched,
                        });
                    }
                    Ok(_) => {}
                    Err(e) if cancel.is_cancelled() => {
                        return Err(fail(format!("Stopped. {}", sentence(&e))))
                    }
                    Err(e) => last = Some(e),
                }
            }
        } else {
            for _ in 0..MOST_TRIES {
                match self
                    .step_once(&req, ask(avoid.clone()), &draft, &cancel)
                    .await
                {
                    Ok((text, done)) if !text.trim().is_empty() => {
                        return Ok(Heard {
                            text,
                            done,
                            sent: None,
                            matched: true,
                        });
                    }
                    // An empty answer: another model.
                    Ok((_, done)) => avoid.push(format!("{}\n{}", done.provider, done.model)),
                    Err(e) => {
                        last = Some(e);
                        break;
                    }
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(fail("Stopped."));
        }
        Err(fail(last.as_ref().map_or_else(|| NO_FREE.into(), sentence)))
    }

    async fn step_once(
        &self,
        req: &ChatRequest,
        ask: StepAsk,
        draft: &DraftSink,
        cancel: &CancellationToken,
    ) -> Result<(String, ChatDone), ProviderError> {
        let (tx, rx) = mpsc::channel(64);
        let (done, text) = tokio::join!(
            self.parts()
                .router
                .step(req, &ask, BUDGET, tx, cancel.clone()),
            gather(rx, draft.clone()),
        );
        done.map(|d| (text, d))
    }

    /// v2 `asTask`: the whole loop, on a session the plugin's conversation maps to.
    async fn as_task(
        &self,
        plugin: &PluginId,
        params: &CreateMessageParams,
        asked: Vec<(Role, MessageBody)>,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let session = self.conversation(plugin)?;
        let mut messages = asked;
        if let Some(prompt) = &params.system_prompt {
            messages.insert(0, (Role::System, body(Content::Text(prompt.clone()))));
        }
        // The turn that started this is written down before the answer to it is; the whole
        // turn, a picture in it included.
        let started = messages.iter().rev().find(|(r, _)| *r == Role::User);
        if let Some((_, b)) = started {
            self.parts()
                .store
                .append(session, Role::User, None, b)
                .map_err(store_fail)?;
        }
        let task = Task {
            session,
            origin: self.owner_origin(),
            messages,
            standing: Vec::new(),
            // ponytail: v2 asks whether a button press of this plugin is in flight. The host
            // exposes no such count yet, so every plugin task counts as background: it keeps
            // off the chat's half of a day-limited tier and gets the background step ceiling.
            background: true,
            plugin: Some(plugin.clone()),
            run: None,
            parent: None,
            max_steps: None,
            steer: Steer::none(),
            steps_done: None,
        };
        let (draft, streaming) = streamer(progress);
        let result = self.run(task, draft, cancel).await;
        let _ = streaming.await;
        let result = result.map_err(|e| fail(e.to_string()))?;
        match result.end {
            RunEnd::Answered | RunEnd::Ceiling => Ok(assistant(
                result.text,
                result.model.as_deref().unwrap_or_default(),
                false,
            )),
            RunEnd::Stopped => Err(fail("Stopped.")),
            RunEnd::Refused(why) => Err(fail(why)),
        }
    }
}

/// Where a plugin's approval questions go: the owner's primary chat when one is known (the
/// asker answers *no* for a desktop origin, because nobody is there to see it).
fn owner_origin(store: &Store) -> Origin {
    // Read off the table rather than a list of channel names: core knows none.
    let found = store.transaction(|tx| {
        let mut st = tx.prepare(
            "SELECT channel, chat FROM channel_chats WHERE is_primary = 1 ORDER BY channel LIMIT 1",
        )?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    });
    match found.ok().and_then(|r| r.into_iter().next()) {
        Some((channel, chat)) => Origin::Channel { channel, chat },
        None => Origin::Desktop,
    }
}

/// `{ "key": { "type": "boolean" } }` and nothing else: the one form core can ask.
fn yes_no(params: &Value) -> Option<(String, String)> {
    if params.get("mode").is_some_and(|m| m != "form") {
        return None;
    }
    let schema = params.get("requestedSchema")?;
    let props = schema.get("properties")?.as_object()?;
    let ((name, prop), None) = (props.iter().next()?, props.iter().nth(1)) else {
        return None;
    };
    (schema["type"] == "object" && prop["type"] == "boolean").then(|| {
        (
            params["message"].as_str().unwrap_or_default().to_owned(),
            name.clone(),
        )
    })
}

#[async_trait::async_trait]
impl Upcalls for Agent {
    /// sampling, elicitation, roots. Sampling is withdrawn in Local mode when nothing local can answer.
    fn offers(&self, _plugin: &PluginId) -> ClientCapabilities {
        let local_only = matches!(privacy(&self.parts().store), PrivacyMode::Local);
        ClientCapabilities {
            roots: Some(Empty {}),
            sampling: (!local_only || self.local_jobs().is_some()).then_some(Empty {}),
            elicitation: Some(Empty {}),
        }
    }

    /// `_core.display_name`, `_core.mode` → privacy, locale.
    fn host_facts(&self) -> HostFacts {
        let store = &self.parts().store;
        let text = |k: &str| {
            store
                .kv_get(NS, k)
                .ok()
                .flatten()
                .and_then(|v| v.as_str().map(str::to_owned))
                .filter(|s| !s.trim().is_empty())
        };
        HostFacts {
            display_name: text("display_name").unwrap_or_else(|| "Alexia".into()),
            privacy_mode: privacy(store),
            locale: text("locale").unwrap_or_else(|| "en-GB".into()),
        }
    }

    async fn sample(
        &self,
        plugin: &PluginId,
        params: CreateMessageParams,
        progress: Option<ProgressSink>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let meta = params.meta.clone().unwrap_or_default();
        let asked = asked_of(&params);
        let local = meta.get(LOCAL_META) == Some(&Value::Bool(true));
        let tools = meta.get(TOOLS_META) == Some(&Value::Bool(true));
        let format = meta.get(FORMAT_META);
        if let Some(f) = format {
            let named = f["name"].as_str().is_some_and(|n| {
                (1..=64).contains(&n.len())
                    && n.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            });
            if !(named && f["schema"].is_object() && f["strict"] == true) {
                return Err(bad(
                    "The answer format asked for is not one Alexia supports.",
                ));
            }
            if !local {
                return Err(bad(
                    "An answer format is only supported on a request kept on this computer.",
                ));
            }
        }
        if local && tools {
            return Err(bad("A request kept on this computer cannot use tools."));
        }
        let req = ChatRequest {
            messages: asked.clone(),
            system: params.system_prompt.clone(),
            tools: Vec::new(),
            max_tokens: params.max_tokens,
        };
        // A private request is never read as a command, never given tools, and never routed
        // anywhere that is not this computer.
        if local {
            return self.privately(plugin, req, format, cancel).await;
        }
        // A command is answered while a task runs: before the tools flag and before the router.
        if let Some(typed) = command_in(&asked) {
            return self.as_command(plugin, typed, cancel).await;
        }
        if matches!(privacy(&self.parts().store), PrivacyMode::Local) {
            return Err(fail(
                "Alexia is in Local mode, so a hosted model will not answer this. Ask for it to be kept on this computer.",
            ));
        }
        if tools {
            return self.as_task(plugin, &params, asked, progress, cancel).await;
        }

        // `min_tier` is the manifest's floor and `modelPreferences` is MCP's own: either asks
        // for a model that can do the work, not the cheapest that fits (v2 `declaredFor`).
        let floor = self
            .host()
            .manifests()
            .into_iter()
            .find(|d| d.manifest.id == plugin.0)
            .and_then(|d| d.manifest.min_tier);
        let capable = wants_capable(params.model_preferences.as_ref())
            || matches!(floor.as_deref(), Some("T2" | "T3"));
        let offered = meta.get(LENGTHS_META);
        let lengths = offered.and_then(lengths_from);
        let hear = offered
            .and_then(|o| o["hear"].as_str())
            .and_then(Size::parse);
        let how = How {
            job: if capable { Job::Plan } else { Job::Chat },
            background: true,
            lengths,
            hear,
        };
        let (draft, streaming) = streamer(progress);
        let heard = self.answer(plugin, req.clone(), how, draft, cancel).await;
        let _ = streaming.await;
        let heard = heard?;
        let cut = req
            .max_tokens
            .is_some_and(|m| heard.done.tokens_out >= i64::from(m));
        let mut out = assistant(heard.text, &heard.done.model, cut);
        if let (Some(sent), Some(lengths)) =
            (heard.sent, lengths_from(offered.unwrap_or(&Value::Null)))
        {
            // The model the chat asks first right now, and the length it is given.
            let first = self
                .parts()
                .router
                .ranked_for(now_ms(), &Needs::of(&req))
                .into_iter()
                .next();
            let mut told = json!({
                "sent": sent.name(),
                "model": heard.done.model,
                "paid": false,
                "cost": heard.done.cost,
                "matched": heard.matched,
            });
            if let Some(h) = hear {
                told["asked"] = json!(h.name());
            }
            if let Some(c) = first {
                told["chat"] =
                    json!({ "model": c.model, "size": sized_for(&lengths, size_for(&c)).1.name() });
            }
            out["_meta"] = json!({ LENGTHS_META: told });
        }
        Ok(out)
    }

    /// One yes/no form → `Ask::confirm`; anything else is refused (only that form is offered).
    async fn elicit(&self, plugin: &PluginId, params: Value) -> Result<Value, RpcError> {
        let Some((message, field)) = yes_no(&params) else {
            return Err(RpcError::new(
                code::MISSING_REQUIRED_CLIENT_CAPABILITY,
                "Alexia can only ask a yes or no question here.",
            ));
        };
        let question = Question {
            run: RunId(format!("elicit-{}-{}", plugin.0, now_ms())),
            text: format!("{} asks: {message}", self.plugin_name(plugin)),
            detail: None,
        };
        let yes = self
            .parts()
            .ask
            .confirm(&self.owner_origin(), &question, CancellationToken::new())
            .await;
        Ok(json!({ "action": "accept", "content": { field: yes } }))
    }

    async fn roots(&self, _plugin: &PluginId) -> Vec<Root> {
        let p = self.parts();
        permissions::roots_of(&permissions::scope(&p.store, &p.layout.root))
    }

    async fn attachments(
        &self,
        plugin: &PluginId,
        call: AttachmentsCall,
    ) -> Result<Value, RpcError> {
        let p = self.parts();
        let pics = Pictures {
            store: &p.store,
            uploads: p.layout.uploads(),
        };
        let own = p.layout.own_dir(&plugin.0);
        let text = |k: &str| call.params[k].as_str().unwrap_or_default().to_owned();
        match call.op {
            "lease" => {
                let ids: Vec<String> = call.params["attachmentIds"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                pics.lease(&text("conversationId"), &ids).map_err(bad)
            }
            "release" => pics
                .release(&text("leaseId"))
                .map(|()| json!({}))
                .map_err(bad),
            "live" => pics
                .live(&text("leaseId"))
                .map(|l| json!({ "live": l }))
                .map_err(bad),
            "register" => {
                let path = own_file(&own, &text("path")).map_err(bad)?;
                let origin = text("origin");
                if !["approved_result", "deterministic_transform", "normalized"]
                    .contains(&origin.as_str())
                {
                    return Err(bad(
                        "That origin is not one a plugin may register a picture with.",
                    ));
                }
                let name = call.params["name"].as_str().unwrap_or("edited.png");
                let bytes =
                    std::fs::read(&path).map_err(|_| bad("That file could not be read."))?;
                pics.ingest(&text("conversationId"), name, &bytes, &origin)
                    .map_err(bad)
            }
            // The link is served by the hub's media server (P2-38); until it is wired there is
            // nothing a link could point at.
            _ => Err(RpcError::new(
                code::CAPABILITY_NOT_AVAILABLE,
                "This Alexia cannot hand out a link to a file yet.",
            )),
        }
    }
}

/// `_core.mode` as a privacy mode: Local or Combined (v2's default); Cloud only when set.
fn privacy(store: &Store) -> PrivacyMode {
    match store
        .kv_get(NS, "mode")
        .ok()
        .flatten()
        .as_ref()
        .and_then(Value::as_str)
    {
        Some("local") => PrivacyMode::Local,
        Some("cloud") => PrivacyMode::Cloud,
        _ => PrivacyMode::Combined,
    }
}

// ---- pictures that stay with their conversation (v2 attachments/) -----------------------

/// A file a plugin hands over must be one of its own, really: not a link out of its folder,
/// and never a network path (stat'ing one makes Windows talk SMB to that host).
fn own_file(own: &Path, path: &str) -> Result<PathBuf, String> {
    if alexia_mcp::is_network_path(path) {
        return Err("Only a file in the plugin's own folder can be handed over.".into());
    }
    let real = std::fs::canonicalize(path).map_err(|_| "That file does not exist.".to_owned())?;
    let dir = std::fs::canonicalize(own).map_err(|_| "That file does not exist.".to_owned())?;
    if real.starts_with(&dir) && real != dir {
        Ok(real)
    } else {
        Err("Only a file in the plugin's own folder can be handed over.".into())
    }
}

fn opaque(prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    static N: AtomicU64 = AtomicU64::new(0);
    let salt = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let mut h = Sha256::new();
    h.update(salt.to_le_bytes());
    h.update(N.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    h.update(now_ms().to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    let hex: String = h
        .finalize()
        .iter()
        .take(12)
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{prefix}_{hex}")
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A conversation id is a session number, as text; anything else is nobody's.
fn session_of(conversation: &str) -> Result<i64, String> {
    if conversation.is_empty() || !conversation.bytes().all(|b| b.is_ascii_digit()) {
        return Err("A conversation is needed for pictures.".into());
    }
    conversation
        .parse()
        .map_err(|_| "A conversation is needed for pictures.".to_owned())
}

fn display_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = last.chars().filter(|c| *c as u32 > 31).collect();
    let clean = clean.trim();
    let n = clean.chars().count();
    let clean: String = clean.chars().skip(n.saturating_sub(200)).collect();
    if clean.is_empty() {
        "picture".into()
    } else {
        clean
    }
}

/// `\\?\C:\x` → `C:\x`: what a plugin can open anywhere.
fn plain(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => s,
    }
}

struct Row {
    id: String,
    label: String,
    display_name: String,
    mime: String,
    width: i64,
    height: i64,
    bytes: i64,
    sha256: String,
    file: String,
    state: String,
}

impl Row {
    fn descriptor(&self) -> Value {
        json!({
            "id": self.id, "label": self.label, "displayName": self.display_name,
            "mime": self.mime, "dimensions": { "width": self.width, "height": self.height },
            "bytes": self.bytes, "sha256": self.sha256,
        })
    }
}

struct Pictures<'a> {
    store: &'a Store,
    uploads: PathBuf,
}

impl Pictures<'_> {
    fn folder(&self, session: i64) -> PathBuf {
        self.uploads.join(session.to_string())
    }

    fn rows(&self, session: i64) -> Result<Vec<Row>, String> {
        self.store
            .transaction(|tx| {
                let mut st = tx.prepare(
                    "SELECT id, label, display_name, mime, width, height, bytes, sha256, file, state \
                     FROM attachments WHERE session_id = ? ORDER BY ordinal",
                )?;
                let rows = st
                    .query_map((session,), |r| {
                        Ok(Row {
                            id: r.get(0)?,
                            label: r.get(1)?,
                            display_name: r.get(2)?,
                            mime: r.get(3)?,
                            width: r.get(4)?,
                            height: r.get(5)?,
                            bytes: r.get(6)?,
                            sha256: r.get(7)?,
                            file: r.get(8)?,
                            state: r.get(9)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .map_err(|e| {
                tracing::warn!("pictures could not be read: {e}");
                "Alexia could not read that picture.".to_owned()
            })
    }

    /// The file, checked: inside this conversation's folder, really, and a plain file.
    fn path(&self, session: i64, row: &Row) -> Result<String, String> {
        let gone = || format!("{} cannot be read any more.", row.label.replace('_', " "));
        let folder = self.folder(session);
        // A row written by the importer may name the file relative to `uploads/`.
        let file = if row.file.contains(['/', '\\']) {
            self.uploads.join(&row.file)
        } else {
            folder.join(&row.file)
        };
        let meta = std::fs::symlink_metadata(&file).map_err(|_| gone())?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(gone());
        }
        let real = std::fs::canonicalize(&file).map_err(|_| gone())?;
        let root = std::fs::canonicalize(&folder).map_err(|_| gone())?;
        if real.starts_with(&root) {
            Ok(plain(real))
        } else {
            Err(gone())
        }
    }

    /// Keep a picture that arrived: bytes checked and metadata removed before anything is
    /// written; the label is the conversation's next, never a reused one.
    fn ingest(
        &self,
        conversation: &str,
        name: &str,
        bytes: &[u8],
        origin: &str,
    ) -> Result<Value, String> {
        let session = session_of(conversation)?;
        let seen = inspect(bytes).map_err(|why| format!("{name}: {why}"))?;
        let id = opaque("att");
        let file = format!("{id}.{}", seen.ext);
        let folder = self.folder(session);
        std::fs::create_dir_all(&folder)
            .map_err(|_| "Alexia could not keep that picture.".to_owned())?;
        std::fs::write(folder.join(&file), &seen.bytes)
            .map_err(|_| "Alexia could not keep that picture.".to_owned())?;
        let sha = hex(&seen.bytes);
        let made = self.store.transaction(|tx| {
            let mut st = tx.prepare("SELECT image_ordinal FROM sessions WHERE id = ?")?;
            let before = st
                .query_map((session,), |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let Some(before) = before.first() else {
                return Err(alexia_store::Error::Refused("That conversation does not exist.".into()));
            };
            let ordinal = before + 1;
            tx.execute("UPDATE sessions SET image_ordinal = ? WHERE id = ?", (ordinal, session))?;
            let row = Row {
                id: id.clone(),
                label: format!("image_{ordinal}"),
                display_name: display_name(name),
                mime: seen.mime.into(),
                width: i64::from(seen.width),
                height: i64::from(seen.height),
                bytes: i64::try_from(seen.bytes.len()).unwrap_or(i64::MAX),
                sha256: sha.clone(),
                file: file.clone(),
                state: "live".into(),
            };
            tx.execute(
                "INSERT INTO attachments (id, session_id, ordinal, label, display_name, mime, width, \
                 height, bytes, sha256, file, origin, state, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    &row.id, session, ordinal, &row.label, &row.display_name, &row.mime, row.width,
                    row.height, row.bytes, &row.sha256, &row.file, origin, "live", now_ms(),
                ),
            )?;
            Ok(row)
        });
        match made {
            Ok(row) => Ok(row.descriptor()),
            Err(e) => {
                // The row is the commit: a file without one is an orphan, removed now.
                let _ = std::fs::remove_file(folder.join(&file));
                Err(match e {
                    alexia_store::Error::Refused(s) => s,
                    other => {
                        tracing::warn!("a picture could not be recorded: {other}");
                        "Alexia could not keep that picture.".into()
                    }
                })
            }
        }
    }

    /// One authorized, immutable selection with readable paths, by attachment id.
    fn lease(&self, conversation: &str, ids: &[String]) -> Result<Value, String> {
        let session = session_of(conversation)?;
        if ids.is_empty() || ids.len() > 8 {
            return Err("Select a picture first.".into());
        }
        let rows = self.rows(session)?;
        let mut picked = Vec::new();
        for id in ids {
            match rows.iter().find(|r| &r.id == id) {
                Some(r) => picked.push(r),
                None => {
                    return Err("A picture this needs is not in this conversation any more.".into())
                }
            }
        }
        for (i, r) in picked.iter().enumerate() {
            if picked[..i].iter().any(|o| o.id == r.id) {
                return Err("The same picture is selected twice.".into());
            }
            if r.state != "live" {
                return Err(format!("{} has been deleted.", r.label.replace('_', " ")));
            }
        }
        let mut attachments = Vec::new();
        for r in &picked {
            let mut d = r.descriptor();
            d["path"] = json!(self.path(session, r)?);
            attachments.push(d);
        }
        let lease = opaque("lease");
        self.store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO attachment_leases (id, session_id, attachment_ids, state, created_at) \
                     VALUES (?, ?, ?, 'live', ?)",
                    (&lease, session, json!(ids).to_string(), now_ms()),
                )?;
                Ok(())
            })
            .map_err(|e| {
                tracing::warn!("a lease could not be recorded: {e}");
                "Alexia could not read that picture.".to_owned()
            })?;
        Ok(json!({
            "version": "1", "conversationId": conversation, "requestId": opaque("req"),
            "selectionId": opaque("sel"), "leaseId": lease, "attachments": attachments,
        }))
    }

    fn release(&self, lease: &str) -> Result<(), String> {
        self.store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE attachment_leases SET state = 'released' WHERE id = ? AND state = 'live'",
                    (lease,),
                )?;
                Ok(())
            })
            .map_err(|_| "Alexia could not read that picture.".to_owned())
    }

    /// A lease is live while it was not released or revoked and every picture in it still is.
    fn live(&self, lease: &str) -> Result<bool, String> {
        self.store
            .transaction(|tx| {
                let mut st =
                    tx.prepare("SELECT state, attachment_ids FROM attachment_leases WHERE id = ?")?;
                let found = st
                    .query_map((lease,), |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let Some((state, ids)) = found.into_iter().next() else {
                    return Ok(false);
                };
                let ids: Vec<String> = serde_json::from_str(&ids)?;
                if state != "live" {
                    return Ok(false);
                }
                for id in &ids {
                    let mut one = tx.prepare(
                        "SELECT COUNT(*) FROM attachments WHERE id = ? AND state = 'live'",
                    )?;
                    let n = one
                        .query_map((id,), |r| r.get::<_, i64>(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    if n.first() != Some(&1) {
                        return Ok(false);
                    }
                }
                Ok(true)
            })
            .map_err(|_| "Alexia could not read that picture.".to_owned())
    }
}

// ---- is this a picture, and what in it is not the picture (v2 images.ts) -----------------

struct Inspected {
    mime: &'static str,
    ext: &'static str,
    width: u32,
    height: u32,
    /// The same picture with its metadata removed.
    bytes: Vec<u8>,
}

/// Forty megapixels: past it, decoding is a memory problem before it is a picture.
const MOST_PIXELS: u64 = 40_000_000;

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn be16(b: &[u8], at: usize) -> u32 {
    u32::from(u16::from_be_bytes([b[at], b[at + 1]]))
}
fn le16(b: &[u8], at: usize) -> u32 {
    u32::from(u16::from_le_bytes([b[at], b[at + 1]]))
}

fn bounded(width: u32, height: u32) -> Result<(), String> {
    if width < 1 || height < 1 {
        return Err("The picture has no pixels.".into());
    }
    if u64::from(width) * u64::from(height) > MOST_PIXELS {
        return Err(format!(
            "The picture is {width}×{height}, larger than Alexia opens."
        ));
    }
    Ok(())
}

/// Answered from the bytes alone, without decoding pixels, so a forty-megapixel bomb is
/// refused before anything allocates for it. The name and the claimed type are never trusted.
fn inspect(b: &[u8]) -> Result<Inspected, String> {
    if b.len() >= 8 && b[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        png(b)
    } else if b.len() >= 3 && b[..3] == [0xff, 0xd8, 0xff] {
        jpeg(b)
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        webp(b)
    } else {
        Err("This is not a PNG, JPEG or WebP picture.".into())
    }
}

/// The PNG chunks that change how the picture looks. Everything else is metadata.
const PNG_KEEP: [&[u8; 4]; 11] = [
    b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT",
    b"pHYs",
];

fn png(b: &[u8]) -> Result<Inspected, String> {
    let mut kept = b[..8].to_vec();
    let (mut at, mut width, mut height, mut ended) = (8usize, 0, 0, false);
    while at + 12 <= b.len() {
        let length = be32(b, at) as usize;
        let kind = &b[at + 4..at + 8];
        let end = at
            .checked_add(12 + length)
            .filter(|e| *e <= b.len())
            .ok_or("The PNG is cut short.")?;
        if crc32(&b[at + 4..at + 8 + length]) != be32(b, at + 8 + length) {
            return Err("The PNG is damaged.".into());
        }
        if kind == b"IHDR" && length >= 8 {
            width = be32(b, at + 8);
            height = be32(b, at + 12);
        }
        if kind == b"acTL" {
            return Err("Animated pictures cannot be edited.".into());
        }
        if PNG_KEEP.iter().any(|k| k.as_slice() == kind) {
            kept.extend_from_slice(&b[at..end]);
        }
        at = end;
        if kind == b"IEND" {
            ended = true;
            break;
        }
    }
    if !ended || width == 0 {
        return Err("The PNG is incomplete.".into());
    }
    bounded(width, height)?;
    Ok(Inspected {
        mime: "image/png",
        ext: "png",
        width,
        height,
        bytes: kept,
    })
}

/// The EXIF orientation tag, if the TIFF block says one.
fn orientation(t: &[u8]) -> Option<u32> {
    if t.len() < 8 {
        return None;
    }
    let little = &t[..2] == b"II";
    let u16_ = |o: usize| if little { le16(t, o) } else { be16(t, o) };
    let u32_ = |o: usize| if little { le32(t, o) } else { be32(t, o) };
    let ifd = u32_(4) as usize;
    if ifd.checked_add(2)? > t.len() {
        return None;
    }
    for i in 0..u16_(ifd) as usize {
        let e = ifd + 2 + i * 12;
        if e + 12 > t.len() {
            return None;
        }
        if u16_(e) == 0x0112 {
            return Some(u16_(e + 8));
        }
    }
    None
}

fn jpeg(b: &[u8]) -> Result<Inspected, String> {
    let mut kept = b[..2].to_vec();
    let (mut at, mut width, mut height) = (2usize, 0, 0);
    while at + 4 <= b.len() {
        if b[at] != 0xff {
            return Err("The JPEG is damaged.".into());
        }
        let marker = b[at + 1];
        if marker == 0xd9 {
            break;
        }
        if marker == 0xda {
            // Start of scan: the rest is compressed pixels through to the end marker.
            kept.extend_from_slice(&b[at..]);
            break;
        }
        let length = be16(b, at + 2) as usize;
        let end = at + 2 + length;
        if end > b.len() || length < 2 {
            return Err("The JPEG is cut short.".into());
        }
        if (0xc0..=0xcf).contains(&marker)
            && ![0xc4, 0xc8, 0xcc].contains(&marker)
            && at + 9 <= b.len()
        {
            height = be16(b, at + 5);
            width = be16(b, at + 7);
        }
        // `end >= at + 10`: an APP1 whose length is 6 or 7 ends before the TIFF block starts.
        if marker == 0xe1 && end >= at + 10 && &b[at + 4..at + 8] == b"Exif" {
            if let Some(turned) = orientation(&b[at + 10..end]) {
                if turned != 1 {
                    return Err("This JPEG is stored sideways. Attach it again from the editor, which turns it upright first.".into());
                }
            }
        }
        // JFIF (APP0), the ICC profile (APP2) and Adobe's colour transform (APP14) change how it
        // looks; every other APP segment and every comment is metadata.
        let metadata = ((0xe0..=0xef).contains(&marker) && ![0xe0, 0xe2, 0xee].contains(&marker))
            || marker == 0xfe;
        if !metadata {
            kept.extend_from_slice(&b[at..end]);
        }
        at = end;
    }
    if width == 0 {
        return Err("The JPEG has no picture in it.".into());
    }
    bounded(width, height)?;
    Ok(Inspected {
        mime: "image/jpeg",
        ext: "jpg",
        width,
        height,
        bytes: kept,
    })
}

fn webp(b: &[u8]) -> Result<Inspected, String> {
    let cut = || "The WebP is cut short.".to_owned();
    let (mut kept, mut at, mut width, mut height, mut vp8x) =
        (Vec::new(), 12usize, 0u32, 0u32, false);
    while at + 8 <= b.len() {
        let kind = &b[at..at + 4];
        let length = le32(b, at + 4) as usize;
        let data_end = at
            .checked_add(8 + length)
            .filter(|e| *e <= b.len())
            .ok_or_else(cut)?;
        let end = (data_end + length % 2).min(b.len());
        let data = &b[at + 8..data_end];
        match kind {
            b"ANIM" | b"ANMF" => return Err("Animated pictures cannot be edited.".into()),
            b"VP8X" if data.len() >= 10 => {
                if data[0] & 0x02 != 0 {
                    return Err("Animated pictures cannot be edited.".into());
                }
                width = 1 + u32::from_le_bytes([data[4], data[5], data[6], 0]);
                height = 1 + u32::from_le_bytes([data[7], data[8], data[9], 0]);
                vp8x = true;
                let mut chunk = b[at..end].to_vec();
                // Clear the EXIF and XMP flags: those chunks are not kept.
                chunk[8] &= !0x0c;
                kept.extend_from_slice(&chunk);
            }
            b"VP8 " => {
                if !vp8x && data.len() >= 10 {
                    width = le16(data, 6) & 0x3fff;
                    height = le16(data, 8) & 0x3fff;
                }
                kept.extend_from_slice(&b[at..end]);
            }
            b"VP8L" => {
                if !vp8x && data.len() >= 5 {
                    let bits = le32(data, 1);
                    width = (bits & 0x3fff) + 1;
                    height = ((bits >> 14) & 0x3fff) + 1;
                }
                kept.extend_from_slice(&b[at..end]);
            }
            b"ALPH" | b"ICCP" => kept.extend_from_slice(&b[at..end]),
            _ => {}
        }
        at = end;
    }
    if width == 0 {
        return Err("The WebP has no picture in it.".into());
    }
    bounded(width, height)?;
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(
        &u32::try_from(kept.len() + 4)
            .unwrap_or(u32::MAX)
            .to_le_bytes(),
    );
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&kept);
    Ok(Inspected {
        mime: "image/webp",
        ext: "webp",
        width,
        height,
        bytes: out,
    })
}

#[cfg(test)]
mod jpeg_tests {
    use super::inspect;

    /// SOI, an APP1 "Exif" segment of the given declared length, a 2x2 SOF0 and a scan start.
    fn jpeg_with_app1(length: u16, body: &[u8]) -> Vec<u8> {
        let mut b = vec![0xff, 0xd8, 0xff, 0xe1];
        b.extend_from_slice(&length.to_be_bytes());
        b.extend_from_slice(body);
        b.extend_from_slice(&[
            0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
        ]);
        b.extend_from_slice(&[0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
        b
    }

    #[test]
    fn short_exif_segments_do_not_panic() {
        // Length 6 and 7 hold only 4 and 5 bytes after the length field: "Exif" and at most one
        // more. The TIFF block would start past the segment's end.
        for (length, body) in [(6u16, &b"Exif"[..]), (7, b"Exif\0")] {
            let out =
                inspect(&jpeg_with_app1(length, body)).expect("a short Exif block is skipped");
            assert_eq!((out.width, out.height), (2, 2));
        }
        // Shorter than the "Exif" tag itself: also fine.
        assert!(inspect(&jpeg_with_app1(3, b"E")).is_ok());
    }

    #[test]
    fn sideways_exif_is_still_refused() {
        // Big-endian TIFF, one entry: orientation (0x0112) = 6.
        let tiff = [
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0,
        ];
        let mut body = b"Exif\0\0".to_vec();
        body.extend_from_slice(&tiff);
        let err = inspect(&jpeg_with_app1(body.len() as u16 + 2, &body))
            .err()
            .expect("refused");
        assert!(err.contains("sideways"), "{err}");
    }
}
