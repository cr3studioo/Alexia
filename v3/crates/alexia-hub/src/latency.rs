// SPDX-License-Identifier: AGPL-3.0-only
//! The latency dashboard (SP-09). Reads only the `spans` table.
#![allow(dead_code)] // main.rs wires `run` in P1-17.

use alexia_store::{Ms, SpanRow, Store};
use std::fmt::Write;
use std::path::PathBuf;

pub struct Options {
    pub last: u32,
    pub html: Option<PathBuf>,
    pub check: bool,
}

/// Parses `latency [--last N] [--html FILE] [--check]` (after the subcommand word).
pub fn parse(args: &[String]) -> Result<Options, String> {
    let mut o = Options {
        last: 50,
        html: None,
        check: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--last" => {
                let v = it.next().ok_or("--last needs a number")?;
                o.last = v
                    .parse()
                    .map_err(|_| format!("--last: '{v}' is not a number"))?;
                if o.last == 0 {
                    return Err("--last must be at least 1".into());
                }
            }
            "--html" => o.html = Some(it.next().ok_or("--html needs a file")?.into()),
            "--check" => o.check = true,
            other => return Err(format!("unknown argument '{other}'")),
        }
    }
    Ok(o)
}

pub struct TurnView {
    pub turn: String,
    pub at: Ms,
    pub lane: String,
    pub total_ms: i64,
    pub ack_ms: Option<i64>,
    /// name, start offset from `at`, ms
    pub stages: Vec<(String, i64, i64)>,
    pub unaccounted_ms: i64,
}

/// Groups `last_turns(n)` rows (already ordered by turn) into turns.
pub fn turns(rows: &[SpanRow]) -> Vec<TurnView> {
    let mut out: Vec<TurnView> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        while j < rows.len() && rows[j].turn == rows[i].turn {
            j += 1;
        }
        let g = &rows[i..j];
        let at = g.iter().map(|r| r.at).min().unwrap_or(0);
        let stages: Vec<(String, i64, i64)> =
            g.iter().map(|r| (r.name.clone(), r.start, r.ms)).collect();
        let total_ms = stages
            .iter()
            .filter(|s| s.0 == "deliver")
            .map(|s| s.1 + s.2)
            .max()
            .unwrap_or_else(|| stages.iter().map(|s| s.1 + s.2).max().unwrap_or(0));
        let ack_ms = stages.iter().find(|s| s.0 == "ack").map(|s| s.1 + s.2);
        let mut iv: Vec<(i64, i64)> = stages
            .iter()
            .filter(|s| s.0 != "ack" && s.0 != "brain")
            .map(|s| (s.1, s.1 + s.2))
            .collect();
        iv.sort_unstable();
        let (mut covered, mut end) = (0, i64::MIN);
        for (s, e) in iv {
            let s = s.max(end);
            if e > s {
                covered += e - s;
            }
            end = end.max(e);
        }
        out.push(TurnView {
            turn: g[0].turn.clone(),
            at,
            lane: g[0].lane.clone(),
            total_ms,
            ack_ms,
            stages,
            unaccounted_ms: (total_ms - covered).max(0),
        });
        i = j;
    }
    out
}

/// UTC "YYYY-MM-DD HH:MM:SS" from epoch ms (civil-from-days).
fn utc(ms: Ms) -> String {
    let t = ms.div_euclid(1000);
    let (z, sod) = (t.div_euclid(86_400) + 719_468, t.rem_euclid(86_400));
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60
    )
}

fn secs(ms: i64) -> String {
    if ms < 10_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{}s", ms / 1000)
    }
}

fn short_id(t: &str) -> &str {
    t.rsplit([':', '/', '-']).next().unwrap_or(t)
}

/// One line per failure; empty when the check passes.
fn check(views: &[TurnView], last: u32) -> Vec<String> {
    let mut f = Vec::new();
    if (views.len() as u32) < last {
        f.push(format!(
            "Only {} turns recorded; the check needs {last}.",
            views.len()
        ));
    }
    for v in views {
        let id = short_id(&v.turn);
        match v.ack_ms {
            None => f.push(format!("turn {id}: no ack")),
            Some(a) if a >= 300 => f.push(format!("turn {id}: ack took {a} ms (limit 300)")),
            _ => {}
        }
        if v.lane == "chat" && v.stages.iter().any(|s| s.0 == "bridge") {
            f.push(format!("turn {id}: chat turn went through the bridge"));
        }
        if v.unaccounted_ms > v.total_ms / 20 {
            f.push(format!(
                "turn {id}: {} ms of {} ms unaccounted",
                v.unaccounted_ms, v.total_ms
            ));
        }
    }
    f
}

