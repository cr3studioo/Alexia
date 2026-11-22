// SPDX-License-Identifier: AGPL-3.0-only
//! The gate every request passes, in v2's order (serve.ts 1849–1914):
//!
//! 1. a static asset is answered without a token (`statics`);
//! 2. otherwise `x-alexia-token` must be the token and `Host` must start `127.0.0.1`, or
//!    `403 text/plain "not for you"`;
//! 3. a non-GET/HEAD body is parsed as JSON once, here (`400` when it is not JSON);
//! 4. `guard.ts` `refuse(path, method, body)`, ported exactly below, may refuse it;
//! 5. then the routes; no match is `404` with an empty body.
//!
//! The parsed body travels to the handlers as the `Sent` extension; the raw bytes are put
//! back so a handler may also read the body itself.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::{json as answer, statics, Api};

/// Request bodies above this are refused (v2 reads whatever arrives; the hub does not).
pub(crate) const BODY_LIMIT: usize = 64 * 1024 * 1024;

/// The request body as v2's guard and handlers see it: a JSON object; `{}` when the body was
/// empty or not an object.
#[derive(Clone, Debug, Default)]
#[allow(dead_code)] // read by the area handlers (P2D-04..P2D-11)
pub(crate) struct Sent(pub Map<String, Value>);

/// The middleware: statics, token and Host, body, guard; then the routes.
pub(crate) async fn gate(State(api): State<Arc<Api>>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if let Some(r) = statics::answer(api.parts.ui_dir.as_deref(), &path, api.token()) {
        return r;
    }

    let headers = request.headers();
    let token_ok = headers
        .get("x-alexia-token")
        .is_some_and(|v| same(v.as_bytes(), api.token().as_bytes()));
    let host_ok = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("127.0.0.1"));
    if !token_ok || !host_ok {
        return answer::text(403, "not for you");
    }

    let method = request.method().clone();
    let (mut parts, body) = request.into_parts();
    let mut sent = Map::new();
    let mut raw = axum::body::Bytes::new();
    if method != Method::GET && method != Method::HEAD {
        raw = match to_bytes(body, BODY_LIMIT).await {
            Ok(b) => b,
            Err(_) => return answer::said(413, "That request is too large."),
        };
        let text: &[u8] = if raw.is_empty() { b"{}" } else { &raw };
        match serde_json::from_slice::<Value>(text) {
            Ok(Value::Object(m)) => sent = m,
            Ok(_) => {}
            Err(_) => return answer::said(400, "That request body is not JSON."),
        }
    }

    if let Some(r) = refuse(&path, method.as_str(), &sent) {
        let mut body = json!({ "ok": false, "said": r.said });
        if r.confirmable {
            body["confirm"] = Value::Bool(true);
        }
        return answer::with(r.status, body);
    }

    parts.extensions.insert(Sent(sent));
    next.run(Request::from_parts(parts, Body::from(raw))).await
}

/// Equal without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---- guard.ts, ported ----

/// What a route is (guard.ts `Verdict`). The reasons are v2's written justification for each
/// entry; only a confirm's sentence is ever shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // `Read` and `Safe` keep their reason as v2's table does
pub(crate) enum Verdict {
    /// It changes nothing. Answered on a GET, refused on anything that means to change it.
    Read(&'static str),
    /// It changes something the same screen can change back. Runs unasked.
    Safe(&'static str),
    /// It can take something away. Refused unless the body carries `confirm: true`.
    Confirm(&'static str),
}

/// Which act a body asks for (guard.ts each route's `act`).
#[derive(Clone, Copy, Debug)]
pub(crate) enum Act {
    /// `action` when it is a string (guard.ts `byAction`, the default).
    ByAction,
    /// `/api/permissions`: `lift` when `lift === true`.
    Lift,
    /// `/api/library/install`: `update`, then `enable`.
    LibraryInstall,
    /// `/api/action`: none for a plugin's button; `core-safe` or `core` for core's own.
    CoreAction,
    /// `/api/adult`: `on` or `off`.
    Adult,
    /// `/api/editor`: a command's `type`, else `action`.
    Editor,
}

#[derive(Debug)]
pub(crate) struct Route {
    pub act: Act,
    /// The acts that differ from `otherwise`.
    pub acts: &'static [(&'static str, Verdict)],
    pub otherwise: Verdict,
}

/// guard.ts `REVERSIBLE_CORE`: core's own row actions that take nothing away.
const REVERSIBLE_CORE: &[&str] = &[
    "export_run",
    "use_model",
    "automatic",
    "set_spend",
    "set_order",
    "set_cross",
    "set_keyless",
    "set_speed",
    "new_chat",
    "open_chat",
    "open_run_chat",
];

fn string<'a>(body: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn is_true(body: &Map<String, Value>, key: &str) -> bool {
    body.get(key) == Some(&Value::Bool(true))
}

