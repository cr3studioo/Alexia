// SPDX-License-Identifier: AGPL-3.0-only
//! The host's side of the `alexia/*` layer (INTERFACES.md §3.4, wire-protocol.md §5): every
//! answer is scoped to the plugin that asked. No method takes another plugin's id, and no
//! answer says which plugin served a capability.

use serde_json::{json, Map, Value};

use crate::alexia::{AlexiaCall, AttachmentsCall, ComputeRunParams, HostInfo, HostPaths};
use crate::jsonrpc::{code, RpcError};
use crate::manifest::Manifest;
use crate::{CallCtx, CallError, McpHost, PluginId, ALEXIA_PROTOCOL_MAX, APP_VERSION};
use alexia_store::{DeleteScope, Select};

/// A setting's or kv value's JSON, at most.
const MAX_VALUE: usize = 65_536;
const CANNOT: &str = "Alexia could not read or write that.";

fn err(code: i32, message: impl Into<String>) -> RpcError {
    RpcError::new(code, message)
}

/// Never the SQLite text: that goes to the log, the plugin gets a sentence.
fn store_err(e: alexia_store::Error) -> RpcError {
    match e {
        alexia_store::Error::OutOfNamespace(s) => err(code::STORAGE_OUT_OF_NAMESPACE, s),
        alexia_store::Error::Invalid(s) => err(code::INVALID_PARAMS, s),
        other => {
            tracing::warn!(error = %other, "a plugin's storage request failed");
            err(code::INTERNAL_ERROR, CANNOT)
        }
    }
}

fn too_big(v: &Value) -> Result<(), RpcError> {
    if v.to_string().len() > MAX_VALUE {
        return Err(err(
            code::INVALID_PARAMS,
            format!("That value is larger than {MAX_VALUE} bytes of JSON."),
        ));
    }
    Ok(())
}

fn requires(m: &Manifest, cap: &str) -> bool {
    m.requires.iter().any(|r| r.cap == cap)
}

fn not_permitted(id: &PluginId, cap: &str) -> RpcError {
    err(
        code::CAPABILITY_NOT_PERMITTED,
        format!("{} did not ask for {cap} in requires[].", id.0),
    )
}

