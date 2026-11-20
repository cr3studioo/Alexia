// SPDX-License-Identifier: AGPL-3.0-only
//! The trace of a run, the runs table and the audit log (TR-08, AC-12, SP-13, TR-03).
//! Ported from v2 `packages/core/src/trace.ts` (`Run`, `TraceStep`, `ending`, `took`, `summary`,
//! `asText`, `KEPT`). Everything written is redacted first (`redact`, P2-14); this file has no
//! pattern list of its own. A trace never breaks a run: `phase`, `model`, `note` and `step`
//! cannot fail, `audited` and `end` report.

use std::sync::{Arc, Mutex, MutexGuard};

use alexia_store::{now_ms, AuditRow, LiveRunRow, Ms, SessionId, Store};
use serde_json::{json, Map, Value};

use crate::bus::RunOutcome;
use crate::redact::{redact_json, redact_text};
use crate::{Bus, Event, Origin, Phase, Result, RunEnd, RunId, Step};

/// v2 `KEPT` (`RUNS_KEPT.count`): how many runs are kept.
pub const KEPT: u32 = 200;
/// v2 `RUNS_KEPT.days`.
const KEPT_DAYS: i64 = 30;
/// What a person needs of a tool's answer (INTERFACES 2.3: at most 2000 chars).
const RESULT_MAX: usize = 2000;

pub struct Trace {
    run: RunId,
    session: SessionId,
    origin: Origin,
    store: Arc<Store>,
    bus: Bus,
    /// Steps already done before this process took the run over (`resume`).
    base: u32,
    body: Mutex<Value>,
}

/// Redacted, then cut to `max` characters.
fn clean(text: &str, max: usize) -> String {
    redact_text(text).0.chars().take(max).collect()
}

fn phase_word(p: Phase) -> &'static str {
    match p {
        Phase::Choosing => "choosing",
        Phase::Asking => "asking",
        Phase::Retrying => "retrying",
        Phase::Backup => "backup",
        Phase::Thinking => "thinking",
        Phase::Writing => "writing",
        Phase::Tool => "tool",
    }
}

fn arr<'a>(body: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !body[key].is_array() {
        body[key] = json!([]);
    }
    match &mut body[key] {
        Value::Array(a) => a,
        _ => unreachable!("just made an array"),
    }
}

/// Give the last stage its length, when it has none yet.
fn close_last(phases: &mut [Value], at: Ms) {
    if let Some(last) = phases.last_mut() {
        if last.get("ms").is_none() {
            let began = last["at"].as_i64().unwrap_or(at);
            last["ms"] = json!(at - began);
        }
    }
}

fn origin_json(o: &Origin) -> String {
    serde_json::to_string(o).unwrap_or_default()
}

impl Trace {
    pub fn begin(
        store: Arc<Store>,
        bus: Bus,
        run: RunId,
        session: SessionId,
        origin: Origin,
        background: bool,
        parent: Option<RunId>,
    ) -> Result<Trace> {
        let at = now_ms();
        store.live_begin(&LiveRunRow {
            run: run.0.clone(),
            session,
            origin: origin_json(&origin),
            started_at: at,
            touched_at: at,
            steps: 0,
            background,
            parent: parent.map(|p| p.0),
        })?;
        Ok(Self::open(store, bus, run, session, origin, 0, None))
    }

    /// (review 4 #1) The `live_runs` row survived a restart, so `live_begin` (a plain INSERT)
    /// must not run again: touch it, say so in the trace, and count on from `steps_done`.
    #[allow(clippy::too_many_arguments)] // the interface is fixed (INTERFACES 2.3)
    pub fn resume(
        store: Arc<Store>,
        bus: Bus,
        run: RunId,
        session: SessionId,
        origin: Origin,
        _background: bool,
        _parent: Option<RunId>,
        steps_done: u32,
    ) -> Result<Trace> {
        // `_background` and `_parent` are already on the surviving row.
        store.live_touch(&run.0, steps_done, now_ms())?;
        let note = format!("Resumed after a restart at step {steps_done}.");
        Ok(Self::open(
            store,
            bus,
            run,
            session,
            origin,
            steps_done,
            Some(note),
        ))
    }

