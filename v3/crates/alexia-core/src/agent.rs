// SPDX-License-Identifier: AGPL-3.0-only
//! The agent loop (SP-01, TR-01, TR-02, TR-12, SP-16, CH-08): plan → act → observe → repeat.
//! A port of v2 `packages/core/src/agent.ts` `run()` and the `gate` in `serve.ts`, minus every
//! paid, pause and allowance branch (D212). The conversation is the state: there is no
//! separate plan object, and every step re-asks the router.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use alexia_mcp::{McpHost, PluginId};
use alexia_store::{
    now_ms, Content, Layout, MessageBody, Ms, Part, Role, SessionId, Store, ToolCall,
};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::checker::{self, Checker, Tally};
use crate::permissions::{self, CallAsk};
use crate::prompt::{self, About};
use crate::router::{Needs, Router, StepAsk};
use crate::trace::Trace;
use crate::trim::{self, TrimOptions};
use crate::{
    chat, commands, lane, local, Ask, Brain, BrainError, Budget, Bus, ChatChunk, ChatRequest,
    DraftFrame, DraftSink, Job, Lane, Limits, Origin, OutFile, PermissionMode, Phase,
    ProviderError, Question, Reply, Ruling, RunEnd, RunId, RunResult, Span, Steer, Step, StepFrame,
    StepOutcomeFrame, Struggle, ToolCtx, ToolOutcome, ToolProgress, ToolSpec, Tooling, Turn,
};

pub struct AgentParts {
    pub router: Arc<Router>,
    pub tools: Arc<dyn Tooling>,
    pub store: Arc<Store>,
    pub bus: Bus,
    pub ask: Arc<dyn Ask>,
    pub checker: Arc<Checker>,
    pub caps: Arc<dyn chat::Caps>,
    pub layout: Layout,
    pub limits: Limits,
    /// (review 4 #2) manifests() for commands, conversation_ended, plugins()
    pub host: McpHost,
}

/// One run to do.
pub struct Task {
    pub session: SessionId,
    pub origin: Origin,
    /// The conversation to continue, ending with the new user turn (already stored).
    pub messages: Vec<(Role, MessageBody)>,
    pub standing: Vec<String>,
    pub background: bool,
    pub plugin: Option<PluginId>,
    pub run: Option<RunId>,
    pub parent: Option<RunId>,
    pub max_steps: Option<u32>,
    pub steer: Steer,
    /// (review 4 #1) Some(n): resuming `run` with n steps done (P2-26). None: new run.
    pub steps_done: Option<u32>,
}

pub struct Agent {
    parts: AgentParts,
    local_jobs: OnceLock<Arc<local::LocalJobs>>,
    /// The checker's give-up count, per conversation (TR-02). Never held across an await.
    tallies: Mutex<HashMap<SessionId, Tally>>,
}

/// How long a step waits for a first byte before the router starts another model. Longer
/// than chat's: nobody is watching a cursor blink, and a second start costs a free request.
const STEP_BUDGET: Budget = Budget {
    first_byte_ms: 8_000,
};
/// v2 `NOT_WORKING`: the share of the ceiling after which a task is grinding.
const NOT_WORKING: f64 = 0.4;
/// v2 `IN_A_ROW`: failures of one tool that mean stuck, dull steps that mean spinning.
const IN_A_ROW: usize = 3;
/// v2 `STRUGGLING`: failed free answers in one task before the person is told.
const STRUGGLING: usize = 3;
/// How long one capability read for the prompt may take (personality, profile, context).
const CAP_WAIT: Duration = Duration::from_secs(2);
/// v2 `CORE_CAPABILITIES` (protocol `capabilities.ts`).
const PERSONALITY: &str = "persona.personality";
const PROFILE: &str = "memory.profile";
const CURRENT_CONTEXT: &str = "context.current";
const RECALL: &str = "memory.recall";
const BUSY: &str = "The free models are all busy right now. Try again in a minute.";
const NO_FREE: &str = "No free model can answer right now.";
const STOPPED: &str = "not run: stopped";
const CAPPED: &str = "not run: step limit reached";
/// How many progress reports of one call may wait for the window before one is dropped.
const PROGRESS_QUEUE: usize = 64;
/// Said when a run is stopped before any model was asked (v2 serve.ts).
const NOT_STARTED: &str = "Stopped before starting.";

/// v2 `WHY`: what just happened, in the words of somebody watching it. One line, before the change.
fn why(s: Struggle) -> &'static str {
    match s {
        Struggle::Looping => "That call has come back twice with the same arguments, so the next plan goes to a better model.",
        Struggle::Stuck => "That tool has failed three times running, so the next plan goes to a better model.",
        Struggle::Spinning => "The last few steps turned up nothing new, so the next plan goes to a better model.",
        Struggle::Grinding => "This is taking a lot of steps, so the next plan goes to a better model.",
    }
}

/// A call exactly as it was made: the whole of the looping signal is a string compare.
fn signature(step: &Step) -> String {
    format!("{}({})", step.name, Value::Object(step.args.clone()))
}

