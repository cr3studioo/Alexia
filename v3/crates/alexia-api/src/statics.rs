// SPDX-License-Identifier: AGPL-3.0-only
//! The static shell: `packages/ui` served as v2 serves it (serve.ts 272–298, 1859–1872).
//!
//! No token is needed for these. Text assets carry the token in place of the first
//! `__TOKEN__`; everything else goes out as bytes.

use std::path::{Path, PathBuf};

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

/// v2's `STATIC` table: path → (file under the UI folder, content type).
const STATIC: &[(&str, &str, &str)] = &[
    ("/", "index.html", "text/html; charset=utf-8"),
    ("/compute.html", "compute.html", "text/html; charset=utf-8"),
    ("/app.css", "app.css", "text/css; charset=utf-8"),
    (
        "/main.js",
        "dist/src/main.js",
        "text/javascript; charset=utf-8",
    ),
    ("/alexia.png", "alexia.png", "image/png"),
    ("/alexia-mark.svg", "alexia-mark.svg", "image/svg+xml"),
    ("/alexia-panel.svg", "alexia-panel.svg", "image/svg+xml"),
    ("/alexia-band.svg", "alexia-band.svg", "image/svg+xml"),
    ("/theme-light.webp", "theme-light.webp", "image/webp"),
    ("/theme-dark.webp", "theme-dark.webp", "image/webp"),
];

const MODULE_TYPE: &str = "text/javascript; charset=utf-8";

/// What `/` answers when the hub was not told where the window's files are.
pub(crate) const NO_UI: &str = "The window's files were not found. Set ALEXIA_UI_DIR.";

/// `^/([a-z][a-z0-9-]*)\.js$`: the module's name, or None. No dots, no slashes, so there is
/// nothing to climb out of `dist/src` with.
pub(crate) fn module(path: &str) -> Option<&str> {
    let name = path.strip_prefix('/')?.strip_suffix(".js")?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_lowercase() {
        return None;
    }
    chars
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        .then_some(name)
}

/// The file and content type a path names, before checking the file exists.
fn asset(path: &str) -> Option<(PathBuf, &'static str)> {
    if let Some((_, file, kind)) = STATIC.iter().find(|(p, _, _)| *p == path) {
        return Some((PathBuf::from(file), kind));
    }
    module(path).map(|name| {
        (
            Path::new("dist").join("src").join(format!("{name}.js")),
            MODULE_TYPE,
        )
    })
}

/// The answer for a static asset, or None to fall through to the API rules (a path not in
/// the table, or its file missing).
pub(crate) fn answer(ui: Option<&Path>, path: &str, token: &str) -> Option<Response> {
    let Some(ui) = ui else {
        return (path == "/").then(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CONTENT_TYPE, "text/plain")],
                NO_UI,
            )
                .into_response()
        });
    };
    let (file, kind) = asset(path)?;
    let full = ui.join(file);
    if !full.is_file() {
        return None;
    }
    let bytes = std::fs::read(&full).ok()?;
    let body = if kind.starts_with("text/") {
        String::from_utf8_lossy(&bytes)
            .replacen("__TOKEN__", token, 1)
            .into_bytes()
    } else {
        bytes
    };
    Some((StatusCode::OK, [(header::CONTENT_TYPE, kind)], body).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_pattern() {
        assert_eq!(module("/settings.js"), Some("settings"));
        assert_eq!(module("/a1-b.js"), Some("a1-b"));
        for bad in [
            "/../x.js", "/a.b.js", "/A.js", "/1a.js", "/.js", "//x.js", "/a/b.js", "/x.jsx",
        ] {
            assert_eq!(module(bad), None, "{bad}");
        }
    }

    #[test]
    fn no_ui_only_answers_root() {
        let r = answer(None, "/", "t").unwrap();
        assert_eq!(r.status(), 503);
        assert!(answer(None, "/app.css", "t").is_none());
    }
}