    fn open(
        store: Arc<Store>,
        bus: Bus,
        run: RunId,
        session: SessionId,
        origin: Origin,
        base: u32,
        note: Option<String>,
    ) -> Trace {
        let at = now_ms();
        let mut body = json!({ "id": run.0, "at": at, "steps": [], "phases": [], "notes": [] });
        if let Some(n) = note {
            arr(&mut body, "notes").push(json!({ "at": at, "text": n }));
        }
        bus.publish(Event::RunStarted {
            at,
            run: run.clone(),
            session,
            origin: origin.clone(),
        });
        Trace {
            run,
            session,
            origin,
            store,
            bus,
            base,
            body: Mutex::new(body),
        }
    }

    fn body(&self) -> MutexGuard<'_, Value> {
        self.body.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A step's number in this run. A resumed run's counter continues after `base`: a step
    /// numbered at or below it is counted from there.
    fn number(&self, step: &Step) -> u32 {
        if step.n > self.base {
            step.n
        } else {
            self.base + step.n
        }
    }

    pub fn phase(&self, p: Phase) {
        let at = now_ms();
        let mut b = self.body();
        let phases = arr(&mut b, "phases");
        let word = phase_word(p);
        if phases.last().is_some_and(|l| l["kind"] == word) {
            return; // v2: the same stage told twice is one stage
        }
        close_last(phases, at);
        phases.push(json!({ "kind": word, "at": at }));
    }

    pub fn model(&self, asked: &str, answered: &str, first_byte_ms: Option<u32>) {
        let mut b = self.body();
        b["asked"] = json!(clean(asked, 200));
        b["answered"] = json!(clean(answered, 200));
        if let Some(ms) = first_byte_ms {
            b["first_byte_ms"] = json!(ms);
        }
    }

    pub fn note(&self, line: &str) {
        let at = now_ms();
        arr(&mut self.body(), "notes").push(json!({ "at": at, "text": clean(line, RESULT_MAX) }));
    }

    /// `live_touch`, `RunStep`.
    pub fn step(&self, step: &Step) {
        let n = self.number(step);
        self.record(step, n);
        let at = now_ms();
        if let Err(e) = self.store.live_touch(&self.run.0, n, at) {
            tracing::warn!("live_touch failed: {e}");
        }
        self.bus.publish(Event::RunStep {
            at,
            run: self.run.clone(),
            step: n,
            summary: one_line(step),
        });
    }

    /// Insert or update step `n` in the body (v2 `step`, then `done`).
    fn record(&self, step: &Step, n: u32) {
        let at = now_ms();
        let mut b = self.body();
        let steps = arr(&mut b, "steps");
        let idx = steps.iter().position(|s| s["n"] == n);
        let before = match idx {
            Some(i) => i.checked_sub(1).and_then(|p| steps.get(p)),
            None => steps.last(),
        };
        let backtrack = before.is_some_and(|p| p["ok"] == false);
        let i = idx.unwrap_or_else(|| {
            steps.push(json!({ "n": n, "at": at }));
            steps.len() - 1
        });
        let slot = &mut steps[i];
        slot["name"] = json!(clean(&step.name, 200));
        slot["args"] = redact_json(&Value::Object(step.args.clone()));
        if backtrack {
            slot["backtrack"] = json!(true);
        }
        if let Some(o) = &step.outcome {
            slot["ok"] = json!(o.ok);
            slot["text"] = json!(clean(&o.text, RESULT_MAX));
            let began = slot["at"].as_i64().unwrap_or(at);
            slot["ms"] = json!(at - began);
        }
    }

    /// One audit row. `gate`: "run" | "ask" | "blocked" | "checker".
    pub fn audited(
        &self,
        step: &Step,
        plugin: Option<&str>,
        gate: &str,
        decision: &str,
        why: Option<&str>,
    ) -> Result<i64> {
        let n = self.number(step);
        self.record(step, n);
        let out = step.outcome.as_ref();
        Ok(self.store.audit(&AuditRow {
            id: 0,
            at: now_ms(),
            run: self.run.0.clone(),
            session: Some(self.session),
            origin: origin_json(&self.origin),
            step: n,
            tool: clean(&step.name, 200),
            plugin: plugin.map(str::to_owned),
            args: redact_json(&Value::Object(step.args.clone())).to_string(),
            gate: gate.to_owned(),
            decision: decision.to_owned(),
            why: why.map(|w| clean(w, RESULT_MAX)),
            ok: out.map(|o| o.ok),
            result: out.map(|o| clean(&o.text, RESULT_MAX)),
            undo: out
                .and_then(|o| o.undo.as_ref())
                .map(|u| redact_json(&json!(u)).to_string()),
            undone_at: None,
        })?)
    }

