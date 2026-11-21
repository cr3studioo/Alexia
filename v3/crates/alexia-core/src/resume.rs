// SPDX-License-Identifier: AGPL-3.0-only
//! Runs survive a restart; jobs that run for days (SP-13, AC-08).
//! The conversation is the state: a resumed run answers whatever was in flight with "not run",
//! says so, and goes back into the loop with the steps already counted.

use std::sync::Arc;

use alexia_store::{now_ms, AuditRow, Content, LiveRunRow, MessageBody, Role, SessionId, Store};
use serde_json::Map;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::agent::{Agent, Task};
use crate::redact::redact_text;
use crate::trace::Trace;
use crate::{Event, Origin, Result, RunEnd, RunId, Steer, Urgency};

/// A run older than this is not picked up again.
const MAX_AGE_MS: i64 = 7 * 24 * 3600 * 1000;
const RESTARTED: &str = "not run: Alexia restarted before it finished";

/// For every `live_runs` row: fix dangling calls, say "Picking up where I stopped: <task>." to the
/// run's origin (`Event::Say`), and spawn `agent.run` with the same RunId and `steps` so far.
/// Rows older than 7 days, or whose session is gone, are ended with a note instead
/// (`Trace::resume(.., row.steps)` then `end` with that note). Returns how many resumed.
pub async fn resume_all(
    agent: Arc<Agent>,
    tracker: &TaskTracker,
    cancel: CancellationToken,
) -> usize {
    let store = agent.store().clone();
    let rows = match store.live_runs() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("could not list the runs to resume: {e}");
            return 0;
        }
    };
    let mut resumed = 0;
    for row in rows {
        let origin = serde_json::from_str::<Origin>(&row.origin);
        let alive = store
            .sessions()
            .map(|s| s.iter().any(|s| s.id == row.session))
            .unwrap_or(false);
        let note = if now_ms() - row.touched_at > MAX_AGE_MS {
            Some("Not picked up after the restart: it had not moved for more than 7 days.")
        } else if !alive {
            Some("Not picked up after the restart: its conversation is gone.")
        } else if origin.is_err() {
            Some("Not picked up after the restart: its origin could not be read.")
        } else {
            None
        };
        let origin = match (note, origin) {
            (None, Ok(o)) => o,
            (note, o) => {
                let note = note.unwrap_or("Not picked up after the restart.");
                end_with(&agent, &row, o.unwrap_or(Origin::Desktop), note);
                continue;
            }
        };
        match start(&agent, tracker, &cancel, &row, origin.clone()) {
            Ok(()) => resumed += 1,
            Err(e) => {
                tracing::warn!(run = row.run, "could not resume: {e}");
                end_with(&agent, &row, origin, "Not picked up after the restart.");
            }
        }
    }
    resumed
}

fn end_with(agent: &Agent, row: &LiveRunRow, origin: Origin, note: &str) {
    let p = agent.parts();
    let ended = Trace::resume(
        p.store.clone(),
        p.bus.clone(),
        RunId(row.run.clone()),
        row.session,
        origin,
        row.background,
        row.parent.clone().map(RunId),
        row.steps,
    )
    .and_then(|t| t.end(&RunEnd::Refused(note.into())));
    if let Err(e) = ended {
        tracing::warn!(run = row.run, "could not end the run: {e}");
        // Never leave a row that would be tried again at every start.
        let _ = p.store.live_end(&row.run);
    }
    close_questions(&p.store, row);
}

/// The question that was waiting went with the old process, and the step it guarded never ran.
/// Close it; the model asks again if it still wants the step. A store error is logged only.
fn close_questions(store: &Store, row: &LiveRunRow) {
    let open = match store.approvals_pending() {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(run = row.run, "could not list the open questions: {e}");
            return;
        }
    };
    for a in open.into_iter().filter(|a| a.run == row.run) {
        if let Err(e) = store.approval_answer(a.id, false, "restart", now_ms()) {
            tracing::warn!(run = row.run, "could not close a question: {e}");
        }
    }
}

