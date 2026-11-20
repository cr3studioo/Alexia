// SPDX-License-Identifier: AGPL-3.0-only
//! Trimming the step trace to fit a model's context. A port of v2 `packages/core/src/trim.ts`.
//!
//! Recent steps stay verbatim, older ones collapse into a running summary, raw tool output is
//! dropped once seen. An assistant turn with calls and the tool turns answering it are one
//! unit (a "cycle"): kept or collapsed together, never split, because every OpenAI-compatible
//! endpoint refuses a `tool` turn whose `tool_calls` are missing. The summary says what
//! worked, not only what happened, so a learned skill can be distilled from the same text.
//! Pure functions: no store, no async.

use alexia_store::{Content, MessageBody, Part, Role};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

type Msg = (Role, MessageBody);

/// Characters per token, v2 `trim.ts` `PER_TOKEN`. Three, not four: a trace is tool arguments,
/// JSON and paths, which tokenise denser than English; over-counting is the safe side.
pub const PER_TOKEN: usize = 3;

/// v2 `DEFAULTS`: assistant turns kept verbatim (two plan-act-observe cycles), characters of
/// tool output kept in a verbatim step, and the budget when no window is known.
const KEEP_TURNS: usize = 4;
const PER_RESULT: usize = 2_000;
const DEFAULT_BUDGET: usize = 24_000;

/// What a picture costs in characters, v2 `IMAGE_WEIGHT` (about 1500 tokens, not its URL).
const IMAGE_WEIGHT: usize = 5_000;

pub struct TrimOptions {
    /// In characters. `None` is v2's fixed default, 24,000.
    pub budget: Option<usize>,
    /// Messages always kept at the end (v2's default).
    pub keep: usize,
}

impl Default for TrimOptions {
    /// v2's.
    fn default() -> TrimOptions {
        TrimOptions {
            budget: Some(DEFAULT_BUDGET),
            keep: KEEP_TURNS,
        }
    }
}

/// The character budget for a model's window: a quarter of it, in characters (v2 `budgetFor`).
/// A model that publishes no window (0) gets the fixed default, not zero.
pub fn budget_for(context: u32) -> usize {
    if context > 0 {
        (f64::from(context) * PER_TOKEN as f64 * 0.25).round() as usize
    } else {
        DEFAULT_BUDGET
    }
}

fn text_of(m: &Msg) -> String {
    m.1.content.text()
}

fn images_in(m: &Msg) -> Vec<Part> {
    match &m.1.content {
        Content::Text(_) => Vec::new(),
        Content::Parts(parts) => parts
            .iter()
            .filter(|p| matches!(p, Part::Image { .. }))
            .cloned()
            .collect(),
    }
}

fn calls_of(m: &Msg) -> &[alexia_store::ToolCall] {
    m.1.calls.as_deref().unwrap_or(&[])
}

/// The same message with its text replaced and its pictures kept (v2 `withText`).
fn with_text(m: &Msg, text: String) -> Msg {
    let mut out = m.clone();
    out.1.content = match &m.1.content {
        Content::Text(_) => Content::Text(text),
        Content::Parts(_) => {
            let mut parts = vec![Part::Text { text }];
            parts.extend(images_in(m));
            Content::Parts(parts)
        }
    };
    out
}

fn plain(role: Role, content: String) -> Msg {
    (
        role,
        MessageBody {
            content: Content::Text(content),
            calls: None,
            call_id: None,
            provider: None,
            notes: None,
            bad: None,
            stopped: None,
            typed: None,
            extra: Map::new(),
        },
    )
}

/// One assistant turn and the tool turns answering it. The unit that is never split.
struct Cycle {
    assistant: Msg,
    results: Vec<Msg>,
    /// The sub-goal this cycle serves: a turn that said something opens a new one.
    goal: usize,
}

/// Everything before the first assistant-with-calls is the conversation (never collapsed).
fn split(messages: &[Msg]) -> (Vec<Msg>, Vec<Cycle>) {
    let mut head = Vec::new();
    let mut cycles: Vec<Cycle> = Vec::new();
    let mut goal = 0;
    let mut tag = |m: &Msg| {
        if !text_of(m).trim().is_empty() {
            goal += 1;
        }
        goal
    };
    for m in messages {
        if m.0 == Role::Assistant && !calls_of(m).is_empty() {
            let goal = tag(m);
            cycles.push(Cycle {
                assistant: m.clone(),
                results: Vec::new(),
                goal,
            });
            continue;
        }
        if m.0 == Role::Tool {
            if let Some(open) = cycles.last_mut() {
                open.results.push(m.clone());
                continue;
            }
        }
        if cycles.is_empty() {
            head.push(m.clone());
        } else {
            let goal = tag(m);
            cycles.push(Cycle {
                assistant: m.clone(),
                results: Vec::new(),
                goal,
            });
        }
    }
    (head, cycles)
}

fn flat(c: &Cycle) -> impl Iterator<Item = &Msg> {
    std::iter::once(&c.assistant).chain(c.results.iter())
}

