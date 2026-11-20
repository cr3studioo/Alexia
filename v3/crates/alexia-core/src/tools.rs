// SPDX-License-Identifier: AGPL-3.0-only
//! Tooling over the MCP host, plus core's builtins. Ports v2 `packages/core/src/tooling.ts`
//! (`PluginTooling`, `outcomeOf`) and `trace.ts` `toolWords`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use alexia_mcp::types::{CallToolResult, ProgressParams};
use alexia_mcp::{CallCtx, CallError, HostedTool, McpHost, PluginId};
use serde_json::{Map, Value};

use crate::{Builtin, Produced, ToolCtx, ToolOutcome, ToolSpec, Tooling, UndoCall};

/// v2 `NAME_LIMIT`: a provider rejects a function name longer than this.
const NAME_LIMIT: usize = 64;
const SEPARATOR: &str = "__";
/// v2 `FINAL_MAX`: the longest reply a tool may give the person itself.
const FINAL_MAX: usize = 4000;

pub struct McpTooling {
    host: McpHost,
    builtins: Mutex<Vec<Arc<dyn Builtin>>>,
    /// What the last `list()` saw, so a call need not ask every plugin again.
    listed: Mutex<Vec<HostedTool>>,
}

impl McpTooling {
    pub fn new(host: McpHost, builtins: Vec<Arc<dyn Builtin>>) -> McpTooling {
        McpTooling {
            host,
            builtins: Mutex::new(builtins),
            listed: Mutex::new(vec![]),
        }
    }

    pub fn add_builtin(&self, b: Arc<dyn Builtin>) {
        self.builtins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(b);
    }

    /// Whether `list()` would offer `name`: a builtin, or a visible plugin tool within the limit.
    async fn callable(&self, name: &str) -> bool {
        if self
            .builtins()
            .iter()
            .any(|b| b.specs().iter().any(|s| s.name == name))
        {
            return true;
        }
        name.len() <= NAME_LIMIT
            && self
                .host
                .tools()
                .await
                .iter()
                .any(|t| !t.hidden && namespaced(&t.plugin, &t.tool.name) == name)
    }

    fn builtins(&self) -> Vec<Arc<dyn Builtin>> {
        self.builtins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn failed(text: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        text: text.into(),
        ok: false,
        files: vec![],
        final_text: None,
        undo: None,
        card: None,
    }
}

/// One progress frame as a line a person reads.
fn progress_line(p: &ProgressParams) -> String {
    let line = match (&p.message, p.total) {
        (Some(m), _) => m.clone(),
        (None, Some(t)) => format!("{} of {}", p.progress, t),
        (None, None) => p.progress.to_string(),
    };
    line.replace(['\r', '\n'], " ")
}

#[async_trait::async_trait]
impl Tooling for McpTooling {
    async fn list(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self.builtins().iter().flat_map(|b| b.specs()).collect();
        let tools = self.host.tools().await;
        *self.listed.lock().unwrap_or_else(|e| e.into_inner()) = tools.clone();
        for t in tools {
            if t.hidden {
                continue;
            }
            let name = namespaced(&t.plugin, &t.tool.name);
            if name.len() > NAME_LIMIT {
                tracing::warn!(
                    "{}: \"{}\" is unreachable, {} characters and a model-facing tool name may be {NAME_LIMIT}",
                    t.plugin.0,
                    t.tool.name,
                    name.len()
                );
                continue;
            }
            specs.push(ToolSpec {
                words: tool_words(&name, t.tool.description.as_deref()),
                description: t.tool.description.unwrap_or_default(),
                params: t.tool.input_schema,
                annotations: t.tool.annotations,
                reviewed: t.reviewed,
                plugin: Some(t.plugin),
                name,
            });
        }
        specs
    }

