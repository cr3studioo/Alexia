// SPDX-License-Identifier: AGPL-3.0-only
//! The research viewer (INVENTORY E6–E7). A port of v2 `serve.ts` 3170–3197.
//!
//! A plugin is a research plugin when its manifest has a `research` widget (in `settings` or
//! the panel); the snapshot is the latest one it sent for the open chat (`McpTooling`,
//! P2D-03). The only files served are inside the plugin's own folder, really: `canonicalize`
//! before the comparison, because `..` and a link are the two ways a path that looks inside
//! points outside.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use alexia_mcp::manifest::Manifest;
use alexia_mcp::PluginId;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use serde_json::{json, Value};

use crate::gate::Sent;
use crate::json;
use crate::Api;

/// The widget type that makes a plugin's research visible.
const RESEARCH: &str = "research";

pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new()
        .route("/api/research", post(snapshot))
        .route("/api/research-file", get(research_file))
}

/// Whether the manifest shows a `research` widget anywhere.
fn shows_research(m: &Manifest) -> bool {
    let in_settings = m.settings.iter().any(|s| s.kind == RESEARCH);
    let in_panel = m
        .panel
        .as_ref()
        .and_then(|p| p.get("widgets"))
        .and_then(Value::as_array)
        .is_some_and(|w| {
            w.iter()
                .any(|w| w.get("type").and_then(Value::as_str) == Some(RESEARCH))
        });
    in_settings || in_panel
}

/// `POST /api/research {plugin}` → `{snapshot}`: the latest snapshot for the open chat, or
/// null when the plugin is not there or shows no research.
async fn snapshot(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let id = PluginId(
        sent.get("plugin")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    );
    let visible = api
        .parts
        .host
        .plugin_dir(&id)
        .is_some_and(|d| shows_research(&d.manifest));
    let snapshot = if visible {
        api.parts.tooling.research(&id, api.session())
    } else {
        None
    };
    let mut r = json::ok(json!({ "snapshot": snapshot }));
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

/// `GET /api/research-file?plugin=&run=&source=&kind=`: a source's preview (`.png`) or the
/// run's report (`.md`), from the latest run of the open chat. Anything else is an empty 404.
async fn research_file(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let get = |k: &str| q.get(k).map(String::as_str).unwrap_or_default();
    let id = PluginId(get("plugin").to_owned());
    let report = get("kind") == "report";
    if api.parts.host.plugin_dir(&id).is_none() {
        return not_found();
    }
    let Some(run) = api.parts.tooling.research(&id, api.session()) else {
        return not_found();
    };
    if run.get("runId").and_then(Value::as_str) != Some(get("run")) {
        return not_found();
    }
    let path = if report {
        run.pointer("/report/path").and_then(Value::as_str)
    } else {
        run.get("sources")
            .and_then(Value::as_array)
            .and_then(|all| {
                all.iter()
                    .find(|s| s.get("id").and_then(Value::as_str) == Some(get("source")))
            })
            .and_then(|s| s.get("preview"))
            .and_then(Value::as_str)
    };
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return not_found();
    };
    match inside(&api.parts.layout.own_dir(&id.0), path, report) {
        Some((real, bytes)) => served(&real, bytes, report),
        None => not_found(),
    }
}

/// v2's 404 carried no body; one with no type and a few words is the same to the window and
/// tells a registered route from a missing one (the gate's own check).
fn not_found() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        axum::body::Body::from("Not found."),
    )
        .into_response()
}

/// The file at `path` when it is, really, inside `own` and of the expected kind.
fn inside(own: &Path, path: &str, report: bool) -> Option<(std::path::PathBuf, Vec<u8>)> {
    // Stat'ing a network path makes Windows talk SMB to that host.
    if alexia_mcp::is_network_path(path) {
        return None;
    }
    let root = std::fs::canonicalize(own).ok()?;
    let real = std::fs::canonicalize(path).ok()?;
    if !real.starts_with(&root) || real == root || !real.is_file() {
        return None;
    }
    let ext = real
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if ext.as_deref() != Some(if report { "md" } else { "png" }) {
        return None;
    }
    let bytes = std::fs::read(&real).ok()?;
    Some((real, bytes))
}

fn served(real: &Path, bytes: Vec<u8>, report: bool) -> Response {
    let mut r = (
        [
            (
                header::CONTENT_TYPE,
                if report {
                    "text/markdown; charset=utf-8"
                } else {
                    "image/png"
                },
            ),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response();
    if report {
        let name: String = real
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if let Ok(v) = header::HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
            r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_own_files_of_the_right_kind() {
        let base =
            std::env::temp_dir().join(format!("alexia-research-unit-{}", std::process::id()));
        let own = base.join("own");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("a.png"), b"png").unwrap();
        std::fs::write(own.join("r.MD"), b"# r").unwrap();
        std::fs::write(base.join("out.png"), b"out").unwrap();
        let s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
        assert!(inside(&own, &s(own.join("a.png")), false).is_some());
        assert!(inside(&own, &s(own.join("r.MD")), true).is_some());
        // The wrong kind, outside, and outside by `..`.
        assert!(inside(&own, &s(own.join("a.png")), true).is_none());
        assert!(inside(&own, &s(base.join("out.png")), false).is_none());
        assert!(inside(&own, &s(own.join("..").join("out.png")), false).is_none());
        assert!(inside(&own, &s(own.clone()), false).is_none());
        assert!(inside(&own, r"\\host\share\a.png", false).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }
}
