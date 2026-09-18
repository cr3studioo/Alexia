# plan_final_v2 — M8-6 / M8-7, one ordered checklist

> **What this file is.** Every unfinished task from `model_plan.md` (M8-6), `plan-personality.md`
> (M8-7), and the session brief that kicked off this round of work, merged into one flat list,
> numbered top to bottom. Work it in order: nothing here needs a task that comes later than it.
> Tick a box (`- [ ]` → `- [x]`) when that item is actually built and tested, not when it is
> merely started — matching the checkbox convention `plan.md`'s own status board already uses.
>
> **Already fully done, and not in this list:** `models_plan_final.md` — all 29 board items are
> ticked and its §6 definition of done was checked against the tree (commit `d717f91`). Nothing
> there needs revisiting. Also already done: `model_plan.md` §1 steps 1, 3, 4; §2; §3; §4 A–J
> (decisions D154–D171); `plan-personality.md` order-of-work steps 0–2. What remains is below.

---

## Read first

**Required reading, in this order**, before touching anything: `CLAUDE.md` → `Alexia.md` (the
decision log D154–D171 and the "What the Models screen lists, and how Automatic ranks" section);
`plan-personality.md` in full; `model_plan.md`'s "Built …" notes from D162 to D171, its "Order of
work" and "Open decisions" sections; `plan.md`'s M8-6/M8-7 status lines and its newest change-log
entries. **Every file:line reference below was checked once, on 2026-09-17** — re-check before
relying on any of them, because this codebase's own docs note that they drift.

### Standing rules — apply to every numbered item below

**Decisions already made stay made.** Everything in Alexia.md's D154–D171 is settled; don't
reopen any of it. If a plan document doesn't answer something, or contradicts Alexia.md or an
earlier decision, say so in plain words and ask with the question tool — the format used in
item 1 below. Don't silently pick a side.

**Never break the live app on this Mac:**
- `alexia.db` is in WAL mode. To read it: copy `alexia.db`, `-wal` and `-shm` into the scratchpad,
  open the copy, delete the copies afterwards. Never write to the original.
- The persona plugin installed there is hand-patched
  (`~/Library/Application Support/Alexia/extensions/persona/index.js`). Never delete or reinstall
  it — that deletes every saved personality.
- The app's database is at migration 5; the code is at migration 7 (5→7 was already verified on a
  copy). If any item below adds a migration, check it on a copy of that database too.
- This Mac runs Ollama on `127.0.0.1:11434`. Any test that starts `serve()` passes `local: false`.

**How to work:**
- Deps: `npx -y pnpm@10.10.0 install --frozen-lockfile`
- Build: `npx tsc -b`
- Lint: `npx eslint . && npx depcruise packages`
- Tests: `npx vitest run --project unit [files]` and `npx vitest run --project invariants`
- Commit after each logical step (each numbered item below is one), ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Don't push.
- The plan's acceptance tests are the specification. Write them as real tests; say which cannot
  be written, and why.
- For any shell (UI) change, also drive the real page in headless Chromium (`playwright-core` in
  the scratchpad worked last time) and say what was checked.
- Throwaway probe scripts belong in the scratchpad; delete them afterwards.

**Gotchas from last time:**
- `depcruise`'s no-circular rule counts type-only imports — move shared pieces to a lower module,
  as `PLANNER` and `stature()` went to `catalog.ts`.
- The UI stylesheet tests want a CSS rule for every class the shell uses, and only defined tokens.
- A plugin-contract change means: bump `ALEXIA_PROTOCOL_MAX`, regenerate
  `docs/spec/plugin.schema.json`, and document it in `manifest.md`, `ui-schema.md` and
  `versions.md`.
- MCP SDK 2.0.0 ignores a cancel for request id 0.
- For `serve()`-level tests, copy the pattern of `packages/core/test/bad.test.ts` and
  `paid.test.ts`: a stub provider plus `noPolling()`. `packages/core/test/fixtures/asker.js`
  stands in for a plugin or a phone.
- Stored messages can carry extra fields (`notes`, `provider`, `bad`) safely: `toWire()` in
  `provider.ts` is a whitelist, so nothing else reaches a model.
- The row of actions under the latest answer is `answerActions()` in `packages/ui/src/main.ts`.
  *That wasn't her* (`plan-personality.md` step 8) goes in that row later — see item 17.
- Plan-personality step 5 (the writer) must skip models that `judge()` in `health.ts` marks as
  new, set aside or doubted. That record exists now — see item 14.

**Recording a decision made while building** (needed by items 1, 4, 5, 6 and 10 below, if they
land on anything not already covered by D154–D171): the same day, in three places —
1. `Alexia.md`'s decision log: a new table row, newest first, `**D172 — …, as built**` (next
   number after D171; increment for each further decision made in this session);
2. `plan.md`'s change log: a matching newest-first row;
3. the plan document the decision came from, as a `**Built YYYY-MM-DD (D172)**` note in the shape
   `model_plan.md`'s D162–D171 notes use ("where the build differs from the text above", then
   "Tests:"), plus a status-line update and that order-of-work item struck through.

