# P3: Proactive (V3-3)

> Planned 2026-11-24 from `v3-plan.md` (the authority: *V3-3*, D214, *Still open*), `Alexia.md`
> (*The load-bearing invariant*, *Architecture*, *The plugin contract*, *The agent loop*,
> *Memory*), `v3/specs/INTERFACES.md`, the code under `v3/crates/` after P2D, and
> `v3/ops/reports/P2D-phase-review.md`. Feature titles are the owner's picks, saved in
> [`v3/picks.md`](../../picks.md) on 2026-11-24 (the picker artifact itself lost its pictures). v2's `packages/core` has no
> proactivity to port; v2's `plugins/memory`, `plugins/commitments` and `plugins/apple-context`
> are the behaviour P3 builds on.

## Goal

Alexia speaks first. A proactivity engine in `alexia-scheduler` collects what might be worth
saying from every plugin that offers it (by capability, never by name), decides with plain rules
whether and when to say it (urgency, deadlines, quiet hours, what the owner said about earlier
notices), and says it in the owner's chat: a morning brief, an evening wrap-up, a weekly review,
deadline warnings while there is still time, and follow-through on promises. The memory it draws
on grows: a life graph of people, dates and goals, recall by meaning, a timeline of the owner's
days, and capture from every channel. The daily sources come as plugins: Google and Microsoft
calendars and mail, tasks, page watches, health nudges, study and errands. Anything that leaves
the owner's devices still asks (D214); what she may do silently is the owner's list below.

## Feature IDs (the owner's picks)

