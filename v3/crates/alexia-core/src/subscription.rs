// SPDX-License-Identifier: AGPL-3.0-only
//! Subscriptions the owner already pays for, reached only through the vendor's own signed-in
//! CLI (MO-05, D212). Off by default: the hub registers this only when the owner pinned it.
//!
//! Alexia never signs in, never reads the CLI's tokens and never starts a plan. The prompt goes
//! on stdin (never argv), the CLI runs in an empty temp folder with its tools turned off, and its
//! JSON events become `ChatChunk::Text`. Headless flags, checked against `claude 2.1.330` and
//! `codex-cli 0.160.0` `--help`:
//! - `claude -p --output-format stream-json --verbose --tools "" --permission-mode plan
//!   --permission-prompts none` (prompt on stdin)
//! - `codex exec --json --sandbox read-only --skip-git-repo-check --ephemeral -C <dir> -`
//!   (`-` reads the prompt from stdin)
//!
//! Codex's read-only sandbox still lets its agent run shell reads anywhere on disk. `codex-cli
//! 0.160.0` has `--disable shell_tool` / `--disable unified_exec`, but browser, computer-use, apps
//! and MCP tools stay, so no one switch is proven to leave it toolless: Codex refuses any request
//! that carries tool output instead (prompt injection would bypass the gate and never-touch list).
//!
//! Both CLIs start with an empty environment plus `ENV_KEEP` and their own config variable, so
//! `ALEXIA_SECRET_*` overrides and provider keys never reach their agents.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use alexia_store::Role;
use regex::Regex;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{ChatChunk, ChatDone, ChatRequest, ModelInfo, Provider, ProviderError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cli {
    ClaudeCode,
    Codex,
}

impl Cli {
    fn name(self) -> &'static str {
        match self {
            Cli::ClaudeCode => "Claude Code",
            Cli::Codex => "Codex",
        }
    }
    fn env(self) -> &'static str {
        match self {
            Cli::ClaudeCode => "ALEXIA_CLAUDE_CLI",
            Cli::Codex => "ALEXIA_CODEX_CLI",
        }
    }
    fn bin(self) -> &'static str {
        match self {
            Cli::ClaudeCode => "claude",
            Cli::Codex => "codex",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Cli::ClaudeCode => "subscription:claude-code",
            Cli::Codex => "subscription:codex",
        }
    }
    /// The CLI's own config folder variable, passed through when set.
    fn config_env(self) -> &'static str {
        match self {
            Cli::ClaudeCode => "CLAUDE_CONFIG_DIR",
            Cli::Codex => "CODEX_HOME",
        }
    }
    /// The no-op sign-in check: exits non-zero when the CLI is not signed in.
    fn status_args(self) -> [&'static str; 2] {
        match self {
            Cli::ClaudeCode => ["auth", "status"],
            Cli::Codex => ["login", "status"],
        }
    }
}

pub struct SubscriptionCli {
    cli: Cli,
    exe: PathBuf,
    check_timeout: Duration,
    chat_timeout: Duration,
}

impl SubscriptionCli {
    /// `ALEXIA_CLAUDE_CLI` / `ALEXIA_CODEX_CLI`, else the name on PATH. None if not installed.
    pub fn find(cli: Cli) -> Option<SubscriptionCli> {
        let exe = match std::env::var_os(cli.env()).filter(|v| !v.is_empty()) {
            Some(p) => Some(PathBuf::from(p)).filter(|p| p.is_file()),
            None => on_path(cli.bin()),
        }?;
        Some(Self::at(cli, exe))
    }

    /// A CLI at a known path (what `find` returns once it has one).
    pub fn at(cli: Cli, exe: PathBuf) -> SubscriptionCli {
        SubscriptionCli {
            cli,
            exe,
            check_timeout: Duration::from_secs(30),
            chat_timeout: Duration::from_secs(30 * 60),
        }
    }

