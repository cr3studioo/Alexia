// SPDX-License-Identifier: AGPL-3.0-only
//! Permission modes, scope, never-touch paths and spoken boundaries (TR-01). A port of v2's
//! `packages/core/src/permissions.ts`.
//!
//! Checked in this order and never the other way round: the never-touch list (no mode turns
//! it off, D63), then scope (the folders the owner chose), then spoken boundaries ("don't
//! delete anything"), then the mode, read off the tool's MCP annotations. Nothing here knows a
//! plugin's name and nothing here asks a model anything.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use alexia_mcp::types::{Root, ToolAnnotations};
use alexia_store::{Ms, Store};
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::{Blocks, Boundary, Origin, PermissionMode, Result, Ruling, Scope};

/// One call, as the rules see it.
pub struct CallAsk<'a> {
    pub tool: &'a str,
    /// What the call does, in words a person reads. Empty → the tool id with its seams out.
    pub words: &'a str,
    pub annotations: Option<&'a ToolAnnotations>,
    /// Absolute paths this call names, if core could work out any.
    pub paths: Vec<PathBuf>,
    /// Whether the annotations can be believed (wire-protocol §7). An unreviewed server's
    /// every tool is destructive until a human says otherwise.
    pub reviewed: bool,
}

/// v2 `EVERYWHERE_WARNING`, word for word.
pub const EVERYWHERE_WARNING: &str = "Everywhere means every folder your account can reach, including ones you have forgotten about. The never-touch list still applies — keys, system folders and Alexia’s own database are never readable whatever the mode.";

const NS: &str = "_core";

/// v2 `rule`. The never-touch list survives Full trust (D63): Full trust removes prompts, not
/// the floor.
pub fn rule(ask: &CallAsk, scope: &Scope) -> Ruling {
    let words = if ask.words.trim().is_empty() {
        plainly(ask.tool)
    } else {
        ask.words.to_string()
    };
    let doing = as_verb(&words);

    if let Some(forbidden) = ask.paths.iter().find(|p| never_touch(p, &scope.data_dir)) {
        return Ruling::Blocked(format!(
            "Alexia can’t use {}. It is on her never-touch list, and no permission setting turns that off.",
            forbidden.display()
        ));
    }

    // Empty roots and no Everywhere: the owner has not said where Alexia may work, so the
    // answer to "may I write here" is no rather than probably.
    if let Some(outside) = ask.paths.iter().find(|p| !in_scope(p, scope)) {
        return Ruling::Ask(format!(
            "Alexia wants to {doing} in {}. That is outside the folders you chose. Allow it?",
            outside.display()
        ));
    }

    let destructive = is_destructive(ask);
    if let Some(b) = scope
        .boundaries
        .iter()
        .find(|b| b.blocks == Blocks::Everything || destructive)
    {
        // Their sentence, not a paraphrase of it, so the thing to lift is unmistakable.
        return Ruling::Blocked(format!(
            "You said “{}”, so Alexia did not {doing}. Tell her to lift it and she will.",
            b.said
        ));
    }

    match scope.mode {
        PermissionMode::FullTrust => Ruling::Run,
        PermissionMode::AskEveryTime => Ruling::Ask(format!("Alexia wants to {doing}. Allow it?")),
        // Runs, and the checker reviews it (M15-4).
        PermissionMode::WatchAndWarn => Ruling::Run,
        PermissionMode::AskRisky if read_only(ask) => Ruling::Run,
        PermissionMode::AskRisky => {
            let changes = if destructive {
                "This may change or delete something."
            } else {
                "This may change something."
            };
            Ruling::Ask(format!("Alexia wants to {doing}. {changes} Allow it?"))
        }
    }
}

/// The sentence for a proactive Ask (P3-06).
pub const PROACTIVE_ASK: &str = "Alexia wants to {doing} on her own. Allow it?";

