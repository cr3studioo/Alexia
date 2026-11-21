// SPDX-License-Identifier: AGPL-3.0-only
//! Slash commands, built-in and from plugins' manifests (SP-01, AC-10, AC-11, AC-12, MO-10,
//! MO-12). A port of v2 `packages/core/src/commands.ts` (`commands`, `run`, `standing`,
//! `/providers`): a message starting with `/` is answered by core, never by a model.
//!
//! The three v2 axes (`/local` and friends) and the adult/cheap/best pins have no meaning on
//! a free-only hub (TR-10 is V3-4), so they answer with one honest sentence.

use std::time::Instant;

use alexia_mcp::{Manifest, PluginId, PluginState};
use alexia_store::{now_ms, Content, Ms, Role};
use chrono::{Datelike, Local};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::bus::Event;
use crate::{
    compare, permissions, tools, trace, undo, BrainError, ChatRequest, Lane, Origin,
    PermissionMode, ProviderError, Question, Reply, RunId, Span, ToolCtx, Turn,
};

pub struct CommandInfo {
    pub name: String,
    pub summary: String,
    pub alias: Option<String>,
    pub plugin: Option<PluginId>,
    pub shadowed: bool,
}

const NOT_YET: &str = "That setting is not in v3 yet.";

/// v2 `BUILT_IN`. Reserved: a plugin cannot take one of these names.
const BUILT_IN: &[(&str, &str)] = &[
    (
        "new",
        "Start a new conversation. Nothing said before it comes with it.",
    ),
    ("help", "List everything you can type here."),
    (
        "status",
        "Where things stand: the permission mode, what is running and what has been spent this month.",
    ),
    (
        "providers",
        "Check every provider: which answer right now.",
    ),
    ("approvals", "List what is waiting for your yes or no."),
    ("approve", "Say yes to a waiting question: /approve <id>."),
    ("deny", "Say no to a waiting question: /deny <id>."),
    ("undo", "Undo the last thing I did in this conversation."),
    (
        "activity",
        "What I did, newest first. Add words to search it: /activity <text>.",
    ),
    (
        "compare",
        "Ask two models the same question and keep one answer: /compare <question>.",
    ),
    ("models", "Which models are pinned for which job."),
    ("local", NOT_YET),
    ("combined", NOT_YET),
    ("cloud", NOT_YET),
    ("nsfw", NOT_YET),
    ("sfw", NOT_YET),
    ("cheap", NOT_YET),
    ("best", NOT_YET),
];

/// v2 `commands()`. `manifests` is in install order: first installed wins the bare word, and
/// the namespaced form (`<plugin>.<name>`) of every command always works, so resolving a
/// collision never breaks one that was already working.
pub fn list(manifests: &[Manifest]) -> Vec<CommandInfo> {
    let mut taken: Vec<String> = BUILT_IN.iter().map(|(n, _)| (*n).to_owned()).collect();
    let mut all: Vec<CommandInfo> = BUILT_IN
        .iter()
        .map(|(name, summary)| CommandInfo {
            name: (*name).into(),
            summary: (*summary).into(),
            alias: None,
            plugin: None,
            shadowed: false,
        })
        .collect();
    for m in manifests {
        for c in &m.commands {
            let alias = format!("{}.{}", m.id, c.name);
            let shadowed = taken.contains(&c.name);
            if !shadowed {
                taken.push(c.name.clone());
            }
            all.push(CommandInfo {
                name: if shadowed {
                    alias.clone()
                } else {
                    c.name.clone()
                },
                summary: c.summary.clone(),
                alias: Some(alias),
                plugin: Some(PluginId(m.id.clone())),
                shadowed,
            });
        }
    }
    all
}

fn other(e: impl Into<crate::Error>) -> BrainError {
    BrainError::Other(e.into())
}

