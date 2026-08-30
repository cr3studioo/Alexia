# models_plan_final.md

**The build plan for [`models_plan.md`](./models_plan.md).**

*Written 2026-08-30. This is the `plan` half of the pair; [`models_plan.md`](./models_plan.md)
is the `facts` half. Neither replaces the other.*

---

## 0. What this file is, and how to use it

[`models_plan.md`](./models_plan.md) is an information capture. It says so itself in
[§0](./models_plan.md#0-what-this-document-is--and-is-not): *"It does not schedule
anything. It does not authorise anything."*

**This file schedules and authorises it.** It contains no new facts. Every fact lives
in `models_plan.md` and is linked to. This file contains only: ordering, dependencies,
scope fences, acceptance criteria.

**How the two are used together.** Open a task below. Follow its `Source:` links into
`models_plan.md` and **read those sections in full** before writing a line. The task
tells you *what to do and when it is done*; the source tells you *what is true*.

> **Precedence.** Where this file and `models_plan.md` disagree on any fact — a URL, a
> limit, a model id, a ToS verdict, a gotcha — **`models_plan.md` wins, always.** This
> file is allowed to be wrong about facts; it is not allowed to overrule them. If you
> find a disagreement, fix this file, never that one.

---

## 1. Scope fence

### 1.1 In scope

Exactly the features described in `models_plan.md` §6 through §14, built in the order
in §4 of this file. Nothing else.

### 1.2 Out of scope — do not do these, ever, in this work

| Forbidden | Why |
|---|---|
| **Reading, following or updating [`plan.md`](./plan.md)** | This work is deliberately outside it. Do not start at its Status board. Do not add `D`-numbers or tasks to it. Do not renumber it. `models_plan.md` §16 Q6 is **not** yours to answer. |
| **Editing [`models_plan.md`](./models_plan.md)** | It is the source of truth and a historical record, corrections included ([§4.3](./models_plan.md#43-corrections-made-during-this-research)). Read-only. |
| **Editing [`Alexia.md`](./Alexia.md)** | Out of scope. Cite it, never change it. |
| Committing, pushing, branching, or opening a PR unless explicitly asked | The user drives git. |
| Reverting, stashing or committing the working tree's pre-existing modifications | Unrelated in-flight work exists. Leave it alone. Work alongside it. |
| Refactoring, renaming, reformatting or "tidying" any code a task does not name | Scope creep is the main way this goes wrong. |
| Upgrading, adding or removing dependencies not required by a named task | Same. |
| Adding **any** provider from the `avoid` bucket | [§6.5](./models_plan.md#65-rejected-with-reasons), [§15](./models_plan.md#15-do-and-do-not), [§17.1](./models_plan.md#171-the-keyless-catalogue-in-full). However good the model list looks. |
| Running OmniRoute or FreeLLMAPI as a daemon or sidecar | [§3.3](./models_plan.md#33-verdict-take-the-table-do-not-run-the-daemon). Vendor the rows, not the process. |
| Enabling the Claude Code plugin, or putting it in a default cascade | [§14.1](./models_plan.md#141-the-claude-code-rung-cannot-be-automatic). It ships off. |
| Inventing a fact `models_plan.md` does not state | See R2. |

---

## 2. Standing rules — these apply to every task below

**R1 — `models_plan.md` is the only source.** Do not re-research. Do not fetch OmniRoute
or FreeLLMAPI. Do not go looking for newer numbers. Everything needed is captured.

**R2 — Never invent a fact.** If a task needs a value that `models_plan.md` does not
state — a model id, a rate limit, a header, a ToS verdict, a `trainsOnYourData` answer —
**stop and ask the user.** Do not infer it, do not guess it, do not derive it from the
price ([§14.3](./models_plan.md#143-the-tos-posture): *"Never infer the answer from the
price"*). An unanswered question is a blocked task, not a creative opportunity.

**R3 — Line numbers have drifted.** `models_plan.md` [§17.4](./models_plan.md#174-alexia-source-references)
gives `file:line` references captured on 2026-08-30 against `main`. The tree has moved
since. **Locate every target by symbol name** (`PROVIDERS`, `MODES`, `Pins`, `PLANNER`,
`costOf`, `firstRun`, …), using the line number only as a hint. If a named symbol does
not exist, **stop and report it** — do not pick the nearest thing that looks similar.

**R4 — [§15](./models_plan.md#15-do-and-do-not) is binding.** Re-read the Do / Do-not
list at the start of every phase. Every bullet in it is a hard constraint on this build,
not advice.

**R5 — One task, one change.** Do not begin a task whose `Depends on` is unfinished. Do
not fold two tasks into one edit. Do not touch a file a task does not name.

**R6 — Every provider row carries provenance.** A `Source:` comment naming where the row
came from, and a `verified:` date. This is simultaneously the MIT licence courtesy
([§3.4](./models_plan.md#34-licence-clean), [§14.2](./models_plan.md#142-licence-obligations))
and the staleness marker ([§7](./models_plan.md#7-changes-needed-to-the-provider-interface),
[§13.4](./models_plan.md#134-no-staleness-marker-on-provider-rows)). A row without both
is not finished.

**R7 — Providers are rows, not code.** `provider.ts`'s own header: *"adding a provider
must never mean adding code."* Exactly two tasks in this plan are allowed to add
mechanism for a provider — **MP-9** (Cloudflare's URL template) and **MP-10** (Cohere's
call budget) — and both exist precisely so that no other provider needs an exception. If
a third provider seems to need code, stop: that is a schema question for the user.

**R8 — Tests are part of the task.** A task is not done when the code compiles. It is
done when its `Done when` boxes are all tickable, including the test one.

**R9 — Report honestly.** If a probe fails, a limit turns out wrong, or a step is
skipped, say so in plain words. A silently degraded result is the exact failure mode this
whole document exists to prevent ([§2](./models_plan.md#2-the-goal): *"Never silently
degraded."*).

**R10 — Do not answer the open questions yourself.** [§16](./models_plan.md#16-open-questions--need-a-human-answer)
needs a human. Section 3 below is that gate.

---

## 3. Gate 0 — decisions required before any code is written

`models_plan.md` [§16](./models_plan.md#16-open-questions--need-a-human-answer) lists
seven questions that need a human answer. Each row below carries **the recommendation
`models_plan.md` itself makes**, pre-selected as the default. The owner ticks, strikes or
overrides. **Do not start MP-1 until every row is settled.**

**Settled by the owner on 2026-08-30.** All seven rows are answered; MP-1 may begin.

| # | Question | Default (from §16) | Settled? |
|---|---|---|---|
| **Q1** | Does local become a rung in the cloud text cascade? | *No default given — §16 marks it "Blocking for the ladder".* **Must be answered by the owner.** | **[x] Yes** — local becomes a rung, placed low |
| **Q2** | How many providers, and how curated? | **(a)** Tier A + the seven = 11 new rows; then **(b)** the ToS-`ok` cluster = 16 *if the key wall looks sparse* | **[x] (b)** — 16 new rows; MP-14 runs |
| **Q3** | How is Cloudflare's account-id-in-URL handled? | **A `{account}` template in `baseUrl`, key stored as `account_id:api_token`** (FreeLLMAPI's approach) — keeps R7 intact | **[x] Template** — MP-9 runs as written |
| **Q4** | How is a call budget expressed? | *No recommendation given.* Add a `callsPerMonth` field **or** drop Cohere. **Owner picks.** | **[x] `callsPerMonth`** — MP-10 runs; Cohere stays |
| **Q5** | What is the default daily allowance? | **$0** — makes `mixed` behave like `free` until the user opts in | **[x] $0** |
| **Q6** | One `D`-number or several? | **Not applicable — out of scope (§1.2).** `plan.md` is untouched by this work. | n/a |
| **Q7** | Is the `avoid` bucket permanently out? | **Permanently out.** Confirm | **[x] Out pending a written policy** — see note below |

**What each answer changes in this plan:**

- **Q1 = yes** → MP-17 runs, and MP-18 uses the full nine-rung ladder from
  [§8.2](./models_plan.md#82-the-ladder).
  **Q1 = no** → **MP-17 is deleted**, and MP-18 builds the ladder with rungs 4 and 8
  (local) absent. Say so explicitly in the code comment; do not leave a phantom rung.
- **Q2 = (a)** → **MP-14 is deleted.** **Q2 = (b)** → MP-14 runs. **Q2 = (c)** → stop and
  ask; "everything credible" is not a specification this plan can execute.
- **Q3 = template** → MP-9 runs as written. **Q3 = code exception** → MP-9 is rewritten
  by the owner first (it breaks R7). **Q3 = drop Cloudflare** → MP-9 deleted, and
  Cloudflare drops out of MP-13.
- **Q4 = `callsPerMonth`** → MP-10 runs. **Q4 = drop Cohere** → MP-10 deleted, and Cohere
  drops out of MP-13.
- **Q5** → the literal default value in MP-5.
- **Q7 = confirmed** → the §1.2 fence stands as written.

**Note on MP-18 (settled by the owner on 2026-08-31).** §8.2 separates rung 1 (*your own
direct free-tier keys*) from rung 3 (*OpenRouter free*), and no field on a `Provider` row says
which of the two a row is — R7's stop condition. The owner chose **leave them collapsed**: the
ladder ships as eight distinguishable rungs (hands → mouths, each half keyed → this machine →
keyless floor), and keyed free tiers sort among themselves on the rules already there. No new
schema field, and no provider named in `router.ts`. `standing()` in `router.ts` says so.

**Note on Q7.** The owner chose *out pending a written policy* rather than *permanently
out*. This changes nothing about what gets built: the §1.2 fence stands unaltered for this
work, and no `avoid`-bucket provider enters. It records only that the exclusion is open to
revisiting later, once someone writes the criteria down. `models_plan.md` §6.5 still says
*permanently out*; per §0's precedence rule that wording is a record of what was true when
written, and this note is the later decision — the fence itself is unchanged either way.

---

## 4. The board

Work top to bottom. Do not reorder. Tick as you go.

| | ID | Task | Depends on | Source |
|---|---|---|---|---|
| **A — schema & safety** | | | | |
| [x] | MP-1 | The five new `Provider` fields | Gate 0 | [§7](./models_plan.md#7-changes-needed-to-the-provider-interface) |
| [x] | MP-2 | Honour those fields in the request path | MP-1 | [§6.6](./models_plan.md#66-per-provider-gotchas) |
| [x] | MP-3 | Router filters on model context size | — | [§13.2](./models_plan.md#132-the-router-never-checks-model-context-size) |
| [x] | MP-4 | Trim budget derives from the chosen model | MP-3 | [§13.3](./models_plan.md#133-trim-budget-is-fixed-regardless-of-target-model) |
| **B — money** | | | | |
| [x] | MP-5 | Daily allowance, defaulting to $0 | Gate 0 (Q5) | [§9.2](./models_plan.md#92-money-is-a-permission-not-a-rung), [§13.1](./models_plan.md#131-unbounded-automatic-spending-91) |
| [x] | MP-6 | `maxTokens` mandatory on any billed call | MP-5 | [§9.4](./models_plan.md#94-three-details-that-stop-it-going-wrong) |
| [x] | MP-7 | Never pay for a sidegrade; tired vs incapable | MP-5 | [§9.3](./models_plan.md#93-where-paid-fires-two-rules), [§9.4](./models_plan.md#94-three-details-that-stop-it-going-wrong) |
| [x] | MP-8 | Ask once per task; show the number | MP-5, MP-7 | [§9.5](./models_plan.md#95-the-user-facing-prompt) |
| **C — providers** | | | | |
| [x] | MP-9 | `baseUrl` template + composite key | Gate 0 (Q3) | [§6.6](./models_plan.md#66-per-provider-gotchas), §16 Q3 |
| [x] | MP-10 | A call budget field | Gate 0 (Q4) | §16 Q4 |
| [x] | MP-11 | Live-probe LLM7, resolve Tier A vs Tier B | MP-1 | [§6.6](./models_plan.md#66-per-provider-gotchas) |
| [x] | MP-12 | Tier A rows — the keyless floor | MP-2, MP-3 | [§6.2](./models_plan.md#62-tier-a--the-keyless-floor-no-key-no-signup-no-card) |
| [x] | MP-13 | Tier B rows — the seven | MP-9, MP-10, MP-11, MP-12 | [§6.3](./models_plan.md#63-tier-b--the-seven-added-from-freellmapi) |
| [x] | MP-14 | The ToS-`ok` cluster *(only if Q2 = b)* | MP-13 | [§6.4](./models_plan.md#64-the-tos-ok-cluster-optional-small-clean) |
| [x] | MP-15 | `providers verify` | MP-12, MP-13 | [§13.4](./models_plan.md#134-no-staleness-marker-on-provider-rows) |
| **D — the promise** | | | | |
| [x] | MP-16 | `answers-with-no-keys.test.ts` | MP-12 | [§13.5](./models_plan.md#135-the-core-promise-is-not-tested) |
| **E — the ladder** | | | | |
| [x] | MP-17 | Local as a text rung *(only if Q1 = yes)* | MP-16 | [§8.3](./models_plan.md#83-local-placement--the-decision-and-why) |
| [x] | MP-18 | The ladder order | MP-16, MP-17 | [§8.2](./models_plan.md#82-the-ladder) |
| [x] | MP-19 | The mid-task rule | MP-18 | [§8.5](./models_plan.md#85-the-mid-task-rule-non-negotiable) |
| [x] | MP-20 | Status bubbles | MP-18 | [§8.4](./models_plan.md#84-status-bubbles) |
| **F — escalation** | | | | |
| [x] | MP-21 | Struggle signals | MP-18 | [§10.3](./models_plan.md#103-the-reframe-measure-struggle-do-not-predict-difficulty) |
| [x] | MP-22 | Fire the existing `above` pin automatically | MP-21 | [§10.6](./models_plan.md#106-what-already-exists) |
| [x] | MP-23 | The budget cap as a doorway, not a wall | MP-22, MP-5 | [§10.5](./models_plan.md#105-the-budget-cap-is-a-trigger-not-a-wall) |
| **G — context** | | | | |
| [x] | MP-24 | Mechanical collapse — the deterministic 80% | MP-4 | [§11.3](./models_plan.md#113-the-rule-for-what-survives-closed-versus-open) |
| [x] | MP-25 | Sub-goal tags, one level, no graph | MP-24 | [§11.5](./models_plan.md#115-on-graphs-right-mental-model-wrong-build) |
| [x] | MP-26 | Pointers instead of content | MP-24 | [§11.4](./models_plan.md#114-context-is-a-cache-not-a-record) |
| [x] | MP-27 | Planner versus cranker | MP-3, MP-22 | [§11.6](./models_plan.md#116-the-consequence-planner-versus-cranker) |
| **H — onboarding** | | | | |
| [x] | MP-28 | The bento key wall | MP-13 | [§12.2](./models_plan.md#122-the-proposed-screen-a-bento-key-wall) |
| [x] | MP-29 | Skip is loud, and provably reaches a conversation | MP-16, MP-28 | [§12.2](./models_plan.md#122-the-proposed-screen-a-bento-key-wall) |

---

## 5. The tasks

Every task block has the same five parts. **Read `Source` before `Do`.**

---

### MP-1 · The five new `Provider` fields

**Source:** [§7](./models_plan.md#7-changes-needed-to-the-provider-interface) — it
contains the five fields *with their doc comments already written*. Use them verbatim.
**Depends on:** Gate 0
**Touch:** `packages/core/src/provider.ts` (the `Provider` interface only)

**Do**
1. Add `auth`, `anonymousKey`, `timeoutMs`, `tools`, `verified` exactly as §7 declares
   them, keeping §7's doc comments as the doc comments.
2. `auth` **replaces** the binary `keyless?: boolean` (§7 says so explicitly). Migrate the
   7 existing rows ([§6.1](./models_plan.md#61-already-in-the-table-7)) so behaviour is
   unchanged: whatever `keyless` said before, `auth` must say the same thing now.
3. Every field is optional. An existing row that sets none of them must behave
   byte-identically to before.

**Do not**
- Do not add a sixth field. The URL template and the call budget are MP-9 and MP-10, and
  both are gated on a human answer.
- Do not add any provider row in this task.

**Done when**
- [ ] The five fields exist with §7's comments.
- [ ] `keyless` is gone and all 7 existing rows carry an `auth` value.
- [ ] The existing test suite passes unchanged.

---

### MP-2 · Honour the new fields in the request path

**Source:** [§7](./models_plan.md#7-changes-needed-to-the-provider-interface) for what
each field means; [§6.6](./models_plan.md#66-per-provider-gotchas) for why each exists.
**Depends on:** MP-1
**Touch:** the provider request/dispatch path in `packages/core/src`

**Do** — four behaviours, one per field:
1. **`auth: 'optional'` with no stored key → send no auth header at all.** Not an empty
   one. §6.6 OVHcloud: a bad key 403s instead of degrading to anonymous, so an empty
   header is worse than none. [§15](./models_plan.md#15-do-and-do-not) states this as a
   hard Do-not.
2. **`anonymousKey` is sent when no user key exists.** §6.6 AI Horde: *"an absence is not
   enough."* The literal value lives in the row, not in code.
3. **`timeoutMs` overrides the default timeout for that provider.** §7 names the callers
   that need it; §6.6 names the per-model exception (Cloudflare's `glm-4.7-flash`).
4. **`tools: false` on a provider strips `tools` from the request** for every model of
   that provider, including live-discovered ones. §7 explains why the per-model
   `supportsTools` flag is not enough: AI Horde's roster is discovered live, and a raw
   text-completion backend **500s** on a `tools` field.

**Do not**
- Do not put any provider's name, id, URL or literal key value in this code. These are
  four generic behaviours driven by row data (R7).

**Done when**
- [ ] Four unit tests, one per behaviour, each asserting the wire shape.
- [ ] The `auth: 'optional'` test asserts the header is **absent**, not empty.
- [ ] The `tools: false` test asserts stripping happens for a model the catalog has never
      seen.

---

### MP-3 · The router filters on model context size

**Source:** [§13.2](./models_plan.md#132-the-router-never-checks-model-context-size) —
*"`Model.context` exists and is never read"*, and this, not the scratchpad design, *"is
what would break the keyless floor."*
**Depends on:** —
**Touch:** `packages/core/src/router.ts`

**Do**
1. A model whose window cannot hold the trace is **not a candidate** — it drops out of
   the pool exactly the way a spent free tier does. §13.2 specifies this shape.
2. Test against the **floor**, as [§13.3](./models_plan.md#133-trim-budget-is-fixed-regardless-of-target-model)
   defines it: *"head plus newest cycle — the part that can never collapse."* If even the
   floor does not fit, the rung is gone.
3. This filter sits beside the existing tool-capability filter (`!needsTools ||
   c.model.supportsTools`) — same list, one more filter,
   [§8.1](./models_plan.md#81-the-organising-idea-hands-versus-mouth).

**Do not**
- Do not degrade, truncate or "best-effort" a too-small model into serving. Filtered out
  means filtered out.

**Done when**
- [ ] `grep -n "context" packages/core/src/router.ts` returns lines. (§13.2 opens with
      that grep returning nothing.)
- [ ] A test routes a trace larger than a small model's window and asserts that model is
      **not** among the candidates.
- [ ] A test asserts that when no model's window fits the floor, the failure is explicit,
      not a silent 400 from upstream.

---

### MP-4 · Trim budget derives from the chosen model's window

**Source:** [§13.3](./models_plan.md#133-trim-budget-is-fixed-regardless-of-target-model)
**Depends on:** MP-3
**Touch:** `packages/core/src/trim.ts`, plus the caller that sequences routing and trimming

**Do**
1. Replace the fixed `budget: 24_000` with a function of the chosen model's `context`.
2. Enforce §13.3's ordering explicitly: **route first, then trim to that model's window.**
3. Keep continuous per-step trimming exactly as it is
   ([§11.2](./models_plan.md#112-compact-as-you-go--never-at-hand-off): compaction is
   re-applied every step, which is *why* no model ever needs to say goodbye — do not
   introduce a trim-at-handoff step).

**Do not**
- Do not add a "summarise before switching model" step. §11.2 explains at length why that
  failure mode cannot occur under the current architecture and must not be reintroduced.

**Done when**
- [ ] `budget` is derived, and a 200k-context model gets a larger budget than a 32k one.
- [ ] A test asserts route-then-trim ordering.
- [ ] `trim.ts`'s existing behaviour and its docstring principle are otherwise untouched.

---

### MP-5 · A daily allowance, defaulting to $0

**Source:** [§9.1](./models_plan.md#91-the-finding-that-reframes-this),
[§9.2](./models_plan.md#92-money-is-a-permission-not-a-rung),
[§9.6](./models_plan.md#96-the-minimal-alternative),
[§13.1](./models_plan.md#131-unbounded-automatic-spending-91)
**Depends on:** Gate 0 (Q5)
**Touch:** `packages/core/src/router.ts`, settings

**Do**
1. Add **one number**: a daily allowance. Default = the Q5 answer (**recommended $0**).
2. Keep `mixed` as the default `spend`, but gate it behind the allowance — §9.6's
   explicit recommendation: *"the middle."* At $0 the app must behave **exactly** like
   `spend: 'free'`.
3. Money is a **permission, not a rung** (§9.2). Do not add a tier, do not reorder the
   ladder, do not make paid a cascade step. `Spend` stays a filter, as the code already
   has it.
4. Daily, not monthly — §9.2 gives both reasons; put them in the comment.

**Do not**
- Do not ship `spend: 'mixed'` without the allowance ([§15](./models_plan.md#15-do-and-do-not) Do-not).
- Do not implement the §9.6 minimal alternative (flipping the default to `free`) *instead*
  of this. §9.6 recommends the middle.

**Done when**
- [ ] With the allowance at its default, a request that previously fell through to a paid
      model now does not, and a test proves it.
- [ ] Setting the allowance above zero unlocks paid, and a test proves that too.
- [ ] The exhaustion path from §9.1 — free tier spent → paid model billed silently — is
      closed, with a test named after it.

---

### MP-6 · `maxTokens` is mandatory on any billed call

**Source:** [§9.4](./models_plan.md#94-three-details-that-stop-it-going-wrong) detail 1
**Depends on:** MP-5
**Touch:** the request path; `ChatRequest` in `packages/core/src/provider.ts`

**Do**
1. `ChatRequest.maxTokens` already exists and is optional. Make it **mandatory whenever
   money is involved** — §9.4 states it in those words.
2. Comment it with §9.4's reasoning: input tokens are countable before sending, output
   tokens are not; `maxTokens` is what converts an unknown cost into a bounded one.

**Do not**
- Do not make it mandatory on free calls. The requirement is scoped to billed ones.

**Done when**
- [ ] A billed call without `maxTokens` fails loudly before leaving the process.
- [ ] A free call without `maxTokens` still works.

---

### MP-7 · Never pay for a sidegrade; tired versus incapable

**Source:** [§9.3](./models_plan.md#93-where-paid-fires-two-rules),
[§9.4](./models_plan.md#94-three-details-that-stop-it-going-wrong) detail 2
**Depends on:** MP-5
**Touch:** `packages/core/src/router.ts`

**Do**
1. **The two rules from §9.3**, exactly as its table gives them — free failed because
   *tired* (429, quota spent) versus free failed because *incapable* (nothing free has
   the tools / the context / vision). Each rule is defensible in one sentence, which §9.3
   names as the test for whether a routing rule should exist. Put those sentences in the
   comments.
2. **No sidegrade** (§9.4 detail 2): a paid model enters only when it is genuinely
   **above** the rung it replaces. Cheapest-first will otherwise buy a paid model no
   better than the free one that just ran out, which §9.4 calls *"the worst possible
   outcome."*

**Do not**
- Do not pick a fixed position for paid in the ladder. §9.3 exists specifically to answer
  "before or after local?" *without* doing that.

**Done when**
- [ ] A test: free 429s → local is tried before paid.
- [ ] A test: nothing free has tools → paid fires immediately, local is not tried.
- [ ] A test: the paid candidate that is merely equal to the exhausted free model is
      rejected.

---

### MP-8 · Ask once per task; show the number

**Source:** [§9.5](./models_plan.md#95-the-user-facing-prompt),
[§9.4](./models_plan.md#94-three-details-that-stop-it-going-wrong) detail 3
**Depends on:** MP-5, MP-7
**Touch:** `packages/ui/src`, plus whatever core state carries the per-task answer

**Do**
1. The prompt fires only in the situation §9.5 names: free-agentic and subscription both
   exhausted **and** local available. Use §9.5's wording.
2. **Ask once per task, remember for the session.** §9.5's reasoning is the requirement:
   a router that asks on every request is a nag, and people click through nags without
   reading, *"which is worse than not asking."*
3. On yes, pick the cheapest model that is a **genuine step up** — MP-7's comparator, not
   cheapest-first.
4. Show spend, in §9.4's format: *"Spent $0.12 of $1.00 today."*

**Do not**
- Do not prompt per request. Do not prompt when the allowance is $0 — there is nothing to
  consent to.

**Done when**
- [ ] A test drives two paid decisions in one task and asserts exactly one prompt.
- [ ] The spent/allowance figure is visible in the UI.

---

### MP-9 · `baseUrl` template + composite key  *(Q3)*

**Source:** [§6.6](./models_plan.md#66-per-provider-gotchas) "Cloudflare Workers AI";
[§16](./models_plan.md#16-open-questions--need-a-human-answer) Q3
**Depends on:** Gate 0 (Q3 = template)
**Touch:** `packages/core/src/provider.ts`, the URL construction path, `secrets.ts` usage

**Do**
1. Support a `{account}` placeholder in `baseUrl`, filled from a key stored as
   `account_id:api_token` — FreeLLMAPI's approach, which §6.6 calls *"clean and worth
   copying"* and §16 Q3 recommends because *"a template keeps the 'no code per provider'
   rule intact."*
2. Generic mechanism only. Cloudflare must not appear by name anywhere in it.

**Do not**
- Do not take the code-exception route unless the owner explicitly chose it at Gate 0 —
  §6.6 flags Cloudflare as *"the one provider in this document that does not fit Alexia's
  'providers are rows' rule as written."*

**Done when**
- [ ] A row with `{account}` in its `baseUrl` and a composite key resolves to the right
      URL, proven by test.
- [ ] A malformed composite key fails with a message naming what was expected.

---

### MP-10 · A call budget field  *(Q4)*

**Source:** [§6.6](./models_plan.md#66-per-provider-gotchas) "Cohere";
[§16](./models_plan.md#16-open-questions--need-a-human-answer) Q4
**Depends on:** Gate 0 (Q4 = add the field)
**Touch:** `packages/core/src/provider.ts`, the quota/ledger path

**Do**
1. Add the field the owner chose at Gate 0 (the name floated in §16 Q4 is
   `callsPerMonth`) and honour it in whatever tracks `rpm`/`rpd`.
2. §6.6: Cohere's free tier is **1,000 API calls/month** — *"a call budget, not a token
   budget"*, and `rpm`/`rpd` cannot express it.

**Do not**
- Do not approximate a call budget with `rpd`. That is the bug this task exists to avoid.
- If Q4 = drop Cohere, **delete this task and drop Cohere from MP-13.** Do not build the
  field anyway.

**Done when**
- [ ] The field exists and exhausting it removes the provider from the pool.
- [ ] A test proves it is counted in calls, not tokens.

---

### MP-11 · Live-probe LLM7 and resolve the conflict

**Source:** [§6.6](./models_plan.md#66-per-provider-gotchas) "LLM7" — three sources
disagree on whether a key is required; §6.6's own action line is *"live-probe before
deciding whether it belongs in Tier A or Tier B."*
[§15](./models_plan.md#15-do-and-do-not) lists it as a Do.
**Depends on:** MP-1
**Touch:** nothing yet — this task produces an answer, not a diff

**Do**
1. Probe `https://api.llm7.io/v1` three ways, matching the three conflicting claims §6.6
   records: no key; the literal placeholder key `unused`; a real token from
   `token.llm7.io`.
2. Report which worked, with the date.
3. Write the answer into MP-13's LLM7 row as `verified:` plus a `Source:` comment saying
   *how* it was resolved. If it is keyless, note that Tier A gains a member; the row still
   ships in MP-13 either way.

**Do not**
- Do not skip the probe and pick a source. §6.6 records the disagreement *unresolved* on
  purpose ([§0](./models_plan.md#0-what-this-document-is--and-is-not): disagreements are
  *"marked with a warning rather than resolved by guessing"*).
- Do not sign up for anything without asking the user first.
- If the network is unavailable, **stop and report** — do not proceed to MP-13 with a
  guessed `auth` value.

**Probe result — 2026-08-30**

Run against `https://api.llm7.io/v1` from this machine. `/v1/models` returns 200 with and
without a header. 44 models, of which 38 are `pro` (not free) and 6 are `turbo`.

| Model (`turbo` tier) | No header at all | `Authorization: Bearer unused` |
|---|---|---|
| `codestral-latest` | **200** | 200 |
| `gpt-oss` | **200** | 200 |
| `meta-Llama-3.1-8B-Instruct-Turbo` | **200** | 200 |
| `minimax-m2.7` | **200** | 200 |
| `gemma4:31b` | 401 `missing_api_key` | 401 `invalid_api_key` |
| `mistral-Nemo-Instruct-2407` | 429 throughout | 429 throughout — undetermined |

**All three of §6.6's sources are partly right, and none is right as stated.**

- FreeLLMAPI — *"anonymous access also works for basic models"* — **correct**, and the
  closest to the truth. Four of six free models answered with no header at all.
- `FREE_TIERS.md` — *"a free token from token.llm7.io is now required"* — **correct for some
  models only.** `gemma4:31b` is one of them.
- `PROVIDER_REFERENCE.md` — *"use any non-empty key, for example `unused`"* — **wrong, and
  actively harmful.** The placeholder buys nothing where no key is needed, and where one *is*
  needed it comes back 401 `invalid_api_key` rather than `missing_api_key` — it is rejected
  as a bad key, not accepted as a pass. This is the OVHcloud lesson again: **a bad key is
  worse than no key.**

**Verdict: LLM7 is keyless-capable, so Tier A gains a member.** The row ships in MP-13 as
written, with `auth: 'optional'`, the header **omitted entirely** when the user has no key —
and **no `anonymousKey`**, because the literal the sources name is a bad key rather than an
anonymous one.

**The third access mode was not probed.** It needs a real token from `token.llm7.io`, which
is a signup, and MP-11's own Do-not forbids signing up without asking first. It was not
needed: the question this task exists to answer is Tier A versus Tier B, and modes one and
two answer it. A real key raises the limits and unlocks the `pro` roster; nothing in this
plan depends on knowing by how much.

**Done when**
- [x] A written result: which of the three access modes answered 200, on what date.
- [x] That result is what MP-13's row encodes.

---

### MP-12 · Tier A rows — the keyless floor

**Source:** [§6.2](./models_plan.md#62-tier-a--the-keyless-floor-no-key-no-signup-no-card)
for the table and the model lists; [§6.6](./models_plan.md#66-per-provider-gotchas) for
every gotcha; [§17.3](./models_plan.md#173-verified-rate-limits) for the rate limits;
[§17.1](./models_plan.md#171-the-keyless-catalogue-in-full) for the catalogue context.
**Depends on:** MP-2, MP-3
**Touch:** the `PROVIDERS` table in `packages/core/src/provider.ts`, and `catalog.ts` for
the models

**This is the task that makes [§2](./models_plan.md#2-the-goal) true.** §6.2: *"Add all
of these."*

**Do**
1. Add all four rows — `ovhcloud`, `aihorde`, `uncloseai`, `kilo-gateway` — taking
   **every field verbatim** from §6.2's table: base URL, model count, limit, ToS verdict,
   tools answer. Add the models §6.2 lists under "Models:".
2. Encode the §6.6 gotchas. Every bullet under a provider's name in §6.6 is a required
   field value or a required test — go bullet by bullet, do not skim. In particular:
   - **OVHcloud** — `auth: 'optional'`; the header omitted entirely when blank; the
     2 req/min is **per model**; tool calling confirmed on the two ids §6.6 names.
   - **AI Horde** — `anonymousKey` set to the literal string §6.6 gives; `timeoutMs`
     120s; `tools: false`; plain-string content only (§6.6's `requiresPlainStringContent`
     note — if the row cannot express it, **stop and ask**, per R2/R7).
   - **Kilo Gateway** — the models path §6.6 gives (**not** `/v1/models`, which 405s on
     GET); **`trainsOnYourData: 'yes'`**.
   - **UncloseAI** — any non-empty string is accepted as a key; use only the
     verified-live model id §6.6 names.
3. `trainsOnYourData` is `'unknown'` for every row **except Kilo**, which is `'yes'`.
   §14.3: that is *"the only row in this document where the answer is known."*
   [§15](./models_plan.md#15-do-and-do-not) lists both halves as Dos.
4. R6 provenance on every row.

**Do not**
- Do not add a fifth row here. `pollinations` is broken; the `avoid` bucket is out (§6.5).
- Do not copy OmniRoute's default of pre-wiring OpenCode Free and Felo
  ([§4.2](./models_plan.md#42-what-keyless-actually-gives-you): *"Alexia must not copy
  that choice"*; [§15](./models_plan.md#15-do-and-do-not) Do-not).
- Do not guess `trainsOnYourData` for the other three.

**Done when**
- [ ] Four rows, each with `Source:` and `verified:`.
- [ ] A test per §6.6 gotcha that is expressible as a row value.
- [ ] Kilo's row reads `trainsOnYourData: 'yes'`.
- [ ] MP-16 can now be attempted.

---

### MP-13 · Tier B rows — the seven

**Source:** [§6.3](./models_plan.md#63-tier-b--the-seven-added-from-freellmapi) for the
table and the rationale; [§6.6](./models_plan.md#66-per-provider-gotchas) for the gotchas;
[§17.3](./models_plan.md#173-verified-rate-limits) for limits.
**Depends on:** MP-9, MP-10, MP-11, MP-12
**Touch:** `PROVIDERS`, `catalog.ts`

**Do**
1. Add the seven rows §6.3's table lists, fields verbatim. Note that §6.3's table itself
   flags Kilo as already added in Tier A — do not duplicate it; the difference is only
   that its key is optional, which `auth: 'optional'` already expresses.
2. Encode §6.6's gotchas per provider, again bullet by bullet:
   - **LLM7** — `auth` set from **MP-11's probe result**, never from a source.
   - **NaraRouter** — pin **only the three known-free ids** §6.6 names; record the shared
     daily pool; record the Telegram-verification friction so MP-28 can surface it on the
     tile.
   - **Cloudflare** — MP-9's template; the timeouts §6.6 gives, including the per-model
     exception; **do not seed the four dead model ids §6.6 names.**
   - **Ollama Cloud** — the model list path §6.6 gives (**not** `/v1/models`); 120s
     timeout; **not keyless** ([§4.3](./models_plan.md#43-corrections-made-during-this-research)
     records the extraction error that briefly said otherwise — do not repeat it).
   - **Z.ai** — the **OpenAI-compatible `paas/v4`** path. §6.6: *"Note OmniRoute's `zai`
     entry uses the Anthropic wire format… Do not copy that."* Handle the two-console key
     namespace problem so a key from the other console does not merely look like a bad key.
   - **Cohere** — the `/compatibility/v1` path, never the native endpoint; MP-10's field.
3. R6 provenance on every row.

**Do not**
- Do not add a provider whose gotchas you have not read.
- Do not let a dropped Gate-0 provider (Cloudflare via Q3, Cohere via Q4) sneak back in.

**Done when**
- [ ] Every row that Gate 0 kept exists, with `Source:` and `verified:`.
- [ ] A test asserts none of the four dead Cloudflare ids are present.
- [ ] A test asserts Z.ai's row uses the `paas/v4` OpenAI-compatible path.
- [ ] Nara's row contains exactly three model ids.

---

### MP-14 · The ToS-`ok` cluster  *(only if Q2 = b)*

**Source:** [§6.4](./models_plan.md#64-the-tos-ok-cluster-optional-small-clean)
**Depends on:** MP-13
**Touch:** `PROVIDERS`, `catalog.ts`

**Do**
1. Add `aion`, `agnes`, `requesty`, `sealion`, `navy` with the URLs and notes §6.4 gives.
2. Honour the two quirks §6.4 states: Agnes needs a **60s timeout** (`timeoutMs`, from
   MP-1); Navy requires a `User-Agent` header.
3. R6 provenance on every row.

**Do not**
- Do not run this task if Q2 = (a). §16 Q2's recommendation is *"(a), then (b) if the key
  wall looks sparse"* — that judgement is the owner's, made at Gate 0, and more rows means
  more surface to keep verified (§13.4).

**Done when**
- [ ] Five rows, each with `Source:` and `verified:`.
- [ ] Agnes' timeout and Navy's header are tested.

---

### MP-15 · `providers verify`

**Source:** [§13.4](./models_plan.md#134-no-staleness-marker-on-provider-rows)
**Depends on:** MP-12, MP-13
**Touch:** the command surface; `packages/core/src/commands.ts`

**Do**
1. A `providers verify` command that pings each row's `models` URL and reports which rows
   answered, which failed, and how stale each `verified:` date is.
2. §13.4: *"Probably not a CI test, since it needs network."* Keep it a command the user
   runs, not something that fails a build.

**Do not**
- Do not auto-update `verified:` dates from a successful ping without showing the user
  what changed.
- Do not delete or disable a row on a failed ping. Report; the human decides.

**Done when**
- [ ] The command exists and lists every row with a pass/fail and a staleness age.
- [ ] It is not wired into CI.

---

### MP-16 · `answers-with-no-keys.test.ts`

**Source:** [§13.5](./models_plan.md#135-the-core-promise-is-not-tested) — *"Given the
whole point of this document, **this is the test that matters most.**"*
**Depends on:** MP-12
**Touch:** `test/invariants/answers-with-no-keys.test.ts`

**Do**
1. Write the sibling to the existing `02-boots-with-no-plugins.test.ts`, with §13.5's
   exact conditions: **no keychain entries, no Ollama running, and Alexia still returns a
   completion.**
2. Model it on the existing invariant test's shape and naming.
3. This turns [§2](./models_plan.md#2-the-goal) from a README claim into something CI
   enforces — §2's own closing line: *"This should be enforced by the codebase, not
   claimed by the README."*

**Do not**
- Do not make it pass by mocking a provider response. If the keyless floor does not
  actually answer, the test must fail and MP-12 is not finished.

**Done when**
- [ ] The test exists, runs in CI, and passes against the real keyless floor.
- [ ] Removing the Tier A rows makes it fail.

---

### MP-17 · Local becomes a rung in the cloud text cascade  *(only if Q1 = yes)*

**Source:** [§8.3](./models_plan.md#83-local-placement--the-decision-and-why);
[§16](./models_plan.md#16-open-questions--need-a-human-answer) Q1
**Depends on:** MP-16
**Touch:** `MODES` in `packages/core/src/router.ts`

**Do**
1. Make local text a rung in the cascade. §8.3's "Open consequence" states the problem
   precisely: in `MODES.combined`, `text` is placed `cloud`, so local text is *"not a rung
   in the cascade at all today."*
2. Put local **low**, not high — §8.3 records this as the owner's correction and explains
   why: privacy is enforced by **mode selection** (`/local` switches `MODES.local` and
   shuts the cloud cascade off entirely), so the cascade only ever runs for someone who
   did not ask for privacy. For them local is *"a slow helper that lives in their house."*
3. Comment the change with §8.3's reasoning, including the misapplied-pin correction, so
   nobody re-derives it.

**Do not**
- Do not run this task unless Q1 was answered yes. §16 marks it *"Blocking for the
  ladder"* and says it *"changes `MODES` semantics… a real decision, not a tweak."*
- Do not put local high in the cascade ([§15](./models_plan.md#15-do-and-do-not) Do-not).
- Do not touch how `/local` and `MODES.local` work.

**Done when**
- [ ] Local text is reachable as a cascade rung in the non-private modes.
- [ ] A test asserts `/local` still shuts the cloud cascade off entirely.

---

### MP-18 · The ladder order

**Source:** [§8.2](./models_plan.md#82-the-ladder) for the nine rungs and their bubble
text; [§8.1](./models_plan.md#81-the-organising-idea-hands-versus-mouth) for the
mechanism; [§14.1](./models_plan.md#141-the-claude-code-rung-cannot-be-automatic) for the
gate on rung 2.
**Depends on:** MP-16, MP-17
**Touch:** `packages/core/src/router.ts`

**Do**
1. Implement the running order exactly as §8.2's ladder prints it, hands-first then
   mouths.
2. **One list plus one filter, not two lists** — §8.1 is explicit that the hands/mouth
   split is already `router.ts`'s `!needsTools || c.model.supportsTools` and needs no new
   structure.
3. **Rung 5 (OVHcloud keyless) is the important refinement** — §8.2 spells out why: it is
   keyless *and* tool-capable, so the agent loop survives to the no-key floor, slowly.
   Only below that is Alexia chat-only.
4. **Rung 2 is gated, not default.** §14.1: the Claude Code rung *"cannot be part of a
   shipped default cascade. It can sit in the ladder as a rung the user explicitly
   unlocks."* Everything else in the ladder is unaffected.
5. If Q1 = no, build the ladder without rungs 4 and 8, and say so in the comment.

**Do not**
- Do not auto-enable the Claude Code plugin, and do not change its shipped-off default.
- Do not build a second candidate list for chat-only models.

**Done when**
- [ ] A test walks the full ladder top to bottom and asserts the order matches §8.2.
- [ ] A test asserts rung 2 is absent unless explicitly unlocked.
- [ ] A test asserts the agent loop still runs on rung 5 with no keys present.

---

### MP-19 · The mid-task rule

**Source:** [§8.5](./models_plan.md#85-the-mid-task-rule-non-negotiable)
**Depends on:** MP-18
**Touch:** `packages/core/src/agent.ts`, `router.ts`

**Do**
1. Implement §8.5's rule, which it labels non-negotiable: **never swap from a
   hands-helper to a talker mid-job.**
2. On exhausting the last tool-capable rung mid-task, do one of §8.5's two things and
   nothing else: **(a)** wait / retry within the hands ladder, or **(b)** stop and say
   *"I ran out of helpers with hands."*
3. Write it down the way `router.ts:21–24` writes down its siblings — §8.5 says this is
   *"the agentic sibling of the existing rule ('a pin is never silently violated') and
   should be written down the same way."*

**Do not**
- Do not quietly continue on a chat-only model. §8.5: *"It must **never**"*;
  [§15](./models_plan.md#15-do-and-do-not) Do-not: *"silently or at all."*

**Done when**
- [ ] A test strands an agent mid-loop with only chat-only rungs left and asserts it takes
      path (a) or (b) — never a silent continue.
- [ ] The rule is written as a comment in the same register as the existing router rules.

---

### MP-20 · Status bubbles

**Source:** [§8.4](./models_plan.md#84-status-bubbles); the bubble strings are in
[§8.2](./models_plan.md#82-the-ladder)'s ladder, with their colours.
**Depends on:** MP-18
**Touch:** `packages/ui/src`

**Do**
1. Each rung shows its state, using §8.2's strings and green/amber/red exactly as printed.
2. **The bubble says what the assistant can *do*, not what it costs** (§8.4). §8.4's
   worked example: *"Not available for agentic work, just chat"* is useful; *"currently
   paid"* is not.
3. Local bubbles carry a capability tag, not a price — §8.4 gives three usable strings.

**Do not**
- Do not put price or provider plumbing in a bubble.

**Done when**
- [ ] Every rung in MP-18's ladder has a bubble, with §8.2's text and colour.
- [ ] No bubble string mentions cost.

---

### MP-21 · Struggle signals

**Source:** [§10.3](./models_plan.md#103-the-reframe-measure-struggle-do-not-predict-difficulty)
for the five signals; [§10.2](./models_plan.md#102-why-read-the-request-and-decide-cannot-work)
for why prediction is not an option; [§10.8](./models_plan.md#108-the-honest-limit) for
the limit.
**Depends on:** MP-18
**Touch:** `packages/core/src/agent.ts`

**Do**
1. Implement the five signals in §10.3's table with the detection costs it states.
2. **Start with the first one** — same tool + same args called twice. §10.3: it is
   *"exact rather than heuristic and catches most of the 'loops for hours' case on its
   own."* A string compare.
3. Measure struggle; do **not** predict difficulty. §10.2's conclusion is that no regex
   and no classifier can work *"because the difficulty is not in the sentence."*
4. Record §10.8's honest limit in a comment: this catches looping and thrashing, not the
   confidently-wrong model. That is `checker.ts`'s problem and **not part of this task.**

**Do not**
- Do not touch or extend the `HARD` regex. Do not build a difficulty classifier.
  [§15](./models_plan.md#15-do-and-do-not) Do-not: *"Predict difficulty from the prompt."*
- Do not start work on the confidently-wrong case.

**Done when**
- [ ] Each of the five signals fires in a test that reproduces its condition.
- [ ] Nothing in the diff reads the user's prompt text to judge difficulty.

---

### MP-22 · Fire the existing `above` pin automatically

**Source:** [§10.6](./models_plan.md#106-what-already-exists),
[§10.4](./models_plan.md#104-start-cheap--always-the-asymmetry),
[§10.7](./models_plan.md#107-what-d62-already-settled)
**Depends on:** MP-21
**Touch:** `packages/core/src/agent.ts`, `router.ts`

**Do**
1. §10.6 states the whole task in one line: *"the work is not 'build escalation' — it is
   'fire the existing pin automatically when the loop shows struggle.'"* `Pins.above`
   already exists and is already wired to a button. Fire it from MP-21's signals.
2. **No restart needed** — §10.6: every step already re-asks the router, so changing the
   pin mid-task *is* the architecture.
3. **Start cheap, always** (§10.4). Its table is the justification; put the asymmetry in
   the comment.
4. **Escalate the planning step, not every step** (§10.6's refinement). Let the good model
   think; let cheap models keep doing the mechanical read-file / run-command turns. §10.6:
   *"that is where most of the saving lives."*
5. §10.7 clears the way: D62 removed shape-to-tier routing, but not for a reason that
   blocks this. Reference that in the comment so it is not re-litigated.

**Do not**
- Do not reinstate shape-to-tier routing or a `tier` lookup (§10.7).
- Do not remove the manual escalation button — §10.6 notes the manual escape hatch
  *"collects the labelled data a cleverer one would need anyway."*

**Done when**
- [ ] A looping agent escalates without user input, proven by test.
- [ ] A test asserts escalation applies to the planning step, not to mechanical steps.
- [ ] The manual button still works.

---

### MP-23 · The budget cap is a doorway, not a wall

**Source:** [§10.5](./models_plan.md#105-the-budget-cap-is-a-trigger-not-a-wall)
**Depends on:** MP-22, MP-5
**Touch:** `packages/core/src/agent.ts`

**Do**
1. Implement §10.5 exactly: when a task has burned ~40% of its budget without finishing,
   **that is the evidence** that cheap is not working — spend the remaining 60% on one
   attempt with a better model.
2. Comment it with §10.5's own framing: *"The waste becomes the signal."*
3. It composes with MP-21's signals as one more trigger, and with the existing `maxSteps`
   ceiling, whose comment already names the fear this addresses.

**Do not**
- Do not make the cap a wall. §10.5 exists because *"cheap model burns the cap and fails"*
  is the wrong outcome.
- Do not exceed the daily allowance from MP-5. This spends the *task's* remaining budget,
  not new money.

**Done when**
- [ ] A test burns 40% of a task budget without finishing and asserts one better-model
      attempt is made with the remainder.
- [ ] A test asserts MP-5's allowance is still respected.

---

### MP-24 · Mechanical collapse — the deterministic 80%

**Source:** [§11.3](./models_plan.md#113-the-rule-for-what-survives-closed-versus-open);
[§11.1](./models_plan.md#111-there-is-no-hand-off) for why this is safe
**Depends on:** MP-4
**Touch:** `packages/core/src/trim.ts`

**Do**
1. Implement §11.3's four collapse rules verbatim — the errored-then-retried call, the
   read-then-edited file, the repeated identical call, the superseded result. §11.3:
   *"That is the cheap 80%, fully deterministic."*
2. The governing rule goes in the comment: **an observation matters until a conclusion
   supersedes it** — and the question is never *"is this important?"* but *"has this line
   of inquiry closed?"*
3. Honour §11.3's asymmetry: **found it** → drop the failed paths, keep one line;
   **not found** → the failed paths *are* the finding and must survive, because they stop
   the next model repeating the search.

**Do not**
- Do not use a model to do any of this. All four rules are mechanical.
- Do not change `trim.ts`'s docstring principle; §11.1 says it is already reaching for the
  right one.

**Done when**
- [ ] Four tests, one per rule.
- [ ] A test proves the not-found case keeps its negative space.

---

### MP-25 · Sub-goal tags — one level, no graph

**Source:** [§11.5](./models_plan.md#115-on-graphs-right-mental-model-wrong-build)
**Depends on:** MP-24
**Touch:** `packages/core/src/trim.ts`, `agent.ts`

**Do**
1. **Tag each cycle with the sub-goal it serves.** One level, not a graph. When a sub-goal
   closes, its cycles collapse to the conclusion. §11.5: *"That yields dependency-collapse
   without dependency-tracking"* and is *"~90% as good."*
2. The loop already knows whether a sub-goal was answered (§11.3) — use that, do not add a
   new judgement.

**Do not**
- **Do not build a dependency graph of the trace.** §11.5: *"Do not build a structure
  whose value depends on a question you cannot answer."*
  [§15](./models_plan.md#15-do-and-do-not) lists it as a Do-not.

**Done when**
- [ ] Cycles carry a sub-goal tag.
- [ ] Closing a sub-goal collapses its cycles to the conclusion, proven by test.
- [ ] Nothing in the diff builds edges between trace entries.

---

### MP-26 · Pointers instead of content

**Source:** [§11.4](./models_plan.md#114-context-is-a-cache-not-a-record)
**Depends on:** MP-24
**Touch:** `packages/core/src/trim.ts`

**Do**
1. Collapse re-derivable content to a pointer. §11.4's worked example is the spec:
   `src/router.ts:198-211` is ~30 tokens; its content is ~2,000.
2. The rule: **anything re-derivable by a tool call is droppable**, because dropping it
   costs one tool call, not the information. §11.4: that *"is what lets a 32k model work
   in a repo of hundreds of thousands of lines"* — which is exactly what the keyless floor
   needs.

**Do not**
- Do not drop anything that is *not* re-derivable by a tool call.

**Done when**
- [ ] A large file read collapses to a pointer, and a test asserts the next step can
      re-read it.

---

### MP-27 · Planner versus cranker

**Source:** [§11.6](./models_plan.md#116-the-consequence-planner-versus-cranker), and
[§10.6](./models_plan.md#106-what-already-exists)'s refinement — §11.6 notes the same
split arrives twice for different reasons, *"usually a sign the split is real."*
**Depends on:** MP-3, MP-22
**Touch:** `packages/core/src/router.ts`

**Do**
1. Route by **role**: the planner needs a real window; the cranker executes one step
   (*"read this file", "run this command"*) and needs almost no history.
2. This is what keeps the free tier useful as the trace grows — §11.6: it *"becomes the
   cranker."*
3. Reuse MP-3's context filter and the existing `PLANNER` floor. Do not build a parallel
   mechanism.

**Do not**
- Do not send the full trace to a cranker step.

**Done when**
- [ ] A test with a long trace routes the planning step to a wide-context model and the
      mechanical step to a small-context free one.

---

### MP-28 · The bento key wall

**Source:** [§12.2](./models_plan.md#122-the-proposed-screen-a-bento-key-wall);
[§12.1](./models_plan.md#121-what-exists) for what is there now;
[§12.3](./models_plan.md#123-the-four-stage-mental-model-the-user-should-end-up-with) for
the mental model it should leave behind.
**Depends on:** MP-13
**Touch:** `packages/ui/src/main.ts` (`firstRun`), UI assets

**Do**
1. **Keep screen 3.** §12.2: *"Screen 3 already asks the right question — 'How should I
   run?' — which is about **them**, not about vendors."* Replace step **4a** only.
2. Build §12.2's six bullets in full: logo tiles for every row in `PROVIDERS` showing real
   free-tier numbers on the face; inline key paste with a per-tile "how do I get one?"
   expander carrying the 3-step signup; **OmniRoute and OpenRouter as tiles among many,
   not a fork**; friction flagged on the tile face (Nara's Telegram verification,
   Cloudflare's Account ID); privacy cost flagged where known (Kilo logs free prompts for
   training); and **Skip loud**.
3. Respect `Alexia.md`'s first-run spec as §12.1 records it: five screens, under two
   minutes, no account, no email, no sign-up, no tour, no permission questions.

**Do not**
- **Do not fork the user on "OpenRouter or OmniRoute" at screen one.** §12.2: it *"asks
  someone to pick a vendor's plumbing before they have said hello, and it contradicts the
  two-minute rule."*
- Do not discover the Nara or Cloudflare friction later in the flow. It belongs on the
  tile face.

**Done when**
- [ ] Every `PROVIDERS` row has a tile carrying its real numbers.
- [ ] Nara's and Cloudflare's friction, and Kilo's training flag, are on their tile faces.
- [ ] First run still completes in under two minutes with no account.

---

### MP-29 · Skip is loud, and provably reaches a conversation

**Source:** [§12.2](./models_plan.md#122-the-proposed-screen-a-bento-key-wall) —
*"Skip must be loud. Zero keys must still reach a working conversation. That is the whole
point of §2."* [§15](./models_plan.md#15-do-and-do-not) lists it as a Do.
**Depends on:** MP-16, MP-28
**Touch:** `packages/ui`, plus a UI-level test

**Do**
1. Skip is visually loud on the key wall, not a de-emphasised escape.
2. Prove the path end to end: skip → first message → a completion, with zero keychain
   entries. This is MP-16's invariant surfaced through the UI.

**Do not**
- Do not treat MP-16 passing as sufficient. §12.2's requirement is about the *user's* path
  through the product, not the router's.

**Done when**
- [ ] Skip is prominent on the key wall.
- [ ] A test drives skip → message → completion with an empty keychain.

---

## 6. Definition of done for the whole plan

- [ ] Every unticked box on the §4 board is ticked, or explicitly deleted by a Gate 0
      answer with a note saying which answer deleted it.
- [ ] `answers-with-no-keys.test.ts` (MP-16) is green in CI.
- [ ] Every new `PROVIDERS` row carries `Source:` and `verified:` (R6).
- [ ] Exactly two provider-driven mechanisms were added — MP-9 and MP-10 — and no other
      provider required code (R7).
- [ ] `plan.md`, `Alexia.md` and `models_plan.md` are unmodified.
- [ ] Every Do and Do-not in [§15](./models_plan.md#15-do-and-do-not) survives a
      read-through against the final diff.

---

## 7. How this goes wrong — check yourself against this list

Each of these is a real failure mode named in `models_plan.md`. If you catch yourself
doing one, stop.

1. **Adding a provider because its model list is impressive.** That is precisely the
   `avoid` bucket's trap — §4.2: *"It contains the models you would actually want."*
2. **Filling in `trainsOnYourData` because a tier is free.** §14.3 forbids inferring it
   from the price. `'unknown'` is a correct answer; a guess is not.
3. **Sending an empty auth header instead of omitting it.** §6.6 OVHcloud: a bad key 403s
   instead of degrading.
4. **Copying OmniRoute's `zai` Anthropic-format entry.** §6.6 says do not.
5. **Building the difficulty classifier anyway.** §10.2 is a whole subsection on why it
   cannot work.
6. **Building the graph anyway.** §11.5 is a whole subsection on why not.
7. **Letting an agent slide onto a chat-only model mid-task.** §8.5, non-negotiable.
8. **Shipping `mixed` before MP-5 lands.** §13.1 — unbounded automatic spending, live in
   `main` today.
9. **Adding small-context providers before MP-3.** §15: *"Make the context filter exist
   before adding small-context providers."* §13.2 says this — not the scratchpad design —
   is what would break the keyless floor.
10. **Trusting a copied table to still be true.** §15: *"Trust either gateway's catalogue
    to stay current"* is a Do-not. That is what `verified:` and MP-15 are for.
11. **Wandering into `plan.md`.** §1.2. It is not part of this work.