/// v2 `struggling`: which signal shows, cheapest first. A function over the steps, not a
/// watcher with state: a second copy of the trace is the thing that drifts from it.
/// `done` is how many steps came before this process's `steps` (a resumed run).
fn struggling(steps: &[Step], done: u32, ceiling: u32) -> Option<Struggle> {
    let last = steps.last()?;
    // Looping: same tool, same arguments, twice. Asked of the newest step only.
    let sig = signature(last);
    if steps[..steps.len() - 1].iter().any(|s| signature(s) == sig) {
        return Some(Struggle::Looping);
    }
    let tail = &steps[steps.len().saturating_sub(IN_A_ROW)..];
    if tail.len() == IN_A_ROW {
        // Stuck: one tool failing three times running, whatever the arguments.
        if tail
            .iter()
            .all(|s| s.outcome.as_ref().is_some_and(|o| !o.ok) && s.name == tail[0].name)
        {
            return Some(Struggle::Stuck);
        }
        // Spinning: three steps that came back with nothing the loop had not been told.
        let older: Vec<&str> = steps[..steps.len() - IN_A_ROW]
            .iter()
            .filter_map(|s| s.outcome.as_ref().map(|o| o.text.as_str()))
            .collect();
        if tail.iter().all(|s| {
            s.outcome
                .as_ref()
                .is_some_and(|o| older.contains(&o.text.as_str()))
        }) {
            return Some(Struggle::Spinning);
        }
    }
    // Grinding: far enough into the leash that the leash is now the story.
    let total = f64::from(done) + steps.len() as f64;
    (total >= f64::from(ceiling) * NOT_WORKING).then_some(Struggle::Grinding)
}

