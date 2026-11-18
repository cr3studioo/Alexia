// SPDX-License-Identifier: AGPL-3.0-only
//! `plugin.json` v1: parse it as strictly as v2 does, decide whether this build may run it,
//! and find every plugin folder in a directory. Nothing here spawns a process.
//!
//! The authority is v2's `packages/protocol/src/manifest.ts` (`ManifestShape` and the
//! `superRefine` on `Manifest`), `versionVerdict`/`mcpRefusal`, and the two checks v2's loader
//! adds in `packages/core/src/plugins.ts` (folder name = id, `fs.`/`net.`/`proc.` must be a
//! permission). Rules about `panel`, `page` and widget fields stay with the UI and are not here.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::{ALEXIA_PROTOCOL_MAX, ALEXIA_PROTOCOL_MIN, APP_VERSION, MCP_REVISIONS};

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{sentence}")]
pub struct ManifestError {
    /// What the owner reads, e.g. "The plugin in “foo” has a manifest with an unknown field “tols”."
    pub sentence: String,
}

/// Strict at the top level like v2 (`deny_unknown_fields`): a typo'd key is a load error.
/// Sub-objects the hub does not interpret yet (`panel`, `page`, a setting's widget fields) are
/// kept as raw JSON so a v2 manifest that is valid today parses unchanged.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(rename = "$schema")]
    pub schema: Option<String>,
    pub manifest_version: u32,
    pub id: String,
    pub name: String,
    pub summary: String,
    pub version: String,
    pub license: String,
    pub entry: Entry,
    pub alexia_protocol: u32,
    pub mcp_protocol: String,
    pub min_app: Option<String>,
    pub max_app: Option<String>,
    #[serde(default)]
    pub requires: Vec<Require>,
    #[serde(default)]
    pub provides: Vec<String>,
    #[serde(default)]
    pub settings: Vec<Setting>,
    pub storage: Option<StorageDecl>,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub assets: Vec<String>,
    pub min_tier: Option<String>,
    pub lifetime: Option<Lifetime>,
    pub panel: Option<Value>,
    pub page: Option<Value>,
    pub compute: Option<ComputeDecl>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub run: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Require {
    pub cap: String,
    pub why: String,
}

