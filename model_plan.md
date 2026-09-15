# Models — the list, the ranking, and the fallback

> **What this doc is.** The plan to fix how Alexia lists, ranks and falls back between models.
> It is a build plan, not research: [`models_plan.md`](./models_plan.md) is the August research
> on which providers exist and what they give away, and this builds on it. **Agreed
> 2026-09-15** and recorded in [`Alexia.md`](./Alexia.md) as **D154** (§1–2) and **D155**
> (§3, which changes D112); **D158** and **D159** record how §3 and §2 were built, and **D160**
> the owner's answers that followed (§4). Tracked as **M8-6** in [`plan.md`](./plan.md).
>
> Started 2026-09-15. Every claim below was checked against the code, this machine's
> `cache/models.json` (1,830 rows) and the real `route()`, not recalled.

---

## The three problems, as reported

1. **The Models list shows every model there is**, not the ones this person can actually use.
   It should be *the models my keys unlock*, and it should update the moment a key is added.
2. **Automatic free picks at random.** It should go from the best free model to the worst.
3. **When a model fails or hits its limit, the conversation stops.** There is no fallback
   to another model. Falling back should be Automatic's job: when somebody picked a model or a
   sequence themselves, the router must not quietly go elsewhere.

All three are real. Each has a cause in the code that is smaller and more specific than
*the models are messed up*.

---

## 1. The list is not "what I can use"

### What the code does

- **"Connected" counts every provider that works without a key.** `connected()`
  (`serve.ts:564`) says yes to any provider whose `auth` is `optional` or `none`: Kilo
  Gateway, LLM7, UncloseAI, AI Horde, OVHcloud. So their models are always listed, key or
  not.
- **Paid models are listed whatever the slider says, and whatever the balance is.** On this
  machine Kilo Gateway alone contributes **348 paid rows** to the list, with no Kilo credit
  behind them.
- **A missing price is read as free.** `perMillion()` (`catalog.ts:520`) turned a price it
  could not find into `0`, and `0` is `T1`, the free tier. Requesty publishes its prices as
  `input_price`/`output_price` per token, which the parser never read, so **all 684 of its
  models were catalogued as free** when 12 are. Connect a Requesty key and *Automatic, free
  only* would route to models that bill, or answer `402`. That `402` then ends the
  conversation (see §3).
- **Adding a key does not redraw anything.** `/api/setup` starts `catalog.refresh()` without
  waiting (`serve.ts:1081`), and the shell sends the key with `void post(...)`
  (`ui/src/main.ts:738`). The Models tab shows the old list until it is closed and reopened
  after the fetch has finished.
- **There is no way to remove a key.** Nothing in `serve.ts` or `surface.ts` deletes one, so
  a provider that is connected stays connected.

### What it should do

**A model is listed when it is usable now, and only then.** Usable means all of these:

