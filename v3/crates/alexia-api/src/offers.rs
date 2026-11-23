// SPDX-License-Identifier: AGPL-3.0-only
//! Files a tool made, offered by id: download, Open, Show in folder (INVENTORY C6–C7).
//!
//! A port of v2 `offered.ts` and serve.ts 3231–3280. The window only ever names a file by the
//! id it was given in a `step` frame; the path Explorer is handed comes from that offer, never
//! from the request.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use alexia_core::Produced;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use serde_json::{json, Value};

use crate::gate::Sent;
use crate::json;
use crate::Api;

/// v2 `MOST`: the oldest offers are forgotten past this many.
const MOST: usize = 500;

/// v2's sentence for an id nothing offered.
const UNKNOWN: &str = "That file is not one anything offered here.";

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new().route("/api/file", get(download).post(act))
}

/// A file a tool made, as the window was told it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Offer {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub mime: String,
}

impl Offer {
    /// Whether Open may start this file. The name came from the plugin and may lie, and the
    /// path is what Explorer is actually handed, so both must be openable: an `evil.bat` named
    /// `invoice.pdf` is refused. (v2 checked the name alone; a missing extension stays openable
    /// there and here.)
    pub(crate) fn openable(&self) -> bool {
        let real = self
            .path
            .file_name()
            .map_or_else(|| self.path.to_string_lossy(), |n| n.to_string_lossy());
        openable(&self.name) && openable(&real)
    }
}

/// The files offered to the window, by id (v2 `Offers`). In memory only: a restart forgets
/// them, as v2's did.
#[derive(Default)]
pub(crate) struct Offers {
    inner: Mutex<Kept>,
}

#[derive(Default)]
struct Kept {
    by_id: HashMap<String, Offer>,
    /// Oldest first, for the `MOST` cut.
    order: VecDeque<String>,
}

impl Offers {
    fn kept(&self) -> MutexGuard<'_, Kept> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keeps `files` under fresh random ids and answers them as the `step` outcome's `files`:
    /// `{id, name, path, bytes, mime, openable}` each (v2 `offers.keep` plus `openable`).
    pub(crate) fn keep(&self, files: &[Produced]) -> Vec<Value> {
        let mut kept = self.kept();
        let mut out = Vec::with_capacity(files.len());
        for f in files {
            let id = crate::mint_token();
            let offer = Offer {
                id: id.clone(),
                name: f.name.clone(),
                path: f.path.clone(),
                bytes: f.bytes,
                mime: f.mime.clone(),
            };
            out.push(json!({
                "id": id,
                "name": offer.name,
                "path": offer.path.to_string_lossy(),
                "bytes": offer.bytes,
                "mime": offer.mime,
                "openable": offer.openable(),
            }));
            kept.order.push_back(id.clone());
            kept.by_id.insert(id, offer);
        }
        while kept.order.len() > MOST {
            if let Some(old) = kept.order.pop_front() {
                kept.by_id.remove(&old);
            }
        }
        out
    }

    /// The offer called `id`, if it is still kept.
    pub(crate) fn get(&self, id: &str) -> Option<Offer> {
        self.kept().by_id.get(id).cloned()
    }

    /// `POST /api/file {id, action}` once the id is read: `open` is refused for a file that runs
    /// when opened; anything else is Show in folder.
    pub(crate) fn act(&self, id: Option<&str>, action: Option<&str>) -> Response {
        let Some(wanted) = id.and_then(|id| self.get(id)) else {
            return json::said(404, UNKNOWN);
        };
        let how = if action == Some("open") {
            How::Open
        } else {
            How::Reveal
        };
        if how == How::Open && !wanted.openable() {
            return json::said(
                409,
                &format!(
                    "{} is the sort of file that runs when it is opened, so Alexia will not open it for you. Show in folder still works, and from there it is your decision.",
                    wanted.name
                ),
            );
        }
        reach(&wanted.path, how);
        json::ok(json!({ "ok": true }))
    }
}