/// The part of a trace that can never be collapsed: the head plus the newest cycle.
pub fn floor(messages: &[Msg]) -> Vec<Msg> {
    let (mut head, cycles) = split(messages);
    if let Some(newest) = cycles.last() {
        head.extend(flat(newest).cloned());
    }
    head
}

/// What a task learned, as lines: one summary for trimming and for skill distillation.
pub fn summary(messages: &[Msg]) -> String {
    lines(&split(messages).1).join("\n")
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

/// Tool names that change what they point at / that ask again for the same answer (v2 `WRITES`
/// / `READS`). ponytail: verb lists read off the name, not a property of the tool; read it off
/// the manifest the day one carries it.
fn writes(name: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(?:^|[^a-z])(?:write|edit|create|update|append|save|patch|delete|remove|move|rename|set)",
    )
    .is_match(name)
}

fn reads(name: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(?:^|[^a-z])(?:read|get|list|show|view|cat|open|fetch|load|search|find|grep|look)",
    )
    .is_match(name)
}

/// Arguments as an object. Anything else is no arguments.
fn fields(raw: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

/// Two calls are about the same thing if they agree on every argument they both name, and
/// there is at least one. Two no-argument calls match only if they are the same tool.
fn about(a: &Map<String, Value>, b: &Map<String, Value>, same_name: bool) -> bool {
    let shared: Vec<&String> = a.keys().filter(|k| b.contains_key(*k)).collect();
    if shared.is_empty() {
        return same_name && a.is_empty() && b.is_empty();
    }
    shared.iter().all(|k| a[*k] == b[*k])
}

/// The mechanical collapse (§11.3), run before anything is measured: a result that a later
/// call already answered becomes "superseded by a later X". Messages are never removed, so
/// pairing holds. The newest cycle is never touched.
pub fn collapse(messages: &[Msg]) -> Vec<Msg> {
    struct Made {
        id: String,
        name: String,
        at: usize,
        args: Map<String, Value>,
    }
    let planning: Vec<usize> = (0..messages.len())
        .filter(|&i| !calls_of(&messages[i]).is_empty())
        .collect();
    let newest = planning.last().copied();
    let made: Vec<Made> = planning
        .iter()
        .flat_map(|&at| {
            calls_of(&messages[at]).iter().map(move |c| Made {
                id: c.id.clone(),
                name: c.name.clone(),
                at,
                args: fields(&c.arguments),
            })
        })
        .collect();

    let mut spent: HashMap<&str, String> = HashMap::new();
    for (i, call) in made.iter().enumerate() {
        if Some(call.at) == newest {
            continue;
        }
        let later = made[i + 1..].iter().find(|next| {
            about(&call.args, &next.args, next.name == call.name)
                && (next.name == call.name || writes(&next.name))
        });
        if let Some(next) = later {
            spent.insert(&call.id, format!("superseded by a later {}", next.name));
        }
    }
    if spent.is_empty() {
        return messages.to_vec();
    }
    messages
        .iter()
        .map(|m| {
            let said = match (&m.0, &m.1.call_id) {
                (Role::Tool, Some(id)) => spent.get(id.as_str()),
                _ => None,
            };
            match said {
                Some(text) => {
                    let mut out = m.clone();
                    out.1.content = Content::Text(text.clone());
                    out
                }
                None => m.clone(),
            }
        })
        .collect()
}

/// Fit `messages` into `opts.budget` characters (v2 `trim`). The head, the newest cycle and
/// the last user turn are always kept; assistant+tool pairs are kept or dropped together.
pub fn trim(messages: &[Msg], opts: &TrimOptions) -> Vec<Msg> {
    let budget = opts.budget.unwrap_or(DEFAULT_BUDGET);
    let (head, cycles) = split(&collapse(messages));
    let n = cycles.len();
    // The step just taken is shown exactly as it came back. Everything else is a cache.
    let laid = |from: usize| -> Vec<Msg> {
        cycles[from..]
            .iter()
            .enumerate()
            .flat_map(|(i, c)| {
                let newest = from + i == n - 1;
                std::iter::once(c.assistant.clone()).chain(c.results.iter().map(move |r| {
                    if newest {
                        clip(r, PER_RESULT)
                    } else {
                        shrink(c, r, PER_RESULT)
                    }
                }))
            })
            .collect()
    };

    let mut whole = head.clone();
    if n > 0 {
        whole.extend(laid(0));
    }

    // The last user turn after the trace began is never collapsed: it is what is being asked.
    let floor_keep = cycles
        .iter()
        .rposition(|c| c.assistant.0 == Role::User)
        .map_or(1, |at| n - at);
    let mut keep = opts.keep.min(n).max(floor_keep.min(n));
    loop {
        let built = if n > keep {
            let mut b = head.clone();
            b.push(summarise(&cycles[..n - keep]));
            b.extend(laid(n - keep));
            b
        } else {
            whole.clone()
        };
        // Under budget, or nothing left to give up.
        if size(&built) <= budget || keep <= floor_keep.max(1) {
            return smaller(built, whole);
        }
        keep -= 1;
    }
}

/// Trimming never makes it bigger: where summarising does not pay, the steps stay.
fn smaller(built: Vec<Msg>, whole: Vec<Msg>) -> Vec<Msg> {
    if size(&built) < size(&whole) {
        built
    } else {
        whole
    }
}

/// The running summary: one line per step, saying what was tried and whether it worked.
/// Arguments are kept (they make a step repeatable); raw output is not.
fn lines(cycles: &[Cycle]) -> Vec<String> {
    let groups = runs(cycles);
    let mut out = Vec::new();
    for (at, group) in groups.iter().enumerate() {
        for cycle in group {
            let said = text_of(&cycle.assistant);
            if !said.trim().is_empty() {
                out.push(format!("Said: {}", one_line(&said, 200)));
            }
        }
        let steps: Vec<(String, bool)> = group.iter().flat_map(|c| told(c)).collect();
        // A closed sub-goal that ended on success collapses to that step; one that ended on a
        // failure keeps every step (the dead ends are the finding). The last run is open.
        match steps.last() {
            Some((line, true)) if at < groups.len() - 1 => out.push(line.clone()),
            _ => out.extend(steps.into_iter().map(|(line, _)| line)),
        }
    }
    out
}

/// The cycles of each sub-goal, in order; contiguous because the tag only moves forward.
fn runs(cycles: &[Cycle]) -> Vec<Vec<&Cycle>> {
    let mut out: Vec<Vec<&Cycle>> = Vec::new();
    for c in cycles {
        match out.last_mut() {
            Some(open) if open[0].goal == c.goal => open.push(c),
            _ => out.push(vec![c]),
        }
    }
    out
}

/// One line per call a cycle made, and whether it worked.
fn told(c: &Cycle) -> Vec<(String, bool)> {
    calls_of(&c.assistant)
        .iter()
        .map(|call| {
            let came = c
                .results
                .iter()
                .find(|r| r.1.call_id.as_deref() == Some(&call.id))
                .map_or(String::new(), |r| one_line(&text_of(r), 160));
            let ok = worked(&came);
            let shown = if came.is_empty() { "no output" } else { &came };
            (
                format!(
                    "{}: {}({}) — {}",
                    if ok { "Worked" } else { "Failed" },
                    call.name,
                    one_line(&call.arguments, 120),
                    shown
                ),
                ok,
            )
        })
        .collect()
}

fn summarise(cycles: &[Cycle]) -> Msg {
    let mut all = vec!["Earlier steps in this task, summarised:".to_string()];
    all.extend(lines(cycles));
    plain(Role::System, all.join("\n"))
}

/// Did it work? Read off the outcome text core itself wrote.
/// ponytail: re-derived from prose; carry `ok` on the tool message when M4-5 needs certainty.
fn worked(said: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let failed = re(
        &R,
        r"(?i)^(?:not allowed|there is no tool|the tool failed)\b|\bis gone —|\bfailed:",
    );
    !said.is_empty() && !failed.is_match(said)
}

/// Context is a cache, not a record (§11.4): a long result of a read-only call is replaced by
/// the call that gives it back. Anything that *did* something is clipped, never pointed at.
fn shrink(cycle: &Cycle, result: &Msg, limit: usize) -> Msg {
    let said = text_of(result);
    let len = said.encode_utf16().count();
    if len <= limit {
        return result.clone();
    }
    let call = calls_of(&cycle.assistant)
        .iter()
        .find(|c| result.1.call_id.as_deref() == Some(&c.id));
    match call {
        Some(c) if reads(&c.name) && !writes(&c.name) => with_text(
            result,
            format!(
                "{len} characters, not carried — read it again with {}({})",
                c.name,
                one_line(&c.arguments, 200)
            ),
        ),
        _ => clip(result, limit),
    }
}

/// Long tool output, middle removed. The ends are where the useful part usually is.
fn clip(m: &Msg, limit: usize) -> Msg {
    let said = text_of(m);
    let chars: Vec<char> = said.chars().collect();
    if chars.len() <= limit {
        return m.clone();
    }
    let half = limit.saturating_sub(40) / 2;
    let cut = chars.len() - limit;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    with_text(m, format!("{head}\n… {cut} characters cut …\n{tail}"))
}

fn one_line(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        flat
    } else {
        format!("{}…", flat.chars().take(limit).collect::<String>())
    }
}

/// Rough size in characters (v2 `size`). Tokens would need a tokeniser per model. Text counts
/// in UTF-16 units as v2's `.length` does; each image counts [`IMAGE_WEIGHT`], not its URL.
pub fn size(messages: &[Msg]) -> usize {
    messages
        .iter()
        .map(|m| {
            text_of(m).encode_utf16().count()
                + images_in(m).len() * IMAGE_WEIGHT
                + calls_of(m)
                    .iter()
                    .map(|c| c.arguments.encode_utf16().count() + c.name.encode_utf16().count())
                    .sum::<usize>()
        })
        .sum()
}