/// (P3-06, D214) Narrows `rule`'s ruling for a task whose origin is `Origin::Scheduler`, so
/// acting on her own never turns into sending things. Blocked stays Blocked (the never-touch
/// list and spoken boundaries hold for a listed tool too). Then, in order:
/// 1. outward-facing (anything but `openWorldHint: false`) or an unreviewed plugin → Ask, in every mode;
/// 2. read-only → `ruling` unchanged;
/// 3. on the owner's list (`scope.silent`) → Run;
/// 4. otherwise → Ask with [`PROACTIVE_ASK`].
pub fn proactive(ask: &CallAsk, scope: &Scope, ruling: Ruling) -> Ruling {
    if matches!(ruling, Ruling::Blocked(_)) {
        return ruling;
    }
    let words = if ask.words.trim().is_empty() {
        plainly(ask.tool)
    } else {
        ask.words.to_string()
    };
    let question = || Ruling::Ask(PROACTIVE_ASK.replace("{doing}", &as_verb(&words)));
    if reaches_out(ask.annotations) || !ask.reviewed {
        return match ruling {
            r @ Ruling::Ask(_) => r,
            _ => question(),
        };
    }
    if read_only(ask) {
        return ruling;
    }
    if scope.silent.iter().any(|t| t == ask.tool) {
        return Ruling::Run;
    }
    question()
}

/// (P3-42) MCP's default for `openWorldHint` is true: only an explicit `false` keeps a tool
/// inside the owner's computers. No annotations at all reaches outside too.
pub fn reaches_out(annotations: Option<&ToolAnnotations>) -> bool {
    annotations.and_then(|a| a.open_world_hint) != Some(false)
}

/// The sentence for a tool local-only blocks.
pub const LOCAL_ONLY_BLOCKED: &str =
    "Local-only mode is on, so Alexia won't {doing}: it would reach outside your computers.";

/// (P4-30, D-P4-11) Narrows a ruling when `scope.local_only`: a tool that [`reaches_out`] is
/// Blocked; everything else unchanged. Applied after `rule` and after `proactive`.
pub fn local_only(ask: &CallAsk, scope: &Scope, ruling: Ruling) -> Ruling {
    if !scope.local_only || matches!(ruling, Ruling::Blocked(_)) {
        return ruling;
    }
    if !reaches_out(ask.annotations) {
        return ruling;
    }
    let words = if ask.words.trim().is_empty() {
        plainly(ask.tool)
    } else {
        ask.words.to_string()
    };
    Ruling::Blocked(LOCAL_ONLY_BLOCKED.replace("{doing}", &as_verb(&words)))
}

/// The flag itself, for callers without a Scope (router, hub). kv `_core`/`local_only` is
/// `true`; absent, any other value or unreadable → false.
pub fn is_local_only(store: &Store) -> bool {
    matches!(store.kv_get(NS, "local_only"), Ok(Some(Value::Bool(true))))
}

/// Someone the owner let talk to Alexia on a channel (HB-18, TR-11).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guest {
    pub id: i64,
    pub name: String,
}

/// The guest behind an origin, if any: `Origin::Channel { channel, chat }` looked up with
/// `Store::guest_of` (a removed guest is nobody). Every other origin → None.
///
/// A store error is None too (the signature has no third answer), and is logged.
pub fn guest_of(store: &Store, origin: &Origin) -> Option<Guest> {
    let Origin::Channel { channel, chat } = origin else {
        return None;
    };
    match store.guest_of(channel, chat) {
        Ok(row) => row.map(|g| Guest {
            id: g.id,
            name: g.name,
        }),
        Err(_) => {
            // Not the chat id: it identifies a person.
            tracing::warn!("guests could not be read for a {channel} chat");
            None
        }
    }
}

/// What a guest hears whenever a call is refused. One sentence for every reason, so a refusal
/// never tells a guest the owner's folders, boundaries or settings.
pub const GUEST_BLOCKED: &str = "That isn't something Alexia does for guests.";

/// (P4-31, D-P4-12) Narrows a ruling for a guest's turn. Applied after `rule`, `proactive` and
/// `local_only`. Blocked unless the tool is on `scope.guest_tools`, names no path (guests get
/// no folders) and is read-only or not destructive. Never Ask: a guest cannot approve for the
/// owner, so what would ask is Blocked. Every Blocked is [`GUEST_BLOCKED`].
pub fn guest(ask: &CallAsk, scope: &Scope, ruling: Ruling) -> Ruling {
    let allowed = matches!(ruling, Ruling::Run)
        && ask.paths.is_empty()
        && scope.guest_tools.iter().any(|t| t == ask.tool)
        && !is_destructive(ask);
    if allowed {
        Ruling::Run
    } else {
        Ruling::Blocked(GUEST_BLOCKED.into())
    }
}