| ID | Title | Task(s) |
|---|---|---|
| PR-01 | Proactivity engine | P3-04, P3-07, P3-08, P3-09 |
| PR-02 | Morning brief → when I first unlock my phone | P3-09 (trigger: *Owner needs* 2) |
| PR-03 | Evening wrap-up | P3-09 |
| PR-04 | Weekly review | P3-09 |
| PR-05 | Daily interruption limit → fully involved: no cap | P3-08 |
| PR-06 | Urgency levels | P3-08 |
| PR-07 | Knows when not to interrupt | P3-07 |
| PR-08 | Keeps your promises for you | P3-25, P3-10 |
| PR-09 | Deadline radar | P3-08 (+ sources P3-14, P3-20, P3-21, P3-25, P3-26) |
| PR-10 | Leave-now alerts | P3-22 |
| PR-11 | Meeting prep | P3-22 |
| PR-12 | Overnight errands | P3-10 |
| PR-13 | Notices patterns | P3-11 |
| PR-14 | Inbox watch | P3-23 |
| PR-16 | Website change watch | P3-27 |
| PR-17 | Package tracking | P3-23 |
| PR-18 | Bills and subscriptions | P3-23 |
| PR-19 | People nudges | P3-14 |
| PR-20 | Health nudges | P3-28 |
| PR-21 | Check-ins | P3-10 |
| PR-22 | "While you were away" | P3-09 |
| PR-23 | Suggests automations | P3-11 |
| PR-24 | Turns repeated tasks into skills | P3-11 |
| PR-25 | Follows your interests | P3-27 |
| PR-26 | How much she does without asking → act silently on low-risk things | P3-06 (list: *Owner needs* 1) |
| ME-01 | Life graph | P3-14 |
| ME-02 | Learns from every conversation | P3-16 |
| ME-03 | Memory screen | P3-17 |
| ME-04 | Plain profile file | P3-15 |
| ME-05 | Timeline of your days | P3-15 |
| ME-06 | Screen memory | P3-19 |
| ME-07 | Document library | P3-18 |
| ME-08 | Notes app sync | P3-18 |
| ME-09 | People profiles | P3-14 |
| ME-10 | Learns from corrections | P3-13 |
| ME-11 | Every fact shows its source | P3-13 |
| ME-12 | Forget on command | P3-13 |
| ME-13 | Locked private memory | P3-15, P3-16 |
| ME-14 | Nightly tidy-up | P3-15 |
| ME-15 | One memory everywhere | P3-16 |
| ME-16 | Goals she keeps in mind | P3-14 |
| ME-17 | Learns your routine | P3-11 |
| ME-18 | Import from other assistants | P3-15 |
| DY-01 | Google Calendar | P3-20 |
| DY-02 | Outlook / Microsoft 365 | P3-21 |
| DY-03 | Smart scheduling | P3-22 |
| DY-04 | Email triage | P3-23 |
| DY-05 | Replies in your voice | P3-24 |
| DY-06 | Sending email for you (always asks, D214) | P3-24, P3-06, P3-35, P3-36 |
| DY-07 | Tasks | P3-26 |
| DY-08 | Reminders by time, place or person | P3-10 (time), P3-26 (place, person) |
| DY-09 | Timers and alarms on any device | P3-10 (this hub's channels; other devices at V3-4/V3-5) |
| DY-10 | Quick capture | P3-12 |
| DY-11 | School portal | P3-27 |
| DY-12 | Study mode | P3-29 |
| DY-13 | Travel planner | P3-30 |
| DY-14 | Bookings (always asks: AC-06) | P3-30 |
| DY-15 | Forms and paperwork | P3-30 |
| DY-16 | Daily plan | P3-22 |
| DY-17 | Contacts | P3-14 (+ `contacts.find` from P3-20, P3-21) |
| DY-18 | Meeting and lecture notes | P3-29 |

## Done when

From `v3-plan.md`: *a week goes by in which the owner gets the morning brief, at least one
promise followed through, and at least one deadline flagged before it was urgent, all
unprompted.* Split into what a task can prove and what only the owner's week can.

**Proven by tasks:**

1. **A simulated week passes** (P3-32): `cargo test -p alexia-hub --test week` runs the real
   wiring with a paused clock, a scripted model and fake `notice.items` / `brief.section`
   sources for 7 days and asserts:
   - each day exactly one morning brief is said, at the first owner activity after the brief's
     earliest time, or at the fallback time when there is none, and none inside quiet hours;
   - a commitment due on day 4 (from the fake commitments source) produces a notice on day 1
     or 2 with urgency `Low` or `Normal`, before it would be `High`. That is the deadline
     flagged before it was urgent;
   - a promise recorded on day 2 ("I will send the form by Thursday") is raised on Thursday's
     brief, the owner answers "done" in the test, and the notice and the commitment are closed.
     That is the promise followed through;
   - every one of those `Say` events has no user turn in the 60 s before it (unprompted);
   - no tool runs from an `Origin::Scheduler` turn without a ruling of `Run` that the silent
     rule allowed (P3-06), and an outward-facing tool (`openWorldHint: true`) always asks.
2. **The pieces hold on their own**: each task's tests (below), `node v3/ci/invariants.mjs`
   (no crate names a plugin, including the ten new plugin ids), and `pnpm check` with the new
   plugins' tests.
3. **On this PC** (P3-33): the real `alexia-hub run`, with the real plugins and the owner's
   accounts connected, says a brief in the owner's Telegram chat within 2 minutes of a forced
   `alexia-hub brief --now`, and `alexia-hub notices --week` prints the notice log.
   `v3/ops/reports/P3-e2e.md` records it.
4. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace` pass in `v3/`; `pnpm check` passes at the repo root (apart from the
   known `compute-connect.test.ts` failure, LATER L8).

**Only the owner's week can prove** (P3-33 starts the log, `v3/ops/reports/P3-week.md`; the
owner fills one line a day):

- that the brief arrives when they actually first pick up the phone, on a real morning;
- that a real promise and a real deadline from their life were caught, raised in time, and
  closed;
- that what she says is worth reading (no noise they mute on day 2), and that nothing she did
  silently surprised them;
- that quiet hours were right for their sleep and lectures.

The phase is accepted when the owner signs that week off.

## Decisions (planner; the owner may overrule)

- **D-P3-1: one queue of notices, in core's database.** Migration 4 adds `notices` and `mutes`
  (INTERFACES §5.3). Every candidate (from a plugin, a watch, a follow-up, a deadline) becomes
  a `notices` row keyed by `(source, its own key)`, so the same thing is never said twice and
  the owner's answers stick. History is kept (PR-22, the `notices` CLI).
- **D-P3-2: sources are capabilities, fanned out.** New capability names `notice.items` (what
  might be worth saying now), `notice.done` (the owner said it is done) and `brief.section` (a section for a brief), plus `calendar.*`,
  `mail.*`, `contacts.find` (INTERFACES §3.6, `docs/spec/capabilities.md`). The scheduler calls
  every provider through `McpHost::call_capability_all` (new, P3-05). No crate names a plugin.
- **D-P3-3: memory stays a plugin; migration 4 has no vectors and no life graph.** This
  overrules INTERFACES §5.3's row 4. `Alexia.md` *Memory* (D199–D202) puts recall across
  sessions in the memory plugin, and deleting it must make Alexia forget. Vectors and the life
  graph live in the memory plugin's namespace. Embeddings come from the host's `text.embed`
  (P2-34, MO-07); without it recall falls back to v2's keyword ranking. Search is brute force
  over at most a few thousand rows, so no `sqlite-vec` C dependency is needed.
- **D-P3-4: the decider is rules, not a model.** Whether and when to say something is decided
  by `decide` (P3-08) from urgency, due time, quiet hours, mutes, snoozes and what was already
  said. The brief itself is composed by code from the sections and notices (P3-09); a plugin
  that wants prose in its section writes it with its own sampling call. So the brief always
  arrives, costs no model call of its own, and "no cap" (PR-05) never becomes "a model decided
  to message you at 3 am".
- **D-P3-5: deadline radar thresholds.** For a notice with `due_at`: more than 7 days out,
  nothing; 7 to 3 days, `Low` (goes into the next brief); 3 days to 24 h, `Normal` (said at the
  next good moment); under 24 h, `High`; under 2 h or overdue, `Urgent`. "Flagged before it was
  urgent" means first said while `Low` or `Normal`.
- **D-P3-6: act silently is enforced in core, per turn origin.** For an `Origin::Scheduler`
  turn the permission ruling is narrowed after `permissions::rule`. A call runs without asking
  only if it is read-only (reviewed and `readOnlyHint`) or its tool id is on the owner's
  approved list (kv `_core`/`silent`). An `openWorldHint: true` tool (anything outward-facing)
  always asks, whatever the mode or list. The list starts **empty** and only the owner adds to
  it (CLI or `/silent`), so until they approve *Owner needs* 1, a proactive run reads and asks.
- **D-P3-7: the morning brief has no phone trigger until V3-5.** "When I first unlock my phone"
  needs the iPhone app (PH-02, V3-5). Until then the brief is said at the **first sign of the
  owner** after the brief's earliest time (default 05:00): a message on any channel, the window
  opened, input on this PC after the night's idle (`Event::Active`, P3-12/P3-31), or an
  `unlock` event from an iOS Shortcut if the owner sets one up (*Owner needs* 2). With no sign
  of the owner by the fallback time (default 09:00), it is said at the fallback time.
- **D-P3-8: `Event::Say` gains `notice` and `to`** (P3-04). `to` is the half of the deferred
  P2-81 that P3 needs (follow-ups answer in the chat where the promise was made). P2-81's
  `files` stays deferred.
- **D-P3-9: Google and Microsoft are plugins with their own OAuth.** Google: a Desktop OAuth
  client the owner creates (free), loopback redirect on `127.0.0.1` with PKCE, opened once from
  the plugin's settings. Microsoft: device-code flow with the owner's app registration.
  Refresh tokens are `password` settings (Credential Manager, TR-03), never in a table, a log
  or a prompt. Both declare `openWorldHint: true` on every tool that writes.
- **D-P3-10: new plugin ids are distinctive** so check 1 of `invariants.mjs` never confuses one
  with an English word in a crate: `google-account`, `microsoft-account`, `day-planner`,
  `mail-desk`, `task-list`, `page-watch`, `notes-library`, `screen-memory`, `study-desk`,
  `errand-kit`. P3-03 creates them all, so `pnpm-lock.yaml` changes in one task only.

## Crates and files this phase creates or changes

| Where | P3 content |
|---|---|
| `v3/specs/INTERFACES.md` | §2.1 notices, mutes, `kv_update`, `audit_scheduled_since`; §2.2 `call_capability_all`; §2.3 `Verdict`, `Scope.silent`, `permissions::proactive`; §2.5 the scheduler's P3 API; §3.6 the P3 capabilities; §4 `Say.notice`/`Say.to`, `Feedback`, `Active`; §5.3 migration 4 (P3-02 only) |
| `docs/spec/capabilities.md` | `notice.items`, `notice.done`, `brief.section`, `calendar.*`, `mail.*`, `contacts.find`, `tasks.add`, `page.text` (P3-02) |
| `alexia-store` | `kv_update` (P3-00); migration 4, notices and mutes API, `audit_scheduled_since` (P3-04) |
| `alexia-mcp` | `call_capability_all` (P3-05) |
| `alexia-core` | `Say` fields, `Feedback`, `Active`, `Verdict` (P3-04); the proactive permission rule (P3-06); capture on every origin, locked memory flag (P3-16); one prompt paragraph about follow-ups (P3-10); slash commands (P3-31) |
| `alexia-scheduler` | `watch.rs`, `quiet.rs` (P3-07); `notices.rs`, `decide.rs` (P3-08); `brief.rs` (P3-09); `follow.rs` (P3-10); `patterns.rs` (P3-11); `lib.rs` grows in that order |
| `alexia-gateway` | notice buttons, feedback, quick capture, `Active` (P3-12) |
| `alexia-api` | private sessions in one place, atomically (P3-00); helpers in one module, stale allows gone (P3-01); `Active` on a window message (P3-12, one line); capture args (P3-16) |
| `alexia-hub` | contract fixtures without a user name (P3-00); `proactive.rs` (sources over the host, PC activity), wiring, CLI (P3-31); `tests/week.rs` (P3-32) |
| `plugins/` (v2 paths) | `memory` (P3-13..P3-15, P3-17), `commitments` (P3-25), `apple-context` (P3-28); new: the ten in D-P3-10 (P3-03 skeletons, then one task each); `pnpm-lock.yaml` (P3-03 only) |
| reports | `v3/ops/reports/P3-e2e.md`, `P3-week.md`, `p3-e2e.ps1` (P3-33) |

`packages/ui`, `packages/core`, `src-tauri`, `.github/workflows/` are not touched. The memory
screen (ME-03) is the memory plugin's own panel, which the existing UI already renders.

## Order of work

```
P3-00 carry-over A (L3, L5) ── P3-01 carry-over B (L1, L2)
P3-02 INTERFACES ─┬─ P3-03 plugin skeletons + lockfile ── the ten new plugins' tasks (P3-18..P3-24, P3-26, P3-27, P3-29, P3-30)
                  ├─ existing plugins, no skeleton needed: P3-13 (memory), P3-25 (commitments), P3-28 (apple-context)
                  ├─ P3-04 store + bus (+P3-00) ─┬─ P3-07 watches, quiet ── P3-08 intake, decider (+P3-05)
                  │                              │      ── P3-09 briefs ── P3-10 follow-through ── P3-11 patterns
                  │                              └─ P3-12 gateway: buttons, capture, Active (+P3-01)
                  ├─ P3-05 mcp fan-out
                  └─ P3-06 act silently ── P3-16 capture everywhere, locked memory (+P3-00, P3-12)
memory plugin, in order:   P3-13 → P3-14 → P3-15 → P3-17
mail, in order:            P3-20 ∥ P3-21 ∥ P3-23 → P3-24
P3-06, P3-11, P3-12, P3-16 ── P3-31 hub wiring, CLI, commands
P3-31 + P3-14 + P3-25 ── P3-32 simulated week
everything ── P3-33 on this PC, the owner's week begins
```

Shared files and the order they force: `INTERFACES.md` and `docs/spec/capabilities.md` are
P3-02's only. `pnpm-lock.yaml` and every new plugin's `package.json` are P3-03's only.
`alexia-store/src/db.rs`: P3-00 → P3-04. `alexia-scheduler/src/lib.rs`: P3-04 (one literal) →
P3-07 → P3-08 → P3-09 → P3-10 → P3-11. `alexia-core/src/lib.rs`, `bus.rs`: P3-04 only.
`alexia-core/src/agent.rs`: P3-06 → P3-16. `alexia-core/src/prompt.rs`: P3-10 only.
`alexia-core/src/commands.rs`: P3-31 only. `alexia-hub/src/main.rs`: P3-04 (Say literals) →
P3-31. `alexia-api/src/chat.rs`: P3-00 → P3-01 → P3-12 → P3-16. `plugins/memory/**`: P3-13 → P3-14 →
P3-15 → P3-17. `plugins/google-account/**`: P3-20 → P3-24; `plugins/microsoft-account/**`:
P3-21 → P3-24; `plugins/mail-desk/**`: P3-23 → P3-24.

Can run together after P3-02/P3-03: the scheduler chain, P3-05, P3-06, and up to two plugin
tasks. **This PC has 16 GB: at most 4 workers at once, and at most 2 of them compiling Rust**
(`CARGO_BUILD_JOBS=1`, per-crate tests). Plugin tasks do not compile Rust except for the
invariants check, so they are the ones to run beside the scheduler chain.

## Tasks

Crate paths are under `v3/crates/`.

| ID | Title | Model | Depends on | Touches |
|---|---|---|---|---|
| P3-00 | P2D carry-over: private sessions atomic, no user name in fixtures (L3, L5) | opus | none | `alexia-store/{src/db.rs, tests/kv_update.rs}`, `alexia-api/{src/lib.rs, src/private.rs (new), src/chat.rs, src/editor.rs, src/board.rs, tests/private.rs}`, `alexia-hub/tests/{contract.rs, contract/local_models.json, contract/plugins.json}` |
| P3-01 | P2D carry-over: one home for alexia-api's helpers, stale allows gone (L1, L2) | sonnet | P3-00 | `alexia-api/src/{util.rs (new), lib.rs, json.rs, chat.rs, plugins.rs, offers.rs, gate.rs, library.rs, local_models.rs, state.rs, compute.rs, editor.rs}`, `alexia-api/tests/util.rs` |
| P3-02 | INTERFACES and capabilities for P3 | opus | none | `v3/specs/INTERFACES.md`, `docs/spec/capabilities.md` |
| P3-03 | Ten plugin skeletons and the lockfile | sonnet | P3-02 | `plugins/{google-account, microsoft-account, day-planner, mail-desk, task-list, page-watch, notes-library, screen-memory, study-desk, errand-kit}/{package.json, plugin.json, index.js, test/load.test.js}`, `pnpm-lock.yaml` |
| P3-04 | Store migration 4 (notices, mutes) and the bus additions | opus | P3-00, P3-02 | `alexia-store/{src/migrations.rs, src/db.rs, src/types.rs, src/lib.rs, tests/notices.rs}`, `alexia-core/{src/bus.rs, src/lib.rs, src/resume.rs}`, `alexia-scheduler/src/lib.rs` (Say literal), `alexia-hub/src/main.rs` (Say literals), `alexia-gateway/tests/gateway.rs` (Say literal) |
| P3-05 | McpHost: call every provider of a capability | opus | P3-02 | `alexia-mcp/{src/host.rs, src/bin/mcp-fixture.rs, tests/fanout.rs}` |
| P3-06 | Act silently: the proactive permission rule and the owner's list | opus | P3-02 | `alexia-core/{src/run.rs, src/permissions.rs, src/agent.rs, tests/silent.rs}` |
| P3-07 | Scheduler: watches, quiet hours, pause | opus | P3-04 | `alexia-scheduler/{src/lib.rs, src/watch.rs, src/quiet.rs, src/notices.rs, src/decide.rs, src/brief.rs, src/follow.rs, src/patterns.rs (last five as stubs), tests/watch.rs, tests/quiet.rs, tests/scheduler.rs (constructor args)}` |
| P3-08 | Scheduler: notice intake, the decider, deadline radar | opus | P3-05, P3-07 | `alexia-scheduler/{src/notices.rs, src/decide.rs, src/lib.rs, tests/decide.rs, tests/intake.rs}` |
| P3-09 | Scheduler: morning brief, evening wrap-up, weekly review, while you were away | opus | P3-08 | `alexia-scheduler/{src/brief.rs, src/lib.rs, tests/brief.rs}` |
| P3-10 | Scheduler: follow-through, check-ins, overnight errands, reminders and timers | opus | P3-09 | `alexia-scheduler/{src/follow.rs, src/lib.rs, tests/follow.rs}`, `alexia-core/src/prompt.rs` |
| P3-11 | Scheduler: patterns, routine, automation and skill suggestions | opus | P3-10 | `alexia-scheduler/{src/patterns.rs, src/lib.rs, tests/patterns.rs}` |
| P3-12 | Gateway: notice buttons, feedback, quick capture, owner activity | sonnet | P3-01, P3-04 | `alexia-gateway/{src/gateway.rs, src/channel.rs, src/channels/telegram/mod.rs, src/channels/telegram/api.rs, tests/notice_buttons.rs}`, `alexia-api/src/chat.rs` (one line) |
| P3-13 | Memory: recall by meaning, sources, corrections, forget | sonnet | P3-02 | `plugins/memory/{search.js, capture.js, index.js, plugin.json, test/search.test.js, test/source.test.js}` |
| P3-14 | Memory: life graph, people, goals, contacts, people nudges | sonnet | P3-13 | `plugins/memory/{graph.js (new), capture.js, index.js, plugin.json, test/graph.test.js}` |
| P3-15 | Memory: timeline, nightly tidy-up, profile file, import, locked facts | sonnet | P3-14 | `plugins/memory/{timeline.js (new), import.js (new), garden.js, profile.js, index.js, plugin.json, test/timeline.test.js, test/import.test.js, test/locked.test.js}` |
| P3-16 | Core: learn from every conversation, one memory, locked memory stays locked | opus | P3-00, P3-06, P3-12 | `alexia-core/{src/agent.rs, src/chat.rs, tests/capture_everywhere.rs}`, `alexia-api/src/chat.rs` (capture args) |
| P3-17 | Memory screen | sonnet | P3-15 | `plugins/memory/{plugin.json, index.js, test/panel.test.js}` |
| P3-18 | Document library and notes sync | sonnet | P3-03 | `plugins/notes-library/**` |
| P3-19 | Screen memory | opus | P3-03 | `plugins/screen-memory/**` |
| P3-20 | Google: calendar, mail reading, contacts | opus | P3-03 | `plugins/google-account/**` |
| P3-21 | Microsoft 365: calendar, mail reading, contacts | opus | P3-03 | `plugins/microsoft-account/**` |
| P3-22 | Day planner: daily plan, smart scheduling, leave-now, meeting prep | sonnet | P3-03 | `plugins/day-planner/**` |
| P3-23 | Mail desk: triage, inbox watch, packages, bills | sonnet | P3-03 | `plugins/mail-desk/**` |
| P3-24 | Replies in your voice and sending email (always asks) | opus | P3-20, P3-21, P3-23 | `plugins/google-account/{mail.js, index.js, plugin.json, test/send.test.js}`, `plugins/microsoft-account/{mail.js, index.js, plugin.json, test/send.test.js}`, `plugins/mail-desk/{voice.js (new), index.js, plugin.json, test/voice.test.js}` |
| P3-25 | Commitments: keeps your promises, early | sonnet | P3-02 | `plugins/commitments/{index.js, ledger.js, plugin.json, test/notice.test.js, test/due.test.js}` |
| P3-26 | Tasks, and reminders by place or person | sonnet | P3-03 | `plugins/task-list/**` |
| P3-27 | Page watch: website changes, school portal, your interests | sonnet | P3-03 | `plugins/page-watch/**` |
| P3-28 | Health nudges | sonnet | P3-02 | `plugins/apple-context/{nudges.js (new), index.js, plugin.json, test/nudges.test.js}` |
| P3-29 | Study desk: study mode, meeting and lecture notes | sonnet | P3-03 | `plugins/study-desk/**` |
| P3-30 | Errand kit: travel planner, bookings, forms and paperwork | sonnet | P3-03 | `plugins/errand-kit/**` |
| P3-31 | Hub: wiring, sources over the host, PC activity, CLI, slash commands | sonnet | P3-06, P3-11, P3-12, P3-16 | `alexia-hub/{Cargo.toml, src/main.rs, src/proactive.rs (new), tests/cli_p3.rs}`, `alexia-core/src/commands.rs`, `v3/Cargo.lock` |
| P3-32 | A simulated week, proven | sonnet | P3-31, P3-14, P3-25 | `alexia-hub/tests/week.rs` |
| P3-33 | On this PC: the real hub, the owner's week begins | sonnet | P3-00..P3-32 | `v3/ops/reports/{P3-e2e.md, P3-week.md, p3-e2e.ps1}` |
| P3-34 | computer.screenshot reports the front window and lock state | opus | P3-19 | `plugins/computer/{windows.js, macos.js, moment.js (new), index.js (screenshot handler), test/windows.test.js, test/macos.test.js, test/moment.test.js, test/screen.live.test.js, test/screen-check.mjs}` |
| P3-35 | Hosts offer elicitation to plugins: a plugin form becomes an owner prompt (host side: offers, call end ends the question) | opus | P3-05, P3-24 | `alexia-mcp/{src/types.rs, src/lib.rs, src/host.rs, src/bin/mcp-fixture.rs, tests/compute.rs, tests/elicit.rs}`, `alexia-core/{src/brain.rs, src/upcalls.rs, tests/upcalls.rs}`, `v3/specs/INTERFACES.md` |
| P3-36 | A plugin's question reaches the owner in the window and on Telegram, and only their answer goes back | opus | P3-35 | `alexia-core/{src/upcalls.rs, tests/upcalls.rs}`, `alexia-gateway/{src/ask.rs, tests/elicit.rs}`, `docs/spec/wire-protocol.md` |
| P3-39 | A watch may only poll a reviewed, read-only capability, and never unlocked | opus | none | `alexia-scheduler/{src/lib.rs, src/watch.rs, tests/watch.rs, tests/watch_gate.rs}`, `alexia-hub/src/proactive.rs` (`watchable` only) |
| P3-40 | A plugin's capability upcall to memory.* never unlocks locked memory | opus | none | `alexia-mcp/{src/serve.rs, tests/upcall_lock.rs}` |
| P3-41 | A bad mutes read or a bad proactive setting holds notices instead of saying them | opus | none | `alexia-scheduler/{src/quiet.rs, src/decide.rs, src/notices.rs, tests/fail_closed.rs}` |
| P3-42 | A tool that does not say openWorldHint counts as reaching outside | opus | P4-30, P4-31 | `alexia-core/{src/permissions.rs, tests/open_world_default.rs}` |
| P3-43 | Plugin notice keys are filed by provider, and Done goes only to the plugin that offered it | opus | P3-39, P3-41 | `alexia-scheduler/{src/notices.rs, src/lib.rs (doc only), tests/notice_keys.rs}`, `alexia-hub/src/proactive.rs` (`done`) |

36 tasks, plus the phase review's follow-ups P3-39..P3-43.

## Owner needs

Asked now so nothing waits.

1. **What she may do without asking (D214, PR-26). Proposed first list, for the owner to
   approve, change or cut.** Nothing outside it runs silently from a proactive turn. Until the
   owner approves, the list is empty: proactive runs only read, and ask for everything else.
   Each item is local, reversible and not outward-facing:
   - **Her own memory**: remember a fact, attach its source, mark one no longer true, link people
     and dates, the nightly tidy-up. (Forgetting stays on command only.)
   - **Her own notices and reminders**: hold, batch, snooze, close her own notices; add, move or
     cancel reminders, watches and timers she created.
   - **Your lists**: add a task, tick one you said is done, add to the shopping list. Never delete.
   - **Commitments**: record a promise you made in a conversation, mark it raised.
   - **Drafts kept on this PC**: write an email reply draft into her own folder for you to look
     at. It is not put into Gmail or Outlook and not sent.
   - **Notes from your files**: index and summarise documents and notes in folders you chose,
     and lecture recordings you gave her.
   - **Reading**: calendar, inbox (without marking anything read), contacts, weather, watched
     pages, files in chosen folders. This is reading, not acting, and is allowed even before you
     approve the list.

   **Always asks, whatever the list says:** sending or replying to email (DY-06), creating,
   moving or declining a calendar event that has other people on it, any booking or purchase
   (AC-06, DY-14), submitting a form anywhere, a message to anyone but you, marking mail read,
   moving or deleting mail, deleting or overwriting your files, computer control (mouse and
   keyboard), installing plugins, changing settings or permissions.
2. **The morning brief's trigger (PR-02).** "When I first unlock my phone" needs the iPhone app
   (V3-5). Until then (D-P3-7): the first message, window or PC input after **05:00**, else at
   **09:00**. Optional, today: an iOS Shortcuts automation ("when Telegram is opened" or "when
   the alarm is stopped") that writes an `unlock` event into the iCloud folder apple-context
   already reads. That only reaches the PC if iCloud for Windows syncs that folder. Do you want
   to set that up, and are 05:00 and 09:00 right?
3. **Quiet hours (PR-07).** Default 23:00–07:00, only `Urgent` gets through. Also: lecture times
   (taken from the calendar if it has them)? Evening wrap-up at 21:00, weekly review Sunday
   18:00?
4. **Google (DY-01)**: create a free Google Cloud project with a "Desktop app" OAuth client
   (P3-20's README walks it through), and say which Google account. **Microsoft (DY-02)**: do
   you use Outlook / Microsoft 365 at all (school account?), and may we register an app in
   your (or the school's) Entra tenant? A school tenant may refuse; then DY-02 waits.
5. **School portal (DY-11)**: which one (name and address)? If it needs a login, it goes in
   Credential Manager. Some portals forbid automated access; P3-27 only reads.
6. **Notes app (ME-08)**: which? Obsidian or any folder of Markdown files works out of the box.
   Apple Notes would need the Mac limb (V3-4). Notion or OneNote would need their own accounts.
7. **Import from other assistants (ME-18)**: which exports do you have (ChatGPT's data export,
   Claude's memory export, Gemini)? P3-15 reads the files; you give them.
8. **Screen memory (ME-06)** keeps the *text* of what was on this PC's screen every few
   minutes, never images, never while a private chat, a password field or a game is in front,
   and kept 14 days. It ships off. Turn it on yourself when you want it.
9. **Health nudges (PR-20)** use the Apple Health data apple-context already imports. Which
   nudges: sleep, activity, resting heart rate? Defaults: little sleep two nights running, no
   workout in 5 days.

## INTERFACES.md additions this phase makes

All written by P3-02 in one commit, before anyone implements them. Each task's *Interfaces*
section repeats what it implements.

1. §2.1: `Store::kv_update`, `notice_upsert`, `notices_live`, `notice`, `notice_said`,
   `notice_set`, `notice_seen`, `notices_since`, `mute_add`, `mutes`, `mute_remove`,
   `audit_scheduled_since`; `NewNotice`, `NoticeRow`, `MuteRow`.
2. §2.2: `McpHost::call_capability_all`.
3. §2.3: `Verdict`; `Scope.silent`; `permissions::proactive`; `ToolCtx` unchanged.
4. §2.5: `Trigger::Watch { cap, args, every_ms }`, `Quiet`, `held`, `Proactive` (config),
   `NoticeItem`, `Sources`, `Decision`, `decide`, `radar`, `Scheduler::with_sources`.
5. New §3.6: the P3 capabilities and their argument and result shapes.
6. §4: `Say { .., notice, to }`, `Feedback`, `Active`.
7. §5.3: migration 4 = `notices`, `mutes` (row 4's "sqlite-vec, life graph" struck, D-P3-3).

## Risky or unclear

- **The scope is large.** 61 features, 34 tasks. The engine (P3-04..P3-11) and P3-31/P3-32 are
  the done-when. The plugins can land in any order after P3-03. If the phase runs long, the CEO
  can ship the engine with P3-25, P3-20 and P3-14 and move the rest to a P3b without touching
  the done-when.
- **OAuth for Google and Microsoft** needs the owner's own client registrations (Owner needs 4).
  Google shows "unverified app" warnings for a personal client, which is normal. A school
  Microsoft tenant may block app consent. Then DY-02 waits for the owner.
- **The morning brief's real trigger** (phone unlock) is V3-5. D-P3-7 is a stand-in, and the
  owner may find "first PC input" wrong on days they start on the phone.
- **The brief is composed by code** (D-P3-4). It may read more like a list than a letter. If
  the owner wants it in her voice, a later task can pass it through the chat fast path; the
  done-when does not depend on a model answering.
- **`Event::Say` in code lags INTERFACES** (P2-81 was deferred). P3-04 adds `to` and `notice`
  and fixes §4 to match the code. P2-81's `files` is still open.
- **Some picks lean on later phases**: DY-09 on other devices (V3-4/V3-5), place reminders
  (DY-08) only as good as apple-context's place events, leave-now (PR-10) without live traffic
  (no paid maps API, D212) uses a fixed or owner-set travel time.
- **Screen memory (ME-06) is a privacy risk** even as text. P3-19 is opus and ships off.
