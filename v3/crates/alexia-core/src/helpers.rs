// SPDX-License-Identifier: AGPL-3.0-only
//! Parallel helpers (AC-07): `helpers.run` starts up to four child runs at once, each in its
//! own session with a short step ceiling, under the parent's origin (so approvals go where the
//! parent's came from), and returns their answers together. Helpers cannot start helpers.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use alexia_store::{now_ms, MessageBody, Role};
use serde_json::{json, Map, Value};
use tokio::task::JoinSet;

use crate::agent::{Agent, Task};
use crate::{Builtin, Event, RunEnd, RunId, Steer, ToolCtx, ToolOutcome, ToolSpec};

const NAME: &str = "helpers.run";
const MAX_HELPERS: usize = 4;
const KEPT_MS: i64 = 30 * 24 * 3600 * 1000;
const TITLE: &str = "Helper: ";
/// Longest goal kept in a session title.
const TITLE_GOAL: usize = 60;

pub struct Helpers {
    agent: Weak<Agent>,
    /// Runs that are helpers right now: the one place "depth 1" is enforced.
    live: Mutex<HashSet<RunId>>,
    seq: AtomicU64,
}

impl Helpers {
    pub fn new(agent: &Arc<Agent>) -> Arc<Helpers> {
        Arc::new(Helpers {
            agent: Arc::downgrade(agent),
            live: Mutex::default(),
            seq: AtomicU64::new(0),
        })
    }

    fn is_helper(&self, run: &RunId) -> bool {
        self.live.lock().map(|l| l.contains(run)).unwrap_or(false)
    }
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
        if self.is_helper(&ctx.run) {
            return Some(outcome(false, "Helpers cannot start helpers."));
        }
        let goals = match goals(args) {
            Ok(g) => g,
            Err(why) => return Some(outcome(false, why)),
        };
        let Some(agent) = self.agent.upgrade() else {
            return Some(outcome(false, "Alexia is shutting down."));
        };
        let store = agent.store().clone();
        // Helper sessions go with their runs: 30 days.
        if let Ok(all) = store.sessions() {
            for s in all {
                let old = s.created_at < now_ms() - KEPT_MS;
                if old && s.title.as_deref().is_some_and(|t| t.starts_with(TITLE)) {
                    let _ = store.delete_session(s.id);
                }
            }
        }
        // The parent's own trace is the loop's; the live feed is what a tool can reach.
        agent.parts().bus.publish(Event::RunStep {
            at: now_ms(),
            run: ctx.run.clone(),
            step: 0,
            summary: format!("Started {} helpers", goals.len()),
        });

        let ceiling = agent.parts().limits.helper_steps;
        let mut set: JoinSet<(usize, String)> = JoinSet::new();
        for (i, goal) in goals.iter().cloned().enumerate() {
            let id = RunId(format!(
                "{}.h{}",
                ctx.run.0,
                self.seq.fetch_add(1, Ordering::Relaxed)
            ));
            let title: String = goal.chars().take(TITLE_GOAL).collect();
            let body: MessageBody = match serde_json::from_value(json!({ "content": goal })) {
                Ok(b) => b,
                Err(e) => return Some(outcome(false, format!("Could not start helpers: {e}"))),
            };
            let session = match store.create_session(Some(&format!("{TITLE}{title}"))) {
                Ok(s) => s,
                Err(e) => return Some(outcome(false, format!("Could not start helpers: {e}"))),
            };
            if let Err(e) = store.append(session, Role::User, None, &body) {
                return Some(outcome(false, format!("Could not start helpers: {e}")));
            }
            if let Ok(mut l) = self.live.lock() {
                l.insert(id.clone());
            }
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
                run: Some(id.clone()),
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
        if let Ok(mut l) = self.live.lock() {
            l.retain(|r| !r.0.starts_with(&format!("{}.h", ctx.run.0)));
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