    /// `save_run`, `live_end`, `RunEnded`; then prune to the newest 200 and 30 days.
    pub fn end(self, end: &RunEnd) -> Result<()> {
        let at = now_ms();
        let (ended, outcome, why) = match end {
            RunEnd::Answered => ("answered", RunOutcome::Done, None),
            RunEnd::Stopped => ("stopped", RunOutcome::Stopped, None),
            RunEnd::Ceiling => ("ceiling", RunOutcome::Limit, None),
            RunEnd::Refused(w) => ("refused", RunOutcome::Failed, Some(clean(w, RESULT_MAX))),
        };
        let (started, body) = {
            let mut b = self.body();
            close_last(arr(&mut b, "phases"), at);
            b["until"] = json!(at);
            b["ended"] = json!(ended);
            if let Some(w) = why {
                b["why"] = json!(w);
            }
            (b["at"].as_i64().unwrap_or(at), b.clone())
        };
        let id = &self.run.0;
        let saved = self.store.save_run(id, started, &body);
        // The live row goes whether or not the save worked: the run is over either way.
        let gone = self.store.live_end(id);
        self.bus.publish(Event::RunEnded {
            at,
            run: self.run.clone(),
            outcome,
        });
        saved?;
        gone?;
        self.store
            .prune_runs(at - KEPT_DAYS * 24 * 3600 * 1000, KEPT)?;
        Ok(())
    }
}

/// v2's one-line summary of a step: what it is and what it was given, redacted and short.
fn one_line(step: &Step) -> String {
    let args = if step.args.is_empty() {
        String::new()
    } else {
        format!(" {}", redact_json(&Value::Object(step.args.clone())))
    };
    clean(&format!("{}{}", step.name, args), 120)
}

pub struct ActivityRow {
    pub at: Ms,
    pub run: String,
    pub tool: String,
    pub decision: String,
    pub ok: Option<bool>,
    pub summary: String,
}

/// The audit log, newest first; `query` is matched against tool, args, why and result.
pub fn activity(store: &Store, query: Option<&str>, limit: u32) -> Result<Vec<ActivityRow>> {
    Ok(store
        .audit_search(query.unwrap_or(""), limit)?
        .into_iter()
        .map(|r| ActivityRow {
            at: r.at,
            run: r.run,
            tool: r.tool,
            decision: r.decision,
            ok: r.ok,
            summary: clean(
                r.why.as_deref().or(r.result.as_deref()).unwrap_or(&r.args),
                200,
            ),
        })
        .collect())
}

/// v2 `took`: `3 s`, `2 min 5 s`.
pub fn took(ms: i64) -> String {
    if ms < 1000 {
        return "under a second".into();
    }
    let s = (ms + 500) / 1000;
    match (s / 60, s % 60) {
        (0, s) => format!("{s} s"),
        (m, 0) => format!("{m} min"),
        (m, s) => format!("{m} min {s} s"),
    }
}

/// v2 `ending`: how a run ended, in words.
pub fn ending(body: &Value) -> &'static str {
    match body["ended"].as_str() {
        None => "Still going",
        Some("answered") => "Finished",
        Some("stopped") => "Stopped",
        Some("ceiling") => "Stopped at the step limit",
        Some("paused") => "Paused for a paid model",
        Some(_) => {
            let asked = body["steps"].as_array().is_some_and(|s| !s.is_empty())
                || body["answered"].is_string();
            if asked {
                "The AI service failed"
            } else {
                "No model could take it"
            }
        }
    }
}