### Owner-only — not steps for the model

- `plan-personality.md` step 0: delete the broken *Alexia* row from the app's own Personality
  screen. Never from the database, never by removing or reinstalling the plugin.
- Before a public release: check that each free provider's terms allow the daily automated test
  message (model_plan.md's last open decision).
- Nothing built below reaches the installed app until there is a new build.

---

## This session

- [x] **1. Ask the four decisions, before any code.**
  One `AskUserQuestion` call, at most 4 questions, the recommended option first, one line of
  consequence per option:
  - Build the keyless group's on/off switch (`model_plan.md` §1) now, or later?
  - Are the table mock-up's unbuilt parts wanted: filter chips (*Needs attention* / *New* / *Set
    aside*), a line under each group heading, a row that opens on click?
  - *Bad answer* is on the latest answer only; the plan said every answer. Keep it that way?
  - Tick M8-6 in `plan.md` now that `model_plan.md` is built?

  Record the four answers — they gate items 3–6 below.

- [x] **2. Fix the set-aside sentence, and the stale note about it — no decision needed.**
  `packages/core/src/surface.ts:270–278` — the sentences for `answers empty`, `always busy for
  you`, and the timeout/failure case each end *"One good reply brings it back."* with no mention
  of a test. Since §4 E (the daily test message) is built now (D166), say a test goes out too,
  the way the mock-up's *"a test message tomorrow"* did.

  Also correct `model_plan.md`'s D164 build-note (currently: *"A set-aside sentence promises no
  test message, since §4 E is not built: 'One good reply brings it back.'"*) — E is built; update
  the note to say so.

  No new decision number needed — this is fixing a note against reality, not deciding anything.

- [x] **3. If item 1 said yes: tick M8-6 in `plan.md`.**
  `plan.md:285` — `model_plan.md` is fully built (§1 steps 1–4, §2, §3, §4 A–J). Tick that box.
  Leave M8-7 (`plan.md:286`) unticked: `plan-personality.md` isn't done until item 17 lands.

  *If item 1 said no, skip this and note why in the session report (item 13).*

- [x] **4. If item 1 said "now": build the keyless group's on/off switch.**
  `model_plan.md` §1's last open piece of step 2. `available(model, connected, spend)` already
  exists (`router.ts`); this adds the switch itself. The decision to have one is already settled
  — *"Yes, as their own group … switched on by default and switchable off"* (D154) — so this is
  implementation, not a fresh decision, unless a real choice comes up while building it (in which
  case, record it per the "Read first" protocol above with the next D-number).

  Acceptance: switching a keyless provider off drops its models from `available()` and the Models
  tab; switching it back on restores them without a reload.

  *If item 1 said "later", skip and leave `model_plan.md` §1's note as-is.*

- [x] **5. If item 1 asked for any table pieces: build exactly those.**
  From `model_plan.md` §4 C's "not built from the mock-up" list: filter chips (*Needs attention*
  / *New* / *Set aside*), a line under each group heading, and/or a row that opens on click
  (today only the *Details* button opens one). Build only what was asked for.

  Check the plugin-contract-bump gotcha before starting: it only applies if a field genuinely
  needs to move into the `table` widget's contract (as `groupOrder`/`note`/`tags` did for D164) —
  a filter control or a click handler drawn purely in `surface.ts`/the shell may not need one.

  *If item 1 said none are wanted, skip.*

- [ ] **6. If item 1 said change it: Bad answer on every finished answer, not the latest only.**
  D170 built *Bad answer* on the latest answer only, because re-asking an older question would
  rewrite everything said after it — that reasoning does not disappear just because the scope
  widens, so re-read it before changing anything. If the owner still wants every answer, this
  reverses part of D170 on purpose (not silently): record it as a new decision (next D-number) in
  `Alexia.md`, `plan.md`, and a `Built (Dxxx)` note in `model_plan.md`'s §4 I section, explaining
  what changed and why the D170 reasoning about rewriting history was decided not to apply (or
  how it's handled for a non-latest answer).

  *If item 1 said keep it as-is, skip — no change needed, D170 stands.*

  **Not built, deliberately (2026-09-18).** Item 1's answer was to keep *Bad answer* on the
  latest answer only. D170 stands untouched, no new decision was taken, and no code changed.
  Left unticked because nothing was built — not because anything is outstanding.

- [x] **7. `plan-personality.md` order-of-work step 3: the trace line.**
  A trace-panel line showing the personality's length (was it sent, and how much) per step — see
  `packages/core/src/trace.ts`'s `Trace` class and how `agent.ts` appends step data
  (`agent.ts:668`, `steps.push(step)`). Before coding: say in plain sentences what will be built,
  and flag anything in the plan that looks wrong, per the brief. Drive the trace panel in headless
  Chromium once built.

- [x] **8. Step 4a — improvement 1: keep the words with the personality.**
  `plugins/persona/`: store the description that was adapted, which model wrote it, and when, on
  the personality's own row. Add **Re-adapt** as a row action. Keep the previous version on every
  change, with **Undo**.

  Everything later that touches a personality's row (improvement 6's safety check, improvement
  2's Refine, improvement 3's preview) builds on this — it goes first for that reason.

