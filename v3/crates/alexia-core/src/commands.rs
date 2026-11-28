// SPDX-License-Identifier: AGPL-3.0-only
//! Slash commands, built-in and from plugins' manifests (SP-01, AC-10, AC-11, AC-12, MO-10,
//! MO-12). A port of v2 `packages/core/src/commands.ts` (`commands`, `run`, `standing`,
//! `/providers`): a message starting with `/` is answered by core, never by a model.
//!
//! The three v2 axes (`/local` and friends) and the adult/cheap/best pins have no meaning on
//! a free-only hub (TR-10 is V3-4), so they answer with one honest sentence.

use std::sync::Arc;
use std::time::Instant;

use alexia_mcp::{CallCtx, CallError, Manifest, PluginId, PluginState};
use alexia_store::{now_ms, Content, Ms, Role, Store};
use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::bus::Event;
use crate::{
    compare, permissions, tools, trace, undo, Brain, BrainError, ChatRequest, DraftSink, Lane,
    Origin, PermissionMode, ProviderError, Question, Reply, RunId, Span, ToolCtx, Turn, Urgency,
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
    (
        "brief",
        "Send me a brief now: /brief, /brief evening or /brief weekly.",
    ),
    (
        "quiet",
        "Quiet hours: /quiet, /quiet 23:00 07:00, /quiet 2h (a pause), /quiet off.",
    ),
    ("notices", "The last things I raised, newest first."),
    (
        "silent",
        "What I may do without asking: /silent, /silent allow <tool id>, /silent remove <tool id>.",
    ),
    (
        "mute",
        "Stop notices from one source: /mute <source>. /mute lists what is muted.",
    ),
    (
        "note",
        "Write something down: /note <text>, or start a message with \"+ \".",
    ),
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
        Origin::Window => "window".into(),
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

const OWNER_ONLY: &str = "Commands are only taken from your own chat.";

/// Typed by the owner: in their own chat, or the window they sit at.
fn from_owner(origin: &Origin) -> bool {
    matches!(origin, Origin::Channel { .. } | Origin::Window)
}

/// (TR-01) A command that answers, undoes, changes or runs something, typed from anywhere but
/// the owner's chat or window (a scheduled prompt, a plugin's conversation). The other
/// read-only built-ins still answer.
fn owner_only(agent: &Agent, turn: &Turn) -> bool {
    if from_owner(&turn.origin) {
        return false;
    }
    if is_note(&turn.content) {
        return true;
    }
    let said = turn.content.text();
    let word = said.trim().trim_start_matches('/').trim_start();
    let word = word.split(char::is_whitespace).next().unwrap_or_default();
    matches!(
        word,
        "approve" | "deny" | "undo" | "brief" | "quiet" | "notices" | "silent" | "mute" | "note"
    ) || list(&manifests(agent))
        .iter()
        .any(|c| c.plugin.is_some() && (c.name == word || c.alias.as_deref() == Some(word)))
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
    let (text, model) = if owner_only(agent, turn) {
        (OWNER_ONLY.to_owned(), None)
    } else {
        answer(agent, turn, &cancel).await?
    };
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
    if is_note(&turn.content) {
        let text = said.trim_start().trim_start_matches('+').trim();
        return Ok((note(agent, turn, text, cancel).await, None));
    }
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
        "brief" => brief(agent, turn, rest, cancel).await,
        "quiet" => quiet(agent, rest),
        "notices" => said_or_why(notice_lines(agent.store(), 10)),
        "silent" => silent(agent, rest).await,
        "mute" => mute(agent, rest),
        "note" => note(agent, turn, rest, cancel).await,
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
    agent
        .parts()
        .tools
        .call(
            &tools::namespaced(plugin, tool),
            args,
            tool_ctx(turn, cancel),
        )
        .await
        .text
}

/// What a tool a command calls knows about the call.
fn tool_ctx(turn: &Turn, cancel: &CancellationToken) -> ToolCtx {
    ToolCtx {
        session: turn.session,
        run: RunId(format!("cmd-{}", now_ms())),
        origin: turn.origin.clone(),
        background: false,
        cancel: cancel.child_token(),
        progress: None,
    }
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

// ---- quick capture (DY-10) ----

/// A message that starts with "+ " and says something after it: a note.
pub fn is_note(content: &Content) -> bool {
    matches!(content, Content::Text(t)
        if t.trim_start().strip_prefix("+ ").is_some_and(|rest| !rest.trim().is_empty()))
}

/// The brain in front of the lanes: an owner's "+ " message is a note, answered like a
/// command, so no model reads it. Everything else goes to `next`.
pub struct QuickNotes {
    agent: Arc<Agent>,
    next: Arc<dyn Brain>,
}

impl QuickNotes {
    pub fn new(agent: Arc<Agent>, next: Arc<dyn Brain>) -> QuickNotes {
        QuickNotes { agent, next }
    }
}

#[async_trait::async_trait]
impl Brain for QuickNotes {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        // A file with it would be lost in a note, so that goes to the brain as usual.
        if from_owner(&turn.origin) && turn.files.is_empty() && is_note(&turn.content) {
            return run(&self.agent, &turn, cancel).await;
        }
        self.next.reply(turn, draft, cancel).await
    }
}

/// Where a note can land, best first.
const NOTE_CAPS: [&str; 2] = ["tasks.add", "memory.remember"];

/// Keeps `text` with the first capability that can take it.
async fn note(agent: &Agent, turn: &Turn, text: &str, cancel: &CancellationToken) -> String {
    if text.is_empty() {
        return "Write the note after it: /note <text>.".into();
    }
    let host = agent.host();
    for cap in NOTE_CAPS {
        if !host.answers(cap).answers {
            continue;
        }
        let args = Map::from_iter([("text".to_owned(), Value::String(text.into()))]);
        let ctx = CallCtx {
            conversation: Some(turn.session.0.to_string()),
            cancel: cancel.child_token(),
            ..CallCtx::default()
        };
        match host.call_capability(cap, args, ctx).await {
            Ok(r) if r.is_error != Some(true) => return "Noted.".into(),
            // Nothing could take it after all (switched off, paused): the next one may.
            Err(CallError::Off { .. }) => {}
            // It may have been half kept, so it is not written a second time elsewhere.
            _ => return "That note could not be saved.".into(),
        }
    }
    "Nothing here can keep notes yet.".into()
}

// ---- proactivity: settings and lists (P3-31), shared with `alexia-hub`'s verbs ----

const CORE: &str = "_core";
/// kv `_core`/`proactive` (INTERFACES §2.5). The scheduler owns its shape; core, which does
/// not depend on it, edits only `quiet` and `paused_until`.
const PROACTIVE: &str = "proactive";
/// kv `_core`/`silent`: the tool ids the owner lets her use without asking (P3-06).
const SILENT: &str = "silent";
/// The scheduler's builtin tool (P3-09).
const BRIEF_TOOL: &str = "brief_now";
const BAD_SETTINGS: &str =
    "The saved proactivity settings are not readable, so nothing was changed.";
const BAD_LIST: &str = "The saved list is not readable, so nothing was changed.";
const OPEN_WORLD: &str = "That one reaches outside your computer, so she always asks.";

/// `_core.proactive.quiet`.
#[derive(Serialize, Deserialize)]
struct Hours {
    from: (u8, u8),
    to: (u8, u8),
    lets_through: Urgency,
}

/// A command's answer: the sentence either way.
fn said_or_why(r: Result<String, String>) -> String {
    r.unwrap_or_else(|why| why)
}

fn text_of(e: alexia_store::Error) -> String {
    e.to_string()
}

/// "2026-05-04 14:05", local time.
fn local_time(at: Ms) -> String {
    Local.timestamp_millis_opt(at).earliest().map_or_else(
        || at.to_string(),
        |t| t.format("%Y-%m-%d %H:%M").to_string(),
    )
}

fn proactive_settings(store: &Store) -> Result<Map<String, Value>, String> {
    match store.kv_get(CORE, PROACTIVE).map_err(text_of)? {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m),
        Some(_) => Err(BAD_SETTINGS.into()),
    }
}

