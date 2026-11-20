// SPDX-License-Identifier: AGPL-3.0-only
//! Port of v2 `packages/core/test/trim.test.ts`, plus the pairing / budget / last-user tests.

use alexia_core::trim::{budget_for, collapse, floor, size, summary, trim, TrimOptions, PER_TOKEN};
use alexia_store::{Content, MessageBody, Part, Role, ToolCall};
use std::collections::HashSet;

type Msg = (Role, MessageBody);

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
        extra: Default::default(),
    }
}
fn text(role: Role, t: &str) -> Msg {
    (role, body(Content::Text(t.into())))
}
fn text_of(m: &Msg) -> String {
    m.1.content.text()
}
fn call(id: &str, name: &str, args: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args.into(),
    }
}
fn saying(n: usize, said: &str, name: &str, args: &str, came: &str) -> Vec<Msg> {
    let id = format!("c{n}");
    let mut a = body(Content::Text(said.into()));
    a.calls = Some(vec![call(&id, name, args)]);
    let mut t = body(Content::Text(came.into()));
    t.call_id = Some(id);
    vec![(Role::Assistant, a), (Role::Tool, t)]
}
fn cycle(n: usize, name: &str, args: &str, said: &str) -> Vec<Msg> {
    saying(n, "", name, args, said)
}
fn task() -> Msg {
    text(Role::User, "Tidy the notes folder.")
}
fn long(n: usize) -> Vec<Msg> {
    (0..n)
        .flat_map(|i| {
            cycle(
                i + 1,
                "files__read",
                &format!(r#"{{"name":"n{i}.txt"}}"#),
                &format!("contents of n{i} {}", "detail ".repeat(40)),
            )
        })
        .collect()
}
fn terse(n: usize) -> Vec<Msg> {
    (0..n)
        .flat_map(|i| {
            cycle(
                i + 1,
                "files__read",
                &format!(r#"{{"name":"n{i}.txt"}}"#),
                "ok",
            )
        })
        .collect()
}
fn with(mut head: Vec<Msg>, rest: Vec<Msg>) -> Vec<Msg> {
    head.extend(rest);
    head
}
fn opts(keep: usize, budget: Option<usize>) -> TrimOptions {
    TrimOptions { keep, budget }
}
fn tools(m: &[Msg]) -> Vec<&Msg> {
    m.iter().filter(|m| m.0 == Role::Tool).collect()
}
fn after(trace: &[Msg]) -> Vec<String> {
    collapse(trace)
        .iter()
        .filter(|m| m.0 == Role::Tool)
        .map(text_of)
        .collect()
}

#[test]
fn defaults_are_v2s() {
    let d = TrimOptions::default();
    assert_eq!((d.keep, d.budget), (4, Some(24_000)));
    assert_eq!(PER_TOKEN, 3);
}

#[test]
fn task_is_never_summarised() {
    let t = trim(&with(vec![task()], long(20)), &opts(2, None));
    assert_eq!(t[0], task());
}

#[test]
fn recent_stay_verbatim_older_become_summary() {
    let t = trim(&with(vec![task()], long(10)), &opts(3, None));
    let verbatim = tools(&t);
    assert_eq!(verbatim.len(), 3);
    assert!(text_of(verbatim.last().unwrap()).starts_with("contents of n9"));
    let s = t.iter().find(|m| m.0 == Role::System).expect("summary");
    let s = text_of(s);
    assert!(s.contains("Earlier steps in this task"));
    assert!(s.contains("files__read"));
}

#[test]
fn summary_records_what_worked() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__list", "{}", "notes.txt done.txt"),
            cycle(
                2,
                "files__read",
                r#"{"name":"archive.txt"}"#,
                "files__read failed: no such file",
            ),
            cycle(3, "files__read", r#"{"name":"notes.txt"}"#, "buy milk"),
            cycle(4, "files__write", "{}", "Done."),
        ]
        .concat(),
    );
    let d = summary(&trace);
    assert!(d.contains("Worked: files__list({})"));
    assert!(d.contains(r#"Failed: files__read({"name":"archive.txt"})"#));
    assert!(d.contains(r#"Worked: files__read({"name":"notes.txt"})"#));
}

fn assert_paired(t: &[Msg], label: &str) {
    let asked: HashSet<&str> = t
        .iter()
        .flat_map(|m| m.1.calls.iter().flatten().map(|c| c.id.as_str()))
        .collect();
    for m in t.iter().filter(|m| m.0 == Role::Tool) {
        assert!(
            asked.contains(m.1.call_id.as_deref().unwrap_or("")),
            "{label}: orphan tool result"
        );
    }
    let answered: HashSet<&str> = t
        .iter()
        .filter(|m| m.0 == Role::Tool)
        .filter_map(|m| m.1.call_id.as_deref())
        .collect();
    for id in asked {
        assert!(answered.contains(id), "{label}: call {id} lost its result");
    }
}

#[test]
fn pairs_never_split() {
    for keep in [0, 1, 2, 3, 7] {
        for budget in [None, Some(1), Some(3_000), Some(10_000)] {
            let t = trim(&with(vec![task()], long(9)), &opts(keep, budget));
            assert_paired(&t, &format!("keep {keep} budget {budget:?}"));
        }
    }
}

#[test]
fn raw_output_clipped_in_the_middle() {
    let huge = format!("START{}END", "x".repeat(5_000));
    let t = trim(
        &with(vec![task()], cycle(1, "files__read", "{}", &huge)),
        &opts(4, None),
    );
    let said = text_of(tools(&t)[0]);
    assert!(said.len() < 2_100);
    assert!(said.starts_with("START") && said.ends_with("END"));
    assert!(said.contains("characters cut"));
}

#[test]
fn over_budget_keeps_collapsing_never_the_last_step() {
    let trace = with(
        vec![task()],
        (0..20)
            .flat_map(|i| {
                cycle(
                    i + 1,
                    "files__read",
                    &format!(r#"{{"name":"n{i}.txt"}}"#),
                    &"x".repeat(1_000),
                )
            })
            .collect(),
    );
    let t = trim(&trace, &opts(10, Some(3_000)));
    assert!(size(&t) < size(&trace));
    assert!(!tools(&t).is_empty());
}

#[test]
fn trimming_never_makes_it_bigger() {
    let trace = with(vec![task()], terse(30));
    assert!(size(&trim(&trace, &opts(1, Some(100)))) <= size(&trace));
}

#[test]
fn short_trace_returned_as_is() {
    let trace = with(vec![task()], cycle(1, "files__list", "{}", "notes.txt"));
    assert_eq!(trim(&trace, &TrimOptions::default()), trace);
}

#[test]
fn bigger_window_bigger_budget() {
    assert!(budget_for(200_000) > budget_for(32_768));
    assert!(budget_for(32_768) >= 24_000);
    assert_eq!(budget_for(0), 24_000);
}

#[test]
fn wide_window_keeps_what_narrow_summarises() {
    let trace = with(vec![task()], long(200));
    let wide = trim(&trace, &opts(4, Some(budget_for(200_000))));
    let narrow = trim(&trace, &opts(4, Some(budget_for(32_768))));
    assert!(tools(&wide).len() > tools(&narrow).len());
    assert!(size(&wide) > size(&narrow));
}

#[test]
fn floor_is_head_plus_newest_cycle() {
    let trace = with(vec![task()], long(5));
    let kept = floor(&trace);
    assert_eq!(kept[0], task());
    assert_eq!(kept[1..], trace[trace.len() - 2..]);
    assert!(size(&kept) < size(&trace));
    assert!(size(&kept) <= size(&trim(&trace, &opts(4, Some(1)))));
}

#[test]
fn errored_then_retried_loses_the_error() {
    let trace = with(
        vec![task()],
        [
            cycle(
                1,
                "files__read",
                r#"{"name":"notes.txt"}"#,
                "files__read failed: locked",
            ),
            cycle(2, "files__read", r#"{"name":"notes.txt"}"#, "buy milk"),
            cycle(3, "files__list", "{}", "notes.txt"),
        ]
        .concat(),
    );
    assert_eq!(
        after(&trace),
        ["superseded by a later files__read", "buy milk", "notes.txt"]
    );
}

#[test]
fn read_then_edited_drops_stale_read() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__read", r#"{"name":"notes.txt"}"#, "buy milk"),
            cycle(
                2,
                "files__write",
                r#"{"name":"notes.txt","text":"buy oat milk"}"#,
                "Done.",
            ),
            cycle(3, "files__list", "{}", "notes.txt"),
        ]
        .concat(),
    );
    assert_eq!(
        after(&trace),
        ["superseded by a later files__write", "Done.", "notes.txt"]
    );
}

#[test]
fn same_call_twice_keeps_one() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__list", "{}", "notes.txt done.txt"),
            cycle(2, "files__list", "{}", "notes.txt done.txt"),
            cycle(3, "files__read", r#"{"name":"notes.txt"}"#, "buy milk"),
        ]
        .concat(),
    );
    assert_eq!(
        after(&trace),
        [
            "superseded by a later files__list",
            "notes.txt done.txt",
            "buy milk"
        ]
    );
}

#[test]
fn superseded_result_is_the_earlier_one() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__list", "{}", "notes.txt"),
            cycle(
                2,
                "files__write",
                r#"{"name":"done.txt","text":"x"}"#,
                "Done.",
            ),
            cycle(3, "files__list", "{}", "notes.txt done.txt"),
            cycle(4, "files__read", r#"{"name":"done.txt"}"#, "x"),
        ]
        .concat(),
    );
    assert_eq!(
        after(&trace),
        [
            "superseded by a later files__list",
            "Done.",
            "notes.txt done.txt",
            "x"
        ]
    );
}