- [x] **9. Step 4b — improvement 6: a safety check in code, not only in the prompt.**
  A deterministic check, run on save (and, once they exist, on refine and import): flags and
  removes lines telling her to skip asking, hide what she did, ignore a limit, or claim to be
  human, with a visible note of what was removed and why. Placed after item 8 so it already
  covers the new **Re-adapt** path from day one.

- [x] **10. Step 4c — improvement 7: show what it costs — flag before coding.**
  Tokens per step for each size, and roughly per 15-step task; a line at Adapt time if the high
  size is over budget. An estimate labelled as one (characters ÷ 4) is enough.

  **Say this to the owner before coding, don't silently resolve it:** the order of work schedules
  this *before* §2's three sizes exist (that's item 15, "beyond this session"), but the
  improvement's own text says it "makes §2 visible" — i.e. it reads most naturally once
  small/medium/high exist. Pick one: show cost against today's single document for now and extend
  once item 15 lands, or defer this item until after item 15. Either is fine; don't build it
  assuming sizes exist when they don't yet.

- [x] **11. Step 4d — the `/persona` command (part of improvement 8).**
  Manifest `commands`: `/persona` lists the saved personalities, `/persona <name>` switches,
  `/plainly` turns it off. `commands` is already a manifest field (`docs/spec/manifest.md`,
  `docs/spec/plugin.schema.json`) — no protocol bump needed. Works on Telegram too, since slash
  commands already reach plugins from there. **The header chip is not part of this item** — it's
  explicitly deferred to item 17 ("M for the chip" in the plan).

- [x] **12. Reconcile the decision record.**
  Confirm every decision actually made in items 1, 4, 5, 6 and 10 has a same-day entry in
  `Alexia.md`'s decision log, `plan.md`'s change log, and the originating plan's own
  `Built (Dxxx)` note with its order-of-work line struck through. This is a final check — each
  item above should already have recorded its own decision as it was made; this step exists to
  catch anything missed before the report below is written.

- [ ] **13. Stop point: full suite, report.**
  This is the brief's "stop after step 4" — i.e. after item 11 above, which is
  `plan-personality.md`'s own order-of-work step 4 finishing, and the genuinely last action of
  the session. Run, in order:
  `npx tsc -b`; `npx eslint . && npx depcruise packages`;
  `npx vitest run --project unit`; `npx vitest run --project invariants`.

  The known flaky test is *"the memory panel forgets exactly the row it was pointed at"* — if it
  alone fails, re-run it before investigating further.

  Report in plain language: what was built, with commit hashes; which acceptance tests could not
  be written, and why; and the outcome of each conditional item (3–6, 10) — built, skipped, or
  deferred, and which way each decision went.

---

## Beyond this session — later work, same rules, don't start without cause

- [ ] **14. `plan-personality.md` step 5 — §1, the writer.**
  In this order, because the plan's own sub-items have this dependency shape:
  1. **M8-1 first.** `intelligencePriority` sorts best-first; manifest `min_tier` becomes
     `Ask.minTier`. Confirmed unbuilt by grep (`Ask.minTier` exists and is read in `router.ts`,
     but nothing sets it; `modelPreferences` has zero references in `packages/core/src`). This is
     also `plan.md`'s own top-level M8-1 item — ticking it there is part of this item.
  2. **Never a router, and never a model Alexia doubts.** Straightforward now: `judge()`'s tags
     (new/not-tried-yet, set aside, too-many-errors, gave-bad-answers) already exist from
     `model_plan.md` §4 B.
  3. G13's run id on Adapt (a button pressed is a run, D156) — needed so Adapt may use a paid
     model under the monthly cap.

  *Already done, don't redo:* "prefer a model that answers" (D160/D162) and "Adapt counts as the
  chat" (D161/D168) — both sub-items of this same section in `plan-personality.md`.

- [ ] **15. Step 6 — §2, three sizes.**
  Small (~100 words), medium (~300), high (~600), chosen per call for the weakest model in that
  step's plan. Once this lands, revisit item 10 if it was deferred rather than built against the
  single-document estimate.

- [ ] **16. Step 7 — improvements 2, 3, 4, 5, 9.**
  Refine (2), the preview with Skip (3), flagging inert behaviour lines (4), facts to Memory with
  one confirm for all (5), and a personality per channel (9).

- [ ] **17. Step 8 — improvement 10, joined with Bad answer.**
  *"That wasn't her"* joins `model_plan.md` §4 I's *Bad answer* as one row of message actions
  (`answerActions()` in `packages/ui/src/main.ts`) — build them together, not twice. The header
  chip deferred from item 11 (improvement 8) lands here too.

- [ ] **18. `model_plan.md`'s deferred item: the model record shared with the owner's server.**
  Explicitly "decided later" (D160); the hook already exists and does nothing (D171, §4 J). Do
  not start this without a fresh, explicit decision from the owner — it touches Alexia.md's *no
  user backend at all* and the registry's *no analytics* promises and needs a privacy policy
  first.