/// Changes `_core.proactive` in one transaction, keeping every key `f` does not touch.
fn edit_proactive(store: &Store, f: impl FnOnce(&mut Map<String, Value>)) -> Result<(), String> {
    let mut unreadable = false;
    store
        .kv_update(CORE, PROACTIVE, |now| {
            let mut settings = match now {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(m)) => m,
                other => {
                    unreadable = true;
                    return other;
                }
            };
            f(&mut settings);
            Some(Value::Object(settings))
        })
        .map_err(text_of)?;
    if unreadable {
        return Err(BAD_SETTINGS.into());
    }
    Ok(())
}

fn hours_of(settings: &Map<String, Value>) -> Option<Hours> {
    serde_json::from_value(settings.get("quiet")?.clone()).ok()
}

fn paused_until(settings: &Map<String, Value>, now: Ms) -> Option<Ms> {
    settings
        .get("paused_until")
        .and_then(Value::as_i64)
        .filter(|until| *until > now)
}

/// The quiet hours and, while one runs, the pause.
pub fn quiet_show(store: &Store, now: Ms) -> Result<String, String> {
    let settings = proactive_settings(store)?;
    let mut text = match hours_of(&settings).filter(|h| h.from != h.to) {
        Some(h) => {
            let through = match h.lets_through {
                Urgency::Urgent => "Only urgent things get through.",
                Urgency::High => "Only high and urgent things get through.",
                Urgency::Normal => "Only low-urgency things wait.",
                Urgency::Low => "Everything gets through.",
            };
            format!(
                "Quiet hours: {:02}:{:02} to {:02}:{:02}. {through}",
                h.from.0, h.from.1, h.to.0, h.to.1
            )
        }
        None => "No quiet hours are set.".into(),
    };
    if let Some(until) = paused_until(&settings, now) {
        text.push_str(&format!(
            "\nPaused until {}: only urgent things get through.",
            local_time(until)
        ));
    }
    Ok(text)
}