/// v2 `readOnly`: neither an unreviewed server's word nor silence counts as read-only.
fn read_only(ask: &CallAsk) -> bool {
    ask.reviewed
        && ask
            .annotations
            .is_some_and(|a| a.read_only_hint == Some(true) && a.destructive_hint != Some(true))
}

/// v2 `isDestructive`. `reviewed == false` is destructive whatever the annotations say.
///
/// Deliberately not v2's code: v2 read a missing `destructiveHint` as safe, although its own
/// comment says "and so does not knowing" and MCP's default for the hint is true. Here only a
/// read-only call or an explicit `destructiveHint: false` is not destructive, so a spoken
/// "don't delete anything" stops a delete tool that carries no annotations.
fn is_destructive(ask: &CallAsk) -> bool {
    !ask.reviewed
        || (!read_only(ask) && ask.annotations.and_then(|a| a.destructive_hint) != Some(false))
}

/// v2 `asVerb`: "Deletes something" read as "delete something", so it fits after "Alexia wants to".
fn as_verb(words: &str) -> String {
    let (first, rest) = match words.split_once(' ') {
        Some((f, r)) => (f, Some(r)),
        None => (words, None),
    };
    let plural = first.len() >= 4
        && first.bytes().all(|b| b.is_ascii_lowercase())
        && first.ends_with('s')
        && !["ss", "us", "is"].iter().any(|e| first.ends_with(e));
    if !plural {
        return words.to_string();
    }
    let base = if let Some(stem) = first.strip_suffix("ies") {
        format!("{stem}y")
    } else if ["shes", "ches", "xes", "zes", "sses"]
        .iter()
        .any(|e| first.ends_with(e))
    {
        first[..first.len() - 2].to_string()
    } else {
        first[..first.len() - 1].to_string()
    };
    match rest {
        Some(r) => format!("{base} {r}"),
        None => base,
    }
}

/// v2 `plainly`: a tool id with its seams taken out, `demo__click` reads "click".
fn plainly(tool: &str) -> String {
    let name = tool.split_once("__").map_or(tool, |(_, n)| n);
    name.split(['_', '.'])
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env_path(var).unwrap_or_default()
}

/// v2 `neverTouchList`: built from where this machine keeps these things, never from path
/// literals (invariant 7). Short on purpose: secrets, the OS, and Alexia's own database.
pub fn never_touch_list(data_dir: &Path) -> Vec<PathBuf> {
    let home = home();
    let mut list = vec![
        data_dir.to_path_buf(),
        home.join(".ssh"),
        home.join(".gnupg"),
        home.join(".aws"),
    ];
    if cfg!(windows) {
        list.extend(
            ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)"]
                .into_iter()
                .filter_map(env_path),
        );
        // DPAPI master keys and the credential vault: the keychain, on this platform.
        if let Some(app) = env_path("APPDATA") {
            list.push(app.join("Microsoft").join("Crypto"));
            list.push(app.join("Microsoft").join("Protect"));
        }
        if let Some(local) = env_path("LOCALAPPDATA") {
            list.push(local.join("Microsoft").join("Credentials"));
        }
    } else {
        let root = Path::new(std::path::MAIN_SEPARATOR_STR);
        let system: &[&str] = if cfg!(target_os = "macos") {
            list.push(home.join("Library").join("Keychains"));
            list.push(root.join("Library").join("Keychains"));
            &["System", "usr", "bin", "sbin", "etc"]
        } else {
            list.push(home.join(".local").join("share").join("keyrings"));
            &["etc", "boot", "bin", "sbin", "usr", "sys", "proc", "dev"]
        };
        list.extend(system.iter().map(|d| root.join(d)));
    }
    // An unset home must not put the current directory on the list.
    list.retain(|p| p.is_absolute());
    list
}

/// v2 `neverTouch`: inside one of the forbidden trees, `..` and symlinks resolved first.
pub fn never_touch(path: &Path, data_dir: &Path) -> bool {
    // A path whose links cannot be followed (a loop) is refused, not guessed at.
    resolved(path).is_none()
        || never_touch_list(data_dir)
            .iter()
            .any(|forbidden| within(forbidden, path))
}

fn in_scope(path: &Path, scope: &Scope) -> bool {
    scope.everywhere || scope.roots.iter().any(|root| within(root, path))
}