/// One request from plugin `id`, already parsed.
pub(crate) async fn serve(
    host: &McpHost,
    id: &PluginId,
    call: AlexiaCall,
    ctx: CallCtx,
) -> Result<Value, RpcError> {
    let Some(m) = host.manifest(id) else {
        return Err(err(code::INTERNAL_ERROR, "That plugin is not installed."));
    };
    let store = host.store();
    // The namespace rule: a plugin that declared no storage has no tables.
    let ns = || {
        m.storage
            .as_ref()
            .map(|s| s.namespace.as_str())
            .ok_or_else(|| {
                err(
                    code::STORAGE_OUT_OF_NAMESPACE,
                    format!("{} did not declare any storage.", id.0),
                )
            })
    };
    let kv = id.0.as_str();
    match call {
        AlexiaCall::SettingsGet(_) => Ok(json!({ "settings": settings(host, &m)? })),
        AlexiaCall::SettingsSet(p) => {
            let Some((_, kind, _)) = declared(&m).into_iter().find(|(k, _, _)| *k == p.key) else {
                return Err(err(
                    code::SETTING_UNKNOWN,
                    format!("{} did not declare a setting called \"{}\".", id.0, p.key),
                ));
            };
            // A `status` is the plugin's own report of itself; every other setting is the
            // owner's answer, which a plugin must not be able to undo.
            if kind != "status" {
                return Err(err(
                    code::INVALID_PARAMS,
                    format!(
                        "{} may only write its own status settings; \"{}\" is a {kind}.",
                        id.0, p.key
                    ),
                ));
            }
            too_big(&p.value)?;
            store.set_setting(kv, &p.key, &p.value).map_err(store_err)?;
            Ok(json!({}))
        }
        AlexiaCall::Insert(p) => {
            let rowid = store.insert(ns()?, &p.table, &p.row).map_err(store_err)?;
            Ok(json!({ "rowid": rowid }))
        }
        AlexiaCall::Select(p) => {
            let query = Select {
                filter: p.filter,
                order: p.order,
                limit: p.limit,
                offset: p.offset,
            };
            let rows = store.select(ns()?, &p.table, &query).map_err(store_err)?;
            Ok(json!({ "rows": rows }))
        }
        AlexiaCall::Update(p) => {
            let n = store
                .update(ns()?, &p.table, &p.set, &p.filter)
                .map_err(store_err)?;
            Ok(json!({ "changed": n }))
        }
        AlexiaCall::Delete(p) => {
            let ns = ns()?;
            let scope = match (&p.filter, p.all) {
                (Some(w), None | Some(false)) if !w.is_empty() => DeleteScope::Where(w),
                (None, Some(true)) => DeleteScope::All,
                _ => {
                    return Err(err(
                        code::INVALID_PARAMS,
                        "delete needs either a non-empty where or all: true, not both.",
                    ))
                }
            };
            let n = store.delete(ns, &p.table, scope).map_err(store_err)?;
            Ok(json!({ "deleted": n }))
        }
        AlexiaCall::Count(p) => {
            let n = store
                .count(ns()?, &p.table, p.filter.as_ref())
                .map_err(store_err)?;
            Ok(json!({ "count": n }))
        }
        AlexiaCall::KvGet(k) => Ok(match store.kv_get(kv, &k.key).map_err(store_err)? {
            Some(value) => json!({ "value": value }),
            None => json!({}),
        }),
        AlexiaCall::KvSet(p) => {
            too_big(&p.value)?;
            store.kv_set(kv, &p.key, &p.value).map_err(store_err)?;
            Ok(json!({}))
        }
        AlexiaCall::KvDelete(k) => {
            store.kv_delete(kv, &k.key).map_err(store_err)?;
            Ok(json!({}))
        }
        AlexiaCall::Raw(p) => {
            let rows = store.raw(ns()?, &p.sql, &p.params).map_err(store_err)?;
            Ok(json!({ "rows": rows }))
        }
        AlexiaCall::CapabilityCall(p) => {
            if !requires(&m, &p.cap) {
                return Err(not_permitted(id, &p.cap));
            }
            let args = p.arguments.unwrap_or_default();
            host.call_capability_as(Some(id), &p.cap, args, ctx)
                .await
                .map(|r| serde_json::to_value(r).expect("serializable"))
                .map_err(rpc_of)
        }
        // No `requires[]` check, as v2: asking whether something exists runs nothing.
        AlexiaCall::Answers(c) => {
            Ok(serde_json::to_value(host.answers(&c.cap)).expect("serializable"))
        }
        AlexiaCall::HostInfo(_) => host_info(host, &m),
        AlexiaCall::ComputeRun(p) => {
            let declared = m
                .compute
                .as_ref()
                .is_some_and(|c| c.operations.iter().any(|o| o.cap == p.cap));
            if !declared && !requires(&m, &p.cap) {
                return Err(not_permitted(id, &p.cap));
            }
            compute(host, id, p, ctx).await
        }
        AlexiaCall::AttachmentsLease(v) => attachments(host, id, &m, "lease", v).await,
        AlexiaCall::AttachmentsRelease(v) => attachments(host, id, &m, "release", v).await,
        AlexiaCall::AttachmentsLive(v) => attachments(host, id, &m, "live", v).await,
        AlexiaCall::AttachmentsRegister(v) => attachments(host, id, &m, "register", v).await,
        AlexiaCall::AttachmentsShare(v) => attachments(host, id, &m, "share", v).await,
    }
}

fn rpc_of(e: CallError) -> RpcError {
    match e {
        CallError::Rpc(e) => e,
        CallError::Off { sentence } => err(code::CAPABILITY_NOT_AVAILABLE, sentence),
        e => err(code::INTERNAL_ERROR, format!("{e}.")),
    }
}

