// SPDX-License-Identifier: AGPL-3.0-only
//! Parallel helpers (AC-07): `helpers.run` starts up to four child runs at once, each in its
//! own session with a short step ceiling, under the parent's origin (so approvals go where the
//! parent's came from), and returns their answers together. Helpers cannot start helpers.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use alexia_store::{now_ms, MessageBody, Role, SessionId, Store};
use serde_json::{json, Map, Value};
use tokio::task::JoinSet;

use crate::agent::{Agent, Task};
use crate::{Builtin, Event, RunEnd, RunId, Steer, ToolCtx, ToolOutcome, ToolSpec};

const NAME: &str = "helpers.run";
const MAX_HELPERS: usize = 4;
const KEPT_MS: i64 = 30 * 24 * 3600 * 1000;
/// Invisible lead character: only sessions made here carry it, so the 30-day cleanup never
/// touches a user's own session that happens to be titled "Helper: ...".
const MARK: char = '\u{2063}';
const TITLE: &str = "Helper: ";
/// Longest goal kept in a session title.
const TITLE_GOAL: usize = 60;

pub struct Helpers {
    agent: Weak<Agent>,
}

impl Helpers {
    pub fn new(agent: &Arc<Agent>) -> Arc<Helpers> {
        Arc::new(Helpers {
            agent: Arc::downgrade(agent),
        })
    }
}

/// Depth 1 from the store, not memory: a helper's live row names its parent, and that row
/// survives a restart.
fn is_helper(store: &Store, run: &RunId) -> bool {
    store
        .live_runs()
        .map(|rows| rows.iter().any(|r| r.run == run.0 && r.parent.is_some()))
        .unwrap_or(false)
}