/// "7:00" or "23:30".
fn clock_of(s: &str) -> Result<(u8, u8), String> {
    let digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    s.split_once(':')
        .filter(|(h, m)| (1..=2).contains(&h.len()) && m.len() == 2 && digits(h) && digits(m))
        .and_then(|(h, m)| Some((h.parse::<u8>().ok()?, m.parse::<u8>().ok()?)))
        .filter(|(h, m)| *h < 24 && *m < 60)
        .ok_or_else(|| "A time is HH:MM, like 23:00.".into())
}

/// Sets the quiet hours. Without `lets_through` the one set before stays (urgent at first).
/// The same start and end means no quiet hours.
pub fn quiet_set(
    store: &Store,
    from: &str,
    to: &str,
    lets_through: Option<&str>,
    now: Ms,
) -> Result<String, String> {
    let (from, to) = (clock_of(from)?, clock_of(to)?);
    let asked = lets_through
        .map(|u| {
            serde_json::from_value::<Urgency>(Value::String(u.to_lowercase()))
                .map_err(|_| "The urgency is low, normal, high or urgent.".to_owned())
        })
        .transpose()?;
    edit_proactive(store, |settings| {
        let lets_through = asked
            .or_else(|| hours_of(settings).map(|h| h.lets_through))
            .unwrap_or(Urgency::Urgent);
        let hours = Hours {
            from,
            to,
            lets_through,
        };
        settings.insert("quiet".into(), json!(hours));
    })?;
    quiet_show(store, now)
}

/// "Not now" for `minutes`.
pub fn quiet_pause(store: &Store, minutes: u64, now: Ms) -> Result<String, String> {
    const YEAR: u64 = 366 * 24 * 60;
    if !(1..=YEAR).contains(&minutes) {
        return Err("A pause is at least a minute and at most a year.".into());
    }
    let until = now.saturating_add(minutes as Ms * 60_000);
    edit_proactive(store, |settings| {
        settings.insert("paused_until".into(), json!(until));
    })?;
    quiet_show(store, now)
}

/// Ends the pause; the quiet hours stay.
pub fn quiet_resume(store: &Store, now: Ms) -> Result<String, String> {
    let mut was = false;
    edit_proactive(store, |settings| {
        was = paused_until(settings, now).is_some();
        settings.remove("paused_until");
    })?;
    Ok(if was {
        "The pause is over.".into()
    } else {
        "There was no pause.".into()
    })
}

/// `/quiet off`: ends a running pause; with none, switches the quiet hours off.
fn quiet_off(store: &Store, now: Ms) -> Result<String, String> {
    if paused_until(&proactive_settings(store)?, now).is_some() {
        quiet_resume(store, now)?;
        return Ok(format!("The pause is over.\n{}", quiet_show(store, now)?));
    }
    quiet_set(store, "00:00", "00:00", None, now)
}

/// "2h", "30m" or "30min" as minutes.
fn minutes_of(s: &str) -> Option<u64> {
    let s = s.to_ascii_lowercase();
    let (number, each) = match s.strip_suffix('h') {
        Some(n) => (n, 60),
        None => (s.strip_suffix("min").or_else(|| s.strip_suffix('m'))?, 1),
    };
    number.parse::<u64>().ok()?.checked_mul(each)
}

/// Tells the running scheduler the owner changed something, so it looks again now.
fn changed(agent: &Agent, key: &str) {
    agent.parts().bus.publish(Event::SettingsChanged {
        at: now_ms(),
        owner: CORE.into(),
        keys: vec![key.into()],
    });
}