/// v2 `summary`: the run in a few sentences.
pub fn summary(body: &Value) -> String {
    let long = match (body["at"].as_i64(), body["until"].as_i64()) {
        (Some(a), Some(u)) => took(u - a),
        _ => String::new(),
    };
    let mut lines = vec![match body["ended"].as_str() {
        None => "Still going.".to_owned(),
        Some("answered") => match body["answered"].as_str() {
            Some(m) => format!("Answered by {m} in {long}."),
            None => format!("Answered in {long}."),
        },
        Some("stopped") => format!("Stopped after {long}, before it had finished."),
        Some("ceiling") => format!(
            "Stopped after {} steps, which is the most one task may take.",
            body["steps"].as_array().map_or(0, Vec::len)
        ),
        Some(_) => format!("{}.", ending(body)),
    }];
    if let Some(w) = body["why"].as_str().filter(|w| !w.trim().is_empty()) {
        lines.push(w.trim().to_owned());
    }
    if let (Some(a), Some(b)) = (body["asked"].as_str(), body["answered"].as_str()) {
        if a != b {
            lines.push(format!(
                "{a} was asked first and could not answer, so {b} did."
            ));
        }
    }
    let steps = body["steps"].as_array().cloned().unwrap_or_default();
    if !steps.is_empty() {
        let mut uses: Vec<(String, usize)> = Vec::new();
        for s in &steps {
            let name = s["name"].as_str().unwrap_or("?");
            match uses.iter_mut().find(|(n, _)| n == name) {
                Some(u) => u.1 += 1,
                None => uses.push((name.to_owned(), 1)),
            }
        }
        let said: Vec<String> = uses
            .iter()
            .map(|(n, c)| {
                if *c > 1 {
                    format!("{n} ({c} times)")
                } else {
                    n.clone()
                }
            })
            .collect();
        lines.push(format!(
            "Used {} tool{}: {}.",
            uses.len(),
            if uses.len() == 1 { "" } else { "s" },
            listed(&said)
        ));
        let failed = steps.iter().filter(|s| s["ok"] == false).count();
        if failed > 0 {
            lines.push(format!(
                "{failed} {} failed.",
                if failed == 1 { "step" } else { "steps" }
            ));
        }
    }
    lines.join("\n")
}

fn listed(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// v2 `asText`: the run as a person reads it, step by step with each decision and why.
pub fn replay(store: &Store, run: &str) -> Result<Option<String>> {
    let Some(body) = store.run_body(run)? else {
        return Ok(None);
    };
    let audit = store.audit_for_run(run)?;
    let steps = body["steps"].as_array().cloned().unwrap_or_default();
    let mut out = vec![
        format!("# Run {run}"),
        String::new(),
        format!(
            "{} step{} · {}",
            steps.len(),
            if steps.len() == 1 { "" } else { "s" },
            if body["ended"].is_null() {
                "unfinished".to_owned()
            } else {
                ending(&body).to_lowercase()
            }
        ),
    ];
    match (body["asked"].as_str(), body["answered"].as_str()) {
        (Some(a), Some(b)) if a != b => {
            out.push(format!("asked {a}, answered {b} — the router fell back"));
        }
        (_, Some(b)) => out.push(format!("model {b}")),
        _ => {}
    }
    if let Some(w) = body["why"].as_str() {
        out.extend([String::new(), w.to_owned()]);
    }
    for n in body["notes"].as_array().into_iter().flatten() {
        out.push(format!("note: {}", n["text"].as_str().unwrap_or("")));
    }
    let phases = body["phases"].as_array().cloned().unwrap_or_default();
    if !phases.is_empty() {
        out.extend([String::new(), "## Where the time went".into()]);
        for p in &phases {
            let lasted = match p["ms"].as_i64() {
                Some(ms) => format!("{}.{}s", ms / 1000, ms % 1000 / 100),
                None if body["ended"].is_null() => "still going".into(),
                None => "did not finish".into(),
            };
            out.push(format!("  {lasted}  {}", p["kind"].as_str().unwrap_or("")));
        }
    }
    for s in &steps {
        let n = s["n"].as_u64().unwrap_or(0);
        let args = s["args"].as_object().cloned().unwrap_or_else(Map::new);
        out.extend([
            String::new(),
            format!(
                "## {n}. {}{}",
                s["name"].as_str().unwrap_or(""),
                if s["backtrack"] == true {
                    "  (retrying after a failure)"
                } else {
                    ""
                }
            ),
            format!("args: {}", Value::Object(args)),
        ]);
        for a in audit.iter().filter(|a| u64::from(a.step) == n) {
            let why = a.why.as_deref().map_or(String::new(), |w| format!(": {w}"));
            out.push(format!("{} -> {}{why}", a.gate, a.decision));
        }
        let state = match s["ok"].as_bool() {
            None => "did not finish",
            Some(true) => "ok",
            Some(false) => "failed",
        };
        out.push(match s["ms"].as_i64() {
            Some(ms) => format!("{state} · {ms}ms"),
            None => state.to_owned(),
        });
        if let Some(t) = s["text"].as_str().filter(|t| !t.is_empty()) {
            out.extend([String::new(), t.to_owned()]);
        }
    }
    Ok(Some(out.join("\n") + "\n"))
}
