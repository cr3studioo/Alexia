// SPDX-License-Identifier: AGPL-3.0-only
//! Learned skills: the "Learn this" offer and edits (INVENTORY B4).
//!
//! A port of v2 `learned.ts` and serve.ts 2837–2906 and 3900–3910. After a task that worked
//! something out, the episode is held (never acted on) and the window is offered "Learn
//! this?". A yes sends it to the free models through the router, and what comes back is held
//! to the same rules a downloaded skill is, then written into `layout.skills()` marked as
//! learned. Nothing is written and no model is asked until somebody says yes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use alexia_core::router::StepAsk;
use alexia_core::{Budget, ChatChunk, ChatRequest, Job};
use alexia_store::{MessageBody, Role, SessionId};
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use axum::{Extension, Router};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::gate::Sent;
use crate::{board, json, Api};

/// v2 `ENOUGH_STEPS`: below this, nothing was worked out.
const ENOUGH_STEPS: usize = 3;

/// v2 `NAME`, the folder-name rule a skill's name is held to.
fn good_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// One step of an episode, as the trace kept it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EpisodeStep {
    pub n: u64,
    pub name: String,
    pub args: Value,
    pub ok: Option<bool>,
    pub text: Option<String>,
}

/// v2 `Episode`: what the user asked, the steps, and the answer it ended on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Episode {
    pub task: String,
    pub steps: Vec<EpisodeStep>,
    pub answer: String,
}

/// v2 `learnable`: enough steps, something worked, and either a recovered failure or enough
/// distinct tools that their order was a decision.
pub(crate) fn learnable(e: &Episode) -> bool {
    let steps = &e.steps;
    if steps.len() < ENOUGH_STEPS {
        return false;
    }
    if !steps.iter().any(|s| s.ok == Some(true)) {
        return false;
    }
    let recovered = steps.iter().any(|s| s.ok == Some(false))
        && steps.last().is_some_and(|s| s.ok == Some(true));
    let mut distinct: Vec<&str> = steps.iter().map(|s| s.name.as_str()).collect();
    distinct.sort_unstable();
    distinct.dedup();
    recovered || distinct.len() >= ENOUGH_STEPS
}

/// v2 `outline`: "5 steps, using a, b, c and 2 more".
pub(crate) fn outline(e: &Episode) -> String {
    let mut tools: Vec<&str> = Vec::new();
    for s in &e.steps {
        if !tools.contains(&s.name.as_str()) {
            tools.push(&s.name);
        }
    }
    let shown = tools.iter().take(3).copied().collect::<Vec<_>>().join(", ");
    let more = if tools.len() > 3 {
        format!(" and {} more", tools.len() - 3)
    } else {
        String::new()
    };
    format!("{} steps, using {shown}{more}", e.steps.len())
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// v2 `transcript`: the task, each step and what came back, trimmed.
fn transcript(e: &Episode) -> String {
    let mut lines = vec![
        format!("The user asked: {}", e.task),
        String::new(),
        "What happened, step by step:".to_owned(),
    ];
    for s in &e.steps {
        lines.push(format!(
            "{}. {}({}) -> {}{}",
            s.n,
            s.name,
            cut(&s.args.to_string(), 300),
            if s.ok == Some(false) { "FAILED: " } else { "" },
            cut(s.text.as_deref().unwrap_or("(no answer)"), 400)
        ));
    }
    lines.push(String::new());
    lines.push(format!("It finished by saying: {}", cut(&e.answer, 800)));
    lines.join("\n")
}

/// v2 `BRIEF`, word for word.
const BRIEF: &str =
    "You turn one recorded episode into a reusable skill, in the agentskills.io format.

A trajectory is not a skill. What happened once is full of incidental detail, dead ends and
mistakes; what you write must be a *procedure* — what to do, when it applies, and what to
check along the way. Drop everything specific to this run: exact paths, exact filenames,
exact numbers, the wrong turns. Keep the decisions that would be the same next time.

Answer with a Markdown document and nothing else, in exactly this shape:

---
name: lowercase-hyphenated-name
description: What this is for and WHEN to use it, in one or two sentences. The \"when\" is
  what decides whether it is ever opened, so it must name the situation.
---

The procedure. Numbered steps, plain sentences, under 300 words.

If nothing here generalises — if it was a one-off, or trivial, or it mostly failed —
answer with exactly: NOTHING TO LEARN";

/// v2 `Distilled`: the name, the description and the whole file.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Distilled {
    pub name: String,
    pub description: String,
    pub document: String,
}