    /// `claude --version` / `codex --version` and a no-op sign-in check; a sentence if not signed in.
    pub async fn check(&self) -> Result<(), String> {
        let name = self.cli.name();
        let version = self.run_quick(&["--version"]).await?;
        if !version.0 {
            return Err(format!("{name} did not answer `--version`; reinstall it."));
        }
        let status = self.run_quick(&self.cli.status_args()).await?;
        if status.0 {
            Ok(())
        } else {
            Err(format!(
                "{name} is not signed in. Open a terminal, run `{} {}` to see why, and sign in with your own account.",
                self.cli.bin(),
                if self.cli == Cli::ClaudeCode { "auth login" } else { "login" }
            ))
        }
    }

    /// Runs a short command; `(exit ok, stdout)`. Stdin closed, no window.
    async fn run_quick(&self, args: &[&str]) -> Result<(bool, String), String> {
        let name = self.cli.name();
        let mut cmd = self.base_command();
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        no_window(&mut cmd);
        let run = tokio::time::timeout(self.check_timeout, cmd.output());
        match run.await {
            Err(_) => Err(format!("{name} did not answer in time.")),
            Ok(Err(e)) => Err(format!("{name} could not be started: {e}")),
            Ok(Ok(o)) => Ok((
                o.status.success(),
                String::from_utf8_lossy(&o.stdout).into_owned(),
            )),
        }
    }

    /// The exe with only `ENV_KEEP` and the CLI's config variable from the hub's environment.
    fn base_command(&self) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.env_clear();
        for k in ENV_KEEP.iter().copied().chain([self.cli.config_env()]) {
            if let Some(v) = std::env::var_os(k) {
                cmd.env(k, v);
            }
        }
        cmd
    }

    fn command(&self, model: &str, dir: &Path) -> Command {
        let mut cmd = self.base_command();
        match self.cli {
            Cli::ClaudeCode => {
                cmd.args(["-p", "--output-format", "stream-json", "--verbose"])
                    .args(["--tools", "", "--permission-mode", "plan"])
                    .args(["--permission-prompts", "none"]);
                if model != "default" {
                    cmd.args(["--model", model]);
                }
            }
            Cli::Codex => {
                cmd.args(["exec", "--json", "--sandbox", "read-only"])
                    .args(["--skip-git-repo-check", "--ephemeral", "-C"])
                    .arg(dir);
                if model != "default" {
                    cmd.args(["--model", model]);
                }
                cmd.arg("-");
            }
        }
        cmd.current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        no_window(&mut cmd);
        cmd
    }
}

/// The only hub variables a CLI sees (plus its own config variable, `Cli::config_env`).
const ENV_KEEP: &[&str] = &[
    // Finding programs; Windows needs these to start anything at all.
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    // Scratch space.
    "TEMP",
    "TMP",
    // Home and app data: where the CLI keeps its own sign-in.
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
];

/// A tool turn, a tool call or a tool result anywhere in the request.
fn has_tool_output(req: &ChatRequest) -> bool {
    req.messages
        .iter()
        .any(|(r, b)| *r == Role::Tool || b.calls.is_some() || b.call_id.is_some())
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = cmd;
}

fn on_path(bin: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat", "com"].map(String::from).to_vec()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter().find_map(|e| {
            let name = if e.is_empty() {
                bin.to_string()
            } else {
                format!("{bin}.{e}")
            };
            Some(dir.join(name)).filter(|p| p.is_file())
        })
    })
}

/// The whole conversation as one stdin prompt: a lone user message goes as is.
fn prompt_text(req: &ChatRequest) -> String {
    let mut out = String::new();
    if let Some(s) = &req.system {
        out.push_str(s);
        out.push_str("\n\n");
    }
    let turns: Vec<(&str, String)> = req
        .messages
        .iter()
        .filter(|(r, _)| *r != Role::System)
        .map(|(r, b)| {
            (
                if *r == Role::Assistant {
                    "Assistant"
                } else {
                    "User"
                },
                b.content.text(),
            )
        })
        .collect();
    if let [(_, only)] = turns.as_slice() {
        out.push_str(only);
    } else {
        for (who, text) in &turns {
            out.push_str(&format!("{who}: {text}\n\n"));
        }
        out.push_str("Assistant:");
    }
    out
}

/// `429` / `401` only as an HTTP status marker, never a bare number in prose or a path.
static STATUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?:status(?:\s+code)?|http(?:/[\d.]+)?|error|code)\s*[:=]?\s*(429|401)|"status(?:_?code)?"\s*:\s*"?(429|401)"#,
    )
    .expect("valid regex")
});