/// v2 `within`: on path segments, never on the string (`work-notes` is not inside `work`).
/// Canonicalised where the path exists (so a symlink out of a root counts as outside),
/// lexically normalised where it does not; case-insensitive on Windows.
pub fn within(parent: &Path, path: &Path) -> bool {
    let (Some(from), Some(to)) = (resolved(parent), resolved(path)) else {
        return false;
    };
    let (from, to) = (key(&from), key(&to));
    // An empty parent would be a prefix of everything: it holds nothing.
    !from.is_empty() && to.len() >= from.len() && to[..from.len()] == from[..]
}

/// Segments to compare. Windows paths are case-insensitive, and Win32 drops trailing dots and
/// spaces from every segment when it opens a path (`.aws.` opens `.aws`).
fn key(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| {
            let s = c.as_os_str().to_string_lossy();
            if cfg!(windows) {
                let t = s.trim_end_matches(['.', ' ']);
                // `.` and `..` keep their meaning; a segment of only dots/spaces is nothing.
                if matches!(s.as_ref(), "." | "..") {
                    Some(s.into_owned())
                } else if t.is_empty() {
                    None
                } else {
                    Some(t.to_lowercase())
                }
            } else {
                Some(s.into_owned())
            }
        })
        .collect()
}

/// The real place a path names: the deepest existing ancestor canonicalised (the OS follows
/// symlinks and `..` there), then the part that does not exist yet folded on top. A dangling
/// symlink or junction is never folded by its name: its target is read and resolving carries on
/// from there. `None` when links loop.
fn resolved(p: &Path) -> Option<PathBuf> {
    let mut abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    // ponytail: hop cap like the OS's ELOOP limit; a deeper chain is treated as a loop.
    'hop: for _ in 0..40 {
        let mut head = abs.as_path();
        let mut tail: Vec<OsString> = Vec::new();
        loop {
            if let Ok(real) = std::fs::canonicalize(head) {
                let mut out = unverbatim(real);
                out.extend(tail.iter().rev());
                return Some(fold(&out));
            }
            let is_link = std::fs::symlink_metadata(head).is_ok_and(|m| m.file_type().is_symlink());
            if is_link {
                let target = std::fs::read_link(head).ok()?;
                // A relative target is relative to the link's folder.
                let base = head.parent().unwrap_or(head);
                let mut next = unverbatim(base.join(target));
                next.extend(tail.iter().rev());
                abs = next;
                continue 'hop;
            }
            match (head.parent(), head.file_name()) {
                (Some(up), Some(name)) => {
                    tail.push(name.to_os_string());
                    head = up;
                }
                // `..` as the last segment has no file name: take it off and keep it.
                (Some(up), None) if head.ends_with("..") => {
                    tail.push("..".into());
                    head = up;
                }
                _ => return Some(fold(&abs)),
            }
        }
    }
    None
}

/// `.` and `..` folded away lexically; `..` never climbs above the root.
fn fold(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// `\\?\C:\x` → `C:\x` and `\\?\UNC\s\x` → `\\s\x`, so canonical and lexical paths compare.
fn unverbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Absolute the way Node's `isAbsolute` is: on Windows `\x` and `/x` count too.
fn looks_absolute(s: &str) -> bool {
    let p = Path::new(s);
    p.is_absolute() || p.has_root()
}

/// A path as the OS would see it once a shell or URI parser had been at it: `file://` decoded,
/// a leading `~` made home, a leading `$VAR`, `${VAR}` or `%VAR%` expanded. An unset variable
/// is left as written, and so is an unclosed `${` or `%`: never dropped, so an absolute string
/// is still checked. The scheme is matched in any case, and RFC 8089's one-slash `file:/x` is a
/// local path. `None` only for a `file://` URI on another host: not a path on this machine.
fn normalised(s: &str) -> Option<String> {
    if s.get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
    {
        // A UNC or drive-relative result still looks absolute, so it is judged, never skipped.
        return alexia_mcp::file_uri_path(s).map(|p| p.to_string_lossy().into_owned());
    }
    if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
        return Some(format!("{}{}", home().display(), &s[1..]));
    }
    let var = if let Some(r) = s.strip_prefix("${") {
        r.split_once('}')
    } else if let Some(r) = s.strip_prefix('$') {
        Some(
            r.split_at(
                r.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(r.len()),
            ),
        )
    } else if let Some(r) = s.strip_prefix('%') {
        r.split_once('%')
    } else {
        None
    };
    let Some((name, rest)) = var else {
        return Some(s.to_string());
    };
    // `var_os` may panic on an empty name or one with `=` or NUL in it.
    let usable = !name.is_empty() && !name.contains(['=', '\0']);
    Some(match usable.then(|| env_path(name)).flatten() {
        Some(value) => format!("{}{rest}", value.display()),
        None => s.to_string(),
    })
}