    async fn call(&self, name: &str, args: Map<String, Value>, ctx: ToolCtx) -> ToolOutcome {
        for b in self.builtins() {
            if let Some(outcome) = b.call(name, &args, &ctx).await {
                return outcome;
            }
        }
        let no_tool = || failed(format!("There is no tool called {name}."));
        let gone = || failed("That tool is gone (its plugin was removed). Plan without it.");
        let Some((plugin, tool)) = name.split_once(SEPARATOR) else {
            return no_tool();
        };
        // `list()` never offers a name past the limit, so `call()` does not take one.
        if name.len() > NAME_LIMIT {
            return no_tool();
        }
        let plugin = PluginId(plugin.to_string());
        let installed = |host: &McpHost| host.plugins().iter().any(|p| p.id == plugin);
        if !installed(&self.host) {
            return no_tool();
        }
        // Hidden tools (compute, editor) are not the model's to call; and listing is what
        // notices a deleted folder, so a plugin missing afterwards vanished just now.
        let is_it = |t: &HostedTool| t.plugin == plugin && t.tool.name == tool && !t.hidden;
        let cached = self
            .listed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|t| is_it(t))
            .cloned();
        let found = match cached {
            Some(t) => Some(t),
            None => self.host.tools().await.into_iter().find(is_it),
        };
        let Some(found) = found else {
            return if installed(&self.host) {
                no_tool()
            } else {
                gone()
            };
        };
        // v2 resolves declared attachment inputs through a per-conversation picture store;
        // v3 core has none yet, so v2's "no pictures here" answer is the honest one.
        if found
            .tool
            .meta
            .as_ref()
            .is_some_and(|m| m.contains_key("alexia/attachmentInputs"))
        {
            return failed(format!(
                "{name} works on pictures in a conversation, and this call has none."
            ));
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel::<ProgressParams>(64);
        let out = ctx.progress.clone();
        let forward = tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                if let Some(out) = &out {
                    // Lossy on purpose: a slow reader drops a line rather than stall the call.
                    let _ = out.try_send(progress_line(&p));
                }
            }
        });
        let call_ctx = CallCtx {
            conversation: Some(ctx.session.0.to_string()),
            progress: ctx.progress.is_some().then_some(tx),
            cancel: ctx.cancel.clone(),
            meta: Map::new(),
        };
        let result = self.host.call_tool(&plugin, tool, args, call_ctx).await;
        // The host dropped its sender with the call, so the forwarder drains and ends.
        let _ = forward.await;
        match result {
            Ok(r) => {
                let mut out = outcome_of(&r);
                // The plugin names its own tools; the model, and so `call`, knows them by
                // `<plugin>__<tool>`.
                if let Some(u) = out.undo.as_mut() {
                    let own = self
                        .builtins()
                        .iter()
                        .any(|b| b.specs().iter().any(|s| s.name == u.tool));
                    let namespaced_already = u
                        .tool
                        .split_once(SEPARATOR)
                        .is_some_and(|(p, _)| self.host.plugins().iter().any(|i| i.id.0 == p));
                    if !own && !namespaced_already {
                        u.tool = namespaced(&plugin, &u.tool);
                    }
                }
                // No undo the model could not call: a hidden or over-long target is dropped.
                if let Some(u) = &out.undo {
                    if !self.callable(&u.tool).await {
                        out.undo = None;
                    }
                }
                out
            }
            Err(CallError::Gone) => gone(),
            Err(CallError::Off { sentence }) => failed(sentence),
            Err(CallError::Timeout) => failed(format!(
                "{name} did not answer in time. Try something else."
            )),
            Err(CallError::Rpc(e)) => failed(format!("{name} failed: {}", e.message)),
            Err(CallError::Cancelled) => failed("Stopped."),
        }
    }
}

/// `<plugin id>__<tool>`, v2's namespacing; a builtin keeps its own name.
pub fn namespaced(plugin: &PluginId, tool: &str) -> String {
    format!("{}{SEPARATOR}{tool}", plugin.0)
}

/// `file:///C:/a%20b` or `file:///a/b` to a path; None for any other kind of link.
fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // Only this machine: an empty host or `localhost`, never `file://srv/share/x`.
    let rest = if rest.starts_with('/') {
        rest
    } else {
        rest.strip_prefix("localhost")
            .filter(|r| r.starts_with('/'))?
    };
    let raw = rest.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let hex = raw
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (raw[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    let path = String::from_utf8_lossy(&out).into_owned();
    let b = path.as_bytes();
    let sep = |c: u8| c == b'/' || c == b'\\';
    // Two leading separators (or `\\?\UNC\`) name a network share: stat'ing one makes
    // Windows talk SMB to that server. Never a local path, so never touched.
    if (b.len() > 1 && sep(b[0]) && sep(b[1])) || path.starts_with(r"\\?\UNC\") {
        return None;
    }
    // `/C:/...` is a Windows drive path.
    if b.len() > 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        return Some(PathBuf::from(&path[1..]));
    }
    // On Windows only a drive-letter path is local; `/x` or `\x` would be drive-relative.
    if cfg!(windows) {
        return None;
    }
    Some(PathBuf::from(path))
}