struct Summary {
    name: String,
    count: usize,
    p50: i64,
    p90: i64,
    max: i64,
    share: f64,
}

fn summary(views: &[TurnView]) -> Vec<Summary> {
    let mut names: Vec<&str> = views
        .iter()
        .flat_map(|v| v.stages.iter().map(|s| s.0.as_str()))
        .collect();
    names.sort_unstable();
    names.dedup();
    let total: i64 = views.iter().map(|v| v.total_ms).sum::<i64>().max(1);
    let mut out: Vec<Summary> = names
        .into_iter()
        .map(|n| {
            let mut ms: Vec<i64> = views
                .iter()
                .flat_map(|v| v.stages.iter().filter(|s| s.0 == n).map(|s| s.2))
                .collect();
            ms.sort_unstable();
            let pct = |p: usize| ms[((ms.len() * p).div_ceil(100)).max(1) - 1];
            Summary {
                name: n.into(),
                count: ms.len(),
                p50: pct(50),
                p90: pct(90),
                max: *ms.last().unwrap_or(&0),
                share: ms.iter().sum::<i64>() as f64 * 100.0 / total as f64,
            }
        })
        .collect();
    out.sort_by(|a, b| b.share.total_cmp(&a.share));
    out
}

fn top3(v: &TurnView) -> String {
    let mut s: Vec<&(String, i64, i64)> = v
        .stages
        .iter()
        .filter(|s| s.0 != "ack" && s.0 != "brain")
        .collect();
    s.sort_by_key(|x| std::cmp::Reverse(x.2));
    s.iter()
        .take(3)
        .map(|x| format!("{} {}", x.0, secs(x.2)))
        .collect::<Vec<_>>()
        .join(" · ")
}

fn table(views: &[TurnView]) -> String {
    let mut o = String::new();
    for v in views {
        let ack = v.ack_ms.map_or("-".into(), |a| format!("{a}ms"));
        let _ = writeln!(
            o,
            "{}  {:<8} total {:>6}  ack {:>7}  {}",
            utc(v.at),
            v.lane,
            secs(v.total_ms),
            ack,
            top3(v)
        );
    }
    let _ = writeln!(
        o,
        "\n{:<20} {:>5} {:>7} {:>7} {:>7} {:>6}",
        "stage", "n", "p50", "p90", "max", "share"
    );
    for s in summary(views) {
        let _ = writeln!(
            o,
            "{:<20} {:>5} {:>7} {:>7} {:>7} {:>5.1}%",
            s.name,
            s.count,
            secs(s.p50),
            secs(s.p90),
            secs(s.max),
            s.share
        );
    }
    o
}

const NAMES: [&str; 17] = [
    "prompt",
    "recall-wait",
    "first-byte",
    "writing",
    "store",
    "lane",
    "chat-escalated",
    "ack",
    "merge",
    "hear",
    "brain",
    "speak",
    "deliver",
    "bridge",
    "bridge-first-byte",
    "tool",
    "other",
];