/// v2 `parse`: what came back, held to the rules a downloaded skill is held to.
pub(crate) fn parse(said: &str) -> Result<Distilled, String> {
    let mut body = said.trim();
    for fence in ["```markdown", "```md", "```"] {
        if let Some(rest) = body.strip_prefix(fence) {
            body = rest.trim_start_matches(['\r', '\n']);
            break;
        }
    }
    let body = body.trim_end().strip_suffix("```").unwrap_or(body).trim();
    let no_front =
        || "The model did not write a skill with frontmatter, so nothing was saved.".to_owned();
    let mut lines = body.split_inclusive('\n');
    if lines.next().map(str::trim_end) != Some("---") {
        return Err(no_front());
    }
    let mut front: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        front.push(line.trim_end_matches(['\r', '\n']));
    }
    if !closed {
        return Err(no_front());
    }
    let mut name = None;
    let mut description: Option<String> = None;
    let mut in_description = false;
    for line in &front {
        let top = !line.starts_with([' ', '\t']);
        if top {
            in_description = false;
            if let Some(v) = line.strip_prefix("name:") {
                name = Some(v.trim().to_owned());
            } else if let Some(v) = line.strip_prefix("description:") {
                description = Some(v.trim().to_owned());
                in_description = true;
            }
        } else if in_description {
            if let Some(d) = description.as_mut() {
                d.push(' ');
                d.push_str(line.trim());
            }
        }
    }
    let name = name.unwrap_or_default();
    if !good_name(&name) {
        return Err(format!(
            "“{name}” is not a usable skill name, so nothing was saved."
        ));
    }
    let description = description
        .map(|d| d.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if description.is_empty() {
        return Err("The skill it wrote has no description, so nothing would ever read it.".into());
    }
    Ok(Distilled {
        name,
        description,
        document: body.to_owned(),
    })
}