/// Who answered, as stored on the approval: `<channel>:<chat>`.
fn via(origin: &Origin) -> String {
    match origin {
        Origin::Channel { channel, chat } => format!("{channel}:{chat}"),
        Origin::Desktop => "desktop".into(),
        Origin::Scheduler { job } => format!("scheduler:{job:?}"),
    }
}

fn dollars(x: f64) -> String {
    format!("${x:.2}")
}

/// Midnight on the first of this month, local time.
fn month_start() -> Ms {
    let first = Local::now().date_naive().with_day(1).unwrap_or_default();
    first
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).earliest())
        .map_or(0, |t| t.timestamp_millis())
}

/// Called by `Agent::reply` for Lane::Command. Appends the turn and the answer to the session.
pub async fn run(
    agent: &Agent,
    turn: &Turn,
    cancel: CancellationToken,
) -> Result<Reply, BrainError> {
    let began = Instant::now();
    let store = agent.store();
    store
        .append(turn.session, Role::User, None, &body(turn.content.clone()))
        .map_err(other)?;
    let (text, model) = answer(agent, turn, &cancel).await?;
    store
        .append(
            turn.session,
            Role::Assistant,
            None,
            &body(Content::Text(text.clone())),
        )
        .map_err(other)?;
    Ok(Reply {
        text,
        files: Vec::new(),
        lane: Lane::Command,
        model,
        spans: vec![Span::since("command", began, began)],
    })
}

fn body(content: Content) -> alexia_store::MessageBody {
    alexia_store::MessageBody {
        content,
        calls: None,
        call_id: None,
        provider: None,
        notes: None,
        bad: None,
        stopped: None,
        typed: None,
        extra: Map::new(),
    }
}