/// Absolute paths an argument object names (v2 `pathsIn`). Absolute only: a relative path
/// cannot be resolved to a real place from out here (D58), so this is a filter, not a sandbox.
pub fn paths_in(args: &Map<String, Value>) -> Vec<PathBuf> {
    fn walk(value: &Value, depth: usize, found: &mut Vec<PathBuf>) {
        if depth > 4 {
            return;
        }
        match value {
            Value::String(s) => {
                if let Some(p) = normalised(s).filter(|p| looks_absolute(p)) {
                    found.push(PathBuf::from(p));
                }
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, depth + 1, found)),
            Value::Object(map) => map.values().for_each(|v| walk(v, depth + 1, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    args.values().for_each(|v| walk(v, 1, &mut found));
    found
}

/// v2 `SPOKEN`. Both apostrophes, because don't and don’t are the same sentence.
static SPOKEN: LazyLock<Vec<(Regex, Blocks)>> = LazyLock::new(|| {
    [
        (
            r"(?i)\b(?:do ?n[o’']?t|never|no)\s+(?:ever\s+)?(?:delete|remove|erase|destroy|rm)\b",
            Blocks::Destructive,
        ),
        (
            r"(?i)\b(?:do ?n[o’']?t|never)\s+(?:ever\s+)?(?:change|modify|edit|overwrite|write)\s+(?:any|anything|my|the)\b",
            Blocks::Destructive,
        ),
        (
            r"(?i)\b(?:do ?n[o’']?t|never)\s+(?:ever\s+)?(?:touch|do)\s+anything\b",
            Blocks::Everything,
        ),
        (
            r"(?i)\bread[- ]only\b.*\bplease\b|\bjust look\b|\blook,? do ?n[o’']?t touch\b",
            Blocks::Destructive,
        ),
    ]
    .into_iter()
    .map(|(p, b)| (Regex::new(p).expect("SPOKEN pattern"), b))
    .collect()
});

/// v2 `LIFTED`.
static LIFTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:you can|go ahead and|ok(?:ay)? (?:you can|to))\s+(?:delete|remove|change|edit|write)|\b(?:lift|forget|cancel|drop)\s+(?:that|the)\s+(?:rule|restriction|boundary)\b|\bnever ?mind that\b")
        .expect("LIFTED pattern")
});

/// "don't delete anything" → a Boundary; None if the sentence is not one (v2 `heard`).
pub fn heard(said: &str, at: Ms) -> Option<Boundary> {
    SPOKEN
        .iter()
        .find(|(re, _)| re.is_match(said))
        .map(|(_, blocks)| Boundary {
            said: said.trim().to_string(),
            blocks: *blocks,
            at,
        })
}

/// v2 `lifts`.
pub fn lifts(said: &str) -> bool {
    LIFTED.is_match(said)
}

/// v2 `boundaryAck`, word for word.
pub fn boundary_ack(b: &Boundary) -> String {
    match b.blocks {
        Blocks::Everything => "Understood — I will not do anything until you say otherwise. That is a rule I hold myself to, not something the operating system enforces for me.",
        Blocks::Destructive => "Understood — I will not delete or change anything until you say otherwise. That is a rule I hold myself to, not something the operating system enforces for me.",
    }
    .to_string()
}

fn mode_of(name: &str) -> Option<PermissionMode> {
    Some(match name {
        "every-time" => PermissionMode::AskEveryTime,
        "risky" => PermissionMode::AskRisky,
        "watch" => PermissionMode::WatchAndWarn,
        "full-trust" => PermissionMode::FullTrust,
        _ => return None,
    })
}