/// `/quiet`, `/quiet 23:00 07:00`, `/quiet 2h`, `/quiet off`.
fn quiet(agent: &Agent, rest: &str) -> String {
    let store = agent.store();
    let now = now_ms();
    let words: Vec<&str> = rest.split_whitespace().collect();
    let done = match words.as_slice() {
        [] => return said_or_why(quiet_show(store, now)),
        ["off"] => quiet_off(store, now),
        [one] => match minutes_of(one) {
            Some(minutes) => quiet_pause(store, minutes, now),
            None => Err(QUIET_USAGE.into()),
        },
        [from, to] => quiet_set(store, from, to, None, now),
        _ => Err(QUIET_USAGE.into()),
    };
    if done.is_ok() {
        changed(agent, PROACTIVE);
    }
    said_or_why(done)
}

const QUIET_USAGE: &str = "Say /quiet, /quiet 23:00 07:00, /quiet 2h or /quiet off.";

/// `/brief [evening|weekly]`: the scheduler's tool, by name. The brief arrives as its own
/// message.
async fn brief(agent: &Agent, turn: &Turn, rest: &str, cancel: &CancellationToken) -> String {
    let kind = match rest {
        "" => "morning",
        "morning" | "evening" | "weekly" => rest,
        _ => return "Say /brief, /brief evening or /brief weekly.".into(),
    };
    let args = Map::from_iter([("kind".to_owned(), Value::String(kind.into()))]);
    agent
        .parts()
        .tools
        .call(BRIEF_TOOL, args, tool_ctx(turn, cancel))
        .await
        .text
}