#[test]
fn paths_that_did_not_hold_it_survive() {
    let missed = ["bin", "usr", "opt", "var", "tmp"];
    let mut rest: Vec<Msg> = missed
        .iter()
        .enumerate()
        .flat_map(|(i, w)| {
            cycle(
                i + 1,
                "files__list",
                &format!(r#"{{"in":"{w}"}}"#),
                &format!("files__list failed: no {w}"),
            )
        })
        .collect();
    rest.extend(cycle(
        6,
        "files__list",
        r#"{"in":"apps"}"#,
        "calculator.exe",
    ));
    rest.extend(cycle(
        7,
        "files__read",
        r#"{"name":"apps/calculator.exe"}"#,
        "MZ",
    ));
    let mut want: Vec<String> = missed
        .iter()
        .map(|w| format!("files__list failed: no {w}"))
        .collect();
    want.extend(["calculator.exe".into(), "MZ".into()]);
    assert_eq!(after(&with(vec![task()], rest)), want);
}

#[test]
fn newest_step_never_collapsed() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__list", "{}", "notes.txt"),
            cycle(2, "files__list", "{}", "notes.txt"),
        ]
        .concat(),
    );
    assert_eq!(
        after(&trace),
        ["superseded by a later files__list", "notes.txt"]
    );
}

