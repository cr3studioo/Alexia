// SPDX-License-Identifier: AGPL-3.0-only
//! Spawning one plugin process (INTERFACES.md §3.2), its stderr ring, and stopping it.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alexia_store::Layout;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::{Error, PluginDir};

/// What v2's MCP SDK passes on Windows, plus `ALEXIA_PLUGIN_DIR` (added in `spawn`).
const ENV: &[&str] = &[
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMFILES",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERPROFILE",
];

const MAX_LINES: usize = 500;
const MASK: &str = "•••";

pub struct Proc {
    /// stdin/stdout are taken by `Conn`.
    pub child: tokio::process::Child,
    pub pid: u32,
    pub stderr: StderrLog,
    /// Dropping it kills the whole tree (Windows).
    job: crate::job::Job,
}

/// The last 500 lines a plugin wrote to stderr (and stdout lines that were not JSON),
/// redacted on the way in.
#[derive(Clone, Default)]
pub struct StderrLog {
    lines: Arc<Mutex<VecDeque<String>>>,
    /// Values replaced by `•••` before a line is kept. Never logged themselves.
    secrets: Arc<Vec<String>>,
}

impl StderrLog {
    pub(crate) fn new(secrets: Vec<String>) -> StderrLog {
        StderrLog {
            lines: Arc::default(),
            secrets: Arc::new(secrets.into_iter().filter(|s| !s.is_empty()).collect()),
        }
    }

    /// Oldest first, at most 500.
    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub(crate) fn push(&self, line: &str) {
        self.push_cut(line, usize::MAX);
    }

    /// Redacts, then keeps the first `max` chars: cutting first could split a secret and
    /// leave its first half unmatched.
    pub(crate) fn push_cut(&self, line: &str, max: usize) {
        let line: String = redact(line, &self.secrets).chars().take(max).collect();
        let mut lines = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if lines.len() == MAX_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }
}

/// INTERFACES.md §3.2. `secrets` are values to redact from stderr (the plugin's password
/// settings, read by the caller); never logged themselves.
pub fn spawn(
    dir: &PluginDir,
    layout: &Layout,
    node: &Path,
    secrets: Vec<String>,
) -> Result<Proc, Error> {
    let entry = &dir.manifest.entry;
    // v2's `#inFolder`: an arg naming a file in the folder becomes absolute. Only relative
    // args are joined (on Windows, joining `/C` would land on the drive root).
    let in_folder = |arg: &str| -> PathBuf {
        let relative = matches!(
            Path::new(arg).components().next(),
            Some(Component::Normal(_) | Component::CurDir | Component::ParentDir)
        );
        let candidate = dir.path.join(arg);
        if relative && candidate.is_file() {
            candidate
        } else {
            PathBuf::from(arg)
        }
    };
    let program = if entry.run == "node" {
        node.to_path_buf()
    } else {
        in_folder(&entry.run)
    };
    let cwd = layout.own_dir(&dir.manifest.id);
    std::fs::create_dir_all(&cwd)?;

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(entry.args.iter().map(|a| in_folder(a)))
        .current_dir(&cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in ENV {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    cmd.env("ALEXIA_PLUGIN_DIR", &dir.path);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let job = crate::job::Job::new()?;
    let mut child = cmd.spawn()?;
    let pid = child.id().unwrap_or_default();
    if let Err(e) = job.assign(pid) {
        let _ = child.start_kill();
        return Err(e.into());
    }

    let stderr = StderrLog::new(secrets);
    if let Some(err) = child.stderr.take() {
        let log = stderr.clone();
        tokio::spawn(read_lines(err, move |line| log.push(line)));
    }
    Ok(Proc {
        child,
        pid,
        stderr,
        job,
    })
}

/// Calls `f` with each line (lossy UTF-8, no `\r\n`) until EOF or a read error.
pub(crate) async fn read_lines(r: impl AsyncRead + Unpin, mut f: impl FnMut(&str)) {
    let mut r = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                f(line.trim_end_matches(['\n', '\r']));
            }
        }
    }
}