/// From the store: the mode (v2's kebab names), `_core.scope` {mode, roots, everywhere} and
/// `_core.boundaries`. Missing or unreadable → AskRisky, no roots.
///
/// v2 keeps the permission mode inside `_core.scope` (serve.ts `scope()`); its `_core.mode`
/// holds the compute mode (`combined`, `local`). Both are read: `scope.mode` first, then
/// `_core.mode` only when it is one of the four permission names.
///
/// Absent is not unreadable: a store error on any of the three keys gives [`closed_scope`],
/// so a read failure never makes a spoken boundary disappear.
pub fn scope(store: &Store, data_dir: &Path) -> Scope {
    let read = |key: &'static str| store.kv_get(NS, key).map_err(|_| key);
    let (saved, mode_saved, boundaries) = match (read("scope"), read("mode"), read("boundaries")) {
        (Ok(s), Ok(m), Ok(b)) => (s, m, b),
        (Err(key), _, _) | (_, Err(key), _) | (_, _, Err(key)) => {
            // The key only: a value could hold a path or a sentence the owner said.
            tracing::warn!("_core.{key} could not be read; Alexia asks before everything");
            return closed_scope(data_dir);
        }
    };
    let saved = saved.unwrap_or(Value::Null);
    let mode = [saved.get("mode").cloned(), mode_saved]
        .into_iter()
        .flatten()
        .find_map(|v| v.as_str().and_then(mode_of))
        .unwrap_or(PermissionMode::AskRisky);
    let roots = saved
        .get("roots")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                // v2 can save an empty root; it must not widen the scope to everywhere.
                .filter(|r| !r.trim().is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    let boundaries = match boundaries {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .into_iter()
            .enumerate()
            .filter_map(|(i, v)| match serde_json::from_value(v) {
                Ok(b) => Some(b),
                Err(_) => {
                    tracing::warn!("spoken boundary {i} could not be read and was skipped");
                    None
                }
            })
            .collect(),
        Some(_) => {
            tracing::warn!("_core.boundaries is not a list; no spoken boundaries were loaded");
            Vec::new()
        }
    };
    // The owner's "do it without asking" list (P3-06). Unreadable or malformed reads as
    // empty: a proactive run then asks, which is the safe side.
    let silent = tool_list(store, "silent");
    Scope {
        mode,
        roots,
        everywhere: saved.get("everywhere") == Some(&Value::Bool(true)),
        boundaries,
        data_dir: data_dir.to_path_buf(),
        silent,
        local_only: is_local_only(store),
        guest_tools: tool_list(store, "guest_tools"),
    }
}

/// A kv `_core` list of tool ids. Unreadable or malformed reads as empty: the safe side for
/// both `silent` (a proactive run asks) and `guest_tools` (a guest only talks).
fn tool_list(store: &Store, key: &str) -> Vec<String> {
    store
        .kv_get(NS, key)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
}

/// What [`scope`] gives when the store cannot be read: ask every time, no folders, and one
/// boundary that blocks everything until the permissions can be read again.
fn closed_scope(data_dir: &Path) -> Scope {
    Scope {
        mode: PermissionMode::AskEveryTime,
        roots: Vec::new(),
        everywhere: false,
        boundaries: vec![Boundary {
            said: "Alexia could not read your permissions, so it asks before everything.".into(),
            blocks: Blocks::Everything,
            at: 0,
        }],
        data_dir: data_dir.to_path_buf(),
        silent: Vec::new(),
        local_only: false,
        guest_tools: Vec::new(),
    }
}

/// `_core.boundaries`, the shape v2 writes.
pub fn save_boundaries(store: &Store, b: &[Boundary]) -> Result<()> {
    store.kv_set(NS, "boundaries", &json!(b))?;
    Ok(())
}

/// v2 `rootsOf`: the chosen folders as MCP roots. Everywhere invents none (`/` would tell a
/// plugin something false), and a forbidden folder is never handed out.
pub fn roots_of(scope: &Scope) -> Vec<Root> {
    scope
        .roots
        .iter()
        .filter(|dir| !never_touch(dir, &scope.data_dir))
        .map(|dir| {
            let abs = fold(&std::path::absolute(dir).unwrap_or_else(|_| dir.clone()));
            let name = abs
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| abs.to_string_lossy().into_owned());
            Root {
                uri: file_uri(&abs),
                name: Some(name),
            }
        })
        .collect()
}