fn color_idx(name: &str) -> usize {
    let n = name.split(':').next().unwrap_or(name);
    NAMES
        .iter()
        .position(|x| *x == n)
        .filter(|_| n != "other")
        .unwrap_or(16)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn html(views: &[TurnView]) -> String {
    const LIGHT: [&str; 17] = [
        "#4e79a7", "#a0cbe8", "#f28e2b", "#59a14f", "#8cd17d", "#b6992d", "#f1ce63", "#499894",
        "#86bcb6", "#e15759", "#ff9d9a", "#79706e", "#bab0ac", "#d37295", "#fabfd2", "#b07aa1",
        "#9d9d9d",
    ];
    const DARK: [&str; 17] = [
        "#6a9bd1", "#4b7391", "#f5a54a", "#76bd6f", "#5d9e50", "#d3b84a", "#c9a93d", "#5bb5af",
        "#3f7f79", "#f0787a", "#b86a68", "#a39b99", "#7d7673", "#e68ab0", "#a85d7c", "#c99bc0",
        "#777777",
    ];
    let mut o = String::from(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>Alexia latency</title><style>:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--line:#ddd;",
    );
    for (i, c) in LIGHT.iter().enumerate() {
        let _ = write!(o, "--c{i}:{c};");
    }
    o.push_str("}@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--line:#333;");
    for (i, c) in DARK.iter().enumerate() {
        let _ = write!(o, "--c{i}:{c};");
    }
    o.push_str(
        "}}body{background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif;margin:0 auto;\
         padding:0 16px;max-width:1000px}table{border-collapse:collapse;width:100%}\
         td,th{border-bottom:1px solid var(--line);padding:2px 6px;text-align:right}\
         td:first-child,th:first-child{text-align:left}svg{width:100%;height:30px;display:block}\
         .lg span{display:inline-block;margin-right:12px}.lg i{display:inline-block;width:10px;height:10px;margin-right:4px}\
         </style></head><body>",
    );
    let (lo, hi) = (
        views.iter().map(|v| v.at).min().unwrap_or(0),
        views.iter().map(|v| v.at).max().unwrap_or(0),
    );
    let mut lanes: Vec<(&str, usize)> = Vec::new();
    for v in views {
        match lanes.iter_mut().find(|l| l.0 == v.lane) {
            Some(l) => l.1 += 1,
            None => lanes.push((&v.lane, 1)),
        }
    }
    let lane_txt: Vec<String> = lanes
        .iter()
        .map(|l| format!("{} {}", esc(l.0), l.1))
        .collect();
    let _ = write!(
        o,
        "<h1>Latency: {} turns</h1><p>{} to {} UTC · {}</p>",
        views.len(),
        utc(lo),
        utc(hi),
        lane_txt.join(" · ")
    );
    o.push_str("<table><tr><th>stage</th><th>n</th><th>p50</th><th>p90</th><th>max</th><th>share</th></tr>");
    for s in summary(views) {
        let _ = write!(
            o,
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{:.1}%</td></tr>",
            esc(&s.name),
            s.count,
            secs(s.p50),
            secs(s.p90),
            secs(s.max),
            s.share
        );
    }
    o.push_str("</table><p class=\"lg\">");
    for (i, n) in NAMES.iter().enumerate() {
        let _ = write!(
            o,
            "<span><i style=\"background:var(--c{i})\"></i>{n}</span>"
        );
    }
    o.push_str("</p>");
    let widest = views.iter().map(|v| v.total_ms).max().unwrap_or(1).max(1);
    for v in views {
        let _ = write!(
            o,
            "<div><b>{}</b> {} · {} · total {}<svg viewBox=\"0 0 1000 30\" preserveAspectRatio=\"none\">",
            esc(short_id(&v.turn)), utc(v.at), esc(&v.lane), secs(v.total_ms)
        );
        let x = |ms: i64| ms as f64 * 1000.0 / widest as f64;
        for (n, st, ms) in &v.stages {
            if n == "brain" {
                continue;
            }
            let (y, h) = if n == "ack" { (0, 4) } else { (6, 24) };
            let _ = write!(
                o,
                "<rect x=\"{:.1}\" y=\"{y}\" width=\"{:.1}\" height=\"{h}\" fill=\"var(--c{})\"><title>{} {}ms</title></rect>",
                x(*st), x(*ms).max(1.0), color_idx(n), esc(n), ms
            );
        }
        o.push_str("</svg><details><summary>stages</summary><ul>");
        for (n, st, ms) in &v.stages {
            let _ = write!(o, "<li>{} +{}ms for {}ms</li>", esc(n), st, ms);
        }
        o.push_str("</ul></details></div>");
    }
    o.push_str("</body></html>");
    o
}

/// Prints the table; writes the page if asked; returns the exit code.
pub fn run(store: &Store, opts: &Options) -> i32 {
    let rows = match store.last_turns(opts.last) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("latency: {e}");
            return 1;
        }
    };
    let views = turns(&rows);
    print!("{}", table(&views));
    if let Some(p) = &opts.html {
        if let Err(e) = std::fs::write(p, html(&views)) {
            eprintln!("latency: cannot write {}: {e}", p.display());
            return 1;
        }
    }
    if opts.check {
        let f = check(&views, opts.last);
        for l in &f {
            eprintln!("{l}");
        }
        return i32::from(!f.is_empty());
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use alexia_core::{Brain, BrainError, Budget, Bus, DraftSink, Lane, OutFile, Reply, Turn};
    use alexia_gateway::{
        Channel, ChatRef, Error as GwError, Gateway, GatewayConfig, InFile, InKind, Inbound, Media,
        MsgRef, Outbound, Result as GwResult,
    };
    use alexia_store::Content;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn r(turn: &str, at: Ms, lane: &str, name: &str, start: Ms, ms: i64) -> SpanRow {
        SpanRow {
            turn: turn.into(),
            at,
            origin: "{}".into(),
            lane: lane.into(),
            name: name.into(),
            start,
            ms,
        }
    }

    fn good(turn: &str, at: Ms) -> Vec<SpanRow> {
        vec![
            r(turn, at, "chat", "ack", 0, 100),
            r(turn, at, "chat", "first-byte", 0, 500),
            r(turn, at, "chat", "deliver", 500, 500),
        ]
    }

    fn s(a: &[&str]) -> Vec<String> {
        a.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn groups_and_offsets() {
        let mut rows = good("t:a", 1000);
        rows.extend(good("t:b", 5000));
        let v = turns(&rows);
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].at, 5000);
        assert_eq!(v[1].stages[2], ("deliver".into(), 500, 500));
        assert_eq!(v[0].total_ms, 1000);
        assert_eq!(v[0].ack_ms, Some(100));
    }

    #[test]
    fn unaccounted_is_union_not_sum() {
        let rows = vec![
            r("t", 0, "chat", "ack", 0, 900),
            r("t", 0, "chat", "brain", 0, 900),
            r("t", 0, "chat", "writing", 0, 600),
            r("t", 0, "chat", "store", 400, 300),
            r("t", 0, "chat", "deliver", 700, 300),
        ];
        let v = turns(&rows);
        // union of [0,600] [400,700] [700,1000] = 1000
        assert_eq!(v[0].total_ms, 1000);
        assert_eq!(v[0].unaccounted_ms, 0);
        let gap = turns(&[
            r("t", 0, "chat", "writing", 0, 400),
            r("t", 0, "chat", "deliver", 700, 300),
        ]);
        assert_eq!(gap[0].unaccounted_ms, 300);
    }

    fn check_n(rows: Vec<SpanRow>, last: u32) -> Vec<String> {
        check(&turns(&rows), last)
    }

    #[test]
    fn check_passes_good_turns() {
        assert!(check_n(good("t:a", 0), 1).is_empty());
    }

    #[test]
    fn check_fails_slow_ack() {
        let mut rows = good("t:a", 0);
        rows[0].ms = 300;
        assert_eq!(check_n(rows, 1).len(), 1);
    }

    #[test]
    fn check_fails_chat_with_bridge() {
        let mut rows = good("t:a", 0);
        rows.push(r("t:a", 0, "chat", "bridge", 0, 10));
        assert!(check_n(rows, 1).iter().any(|l| l.contains("bridge")));
    }

    #[test]
    fn check_fails_gaps() {
        let rows = vec![
            r("t:a", 0, "chat", "ack", 0, 100),
            r("t:a", 0, "chat", "writing", 0, 500),
            r("t:a", 0, "chat", "deliver", 800, 200),
        ];
        assert!(check_n(rows, 1).iter().any(|l| l.contains("unaccounted")));
    }

    #[test]
    fn check_fails_too_few() {
        assert_eq!(
            check_n(good("t:a", 0), 50),
            vec!["Only 1 turns recorded; the check needs 50.".to_string()]
        );
    }

    #[test]
    fn html_is_self_contained() {
        let mut rows = good("t:a", 0);
        rows.extend(good("t:b", 9000));
        let page = html(&turns(&rows));
        assert!(!page.contains("src=\"http") && !page.contains("<script src"));
        assert_eq!(page.matches("<svg").count(), 2);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("latency.html"), page).unwrap();
    }

    #[test]
    fn utc_known_dates() {
        assert_eq!(utc(0), "1970-01-01 00:00:00");
        assert_eq!(utc(951_782_400_000), "2000-02-29 00:00:00"); // leap day
        assert_eq!(utc(1_709_251_199_999), "2024-02-29 23:59:59"); // leap day
        assert_eq!(utc(1_700_000_000_000), "2023-11-14 22:13:20");
    }

    #[test]
    fn top3_keeps_deliver() {
        let v = turns(&[
            r("t", 0, "chat", "ack", 0, 100),
            r("t", 0, "chat", "deliver", 0, 900),
        ]);
        assert!(top3(&v[0]).contains("deliver"));
    }

    #[test]
    fn absolute_start_is_not_subtracted() {
        let at = 1_700_000_000_000;
        let v = turns(&[
            r("t", at, "chat", "ack", 0, 120),
            r("t", at, "chat", "first-byte", 0, 900), // covers the gap so `check` is clean
            r("t", at, "chat", "deliver", 900, 100),
        ]);
        assert_eq!(v[0].ack_ms, Some(120));
        assert_eq!(v[0].total_ms, 1000);
        assert!(check(&v, 1).is_empty());
    }

    #[test]
    fn check_fails_slow_ack_with_real_epoch() {
        let at = 1_700_000_000_000;
        let v = turns(&[
            r("t:a", at, "chat", "ack", 0, 400),
            r("t:a", at, "chat", "deliver", 0, 1000),
        ]);
        assert!(check(&v, 1).iter().any(|l| l.contains("ack took 400 ms")));
    }

    struct OneMsg(std::sync::Mutex<bool>);

    #[async_trait::async_trait]
    impl Channel for OneMsg {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn budget(&self) -> Budget {
            Budget::CHAT
        }
        async fn next(&self, cancel: CancellationToken) -> GwResult<Vec<Inbound>> {
            let first = !std::mem::replace(&mut *self.0.lock().unwrap(), true);
            if first {
                return Ok(vec![Inbound {
                    chat: ChatRef { chat: "a".into() },
                    msg: MsgRef { id: "1".into() },
                    kind: InKind::Message,
                    from_owner: true,
                    content: Content::Text("hi".into()),
                    files: vec![],
                    at: 0,
                }]);
            }
            cancel.cancelled().await;
            Err(GwError::Cancelled)
        }
        async fn react(&self, _: &ChatRef, _: &MsgRef, _: &str) -> GwResult<()> {
            Ok(())
        }
        async fn typing(&self, _: &ChatRef) -> GwResult<()> {
            Ok(())
        }
        async fn send(&self, _: &ChatRef, _: &Outbound) -> GwResult<MsgRef> {
            Ok(MsgRef { id: "s".into() })
        }
        async fn draft(&self, _: &ChatRef, _: Option<&str>) -> GwResult<()> {
            Ok(())
        }
        async fn edit(&self, _: &ChatRef, _: &MsgRef, _: &str) -> GwResult<()> {
            Ok(())
        }
        async fn ask(&self, _: &ChatRef, _: &str, _: CancellationToken) -> GwResult<Option<bool>> {
            Ok(None)
        }
    }

    struct NoMedia;

    #[async_trait::async_trait]
    impl Media for NoMedia {
        async fn transcribe(&self, _: &InFile) -> GwResult<Option<String>> {
            Ok(None)
        }
        async fn speak(&self, _: &str) -> GwResult<Option<OutFile>> {
            Ok(None)
        }
    }

    struct SlowBrain;

    #[async_trait::async_trait]
    impl Brain for SlowBrain {
        async fn reply(
            &self,
            _: Turn,
            _: DraftSink,
            _: CancellationToken,
        ) -> Result<Reply, BrainError> {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Ok(Reply {
                text: "ok".into(),
                files: vec![],
                lane: Lane::Chat,
                model: None,
                spans: vec![],
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn gateway_spans_round_trip() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut gw = Gateway::new(
            GatewayConfig {
                merge_ms: 20,
                ..Default::default()
            },
            store.clone(),
            Bus::new(64),
            Arc::new(SlowBrain),
            Arc::new(NoMedia),
        );
        gw.add(Arc::new(OneMsg(Default::default())));
        let cancel = CancellationToken::new();
        let run = tokio::spawn(gw.run(cancel.clone()));
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let rows = loop {
            let rows = store.last_turns(1).unwrap();
            let has = |n: &str| rows.iter().any(|r| r.name == n);
            if has("ack") && has("deliver") {
                break rows;
            }
            assert!(
                std::time::Instant::now() < end,
                "no ack+deliver rows: {rows:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        cancel.cancel();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), run).await;
        let v = turns(&rows);
        assert_eq!(v.len(), 1);
        let a = v[0].ack_ms.expect("ack");
        assert!((0..300).contains(&a), "ack_ms {a}");
        assert!(v[0].stages.iter().all(|s| s.1 >= 0), "{:?}", v[0].stages);
        assert!(
            (50..5_000).contains(&v[0].total_ms),
            "total {}",
            v[0].total_ms
        );
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            (now - rows[0].at).abs() < 10_000,
            "at {} now {now}",
            rows[0].at
        );
    }

    #[test]
    fn parse_args() {
        let o = parse(&[]).unwrap();
        assert_eq!((o.last, o.html.is_none(), o.check), (50, true, false));
        let o = parse(&s(&["--last", "5", "--html", "x.html", "--check"])).unwrap();
        assert_eq!((o.last, o.check), (5, true));
        assert_eq!(o.html, Some(PathBuf::from("x.html")));
        assert!(parse(&s(&["--last", "x"])).is_err());
        assert!(parse(&s(&["--last", "0"])).is_err());
        assert!(parse(&s(&["--nope"])).is_err());
    }
}
