# Code Review Findings

Branch: `cr3studioo/personality-plugin-adapt-model`
Scope: `git diff @{upstream}...HEAD` (~6649 lines, 57 files)
Method: 10 parallel finder angles (5 correctness + reuse/simplification/efficiency + altitude + CLAUDE.md conventions), single-vote verification on every candidate, plus a Phase 3 gap sweep (also verified). This is a findings report only — no fixes have been applied.

23 candidates survived verification as CONFIRMED or PLAUSIBLE; 4 were REFUTED with evidence (see bottom of this document). Below are the 15 most severe, ranked with correctness bugs prioritized over cleanup findings.

---

## 1. `packages/core/src/store.ts:755` — Bad-answer avoid-list broken for router-served models

**Summary:** `markLastAnswerBad()` returns the provider-reported model id (persisted by `provider.ts`'s `chat()` when `chunk.model` overrides the requested id), not the catalog id that `route()`'s avoid-list matching uses, so "Bad answer" silently fails to exclude router/gateway catalog entries.

**Failure scenario:** A reply comes from a router-style catalog row (e.g. `kilo-auto/free` or `openrouter/free`, which `catalog.ts` documents as "hands the request to a different model each time"). Pressing "Bad answer" builds `avoid: ['kilo-gateway\n<resolved-id>']`, but `router.ts`'s `route()` filters by `${c.provider.id}\n${c.model.id}` using the catalog id `'kilo-auto/free'` — never matching — so Automatic can immediately re-select the same router entry and route back to the same bad model.

---

## 2. `packages/ui/src/main.ts:193` — "Bad answer" race can mark the wrong answer

**Summary:** The "Bad answer" button attached to an answer bubble stays clickable until the next `respond()` call's `done` SSE event is processed client-side, but server-side `markLastAnswerBad()` only ever marks the session's current last assistant message, with no turn/id correlation to the button that was clicked.

**Failure scenario:** User asks Q1, gets A1 (Bad-answer button shown). User asks Q2; `agent.ts` appends A2 to the session the instant the model answers, before the `done` SSE frame is even sent. If the user clicks A1's still-live Bad-answer button in that window, the server marks A2 (not A1) bad and excludes A2's model from the retry, while the UI shows "You marked this a bad answer" under A1 — the wrong answer is silently marked and hidden from future context.

---

## 3. `packages/core/src/store.ts:746` — `markLastAnswerBad()` has no server-side gate

**Summary:** `markLastAnswerBad()` walks every assistant message in the whole session (DESC) looking for the first one without tool calls, with no server-side gate on message/turn state — the `done.ended === 'answered'` check that would prevent this exists only in the UI, not in the API handler.

**Failure scenario:** A task ends `'ceiling'` or `'stopped'` (its last assistant row has tool calls, no final text). Any direct `{again:true, bad:{}}` POST to that session (not gated by the UI-only check) walks back past that incomplete turn and marks a much earlier, unrelated, fully-answered turn as bad, silently dropping it from future model context via the `bad !== true` filter.

---

## 4. `packages/core/src/surface.ts:506` — Duplicate contradictory Models table rows

**Summary:** The Models table's `shown` dedup Set is only populated by the Automatic/Paid `push()` calls, not by the CHOSEN (pinned) / LISTED `push()` calls, so a pinned model that `health.judge()` also marks "set aside" renders as two rows with contradictory notes.

**Failure scenario:** User pins model X; X later accumulates enough failures that `judge()` sets `judged.aside`. `route()`'s pinned branch bypasses aside filtering entirely and still returns X, so it's pushed once under "Your choice" without touching `shown`. The later aside-group filter (`!shown.has(rowId(...))`) then matches X again (`available()` has no health check), pushing a second row: "Set aside by Alexia: ... not answering." next to "Your choice: every request goes to it."

---

## 5. `packages/core/src/agent.ts:613` — Duplicated probe blocks with asymmetric filtering

**Summary:** Two near-identical post-failure "would paid have answered" probe blocks differ in whether they exclude providers whose key was just refused: the first filters via `refused`, the second omits that filter entirely.

**Failure scenario:** Free rungs fail, and the only paid rung is behind a provider whose key was also just refused in the same plan walk. The second block (paid switch already on, allowance exhausted) still reports "today's paid allowance is spent — raise it" even though raising the allowance won't fix a refused key — the first block's own comment ("Not behind a key that was just refused") shows the authors knew this filter was needed, and it wasn't carried into the second block.

---

## 6. `packages/core/src/agent.ts:616` — `refused` set misses 402 no-credit failures

**Summary:** The `refused` set used to gate the "Allow switching to a paid model" prompt is populated in `router.ts`'s `send()` only for 401 key-refusal failures, never for 402 no-credit failures.

**Failure scenario:** A paid rung fails with a 402 "no credit" error (not 401). `refused` stays empty, so `agent.ts` can still offer "Allow switching to a paid model" for that provider; accepting it retries and immediately hits the same 402 again.

*(Verdict: PLAUSIBLE — mechanism confirmed, exact trigger config is edge-case-dependent.)*

---

## 7. `packages/ui/src/widgets.ts:750` — News line gets stuck on "Nothing matches that."

**Summary:** The table widget's `paint()` overwrites the news line (`said.textContent`) with "Nothing matches that." when a filter matches zero rows, but never restores the original news text — only a full `load()` (not `paint()`) sets `said.textContent` to the news sentence.

**Failure scenario:** Models tab shows a news sentence ("1 new free model since..."). User types a filter matching no rows, then clears the filter. `paint()` re-runs on every keystroke but never resets `textContent`, so "Nothing matches that." stays displayed in place of the news line for the rest of the session, even with all rows visible again.

---

## 8. `packages/ui/src/widgets.ts:1706` — `noteAt` fallback attaches note to a right-aligned column

**Summary:** `noteAt = Math.max(0, columns.findIndex(c => c.align !== 'right'))` clamps a "no non-right column" result (`-1`) to `0`, attaching a row's note to column 0 even when that column is right-aligned.

**Failure scenario:** A table (core-declared or plugin-declared via the manifest, which has no restriction on column alignment combinations) has every column right-aligned. Any row with a `note` gets it attached under a right-aligned numeric column, reproducing the exact wrapping bug the surrounding comment says this code avoids. Not covered by the new `widgets.test.ts` case (which uses non-right columns).

---

## 9. `packages/ui/src/widgets.ts:1708` — `tags` branch skips note rendering entirely

**Summary:** The `tags` column's render branch does an unconditional `continue` before the note-attachment check runs for that column index, so if `tags` lands at the index `noteAt` resolves to, `row.note` never renders for any row in that table.

**Failure scenario:** A table (plugin or future core table) declares `tags` as, or before, its first non-right-aligned column. `noteAt` resolves to that index, but the `tags` branch's `continue` permanently skips the note-attachment code at that index — total, silent loss of the notes feature for that entire table. Not covered by the new test, which orders `name` before `tags`.

---

## 10. `packages/core/src/provider.ts:1030` — Keep-alive-only stream mislabeled as "stalled"

**Summary:** `started` is set true by keep-alive-only stream chunks, so a stream that sends only keep-alives and then goes fully silent before the new keep-alive-wall threshold (120s) is reached gets mislabeled by the ordinary 20s between-timeout as "went quiet partway through an answer" (`trouble: 'stalled'`) instead of "never answered."

**Failure scenario:** A provider sends a few keep-alive comments (setting `started = true`, `answered` never `true`) then stops entirely for 20s+ but under 120s. `gaveUp` fires with `started = true`, producing a misleading user-facing message and an incorrect outcome/evidence-log entry in the Models tab, even though no real content was ever streamed (ranking is unaffected since both outcomes land in the same `STRUCK`/`ERRORS`/`WALLED` sets).

---

## 11. `packages/core/src/serve.ts:649` — `testModels()`/`trial()` reentrancy race

**Summary:** `testModels()` has no reentrancy guard beyond `answering()` (task/sampling in-flight check), and `trial()` does an unsynchronized `kvGet`-then-per-test-`kvSet` read-modify-write on the `TESTED` kv record.

**Failure scenario:** If a trial run is still in flight when the next scheduled trigger fires `testModels()` again (e.g. timer coalescing after system sleep, or a manual re-trigger), two overlapping `trial()` calls can each load a stale `tested` snapshot and overwrite each other's `kvSet`, causing a model to be tested twice or the day's test count to be lost. Low-probability under normal single-process timing (60s startup timer vs. 6h interval; runs typically finish in well under an hour) but has no compensating guard.

*(Verdict: PLAUSIBLE.)*

---

## 12. `packages/core/src/catalog.ts:510` — Ungrammatical "A and B and C" join

**Summary:** `news()`'s named-models branch uses `shown.join(' and ')` when there's no "N more" suffix, producing the ungrammatical "A and B and C" for exactly 3 new free models, instead of the Oxford-comma style used elsewhere in the codebase (and used by this same function for 4+ items).

**Failure scenario:** A refresh adds exactly 3 new free models in one cycle: `shown = ['A','B','C']`, `more = 0`, so `names = 'A and B and C'` (`Array.join` inserts "and" between every pair). `catalog.test.ts` only exercises the 1-item case, so this is untested.

---

## 13. `packages/core/src/pool.ts:83` — Unvalidated KV cast to `Account`

**Summary:** `store.kvGet(CORE, accountKey(provider.id)) as Account | undefined` casts unvalidated KV data straight to `Account` with no runtime shape check before `fundedBy()` reads `.freeTier`/`.limitRemaining` off it.

**Failure scenario:** A stale or malformed stored value under this key would be silently treated as a valid `Account`, producing a wrong `funded`/`dayLimit` result rather than failing loudly.

*(Verdict: PLAUSIBLE — no current code path writes a shape-mismatched value to this key, so it isn't reachable today, but there's no defense if that changes.)*

---

## 14. `packages/core/src/store.ts:920` — `seen` table unbounded + full scan every agent step

**Summary:** The new `seen` table is never pruned (rows only INSERTed/UPDATEd, unlike `tries` which deletes rows older than 30 days on every insert), and `seen()` runs an unfiltered full-table scan inside `judge()`, which `world()` now calls once per agent-loop step (not once per ask).

**Failure scenario:** Every step of a multi-step agentic task reruns a full, uncached scan of both `tries` and `seen` via `judge()` inside `world()` (`agent.ts`'s `for(;;)` loop calls `world()` every step). `seen` accumulates one permanent row per distinct provider+model pair ever observed, with no pruning.

*(Verified as a real but scale-bounded inefficiency — this is a local single-user SQLite app, not a severe hot-path crisis — but a genuine, fixable redundancy.)*

---

## 15. `packages/core/src/router.ts:573` — `ranking(world, 'best')` rebuilt on every `fitting()` call

**Summary:** `ranking(world, 'best')` is rebuilt from scratch inside `fitting()` on every call (re-running `sunk()` over strikes and rebuilding a `lately` Map plus 10 `Key` closures), instead of being hoisted once like the "cheap" ranking (`const ranked = ranking(world).compare`, hoisted at line 414).

**Failure scenario:** `fitting()` can be called up to 3 times in a single `route()` invocation (`everyone`, `unrationed`, and one of `priced`/`sidegrade`). When `pins.prefer === 'best'`, each call redundantly reconstructs the same ranking object instead of reusing one computed once per `route()` call.

---

## Cut from the top 15 (still real, lower severity)

These were CONFIRMED/PLAUSIBLE but dropped when the 15-item cap forced a cut (all are cleanup/reuse/efficiency, not correctness bugs):

- `packages/core/src/serve.ts:1078` — a third copy of "ask yes/no via MCP capability" logic, already duplicated between `asCommand` and `asTask`'s `approve` callback.
- `packages/core/src/router.ts:618` / `:1054` / `:1096` — a modality-name ternary duplicated 3x with no shared helper.
- `packages/core/src/agent.ts:458` — dead `upward` alias (`const upward: Pins = pins`, never reassigned), leftover from the removed MoneyConsent feature.
- `packages/core/src/surface.ts:375` and `:542` — `rows()` and `detail()` both redundantly re-fetch `store.tries()` after `world()` already fetched it internally via `judge()`.
- `packages/core/src/health.ts:123` — hand-rolled `MONTHS` array/`day()` formatter instead of `Intl.DateTimeFormat` (already used in `host.ts`/`surface.ts`).
- `packages/core/src/store.ts:203` — `weekOf()` reimplements the day-bucket math already present as `SPANS[1][1]` in the same file.
- `packages/core/src/surface.ts:527` and `:929` — a composite `provider\nmodel` id-parsing expression pasted verbatim twice, no shared decoder despite an existing encoder.
- Join-list ("A, B and C") duplication across `router.ts:434`, `router.ts:1284`, `ui/main.ts:730` — PLAUSIBLE; note `catalog.ts` does *not* actually share this pattern (that part of the original candidate was refuted).

## REFUTED candidates (investigated, found not to be bugs)

- **`serve.ts`'s plugin-sampling handler using bare `world()` instead of `worldFor()`** — looked like a paid-switch billing bypass, but `send()` has an independent `unpaid()` gate that blocks any paid model from ever being billed on the plugin-sampling path, regardless of `world()` vs `worldFor()`.
- **`store.ts`'s `#waits` Map "unbounded growth"** — actually self-limiting: entries are keyed by `provider\nmodel`, so repeat rate-limits on the same pair overwrite in place rather than accumulate.
- **`surface.ts`'s `useModel()` cross-provider fallback "silently mis-pins to the wrong provider"** — pins never persist a provider (`Pins.model` is a bare string), so this fallback cannot cause a wrong-provider pin; the router always re-resolves the provider fresh on every request.
- **`router.ts`'s `World.reported` field "dead/unread"** — confirmed intentional: a commit message and a dedicated test (`report.test.ts`, "nothing calls the report and nothing sends it") document this as a deliberate, not-yet-wired hook for a future feature (§4 J, D171), not an oversight.