/// v2 `fileUri`: `file:///C:/x` on Windows, `file:///x` elsewhere, percent-encoded.
fn file_uri(abs: &Path) -> String {
    let slashed = abs.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if slashed.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for b in slashed.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:!$&'()*+,;=@".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unclosed_var_is_kept_as_written() {
        for s in ["${oops/x", "%oops/x", r"C:\Users\x\.ssh\${oops"] {
            assert_eq!(normalised(s).as_deref(), Some(s));
        }
    }

    #[test]
    fn as_verb_drops_the_s() {
        assert_eq!(as_verb("Lists every note"), "Lists every note"); // capitalised: untouched
        assert_eq!(as_verb("lists every note"), "list every note");
        assert_eq!(as_verb("copies it"), "copy it");
        assert_eq!(as_verb("pushes it"), "push it");
        assert_eq!(as_verb("access it"), "access it");
        assert_eq!(as_verb("its"), "its");
    }

    #[test]
    fn plainly_takes_the_seams_out() {
        assert_eq!(plainly("demo__click"), "click");
        assert_eq!(plainly("notes__read_all.v2"), "read all v2");
        assert_eq!(plainly("plain"), "plain");
    }

    // ---- P3-06: the proactive rule ----

    fn ann(v: serde_json::Value) -> ToolAnnotations {
        serde_json::from_value(v).unwrap()
    }

    fn silent_scope(silent: &[&str]) -> Scope {
        Scope {
            mode: PermissionMode::FullTrust,
            roots: Vec::new(),
            everywhere: true,
            boundaries: Vec::new(),
            data_dir: PathBuf::from("/data"),
            silent: silent.iter().map(|s| s.to_string()).collect(),
            local_only: false,
            guest_tools: Vec::new(),
        }
    }

    fn asking<'a>(tool: &'a str, a: &'a ToolAnnotations, reviewed: bool) -> CallAsk<'a> {
        CallAsk {
            tool,
            words: "",
            annotations: Some(a),
            paths: Vec::new(),
            reviewed,
        }
    }

    #[test]
    fn proactive_blocked_stays_blocked() {
        let a = ann(serde_json::json!({"readOnlyHint": true}));
        let r = proactive(
            &asking("x__look", &a, true),
            &silent_scope(&["x__look"]),
            Ruling::Blocked("no".into()),
        );
        assert_eq!(r, Ruling::Blocked("no".into()));
    }

    #[test]
    fn proactive_open_world_and_unreviewed_ask() {
        let open = ann(serde_json::json!({"readOnlyHint": true, "openWorldHint": true}));
        let s = silent_scope(&["x__send"]);
        assert!(matches!(
            proactive(&asking("x__send", &open, true), &s, Ruling::Run),
            Ruling::Ask(_)
        ));
        let read = ann(serde_json::json!({"readOnlyHint": true}));
        assert!(matches!(
            proactive(&asking("x__send", &read, false), &s, Ruling::Run),
            Ruling::Ask(_)
        ));
    }

    #[test]
    fn proactive_read_only_keeps_ruling() {
        let read = ann(
            serde_json::json!({"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}),
        );
        let s = silent_scope(&[]);
        assert_eq!(
            proactive(&asking("x__look", &read, true), &s, Ruling::Run),
            Ruling::Run
        );
        let asked = Ruling::Ask("outside".into());
        assert_eq!(
            proactive(&asking("x__look", &read, true), &s, asked.clone()),
            asked
        );
    }

    #[test]
    fn proactive_listed_runs_unlisted_asks() {
        let write = ann(
            serde_json::json!({"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}),
        );
        let on = silent_scope(&["x__note"]);
        assert_eq!(
            proactive(
                &asking("x__note", &write, true),
                &on,
                Ruling::Ask("q".into())
            ),
            Ruling::Run
        );
        let off = silent_scope(&[]);
        assert_eq!(
            proactive(&asking("x__note", &write, true), &off, Ruling::Run),
            Ruling::Ask("Alexia wants to note on her own. Allow it?".into())
        );
    }

    // ---- P3-42: a missing openWorldHint reaches outside ----

    #[test]
    fn reaches_out_unless_explicitly_false() {
        assert!(reaches_out(None));
        assert!(reaches_out(Some(&ann(serde_json::json!({})))));
        assert!(reaches_out(Some(&ann(
            serde_json::json!({"openWorldHint": true})
        ))));
        assert!(!reaches_out(Some(&ann(
            serde_json::json!({"openWorldHint": false})
        ))));
    }
}