fn start(
    agent: &Arc<Agent>,
    tracker: &TaskTracker,
    cancel: &CancellationToken,
    row: &LiveRunRow,
    origin: Origin,
) -> Result<()> {
    let store = agent.store().clone();
    answer_dangling(&store, row, RESTARTED)?;
    close_questions(&store, row);
    let messages: Vec<_> = store
        .history(row.session, None)?
        .into_iter()
        .map(|m| (m.role, m.body))
        .collect();
    let what: String = messages
        .iter()
        .rev()
        .find(|(r, _)| *r == Role::User)
        .map(|(_, b)| b.content.text())
        .unwrap_or_default()
        .chars()
        .take(100)
        .collect();
    let job = match &origin {
        Origin::Scheduler { job } => Some(*job),
        _ => None,
    };
    let bus = agent.parts().bus.clone();
    let say = move |text: String| {
        bus.publish(Event::Say {
            at: now_ms(),
            text,
            urgency: Urgency::Normal,
            job,
        })
    };
    say(format!("Picking up where I stopped: {what}."));
    let task = Task {
        session: row.session,
        origin,
        messages,
        standing: Vec::new(),
        background: row.background,
        plugin: None,
        run: Some(RunId(row.run.clone())),
        parent: row.parent.clone().map(RunId),
        max_steps: None,
        steer: Steer::none(),
        steps_done: Some(row.steps),
    };
    let (tx, mut rx) = mpsc::channel(64);
    let (agent, cancel) = (agent.clone(), cancel.clone());
    tracker.spawn(async move {
        // Nobody watches a resumed draft: drain it so the run never waits on it.
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let result = agent.run(task, tx, cancel).await;
        let _ = drain.await;
        match result {
            Ok(r) if r.end == RunEnd::Answered && !r.text.trim().is_empty() => say(r.text),
            Ok(_) => {}
            Err(e) => tracing::warn!("a resumed run failed: {e}"),
        }
    });
    Ok(())
}

/// The dangling-call fix on its own (v2 P1-24 / P1-31 rule). Every call of the last assistant
/// turn that has no answer gets a tool row saying `why` and an audit row `unanswered`; nothing
/// is run; the audit rows name `row`'s run. Returns how many were answered.
pub fn answer_dangling(store: &Store, row: &LiveRunRow, why: &str) -> Result<u32> {
    let session = row.session;
    let live = Some(row);
    let history = store.history(session, None)?;
    let Some(at) = history
        .iter()
        .rposition(|m| m.role == Role::Assistant && m.body.calls.is_some())
    else {
        return Ok(0);
    };
    let answered: Vec<&str> = history[at + 1..]
        .iter()
        .filter(|m| m.role == Role::Tool)
        .filter_map(|m| m.body.call_id.as_deref())
        .collect();
    let mut n = 0;
    for call in history[at].body.calls.iter().flatten() {
        if answered.contains(&call.id.as_str()) {
            continue;
        }
        let b = MessageBody {
            content: Content::Text(why.into()),
            calls: None,
            call_id: Some(call.id.clone()),
            provider: None,
            notes: None,
            bad: None,
            stopped: None,
            typed: None,
            extra: Map::new(),
        };
        store.append(session, Role::Tool, None, &b)?;
        store.audit(&AuditRow {
            id: 0,
            at: now_ms(),
            run: live.map(|r| r.run.clone()).unwrap_or_default(),
            session: Some(session),
            origin: live.map(|r| r.origin.clone()).unwrap_or_default(),
            step: live.map_or(0, |r| r.steps + 1 + n),
            tool: call.name.chars().take(200).collect(),
            plugin: None,
            args: redact_text(&call.arguments).0.chars().take(2000).collect(),
            gate: "run".into(),
            decision: "unanswered".into(),
            why: Some(why.into()),
            ok: None,
            result: None,
            undo: None,
            undone_at: None,
        })?;
        n += 1;
    }
    Ok(n)
}