/// The sentence a command ends with, and the model that wrote it (only `/compare` has one).
async fn answer(
    agent: &Agent,
    turn: &Turn,
    cancel: &CancellationToken,
) -> Result<(String, Option<String>), BrainError> {
    let said = turn.content.text();
    let typed = said.trim().trim_start_matches('/').trim_start();
    let (word, rest) = typed
        .split_once(char::is_whitespace)
        .map_or((typed, ""), |(w, r)| (w, r.trim()));
    let p = agent.parts();

    let text = match word {
        "new" => new_chat(agent, turn).await?,
        "help" => {
            let manifests = manifests(agent);
            list(&manifests)
                .iter()
                .map(|c| format!("/{} — {}", c.name, c.summary))
                .collect::<Vec<_>>()
                .join("\n")
        }
        "status" => status(agent)?,
        "providers" => providers(agent),
        "approvals" => {
            let rows = p.store.approvals_pending().map_err(other)?;
            if rows.is_empty() {
                "Nothing is waiting for your answer.".into()
            } else {
                rows.iter()
                    .map(|r| {
                        format!(
                            "#{} — {} (/approve {} or /deny {})",
                            r.id, r.text, r.id, r.id
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        "approve" => approval(agent, turn, rest, true)?,
        "deny" => approval(agent, turn, rest, false)?,
        "undo" => undo::undo_last(agent, turn.session, &turn.origin, cancel.clone()).await,
        "activity" => activity(agent, rest)?,
        "compare" => return compare_two(agent, turn, rest, cancel).await,
        "models" => models(agent),
        "local" | "combined" | "cloud" | "nsfw" | "sfw" | "cheap" | "best" => NOT_YET.into(),
        _ => {
            let manifests = manifests(agent);
            let all = list(&manifests);
            let found = all.iter().find(|c| {
                c.plugin.is_some() && (c.name == word || c.alias.as_deref() == Some(word))
            });
            match found {
                Some(c) => plugin_command(agent, turn, c, rest, cancel).await,
                None => format!("There is no /{word}. Type /help to see what there is."),
            }
        }
    };
    Ok((text, None))
}

fn manifests(agent: &Agent) -> Vec<Manifest> {
    agent
        .host()
        .manifests()
        .into_iter()
        .map(|d| d.manifest)
        .collect()
}

/// `/new`: a channel chat is pointed at a fresh session; the window rotates its own.
async fn new_chat(agent: &Agent, turn: &Turn) -> Result<String, BrainError> {
    if let Origin::Channel { channel, chat } = &turn.origin {
        agent
            .store()
            .new_channel_session(channel, chat)
            .map_err(other)?;
    }
    agent.host().conversation_ended().await;
    Ok("Started a new conversation. Nothing said before it comes with it.".into())
}

/// `/status`: the mode, what is running, spend this month (v2 `standing`).
fn status(agent: &Agent) -> Result<String, BrainError> {
    let p = agent.parts();
    let scope = permissions::scope(&p.store, &p.layout.root);
    let mode = match scope.mode {
        PermissionMode::AskEveryTime => "ask every time",
        PermissionMode::AskRisky => "ask when risky",
        PermissionMode::WatchAndWarn => "watch and warn",
        PermissionMode::FullTrust => "full trust",
    };
    let plugins = agent
        .host()
        .plugins()
        .iter()
        .filter(|s| s.state == PluginState::Running)
        .count();
    let tasks = p.store.live_runs().map_err(other)?.len();
    let start = month_start();
    // The store has no spend query and this task may not add one; `usage.cost` is the one
    // column that can ever be non-zero (a provider that charged).
    let spent: f64 = p
        .store
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT COALESCE(SUM(cost), 0) FROM usage WHERE at >= ?",
                [start],
                |r| r.get::<_, f64>(0),
            )?)
        })
        .map_err(other)?;
    let running = match (tasks, plugins) {
        (0, 0) => "nothing running".to_owned(),
        (t, pl) => format!(
            "{t} task{} running · {pl} plugin{} on",
            plural(t),
            plural(pl)
        ),
    };
    Ok(format!(
        "{mode} · {running} · {} this month",
        dollars(spent)
    ))
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// `/providers`: which providers have a model that can answer right now. Reports, never acts.
// ponytail: reads the router's ranked candidates; a live ping of every row (v2 `verify`)
// needs the catalog's rows, which the agent does not expose.
fn providers(agent: &Agent) -> String {
    let ranked = agent.parts().router.ranked(now_ms());
    let mut by: Vec<(String, usize)> = Vec::new();
    for c in &ranked {
        match by.iter_mut().find(|(p, _)| *p == c.provider) {
            Some((_, n)) => *n += 1,
            None => by.push((c.provider.clone(), 1)),
        }
    }
    if by.is_empty() {
        return "No provider can answer right now.".into();
    }
    let lines = by
        .iter()
        .map(|(p, n)| format!("{p} — answering ({n} model{})", plural(*n)));
    std::iter::once(format!("{} providers answering.", by.len()))
        .chain(lines)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `/approve <id>`, `/deny <id>`: the first answer wins; the waiting asker hears it on the bus.
fn approval(agent: &Agent, turn: &Turn, rest: &str, yes: bool) -> Result<String, BrainError> {
    let verb = if yes { "approve" } else { "deny" };
    let Ok(id) = rest.trim_start_matches('#').parse::<i64>() else {
        return Ok(format!(
            "Say which one: /{verb} <id>. /approvals lists them."
        ));
    };
    let p = agent.parts();
    if p.store.approval(id).map_err(other)?.is_none() {
        return Ok(format!("There is no waiting question #{id}."));
    }
    let at = now_ms();
    if !p
        .store
        .approval_answer(id, yes, &via(&turn.origin), at)
        .map_err(other)?
    {
        return Ok(format!("#{id} was already answered."));
    }
    p.bus.publish(Event::Answered {
        at,
        approval: id,
        answer: yes,
    });
    Ok(format!(
        "{} #{id}.",
        if yes { "Approved" } else { "Denied" }
    ))
}

/// `/activity [text]`: the audit log, newest first.
fn activity(agent: &Agent, rest: &str) -> Result<String, BrainError> {
    let query = (!rest.is_empty()).then_some(rest);
    let rows = trace::activity(agent.store(), query, 10).map_err(other)?;
    if rows.is_empty() {
        return Ok("Nothing in the activity log yet.".into());
    }
    Ok(rows
        .iter()
        .map(|r| format!("{} — {} ({}): {}", r.run, r.tool, r.decision, r.summary))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// `/models`: the owner's pins, per job.
fn models(agent: &Agent) -> String {
    let pins = agent.parts().router.pins();
    if pins.is_empty() {
        return "Nothing is pinned: the router picks the best free model for every job.".into();
    }
    pins.iter()
        .map(|(job, models)| format!("{job} — {}", models.join(", ")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A plugin's command: its tool of the same name, the rest of the line handed over whole
/// under `rest` (v2 D177). Core does not read it.
async fn plugin_command(
    agent: &Agent,
    turn: &Turn,
    c: &CommandInfo,
    rest: &str,
    cancel: &CancellationToken,
) -> String {
    let (Some(plugin), Some(alias)) = (&c.plugin, &c.alias) else {
        return format!("/{} needs a plugin that is not here.", c.name);
    };
    let tool = alias
        .strip_prefix(&format!("{}.", plugin.0))
        .unwrap_or(&c.name);
    let mut args = Map::new();
    if !rest.is_empty() {
        args.insert("rest".into(), Value::String(rest.into()));
    }
    let ctx = ToolCtx {
        session: turn.session,
        run: RunId(format!("cmd-{}", now_ms())),
        origin: turn.origin.clone(),
        background: false,
        cancel: cancel.child_token(),
        progress: None,
    };
    agent
        .parts()
        .tools
        .call(&tools::namespaced(plugin, tool), args, ctx)
        .await
        .text
}

/// `/compare <question>`: two models, both answers, keep one.
async fn compare_two(
    agent: &Agent,
    turn: &Turn,
    question: &str,
    cancel: &CancellationToken,
) -> Result<(String, Option<String>), BrainError> {
    if question.is_empty() {
        return Ok(("Ask me what to compare: /compare <question>.".into(), None));
    }
    let p = agent.parts();
    let req = ChatRequest {
        messages: vec![(Role::User, body(Content::Text(question.into())))],
        system: None,
        tools: Vec::new(),
        max_tokens: None,
    };
    let c = match compare::compare(&p.router, &req, cancel.clone()).await {
        Ok(c) => c,
        Err(ProviderError::Cancelled) => return Err(BrainError::Cancelled),
        Err(e) => return Ok((e.to_string(), None)),
    };
    // A side that did not answer holds a note, not an answer: it cannot be kept.
    let (ask, only) = match (c.a_failed, c.b_failed) {
        (false, false) => (
            format!("{}\n(Yes keeps A, no keeps B.)", compare::present(&c)),
            None,
        ),
        (true, false) => (
            format!(
                "{}\n\nA did not answer, so there is nothing to keep from it. Keep B?",
                compare::present(&c).replace("Keep A or B?", "").trim_end()
            ),
            Some(false),
        ),
        _ => (
            format!(
                "{}\n\nB did not answer, so there is nothing to keep from it. Keep A?",
                compare::present(&c).replace("Keep A or B?", "").trim_end()
            ),
            Some(true),
        ),
    };
    let q = Question {
        run: RunId(format!("cmd-{}", now_ms())),
        text: ask,
        detail: None,
    };
    let yes = p.ask.confirm(&turn.origin, &q, cancel.child_token()).await;
    if cancel.is_cancelled() {
        return Err(BrainError::Cancelled);
    }
    // With one side failed the question is yes/no about the other: "no" keeps nothing.
    if only.is_some() && !yes {
        return Ok(("Kept neither answer.".into(), None));
    }
    let keep_a = only.unwrap_or(yes);
    let ((model, kept), label) = if keep_a { (&c.a, "A") } else { (&c.b, "B") };
    Ok((
        format!("Kept {label} ({model}):\n{}", kept.trim()),
        Some(model.clone()),
    ))
}