/// `path` resolved (symlinks, `..`) and required to sit inside one of `roots`. A network
/// path is refused before any filesystem call: stat'ing `\\host\x` makes Windows talk SMB to
/// that host. The URI decoder is shared (`crate::file_uri_path`, the one core's gate uses), but
/// this containment check stays compute's own: it checks a plugin's own folder, not the owner's
/// scope, and core depends on this crate, not the other way round.
fn inside(path: &str, roots: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    // Windows folds `..` in the text without checking the folder exists, so a path through a
    // missing folder and back up would end the walk early and still reach a link. Refuse `..`.
    let up = p.components().any(|c| c == std::path::Component::ParentDir);
    if crate::is_network_path(path) || up || !links_stay_local(p, &mut 0) {
        return None;
    }
    // ponytail: a link created between the walk and the canonicalize is not covered; the
    // plugin cannot create links outside its own folder.
    let real = std::fs::canonicalize(path).ok()?;
    if remote(&real) {
        return None;
    }
    roots
        .iter()
        .filter(|r| !crate::is_network_path(&r.to_string_lossy()))
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| real.starts_with(r))
        .then_some(real)
}

/// Walks `path`'s prefixes the way `canonicalize` would, but reads each link's target first and
/// refuses one that is a network path, so no link makes compute talk SMB to another host.
fn links_stay_local(path: &std::path::Path, hops: &mut u32) -> bool {
    let mut cur = std::path::PathBuf::new();
    for c in path.components() {
        cur.push(c);
        let Ok(meta) = std::fs::symlink_metadata(&cur) else {
            // Missing: `canonicalize` fails on it without leaving this machine.
            return true;
        };
        // On Windows this is true for junctions too.
        if !meta.file_type().is_symlink() {
            continue;
        }
        *hops += 1;
        let Ok(target) = std::fs::read_link(&cur) else {
            return false;
        };
        if *hops > 40 || remote(&target) {
            return false;
        }
        let target = cur.parent().map_or(target.clone(), |p| p.join(&target));
        if !links_stay_local(&target, hops) {
            return false;
        }
        cur = target;
    }
    true
}