/// Close stdin, wait `grace`, then kill (the Job Object on Windows, `start_kill` elsewhere).
/// Returns the exit code if any.
pub async fn stop(mut proc: Proc, grace: Duration) -> Option<i32> {
    drop(proc.child.stdin.take());
    let status = match tokio::time::timeout(grace, proc.child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            #[cfg(windows)]
            proc.job.kill();
            #[cfg(not(windows))]
            let _ = proc.child.start_kill();
            proc.child.wait().await.ok()
        }
    };
    // Whatever the plugin started itself goes too, even when it left politely.
    proc.job.kill();
    status.and_then(|s| s.code())
}

// ---- redaction: v2's `redactSecrets` patterns (packages/core/src/redact.ts), by hand ----

/// Every secret value, then every credential shape, replaced by `•••`.
pub fn redact(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_string();
    // Longest first: a shorter secret inside a longer one would otherwise break it up and
    // leave the longer one's ends behind.
    let mut secrets: Vec<&String> = secrets.iter().collect();
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for s in secrets {
        out = out.replace(s.as_str(), MASK);
    }
    for rule in RULES {
        out = apply(&out, *rule);
    }
    out
}

/// A matcher tried at byte `i`: `Ok(end)` on a match, `Err(next)` for where to try next.
type Rule = fn(&[u8], usize) -> Result<usize, usize>;

const RULES: &[Rule] = &[
    api_key,
    github,
    aws,
    google,
    slack,
    telegram,
    private_key,
    jwt,
    env_assignment,
];