#[test]
fn no_argument_tools_are_not_about_the_same_thing() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__list", "{}", "notes.txt"),
            cycle(2, "clock__now", "{}", "Tuesday"),
            cycle(3, "files__read", r#"{"name":"notes.txt"}"#, "buy milk"),
        ]
        .concat(),
    );
    assert_eq!(after(&trace), ["notes.txt", "Tuesday", "buy milk"]);
}

#[test]
fn collapsing_shrinks_and_trim_still_fits() {
    let again: Vec<Msg> = (0..6)
        .flat_map(|i| {
            cycle(
                i + 1,
                "files__read",
                r#"{"name":"notes.txt"}"#,
                &format!("contents of notes.txt {}", "detail ".repeat(40)),
            )
        })
        .collect();
    let trace = with(vec![task()], again);
    let t = trim(&trace, &opts(4, None));
    assert!(size(&t) < size(&trace) / 2);
    assert!(text_of(t.last().unwrap()).contains("contents of notes.txt"));
}

#[test]
fn closed_subgoal_collapses_to_answer() {
    let d = summary(&with(
        vec![task()],
        [
            saying(
                1,
                "Let me find the calculator.",
                "files__list",
                r#"{"in":"bin"}"#,
                "files__list failed: no bin",
            ),
            cycle(
                2,
                "files__list",
                r#"{"in":"usr"}"#,
                "files__list failed: no usr",
            ),
            cycle(3, "files__list", r#"{"in":"apps"}"#, "calculator.exe"),
            saying(
                4,
                "Found it. Now I will open it.",
                "shell__run",
                r#"{"cmd":"apps/calculator.exe"}"#,
                "started",
            ),
        ]
        .concat(),
    ));
    assert_eq!(
        d.split('\n').collect::<Vec<_>>(),
        [
            "Said: Let me find the calculator.",
            r#"Worked: files__list({"in":"apps"}) — calculator.exe"#,
            "Said: Found it. Now I will open it.",
            r#"Worked: shell__run({"cmd":"apps/calculator.exe"}) — started"#,
        ]
    );
}

#[test]
fn failed_subgoal_keeps_every_path() {
    let d = summary(&with(
        vec![task()],
        [
            saying(
                1,
                "Let me find the calculator.",
                "files__list",
                r#"{"in":"bin"}"#,
                "files__list failed: no bin",
            ),
            cycle(
                2,
                "files__list",
                r#"{"in":"usr"}"#,
                "files__list failed: no usr",
            ),
            cycle(
                3,
                "files__list",
                r#"{"in":"opt"}"#,
                "files__list failed: no opt",
            ),
            saying(
                4,
                "It is not installed. I will say so.",
                "files__write",
                r#"{"name":"notes.txt"}"#,
                "Done.",
            ),
        ]
        .concat(),
    ));
    assert_eq!(
        d.split('\n').collect::<Vec<_>>(),
        [
            "Said: Let me find the calculator.",
            r#"Failed: files__list({"in":"bin"}) — files__list failed: no bin"#,
            r#"Failed: files__list({"in":"usr"}) — files__list failed: no usr"#,
            r#"Failed: files__list({"in":"opt"}) — files__list failed: no opt"#,
            "Said: It is not installed. I will say so.",
            r#"Worked: files__write({"name":"notes.txt"}) — Done."#,
        ]
    );
}

#[test]
fn open_subgoal_left_whole() {
    let d = summary(&with(
        vec![task()],
        [
            saying(
                1,
                "First I will list the folder.",
                "files__list",
                "{}",
                "notes.txt done.txt",
            ),
            saying(
                2,
                "Now I will read both.",
                "files__read",
                r#"{"name":"notes.txt"}"#,
                "buy milk",
            ),
            cycle(3, "files__read", r#"{"name":"done.txt"}"#, "called mum"),
        ]
        .concat(),
    ));
    assert_eq!(
        d.split('\n').collect::<Vec<_>>(),
        [
            "Said: First I will list the folder.",
            "Worked: files__list({}) — notes.txt done.txt",
            "Said: Now I will read both.",
            r#"Worked: files__read({"name":"notes.txt"}) — buy milk"#,
            r#"Worked: files__read({"name":"done.txt"}) — called mum"#,
        ]
    );
}

fn big() -> String {
    "export function route() { /* ... */ }\n".repeat(200)
}

#[test]
fn large_read_is_pointed_at() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__read", r#"{"name":"src/router.ts"}"#, &big()),
            cycle(2, "files__list", "{}", "router.ts"),
        ]
        .concat(),
    );
    let t = trim(&trace, &opts(4, None));
    let p = text_of(
        t.iter()
            .find(|m| m.1.call_id.as_deref() == Some("c1"))
            .unwrap(),
    );
    assert!(p.contains(r#"files__read({"name":"src/router.ts"})"#));
    assert!(p.len() < 200);
}

#[test]
fn newest_step_shown_as_it_came_back() {
    let trace = with(
        vec![task()],
        [
            cycle(1, "files__list", "{}", "router.ts"),
            cycle(2, "files__read", r#"{"name":"src/router.ts"}"#, &big()),
        ]
        .concat(),
    );
    let t = trim(&trace, &opts(4, None));
    assert!(text_of(t.last().unwrap()).contains("export function route()"));
}

#[test]
fn once_only_answer_is_clipped_not_pointed_at() {
    let said = format!("deleted {}", "a-file.txt ".repeat(400));
    let trace = with(
        vec![task()],
        [
            cycle(1, "shell__run", r#"{"cmd":"rm *.txt"}"#, &said),
            cycle(2, "files__list", "{}", "nothing"),
        ]
        .concat(),
    );
    let t = trim(&trace, &opts(4, None));
    let k = text_of(
        t.iter()
            .find(|m| m.1.call_id.as_deref() == Some("c1"))
            .unwrap(),
    );
    assert!(k.contains("characters cut"));
    assert!(k.contains("deleted a-file.txt"));
}

#[test]
fn images_count_as_v2_counts_them() {
    let m = body(Content::Parts(vec![
        Part::Text { text: "abc".into() },
        Part::Image {
            url: format!("data:image/png;base64,{}", "A".repeat(100_000)),
        },
    ]));
    assert_eq!(size(&[(Role::User, m)]), 3 + 5_000);
}

#[test]
fn clip_keeps_images() {
    let mut t = body(Content::Parts(vec![
        Part::Text {
            text: "y".repeat(5_000),
        },
        Part::Image {
            url: "data:image/png;base64,AAAA".into(),
        },
    ]));
    t.call_id = Some("c1".into());
    let mut a = body(Content::Text(String::new()));
    a.calls = Some(vec![call("c1", "shell__run", "{}")]);
    let trace = vec![task(), (Role::Assistant, a), (Role::Tool, t)];
    let out = trim(&trace, &opts(4, None));
    match &out[2].1.content {
        Content::Parts(p) => assert!(matches!(p[1], Part::Image { .. })),
        Content::Text(_) => panic!("image lost"),
    }
}

#[test]
fn fits_budget() {
    let trace = with(
        vec![task()],
        (0..12)
            .flat_map(|i| {
                cycle(
                    i + 1,
                    "files__read",
                    &format!(r#"{{"name":"n{i}.txt"}}"#),
                    &"x".repeat(1_500),
                )
            })
            .collect(),
    );
    let budget = 4_500;
    let t = trim(&trace, &opts(4, Some(budget)));
    assert!(size(&t) <= budget, "size {} over {budget}", size(&t));
    assert_paired(&t, "fits_budget");
}

#[test]
fn last_user_turn_always_kept() {
    // The user speaks again after a long trace; even a tiny budget must not summarise it away.
    let mut trace = with(vec![task()], long(15));
    trace.push(text(Role::User, "Now archive them."));
    trace.extend(cycle(99, "files__list", "{}", "notes.txt"));
    for budget in [Some(1), Some(500), None] {
        let t = trim(&trace, &opts(1, budget));
        assert!(
            t.iter()
                .any(|m| m.0 == Role::User && text_of(m) == "Now archive them."),
            "budget {budget:?}"
        );
        assert_eq!(t[0], task());
        assert_paired(&t, "last_user");
    }
}

#[test]
fn early_user_turn_pinned_while_rest_collapses() {
    // A follow-up early in a long trace: it stays verbatim, the cycles around it still collapse.
    let mut trace = with(vec![task()], long(3));
    trace.push(text(Role::User, "Also skip the drafts."));
    trace.extend((0..50).flat_map(|i| {
        cycle(
            100 + i,
            "files__read",
            &format!(r#"{{"name":"m{i}.txt"}}"#),
            &"z".repeat(1_500),
        )
    }));
    let budget = 13_000; // the summary lines alone are ~11k; the whole trace is ~80k
    let t = trim(&trace, &opts(4, Some(budget)));
    assert!(size(&t) <= budget, "size {} over {budget}", size(&t));
    assert_eq!(
        t.iter()
            .filter(|m| m.0 == Role::User && text_of(m) == "Also skip the drafts.")
            .count(),
        1
    );
    assert_eq!(t[0], task());
    assert_paired(&t, "early_user");
}

#[test]
fn clip_counts_utf16_and_keeps_surrogate_pairs() {
    // Odd leading unit puts the naive cut inside an emoji's surrogate pair.
    let big = format!("a{}", "😀".repeat(3_000));
    let mut a = body(Content::Text(String::new()));
    a.calls = Some(vec![call("c1", "shell__run", "{}")]);
    let mut t = body(Content::Text(big));
    t.call_id = Some("c1".into());
    let trace = vec![task(), (Role::Assistant, a), (Role::Tool, t)];
    let out = trim(&trace, &opts(4, None));
    let said = text_of(&out[2]);
    assert!(said.contains("6001") || said.contains("characters cut"));
    assert!(!said.contains('\u{FFFD}'), "pair split: {said:?}");
    assert!(
        said.encode_utf16().count() <= 2_000 + 40,
        "not clipped to UTF-16 limit"
    );
    assert!(said.contains('😀'));
}