/// A network path, also in its `\\?\UNC\…` and `\??\UNC\…` forms. A verbatim path counts as
/// local only on a drive letter (`\\?\C:\…`).
fn remote(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy().replace('/', "\\");
    match s.strip_prefix(r"\\?\").or_else(|| s.strip_prefix(r"\??\")) {
        Some(rest) => {
            let b = rest.as_bytes();
            !(b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        }
        None => crate::is_network_path(&s),
    }
}

/// `dir/<name of from>`, or `name-2.ext`, `name-3.ext`... when that is already taken.
fn free_name(dir: &std::path::Path, from: &std::path::Path) -> std::path::PathBuf {
    let name = from.file_name().unwrap_or_default();
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = from.file_stem().unwrap_or_default().to_string_lossy();
    let ext = from
        .extension()
        .map_or(String::new(), |e| format!(".{}", e.to_string_lossy()));
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .expect("an unbounded range has a free name")
}

/// v2's local compute path: inputs must be the caller's own or uploads; the provider's tool
/// runs here; the files it names are copied into the caller's own folder.
async fn compute(
    host: &McpHost,
    id: &PluginId,
    p: ComputeRunParams,
    ctx: CallCtx,
) -> Result<Value, RpcError> {
    let layout = host.layout();
    let own = layout.own_dir(&id.0);
    let mut args = p.arguments.unwrap_or_default();
    if !p.inputs.is_empty() {
        let roots = [own.clone(), layout.uploads()];
        let mut inputs = vec![];
        for i in &p.inputs {
            let Some(real) = inside(&i.path, &roots) else {
                return Err(err(
                    code::INVALID_PARAMS,
                    format!(
                        "The input \"{}\" is not in this plugin's own folder or the uploads.",
                        i.name
                    ),
                ));
            };
            // The worker gets the path that was checked, never the raw one a link could swap.
            inputs.push(json!({ "name": i.name, "path": real, "mime": i.mime }));
        }
        args.insert("inputs".into(), Value::Array(inputs));
    }
    let (provider, result) = host.compute_call(&p.cap, args, ctx).await.map_err(rpc_of)?;
    let blocks = |kind: &str| {
        result
            .content
            .iter()
            .filter(move |b| b["type"] == kind)
            .collect::<Vec<_>>()
    };
    let text = blocks("text")
        .iter()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    if result.is_error == Some(true) {
        let first = text.lines().next().unwrap_or_default();
        let sentence = if first.is_empty() {
            "The compute worker reported a failure."
        } else {
            first
        };
        return Err(err(code::INTERNAL_ERROR, sentence));
    }
    let theirs = [layout.own_dir(&provider.0)];
    let dest = own.join("compute").join(format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    let mut files = vec![];
    for b in blocks("resource_link") {
        let from = b["uri"]
            .as_str()
            .and_then(crate::file_uri_path)
            .and_then(|f| inside(&f.to_string_lossy(), &theirs));
        let Some(from) = from else {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(err(
                code::INTERNAL_ERROR,
                "The compute worker named a file it does not own.",
            ));
        };
        let to = std::fs::create_dir_all(&dest)
            .map(|()| free_name(&dest, &from))
            .and_then(|to| std::fs::copy(&from, &to).map(|_| to));
        match to {
            Ok(to) => files.push(to.to_string_lossy().into_owned()),
            Err(e) => {
                tracing::warn!(plugin = %id.0, "a compute result could not be copied: {e}");
                let _ = std::fs::remove_dir_all(&dest);
                return Err(err(code::INTERNAL_ERROR, CANNOT));
            }
        }
    }
    let mut out = json!({ "files": files });
    if !text.is_empty() {
        out["text"] = Value::String(text);
    }
    Ok(out)
}

async fn attachments(
    host: &McpHost,
    id: &PluginId,
    m: &Manifest,
    op: &'static str,
    params: Value,
) -> Result<Value, RpcError> {
    if !requires(m, "attachments.scoped") {
        return Err(not_permitted(id, "attachments.scoped"));
    }
    host.upcalls()
        .attachments(id, AttachmentsCall { op, params })
        .await
}

/// `(key, type, default)` of every declared setting and panel widget: one namespace (D86).
fn declared(m: &Manifest) -> Vec<(&str, &str, Option<&Value>)> {
    let panel = m
        .panel
        .as_ref()
        .and_then(|p| p.get("widgets"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| {
            let key = w.get("key")?.as_str()?;
            let kind = w.get("type").and_then(Value::as_str).unwrap_or_default();
            Some((key, kind, w.get("default")))
        });
    m.settings
        .iter()
        .map(|s| (s.key.as_str(), s.kind.as_str(), s.default.as_ref()))
        .chain(panel)
        .collect()
}

/// Declared defaults with the owner's values on top; `password`s from the keychain, now.
fn settings(host: &McpHost, m: &Manifest) -> Result<Map<String, Value>, RpcError> {
    let stored = host.store().settings(&m.id).map_err(store_err)?;
    let mut out = Map::new();
    for (key, kind, default) in declared(m) {
        if kind == "password" {
            // Never from the database. No usable keychain is the same as unset, as v2.
            match alexia_store::secrets::get(&m.id, key) {
                Ok(Some(secret)) => {
                    out.insert(key.into(), Value::String(secret));
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(plugin = %m.id, "a password setting could not be read: {e}")
                }
            }
            continue;
        }
        // A stored null falls back to the default, as v2's `??`.
        if let Some(v) = stored.get(key).filter(|v| !v.is_null()).or(default) {
            out.insert(key.into(), v.clone());
        }
    }
    Ok(out)
}

/// Node's names, so a v2 plugin's `process.platform` checks keep working.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn host_info(host: &McpHost, m: &Manifest) -> Result<Value, RpcError> {
    let layout = host.layout();
    let made = |dir: std::path::PathBuf| {
        std::fs::create_dir_all(&dir)
            .map(|()| dir.to_string_lossy().into_owned())
            .map_err(|e| {
                tracing::warn!(plugin = %m.id, "a plugin folder could not be made: {e}");
                err(code::INTERNAL_ERROR, CANNOT)
            })
    };
    // Only if it asked: a plugin without `fs.own_dir` gets no path to build one from.
    let own_dir = if requires(m, "fs.own_dir") {
        Some(made(layout.own_dir(&m.id))?)
    } else {
        None
    };
    let facts = host.upcalls().host_facts();
    let info = HostInfo {
        platform: node_platform().into(),
        arch: node_arch().into(),
        alexia_version: APP_VERSION.into(),
        alexia_protocol: ALEXIA_PROTOCOL_MAX,
        display_name: facts.display_name,
        privacy_mode: facts.privacy_mode,
        paths: HostPaths {
            own_dir,
            cache_dir: made(layout.cache().join(&m.id))?,
        },
        locale: facts.locale,
    };
    Ok(serde_json::to_value(info).expect("serializable"))
}