/// Every match lies on ASCII boundaries, so slicing the string there is safe.
fn apply(text: &str, rule: Rule) -> String {
    let b = text.as_bytes();
    let (mut out, mut i, mut copied) = (String::new(), 0, 0);
    while i < b.len() {
        match rule(b, i) {
            Ok(end) => {
                out.push_str(&text[copied..i]);
                out.push_str(MASK);
                i = end;
                copied = end;
            }
            Err(next) => i = next.max(i + 1),
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn token(c: u8) -> bool {
    word(c) || c == b'-'
}

fn name(c: u8) -> bool {
    token(c) || c == b'.'
}

/// `\b` before a word character at `i`.
fn starts_word(b: &[u8], i: usize) -> bool {
    i == 0 || !word(b[i - 1])
}

fn run(b: &[u8], i: usize, class: fn(u8) -> bool) -> usize {
    i + b[i..].iter().take_while(|c| class(**c)).count()
}

/// JS `\b` at `k`: a word character on exactly one side.
fn boundary(b: &[u8], k: usize) -> bool {
    let before = k > 0 && word(b[k - 1]);
    let after = k < b.len() && word(b[k]);
    before != after
}

/// The longest end in `min..=j` that sits on a `\b` (regex backtracking over a run that may
/// end in `-`).
fn word_end(b: &[u8], min: usize, j: usize) -> Option<usize> {
    (min..=j).rev().find(|&k| boundary(b, k))
}

/// The end of the JS `\s*` run at `i`: `char::is_whitespace` less U+0085, plus U+FEFF.
/// `i` must be a char boundary of the line `b` came from.
fn js_space_run(b: &[u8], i: usize) -> usize {
    let rest = std::str::from_utf8(&b[i..]).unwrap_or_default();
    let js = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    i + rest.len() - rest.trim_start_matches(js).len()
}

fn lit(b: &[u8], i: usize, s: &str) -> bool {
    b[i..].starts_with(s.as_bytes())
}

/// `\bsk-[A-Za-z0-9_-]{16,}\b`
fn api_key(b: &[u8], i: usize) -> Result<usize, usize> {
    if !lit(b, i, "sk-") || !starts_word(b, i) {
        return Err(i + 1);
    }
    word_end(b, i + 19, run(b, i + 3, token)).ok_or(i + 1)
}

/// `\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b`
fn github(b: &[u8], i: usize) -> Result<usize, usize> {
    if !starts_word(b, i) {
        return Err(i + 1);
    }
    for p in ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if lit(b, i, p) {
            let j = run(b, i + p.len(), word);
            if j - (i + p.len()) >= 20 {
                return Ok(j);
            }
        }
    }
    Err(i + 1)
}

/// `\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`
fn aws(b: &[u8], i: usize) -> Result<usize, usize> {
    if !(lit(b, i, "AKIA") || lit(b, i, "ASIA")) || !starts_word(b, i) {
        return Err(i + 1);
    }
    let end = i + 20;
    let body = b.get(i + 4..end).unwrap_or_default();
    let ok = body.len() == 16
        && body
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && (end == b.len() || !word(b[end]));
    if ok {
        Ok(end)
    } else {
        Err(i + 1)
    }
}

/// `\bAIza[A-Za-z0-9_-]{30,}`
fn google(b: &[u8], i: usize) -> Result<usize, usize> {
    if !lit(b, i, "AIza") || !starts_word(b, i) {
        return Err(i + 1);
    }
    let j = run(b, i + 4, token);
    if j - (i + 4) >= 30 {
        Ok(j)
    } else {
        Err(i + 1)
    }
}

/// `\bxox[abposr]-[A-Za-z0-9-]{10,}\b`
fn slack(b: &[u8], i: usize) -> Result<usize, usize> {
    let ok = lit(b, i, "xox")
        && starts_word(b, i)
        && b.get(i + 3).is_some_and(|c| b"abposr".contains(c))
        && b.get(i + 4) == Some(&b'-');
    if !ok {
        return Err(i + 1);
    }
    let j = run(b, i + 5, |c| c.is_ascii_alphanumeric() || c == b'-');
    word_end(b, i + 15, j).ok_or(i + 1)
}

/// `\b\d{8,12}:[A-Za-z0-9_-]{30,}\b`
fn telegram(b: &[u8], i: usize) -> Result<usize, usize> {
    if !b[i].is_ascii_digit() || !starts_word(b, i) {
        return Err(i + 1);
    }
    let d = run(b, i, |c| c.is_ascii_digit());
    if !(8..=12).contains(&(d - i)) || b.get(d) != Some(&b':') {
        return Err(d);
    }
    word_end(b, d + 31, run(b, d + 1, token)).ok_or(d)
}

/// `-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----`
fn private_key(b: &[u8], i: usize) -> Result<usize, usize> {
    if !lit(b, i, "-----BEGIN") {
        return Err(i + 1);
    }
    let tail = " PRIVATE KEY-----";
    let (mut j, mut best) = (i + 10, None);
    loop {
        if lit(b, j, tail) {
            best = Some(j + tail.len());
        }
        if b.get(j) != Some(&b' ') {
            break;
        }
        let k = run(b, j + 1, |c| c.is_ascii_uppercase());
        if k == j + 1 {
            break;
        }
        j = k;
    }
    best.ok_or(i + 1)
}

/// `\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`
fn jwt(b: &[u8], i: usize) -> Result<usize, usize> {
    if !lit(b, i, "eyJ") || !starts_word(b, i) {
        return Err(i + 1);
    }
    let part = |start: usize| -> Option<usize> {
        let j = run(b, start, token);
        (j - start >= 8 && b.get(j) == Some(&b'.')).then_some(j + 1)
    };
    let second = part(i + 3).filter(|&j| lit(b, j, "eyJ"));
    let third = second.and_then(|j| part(j + 3));
    third
        .and_then(|j| word_end(b, j + 8, run(b, j, token)))
        .ok_or(i + 1)
}

/// `[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|bearer|credential)[A-Za-z0-9_.-]*
/// \s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}`, case-insensitive.
fn env_assignment(b: &[u8], i: usize) -> Result<usize, usize> {
    let e = run(b, i, name);
    // Everything after the name is the same for every start inside it, and a shorter name
    // holds fewer keywords: one failed try settles the whole run.
    let skip = Err(e.max(i + 1));
    let lower = b[i..e].to_ascii_lowercase();
    let has = |k: &str| lower.windows(k.len()).any(|w| w == k.as_bytes());
    let keyword = [
        "apikey",
        "api_key",
        "api-key",
        "secret",
        "token",
        "password",
        "passwd",
        "bearer",
        "credential",
    ]
    .iter()
    .any(|k| has(k));
    if !keyword {
        return skip;
    }
    let mut j = js_space_run(b, e);
    if !matches!(b.get(j), Some(b':' | b'=')) {
        return skip;
    }
    j = js_space_run(b, j + 1);
    if matches!(b.get(j), Some(b'"' | b'\'')) {
        j += 1;
    }
    let v = run(b, j, |c| name(c) || c == b'/' || c == b'+');
    if v - j >= 12 {
        Ok(v)
    } else {
        skip
    }
}

#[cfg(test)]
mod tests {
    use super::redact;

    fn r(s: &str) -> String {
        redact(s, &[])
    }

    #[test]
    fn credential_shapes_go() {
        let cases = [
            concat!("key sk-", "ant-abcdefghijklmnop1234 end"),
            concat!("ghp", "_abcdefghijklmnopqrstuvwxyz12"),
            concat!("AK", "IAABCDEFGHIJKLMNOP"),
            concat!("AI", "zaabcdefghijklmnopqrstuvwxyz0123456789"),
            concat!("xo", "xb-1234567890-abc"),
            "123456789:abcdefghijklmnopqrstuvwxyz0123456",
            concat!("-----BEGIN RSA PRIVATE", " KEY-----"),
            concat!("-----BEGIN PRIVATE", " KEY-----"),
            concat!("eyJhbGciOiJIUzI1.", "eyJzdWIiOiIxMjM0.abcdefghijk"),
            "OPENROUTER_API_KEY=abcdefghijklmnop",
            concat!("AWS_SECRET", "_ACCESS_KEY = \"abcdefghijklmnop\""),
            "password: hunter2hunter2",
        ];
        for c in cases {
            let out = r(c);
            assert!(out.contains("•••"), "{c:?} → {out:?}");
        }
        assert_eq!(r(concat!("sk-", "abcdefghijklmnopqr-")), "•••-");
        assert_eq!(r("x OPENROUTER_API_KEY=abcdefghijklmnop y"), "x ••• y");
        assert_eq!(
            r(concat!("-----BEGIN RSA PRIVATE", " KEY-----\nMII")),
            "•••\nMII"
        );
    }

    #[test]
    fn ordinary_text_stays() {
        let cases = [
            "starting on port 8080",
            "risk-free sk-short",
            "token=short",
            concat!("AK", "IAABCDEFGHIJKLMNOPQ"),
            "příliš žluťoučký kůň token count 3",
            "1234567:abcdefghijklmnopqrstuvwxyz0123456",
        ];
        for c in cases {
            assert_eq!(r(c), c);
        }
    }

    #[test]
    fn secret_values_go_first() {
        assert_eq!(
            redact("using hunter2 now", &["hunter2".into()]),
            "using ••• now"
        );
    }

    #[test]
    fn js_whitespace_around_the_assignment() {
        assert_eq!(r("password=\u{a0}hunter2hunter2xx"), "•••");
        assert_eq!(r("TOKEN\u{b}=abcdefghijklmnop"), "•••");
        for ws in [
            '\u{c}', '\u{1680}', '\u{2000}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}',
            '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            let line = format!("token{ws}:{ws}abcdefghijklmnop");
            assert_eq!(r(&line), "•••", "{ws:?}");
        }
        // U+0085 is Rust whitespace but not JS `\s`.
        let nel = "token\u{85}=abcdefghijklmnop";
        assert_eq!(r(nel), nel);
    }

    #[test]
    fn word_boundary_either_way() {
        // `-` then `_` is a nonword-to-word `\b`.
        assert_eq!(r(concat!("xo", "xb-123456789-_")), "•••_");
    }

    #[test]
    fn longer_secret_goes_before_its_substring() {
        let secrets = ["horse".to_string(), "correct-horse-battery".to_string()];
        assert_eq!(redact("pw correct-horse-battery!", &secrets), "pw •••!");
    }
}