| Check | Rule |
|---|---|
| **Reachable** | The provider has a key, or it is a keyless provider the person has left switched on (see *Open decisions*) |
| **Priced** | The price is published, or the provider row says its whole list is free. **An unknown price is not free**: it is unlisted |
| **Allowed** | Free, or paid while the slider is not on *free only* |
| **Funded** | For paid rows, where the provider reports a balance (OpenRouter's key endpoint does; others to be checked per row), there is one |
| **A chat model** | Unchanged: no zero-length completions, no negative prices (D107) |

**The list follows the keychain.** Adding or removing a key refreshes that provider's list
and redraws the Models tab when it lands, not on the next reopen. The tab says what happened
in one line: *Groq connected — 14 free models.*

### The fix

1. **`Provider.pricing`**: `'free' | 'published'`, declared on every row (a test holds it).
   `free` rows are the ones `models_plan.md` §6 documents as free for everything they list;
   OpenRouter, Kilo, Requesty, Navy, Aion and Z.ai are `published`. `freeModels` names the
   free ones on a `published` provider whose list carries no prices (Z.ai's GLM-4.7-Flash).
   `perMillion()` returns `undefined` for a missing price, `parse()` also reads Requesty's
   `input_price`/`output_price` and its tool flag, and drops an unpriced row on a `published`
   provider. `PARSER` is 6, so the bad rows on disk leave on the next poll. **Done
   2026-09-15.**
2. **`available(model, connected, spend)`** in `router.ts`: one function that both the
   Models tab and `route()` read. Two copies of *what counts as usable* are how the list and
   the router came to disagree. **Done 2026-09-15**, for *reachable* and *allowed*. *Funded*
   (a balance per provider) and the keyless group's switch are not in it yet.
3. **Key changes are events.** `/api/setup` awaits `catalog.refresh(provider, 0, key)` and
   answers with the new counts. The shell redraws the Models tab from that answer.
4. **Remove a key**, from the same settings screen that adds one: keychain entry gone,
   provider disconnected, list redrawn. A pin or a sequence entry pointing at that provider's
   models stays, and is shown as *not available*, not deleted.

**Acceptance.** A catalog row with no price is not in `available()`. A fresh install with no
keys lists no paid rows. Saving a key changes the Models tab's rows without a reload.
Removing it changes them back. The Requesty rows on this machine disappear from Automatic.

---

## 2. Automatic is not best-to-worst

### What the code does

`cheapest` (`router.ts:552`) orders free models by: the user's order → tools before
text-only → keyed, then this machine, then keyless → tier → price → **`weekly`**. The first
five are the same for almost every free model, so **`weekly` decides**. That is how many
tokens the world sent through the model last week (D104).

**Only OpenRouter publishes `weekly`.** On this machine, 418 of 1,830 rows have it, all of
them OpenRouter's. Every other provider's free models tie, and the tie goes to whatever order
the provider's JSON happened to list them in. The router was run on this machine's catalog
(rate limits ignored, no local models):

| Setup | First choice | Why |
|---|---|---|
| OpenRouter key, no order | `google/gemma-4-31b-it:free` | `weekly` exists and ranks it first. **This one works.** |
| No OpenRouter key, no order | **`kilo-auto/free`**, a router | No `weekly` anywhere; Kilo lists its auto-router first |
| A pinned `openrouter/free` | `openrouter/free` on Kilo, **one choice only** | A pin is one model, and this one is a router |

**Meta-routers slip through.** D107 removed OpenRouter's routers priced at `-1`, but
`openrouter/free` and `kilo-auto/free` are priced at `0`, so they are ordinary free rows.
Routing to a router hands a random free model the job, 2.6B models included. That is the
*random* in the report.

**Size is invisible for hosted models.** `params` is only filled in for local models, so a
2.6B hosted model and a 550B one are judged the same.

### What it should do

**Rank free models on what predicts a good answer, strongest signal first:**

1. **Works on this machine.** A model that failed, timed out or answered empty in the last
   day sinks, and recovers as the strike ages. This is the one signal about *this* person's
   keys and network. It is new: `provider_usage` counts every request and `usage` records
   every success, but nothing records a failure yet.
2. **Not a router.** `openrouter/free`, `kilo-auto/free` and their siblings go to the bottom
   of Automatic. They stay pinnable, labelled *a different free model each time*.
3. **Size class.** Where the provider does not report a size, read it from the model id
   (`-2.6b`, `-120b-a12b`, `-31b`). Under 7B (the `PLANNER` line) sinks below everything that
   is known to be bigger. Unknown is not small: it sorts in the middle, not at the bottom.
4. **World usage (`weekly`), borrowed across providers.** OpenRouter's model list is public
   and fetched without a key. The same model on Kilo, NVIDIA or Requesty borrows OpenRouter's
   figure by normalized id (`:free`, provider prefixes and case stripped). Kilo's Nemotron 3
   Super then ranks as well as OpenRouter's.
5. **Then price, then the order the provider sent.** As now, but only as the last tiebreak.

**Why not a list of the best models in a file.** `surface.ts` already gives the reason, and it
holds: a list kept in code is wrong within a season. Every signal above comes from outside this
repo or from this machine, so it updates itself.

**Also fix:** `anonymous()` (`provider.ts:553`) makes a Kilo row count as keyless even when a
Kilo key is saved, so a paid-up Kilo account ranks with the no-key floor. A stored key should
make a provider `keyed`.

**Acceptance.** With no OpenRouter key, Automatic's first choice on this catalog is not a
router and not under 7B. A model that timed out twice in the last hour is not first. The ★ on
the Models tab is still exactly `route()`'s first choice, because it already is by definition.

**Built 2026-09-15 (D159)**, all five signals and both fixes, in core and the Models tab. Where
the build differs from the text above, or had to decide something the text did not:

- **The whole order**, after free before paid and tools first: strikes, not a router, the ladder
  (keyed, this machine, keyless), tier, price, size class, `weekly`, then the provider's order.
  **Price stays above size and usage.** It is zero across the free tier, so the ranking above
  holds exactly, and a paid fallback is still the cheapest one that fits.
- **A strike counts one and halves every hour**; a model sinks by what it carries, rounded. One
  failure sinks it for an hour, two together for two, and a model that always fails is retried
  about every hour and a half. Rows older than a day are deleted (`strikes`, migration 6).
  **Only failures about the model strike**: rate limit, no credit, timeout, dropped or dead
  stream, an empty answer, a free answer cut off. A refused key and a context too long do not.
- **A strike orders and never removes.** A pin and a list keep their entries and their order;
  a strike only decides which provider of one listed or pinned model is asked first.
- **Routers are known by id or name** (`routes()` in `catalog.ts`). OpenRouter's
  `tokenizer: "Router"` also marks the `~vendor/…-latest` aliases, which are one model each, and
  Kilo's routers say `"Other"`. Checked against 1,830 cached rows and both live lists: nine
  router ids, no false positives. The tab labels them *a different free model each time*.
- **Size is the whole model** for a mixture of experts (`-120b-a12b` is 120, so Nemotron 3 Nano
  Omni's `30b-a3b` is big), and it is an order only: `params`, which only a runner reports, is
  still the only thing the planning filter reads. It reaches local models too, so beside an 8B a
  1B no longer turns the crank; `agent.test`'s planner/cranker fixture changed to say so.
- **`weekly` is lent when the catalog is read** (`borrow()`), never written to the cache, with
  `weeklyFrom` naming the lender for the detail line. Routers neither lend nor borrow.
- **`/best` reverses only the money half** (group, tools, ladder, tier, price). Reversing the
  whole list would have put a model that failed a minute ago, and every router, first.
- **A stored key makes a keyless provider keyed**: `usable()` reads the keychain for every
  provider and `Rung.keyed` reaches the choice and its bubble.
- **A pin on a model served by two providers** is picked the way a list picks, still one choice.

Measured on this Mac's catalog (a copy of `cache/models.json`): with no OpenRouter key Automatic
starts at `gpt-oss-120b` on OVHcloud (borrowing OpenRouter's figure), then Nemotron 3 Ultra and
Super on Kilo, where it used to start at `kilo-auto/free`. With an OpenRouter key it starts at
`google/gemma-4-31b-it:free`. The pin on Nemotron 3 Super goes to OpenRouter, not Kilo, and the
owner's list asks each Nemotron on OpenRouter, then on Kilo.

Tests: `router.test.ts` (each signal, the keyed floor, the pin, `/best`, what `send()` records,
this catalog's shape), `catalog.test.ts` (routers, sizes, lending), `pool.test.ts`,
`store.test.ts`, and `ranking.test.ts` over the wire (the label, the lender's line, the ★ moving
off a model that failed in a chat).

**Found while checking, not fixed:** a plugin's `sampling/createMessage` reaches the host without
the SDK's abort signal (`supervisor.ts`), so when Adapt gives up at 110 s, `send()` goes on
walking the plan. The fix is to pass that signal through `host.sampling()` into `send()`.

---

## 3. A failure ends the conversation

### What the code does

`send()` (`router.ts:720`) walks the plan and moves to the next model on **429, any 5xx, 403,
406, and an empty answer**. Everything else throws, and the task ends:

| What happens | Status | Today |
|---|---|---|
| Rate-limited, provider down | 429, 5xx | Next model |
| Model gated, worker gone | 403, 406 | Next model |
| **No credit** | **402** | **Ends the conversation** |
| **Model retired or renamed** | **404** | **Ends the conversation** |
| **Request too large for this model** | **400, 413** | **Ends the conversation** |
| **Network drop, DNS, reset** | *(no status)* | **Ends the conversation** |
| **The stream dies halfway** | *(no status)* | **Ends the conversation** |
| **A provider that never answers** | *(no timeout)* | **Waits.** Most rows declare no `timeoutMs` |
| Wrong key | 401 | Ends the conversation. Right when pinned, wrong in Automatic when other providers exist |

And **a pinned model is one choice** (`router.ts:302`), so *any* failure on it ends the
conversation. A pin whose provider the ledger marks as spent is refused before it is even
tried (*…is not available right now*).

**D112 says** *anything you do not list still answers behind the ones you did*. So today a
**sequence silently continues into every other model**, and a **single pin has no fallback at
all**. That is exactly backwards from what was asked for.

### What it should do: three modes, three promises

| Mode | What the person chose | On failure |
|---|---|---|
| **Automatic** | Nothing, or *Automatic* | **Falls through the whole ranked list** (§2), on any failure that is about the model, not about the request. One line when it switches: *Nemotron 3 Super is rate-limited — this answer is from Gemma 4 31B.* |
| **Sequence** | An ordered list | **Falls through that list, and only that list.** When the last one fails it stops and says which failed and why, with one button: *Use Automatic for this answer.* |
| **One model** | A single model | **No fallback.** It stops, names the model and the reason in plain words, with *Try again* and *Use Automatic for this answer*. |

**"Use Automatic for this answer" is one answer, not a setting change.** The person's pin
survives; the next message goes back to their choice. Changing the setting is theirs to do.

### The fix

1. **Classify failures once, in `send()`**, into three kinds:
   - **This model, right now**: 402, 403, 404, 406, 408, 429, 5xx, a timeout, a network
     error, a dead stream, an empty or cut-off answer. The next rung may work.
   - **This provider**: 401. Skip every rung on that provider for the rest of the answer, and
     say *the Groq key was refused* once. Other providers can still answer.
   - **This request**: 400 or 413 from a context that is too long. Try the next rung **with a
     bigger window**, never a smaller one; if none has one, stop and say the conversation is
     too long for the models available.
2. **A mode on the plan, not on `send()`.** `route()` returns
   `{ mode: 'automatic' | 'sequence' | 'pinned', choices }`. For `sequence` the choices are
   exactly the listed models, and for `pinned` exactly one. `send()` falls through whatever it
   was given, so the rule lives in one place.
3. **A default patience for every provider**: time to first byte of 30 s, then 20 s between
   chunks. Rows that already declare `timeoutMs` keep theirs; AI Horde's volunteer queue gets
   a longer one. *Nothing waits forever* is the rule, not the number.
4. **A dead stream restarts on the next rung**, in Automatic and within a sequence. The shell
   is told `restart` so it clears the half-written bubble before the new one streams in.
5. **The stop message is a sentence and two buttons**, never a status code. It reads the
   failure kind: *Gemma 4 31B has used up today's free requests.* / *Your OpenRouter key has no
   credit left.* / *Nemotron 3 Super did not answer within 30 seconds.*
6. **The ledger stops refusing pins in advance.** A pinned model whose provider's local count
   says *spent* is tried anyway: D107 already says that count is a deliberately low copy of
   somebody else's number.

**Built 2026-09-15 (D158)**, all six, in core and the shell. Where the build differs from the
text above, or had to decide something the text did not:

- **Patience counts bytes.** A reasoning model streaming its thoughts and a gateway's keep-alive
  both reset the gap. A row's `timeoutMs` is its first-byte patience, `idleMs` its gap. Ollama
  on this machine gets 180 s to the first byte.
- **A stream that ends without `[DONE]` or a `finish_reason`, or sends an error frame, is a
  failure.** Before, it came back as a finished answer.
- **A cut-off answer moves on only when free.** A paid one was billed, and the next paid model
  would hit the same ceiling for a second bill.
- **A 401 on a keyless provider with no key sent is one model wanting a key**, not the
  provider's key refused, so that provider's other models are still asked.
- **A sequence keeps today's filters, money included** (allowance, sidegrade). Rows of one model
  on two providers go key first, then the keyless floor. On this machine each Nemotron in the
  owner's order is on both OpenRouter and Kilo.
- **The switch line is said as the new model starts answering**, not before it is asked:
  *Nemotron 3 Super is rate-limited right now — this answer is from Gemma 4 31B.* It is also
  said inside a sequence.
- **"Use Automatic for this answer"** is `POST /api/chat {again: true, automatic: true}`. It asks
  the question already in the conversation, from where the task stopped, and appends nothing.
  A pin also gets *Try again*.
- Found while testing: four `serve.test` failures were this Mac's Ollama answering the suite;
  `ServeOptions.local: false` keeps it out.

Tests: `router.test.ts` (modes, every failure kind, the stop sentence), `provider.test.ts`
(patience, dropped streams, error frames, unreachable, keyless 401), `agent.test.ts`, and
`fallback.test.ts` over `/api/chat`. The shell was driven in headless Chromium against a stub.

**Acceptance.** A fake provider answering 402 then a working one: Automatic answers from the
second, and the transcript shows the switch line. The same with a single pin: the answer stops
with the 402 sentence and two buttons. A sequence of two failing models with a third working
model outside the sequence: stops, and the third is never called. A stream cut after five
chunks: Automatic restarts on the next model and the first bubble is cleared. A provider that
never answers: the next rung is asked after 30 s.

---

## 4. After §2: the owner's answers (D160)

Asked in plain words once §2 was built, and answered 2026-09-15. Each line says whether it is
**decided**, **proposed** (suggested here, not yet confirmed by the owner), or **open**.

### Decided

- **Size.** A size read from a name counts the whole model (`30b-a3b` is 30B), and only ever
  orders: names can be wrong, so it never rules a model out. This is what D159 built.
- **Free limits are protected per provider account**, not by locking one model to a chat. A
  free allowance is usually shared by every free model on one account (OpenRouter's daily free
  requests are), so a lock on one model would protect nothing. The chat somebody is watching has
  first claim on each provider's free requests; plugins (Telegram, Adapt) take another provider,
  wait, or run locally.
- **A switch to another model is said twice**: a pop-up that goes away after three seconds, on
  every switch (rate limit, timeout, error, an answer that broke off), and the line in the chat
  that already says it stays, as the record.
- **An answer that breaks off restarts on the next model without asking, paid ones included.**
  That is what `send()` already does. D158's rule is unchanged: a paid answer that reached its
  length limit is kept, not bought again.
- **Crossing into paid gets a switch**, shown under the slider when it is on *free then paid*:
  - **On**: Automatic moves to a paid model when the free ones are done, and a warning sits under
    the message box (*paid models will be used once the free ones are done*).
  - **Off**: the work pauses, and waits for *Allow switching to a paid model*.
- **When Adapt gives up, core stops too.** `supervisor.ts` hands `sampling/createMessage` to the
  host without the SDK's abort signal; it is to be passed through `host.sampling()` into `send()`.

### Asked for, to be designed (a clickable mock-up first)

- **A table on the Models screen that ranks every model and shows why**: its place, its
  attributes, and what Alexia thinks of it, as tags such as *new*, *busy* and *broken*, so Alexia
  can set aside a model that does not help on its own.
- **Kept current without anybody importing a model.** Every provider's list is already fetched
  by Alexia itself; what changes daily should show up in the table.

### Proposed, not yet confirmed

- **Busy is not broken.** Most free failures are evening rate limits. *Busy* sinks and comes back
  on its own (D159's strikes); *broken* is retired, always empty or always failing.
- **Set aside, never deleted, and never out of somebody's own choice.** A broken model is hidden
  with its reason on screen and comes back if it starts working. A pinned or listed model is shown
  as *not available*, never removed (D155).
- **New is the middle, not the bottom.** A model that just appeared has no usage figure yet; a new
  model is sometimes the best one, and OpenRouter's figure fills in within a week.
- **Hallucinating needs a person.** A script sees errors, timeouts and empty answers, but cannot
  tell a wrong answer from a right one. The signal is a *bad answer* press — Alexia.md already
  plans *try that again with a smarter model*, which collects exactly that.
- **The list on a timer.** Today it is fetched at startup and when the Models tab opens, so an app
  left open for a week has a week-old list.
- **Limits read from answers.** Limits are typed into `PROVIDERS` by hand with a *verified* date,
  because providers do not publish them in a readable list; some send *requests left* with every
  answer, which could keep the ledger honest.
- **The paid switch works through the daily allowance** Alexia already has, so there are not two
  money settings that can disagree: on spends up to the allowance without asking, off asks. A
  paused task started from Telegram gives up after a while and says so there. The warning also
  covers the case where no free model *can* do the job (a picture, a long conversation), not only
  where they are used up.

### Open

- **Sending model statistics to a server of the owner's.** *Decided later.* It would change two
  things Alexia.md says (*no user backend at all*, and the registry's *no analytics*). If it comes:
  opt-in, no prompts, keys, names or times of day, a privacy policy (GDPR applies in Europe),
  protection against fake reports, and a published *known broken* list the app reads as one more
  signal — never a server deleting models from people's apps.

---

## Order of work

**Status 2026-09-15:** steps 1 and 2 are built and tested. Measured against the live lists:
Requesty 684 → **12** free (9 with tools), Navy 146 → 101 rows (45 unpriced dropped, 1 free),
Kilo 370 rows (22 free), OpenRouter 441 (23 free). Under *free only*, the Models tab no longer
lists paid rows. §3 is in core and the shell (D158), and it reaches the installed app only with
a new build. §2 is built too (D159), and also needs a new build. Not yet: *Funded*, the keyless
group and its switch, key events, key removal. Next: §1 steps 3–4, then §4 (D160).

1. **§1 steps 1–2**: unpriced is not free, one `available()`. Smallest change, and it closes
   a real billing hole (Requesty) before anything else.
2. ~~**§3**: failure kinds, the three modes, default timeouts. This is the one people feel on
   every rate-limited evening.~~ Done 2026-09-15 (D158).
3. ~~**§2**: ranking. Borrowed `weekly` and *routers last* first, because they are cheap. Strikes
   and size-from-id second.~~ Done 2026-09-15 (D159).
4. **§1 steps 3–4**: key events and key removal, which need the shell.
5. ~~**Alexia.md**: D112 rewritten with the three modes, and the decision log entry.~~ Done
   2026-09-15 (D154, D155).
6. **§4** (D160): Adapt's cancel reaching `send()` (small); the mock-up of the model table, then
   its build; free limits per account; the switch pop-up; the paid switch.

## Open decisions

- [x] **Keyless providers in the list.** **Yes, as their own group** — *works without a key*,
  switched on by default and switchable off (D154).
- [x] **A sequence falls through within itself.** **Yes** — and never past its last entry
  (D155).
- [x] **Automatic and paid.** With the slider on *free then paid*, does Automatic's
  fallthrough cross into paid models after the last free one? **A switch decides** (D160): on,
  it does, with a warning under the message box; off, it pauses and asks. See §4.
- [x] **The model-size heuristic.** Reading `-2.6b` out of an id is right for most open
  models and says nothing about closed ones. **An order and never a filter, and the whole
  model counts** (`-30b-a3b` is 30B): built in D159, confirmed in D160.
- [x] **A restart after a dead stream** costs the tokens already streamed. **Restart without
  asking, paid included** (D160), with a three-second pop-up and the line in the chat.
- [ ] **Model statistics to the owner's server.** Decided later (D160). See §4.