/// JavaScript's `String(value)` for the values a command's `type` can hold.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        // `String(["a", "b"])` is "a,b"; null and undefined items are empty.
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                v => js_string(Some(v)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

impl Act {
    fn of(self, body: &Map<String, Value>) -> Option<String> {
        match self {
            Act::ByAction => string(body, "action").map(str::to_owned),
            Act::Lift => is_true(body, "lift").then(|| "lift".into()),
            Act::LibraryInstall => {
                if is_true(body, "update") {
                    Some("update".into())
                } else if is_true(body, "enable") {
                    Some("enable".into())
                } else {
                    None
                }
            }
            Act::CoreAction => {
                let plugin = string(body, "plugin").unwrap_or("");
                if !plugin.is_empty() {
                    return None;
                }
                let key = string(body, "key").unwrap_or("");
                Some(
                    if REVERSIBLE_CORE.contains(&key) {
                        "core-safe"
                    } else {
                        "core"
                    }
                    .into(),
                )
            }
            Act::Adult => Some(
                if is_true(body, "enabled") || string(body, "action") == Some("on") {
                    "on"
                } else {
                    "off"
                }
                .into(),
            ),
            Act::Editor => match (string(body, "call"), body.get("command")) {
                (Some("command"), Some(Value::Object(c))) => Some(js_string(c.get("type"))),
                _ => string(body, "action").map(str::to_owned),
            },
        }
    }
}

/// guard.ts `verdictOf`: what a route is for this body, or None when core does not serve it.
pub(crate) fn verdict_of(path: &str, body: &Map<String, Value>) -> Option<Verdict> {
    let route = ROUTES
        .iter()
        .find(|(p, _)| *p == path)
        .or_else(|| {
            local_model_id(path)
                .then(|| {
                    ROUTES
                        .iter()
                        .find(|(p, _)| *p == "/api/local-models/remove")
                })
                .flatten()
        })
        .map(|(_, r)| r)?;
    let act = route.act.of(body);
    Some(
        act.and_then(|a| route.acts.iter().find(|(k, _)| *k == a).map(|(_, v)| *v))
            .unwrap_or(route.otherwise),
    )
}

/// `^/api/local-models/[^/]+$`.
fn local_model_id(path: &str) -> bool {
    path.strip_prefix("/api/local-models/")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// guard.ts `Refusal`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Refusal {
    /// 404 core does not serve this; 405 it only reads; 409 it needs a confirm it did not get.
    pub status: u16,
    pub said: String,
    /// Sending the same request again with `confirm: true` would run it.
    pub confirmable: bool,
}

/// guard.ts `refuse`, run before any handler sees the request.
pub(crate) fn refuse(path: &str, method: &str, body: &Map<String, Value>) -> Option<Refusal> {
    if method == "GET" || method == "HEAD" {
        return None;
    }
    match verdict_of(path, body) {
        None => Some(Refusal {
            status: 404,
            said: format!("There is nothing at {path}."),
            confirmable: false,
        }),
        Some(Verdict::Read(_)) => Some(Refusal {
            status: 405,
            said: format!(
                "{path} only reads. Nothing about it changes anything, so it does not answer a request that means to."
            ),
            confirmable: false,
        }),
        Some(Verdict::Confirm(what)) if !is_true(body, "confirm") => Some(Refusal {
            status: 409,
            said: format!("{what} Nothing has happened yet."),
            confirmable: true,
        }),
        Some(_) => None,
    }
}

/// guard.ts `ROUTES`: every path core answers, in the order serve.ts matches them. The
/// sentences are v2's, copied byte for byte.
#[rustfmt::skip]
pub(crate) const ROUTES: &[(&str, Route)] = &[
    (
        "/api/research",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The viewer reads the latest research snapshot for the current conversation. Repeated requests do not start, cancel or change provider work."),
        },
    ),
    (
        "/api/research-file",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The viewer downloads only the current conversation’s referenced preview or report, checked against the provider’s own directory and immutable run identifier."),
        },
    ),
    (
        "/api/state",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Everything the shell draws itself from — the conversation, the pins, the spend, and the current value of every control that changes them. It reads the store and writes nothing."),
        },
    ),
    (
        "/api/local-models",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The machine facts, model recommendations and installed model registry are read without starting a runner or downloading files."),
        },
    ),
    (
        "/api/local-models/search",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Hugging Face search reads model metadata from the Hub; no weights or executable code are downloaded and nothing is installed."),
        },
    ),
    (
        "/api/local-models/repo",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("A repository preview reads pinned file hashes, sizes and licence metadata so the user can judge an install before starting it."),
        },
    ),
    (
        "/api/local-models/progress",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Installation progress is a read of the running job in memory; polling neither starts another download nor changes the chosen model."),
        },
    ),
    (
        "/api/local-models/context",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The context size, cache precision and optional compatible draft are local runtime preferences. They take effect on the next model start and can be changed again here."),
        },
    ),
    (
        "/api/local-models/maintenance",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Update and cleanup suggestions inspect installed model metadata. Nothing is installed or removed until the user chooses an action."),
        },
    ),
    (
        "/api/local-models/import-preview",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The selected local GGUF header is parsed to show its name, size and context. No files are copied or changed."),
        },
    ),
    (
        "/api/local-models/import",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The user selected a local GGUF and whether Alexia should copy or reference it. Import verifies the source and runs a short local check before making it selectable."),
        },
    ),
    (
        "/api/local-models/benchmark",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("A short local response measures the selected model. It does not change the pin or send the prompt to a hosted provider."),
        },
    ),
    (
        "/api/local-models/install",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The user chooses model weights and their licence on this screen; downloading and choosing them is reversible through Remove and Use, and the prior pin survives a failed install."),
        },
    ),
    (
        "/api/local-models/cancel",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Cancelling aborts the running installation and retains resumable partial files; a later Install continues it and the existing chosen model is preserved."),
        },
    ),
    (
        "/api/local-models/use",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Choosing an installed local model and an explicit run mode sets preferences shown on this screen, both changeable back without deleting data."),
        },
    ),
    (
        "/api/local-models/remove",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Removing deletes only verified downloadable weights managed by Alexia; conversations and user documents are untouched and Install restores the model."),
        },
    ),
    (
        "/api/local-models/token",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The token just entered is stored only in the operating system keychain; this same screen can replace or remove it without exposing its value."),
        },
    ),
    (
        "/api/compute/role",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Confirm("This switches this computer’s role between the one you talk to and one that only computes. Running work is finished or cancelled first, Alexia’s services and workers are stopped, and Alexia restarts in the new role. Existing chats are kept."),
        },
    ),
    (
        "/api/compute/role/cancel",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("It stops a role switch that is still waiting for running work. Nothing has been stopped at that point, so the computer simply keeps the role it has, and the switch can be asked for again."),
        },
    ),
    (
        "/api/compute/hosts",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The paired computers, how each is reached and what each last said about itself. It reads the pairing records and opens a session to ask; it changes nothing on either computer."),
        },
    ),
    (
        "/api/compute/tailscale",
        Route {
            act: Act::ByAction,
            acts: &[
                ("install", Verdict::Confirm("This downloads Tailscale from Tailscale’s own website and opens its installer, which asks for your permission. Tailscale is a separate program that lets your computers reach each other when they are not on the same network; it can be uninstalled like any other app.")),
            ],
            otherwise: Verdict::Safe("It switches Tailscale on or opens its sign-in page in your browser. You sign in there yourself; Alexia never sees your password."),
        },
    ),
    (
        "/api/compute/discover",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Looks for your other computer waiting to pair, on Tailscale and on this network. It only asks; nothing is paired or changed."),
        },
    ),
    (
        "/api/compute/pair/start",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Pairing only records another computer’s public identity after both sides proved it, and Unpair undoes it. The code is single-use, expires in five minutes and is never logged."),
        },
    ),
    (
        "/api/compute/pair",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Where the open pairing stands, and the code for the page that is showing it. Reading it neither extends the code nor starts a pairing."),
        },
    ),
    (
        "/api/compute/pair/cancel",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Cancelling a pairing that has not finished kills its code and records nothing. A fresh code starts again, so nothing is lost by stopping."),
        },
    ),
    (
        "/api/compute/unpair",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Confirm("This forgets the paired computer. Its running jobs are cancelled, its connection is closed at once, and its models are no longer offered here. Pairing again needs a fresh code."),
        },
    ),
    (
        "/api/compute/inventory",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("What a computer says it has: its hardware, models, capabilities and what is missing. It is the last inventory that computer built, read without probing or installing anything."),
        },
    ),
    (
        "/api/compute/status",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("How a paired computer is reached right now — direct, relayed or offline — and why it cannot serve when it cannot. Nothing is connected or changed by asking."),
        },
    ),
    (
        "/api/compute/select",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("It only changes which computer’s models the picker shows. No model is chosen, loaded or downloaded by it, and picking another computer changes it back."),
        },
    ),
    (
        "/api/compute/setup/install",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("One missing requirement is installed on the computer named, from a button whose label showed the download’s size. It adds files there and nothing is removed; Remove undoes a model."),
        },
    ),
    (
        "/api/compute/queue",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The running job and the jobs waiting behind it on one computer, in order. It is a read of the queue as that computer last described it."),
        },
    ),
    (
        "/api/compute/job",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("One job’s state by its id — queued, running, finished, failed or interrupted, with its progress. Asking never starts, repeats or cancels the job."),
        },
    ),
    (
        "/api/compute/jobs",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The jobs this run of Alexia heard about on one computer, finished and interrupted ones included. It is held in memory and reading it changes nothing."),
        },
    ),
    (
        "/api/compute/jobs/cancel",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Cancelling one job is what the Cancel button beside it says. A queued job leaves the queue and a running one is stopped; nothing else is touched, and the job can be started again."),
        },
    ),
    (
        "/api/compute/pause",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Pausing a compute host makes its jobs wait in the queue and starts none; nothing running is stopped, and Resume on the same control undoes it."),
        },
    ),
    (
        "/api/compute/services",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The relay and mailbox addresses are two settings shown on this screen, used the next time the connection service starts. Clearing them restores the built-in defaults."),
        },
    ),
    (
        "/api/compute/window/close",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("It lets the compute host’s window go while the host keeps working from the tray. Open window in the tray menu brings it back, and no job is affected."),
        },
    ),
    (
        "/api/setup",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The first-run answers plus the theme and where the pages sit, each written by the screen that shows it and each writable again. The only thing it can replace is a provider key, and only with one somebody has just typed into the box beside it."),
        },
    ),
    (
        "/api/local-stats",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The models on this machine and the ones in memory, read from Ollama’s own listing, and how busy, full and warm the machine is, read from the operating system’s own counters. It loads nothing, downloads nothing and writes nothing, and when Ollama is not there it says so rather than failing."),
        },
    ),
    (
        "/api/command",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Two kinds of command, both typed by name. Core's own set a mode or a pin — one word to change back, with the current value shown beside the control. A plugin's is a call to that plugin's tool, and it goes through the same permission ruling the loop and the action buttons use, which is where a destructive one is stopped."),
        },
    ),
    (
        "/api/permissions",
        Route {
            act: Act::Lift,
            acts: &[
                ("lift", Verdict::Confirm("Lifting drops every boundary you have spoken aloud, all of them at once, and nothing keeps a copy. The sentences that made them are in the conversation, not in a store this can put them back from.")),
            ],
            otherwise: Verdict::Safe("A mode, a list of folders and a switch. All three are shown on the screen that writes them and all three can be set back — and widening one is what the picker is for, not something core does on its own."),
        },
    ),
    (
        "/api/ceilings",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Three numbers, each with a control beside its current value and each changeable back. Raising one spends nothing by itself; the preview and the cap are what stand between a number and money (M15-7)."),
        },
    ),
    (
        "/api/stop",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("It aborts a running task and settles an open permission question as a no. Nothing is deleted — the half-finished answer stays in the history — and starting again costs a sentence."),
        },
    ),
    (
        "/api/approve",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("This is a confirmation arriving, not an act that needs one. It carries an answer to a question the loop is already blocked on, and a gate in front of the consent primitive would be a question about a question."),
        },
    ),
    (
        "/api/plugins",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("Every installed plugin, its settings pane, the folders that are not plugins, and the skills. It spawns nothing: with lazy spawn *not running* is the ordinary state, and a screen that woke three processes to draw itself would wake them every time anybody looked."),
        },
    ),
    (
        "/api/panels",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The control surface’s tab list: core’s own tabs, and only those — a plugin’s panel is the second half of its page on /api/plugins. Read from the store, and it spawns nothing."),
        },
    ),
    (
        "/api/search",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("The command palette, over the same reads the panels use — no second index, and a plugin’s panel contributes its name rather than its contents, because reaching inside one would mean spawning it on every keystroke. It finds; it never runs anything."),
        },
    ),
    (
        "/api/plugin",
        Route {
            act: Act::ByAction,
            acts: &[
                ("enable", Verdict::Safe("The plugin starts. It is the moment of consent and the screen has just shown, in the author’s own words, what it asked for — and disable is one press away.")),
                ("disable", Verdict::Safe("The process stops and everything it owns stays: its folder, its settings, its stored data, its keychain entries. It is the cheap opposite of enable, which is why the screen offers it first.")),
                ("restart", Verdict::Safe("A plugin the supervisor switched off after stopping too often is allowed to start again. It clears a tally and nothing else — nothing is deleted, nothing new is consented to, and if it keeps stopping the supervisor switches it off again.")),
            ],
            otherwise: Verdict::Confirm("Deleting takes the plugin’s folder, its settings, everything it stored and its keychain entries with it — that is what invariant 5 checks — and only a fresh download brings any of it back."),
        },
    ),
    (
        "/api/install",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("It copies a folder in and enables nothing, because a folder appearing is not consent (D73). An id that is already installed is refused rather than overwritten, so nothing here replaces anything."),
        },
    ),
    (
        "/api/library",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("What the registry lists, what is already here, and what has been withdrawn. It reaches the network and writes nothing; when the registry is unreachable it says so rather than answering an empty list."),
        },
    ),
    (
        "/api/library/progress",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("How many bytes of a download from the shelf have arrived. A number kept in memory while the install is under way; reading it changes nothing."),
        },
    ),
    (
        "/api/library/install",
        Route {
            act: Act::LibraryInstall,
            acts: &[
                ("update", Verdict::Confirm("An update stops the running plugin and replaces its folder with a different version. The version being replaced is not kept, and the thing being overwritten is a plugin that was working a minute ago.")),
                ("enable", Verdict::Safe("The download starts running once it lands. Only first run asks for this, and only having shown the plugin’s own `requires` sentences beside the tick that agreed to them (D118) — which is the same consent the Plugins page takes, in the one place a person is choosing several at once. Disable is one press away.")),
            ],
            otherwise: Verdict::Safe("A download, a checksum, and a folder that arrives installed and not enabled. Nothing already here is touched, and deleting it again is one press away."),
        },
    ),
    (
        "/api/server",
        Route {
            act: Act::ByAction,
            acts: &[
                ("trust", Verdict::Confirm("Trusting an MCP server stops core treating its tools as things that change something — every tool it has now and every tool it grows later, in every mode. It is a decision with a person behind it, which is the only shape that answer should ever take.")),
            ],
            otherwise: Verdict::Safe("Adding probes the server before writing anything, so a mistyped command fails with the operating system’s own words. It arrives unreviewed, which means every tool it offers is asked about until somebody says otherwise."),
        },
    ),
    (
        "/api/learn",
        Route {
            act: Act::ByAction,
            acts: &[
                ("forget", Verdict::Confirm("It deletes the skill’s folder from disk. A learned skill was distilled from a task that has long since scrolled away, so nothing regenerates it.")),
                ("edit", Verdict::Safe("Only a skill Alexia wrote is editable here — one somebody installed belongs to whoever wrote it — and the text being replaced is the text sitting in the box that submits it, which can be typed back.")),
            ],
            otherwise: Verdict::Safe("Distilling the last task into a skill writes a new folder and removes nothing. It costs a model call under the same ceilings as everything else, and forget is the way back."),
        },
    ),
    (
        "/api/settings",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("One declared setting, validated against the schema its plugin published, written where the same pane can write it again. A secret goes to the keychain rather than the database, and replacing one is what typing in the box means."),
        },
    ),
    (
        "/api/upload",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The bytes behind a declared `file` widget, written inside the asking plugin’s own folder under the same ceilings an attachment gets, replacing whatever that widget held before. The person is choosing the file in their own picker, so a confirm would be asking them to agree to the thing they have just done — and it puts nothing anywhere they could not reach."),
        },
    ),
    (
        "/api/rows",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("A table asking for its contents. It calls the tool the author named, under the same permission ruling every tool call gets — a lister that has not declared itself read-only is asked about, in every mode but Full trust. Nothing core owns changes."),
        },
    ),
    (
        "/api/plugin-file",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("The bytes of a picture an `image` widget is showing. It reads and nothing else — and it will only read inside the asking plugin’s **own** folder, resolved through the real path first so that a `..` or a symlink pointing outside is refused rather than followed. A plugin naming a file it does not own gets a 403 and the widget draws a gap."),
        },
    ),
    (
        "/api/detail",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("What expands under one row of a table: the same call as the list above, about one thing rather than all of them, through the same ruling."),
        },
    ),
    (
        "/api/action",
        Route {
            act: Act::CoreAction,
            acts: &[
                ("core", Verdict::Confirm("A row action on one of core’s own lists — forgetting a skill, which deletes a folder. There is no plugin and so no tool call, which means the permission ruling that guards the other kind has nothing to rule on.")),
                ("core-safe", Verdict::Safe("One of core’s own row actions that takes nothing away — exporting a run to a file, which adds one and changes nothing that was already there. The list is short on purpose, and anything not on it is guarded.")),
            ],
            otherwise: Verdict::Safe("A press on a plugin’s button or a row action on its table. Both go through the same permission ruling a tool call gets: a destructive tool is asked about in every mode but Full trust, and the never-touch list is not negotiable in any of them (M15-3). A confirm here would be the same question twice."),
        },
    ),
    (
        "/api/not-her",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Marking one answer as out of character. Nothing is deleted, nothing is re-asked, and the answer stays on the page exactly as it was — what it changes is a note a personality plugin keeps about itself, which that plugin then shows you before it acts on it. A confirm here would be a confirm on saying *that did not sound right*."),
        },
    ),
    (
        "/api/adult",
        Route {
            act: Act::Adult,
            acts: &[
                ("on", Verdict::Confirm("Turning adult content on records that you are 18 or older and lets /nsfw switch on uncensored models and adult picture edits. It is off again with one press.")),
            ],
            otherwise: Verdict::Safe("Turning adult content off. Nothing is deleted, and /nsfw stops working until it is turned on again."),
        },
    ),
    (
        "/api/editor",
        Route {
            act: Act::Editor,
            acts: &[
                ("remove_version", Verdict::Confirm("Removing a version takes it out of the editor’s history. The original and the other versions stay, but this one is not offered again.")),
            ],
            otherwise: Verdict::Safe("The image editor’s own screen: opening a picture, saving a draft, asking for versions, comparing and exporting. Every generation goes through the same checks a request in chat does, and the original picture is never changed."),
        },
    ),
    (
        "/api/editor/upload",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Adding a picture to this conversation for the editor — kept with the conversation and deleted with it. Nothing already there is changed."),
        },
    ),
    (
        "/api/editor/forget",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Confirm("Forgetting the pictures in this conversation deletes them, every version made from them and every copy in its messages, and stops anything still being made from them. It cannot be undone."),
        },
    ),
    (
        "/api/editor/file",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("A file the image editor made for this conversation, by the token it was shared under. No path is in the request."),
        },
    ),
    (
        "/api/editor/picture",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Read("One of this conversation’s own pictures, by its id. Another conversation’s pictures are not found here."),
        },
    ),
    (
        "/api/chat",
        Route {
            act: Act::ByAction,
            acts: &[
            ],
            otherwise: Verdict::Safe("Sending a sentence is the product. Everything it can then do goes through the permission gate, the never-touch list and the ceilings, and the preview asks before an expensive task starts — a confirm on the message box would be a confirm on typing."),
        },
    ),
    (
        "/api/file",
        Route {
            act: Act::ByAction,
            acts: &[
                ("reveal", Verdict::Safe("It opens a file manager with the file selected. Nothing runs, nothing changes, and the window it opens is one the person closes — this is the answer for everything Open refuses, so a refusal is never a dead end.")),
                ("open", Verdict::Confirm("Opening hands the file to whatever this machine has registered for it, which for some kinds means running it. The file has to be one a tool offered during this session and its extension has to be one that is not a program — but the press itself is the last thing standing between a plugin writing a file and this machine executing it.")),
            ],
            otherwise: Verdict::Read("The bytes of a file some tool made, by the id it was offered under. It reads one file off the disk and sends it; there is no path in the request, so there is nothing to point somewhere else. A POST with no act nobody has classified lands here and is refused, which is the right way round."),
        },
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn body(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    #[test]
    fn reads_pass_on_get_and_refuse_writes() {
        assert_eq!(refuse("/api/state", "GET", &Map::new()), None);
        let r = refuse("/api/state", "POST", &Map::new()).unwrap();
        assert_eq!(r.status, 405);
        assert_eq!(
            r.said,
            "/api/state only reads. Nothing about it changes anything, so it does not answer a request that means to."
        );
        assert!(!r.confirmable);
    }

    #[test]
    fn unknown_path_is_refused() {
        let r = refuse("/api/nope", "POST", &Map::new()).unwrap();
        assert_eq!(
            (r.status, r.said.as_str()),
            (404, "There is nothing at /api/nope.")
        );
    }

    #[test]
    fn confirm_routes_need_confirm() {
        let r = refuse("/api/plugin", "POST", &body(json!({"action": "delete"}))).unwrap();
        assert_eq!(r.status, 409);
        assert!(r.confirmable);
        assert!(r.said.ends_with(" Nothing has happened yet."));
        assert!(r.said.starts_with("Deleting takes the plugin’s folder"));
        assert_eq!(
            refuse(
                "/api/plugin",
                "POST",
                &body(json!({"action": "delete", "confirm": true}))
            ),
            None
        );
        assert_eq!(
            refuse("/api/plugin", "POST", &body(json!({"action": "enable"}))),
            None
        );
        // `confirm` must be the boolean true, not just truthy.
        assert!(refuse(
            "/api/plugin",
            "POST",
            &body(json!({"action": "delete", "confirm": "yes"}))
        )
        .is_some());
    }

    #[test]
    fn per_route_acts() {
        assert!(refuse("/api/permissions", "POST", &body(json!({"lift": true}))).is_some());
        assert_eq!(
            refuse(
                "/api/permissions",
                "POST",
                &body(json!({"mode": "ask_risky"}))
            ),
            None
        );
        assert!(refuse(
            "/api/library/install",
            "POST",
            &body(json!({"update": true}))
        )
        .is_some());
        assert_eq!(
            refuse(
                "/api/library/install",
                "POST",
                &body(json!({"enable": true}))
            ),
            None
        );
        assert_eq!(
            refuse(
                "/api/action",
                "POST",
                &body(json!({"plugin": "x", "key": "y"}))
            ),
            None
        );
        assert_eq!(
            refuse(
                "/api/action",
                "POST",
                &body(json!({"plugin": "", "key": "new_chat"}))
            ),
            None
        );
        assert!(refuse("/api/action", "POST", &body(json!({"key": "forget_chat"}))).is_some());
        assert!(refuse("/api/adult", "POST", &body(json!({"enabled": true}))).is_some());
        assert!(refuse("/api/adult", "POST", &body(json!({"action": "on"}))).is_some());
        assert_eq!(
            refuse("/api/adult", "POST", &body(json!({"enabled": false}))),
            None
        );
        let cmd = json!({"call": "command", "command": {"type": "remove_version"}});
        assert!(refuse("/api/editor", "POST", &body(cmd)).is_some());
        assert!(refuse(
            "/api/editor",
            "POST",
            &body(json!({"action": "remove_version"}))
        )
        .is_some());
        assert_eq!(
            refuse("/api/editor", "POST", &body(json!({"call": "open"}))),
            None
        );
        // JavaScript's `String(["remove_version"])` is "remove_version", so it is still guarded.
        let cmd = json!({"call": "command", "command": {"type": ["remove_version"]}});
        assert!(refuse("/api/editor", "POST", &body(cmd)).is_some());
        assert_eq!(
            refuse("/api/file", "POST", &body(json!({"action": "reveal"}))).map(|r| r.status),
            None
        );
        assert_eq!(
            refuse("/api/file", "POST", &Map::new()).map(|r| r.status),
            Some(405)
        );
        assert!(refuse(
            "/api/compute/tailscale",
            "POST",
            &body(json!({"action": "install"}))
        )
        .is_some());
        assert_eq!(
            refuse(
                "/api/compute/tailscale",
                "POST",
                &body(json!({"action": "on"}))
            ),
            None
        );
        assert!(refuse("/api/server", "POST", &body(json!({"action": "trust"}))).is_some());
        assert!(refuse("/api/learn", "POST", &body(json!({"action": "forget"}))).is_some());
    }

    #[test]
    fn local_model_fallback() {
        assert_eq!(refuse("/api/local-models/abc", "DELETE", &Map::new()), None);
        assert_eq!(
            refuse("/api/local-models/a/b", "DELETE", &Map::new()).map(|r| r.status),
            Some(404)
        );
        assert_eq!(
            refuse("/api/local-models/", "DELETE", &Map::new()).map(|r| r.status),
            Some(404)
        );
    }

    #[test]
    fn table_is_v2s() {
        assert_eq!(ROUTES.len(), 69);
        let mut paths: Vec<_> = ROUTES.iter().map(|(p, _)| *p).collect();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), 69, "a path is listed twice");
    }
}