/// The newest `n` notices, one line each.
pub fn notice_lines(store: &Store, n: u32) -> Result<String, String> {
    let rows = store.notices_since(0, n).map_err(text_of)?;
    if rows.is_empty() {
        return Ok("No notices yet.".into());
    }
    Ok(rows
        .iter()
        .map(|r| {
            let text = r.text.split_whitespace().collect::<Vec<_>>().join(" ");
            format!(
                "#{} {} · {} · {} · {text}",
                r.id,
                local_time(r.updated_at),
                r.state,
                r.urgency
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn silent_ids(value: Option<Value>) -> Option<Vec<String>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(v) => serde_json::from_value(v).ok(),
    }
}

/// Changes `_core.silent` in one transaction; what `f` returns comes back. An unreadable list
/// is left as it is.
fn edit_silent<T>(store: &Store, f: impl FnOnce(&mut Vec<String>) -> T) -> Result<T, String> {
    let mut out = None;
    store
        .kv_update(CORE, SILENT, |now| match silent_ids(now.clone()) {
            Some(mut ids) => {
                out = Some(f(&mut ids));
                Some(json!(ids))
            }
            None => now,
        })
        .map_err(text_of)?;
    out.ok_or_else(|| BAD_LIST.into())
}

/// The owner's list, one tool id per line.
pub fn silent_list(store: &Store) -> Result<String, String> {
    let ids = silent_ids(store.kv_get(CORE, SILENT).map_err(text_of)?).ok_or(BAD_LIST)?;
    if ids.is_empty() {
        return Ok(
            "The list is empty: on her own she asks before anything that changes something.".into(),
        );
    }
    Ok(ids.join("\n"))
}

/// Puts `tool` on the list. `open_world` is the tool's own `openWorldHint`; None means there
/// is no such tool. A tool that reaches outside is refused: it always asks (D214).
pub fn silent_allow(store: &Store, tool: &str, open_world: Option<bool>) -> Result<String, String> {
    match open_world {
        None => Err(format!("There is no tool called {tool}.")),
        Some(true) => Err(OPEN_WORLD.into()),
        Some(false) => {
            let added = edit_silent(store, |ids| {
                let new = !ids.iter().any(|i| i == tool);
                if new {
                    ids.push(tool.to_owned());
                }
                new
            })?;
            Ok(if added {
                format!("Added {tool}: she may use it without asking.")
            } else {
                format!("{tool} is already on the list.")
            })
        }
    }
}

/// Takes `tool` off the list.
pub fn silent_remove(store: &Store, tool: &str) -> Result<String, String> {
    let removed = edit_silent(store, |ids| {
        let before = ids.len();
        ids.retain(|i| i != tool);
        ids.len() < before
    })?;
    if removed {
        Ok(format!(
            "Removed {tool}: she asks before using it on her own."
        ))
    } else {
        Err(format!("{tool} is not on the list."))
    }
}

/// `/silent`, `/silent allow <tool id>`, `/silent remove <tool id>`.
async fn silent(agent: &Agent, rest: &str) -> String {
    let store = agent.store();
    let words: Vec<&str> = rest.split_whitespace().collect();
    said_or_why(match words.as_slice() {
        [] | ["list"] => silent_list(store),
        ["allow", tool] => {
            let open_world = agent
                .parts()
                .tools
                .list()
                .await
                .iter()
                .find(|s| s.name == *tool)
                .map(|s| s.annotations.as_ref().and_then(|a| a.open_world_hint) == Some(true));
            silent_allow(store, tool, open_world)
        }
        ["remove", tool] => silent_remove(store, tool),
        _ => Err("Say /silent, /silent allow <tool id> or /silent remove <tool id>.".into()),
    })
}

/// The mutes in force, one per line.
pub fn mute_list(store: &Store, now: Ms) -> Result<String, String> {
    let rows = store.mutes(now).map_err(text_of)?;
    if rows.is_empty() {
        return Ok("Nothing is muted.".into());
    }
    Ok(rows
        .iter()
        .map(|m| {
            let topic = m
                .topic
                .as_deref()
                .map(|t| format!(" ({t})"))
                .unwrap_or_default();
            let until = m
                .until
                .map(|u| format!(" until {}", local_time(u)))
                .unwrap_or_default();
            format!("#{} {}{topic}{until}", m.id, m.source)
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

/// `/mute` (list) and `/mute <source>`.
fn mute(agent: &Agent, rest: &str) -> String {
    let store = agent.store();
    let now = now_ms();
    if rest.is_empty() {
        return said_or_why(mute_list(store, now));
    }
    if rest.contains(char::is_whitespace) {
        return "Name one source: /mute <source>.".into();
    }
    said_or_why(store.mutes(now).map_err(text_of).and_then(|rows| {
        if rows
            .iter()
            .any(|m| m.source == rest && m.topic.is_none() && m.until.is_none())
        {
            return Ok(format!("{rest} is already muted."));
        }
        store.mute_add(rest, None, None, now).map_err(text_of)?;
        changed(agent, "mutes");
        Ok(format!("Muted {rest}."))
    }))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use alexia_mcp::jsonrpc::RpcError;
    use alexia_mcp::types::{
        CallToolResult, ClientCapabilities, CreateMessageParams, Root, ToolAnnotations,
    };
    use alexia_mcp::{During, HostConfig, HostFacts, McpHost, ProgressSink, Timings, Upcalls};
    use alexia_store::{Layout, SessionId};

    use super::*;
    use crate::agent::AgentParts;
    use crate::catalog::Catalog;
    use crate::chat::Caps;
    use crate::checker::Checker;
    use crate::router::Router;
    use crate::{Ask, Bus, Limits, Steer, ToolOutcome, ToolSpec, Tooling};

    type Calls = Arc<Mutex<Vec<(String, Value)>>>;

    /// The tools: `brief_now`, one that stays on this computer and one that reaches outside.
    struct Tools {
        called: Calls,
    }

    #[async_trait::async_trait]
    impl Tooling for Tools {
        async fn list(&self) -> Vec<ToolSpec> {
            let spec = |name: &str, open_world: bool| ToolSpec {
                name: name.into(),
                description: String::new(),
                params: json!({"type": "object"}),
                annotations: Some(ToolAnnotations {
                    title: None,
                    read_only_hint: Some(false),
                    destructive_hint: Some(false),
                    idempotent_hint: None,
                    open_world_hint: Some(open_world),
                }),
                reviewed: true,
                plugin: None,
                words: String::new(),
            };
            vec![spec("demo__jot", false), spec("demo__send", true)]
        }

        async fn call(&self, name: &str, args: Map<String, Value>, _: ToolCtx) -> ToolOutcome {
            self.called
                .lock()
                .unwrap()
                .push((name.into(), Value::Object(args)));
            ToolOutcome {
                text: "Sent.".into(),
                ok: true,
                files: Vec::new(),
                final_text: None,
                undo: None,
                card: None,
            }
        }
    }

    /// Answers capabilities as core's host does when no plugin provides them.
    struct Provides {
        caps: Vec<&'static str>,
        called: Calls,
        fails: bool,
    }

    #[async_trait::async_trait]
    impl Upcalls for Provides {
        fn offers(&self, _: &PluginId) -> ClientCapabilities {
            ClientCapabilities::default()
        }
        fn host_facts(&self) -> HostFacts {
            unreachable!("no plugin runs in these tests")
        }
        async fn sample(
            &self,
            _: &PluginId,
            _: CreateMessageParams,
            _: Option<ProgressSink>,
            _: CancellationToken,
        ) -> Result<Value, RpcError> {
            Err(RpcError::method_not_found())
        }
        async fn elicit(
            &self,
            _: &PluginId,
            _: Value,
            _: Option<During>,
            _: CancellationToken,
        ) -> Result<Value, RpcError> {
            Err(RpcError::method_not_found())
        }
        async fn roots(&self, _: &PluginId) -> Vec<Root> {
            Vec::new()
        }
        fn host_caps(&self) -> Vec<String> {
            self.caps.iter().map(|c| (*c).to_owned()).collect()
        }
        async fn host_call(
            &self,
            _: &PluginId,
            cap: &str,
            args: Map<String, Value>,
            _: CancellationToken,
        ) -> Option<Result<CallToolResult, RpcError>> {
            if !self.caps.contains(&cap) {
                return None;
            }
            self.called
                .lock()
                .unwrap()
                .push((cap.into(), Value::Object(args)));
            let result = json!({"content": [], "isError": self.fails});
            Some(Ok(serde_json::from_value(result).unwrap()))
        }
    }

    struct Yes;

    #[async_trait::async_trait]
    impl Ask for Yes {
        async fn confirm(&self, _: &Origin, _: &Question, _: CancellationToken) -> bool {
            true
        }
    }

    struct NoCaps;

    #[async_trait::async_trait]
    impl Caps for NoCaps {
        fn answers(&self, _: &str) -> bool {
            false
        }
        async fn call(
            &self,
            _: &str,
            _: Map<String, Value>,
            _: CancellationToken,
        ) -> Option<String> {
            None
        }
    }

    /// A brain that must only hear what is not a note.
    #[derive(Default)]
    struct Heard(Mutex<Vec<String>>);

    #[async_trait::async_trait]
    impl Brain for Heard {
        async fn reply(
            &self,
            turn: Turn,
            _: DraftSink,
            _: CancellationToken,
        ) -> Result<Reply, BrainError> {
            self.0.lock().unwrap().push(turn.content.text().to_string());
            Ok(Reply {
                text: "from the brain".into(),
                files: Vec::new(),
                lane: Lane::Chat,
                model: None,
                spans: Vec::new(),
            })
        }
    }

    struct World {
        agent: Arc<Agent>,
        bus: Bus,
        tools: Calls,
        caps: Calls,
        session: SessionId,
        root: PathBuf,
    }

    impl Drop for World {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn world(tag: &str, provided: &[&'static str], fails: bool) -> World {
        let root =
            std::env::temp_dir().join(format!("alexia-core-commands-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let store = Arc::new(Store::open_in_memory().unwrap());
        let catalog = Arc::new(Catalog::new(
            Vec::new(),
            Vec::new(),
            root.join("catalog.json"),
        ));
        let router = Arc::new(Router::new(Vec::new(), catalog, store.clone()));
        let (tools, caps) = (Calls::default(), Calls::default());
        let host = McpHost::new(
            HostConfig {
                layout: Layout::new(root.join("data")),
                plugin_dirs: Vec::new(),
                node: PathBuf::from("node"),
                timings: Timings::default(),
                dial: None,
            },
            store.clone(),
            Arc::new(Provides {
                caps: provided.to_vec(),
                called: caps.clone(),
                fails,
            }),
            Arc::new(|_| {}),
        );
        host.start(&[]).await.unwrap();
        let bus = Bus::new(64);
        let session = store.create_session(None).unwrap();
        let agent = Agent::new(AgentParts {
            router,
            tools: Arc::new(Tools {
                called: tools.clone(),
            }),
            store,
            bus: bus.clone(),
            ask: Arc::new(Yes),
            checker: Arc::new(Checker::new(None)),
            caps: Arc::new(NoCaps),
            layout: Layout::new(root.join("data")),
            limits: Limits::default(),
            host,
        });
        World {
            agent,
            bus,
            tools,
            caps,
            session,
            root,
        }
    }

    fn owner() -> Origin {
        Origin::Channel {
            channel: "chat".into(),
            chat: "1".into(),
        }
    }

    fn turn(w: &World, origin: Origin, text: &str) -> Turn {
        Turn {
            session: w.session,
            origin,
            content: Content::Text(text.into()),
            files: Vec::new(),
            received_at: now_ms(),
            steer: Steer::none(),
        }
    }

    async fn say(w: &World, text: &str) -> String {
        run(&w.agent, &turn(w, owner(), text), CancellationToken::new())
            .await
            .unwrap()
            .text
    }

    fn kv(w: &World, key: &str) -> Option<Value> {
        w.agent.store().kv_get(CORE, key).unwrap()
    }

    #[tokio::test]
    async fn quiet_command_sets_kv() {
        let w = world("quiet", &[], false).await;
        let mut events = w.bus.subscribe();
        assert_eq!(say(&w, "/quiet").await, "No quiet hours are set.");
        // A key the commands do not own stays.
        w.agent
            .store()
            .kv_set(CORE, PROACTIVE, &json!({"brief_fallback": [8, 30]}))
            .unwrap();
        assert_eq!(
            say(&w, "/quiet 23:00 7:00").await,
            "Quiet hours: 23:00 to 07:00. Only urgent things get through."
        );
        assert_eq!(
            kv(&w, PROACTIVE),
            Some(json!({
                "brief_fallback": [8, 30],
                "quiet": {"from": [23, 0], "to": [7, 0], "lets_through": "urgent"},
            }))
        );
        assert!(matches!(
            &*events.try_recv().unwrap(),
            Event::SettingsChanged { owner, .. } if owner == CORE
        ));

        let before = now_ms();
        let said = say(&w, "/quiet 2h").await;
        assert!(said.contains("Paused until "), "{said}");
        let until = kv(&w, PROACTIVE).unwrap()["paused_until"].as_i64().unwrap();
        let two_hours = 2 * 60 * 60 * 1000;
        assert!((before + two_hours..=now_ms() + two_hours).contains(&until));

        // Off ends the pause first, and the hours stay.
        assert!(say(&w, "/quiet off")
            .await
            .starts_with("The pause is over."));
        let now = kv(&w, PROACTIVE).unwrap();
        assert_eq!(now.get("paused_until"), None);
        assert_eq!(now["quiet"]["from"], json!([23, 0]));
        // With no pause, off switches the hours off.
        assert_eq!(say(&w, "/quiet off").await, "No quiet hours are set.");
        let now = kv(&w, PROACTIVE).unwrap();
        assert_eq!(now["quiet"]["from"], now["quiet"]["to"]);

        // Nonsense changes nothing.
        for wrong in [
            "/quiet 25:00 07:00",
            "/quiet 23 7",
            "/quiet soon",
            "/quiet 0m",
            "/quiet 99999999999999999999h",
            "/quiet 1:00 2:00 3:00",
        ] {
            say(&w, wrong).await;
            assert_eq!(kv(&w, PROACTIVE).unwrap(), now, "{wrong}");
        }
        // A value that is not settings is left alone.
        w.agent
            .store()
            .kv_set(CORE, PROACTIVE, &json!("junk"))
            .unwrap();
        assert_eq!(say(&w, "/quiet 1h").await, BAD_SETTINGS);
        assert_eq!(kv(&w, PROACTIVE), Some(json!("junk")));
    }

    #[test]
    fn quiet_set_keeps_the_urgency_set_before() {
        let store = Store::open_in_memory().unwrap();
        quiet_set(&store, "22:00", "06:00", Some("High"), 0).unwrap();
        let said = quiet_set(&store, "23:00", "07:00", None, 0).unwrap();
        assert!(
            said.ends_with("Only high and urgent things get through."),
            "{said}"
        );
        assert!(quiet_set(&store, "23:00", "07:00", Some("loud"), 0).is_err());
    }

    #[tokio::test]
    async fn note_prefers_tasks_then_memory() {
        let both = world("both", &["tasks.add", "memory.remember"], false).await;
        assert_eq!(say(&both, "/note buy milk").await, "Noted.");
        assert_eq!(
            *both.caps.lock().unwrap(),
            [("tasks.add".to_owned(), json!({"text": "buy milk"}))]
        );

        let recall = world("recall", &["memory.remember"], false).await;
        assert_eq!(
            say(&recall, "/note the code is under the mat").await,
            "Noted."
        );
        assert_eq!(
            *recall.caps.lock().unwrap(),
            [(
                "memory.remember".to_owned(),
                json!({"text": "the code is under the mat"})
            )]
        );

        let nobody = world("nobody", &[], false).await;
        assert_eq!(
            say(&nobody, "/note x").await,
            "Nothing here can keep notes yet."
        );
        assert!(say(&nobody, "/note").await.starts_with("Write the note"));

        // A list that refuses it is said so, and it is not written elsewhere as well.
        let broken = world("broken", &["tasks.add", "memory.remember"], true).await;
        assert_eq!(
            say(&broken, "/note x").await,
            "That note could not be saved."
        );
        assert_eq!(broken.caps.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn plus_prefix_is_a_note() {
        let w = world("plus", &["tasks.add"], false).await;
        let heard = Arc::new(Heard::default());
        let brain = QuickNotes::new(w.agent.clone(), heard.clone());
        let ask = |origin: Origin, text: &str| {
            let turn = turn(&w, origin, text);
            let (tx, _rx) = tokio::sync::mpsc::channel(8);
            brain.reply(turn, tx, CancellationToken::new())
        };
        for origin in [owner(), Origin::Window] {
            let reply = ask(origin, "+ buy milk").await.unwrap();
            assert_eq!(reply.text, "Noted.");
            assert_eq!(reply.lane, Lane::Command);
        }
        assert_eq!(w.caps.lock().unwrap().len(), 2);
        assert_eq!(w.caps.lock().unwrap()[0].1, json!({"text": "buy milk"}));
        // Not notes: no space, nothing after it, a plus further in, or not the owner.
        for text in ["+420 123", "+ ", "2 + 2", "good morning"] {
            assert_eq!(ask(owner(), text).await.unwrap().text, "from the brain");
        }
        let job = Origin::Scheduler {
            job: crate::JobId(1),
        };
        assert_eq!(ask(job, "+ do it").await.unwrap().text, "from the brain");
        assert_eq!(heard.0.lock().unwrap().len(), 5);
        assert_eq!(w.caps.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn silent_command_owner_only() {
        let w = world("silent", &["tasks.add"], false).await;
        for origin in [
            Origin::Desktop,
            Origin::Scheduler {
                job: crate::JobId(1),
            },
        ] {
            for text in [
                "/silent allow demo__jot",
                "/silent",
                "/quiet 1h",
                "/mute watch",
                "/brief",
                "/notices",
                "/note x",
                "+ x",
            ] {
                let said = run(
                    &w.agent,
                    &turn(&w, origin.clone(), text),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .text;
                assert_eq!(said, OWNER_ONLY, "{text}");
            }
        }
        assert_eq!(kv(&w, SILENT), None);
        assert_eq!(kv(&w, PROACTIVE), None);
        assert!(w.agent.store().mutes(now_ms()).unwrap().is_empty());
        assert!(w.tools.lock().unwrap().is_empty());
        assert!(w.caps.lock().unwrap().is_empty());

        assert!(say(&w, "/silent").await.starts_with("The list is empty"));
        assert_eq!(say(&w, "/silent allow demo__send").await, OPEN_WORLD);
        assert_eq!(
            say(&w, "/silent allow demo__nothing").await,
            "There is no tool called demo__nothing."
        );
        assert_eq!(kv(&w, SILENT), None);
        assert!(say(&w, "/silent allow demo__jot")
            .await
            .starts_with("Added"));
        assert!(say(&w, "/silent allow demo__jot")
            .await
            .ends_with("already on the list."));
        assert_eq!(kv(&w, SILENT), Some(json!(["demo__jot"])));
        assert_eq!(say(&w, "/silent").await, "demo__jot");
        assert!(say(&w, "/silent remove demo__jot")
            .await
            .starts_with("Removed"));
        assert_eq!(kv(&w, SILENT), Some(json!([])));
        assert!(say(&w, "/silent remove demo__jot")
            .await
            .ends_with("is not on the list."));
        // A list that cannot be read is not written over.
        w.agent
            .store()
            .kv_set(CORE, SILENT, &json!("junk"))
            .unwrap();
        assert_eq!(say(&w, "/silent allow demo__jot").await, BAD_LIST);
        assert_eq!(kv(&w, SILENT), Some(json!("junk")));
    }

    #[tokio::test]
    async fn brief_notices_and_mute_commands() {
        let w = world("rest", &[], false).await;
        assert_eq!(say(&w, "/brief").await, "Sent.");
        assert_eq!(say(&w, "/brief weekly").await, "Sent.");
        assert!(say(&w, "/brief yearly").await.starts_with("Say /brief"));
        assert_eq!(
            *w.tools.lock().unwrap(),
            [
                ("brief_now".to_owned(), json!({"kind": "morning"})),
                ("brief_now".to_owned(), json!({"kind": "weekly"})),
            ]
        );

        assert_eq!(say(&w, "/notices").await, "No notices yet.");
        for i in 0..12 {
            let (key, text) = (format!("k{i}"), format!("thing\n{i}"));
            let notice = alexia_store::NewNotice {
                key: &key,
                source: "watch",
                text: &text,
                why: "",
                urgency: "low",
                due_at: None,
                not_before: None,
            };
            w.agent.store().notice_upsert(&notice, 1_000 + i).unwrap();
        }
        let said = say(&w, "/notices").await;
        let lines: Vec<&str> = said.lines().collect();
        assert_eq!(lines.len(), 10, "{said}");
        assert!(lines[0].ends_with("new · low · thing 11"), "{said}");
        assert!(lines[9].ends_with("thing 2"), "{said}");

        assert_eq!(say(&w, "/mute").await, "Nothing is muted.");
        assert_eq!(say(&w, "/mute watch").await, "Muted watch.");
        assert_eq!(say(&w, "/mute watch").await, "watch is already muted.");
        assert!(say(&w, "/mute two words").await.starts_with("Name one"));
        assert!(say(&w, "/mute").await.ends_with(" watch"));
        assert_eq!(w.agent.store().mutes(now_ms()).unwrap().len(), 1);
    }
}