/// `key` and `type` are what the host reads; everything else is the widget's (ui-schema.md).
#[derive(Clone, Debug, Deserialize)]
pub struct Setting {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub default: Option<Value>,
    #[serde(flatten)]
    pub widget: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageDecl {
    pub namespace: String,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub dir: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub name: String,
    pub summary: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lifetime {
    Lazy,
    Resident,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputeDecl {
    pub operations: Vec<ComputeOp>,
    #[serde(default)]
    pub hooks: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputeOp {
    pub cap: String,
    pub summary: String,
    pub weight: Option<String>,
}

/// A folder with a readable plugin.json. Reading one never spawns anything.
#[derive(Clone, Debug)]
pub struct PluginDir {
    pub path: PathBuf,
    pub manifest: Manifest,
}

/// Every top-level key `Manifest` has. Checked before serde so the sentence can name the key.
const KEYS: &[&str] = &[
    "$schema",
    "manifest_version",
    "id",
    "name",
    "summary",
    "version",
    "license",
    "entry",
    "alexia_protocol",
    "mcp_protocol",
    "min_app",
    "max_app",
    "requires",
    "provides",
    "settings",
    "storage",
    "commands",
    "skills",
    "assets",
    "min_tier",
    "lifetime",
    "panel",
    "page",
    "compute",
];

/// capabilities.ts `PERMISSIONS`.
const PERMISSIONS: &[&str] = &[
    "fs.own_dir",
    "fs.read_scoped",
    "fs.write_scoped",
    "net.download",
    "net.request",
    "net.listen",
    "audio.input",
    "audio.output",
    "screen.capture",
    "input.control",
    "proc.spawn",
    "notify",
    "attachments.scoped",
];

/// The widget types v2's `setting` discriminated union accepts.
const WIDGETS: &[&str] = &[
    "research",
    "text",
    "password",
    "number",
    "toggle",
    "choice",
    "multi-choice",
    "path",
    "file",
    "status",
    "progress",
    "action",
    "table",
    "graph",
    "tree",
    "cards",
    "image",
];

const TIERS: &[&str] = &["T0", "T1", "T2", "T3"];
const HOOKS: &[&str] = &["setup", "install", "prepare", "release"];

impl Manifest {
    /// Parse and run manifest.md's cross-field checks (ids, capability syntax, duplicates,
    /// permission names from capabilities.md's registry).
    pub fn parse(json: &str) -> Result<Manifest, ManifestError> {
        let raw: Option<Value> = serde_json::from_str(json).ok();
        let subject = match raw
            .as_ref()
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
        {
            Some(id) => format!("The plugin “{id}”"),
            None => "This plugin".to_string(),
        };
        parse_as(json, &subject)
    }

    /// Check two of wire-protocol.md §3.3 plus min_app/max_app. Err is the sentence the owner reads.
    /// Order and wording are v2's `versionVerdict`.
    pub fn compatible(&self) -> Result<(), String> {
        let name = &self.name;
        let app = APP_VERSION;
        if let Some(min) = &self.min_app {
            if newer(min, app) {
                return Err(format!(
                    "{name} needs Alexia {min} or later, and this is {app}.\nUpdate Alexia, or install an earlier version of {name}."
                ));
            }
        }
        if let Some(max) = &self.max_app {
            if newer(app, max) {
                return Err(format!(
                    "{name} says it runs on Alexia {max} and earlier, and this is {app}.\nCheck whether {name} has an update."
                ));
            }
        }
        if self.alexia_protocol > ALEXIA_PROTOCOL_MAX {
            return Err(format!(
                "{name} needs a newer Alexia.\nUpdate Alexia, or install an earlier version of {name}."
            ));
        }
        if self.alexia_protocol < ALEXIA_PROTOCOL_MIN {
            return Err(format!(
                "{name} was written for an older version of Alexia and can't load.\nCheck whether {name} has an update."
            ));
        }
        if !MCP_REVISIONS.contains(&self.mcp_protocol.as_str()) {
            return Err(format!(
                "{name} speaks a version of MCP that Alexia doesn't.\nAlexia speaks {}; {name} speaks {}.",
                MCP_REVISIONS.join(" and "),
                self.mcp_protocol
            ));
        }
        Ok(())
    }

    /// `lifetime` with v2's default (`Lazy` when absent).
    pub fn lifetime(&self) -> Lifetime {
        self.lifetime.unwrap_or(Lifetime::Lazy)
    }

    /// Keys of settings whose `kind == "password"`.
    pub fn password_keys(&self) -> Vec<String> {
        self.settings
            .iter()
            .filter(|s| s.kind == "password")
            .map(|s| s.key.clone())
            .collect()
    }
}

/// Every `<dir>/*/plugin.json`. A folder whose manifest fails is reported, never fatal.
/// Sorted by folder name; a missing `dir` or a folder with no `plugin.json` yields nothing.
pub fn discover(dir: &Path) -> Vec<Result<PluginDir, (PathBuf, ManifestError)>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut folders: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| p.join("plugin.json").is_file())
        .collect();
    folders.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    folders
        .into_iter()
        .map(|path| {
            let folder = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let subject = format!("The plugin in “{folder}”");
            let manifest = std::fs::read_to_string(path.join("plugin.json"))
                .map_err(|_| err(format!("{subject} has a plugin.json Alexia can’t read.")))
                .and_then(|json| parse_as(&json, &subject))
                // v2's loader: the folder name is the id everywhere else.
                .and_then(|m| {
                    if m.id == folder {
                        Ok(m)
                    } else {
                        Err(err(format!(
                            "{subject} has a manifest that calls it “{}”; the folder and the id must match.",
                            m.id
                        )))
                    }
                });
            match manifest {
                Ok(manifest) => Ok(PluginDir { path, manifest }),
                Err(e) => Err((path, e)),
            }
        })
        .collect()
}

fn err(sentence: String) -> ManifestError {
    ManifestError { sentence }
}

fn parse_as(json: &str, subject: &str) -> Result<Manifest, ManifestError> {
    let invalid = |detail: String| {
        err(format!(
            "{subject} has a manifest Alexia can’t load: {detail}."
        ))
    };
    let raw: Value = serde_json::from_str(json)
        .map_err(|_| err(format!("{subject} has a manifest that is not valid JSON.")))?;
    let Some(top) = raw.as_object() else {
        return Err(invalid("it is not a JSON object".into()));
    };
    if let Some(key) = top.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(err(format!(
            "{subject} has a manifest with an unknown field “{key}”."
        )));
    }
    // zod's `.optional()` refuses null, but serde reads null as absent: check the raw keys,
    // and every key inside the strict objects. Settings are not walked: their widget fields
    // stay v2's, and zod strips unknown keys such as a password `default`.
    const STRICT: &[&str] = &["entry", "requires", "storage", "commands", "compute"];
    let null = top.iter().find_map(|(k, v)| match v {
        Value::Null => Some(k.clone()),
        v if STRICT.contains(&k.as_str()) => null_path(v, k),
        _ => None,
    });
    if let Some(key) = null {
        return Err(invalid(format!("“{key}” must not be null")));
    }
    // v2 checks `assets !== undefined`; serde's default can't tell `[]` from absent.
    let protocol = top.get("alexia_protocol").and_then(Value::as_u64);
    if top.contains_key("assets") && protocol.is_some_and(|p| p < 15) {
        return Err(invalid(
            "assets arrived in alexia_protocol 15; declare “alexia_protocol”: 15 to use it".into(),
        ));
    }
    let mut m: Manifest =
        serde_json::from_value(raw).map_err(|e| invalid(curly(&e.to_string())))?;
    check(&m).map_err(invalid)?;
    // v2's `password` variant has no `default`; zod strips it, so a password never has one.
    for s in m.settings.iter_mut().filter(|s| s.kind == "password") {
        s.default = None;
    }
    Ok(m)
}

/// The path of the first null inside `v`, e.g. `compute.operations[0].weight`.
fn null_path(v: &Value, path: &str) -> Option<String> {
    match v {
        Value::Null => Some(path.to_string()),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .find_map(|(i, x)| null_path(x, &format!("{path}[{i}]"))),
        Value::Object(o) => o
            .iter()
            .find_map(|(k, x)| null_path(x, &format!("{path}.{k}"))),
        _ => None,
    }
}

/// serde writes `name`; the owner reads “name”.
fn curly(s: &str) -> String {
    let mut open = true;
    s.chars()
        .map(|c| match c {
            '`' => {
                let q = if open { '“' } else { '”' };
                open = !open;
                q
            }
            c => c,
        })
        .collect()
}

/// `ManifestShape`'s field rules and the `superRefine`'s cross-field rules, for the fields this
/// struct interprets. The first broken rule is the one reported, as v2 reports its first issue.
fn check(m: &Manifest) -> Result<(), String> {
    let p = m.alexia_protocol;
    let since = |what: &str, rev: u32| -> Result<(), String> {
        if p < rev {
            Err(format!(
                "{what} arrived in alexia_protocol {rev}; declare “alexia_protocol”: {rev} to use it"
            ))
        } else {
            Ok(())
        }
    };
    let rule = |ok: bool, msg: String| if ok { Ok(()) } else { Err(msg) };
    let len = |s: &str, min: usize, max: usize| (min..=max).contains(&s.chars().count());

    rule(
        m.manifest_version == 1,
        format!("“manifest_version” must be 1, not {}", m.manifest_version),
    )?;
    rule(
        len(&m.id, 1, 64) && is_id(&m.id),
        format!(
            "“id” “{}” must be lowercase letters, digits and hyphens only",
            m.id
        ),
    )?;
    rule(
        len(&m.name, 1, 64),
        "“name” must be 1 to 64 characters".into(),
    )?;
    rule(
        len(&m.summary, 1, 200),
        "“summary” must be 1 to 200 characters".into(),
    )?;
    rule(
        is_semver(&m.version),
        format!(
            "“version” “{}” must be a semantic version, e.g. 0.1.0",
            m.version
        ),
    )?;
    rule(!m.license.is_empty(), "“license” must not be empty".into())?;
    rule(
        !m.entry.run.is_empty(),
        "“entry.run” must not be empty".into(),
    )?;
    rule(
        !is_absolute(&m.entry.run),
        "“entry.run” must be a command on PATH or a path relative to the plugin folder".into(),
    )?;
    rule(
        m.alexia_protocol > 0,
        "“alexia_protocol” must be a positive integer".into(),
    )?;
    rule(
        is_mcp_revision(&m.mcp_protocol),
        format!(
            "“mcp_protocol” “{}” must be an MCP revision date, e.g. 2025-11-25",
            m.mcp_protocol
        ),
    )?;
    for (field, v) in [("min_app", &m.min_app), ("max_app", &m.max_app)] {
        if let Some(v) = v {
            rule(
                is_semver(v),
                format!("“{field}” “{v}” must be a semantic version, e.g. 0.2.0"),
            )?;
        }
    }
    for r in &m.requires {
        rule(
            is_capability(&r.cap),
            format!(
                "“requires” names “{}”, which is not a capability name",
                r.cap
            ),
        )?;
        rule(
            len(&r.why, 1, 120),
            format!("the “why” for “{}” must be 1 to 120 characters", r.cap),
        )?;
        // v2's loader: these prefixes are permissions core grants, and the list is closed.
        let gated = ["fs.", "net.", "proc."]
            .iter()
            .any(|g| r.cap.starts_with(g));
        rule(
            !gated || PERMISSIONS.contains(&r.cap.as_str()),
            format!(
                "it asks for “{}”, which is not a permission Alexia grants",
                r.cap
            ),
        )?;
        if r.cap == "attachments.scoped" {
            since("attachments.scoped", 14)?;
        }
    }
    for cap in &m.provides {
        rule(
            is_capability(cap),
            format!("“provides” names “{cap}”, which is not a capability name"),
        )?;
    }
    for s in &m.settings {
        rule(
            is_ident(&s.key),
            format!(
                "the setting key “{}” must be lowercase letters, digits and underscores",
                s.key
            ),
        )?;
        rule(
            WIDGETS.contains(&s.kind.as_str()),
            format!(
                "the setting “{}” has type “{}”, which is not a widget",
                s.key, s.kind
            ),
        )?;
    }
    if let Some(st) = &m.storage {
        rule(
            st.namespace == m.id,
            format!("“storage.namespace” must equal the id (“{}”)", m.id),
        )?;
        for t in &st.tables {
            rule(
                is_ident(t),
                format!("the table name “{t}” must be lowercase letters, digits and underscores"),
            )?;
        }
    }
    for c in &m.commands {
        rule(
            is_id(&c.name),
            format!(
                "the command name “{}” must be lowercase letters, digits and hyphens",
                c.name
            ),
        )?;
        rule(
            len(&c.summary, 1, 120),
            format!(
                "the summary of command “{}” must be 1 to 120 characters",
                c.name
            ),
        )?;
    }
    for s in &m.skills {
        rule(
            !s.is_empty() && !is_absolute(s) && !s.split(['/', '\\']).any(|p| p == ".."),
            "a skill path must stay inside the plugin folder".into(),
        )?;
    }
    rule(
        m.assets.len() <= 100,
        "“assets” lists more than 100 files".into(),
    )?;
    for a in &m.assets {
        let inside = len(a, 1, 240)
            && !is_absolute(a)
            && !a.contains('\0')
            && !a
                .split(['/', '\\'])
                .any(|p| p == ".." || p == "." || p.is_empty());
        rule(
            inside,
            "an asset path must stay inside the plugin folder".into(),
        )?;
    }
    if let Some(t) = &m.min_tier {
        rule(
            TIERS.contains(&t.as_str()),
            format!("“min_tier” “{t}” must be one of T0, T1, T2 or T3"),
        )?;
    }
    if m.lifetime.is_some() {
        since("lifetime", 2)?;
    }
    if m.panel.is_some() {
        since("panel", 3)?;
    }
    if m.page.is_some() {
        since("page", 12)?;
    }
    if let Some(c) = &m.compute {
        since("compute", 13)?;
        rule(
            !c.operations.is_empty(),
            "“compute.operations” needs at least one operation".into(),
        )?;
        for op in &c.operations {
            rule(
                is_capability(&op.cap),
                format!(
                    "the compute operation “{}” is not a capability name",
                    op.cap
                ),
            )?;
            rule(
                len(&op.summary, 1, 120),
                format!(
                    "the summary of compute operation “{}” must be 1 to 120 characters",
                    op.cap
                ),
            )?;
            if let Some(w) = &op.weight {
                rule(
                    w == "heavy" || w == "light",
                    format!(
                        "the weight of compute operation “{}” must be heavy or light",
                        op.cap
                    ),
                )?;
            }
            rule(
                m.provides.contains(&op.cap),
                format!("compute operation “{}” must also be in provides", op.cap),
            )?;
        }
        for h in &c.hooks {
            rule(
                HOOKS.contains(&h.as_str()),
                format!("“{h}” is not a compute hook"),
            )?;
        }
        dupes(
            "compute.operations",
            c.operations.iter().map(|o| o.cap.as_str()),
        )?;
        dupes("compute.hooks", c.hooks.iter().map(String::as_str))?;
    }
    // Settings and panel widgets are one namespace (a widget's value is stored once), and a
    // table's or tree's row-action keys share it.
    let panel_widgets: Vec<&Value> = m
        .panel
        .as_ref()
        .and_then(|p| p.get("widgets"))
        .and_then(Value::as_array)
        .map(|w| w.iter().collect())
        .unwrap_or_default();
    let settings_raw: Vec<(&str, &str, Option<&Value>)> = m
        .settings
        .iter()
        .map(|s| (s.key.as_str(), s.kind.as_str(), s.widget.get("rowActions")))
        .chain(panel_widgets.iter().map(|w| {
            (
                w.get("key").and_then(Value::as_str).unwrap_or_default(),
                w.get("type").and_then(Value::as_str).unwrap_or_default(),
                w.get("rowActions"),
            )
        }))
        .collect();
    let every_key = settings_raw.iter().flat_map(|(key, kind, actions)| {
        let row_keys = match (*kind, actions.and_then(|a| a.as_array())) {
            ("table" | "tree", Some(a)) => a
                .iter()
                .filter_map(|x| x.get("key").and_then(Value::as_str))
                .collect(),
            _ => vec![],
        };
        std::iter::once(*key).chain(row_keys)
    });
    if let Some(d) = first_dupe(every_key) {
        return Err(format!(
            "“{d}” is declared twice; settings and panel are one namespace, because a widget’s value is stored once"
        ));
    }
    dupes("commands", m.commands.iter().map(|c| c.name.as_str()))?;
    dupes("provides", m.provides.iter().map(String::as_str))?;
    dupes("requires", m.requires.iter().map(|r| r.cap.as_str()))?;
    Ok(())
}

fn first_dupe<'a>(xs: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut seen = HashSet::new();
    xs.into_iter().find(|x| !seen.insert(*x))
}