/// v2 `parse`: malformed JSON from a small model is common, so it is `{}` and the tool says
/// what it needed; that sentence is what the model plans around.
fn parse(raw: &str) -> Map<String, Value> {
    match serde_json::from_str(raw) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn run_id() -> RunId {
    static N: AtomicU64 = AtomicU64::new(0);
    RunId(format!(
        "r-{}-{}",
        now_ms(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

fn key(provider: &str, model: &str) -> String {
    format!("{provider}\n{model}")
}

fn body(content: Content) -> MessageBody {
    MessageBody {
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

fn failure(text: String) -> ToolOutcome {
    ToolOutcome {
        text,
        ok: false,
        files: Vec::new(),
        final_text: None,
        undo: None,
        card: None,
    }
}

fn as_tool(spec: &ToolSpec) -> alexia_mcp::types::Tool {
    alexia_mcp::types::Tool {
        name: spec.name.clone(),
        title: None,
        description: Some(spec.description.clone()),
        input_schema: spec.params.clone(),
        output_schema: None,
        annotations: spec.annotations.clone(),
        meta: None,
    }
}

fn other(e: impl Into<crate::Error>) -> BrainError {
    BrainError::Other(e.into())
}

// ---- (P3-16) what memory hears, and what it may hand back ----

const CAPTURE: &str = "memory.capture";
/// Every capability a memory provider offers starts with this (INTERFACES §2.3).
const MEMORY: &str = "memory.";
/// The argument a memory provider's reads take to hand over locked facts (P3-15).
const UNLOCKED: &str = "unlocked";
/// kv `_core`/`private_sessions`: the private conversations' ids (P3-00 keeps it atomic).
const PRIVATE_SESSIONS: &str = "private_sessions";

/// (P3-16) Whether memory may hand this turn its locked facts: the window, the desktop, and
/// the primary chat of a channel (`store.primary_chat(channel) == Some(chat)`). Never a
/// Scheduler turn, never a non-primary chat.
pub(crate) fn unlocked(store: &Store, origin: &Origin) -> bool {
    match origin {
        Origin::Window | Origin::Desktop => true,
        Origin::Channel { channel, chat } => {
            store.primary_chat(channel).ok().flatten().as_deref() == Some(chat.as_str())
        }
        Origin::Scheduler { .. } => false,
    }
}

/// (P3-16) kv `_core`/`private_sessions` holds `session` (the list P3-00 made atomic). An
/// unreadable list reads as empty, like the api's own reader.
pub(crate) fn is_private(store: &Store, session: SessionId) -> bool {
    store
        .kv_get("_core", PRIVATE_SESSIONS)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<Vec<i64>>(v).ok())
        .is_some_and(|ids| ids.contains(&session.0))
}

/// The arguments for core's own `memory.profile`/`memory.recall` calls.
pub(crate) fn memory_args(store: &Store, origin: &Origin) -> Map<String, Value> {
    let mut args = Map::new();
    args.insert(UNLOCKED.into(), Value::Bool(unlocked(store, origin)));
    args
}

/// Where a turn came from, as `memory.capture`'s `channel`. None: a proactive turn, which
/// memory never hears.
fn channel_of(origin: &Origin) -> Option<&str> {
    match origin {
        Origin::Channel { channel, .. } => Some(channel),
        Origin::Window => Some("window"),
        Origin::Desktop => Some("desktop"),
        Origin::Scheduler { .. } => None,
    }
}

/// (P3-16, ME-02, ME-15) Offers a finished exchange to `memory.capture`: spawned, never
/// awaited. Not for a Scheduler turn, a private conversation, an empty answer, or when
/// nothing provides the capability. Credentials never make the trip (v2 `exchange()`).
pub(crate) fn capture(
    caps: &Arc<dyn chat::Caps>,
    store: &Store,
    origin: &Origin,
    session: SessionId,
    said: &str,
    answered: &str,
) {
    let Some(channel) = channel_of(origin) else {
        return;
    };
    if answered.trim().is_empty() || is_private(store, session) || !caps.answers(CAPTURE) {
        return;
    }
    let mut args = Map::new();
    args.insert("said".into(), alexia_mcp::redact(said, &[]).into());
    args.insert("answered".into(), alexia_mcp::redact(answered, &[]).into());
    args.insert("at".into(), now_ms().into());
    args.insert("channel".into(), channel.into());
    args.insert("session".into(), session.0.into());
    let caps = caps.clone();
    tokio::spawn(async move {
        caps.call(CAPTURE, args, CancellationToken::new()).await;
    });
}

/// A call the model made to a memory provider's tool never unlocks anything: only core's own
/// profile and recall reads may (P3-15 review). By capability, not by plugin id.
fn lock_memory(caps: &dyn chat::Caps, spec: Option<&ToolSpec>, args: &mut Map<String, Value>) {
    let Some(plugin) = spec.and_then(|s| s.plugin.as_ref()) else {
        return;
    };
    if args.contains_key(UNLOCKED)
        && caps
            .provided_by(plugin)
            .iter()
            .any(|c| c.starts_with(MEMORY))
    {
        args.insert(UNLOCKED.into(), Value::Bool(false));
    }
}

/// What the gate said about one call.
struct Gate {
    /// Some: it may not run, and this is its outcome. None: it runs.
    refused: Option<ToolOutcome>,
    gate: &'static str,
    decision: &'static str,
    why: Option<String>,
    plugin: Option<String>,
}

/// What a model turn streamed.
#[derive(Default)]
struct Heard {
    text: String,
    calls: Vec<ToolCall>,
}

/// Forwards a model turn to the draft (SP-14: reasoning is a phase, never text).
async fn relay(mut rx: mpsc::Receiver<ChatChunk>, draft: &DraftSink, trace: &Trace) -> Heard {
    let mut heard = Heard::default();
    let (mut writing, mut thinking) = (false, false);
    while let Some(chunk) = rx.recv().await {
        match chunk {
            ChatChunk::Text(t) => {
                if !writing {
                    writing = true;
                    trace.phase(Phase::Writing);
                    let _ = draft.send(DraftFrame::Phase(Phase::Writing)).await;
                }
                heard.text.push_str(&t);
                let _ = draft.send(DraftFrame::Delta(t)).await;
            }
            ChatChunk::Reasoning(_) if !thinking => {
                thinking = true;
                trace.phase(Phase::Thinking);
                let _ = draft.send(DraftFrame::Phase(Phase::Thinking)).await;
            }
            ChatChunk::Reasoning(_) => {}
            ChatChunk::ToolCall(c) => heard.calls.push(c),
        }
    }
    heard
}

/// One run's state. The conversation (`messages`) is the plan.
struct Run<'a> {
    agent: &'a Agent,
    task: &'a Task,
    run: RunId,
    trace: &'a Trace,
    draft: &'a DraftSink,
    messages: Vec<(Role, MessageBody)>,
    steps: Vec<Step>,
    /// Steps done before this process took the run over.
    done: u32,
    ceiling: u32,
    /// Lines for the next stored assistant row (and the trace, at once).
    notes: Vec<String>,
    files: Vec<OutFile>,
    model: Option<String>,
    text: String,
    /// The user's words, for the checker.
    said: String,
}

impl Run<'_> {
    fn store(&self) -> &Store {
        &self.agent.parts.store
    }

    async fn frame(&self, f: DraftFrame) {
        let _ = self.draft.send(f).await;
    }

    async fn phase(&self, p: Phase) {
        self.trace.phase(p);
        self.frame(DraftFrame::Phase(p)).await;
    }

    /// A line for the person: kept for the next stored reply, and said now (`DraftFrame::Note`).
    async fn note(&mut self, line: &str) {
        self.trace.note(line);
        self.notes.push(line.to_owned());
        self.frame(DraftFrame::Note(line.to_owned())).await;
    }

    /// A step as the window draws it, with nothing filled in yet.
    fn step_frame(step: &Step) -> StepFrame {
        StepFrame {
            n: step.n,
            name: step.name.clone(),
            args: None,
            progress: None,
            outcome: None,
        }
    }

    /// Stores a message in the session and adds it to the conversation.
    fn append(
        &mut self,
        role: Role,
        model: Option<&str>,
        b: MessageBody,
    ) -> Result<(), BrainError> {
        self.store()
            .append(self.task.session, role, model, &b)
            .map_err(other)?;
        self.messages.push((role, b));
        Ok(())
    }

    fn reply(&mut self, text: String) -> Result<(), BrainError> {
        let mut b = body(Content::Text(text.clone()));
        b.notes = self.take_notes();
        self.append(Role::Assistant, None, b)?;
        self.text = text;
        Ok(())
    }

    fn take_notes(&mut self) -> Option<Vec<String>> {
        (!self.notes.is_empty()).then(|| std::mem::take(&mut self.notes))
    }

    /// v2 `unanswered`: every call id in the stored assistant row needs a result, or a strict
    /// provider refuses the next turn. These never ran, so they are not steps.
    fn unanswered(&mut self, left: &[ToolCall], why: &str) -> Result<(), BrainError> {
        for call in left {
            let mut b = body(Content::Text(why.into()));
            b.call_id = Some(call.id.clone());
            self.append(Role::Tool, None, b)?;
        }
        Ok(())
    }

    /// Steer messages waiting now, each a user row (CH-08). True if there were any.
    async fn steered(&mut self) -> Result<bool, BrainError> {
        let waiting = self.task.steer.take().await;
        let any = !waiting.is_empty();
        for c in waiting {
            self.append(Role::User, None, body(c))?;
        }
        Ok(any)
    }

    /// The spoken-boundary check on the new user turn (TR-01): before the run starts.
    async fn boundaries(&mut self) -> Result<(), BrainError> {
        let agent = self.agent;
        let p = &agent.parts;
        let scope = permissions::scope(&p.store, &p.layout.root);
        if let Some(b) = permissions::heard(&self.said, now_ms()) {
            let mut all = scope.boundaries;
            all.push(b.clone());
            permissions::save_boundaries(&p.store, &all).map_err(other)?;
            self.note(&permissions::boundary_ack(&b)).await;
        } else if !scope.boundaries.is_empty() && permissions::lifts(&self.said) {
            permissions::save_boundaries(&p.store, &[]).map_err(other)?;
            self.note("Lifted. I can delete and change things again.")
                .await;
        }
        Ok(())
    }

    async fn about(&self, cancel: &CancellationToken) -> About {
        let p = &self.agent.parts;
        let read = |cap: &'static str, args: Map<String, Value>| async move {
            if !p.caps.answers(cap) {
                return None;
            }
            let got = tokio::time::timeout(CAP_WAIT, p.caps.call(cap, args, cancel.child_token()))
                .await
                .ok()
                .flatten()?;
            let got = got.trim();
            (!got.is_empty()).then(|| got.to_owned())
        };
        // Read once per run, not per step: a plugin woken every step to repeat a paragraph
        // is a plugin somebody turns off. Nothing installed → the stock floor.
        let (personality, profile, context) = tokio::join!(
            read(PERSONALITY, Map::new()),
            read(PROFILE, memory_args(&p.store, &self.task.origin)),
            read(CURRENT_CONTEXT, Map::new())
        );
        let name = p
            .store
            .kv_get("_core", "display_name")
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(str::to_owned));
        About {
            name,
            profile: profile.unwrap_or_default(),
            current_context: context,
            remembers: p.caps.answers(RECALL),
            today: prompt::day_of(chrono::Local::now().date_naive()),
            personality,
        }
    }

    /// v2 B9: free models failing, said once a task. Busy tries since the run began (the
    /// router records them) plus the empty answers seen here.
    // ponytail: `tries` are not per run, so a parallel task's busy tries count too; a run
    // column on tries would make it exact.
    async fn free_failing(&mut self, empties: usize, since: Ms, told: &mut bool) {
        if *told {
            return;
        }
        let busy = self
            .store()
            .tries_since(since)
            .map(|t| t.iter().filter(|t| t.outcome == "busy").count())
            .unwrap_or(0);
        let n = busy + empties;
        if n >= STRUGGLING {
            *told = true;
            self.note(&format!(
                "The free models are struggling right now — {n} empty, cut-off or busy answers in this task."
            ))
            .await;
        }
    }

    async fn go(&mut self, cancel: &CancellationToken) -> Result<RunEnd, BrainError> {
        let agent = self.agent;
        let p = &agent.parts;
        let about = self.about(cancel).await;
        let since = now_ms();
        // Planning shape for the request; after a clean step the cheap shape turns the crank.
        let mut job = Job::Plan;
        // Latched once the task escalates (v2 `above`): the model it went above.
        let mut above: Option<String> = None;
        let mut above_dropped = false;
        let mut answered: Option<String> = None;
        let mut avoid: Vec<String> = Vec::new();
        let (mut empties, mut told) = (0usize, false);
        let mut steerable = false;

        let mut started = false;
        loop {
            if cancel.is_cancelled() {
                if !started && self.done == 0 {
                    self.trace.note(NOT_STARTED);
                    self.frame(DraftFrame::Note(NOT_STARTED.into())).await;
                }
                return Ok(RunEnd::Stopped);
            }
            started = true;
            if steerable {
                self.steered().await?;
            }
            self.phase(Phase::Choosing).await;
            // Re-asked every step, on purpose: a plugin can vanish between steps (check 4).
            let available = p.tools.list().await;

            // How badly is this going? Asked of the steps, once a step (v2 §10.3). Tried
            // before it is announced: with no other model, the note would be untrue.
            if above.is_none() {
                if let Some(last) = &answered {
                    if let Some(signal) = struggling(&self.steps, self.done, self.ceiling) {
                        let needs = Needs {
                            tools: !available.is_empty(),
                            vision: false,
                            tokens: 0,
                        };
                        let better = p
                            .router
                            .ranked_for(now_ms(), &needs)
                            .iter()
                            .any(|c| &key(&c.provider, &c.model) != last);
                        if better {
                            above = Some(last.clone());
                            // Escalate the planning step, not every step.
                            job = Job::Plan;
                            self.note(why(signal)).await;
                        }
                    }
                }
            }

            let system = prompt::system(&available, &about, &self.task.standing);
            let seen =
                local::see_before_cloud(self.agent.local_jobs(), self.messages.clone()).await;
            let mut req = ChatRequest {
                messages: seen,
                system: Some(system),
                tools: available.iter().map(as_tool).collect(),
                max_tokens: None,
            };
            // Route first, then trim to the window that wins; the first candidate is the one
            // that almost always answers (v2 `budgetFor` on the plan's first rung).
            let needs = Needs::of(&req);
            let window = p
                .router
                .ranked_for(now_ms(), &needs)
                .first()
                .map_or(0, |c| c.context);
            req.messages = trim::trim(
                &req.messages,
                &TrimOptions {
                    budget: Some(trim::budget_for(window)),
                    ..TrimOptions::default()
                },
            );
            let mut skip = avoid.clone();
            let escalated = job == Job::Plan && !above_dropped && above.is_some();
            if escalated {
                skip.extend(above.clone());
            }
            let ask = StepAsk {
                job,
                avoid: skip,
                plugin: self.task.plugin.as_ref().map(|p| p.0.clone()),
                run: Some(self.run.clone()),
                session: Some(self.task.session),
            };
            if !steerable {
                steerable = true;
                self.frame(DraftFrame::Steerable).await;
            }

            let (tx, rx) = mpsc::channel(64);
            let (result, heard) = tokio::join!(
                p.router.step(&req, &ask, STEP_BUDGET, tx, cancel.clone()),
                relay(rx, self.draft, self.trace),
            );
            for n in p.router.take_notes(Some(&self.run)) {
                self.note(&n).await;
            }
            let done = match result {
                Err(_) if cancel.is_cancelled() => {
                    // Stop keeps what was written, marked as stopped, so it is still there
                    // when the conversation is opened again.
                    if !heard.text.trim().is_empty() {
                        let mut b = body(Content::Text(heard.text.clone()));
                        b.stopped = Some(true);
                        b.notes = self.take_notes();
                        self.append(Role::Assistant, None, b)?;
                        self.text = heard.text;
                    }
                    return Ok(RunEnd::Stopped);
                }
                // The better model has run out since: half a task is not the price of asking
                // for something better, so the escalation drops and the work carries on.
                Err(_) if escalated => {
                    above_dropped = true;
                    if !heard.text.is_empty() {
                        self.frame(DraftFrame::Restart).await;
                    }
                    continue;
                }
                Err(e) => return Ok(RunEnd::Refused(self.refusal(&e, &needs))),
                Ok(done) => done,
            };
            let who = key(&done.provider, &done.model);
            if heard.text.trim().is_empty() && heard.calls.is_empty() {
                // An empty answer: try another model, and count it towards B9.
                empties += 1;
                avoid.push(who);
                self.free_failing(empties, since, &mut told).await;
                continue;
            }
            self.free_failing(empties, since, &mut told).await;
            self.trace
                .model(&done.model, &done.model, done.first_byte_ms);
            answered = Some(who);
            self.model = Some(done.model.clone());

            let mut b = body(Content::Text(heard.text.clone()));
            b.provider = Some(done.provider.clone());
            b.notes = self.take_notes();
            if !heard.calls.is_empty() {
                b.calls = Some(heard.calls.clone());
            }
            self.append(Role::Assistant, Some(&done.model), b)?;
            self.text = heard.text;

            let calls = heard.calls;
            if calls.is_empty() {
                // A steer message that came while the answer was written is the next step.
                if self.steered().await? {
                    job = Job::Plan;
                    continue;
                }
                return Ok(RunEnd::Answered);
            }

            // Two passes (SP-16). The gate pass is sequential and in the model's order: the
            // step, the ceiling and every question, one at a time. The run pass starts every
            // call the gate allowed at once; a refusal is already its outcome. Results go back
            // in the model's order however they finished, so the stored history is fixed.
            let mut gated: Vec<(usize, Gate)> = Vec::new();
            let mut capped = false;
            for call in &calls {
                if cancel.is_cancelled() {
                    // Gated calls have not run either: the run pass never started.
                    self.unanswered(&calls, STOPPED)?;
                    return Ok(RunEnd::Stopped);
                }
                if self.done + self.steps.len() as u32 >= self.ceiling {
                    capped = true;
                    break;
                }
                let spec = available.iter().find(|t| t.name == call.name);
                let mut args = parse(&call.arguments);
                lock_memory(&*p.caps, spec, &mut args);
                let step = Step {
                    n: self.steps.len() as u32 + 1,
                    name: call.name.clone(),
                    args,
                    outcome: None,
                };
                self.trace.step(&step);
                self.frame(DraftFrame::Step(StepFrame {
                    args: Some(Value::Object(step.args.clone())),
                    ..Run::step_frame(&step)
                }))
                .await;
                self.phase(Phase::Tool).await;
                let gate = self.gate(&step, spec, cancel).await;
                self.steps.push(step);
                gated.push((self.steps.len() - 1, gate));
            }

            let mut running: JoinSet<(usize, ToolOutcome)> = JoinSet::new();
            // One per running call: its progress, as `Step` frames. The call `try_send`s into a
            // bounded queue, so a slow window loses a report and never stalls the tool.
            let mut moving: JoinSet<()> = JoinSet::new();
            for (i, gate) in &gated {
                if gate.refused.is_some() {
                    continue;
                }
                let (tools, step, i) = (p.tools.clone(), self.steps[*i].clone(), *i);
                let (progress, mut reports) = mpsc::channel::<ToolProgress>(PROGRESS_QUEUE);
                let (draft, frame) = (self.draft.clone(), Run::step_frame(&step));
                moving.spawn(async move {
                    while let Some(report) = reports.recv().await {
                        let f = StepFrame {
                            progress: Some(report),
                            ..frame.clone()
                        };
                        let _ = draft.send(DraftFrame::Step(f)).await;
                    }
                });
                let ctx = ToolCtx {
                    session: self.task.session,
                    run: self.run.clone(),
                    origin: self.task.origin.clone(),
                    background: self.task.background,
                    cancel: cancel.child_token(),
                    progress: Some(progress),
                };
                running.spawn(async move { (i, tools.call(&step.name, step.args, ctx).await) });
            }
            let mut outcomes: HashMap<usize, ToolOutcome> = HashMap::new();
            while let Some(joined) = running.join_next().await {
                match joined {
                    Ok((i, o)) => {
                        outcomes.insert(i, o);
                    }
                    Err(e) => tracing::warn!("a tool call stopped unexpectedly: {e}"),
                }
            }
            // Every call is over and dropped its sender, so each forwarder ends once it has
            // said what was queued: no progress frame comes after its step's outcome.
            while moving.join_next().await.is_some() {}

            let n_gated = gated.len();
            let mut failed = false;
            for ((i, gate), call) in gated.into_iter().zip(&calls) {
                let ran = gate.refused.is_none();
                let outcome = gate.refused.clone().unwrap_or_else(|| {
                    outcomes.remove(&i).unwrap_or_else(|| {
                        failure(format!(
                            "{} stopped unexpectedly and gave no answer.",
                            call.name
                        ))
                    })
                });
                failed |= !outcome.ok;
                self.files.extend(outcome.files.iter().map(|f| OutFile {
                    name: f.name.clone(),
                    mime: f.mime.clone(),
                    path: f.path.clone(),
                }));
                // TR-12: what a tool said is data, fenced; a refusal is Alexia's own words.
                let shown = if ran {
                    prompt::untrusted(&call.name, &outcome.text)
                } else {
                    outcome.text.clone()
                };
                let done = StepFrame {
                    outcome: Some(StepOutcomeFrame {
                        text: outcome.text.clone(),
                        ok: outcome.ok,
                        files: outcome.files.clone(),
                    }),
                    ..Run::step_frame(&self.steps[i])
                };
                self.steps[i].outcome = Some(outcome);
                self.frame(DraftFrame::Step(done)).await;
                let step = &self.steps[i];
                self.trace.step(step);
                if let Err(e) = self.trace.audited(
                    step,
                    gate.plugin.as_deref(),
                    gate.gate,
                    gate.decision,
                    gate.why.as_deref(),
                ) {
                    tracing::warn!("a call could not be audited: {e}");
                }
                let mut b = body(Content::Text(shown));
                b.call_id = Some(call.id.clone());
                self.append(Role::Tool, None, b)?;
            }
            if capped {
                let left = calls[n_gated..].to_vec();
                self.unanswered(&left, CAPPED)?;
                let total = self.done + self.steps.len() as u32;
                self.reply(format!(
                    "I stopped after {total} steps, the most one task may take. Ask me to go on and I will carry on from here."
                ))?;
                return Ok(RunEnd::Ceiling);
            }

            // A tool that already has the answer gives it (`alexia/final`): one call, it
            // worked, and it said what to reply. With other calls beside it the model sums up.
            if calls.len() == 1 {
                let only = self.steps.last().and_then(|s| s.outcome.as_ref());
                if let Some(text) = only.filter(|o| o.ok).and_then(|o| o.final_text.clone()) {
                    self.frame(DraftFrame::Delta(text.clone())).await;
                    self.reply(text)?;
                    return Ok(RunEnd::Answered);
                }
            }

            // A failure (a refusal, a vanished tool) means the plan was wrong: re-planning is
            // the expensive step, so it buys back the planning shape for one turn.
            job = if failed { Job::Plan } else { Job::Step };
        }
    }

    /// The sentence a failed step ends the run with.
    fn refusal(&self, e: &ProviderError, needs: &Needs) -> String {
        // Hands ran out mid-task: models that only talk are left (v2 `ranOutOfHands`).
        if !self.steps.is_empty() && needs.tools {
            let talk = Needs {
                tools: false,
                ..*needs
            };
            let router = &self.agent.parts.router;
            if router.ranked_for(now_ms(), needs).is_empty()
                && !router.ranked_for(now_ms(), &talk).is_empty()
            {
                return prompt::NO_HANDS.into();
            }
        }
        match e {
            ProviderError::Other(s) if !s.trim().is_empty() => s.clone(),
            ProviderError::Busy { .. } => BUSY.into(),
            _ => NO_FREE.into(),
        }
    }

    /// May this call run? (v2 serve.ts `gate`.) The scope is read fresh for every call, so a
    /// boundary spoken mid-task applies to the next call. A refusal is an outcome the model
    /// plans around, never an error and never silent.
    async fn gate(&self, step: &Step, spec: Option<&ToolSpec>, cancel: &CancellationToken) -> Gate {
        let p = &self.agent.parts;
        let Some(spec) = spec else {
            // The vanisher half of check 4: gone since the model saw the list.
            let why = format!(
                "{} is not available any more (its plugin may have been removed), so it did not run.",
                step.name
            );
            return Gate {
                refused: Some(failure(why.clone())),
                gate: "blocked",
                decision: "gone",
                why: Some(why),
                plugin: None,
            };
        };
        let plugin = spec.plugin.as_ref().map(|p| p.0.clone());
        let scope = permissions::scope(&p.store, &p.layout.root);
        let ask = CallAsk {
            tool: &step.name,
            words: &spec.words,
            annotations: spec.annotations.as_ref(),
            paths: permissions::paths_in(&step.args),
            reviewed: spec.reviewed,
        };
        let ruling = permissions::rule(&ask, &scope);
        // Acting on her own (D214, P3-06): narrowed for a scheduled task and the helpers it
        // starts, which inherit its origin.
        let (ruling, narrowed) = if matches!(self.task.origin, Origin::Scheduler { .. }) {
            let r = permissions::proactive(&ask, &scope, ruling.clone());
            let changed = r != ruling;
            (r, changed)
        } else {
            (ruling, false)
        };
        // The checker is coverage on top of the rules, never instead of them: only asked
        // about what they would let run, and only in Watch and warn me.
        let (ruling, gate) = match ruling {
            Ruling::Run if scope.mode == PermissionMode::WatchAndWarn => {
                match p
                    .checker
                    .review(step, &self.said, &scope, cancel.clone())
                    .await
                {
                    None => (
                        Ruling::Ask(format!(
                            "The checker could not look at {} just now. Allow it?",
                            step.name
                        )),
                        "checker",
                    ),
                    Some(review) => {
                        let tally = {
                            let mut all =
                                self.agent.tallies.lock().unwrap_or_else(|e| e.into_inner());
                            let t = all.entry(self.task.session).or_default();
                            *t = checker::counted(*t, &review);
                            *t
                        };
                        (checker::as_ruling(&review, step, &tally), "checker")
                    }
                }
            }
            r if narrowed => (r, "proactive"),
            Ruling::Run => (Ruling::Run, "run"),
            r @ Ruling::Ask(_) => (r, "ask"),
            r @ Ruling::Blocked(_) => (r, "blocked"),
        };
        match ruling {
            Ruling::Run => Gate {
                refused: None,
                gate,
                decision: "run",
                why: None,
                plugin,
            },
            Ruling::Blocked(why) => Gate {
                refused: Some(failure(why.clone())),
                gate,
                decision: "blocked",
                why: Some(why),
                plugin,
            },
            Ruling::Ask(q) => {
                self.phase(Phase::Asking).await;
                let question = Question {
                    run: self.run.clone(),
                    text: q.clone(),
                    detail: Some(signature(step)),
                };
                let yes = p
                    .ask
                    .confirm(&self.task.origin, &question, cancel.child_token())
                    .await;
                Gate {
                    refused: (!yes).then(|| {
                        failure(format!(
                            "The user did not approve it, so it did not run. They were asked: {q}"
                        ))
                    }),
                    gate,
                    decision: if yes { "approved" } else { "denied" },
                    why: Some(q),
                    plugin,
                }
            }
        }
    }
}

impl Agent {
    pub fn new(parts: AgentParts) -> Arc<Agent> {
        Arc::new(Agent {
            parts,
            local_jobs: OnceLock::new(),
            tallies: Mutex::default(),
        })
    }

    /// The loop. Appends every message it adds to `task.session`.
    pub async fn run(
        &self,
        task: Task,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<RunResult, BrainError> {
        let p = &self.parts;
        let (run, trace, done) = match task.steps_done {
            Some(n) => {
                let Some(run) = task.run.clone() else {
                    return Err(BrainError::Unavailable(
                        "A run can only be resumed by its id, and none was given.".into(),
                    ));
                };
                let trace = Trace::resume(
                    p.store.clone(),
                    p.bus.clone(),
                    run.clone(),
                    task.session,
                    task.origin.clone(),
                    task.background,
                    task.parent.clone(),
                    n,
                )
                .map_err(BrainError::Other)?;
                (run, trace, n)
            }
            None => {
                let run = task.run.clone().unwrap_or_else(run_id);
                let trace = Trace::begin(
                    p.store.clone(),
                    p.bus.clone(),
                    run.clone(),
                    task.session,
                    task.origin.clone(),
                    task.background,
                    task.parent.clone(),
                )
                .map_err(BrainError::Other)?;
                (run, trace, 0)
            }
        };
        let ceiling = task.max_steps.unwrap_or(if task.background {
            p.limits.background_steps
        } else {
            p.limits.max_steps
        });
        // v2: a caller's system lines join the one system turn rather than a second one.
        let mut standing = task.standing.clone();
        let mut messages = Vec::new();
        for (role, b) in &task.messages {
            if *role == Role::System {
                standing.push(b.content.text());
            } else {
                messages.push((*role, b.clone()));
            }
        }
        let said = messages
            .iter()
            .rev()
            .find(|(r, _)| *r == Role::User)
            .map(|(_, b)| b.content.text())
            .unwrap_or_default();
        let task = Task { standing, ..task };
        let mut r = Run {
            agent: self,
            task: &task,
            run: run.clone(),
            trace: &trace,
            draft: &draft,
            messages,
            steps: Vec::new(),
            done,
            ceiling,
            notes: Vec::new(),
            files: Vec::new(),
            model: None,
            text: String::new(),
            said,
        };
        let ended = if done == 0 {
            r.boundaries().await
        } else {
            Ok(())
        };
        let ended = match ended {
            Ok(()) => r.go(&cancel).await,
            Err(e) => Err(e),
        };
        let end = match &ended {
            Ok(end) => end.clone(),
            Err(e) => RunEnd::Refused(e.to_string()),
        };
        let Run {
            steps,
            files,
            model,
            text,
            ..
        } = r;
        if let Err(e) = trace.end(&end) {
            tracing::warn!("the run's trace could not be saved: {e}");
        }
        ended?;
        Ok(RunResult {
            run,
            end,
            steps,
            text,
            files,
            model,
        })
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.parts.store
    }

    pub fn host(&self) -> &McpHost {
        &self.parts.host
    }

    /// The parts the agent was built from. Read-only.
    pub fn parts(&self) -> &AgentParts {
        &self.parts
    }

    /// Set once by the hub (P2-38); None until then. A second set is ignored.
    pub fn set_local_jobs(&self, jobs: Arc<local::LocalJobs>) {
        if self.local_jobs.set(jobs).is_err() {
            tracing::warn!("local jobs were already set; the second set is ignored");
        }
    }

    pub fn local_jobs(&self) -> Option<&local::LocalJobs> {
        self.local_jobs.get().map(|j| &**j)
    }
}

/// The bridge's document limit (P2-38 deletes the bridge; this is its port).
const MAX_DOCUMENT: u64 = 20 * 1024 * 1024;
/// The most text a text-like file inlines into the turn.
const MAX_TEXT_FILE: u64 = 200 * 1024;

/// The turn's content with its files read in: images as data URLs, text-like files inlined,
/// anything else named as unreadable. Stored as the user message, so a resumed run (P2-26)
/// sees the same content after the gateway deleted the files.
async fn attach(turn: &Turn) -> Content {
    fn base64(bytes: &[u8]) -> String {
        const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for c in bytes.chunks(3) {
            let n = u32::from(c[0]) << 16
                | u32::from(*c.get(1).unwrap_or(&0)) << 8
                | u32::from(*c.get(2).unwrap_or(&0));
            for i in 0..4 {
                out.push(if i <= c.len() {
                    char::from(ABC[(n >> (18 - 6 * i) & 63) as usize])
                } else {
                    '='
                });
            }
        }
        out
    }
    if turn.files.is_empty() {
        return turn.content.clone();
    }
    let mut parts = match &turn.content {
        Content::Text(t) if t.is_empty() => Vec::new(),
        Content::Text(t) => vec![Part::Text { text: t.clone() }],
        Content::Parts(p) => p.clone(),
    };
    for f in &turn.files {
        let ext = f.path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ext = ext.to_ascii_lowercase();
        let image = f.mime.starts_with("image/");
        let texty = f.mime.starts_with("text/")
            || matches!(f.mime.as_str(), "application/json" | "application/xml")
            || matches!(ext.as_str(), "md" | "csv");
        let limit = if image { MAX_DOCUMENT } else { MAX_TEXT_FILE };
        let size = tokio::fs::metadata(&f.path).await.map(|m| m.len()).ok();
        let read = match size {
            Some(n) if (image || texty) && n <= limit => tokio::fs::read(&f.path).await.ok(),
            _ => None,
        };
        let part = match read {
            Some(bytes) if image => Some(Part::Image {
                url: format!("data:{};base64,{}", f.mime, base64(&bytes)),
            }),
            Some(bytes) => String::from_utf8(bytes).ok().map(|text| Part::Text {
                text: format!("{}:\n{text}", f.name),
            }),
            None => None,
        };
        parts.push(part.unwrap_or_else(|| {
            tracing::warn!(file = %f.name, mime = %f.mime, ?size, "an attached file is not read");
            Part::Text {
                text: format!(
                    "(The owner attached {}, {}, which Alexia cannot read yet.)",
                    f.name, f.mime
                ),
            }
        }));
    }
    Content::Parts(parts)
}

/// Lane::Command (owner's chat or window) → `commands::run`; else append the user turn, build a Task, `run`, map to Reply.
#[async_trait::async_trait]
impl Brain for Agent {
    async fn reply(
        &self,
        turn: Turn,
        draft: DraftSink,
        cancel: CancellationToken,
    ) -> Result<Reply, BrainError> {
        // Only the owner can run a command: their own chat, or the window they sit at. From
        // anywhere else `/…` is text (TR-01).
        if matches!(turn.origin, Origin::Channel { .. } | Origin::Window)
            && lane::lane(&turn.content) == Lane::Command
        {
            return commands::run(self, &turn, cancel).await;
        }
        let began = Instant::now();
        let store = &self.parts.store;
        let content = attach(&turn).await;
        store
            .append(turn.session, Role::User, None, &body(content))
            .map_err(other)?;
        let messages = store
            .history(turn.session, None)
            .map_err(other)?
            .into_iter()
            .map(|m| (m.role, m.body))
            .collect();
        let task = Task {
            session: turn.session,
            origin: turn.origin.clone(),
            messages,
            standing: Vec::new(),
            background: matches!(turn.origin, Origin::Scheduler { .. }),
            plugin: None,
            run: None,
            parent: None,
            max_steps: None,
            steer: turn.steer.clone(),
            steps_done: None,
        };
        let result = self.run(task, draft, cancel).await?;
        // ME-02: the task lane's exchange goes to memory like the chat lane's. The window's
        // route hands over its own (alexia-api `chat.rs`, after its learn offer), so it is
        // not offered twice. A ceiling, a stop or a refusal is not a finished exchange.
        if result.end == RunEnd::Answered && turn.origin != Origin::Window {
            capture(
                &self.parts.caps,
                store,
                &turn.origin,
                turn.session,
                &turn.content.text(),
                &result.text,
            );
        }
        match result.end {
            RunEnd::Stopped => Err(BrainError::Cancelled),
            RunEnd::Refused(why) => Err(BrainError::Unavailable(why)),
            RunEnd::Answered | RunEnd::Ceiling => Ok(Reply {
                text: result.text,
                files: result.files,
                lane: Lane::Task,
                model: result.model,
                spans: vec![Span::since("task", began, began)],
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(name: &str, args: Value, ok: Option<(&str, bool)>) -> Step {
        Step {
            n: 0,
            name: name.into(),
            args: args.as_object().cloned().unwrap_or_default(),
            outcome: ok.map(|(text, ok)| ToolOutcome {
                ok,
                ..failure(text.into())
            }),
        }
    }

    #[test]
    fn struggle_signals() {
        let a = step("look", serde_json::json!({"q": 1}), Some(("x", true)));
        let b = step("look", serde_json::json!({"q": 2}), Some(("y", true)));
        assert_eq!(struggling(std::slice::from_ref(&a), 0, 24), None);
        assert_eq!(
            struggling(&[a.clone(), a.clone()], 0, 24),
            Some(Struggle::Looping)
        );
        let bad = |q| step("wipe", serde_json::json!({ "q": q }), Some(("no", false)));
        assert_eq!(
            struggling(&[a.clone(), bad(1), bad(2), bad(3)], 0, 24),
            Some(Struggle::Stuck)
        );
        let same = |q| step("find", serde_json::json!({ "q": q }), Some(("x", true)));
        assert_eq!(
            struggling(&[a.clone(), same(1), same(2), same(3)], 0, 24),
            Some(Struggle::Spinning)
        );
        assert_eq!(
            struggling(&[a.clone(), b.clone()], 0, 5),
            Some(Struggle::Grinding)
        );
        assert_eq!(struggling(&[a, b], 8, 24), Some(Struggle::Grinding));
    }

    #[test]
    fn bad_json_args_are_empty() {
        assert!(parse("{not json").is_empty());
        assert!(parse("[1]").is_empty());
        assert_eq!(parse(r#"{"a":1}"#)["a"], 1);
    }
}