/// `GET /api/file?id=`: the bytes, with v2's headers.
async fn download(
    State(api): State<Arc<Api>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(wanted) = q.get("id").and_then(|id| api.offers.get(id)) else {
        return json::said(404, UNKNOWN);
    };
    let bytes = match tokio::fs::read(&wanted.path).await {
        Ok(b) => b,
        // There when the tool offered it, not there now: a fact about the file, said on the row.
        Err(_) => {
            return json::said(
                410,
                &format!("{} is no longer where it was made.", wanted.name),
            )
        }
    };
    let kind = if wanted.mime == "application/octet-stream" {
        mime_of(&wanted.name).to_owned()
    } else {
        wanted.mime.clone()
    };
    (
        [
            (header::CONTENT_TYPE, kind),
            (header::CONTENT_LENGTH, bytes.len().to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"{}\"",
                    disposition_name(&wanted.name)
                ),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        bytes,
    )
        .into_response()
}

/// `POST /api/file`.
async fn act(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    api.offers.act(
        sent.get("id").and_then(Value::as_str),
        sent.get("action").and_then(Value::as_str),
    )
}

/// v2: `name.replace(/[^\w. -]/g, '_')`.
fn disposition_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ' ' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// v2 `offered.ts` `TYPES`.
fn mime_of(name: &str) -> &'static str {
    match extension(name).as_str() {
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

/// v2 `extname(name).slice(1).toLowerCase()`: the text after the last dot of the last
/// segment, empty for none or for a name that only starts with a dot.
fn extension(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match last.rfind('.') {
        Some(i) if i > 0 => last[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// v2 `EXECUTABLE`: files that run when they are opened.
const EXECUTABLE: &[&str] = &[
    "exe",
    "com",
    "scr",
    "pif",
    "msi",
    "msp",
    "msc",
    "cpl",
    "dll",
    "sys",
    "drv",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "vbs",
    "vbe",
    "wsf",
    "wsh",
    "js",
    "jse",
    "hta",
    "jar",
    "lnk",
    "url",
    "scf",
    "reg",
    "inf",
    "gadget",
    "appref-ms",
    "app",
    "command",
    "sh",
    "bash",
    "zsh",
    "run",
    "appimage",
    "deb",
    "rpm",
    "pkg",
    "dmg",
];

/// v2 `openable`: false for a file that runs when it is opened. Windows drops trailing
/// dots and spaces when it resolves a name (`evil.exe.` is `evil.exe`), and `evil.exe::$DATA`
/// or `C:evil.exe` name the program itself, so each `:` piece is checked after trimming.
pub(crate) fn openable(name: &str) -> bool {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    !std::iter::once(last)
        .chain(last.split(':'))
        .any(|piece| EXECUTABLE.contains(&extension(piece.trim_end_matches(['.', ' '])).as_str()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum How {
    Open,
    Reveal,
}

/// The program and arguments that open `path` or show it in its folder (v2 `reach`).
fn command_for(path: &Path, how: How) -> (&'static str, Vec<String>) {
    let p = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        match how {
            How::Reveal => ("explorer.exe", vec![format!("/select,{p}")]),
            How::Open => ("explorer.exe", vec![p]),
        }
    } else if cfg!(target_os = "macos") {
        match how {
            How::Reveal => ("open", vec!["-R".into(), p]),
            How::Open => ("open", vec![p]),
        }
    } else {
        let target = match how {
            How::Reveal => path
                .parent()
                .map_or(p.clone(), |d| d.to_string_lossy().into_owned()),
            How::Open => p,
        };
        ("xdg-open", vec![target])
    }
}

/// Opens or reveals `path`, detached, and does not wait. `explorer.exe` exits 1 on success, so
/// its exit code is never read; a failure to start is logged and is not the person's problem.
fn reach(path: &Path, how: How) {
    let (program, args) = command_for(path, how);
    spawn(program, &args);
}

#[cfg(not(test))]
fn spawn(program: &str, args: &[String]) {
    use std::process::{Command, Stdio};
    // No CREATE_NO_WINDOW: Explorer must show.
    match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // Reaped off the request, so a slow Explorer never holds the answer.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => tracing::warn!("file: could not start {program}: {e}"),
    }
}

/// The test build's seam: what would have been started, instead of starting it.
#[cfg(test)]
fn spawn(program: &str, args: &[String]) {
    spawned::record(program, args);
}

#[cfg(test)]
pub(crate) mod spawned {
    use std::sync::Mutex;

    static STARTED: Mutex<Vec<(String, Vec<String>)>> = Mutex::new(Vec::new());

    pub(crate) fn record(program: &str, args: &[String]) {
        STARTED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((program.to_owned(), args.to_vec()));
    }

    /// Everything started so far whose arguments mention `marker`.
    pub(crate) fn with(marker: &str) -> Vec<(String, Vec<String>)> {
        STARTED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, a)| a.iter().any(|x| x.contains(marker)))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn produced(name: &str, path: &Path) -> Produced {
        Produced {
            name: name.into(),
            path: path.to_path_buf(),
            bytes: 3,
            mime: "application/octet-stream".into(),
        }
    }

    #[test]
    fn keep_gives_fresh_ids_and_get_finds_them() {
        let offers = Offers::default();
        let a = offers.keep(&[
            produced("a.txt", Path::new("/x/a.txt")),
            produced("run.EXE", Path::new("/x/run.EXE")),
        ]);
        assert_eq!(a.len(), 2);
        let (ia, ib) = (a[0]["id"].as_str().unwrap(), a[1]["id"].as_str().unwrap());
        assert_ne!(ia, ib);
        assert_eq!(a[0]["openable"], json!(true));
        assert_eq!(a[1]["openable"], json!(false));
        assert_eq!(a[0]["name"], "a.txt");
        assert_eq!(a[0]["bytes"], 3);
        assert_eq!(offers.get(ia).unwrap().path, PathBuf::from("/x/a.txt"));
        assert!(offers.get("nope").is_none());
    }

    #[test]
    fn oldest_forgotten_past_most() {
        let offers = Offers::default();
        let first = offers.keep(&[produced("0.txt", Path::new("/0.txt"))]);
        for _ in 0..MOST {
            offers.keep(&[produced("n.txt", Path::new("/n.txt"))]);
        }
        assert!(offers.get(first[0]["id"].as_str().unwrap()).is_none());
        assert_eq!(offers.kept().by_id.len(), MOST);
    }

    #[test]
    fn openable_and_mime_follow_v2() {
        for bad in ["x.exe", "x.PS1", "dir/x.lnk", "x.appref-ms", "a.b.bat"] {
            assert!(!openable(bad), "{bad}");
        }
        for ok in ["x.pdf", "x", ".exe", "x.txt", "x.exe.txt"] {
            assert!(openable(ok), "{ok}");
        }
    }

    #[test]
    fn openable_sees_through_windows_name_tricks() {
        for bad in [
            "evil.exe.",
            "evil.exe ",
            "evil.exe. . ",
            "dir\\evil.BAT...",
            "evil.exe::$DATA",
            "C:evil.exe",
        ] {
            assert!(!openable(bad), "{bad:?}");
        }
        for ok in ["report.pdf.", "notes.txt ", "photo.png::$DATA"] {
            assert!(openable(ok), "{ok:?}");
        }
    }

    #[test]
    fn mime_and_disposition_follow_v2() {
        assert_eq!(mime_of("A.PNG"), "image/png");
        assert_eq!(mime_of("x.unknown"), "application/octet-stream");
        assert_eq!(disposition_name("a b/c\"d.é.txt"), "a b_c_d._.txt");
    }

    fn offered(offers: &Offers, name: &str, path: &str) -> (String, Value) {
        let v = offers.keep(&[produced(name, Path::new(path))]).remove(0);
        (v["id"].as_str().unwrap().to_owned(), v)
    }

    #[test]
    fn open_refused_when_path_runs_though_name_is_safe() {
        let offers = Offers::default();
        let (id, v) = offered(&offers, "invoice.pdf", "/made/evil-4d2.bat");
        assert_eq!(v["openable"], json!(false));
        let r = offers.act(Some(&id), Some("open"));
        assert_eq!(r.status(), 409);
        assert!(spawned::with("evil-4d2").is_empty());
        // Show in folder still works.
        assert_eq!(offers.act(Some(&id), Some("reveal")).status(), 200);
        assert_eq!(spawned::with("evil-4d2").len(), 1);
    }

    #[test]
    fn open_refused_when_name_runs_though_path_is_safe() {
        let offers = Offers::default();
        let (id, v) = offered(&offers, "setup.exe", "/made/notes-8b7.txt");
        assert_eq!(v["openable"], json!(false));
        assert_eq!(offers.act(Some(&id), Some("open")).status(), 409);
        assert!(spawned::with("notes-8b7").is_empty());
    }

    #[test]
    fn open_runs_when_name_and_path_are_safe() {
        let offers = Offers::default();
        let (id, v) = offered(&offers, "report.pdf", "/made/report-e51.pdf");
        assert_eq!(v["openable"], json!(true));
        assert_eq!(offers.act(Some(&id), Some("open")).status(), 200);
        let started = spawned::with("report-e51");
        assert_eq!(started.len(), 1);
        assert!(!started[0]
            .1
            .iter()
            .any(|a| a.contains("-R") || a.contains("/select")));
    }

    #[cfg(windows)]
    #[test]
    fn file_reveal_spawns_explorer() {
        let offers = Offers::default();
        let path = PathBuf::from(r"C:\made\reveal-me-7f3.txt");
        let id = offers.keep(&[produced("reveal-me-7f3.txt", &path)])[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let r = offers.act(Some(&id), Some("reveal"));
        assert_eq!(r.status(), 200);
        let r = offers.act(Some(&id), Some("open"));
        assert_eq!(r.status(), 200);
        let started = spawned::with("reveal-me-7f3");
        assert_eq!(
            started,
            vec![
                (
                    "explorer.exe".to_owned(),
                    vec![r"/select,C:\made\reveal-me-7f3.txt".to_owned()]
                ),
                (
                    "explorer.exe".to_owned(),
                    vec![r"C:\made\reveal-me-7f3.txt".to_owned()]
                ),
            ]
        );
    }

    #[test]
    fn open_refuses_what_runs_and_unknown_is_404() {
        let offers = Offers::default();
        let id = offers.keep(&[produced("setup-9c1.exe", Path::new("/made/setup-9c1.exe"))])[0]
            ["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(offers.act(Some(&id), Some("open")).status(), 409);
        assert!(spawned::with("setup-9c1").is_empty());
        assert_eq!(offers.act(Some("nope"), Some("reveal")).status(), 404);
        assert_eq!(offers.act(None, Some("reveal")).status(), 404);
    }
}
