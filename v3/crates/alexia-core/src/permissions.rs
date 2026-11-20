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
use serde_json::{Map, Value, json};

use crate::{Blocks, Boundary, PermissionMode, Result, Ruling, Scope};

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

/// v2 `readOnly`: neither an unreviewed server's word nor silence counts as read-only.
fn read_only(ask: &CallAsk) -> bool {
    ask.reviewed
        && ask
            .annotations
            .is_some_and(|a| a.read_only_hint == Some(true) && a.destructive_hint != Some(true))
}

/// v2 `isDestructive`. `reviewed == false` is destructive whatever the annotations say.
fn is_destructive(ask: &CallAsk) -> bool {
    !ask.reviewed || ask.annotations.is_some_and(|a| a.destructive_hint == Some(true))
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

/// v2 `plainly`: a tool id with its seams taken out, `computer__click` reads "click".
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
    never_touch_list(data_dir)
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
    let from = key(&resolved(parent));
    let to = key(&resolved(path));
    to.len() >= from.len() && to[..from.len()] == from[..]
}

/// Segments to compare. Windows paths are case-insensitive.
fn key(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| {
            let s = c.as_os_str().to_string_lossy();
            if cfg!(windows) {
                s.to_lowercase()
            } else {
                s.into_owned()
            }
        })
        .collect()
}

/// The real place a path names: the deepest existing ancestor canonicalised (the OS follows
/// symlinks and `..` there), then the part that does not exist yet folded on top.
fn resolved(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut head = abs.as_path();
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(head) {
            let mut out = unverbatim(real);
            out.extend(tail.iter().rev());
            return fold(&out);
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
            _ => return fold(&abs),
        }
    }
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

/// Absolute paths an argument object names (v2 `pathsIn`). Absolute only: a relative path
/// cannot be resolved to a real place from out here (D58), so this is a filter, not a sandbox.
pub fn paths_in(args: &Map<String, Value>) -> Vec<PathBuf> {
    fn walk(value: &Value, depth: usize, found: &mut Vec<PathBuf>) {
        if depth > 4 {
            return;
        }
        match value {
            Value::String(s) if looks_absolute(s) => found.push(PathBuf::from(s)),
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
pub fn scope(store: &Store, data_dir: &Path) -> Scope {
    let get = |key: &str| store.kv_get(NS, key).ok().flatten();
    let saved = get("scope").unwrap_or(Value::Null);
    let mode = [saved.get("mode").cloned(), get("mode")]
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
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    let boundaries = get("boundaries")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Scope {
        mode,
        roots,
        everywhere: saved.get("everywhere") == Some(&Value::Bool(true)),
        boundaries,
        data_dir: data_dir.to_path_buf(),
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
        assert_eq!(plainly("computer__click"), "click");
        assert_eq!(plainly("notes__read_all.v2"), "read all v2");
        assert_eq!(plainly("plain"), "plain");
    }
}