/// A rate-limit or sign-in message from the CLI, as the error it means.
fn classify(text: &str, cli: Cli) -> Option<ProviderError> {
    let t = text.to_lowercase();
    let status = STATUS
        .captures_iter(&t)
        .filter_map(|c| c.get(1).or(c.get(2)))
        .map(|m| m.as_str().to_string())
        .collect::<Vec<_>>();
    if [
        "rate limit",
        "rate-limit",
        "usage limit",
        "limit reached",
        "too many requests",
    ]
    .iter()
    .any(|k| t.contains(k))
        || status.iter().any(|s| s == "429")
    {
        return Some(ProviderError::Busy {
            retry_after_ms: None,
        });
    }
    if [
        "not logged in",
        "not signed in",
        "/login",
        "please log in",
        "invalid api key",
        "unauthorized",
    ]
    .iter()
    .any(|k| t.contains(k))
        || status.iter().any(|s| s == "401")
    {
        return Some(ProviderError::Refused(format!(
            "{} is not signed in. Sign in with the CLI itself and try again.",
            cli.name()
        )));
    }
    None
}

static TEMP: AtomicU64 = AtomicU64::new(0);

/// An empty folder for the CLI to work in; removed on drop.
struct WorkDir(PathBuf);
impl WorkDir {
    fn new() -> std::io::Result<WorkDir> {
        let n = TEMP.fetch_add(1, Ordering::SeqCst);
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("alexia-sub-{}-{t}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        Ok(WorkDir(dir))
    }
}
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Kills the child and, on Windows, anything it started (`.cmd` shims run node underneath).
async fn kill(child: &mut Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut t = Command::new("taskkill");
        t.args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_window(&mut t);
        let _ = t.status().await;
    }
    let _ = child.kill().await;
}

#[derive(Default)]
struct Seen {
    text: bool,
    tokens: (i64, i64),
    error: Option<String>,
    result: Option<String>,
}

/// One JSON event line from either CLI.
fn read_event(line: &str, cli: Cli, seen: &mut Seen) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let mut texts = vec![];
    let usage = |u: &Value, seen: &mut Seen| {
        let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
        seen.tokens = (n("input_tokens"), n("output_tokens"));
    };
    match (cli, v["type"].as_str().unwrap_or("")) {
        (Cli::ClaudeCode, "assistant") => {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                if let ("text", Some(t)) = (b["type"].as_str().unwrap_or(""), b["text"].as_str()) {
                    texts.push(t.to_string());
                }
            }
        }
        (Cli::ClaudeCode, "result") => {
            usage(&v["usage"], seen);
            let r = v["result"].as_str().unwrap_or("").to_string();
            if v["is_error"].as_bool().unwrap_or(false) {
                seen.error = Some(r);
            } else {
                seen.result = Some(r);
            }
        }
        (Cli::Codex, "item.completed") => {
            if v["item"]["type"] == "agent_message" {
                if let Some(t) = v["item"]["text"].as_str() {
                    texts.push(t.to_string());
                }
            }
        }
        (Cli::Codex, "turn.completed") => usage(&v["usage"], seen),
        (Cli::Codex, "error") => seen.error = Some(v["message"].as_str().unwrap_or("").to_string()),
        (Cli::Codex, "turn.failed") => {
            seen.error = Some(v["error"]["message"].as_str().unwrap_or("").to_string());
        }
        _ => {}
    }
    texts
}

/// id "subscription:claude-code" | "subscription:codex"; `models()` one entry, free: true, tools: false.
#[async_trait::async_trait]
impl Provider for SubscriptionCli {
    fn id(&self) -> &str {
        self.cli.id()
    }