/// v2 `distil`, through the router's free models (a planning job: larger models first).
pub(crate) async fn distil(api: &Api, e: &Episode) -> Result<Distilled, String> {
    let user: MessageBody =
        serde_json::from_value(json!({ "content": transcript(e) })).map_err(|e| e.to_string())?;
    let req = ChatRequest {
        messages: vec![(Role::User, user)],
        system: Some(BRIEF.to_owned()),
        tools: vec![],
        max_tokens: Some(1200),
    };
    let ask = StepAsk {
        job: Job::Plan,
        avoid: vec![],
        plugin: None,
        run: None,
        session: None,
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    let collect = async move {
        let mut said = String::new();
        while let Some(chunk) = rx.recv().await {
            if let ChatChunk::Text(t) = chunk {
                said.push_str(&t);
            }
        }
        said
    };
    let asking = api
        .parts
        .router
        .step(&req, &ask, Budget::CHAT, tx, CancellationToken::new());
    let (done, said) = tokio::join!(asking, collect);
    if let Err(e) = done {
        return Err(e.to_string());
    }
    let said = said.trim();
    if said
        .get(..16)
        .is_some_and(|s| s.eq_ignore_ascii_case("NOTHING TO LEARN"))
    {
        return Err("There was nothing in that worth keeping for next time.".into());
    }
    parse(said)
}

/// v2 `save`: written into `skills_dir/<name>/SKILL.md`, marked as learned, with the date and
/// the task it came out of.
pub(crate) fn save(
    skills_dir: &Path,
    learned: &Distilled,
    from: Option<&str>,
) -> std::io::Result<PathBuf> {
    let dir = skills_dir.join(&learned.name);
    std::fs::create_dir_all(&dir)?;
    let source = from
        .map(|f| cut(&f.split_whitespace().collect::<Vec<_>>().join(" "), 200))
        .filter(|s| !s.is_empty());
    let today = chrono::Utc::now().format("%Y-%m-%d");
    let mut head = format!("---\nmetadata:\n  learned: true\n  learned_at: {today}\n");
    if let Some(s) = source {
        head.push_str(&format!("  learned_from: {}\n", json!(s)));
    }
    let rest = learned
        .document
        .strip_prefix("---\r\n")
        .or_else(|| learned.document.strip_prefix("---\n"))
        .unwrap_or(&learned.document);
    std::fs::write(dir.join("SKILL.md"), format!("{head}{rest}\n"))?;
    Ok(dir)
}

/// v2 `forget`: the folder goes. True when there was one to remove.
pub(crate) fn forget(skills_dir: &Path, name: &str) -> bool {
    if !good_name(name) {
        return false;
    }
    let dir = skills_dir.join(name);
    dir.is_dir() && std::fs::remove_dir_all(&dir).is_ok()
}

/// Registers this area's INVENTORY rows (path + method).
pub(crate) fn routes() -> Router<Arc<Api>> {
    Router::new().route("/api/learn", post(learn))
}

fn text_of(sent: &serde_json::Map<String, Value>, key: &str) -> String {
    sent.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// serve.ts 2837–2906.
async fn learn(State(api): State<Arc<Api>>, Extension(Sent(sent)): Extension<Sent>) -> Response {
    let action = text_of(&sent, "action");
    let name = text_of(&sent, "name");
    let skills_dir = api.parts.layout.skills();

    if action == "forget" {
        let gone = forget(&skills_dir, &name);
        if gone {
            board::forget_consent(&api, &name);
        }
        return json::ok(json!({
            "ok": gone,
            "said": if gone { format!("Forgotten. {name} is gone.") } else { "There is no skill by that name.".into() },
        }));
    }

    if action == "edit" {
        // Only a learned one: a skill somebody installed belongs to whoever wrote it.
        let Some(skill) = board::skills_of(&api)
            .into_iter()
            .find(|s| s.name == name && s.learned && s.dir.starts_with(&skills_dir))
        else {
            return json::ok(json!({
                "ok": false,
                "said": "That is not a skill Alexia wrote, so it is not editable here.",
            }));
        };
        let file = skill.dir.join("SKILL.md");
        let text = text_of(&sent, "text");
        if !text.trim().is_empty() {
            return match std::fs::write(&file, format!("{}\n", text.trim())) {
                Ok(()) => json::ok(json!({ "ok": true, "said": "Saved." })),
                Err(e) => {
                    json::ok(json!({ "ok": false, "said": format!("Could not save it: {e}") }))
                }
            };
        }
        return match std::fs::read_to_string(&file) {
            Ok(text) => json::ok(json!({ "ok": true, "text": text })),
            Err(e) => json::ok(json!({ "ok": false, "said": format!("Could not read it: {e}") })),
        };
    }

    let Some(episode) = api.board.take_lesson() else {
        return json::ok(json!({ "ok": false, "said": "There is nothing waiting to be learned." }));
    };
    let learned = match distil(&api, &episode).await {
        Ok(l) => l,
        Err(why) => return json::ok(json!({ "ok": false, "said": why })),
    };
    if let Err(e) = save(&skills_dir, &learned, Some(&episode.task)) {
        return json::ok(json!({ "ok": false, "said": format!("Could not save it: {e}") }));
    }
    // Written at creation, the one moment anything knows this for certain (M6-9). Nobody
    // asked for this skill, so it waits for a yes like any other.
    board::record_provenance(&api, &learned.name, "learned");
    json::ok(json!({
        "ok": true,
        "name": learned.name,
        "said": format!("Learned: {}. {}", learned.name, learned.description),
    }))
}

/// The newest run of `session` whose steps the trace kept, as an episode.
fn episode_of(api: &Api, session: SessionId, task: &str, answer: &str) -> Option<Episode> {
    let store = &api.parts.store;
    let runs = store.runs(10).ok()?;
    for (id, _, body) in runs {
        let ours = store
            .audit_for_run(&id)
            .ok()?
            .iter()
            .any(|a| a.session == Some(session));
        if !ours {
            continue;
        }
        let steps = body["steps"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| EpisodeStep {
                        n: s["n"].as_u64().unwrap_or(0),
                        name: s["name"].as_str().unwrap_or("").to_owned(),
                        args: s["args"].clone(),
                        ok: s["ok"].as_bool(),
                        text: s["text"].as_str().map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default();
        return Some(Episode {
            task: task.to_owned(),
            steps,
            answer: answer.to_owned(),
        });
    }
    None
}

/// The `learn` frame's body after a task, or None when there is nothing to offer (serve.ts
/// 3906–3910). The episode is held in `api.board` until `/api/learn` says yes, and a later
/// offer replaces it.
pub(crate) fn offer(
    api: &Api,
    session: SessionId,
    task: &str,
    steps: usize,
    answer: &str,
) -> Option<Value> {
    if steps < ENOUGH_STEPS || crate::private::is_private(&api.parts.store, session) {
        return None;
    }
    let episode = episode_of(api, session, task, answer)?;
    if !learnable(&episode) {
        return None;
    }
    let v = json!({ "about": cut(task, 120), "outline": outline(&episode) });
    api.board.hold_lesson(episode);
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(n: u64, name: &str, ok: Option<bool>) -> EpisodeStep {
        EpisodeStep {
            n,
            name: name.into(),
            args: json!({}),
            ok,
            text: Some("t".into()),
        }
    }

    fn episode(steps: Vec<EpisodeStep>) -> Episode {
        Episode {
            task: "do it".into(),
            steps,
            answer: "done".into(),
        }
    }

    #[test]
    fn learnable_as_v2() {
        let few = episode(vec![step(1, "a", Some(true)), step(2, "b", Some(true))]);
        assert!(!learnable(&few));
        let all_failed = episode(vec![
            step(1, "a", Some(false)),
            step(2, "b", Some(false)),
            step(3, "c", Some(false)),
        ]);
        assert!(!learnable(&all_failed));
        let distinct = episode(vec![
            step(1, "a", Some(true)),
            step(2, "b", Some(true)),
            step(3, "c", Some(true)),
        ]);
        assert!(learnable(&distinct));
        let recovered = episode(vec![
            step(1, "a", Some(false)),
            step(2, "a", Some(true)),
            step(3, "a", Some(true)),
        ]);
        assert!(learnable(&recovered));
        let same = episode(vec![
            step(1, "a", Some(true)),
            step(2, "a", Some(true)),
            step(3, "a", Some(true)),
        ]);
        assert!(!learnable(&same));
        assert_eq!(outline(&distinct), "3 steps, using a, b, c");
        let many = episode(
            (1..=5)
                .map(|n| step(n, &format!("t{n}"), Some(true)))
                .collect(),
        );
        assert_eq!(outline(&many), "5 steps, using t1, t2, t3 and 2 more");
    }

    #[test]
    fn parse_holds_the_rules() {
        let ok = parse("```markdown\n---\nname: tidy-folder\ndescription: Use when a folder\n  is a mess.\n---\n\n1. Sort.\n```").unwrap();
        assert_eq!(ok.name, "tidy-folder");
        assert_eq!(ok.description, "Use when a folder is a mess.");
        assert!(ok.document.starts_with("---\nname: tidy-folder"));
        assert!(parse("no frontmatter").is_err());
        assert!(parse("---\nname: Bad Name\ndescription: x\n---\n").is_err());
        assert!(parse("---\nname: fine\n---\n").is_err());
    }

    #[test]
    fn save_marks_and_forget_removes() {
        let dir = std::env::temp_dir().join(format!("alexia-learned-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let d = parse("---\nname: tidy-folder\ndescription: Use when.\n---\n\nBody.").unwrap();
        let at = save(&dir, &d, Some("tidy my\ndownloads")).unwrap();
        let text = std::fs::read_to_string(at.join("SKILL.md")).unwrap();
        assert!(text.starts_with("---\nmetadata:\n  learned: true\n  learned_at: "));
        assert!(text.contains("  learned_from: \"tidy my downloads\"\n"));
        assert!(text.contains("name: tidy-folder\n"));
        assert!(!forget(&dir, "../x"));
        assert!(forget(&dir, "tidy-folder"));
        assert!(!forget(&dir, "tidy-folder"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