/// v2 `mimeOf`: from the name alone.
fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" => "text/html",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// v2 `produced`: a `resource_link` as a file on this machine, only if it is a `file:` URI
/// naming a file that is there.
fn produced(block: &Value) -> Option<Produced> {
    let path = file_uri_path(block["uri"].as_str()?)?;
    let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
    let name = block["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))?;
    let mime = block["mimeType"]
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| mime_of(&name))
        .to_string();
    Some(Produced {
        name,
        path,
        bytes: meta.len(),
        mime,
    })
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// v2 `cardOf`: text fields only, a handful, and a link only to a web page.
fn card_of(v: &Value) -> Option<Value> {
    let title = v.get("title")?.as_str()?;
    let fields: Map<String, Value> = v
        .get("fields")?
        .as_object()?
        .iter()
        .filter_map(|(k, val)| {
            let text = match val {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            Some((clip(k, 40), Value::String(clip(&text, 400))))
        })
        .take(8)
        .collect();
    if fields.is_empty() {
        return None;
    }
    let mut card = Map::new();
    card.insert("title".into(), Value::String(clip(title, 200)));
    card.insert("fields".into(), Value::Object(fields));
    if let Some(url) = v.get("url").and_then(Value::as_str) {
        let lower = url.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("https://")
            .or_else(|| lower.strip_prefix("http://"));
        if rest.is_some_and(|r| !r.is_empty()) && !url.contains(char::is_whitespace) {
            card.insert("url".into(), Value::String(clip(url, 2000)));
        }
    }
    Some(Value::Object(card))
}

/// An MCP result as the model reads it (v2 `outcomeOf`): text blocks joined, a `resource_link`
/// named and kept as a produced file, other blocks named; `alexia/final`, `alexia/card` and
/// `alexia/undo` read from `_meta`.
pub fn outcome_of(result: &CallToolResult) -> ToolOutcome {
    let mut files = vec![];
    let parts: Vec<String> = result
        .content
        .iter()
        .map(|block| match block["type"].as_str().unwrap_or("") {
            "text" => block["text"].as_str().unwrap_or("").to_string(),
            "resource_link" => match produced(block) {
                Some(one) => {
                    let line = format!("[file: {}]", one.name);
                    files.push(one);
                    line
                }
                None => {
                    let name = block["name"]
                        .as_str()
                        .or_else(|| block["uri"].as_str())
                        .unwrap_or("unnamed");
                    format!("[file: {name} — not written]")
                }
            },
            other => format!("[{other}]"),
        })
        .collect();
    let text = parts.join("\n").trim().to_string();
    let ok = result.is_error != Some(true);
    let meta = result.meta.as_ref();
    // A failure is always the model's to explain, so these ride only on a call that worked.
    let final_text = meta
        .filter(|_| ok)
        .and_then(|m| m.get("alexia/final")?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| clip(s, FINAL_MAX));
    let undo = meta
        .filter(|_| ok)
        .and_then(|m| serde_json::from_value::<UndoCall>(m.get("alexia/undo")?.clone()).ok());
    let card = meta.and_then(|m| card_of(m.get("alexia/card")?));
    ToolOutcome {
        text: if text.is_empty() {
            if ok {
                "Done.".into()
            } else {
                "The tool failed and said nothing.".into()
            }
        } else {
            text
        },
        ok,
        files,
        final_text,
        undo,
        card,
    }
}

/// v2 `toolWords`: the first clause of the description, lower-cased to sit in a sentence,
/// else the name with its seams taken out.
pub fn tool_words(name: &str, description: Option<&str>) -> String {
    let desc = description.unwrap_or("").trim();
    // First sentence: up to whitespace after `.`, `!` or `?`, or a newline.
    let mut end = desc.len();
    let mut prev_stop = false;
    for (i, c) in desc.char_indices() {
        if c == '\n' || (prev_stop && c.is_whitespace()) {
            end = i;
            break;
        }
        prev_stop = matches!(c, '.' | '!' | '?');
    }
    let first = &desc[..end];
    let clause = first
        .split([',', ';', ':', '('])
        .next()
        .unwrap_or("")
        .split(" — ")
        .next()
        .unwrap_or("")
        .trim_end_matches(['.', '!', '?'])
        .trim();
    if !clause.is_empty() && clause.chars().count() <= 70 {
        let mut cs = clause.chars();
        let (a, b) = (cs.next(), cs.next());
        // Lower-case the first letter unless it starts an acronym.
        return match (a, b) {
            (Some(a), Some(b)) if a.is_ascii_uppercase() && b.is_ascii_lowercase() => {
                format!("{}{}", a.to_ascii_lowercase(), &clause[1..])
            }
            _ => clause.to_string(),
        };
    }
    let base = name.split_once(SEPARATOR).map_or(name, |(_, t)| t);
    // Runs of `_` and `.` become one space.
    let mut out = String::new();
    for c in base.chars() {
        if matches!(c, '_' | '.') {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}