    async fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(vec![ModelInfo {
            id: "default".into(),
            context: 200_000,
            free: true,
            tools: false,
            vision: false,
        }])
    }

    async fn chat(
        &self,
        req: &ChatRequest,
        model: &str,
        out: mpsc::Sender<ChatChunk>,
        cancel: CancellationToken,
    ) -> Result<ChatDone, ProviderError> {
        let cli = self.cli;
        if cli == Cli::Codex && has_tool_output(req) {
            return Err(ProviderError::Other(
                "Codex is not used on steps that carry tool output.".into(),
            ));
        }
        let dir = WorkDir::new().map_err(|e| ProviderError::Other(e.to_string()))?;
        let prompt = prompt_text(req);
        let mut child = self.command(model, &dir.0).spawn().map_err(|e| {
            ProviderError::Other(format!("{} could not be started: {e}", cli.name()))
        })?;

        // Written from its own task: a long prompt must not wait on a stdout nobody reads yet.
        if let Some(mut stdin) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = stdin.write_all(prompt.as_bytes()).await;
            });
        }
        let mut stderr = child.stderr.take().expect("piped");
        // Read to the end so a chatty CLI never blocks on a full pipe; keep the first 64 KiB.
        let err_task = tokio::spawn(async move {
            let mut s = Vec::new();
            let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut s).await;
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            String::from_utf8_lossy(&s).into_owned()
        });
        let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();

        let started = Instant::now();
        let deadline = tokio::time::sleep(self.chat_timeout);
        tokio::pin!(deadline);
        let mut seen = Seen::default();
        let mut first_byte_ms = None;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    kill(&mut child).await;
                    return Err(ProviderError::Cancelled);
                }
                _ = &mut deadline => {
                    kill(&mut child).await;
                    return Err(ProviderError::Other(format!("{} took too long.", cli.name())));
                }
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        for t in read_event(&line, cli, &mut seen) {
                            if t.is_empty() { continue; }
                            first_byte_ms.get_or_insert(started.elapsed().as_millis() as u32);
                            seen.text = true;
                            if out.send(ChatChunk::Text(t)).await.is_err() {
                                kill(&mut child).await;
                                return Err(ProviderError::Cancelled);
                            }
                        }
                    }
                    _ => break,
                },
            }
        }
        // Stdout ended (or failed); the child may still run, so cancel and the deadline still hold.
        let (status, stderr) = tokio::select! {
            _ = cancel.cancelled() => {
                kill(&mut child).await;
                return Err(ProviderError::Cancelled);
            }
            _ = &mut deadline => {
                kill(&mut child).await;
                return Err(ProviderError::Other(format!("{} took too long.", cli.name())));
            }
            r = async { (child.wait().await, err_task.await.unwrap_or_default()) } => r,
        };
        let status = status.map_err(|e| ProviderError::Other(e.to_string()))?;

        if let Some(e) = &seen.error {
            return Err(classify(e, cli)
                .or_else(|| classify(&stderr, cli))
                .unwrap_or_else(|| ProviderError::Other(e.clone())));
        }
        if !status.success() {
            return Err(classify(&stderr, cli).unwrap_or_else(|| {
                let tail: String = stderr.trim().chars().take(300).collect();
                ProviderError::Other(format!("{} stopped: {tail}", cli.name()))
            }));
        }
        if !seen.text {
            if let Some(r) = seen.result.take().filter(|r| !r.is_empty()) {
                first_byte_ms.get_or_insert(started.elapsed().as_millis() as u32);
                let _ = out.send(ChatChunk::Text(r)).await;
            }
        }
        Ok(ChatDone {
            model: model.to_string(),
            provider: cli.id().to_string(),
            tokens_in: seen.tokens.0,
            tokens_out: seen.tokens.1,
            cost: 0.0, // the plan is already paid
            first_byte_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_markers_only() {
        let busy = |t| matches!(classify(t, Cli::Codex), Some(ProviderError::Busy { .. }));
        let signed_out = |t| matches!(classify(t, Cli::Codex), Some(ProviderError::Refused(_)));
        for t in [
            "HTTP 429",
            "unexpected status 429",
            r#"{"status":429,"message":"slow down"}"#,
            "error: 429",
        ] {
            assert!(busy(t), "{t}");
        }
        for t in ["status 401", "HTTP/1.1 401", r#"{"status": 401}"#] {
            assert!(signed_out(t), "{t}");
        }
        for t in [
            "read 4290 files",
            "C:/data/429/out.txt",
            "my 401k plan",
            "line 401 of x",
        ] {
            assert!(classify(t, Cli::Codex).is_none(), "{t}");
        }
    }
}
