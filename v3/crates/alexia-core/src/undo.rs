// SPDX-License-Identifier: AGPL-3.0-only
//! Undo (AC-11): reverse the newest thing in a conversation that declared an inverse, through
//! the same permission gate as any call.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use alexia_store::{now_ms, AuditRow, SessionId};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::agent::Agent;
use crate::permissions::{self, CallAsk};
use crate::{Builtin, Origin, Question, Ruling, RunId, ToolCtx, ToolOutcome, ToolSpec, UndoCall};

const NOTHING: &str = "There is nothing I can undo in this conversation.";
const TOOL: &str = "undo.last";

fn run_id() -> RunId {
    static N: AtomicU64 = AtomicU64::new(0);
    RunId(format!(
        "undo-{}-{}",
        now_ms(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// "Undone: <summary>." | "There is nothing I can undo in this conversation." | the gate's refusal.
pub async fn undo_last(
    agent: &Agent,
    session: SessionId,
    origin: &Origin,
    cancel: CancellationToken,
) -> String {
    let p = agent.parts();
    let row = match p.store.last_undoable(session) {
        Ok(Some(row)) => row,
        Ok(None) => return NOTHING.into(),
        Err(e) => {
            tracing::warn!("undo: the audit log could not be read: {e}");
            return "I could not look up what I did, so I can't undo anything right now.".into();
        }
    };
    let Some(undo) = row
        .undo
        .as_deref()
        .and_then(|j| serde_json::from_str::<UndoCall>(j).ok())
    else {
        return "I can't read how to undo my last action, so I left it alone.".into();
    };
    let run = run_id();
    let why = format!("undo of #{}", row.id);
    let summary = undo.summary.trim().trim_end_matches('.').to_owned();
    let audit = |gate: &str, decision: &str, plugin: Option<String>, out: Option<&ToolOutcome>| {
        let r = p.store.audit(&AuditRow {
            id: 0,
            at: now_ms(),
            run: run.0.clone(),
            session: Some(session),
            origin: serde_json::to_string(origin).unwrap_or_default(),
            step: 0,
            tool: undo.tool.clone(),
            plugin,
            args: crate::redact::redact_json(&Value::Object(undo.arguments.clone())).to_string(),
            gate: gate.into(),
            decision: decision.into(),
            why: Some(why.clone()),
            ok: out.map(|o| o.ok),
            result: out.map(|o| o.text.chars().take(2000).collect()),
            undo: None,
            undone_at: None,
        });
        if let Err(e) = r {
            tracing::warn!("undo: its audit row could not be written: {e}");
        }
    };

    let specs = p.tools.list().await;
    let Some(spec) = specs.iter().find(|s| s.name == undo.tool) else {
        let msg = format!(
            "I can't undo that: {} is not available any more.",
            undo.tool
        );
        audit("blocked", "gone", None, None);
        return msg;
    };
    let plugin = spec.plugin.as_ref().map(|x| x.0.clone());
    let scope = permissions::scope(&p.store, &p.layout.root);
    let ruling = permissions::rule(
        &CallAsk {
            tool: &undo.tool,
            words: &spec.words,
            annotations: spec.annotations.as_ref(),
            paths: permissions::paths_in(&undo.arguments),
            reviewed: spec.reviewed,
        },
        &scope,
    );
    let (gate, decision) = match ruling {
        Ruling::Run => ("run", "ran"),
        Ruling::Blocked(why) => {
            audit("blocked", "blocked", plugin, None);
            return why;
        }
        Ruling::Ask(q) => {
            let question = Question {
                run: run.clone(),
                text: q.clone(),
                detail: Some(format!("undo: {summary}")),
            };
            if !p.ask.confirm(origin, &question, cancel.child_token()).await {
                audit("ask", "denied", plugin, None);
                return format!(
                    "The user did not approve it, so I did not undo it. They were asked: {q}"
                );
            }
            ("ask", "approved")
        }
    };

    let ctx = ToolCtx {
        session,
        run: run.clone(),
        origin: origin.clone(),
        background: false,
        cancel,
        progress: None,
    };
    let out = p.tools.call(&undo.tool, undo.arguments.clone(), ctx).await;
    audit(gate, decision, plugin, Some(&out));
    if !out.ok {
        return format!("I could not undo it ({summary}): {}", out.text);
    }
    match p.store.mark_undone(row.id, now_ms()) {
        Ok(()) => format!("Undone: {summary}."),
        Err(e) => {
            tracing::warn!("undo: row {} could not be marked undone: {e}", row.id);
            format!("Undone: {summary}. (I could not record that, so it may be offered again.)")
        }
    }
}

pub struct UndoTool {
    agent: Weak<Agent>,
}

impl UndoTool {
    pub fn new(agent: &Arc<Agent>) -> Arc<UndoTool> {
        Arc::new(UndoTool {
            agent: Arc::downgrade(agent),
        })
    }
}

/// `undo.last {}`.
#[async_trait::async_trait]
impl Builtin for UndoTool {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: TOOL.into(),
            description: "Undo the newest thing Alexia did in this conversation that can be undone. Call it when the owner says \"undo that\".".into(),
            params: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            // Not destructive itself: the inverse it runs is gated on its own tool.
            annotations: serde_json::from_value(
                json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }),
            )
            .ok(),
            reviewed: true,
            plugin: None,
            words: "undo the last thing Alexia did".into(),
        }]
    }

    async fn call(
        &self,
        name: &str,
        _args: &Map<String, Value>,
        ctx: &ToolCtx,
    ) -> Option<ToolOutcome> {
        if name != TOOL {
            return None;
        }
        let (text, ok) = match self.agent.upgrade() {
            Some(agent) => {
                let text = undo_last(&agent, ctx.session, &ctx.origin, ctx.cancel.clone()).await;
                let ok = text.starts_with("Undone:");
                (text, ok)
            }
            None => (
                "Alexia is shutting down, so nothing was undone.".into(),
                false,
            ),
        };
        Some(ToolOutcome {
            text,
            ok,
            files: Vec::new(),
            final_text: None,
            undo: None,
            card: None,
        })
    }
}