fn dupes<'a>(field: &str, xs: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
    match first_dupe(xs) {
        Some(d) => Err(format!("“{field}” lists “{d}” twice")),
        None => Ok(()),
    }
}

/// v2's `newer`: is `candidate` strictly later than `installed`? Pre-release tags are ignored.
fn newer(candidate: &str, installed: &str) -> bool {
    let parts = |v: &str| -> [u64; 3] {
        let mut out = [0; 3];
        let core = v.split('-').next().unwrap_or_default();
        for (slot, n) in out.iter_mut().zip(core.split('.')) {
            *slot = n.parse().unwrap_or(0);
        }
        out
    };
    parts(candidate) > parts(installed)
}

fn lower_alnum(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

/// `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`
fn is_id(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.split('-')
            .all(|part| !part.is_empty() && part.chars().all(lower_alnum))
}

/// `^[a-z][a-z0-9_]*$`
fn is_ident(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_lowercase()) && s.chars().all(|c| lower_alnum(c) || c == '_')
}

/// `^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$`
fn is_capability(s: &str) -> bool {
    let mut parts = s.split('.');
    let head = parts.next().unwrap_or_default();
    let rest: Vec<&str> = parts.collect();
    head.starts_with(|c: char| c.is_ascii_lowercase())
        && head.chars().all(lower_alnum)
        && !rest.is_empty()
        && rest.iter().all(|p| is_ident(p))
}

/// `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`
fn is_semver(s: &str) -> bool {
    let tag = |t: &str| {
        !t.is_empty()
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    };
    let (rest, build) = match s.split_once('+') {
        Some((r, b)) => (r, Some(b)),
        None => (s, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (rest, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    nums.len() == 3
        && nums
            .iter()
            .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(tag)
        && build.is_none_or(tag)
}

/// `^\d{4}-\d{2}-\d{2}$`
fn is_mcp_revision(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// `^([A-Za-z]:|[\\/])`
fn is_absolute(s: &str) -> bool {
    let b = s.as_bytes();
    matches!(b.first(), Some(b'/' | b'\\'))
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}