/// A run id no earlier run (this process or a past one) can hold: the clock plus a counter.
fn helper_id(parent: &RunId) -> RunId {
    static N: AtomicU64 = AtomicU64::new(0);
    RunId(format!(
        "{}.h-{}-{}",
        parent.0,
        now_ms(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Helper sessions go with their runs: those this module made, older than 30 days at `now`.
fn sweep(store: &Store, now: i64) {
    let Ok(all) = store.sessions() else { return };
    for s in all {
        if s.created_at < now - KEPT_MS && s.title.as_deref().is_some_and(|t| t.starts_with(MARK)) {
            let _ = store.delete_session(s.id);
        }
    }
}

/// One new session per goal, each holding its goal as the first message. If any step fails,
/// the sessions already made are deleted: nothing is left behind.
fn prepare(
    store: &Store,
    goals: &[String],
    mut body_of: impl FnMut(&str) -> Result<MessageBody, String>,
) -> Result<Vec<(SessionId, MessageBody)>, String> {
    let mut made: Vec<(SessionId, MessageBody)> = Vec::new();
    for goal in goals {
        let one = body_of(goal).and_then(|body| {
            let title: String = goal.chars().take(TITLE_GOAL).collect();
            let session = store
                .create_session(Some(&format!("{MARK}{TITLE}{title}")))
                .map_err(|e| e.to_string())?;
            match store.append(session, Role::User, None, &body) {
                Ok(_) => Ok((session, body)),
                Err(e) => {
                    let _ = store.delete_session(session);
                    Err(e.to_string())
                }
            }
        });
        match one {
            Ok(m) => made.push(m),
            Err(e) => {
                for (s, _) in &made {
                    let _ = store.delete_session(*s);
                }
                return Err(format!("Could not start helpers: {e}"));
            }
        }
    }
    Ok(made)
}

fn outcome(ok: bool, text: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        text: text.into(),
        ok,
        files: Vec::new(),
        final_text: None,
        undo: None,
        card: None,
    }
}

/// The goals asked for, or why the call is refused.
fn goals(args: &Map<String, Value>) -> Result<Vec<String>, String> {
    let tasks = args
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or("helpers.run needs `tasks`: a list of {goal}.")?;
    if tasks.is_empty() || tasks.len() > MAX_HELPERS {
        return Err(format!(
            "helpers.run takes 1 to {MAX_HELPERS} tasks at a time; got {}.",
            tasks.len()
        ));
    }
    tasks
        .iter()
        .map(
            |t| match t.get("goal").and_then(Value::as_str).map(str::trim) {
                Some(g) if !g.is_empty() => Ok(g.to_owned()),
                _ => Err("Every task needs a non-empty `goal`.".to_owned()),
            },
        )
        .collect()
}

#[async_trait::async_trait]
impl Builtin for Helpers {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: NAME.into(),
            description: "Split a big job across helpers that work at the same time. Each task \
                gets its own goal and a fresh conversation; their answers come back together. \
                Up to 4 tasks. Helpers cannot start helpers."
                .into(),
            params: json!({
                "type": "object",
                "properties": { "tasks": {
                    "type": "array", "minItems": 1, "maxItems": MAX_HELPERS,
                    "items": { "type": "object",
                        "properties": { "goal": { "type": "string" } },
                        "required": ["goal"] }
                } },
                "required": ["tasks"],
            }),
            annotations: None,
            reviewed: true,
            plugin: None,
            words: "ask helpers to work on parts of the job".into(),
        }]
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        ctx: &ToolCtx,
    ) -> Option<ToolOutcome> {
        if name != NAME {
            return None;
        }
        let Some(agent) = self.agent.upgrade() else {
            return Some(outcome(false, "Alexia is shutting down."));
        };
        let store = agent.store().clone();
        if is_helper(&store, &ctx.run) {
            return Some(outcome(false, "Helpers cannot start helpers."));
        }
        let goals = match goals(args) {
            Ok(g) => g,
            Err(why) => return Some(outcome(false, why)),
        };
        sweep(&store, now_ms());
        let ceiling = agent.parts().limits.helper_steps;
        let made = match prepare(&store, &goals, |g| {
            serde_json::from_value(json!({ "content": g })).map_err(|e| e.to_string())
        }) {
            Ok(m) => m,
            Err(why) => return Some(outcome(false, why)),
        };
        // The parent's own trace is the loop's; the live feed is what a tool can reach.
        agent.parts().bus.publish(Event::RunStep {
            at: now_ms(),
            run: ctx.run.clone(),
            step: 0,
            summary: format!("Started {} helpers", goals.len()),
        });

        let mut set: JoinSet<(usize, String)> = JoinSet::new();
        for (i, (session, body)) in made.into_iter().enumerate() {
            let task = Task {
                session,
                origin: ctx.origin.clone(),
                messages: vec![(Role::User, body)],
                standing: vec![
                    "You are a helper working on one part of a bigger job. Do only your goal, \
                     answer briefly, and do not start other helpers."
                        .into(),
                ],
                background: ctx.background,
                plugin: None,
                run: Some(helper_id(&ctx.run)),
                parent: Some(ctx.run.clone()),
                max_steps: Some(ceiling),
                steer: Steer::none(),
                steps_done: None,
            };
            let (agent, cancel) = (agent.clone(), ctx.cancel.child_token());
            set.spawn(async move {
                let (tx, mut rx) = tokio::sync::mpsc::channel(64);
                tokio::spawn(async move { while rx.recv().await.is_some() {} });
                let said = match agent.run(task, tx, cancel).await {
                    Ok(r) => match r.end {
                        RunEnd::Answered => r.text,
                        RunEnd::Ceiling => format!("stopped at the step limit. {}", r.text),
                        RunEnd::Stopped => "stopped before it finished.".into(),
                        RunEnd::Refused(why) => format!("could not finish: {why}"),
                    },
                    Err(e) => format!("could not finish: {e}"),
                };
                (i, said)
            });
        }

        let mut answers: Vec<Option<String>> = vec![None; goals.len()];
        while let Some(joined) = set.join_next().await {
            if let Ok((i, said)) = joined {
                answers[i] = Some(said);
            } else {
                tracing::warn!("a helper stopped unexpectedly");
            }
        }
        let text = goals
            .iter()
            .zip(answers)
            .enumerate()
            .map(|(i, (g, a))| {
                let a = a.unwrap_or_else(|| "stopped unexpectedly.".into());
                format!("Helper {} ({g}): {}", i + 1, a.trim())
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        Some(outcome(true, text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_start_leaves_no_sessions() {
        let store = Store::open_in_memory().unwrap();
        let goals: Vec<String> = ["a", "b", "c"].map(String::from).to_vec();
        let r = prepare(&store, &goals, |g| {
            if g == "c" {
                Err("boom".into())
            } else {
                serde_json::from_value(json!({ "content": g })).map_err(|e| e.to_string())
            }
        });
        assert!(r.unwrap_err().contains("boom"));
        assert!(store.sessions().unwrap().is_empty());
    }

    #[test]
    fn sweep_deletes_only_marked_old_sessions() {
        let store = Store::open_in_memory().unwrap();
        let mine = store
            .create_session(Some(&format!("{MARK}{TITLE}x")))
            .unwrap();
        let theirs = store.create_session(Some("Helper: my own notes")).unwrap();
        sweep(&store, now_ms()); // too young: both stay
        assert_eq!(store.sessions().unwrap().len(), 2);
        sweep(&store, now_ms() + KEPT_MS + 60_000);
        let left: Vec<_> = store
            .sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(left, vec![theirs]);
        assert_ne!(mine, theirs);
    }
}
