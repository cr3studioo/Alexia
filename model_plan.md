# Models — the list, the ranking, and the fallback

> **What this doc is.** The plan to fix how Alexia lists, ranks and falls back between models.
> It is a build plan, not research: [`models_plan.md`](./models_plan.md) is the August research
> on which providers exist and what they give away, and this builds on it. **Agreed
> 2026-09-15** and recorded in [`Alexia.md`](./Alexia.md) as **D154** (§1–2) and **D155**
> (§3, which changes D112); **D158** and **D159** record how §3 and §2 were built; **D160** the
> owner's answers that followed, and **D161** the design of §4 answered against a clickable
> mock-up. Tracked as **M8-6** in [`plan.md`](./plan.md).
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
walking the plan. The fix is to pass that signal through `host.sampling()` into `send()` (§4 A).

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

## 4. A table that shows what Alexia thinks of each model

Asked for by the owner once §2 was built (**D160**), then designed against a clickable mock-up
and answered the same day (**D161**). In the owner's words: *a table where every model is ranked
and given attributes, so I can see what the program thinks about each model. Alexia tags models
herself, "too many errors", and sets aside models that don't help, on her own. The table keeps
itself up to date: providers change their lists and limits almost daily, and nobody should ever
import a model by hand. New models are "not trusted yet" and move up as evidence arrives.*

**Mock-up:** [the Models table](https://claude.ai/artifact/WhUn8j9VYiMQKQTaGkkWQr). Every
rank, size, usage figure, price, key and *answered here* in it is real: this Mac's
`cache/models.json` run through the built `route()`, OpenRouter's live list, this Mac's database,
and test requests sent on 2026-09-15. Tags drawn with a dashed outline show a rule where this Mac
has no evidence for it yet.

**Already built, and confirmed in D160:** a size read from a name counts the whole model
(`30b-a3b` is 30B) and only orders (D159); an answer that breaks off restarts on the next model
without asking, paid included, and a paid answer that reached its length limit is still kept
rather than bought twice (D158).

### What the code does

**The table is not the ranking.**
- The Models tab sorts its rows with a comparator of its own (`surface.ts:264`): the ★, the
  person's list, router, size, `weekly`, price. It leaves out what failed here and the ladder
  (your key, this Mac, no key), so a row's place is not where Automatic would ask it. Only the ★
  is `route()`'s answer.
- Rows are grouped by provider (`panels.ts:265`), so there is no one order to read a rank from.
- A row's id is the model id (`surface.ts:283`) and the detail finds the first row with that id
  (`surface.ts:310`). Nemotron 3 Super is on OpenRouter and on Kilo, so Kilo's row opens
  OpenRouter's detail.
- The hint still says every provider but OpenRouter *is ordered by price instead*
  (`panels.ts:243`), which D159's lent figure made untrue.

**Nothing remembers enough to judge a model.**
- `strikes` (migration 6, `store.ts:96`) keeps failures for one day (`STRIKES_KEPT`,
  `store.ts:109`), and `strikes()` does not return the status it stored (`store.ts:674`). *Busy
  this evening* and *retired* look the same, and anything older than a day is gone.
- `usage` keeps every answer (`store.ts:684`); `provider_usage` counts requests per provider for
  the current minute, day and month only (`store.ts:620`). Nothing counts how often one model was
  *tried*, so no failure rate can be computed.
- No first-seen time is stored. `refresh()` works out `Change.added` and `removed`
  (`catalog.ts:385`) and nobody keeps them. `news()` (`catalog.ts:448`), which turns them into
  *three new free models are available*, has no caller. `parse()` (`catalog.ts:470`) reads
  neither OpenRouter's `created` nor its `expiration_date`.
- The installed app's database is at migration 5, so D159's `strikes` has not reached it. On this
  Mac: 16 answers ever, and the ledger shows 8 OVHcloud requests on 14 Sep with none answered.

**Evidence only arrives from the top.** Automatic walks from its first choice and stops at the
first answer, so on an ordinary day only the first few rows are ever asked. A model lower down is
never tried, and a model that has been set aside would never be tried again.

**The lists are fetched at startup and when the Models tab opens** (`serve.ts:244`,
`surface.ts:232`). There is no timer, though Alexia.md (*The model router*) already says *poll
daily*. Measured: OpenRouter's free list gained `z-ai/glm-5.2:free` between this Mac's cache
(10:25 UTC) and the evening.

**Limits are typed by hand, and some are already wrong.** `rpm`, `rpd` and `callsPerMonth`, each
row with a `verified` date (`provider.ts:106–132`). Checked on 2026-09-15:

| Provider | The row says | Now |
|---|---|---|
| **Cerebras** | 30 a minute, 14,400 a day | 5 a minute on the free trial (its docs) |
| **Groq** | 14,400 a day | GPT-OSS 120B: 30 a minute, 1,000 a day, published per model (its docs) |
| **LLM7** | answers without a key | *Missing API key* from both models tried (live) |
| **OVHcloud** | 2 a minute without a key | 429 on the first request, and again a minute later (live) |

`chat()` (`provider.ts:816`) reads no response header. What providers send:

| Provider | What it tells | How it is known |
|---|---|---|
| **Groq** | `x-ratelimit-limit-requests` and `-remaining-requests` (per day), `-limit-tokens` and `-remaining-tokens` (per minute), `-reset-*`, `retry-after` on a 429 | docs |
| **OVHcloud** | `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `x-ratelimit-limit-minute`, `x-ratelimit-remaining-minute`, `retry-after` | live, keyless |
| **OpenRouter** | `X-RateLimit-Limit`, `-Remaining`, `-Reset` **only on a 429**; `Retry-After` when the providers behind it hint | docs |
| **OpenRouter `GET /api/v1/key`** | `limit`, `limit_remaining`, `usage`, `usage_daily`/`_weekly`/`_monthly`, `is_free_tier` | docs; not called with the owner's key |
| **Kilo** | nothing on a 200 | live, keyless |
| **Google AI Studio** | nothing documented; limits are shown in its dashboard | docs |
| **Cerebras** | not named in its docs | docs |

**Free requests are one pool for everybody.** `send()` counts every free request against its
provider (`router.ts:1152`, `pool.ts:101`) whoever sent it, so a Telegram task and the chat on
screen draw from the same OpenRouter fifty a day, first come, first served.

**A switch is said once, and not kept.** `send()` says the switch line as the new model starts
answering (`router.ts:1128`); `serve.ts:2172` streams it as a `note`; the shell writes it into
`#note` (`main.ts:1469` → `say()`, `main.ts:143`): one line under the message box, replaced by the
next note and never stored. A reload loses it.

**Money.** The daily allowance is `caps.daily` (`usage.ts:44`), **$0 unless somebody sets it**
(`usage.ts:56`), and at $0 *free then paid* is *free only* (`capped`, `router.ts:430`). The router
already knows when paid *would* have answered (`priced`, `router.ts:513`), and says it as a
sentence. The money question (`MoneyConsent`, `agent.ts:178`) is asked only when this Mac's model
heads the plan with a paid one behind it (`agent.ts:560`), and the answer lasts the conversation
(`spending`, `serve.ts:595`). A plugin with no run is free only (D96, `router.ts:1063`). A Telegram
task can already put a yes/no to the phone (`CORE_CAPABILITIES.ask`, `serve.ts:776`).

**Adapt's cancel.** `supervisor.ts:256` registers `sampling/createMessage` as
`(request) => this.host.sampling(this.id, request.params)`. The SDK (2.0.0) passes the handler a
second argument whose `mcpReq.signal` aborts when the plugin gives up. It is dropped:
`HostServices.sampling` (`supervisor.ts:51`) and `host.ts:83` have nowhere to put it, and
`serve.ts:379` calls `send()` without one. When Adapt stops waiting at 110 s, `send()` goes on
down the plan.

**No bad-answer button.** `Ask.above` exists and the loop escalates with it (`agent.ts:416`), but
the shell has no *try that again with a smarter model*.

### What it should do

#### The table

**One table, in the order Alexia would ask**, grouped by what a row is to the router rather
than by provider:

| Group | Which rows | In what order |
|---|---|---|
| **Your list** | Only when the list has entries | The list's own order, one model's providers key first (D158) |
| **Automatic, free** | Every reachable free model that is not set aside | `route()`'s order for a plain request |
| **Set aside by Alexia** | Free models set aside, each with its reason | By reason, then name |
| **Paid** | Unless the slider is on *free only* | `route()`'s order under *paid only*: tools first, then cheapest |

**The columns, and where each value comes from:**

| Column | Shows | From |
|---|---|---|
| **#** | Place in its group | The position in `route()`'s `choices`, never a second sort in `surface.ts` |
| **Model** | Name, provider, *your key* / *no key* / *this Mac* | `Model.name`, `Choice.provider`, `Choice.keyed` |
| **Why it is here** | One sentence under the name | `explain(row, rowAbove)`: the first ranking key on which the two differ |
| **Size** | *31B, from its name* / *8.2B, reported* / *not said* | `sizeOf()` (`catalog.ts:86`), and whether `params` was reported |
| **Can** | *tools* / *talk only*, *pictures*, *reads 256k* | `supportsTools`, `modality`, `context` |
| **World, last week** | Tokens, and *via OpenRouter* when lent | `weekly`, `weeklyFrom` |
| **Answered here** | Answers in 30 days | The model record, below |
| **Price** | *free*, or dollars per million tokens in | `priceIn` |
| **Tags** | What Alexia thinks, and plain facts | `judge()`, below |

Clicking a row opens **what Alexia has seen**, a sentence per piece of evidence (*answered 2
times; said "too busy" 4 times between 18:10 and 21:40*), and the model's facts.

**The why-line cannot drift from the ranking, because it is the ranking.** `ranking()`
(`router.ts:681`) becomes an ordered list of named keys, each with a comparison and a sentence.
The comparator walks the list; `explain(a, b)` returns the first deciding key's sentence. From the
mock-up: *The world sent it 32B tokens last week, fewer than Gemma 4 26B's 317B.* · *No key
needed, so shared and rationed for everyone. After models on your key.* · *A router: a different
free model each time, some of them tiny.* · *New and not tried yet, so it waits below every model
that has answered.*

**Rows are keyed by provider and model**, so each copy has its own detail and its own tags:
Kilo's Nemotron can be busy while OpenRouter's answers.

#### The model record

**One row per try, kept 30 days**: when, which provider and model, how it went (*answered*,
*busy*, *failed*, *slow*, *empty*, *cut*, *retired*, *needs a key*, *bad answer*), the status, and
who asked (*chat*, *plugin*, *test*, or *person* for a bad-answer press). **And one row per model
per provider**: when it was first seen here, whether its provider's list was already known at that
moment, and when it left the list.

D159's strikes become a reading of the record: the last day's failures about the model, weighed
exactly as `sunk()` weighs them (`router.ts:246`), so Automatic's order does not move on the same
failures. As in D159, a refused key is the provider's and a conversation too long is the
request's. No credit (402) is the account's: said about the provider, never tagged on the model.

#### The tags, and what each one does

One function, `judge()`, computes them from the record and the catalog, and both `route()` and the
table read it (the D154 rule: one function, two readers). Every number is a named constant
beside its reason.

| Tag | Rule | Effect | Why this number |
|---|---|---|---|
| **new · not tried yet** | First seen here in the last 14 days, when its provider's list was already known; or OpenRouter's `created` in the last 14 days. And no good reply here yet | **The bottom of its group** | 14 days gives OpenRouter's weekly figure a full week to arrive. On a fresh install everything is first seen at once, so there only `created` counts |
| *(no longer new)* | Its first good reply, from a real question or a test message | Ranked as if its usage were the middle of models its size, until a real figure (its own or lent) replaces that, up or down | The owner's rule: *the first good reply moves it higher, then OpenRouter's figure overwrites it*. The middle is the least one reply proves. After 14 days with no figure it ranks like any model without one |
| **busy** | Rate-limited in the last hour, or before a `retry-after` the provider sent | Sinks, as D159's strikes already do, and clears by itself | Busy is not broken: most free failures are an evening's per-minute limits |
| **always busy for you** | In the last 24 hours, at least 3 tries spread over at least 2 hours, every one rate-limited, none answered | **Set aside** | A rush comes in minutes. D159's half-life retries a sinking model about every 90 minutes, so a whole day of refusals reaches 3 spread tries by itself. OVHcloud: 8 of 8 on 14 Sep, 2 of 2 on 15 Sep |
| **not answering** | The same shape for timeouts, dropped streams and errors, or a mix of those and rate limits | **Set aside** | The same day-long wall for a different reason |
| **answers empty** | 3 empty answers in a row with no good reply between | **Set aside** | A classifier (`nemotron-3.5-content-safety`) or an image model is empty every time; one empty answer can be a hiccup |
| **retired** | *No longer offered* (404) twice in a row; or gone from its provider's list; or past OpenRouter's `expiration_date` | **Set aside**. A row gone from the list stays only where a pin or a list names it | One 404 can be a provider mid-deploy |
| **retiring {date}** | OpenRouter's `expiration_date` within 30 days | None | Said before it happens: `dots-3-note-preview:free` retires 2026-09-30 |
| **needs a key** | Refused for having no key (a keyless 401, D158) twice for one model, **or once each for two models of the same provider** | **Set aside** until a key for that provider is saved, then back at once | LLM7 on 15 Sep: two models, two refusals. One model wanting a key is that model; two means the provider changed |
| **too many errors** | In 30 days, at least 5 tries and at least half of them failed, busy not counted | Below every model without doubts in its group; stays listed | Under 5 tries the share is luck. At half, every other answer is a switch pop-up |
| **gave bad answers** | 2 *Bad answer* presses in 30 days | As *too many errors* | One press can be the question's fault; two in a month are the model's |
| **router**, **under 7B**, **talk only**, **keeps your words** | `routes()`, `stature()`, `supportsTools`, `trainsOnYourData: 'yes'` | Nothing beyond what they already do in the ranking | Facts, shown so nobody has to open the detail for them |

**Set aside, never deleted:**
- **Automatic** leaves a set-aside model out of its plan. When that would leave nothing, it asks
  them anyway, the reading the ledger already gets (`reachable()`, `router.ts:546`): asking and
  collecting a refusal beats refusing on a guess.
- **Your list** keeps every entry. A set-aside entry is skipped and shown as *not available:
  always busy for you*; when every entry is set aside they are asked in order anyway. D155's promise
  holds: Alexia never edits a list.
- **A pin is asked anyway**, the way D158 stopped the ledger refusing pins in advance, and its row
  says what Alexia has seen.
- **One good reply brings a model back**, and the daily test is how a set-aside model gets the
  chance to give one.

**Hallucination is not detected.** A script sees errors, timeouts and empty answers. It cannot
tell a wrong answer from a right one, so the signal is a person pressing *Bad answer*.

#### Test messages

**Once a day, Alexia sends a tiny test to the models that have no other way to earn evidence**:
new models not yet tried, and set-aside models (except *needs a key* while there is no key, and
*retired* once gone from the list).
- **What is sent**: *Reply with the single word OK.* Never a word of the person's, never a
  conversation, never a personality. Any reply with text in it is a good reply.
- **Free only**, like any request nobody is waiting on (D96).
- **At most 10 a day in all**, one per model, only while the app is running, never while an
  answer is streaming.
- **The lowest claim on free requests**: a test counts as background for the rule below.
- Recorded as `source: 'test'`. Nothing goes into a conversation or the spend ledger.

#### Keeping it current

- **Every 6 hours** while the app runs, plus at startup and when the Models tab opens, as now.
  Alexia.md said *daily*. `refresh()`'s age check becomes 6 hours; a tick that comes late after
  the machine slept simply polls.
- **First seen** is written from `Change.added` on every refresh, and *left the list* from
  `Change.removed`; a model that comes back clears it.
- **`parse()` reads `created` and `expiration_date` for OpenRouter**, the only list whose
  `created` means *added*. `PARSER` becomes 7.
- **The news line**: `news()` gets its caller. On the Models tab, once per refresh that added
  something free: *1 new free model since this morning: GLM 5.2 on OpenRouter. Not tried yet.*
- **Limits from answers**: `chat()` reads the headers above on every response and every error. A
  remaining count lowers the ledger's count for that provider and never raises it past the row; a
  reset says when it recovers; `retry-after` makes the model *busy* until then. A provider that
  sends nothing changes nothing, and the typed row stays the floor.
- **OpenRouter's key**, when there is one, is read (`GET /api/v1/key`) when it is saved and on
  every tick: `is_free_tier` picks 50 or 1,000 a day, which replaces D107's deliberately low guess
  with the real figure, and `limit_remaining` is §1's missing *Funded*.
- **The four rows found wrong are re-verified by hand** (Cerebras, Groq, LLM7, OVHcloud).
  Headers correct what they report, and no header reports Cerebras's or LLM7's terms.

#### Free limits per account, with the chat first

D160 gave the chat on screen first claim on each provider's free requests. How:
- **The chat** is a request from the app's own chat, and **Adapt**, which somebody pressed and is
  watching (D156). **Background** is everything else: a plugin's task (Telegram), a plugin's
  sampling request, a test message.
- **Background uses providers with no daily limit first**: no `rpd` and no `callsPerMonth` (a
  per-minute limit alone, like Kilo's, is not a daily one), and this Mac.
- **Only when none of those can do the job** (tools, window, pictures) may background use a
  day-limited provider, and **only the first half of its day**: 25 of OpenRouter's 50, by the
  ledger or by a header's remaining count, whichever is lower.
- **Per provider.** OpenRouter's free allowance is shared by every free model on an account (its
  docs), which is the case D160 was about. Groq publishes a limit per model, so there the half is
  stricter than it needs to be; a row can say `limits: 'model'` the day that matters.
- A pin or a list is held to the same half for background, and the stop says *the rest of today's
  OpenRouter requests are kept for your chat*.

#### A switch is said twice

D160: every switch to another model (a rate limit, a timeout, an error, an answer that broke off)
is **a pop-up for three seconds** and **a line in the chat that stays**.
- `send()` reports the switch as an event with its parts (from, to, the reasons) beside the
  sentence it already builds.
- The shell shows that sentence as a pop-up for 3 seconds (a newer one replaces it), and adds it
  to the answer as a small line above the words, not to `#note`.
- **The line is saved** on the assistant message, as `notes` in its JSON body (no migration,
  `store.ts:586`), and drawn again from history. `toWire()` (`provider.ts:1021`) sends only what
  a provider reads, so a note never reaches a model.
- The paid warning gets a place of its own above the message box, so neither replaces the other.

#### Crossing into paid

| | The paid switch **on** | The paid switch **off** |
|---|---|---|
| **The setting** | Shown under the slider on *free then paid*. Turning it on asks *up to $__ a day*, starting at $1, and that number **is** `caps.daily`: one money setting | The daily amount is kept and bounds what *Allow* can spend |
| **Free models used up** | Moves to paid, with a warning above the message box: *Paid models will be used once the free ones are done, up to $1.00 today* | The work **pauses**: *The free models are used up.* **Allow switching to a paid model** |
| **No free model can do it** (a picture, a long conversation) | The same, and the warning names the reason | The same pause, naming the reason |
| **This Mac's model is next** | Paid first: the switch is the yes, given in advance | This Mac answers; it pauses only if this Mac cannot |
| **One press of *Allow*** | — | Covers **this conversation**, as today's money question does. At $0 the button carries the amount box |
| **A Telegram task** | Moves to paid, as the chat would | **Asks on Telegram**, with the yes/no permission questions already use. No answer in **10 minutes** stops it, and it says so there |
| **A plugin with no run** | Free only (D96), unchanged | Free only |

**The money question is folded into the switch.** *Slow local (free), or paid?* (`agent.ts:560`)
stops being a question of its own: with the switch on it is already answered, and with the switch
off the pause is the one place money is asked about. The monthly cap and its hard stop are
unchanged and still stop everything.

#### Adapt's cancel

When the plugin gives up, core stops. The SDK's signal is passed from the handler into `send()`,
so no further rung is asked, nothing counts as the model's failure, and nothing is billed after
the plugin has shown its refusal. The same signal reaches `asTask`, so a plugin's task stops when
its plugin gives up.

#### A bad-answer button

A quiet **Bad answer** on every finished answer. A press records a *bad answer* for the model
that answered (a router's own row when a router answered), then asks the same question again
**without that model**: the next in Automatic's ranking, or with the paid switch on, a model
above its tier (`Ask.above`, the *smarter model* Alexia.md planned). Two presses in 30 days tag
the model. It sits in the same place on an answer as D157's *that wasn't her*, which is about the
personality rather than the model, so the two are built as one row of message actions.

#### Later: the record shared with a server of the owner's

*Decided later* (D160). This plan leaves the hook and nothing else:
- `store.report(since)` returns, per model per provider and by week: tries, answers, failures by
  kind, and bad-answer presses. No prompts, answers, keys, names or times of day. Nothing calls
  it and nothing sends it.
- `World.reported`, an optional set of models reported broken elsewhere, is empty today; `judge()`
  would read it as one more piece of evidence, never as a deletion.
- **Sending it would change Alexia.md in two places**: *no user backend at all* (*What deliberately
  is not in first run*) and the registry's *no analytics* (*A real backend from the start*). It
  would have to be opt-in, with a privacy policy (GDPR applies), protection against fake reports,
  and a published *known broken* list that apps read as a signal.

### The fix

**A. Adapt's cancel**
1. `HostServices.sampling(pluginId, params, signal?)` (`supervisor.ts:51`). The handler at
   `supervisor.ts:256` passes `ctx.mcpReq.signal`, and `host.ts:83` passes it on.
2. `serve.ts`'s `sample` puts the signal on `send()`'s request (`serve.ts:379`) and on `asTask`'s
   run, joined to the task's own stop with `AbortSignal.any`.

**B. The model record and the tags**
3. **Migration 7**: `tries` (`at`, `provider`, `model`, `outcome`, `status`, `source`) and `seen`
   (`provider`, `model`, `first_seen`, `list_known`, `gone_at`); rows older than 30 days deleted as
   new ones arrive. `recordStrike()` becomes `recordTry()`, called by `send()` for every outcome,
   answers included; `strikes()` reads the last day's model failures from `tries`; the one-day
   `strikes` table is dropped by the same migration. The outcome is named beside `failed()`
   (`router.ts:943`).
4. **`health.ts`**: `judge(tries, seen, models, keyed, now)` returns, per provider and model,
   `{ tags, aside?, untested, doubted, standIn? }`, every threshold a named constant with its
   reason. `World.health` carries it and `world()` (`serve.ts:487`) gathers it.
5. **`route()`** leaves set-aside rows out of Automatic's pool and a sequence's, unless nothing
   would be left; a pin ignores it.
6. **`ranking()` becomes named keys**: group, *not tried yet*, *doubted*, tools, what failed here,
   router, the ladder, tier, price, size, usage or its stand-in. `/best` still turns only the
   money keys. `explain(a, b)` returns the deciding key's sentence.

**C. The table**
7. `surface.ts` builds the rows from `route()`'s plans (the list's; Automatic's for a plain
   request; *paid only*'s) and the set-aside rows from `World.health`, keyed `provider\nmodel`;
   `detail` and the row actions read both halves. `panels.ts` replaces `groupBy: 'provider'` with
   the four groups and a corrected hint; the shell's table draws tags as chips in their tone.
8. The ★ keeps its definition: `route()`'s first choice for a request with tools.

**D. Keeping it current**
9. A 6-hour timer in `serve()` calling `pollAll`, cleared on close; `refresh()`'s default age 6 hours.
10. `refresh()` writes `seen` from its `Change`; `parse()` reads `created` and `expiration_date`
    for OpenRouter; `PARSER` 7; `news()` is called and its line shown on the Models tab.
11. `chat()` reads rate-limit headers into a per-provider *heard* record (remaining, span, reset,
    when); `remaining()` (`pool.ts:44`) takes the lower of the ledger and what was heard;
    `retry-after` records *busy until* for that model.
12. OpenRouter's `GET /api/v1/key` when its key is saved and on every tick: `is_free_tier` sets
    the day's limit, `limit_remaining` feeds §1's *Funded*.
13. Re-verify the Cerebras, Groq, LLM7 and OVHcloud rows by hand, with new `verified` dates.

**E. Test messages**
14. **`trial.ts`**: once a day on the timer, up to 10 models due a test, each sent
    `send([choice], { messages: [TEST], maxTokens: 256 }, …, { source: 'test' })` one at a time,
    skipped while a chat answer streams. Free only, and background for the limit rule.

**F. Free limits per account**
15. `Ask.background` (a plugin's task or sampling request, a test; never the chat or Adapt). For
    background, `route()` builds the pool from providers with no daily limit and this Mac; only when
    that pool fits nothing does it add day-limited providers under half their day. The refusal
    says the rest is kept for the chat.

**G. A switch said twice**
16. `send()` gains `onSwitch({ from, to, reasons })` beside `onNote`; `serve.ts` streams `switch`;
    the assistant message stores `notes`.
17. The shell: a 3-second pop-up, the saved line above the answer, notes drawn from history, and
    the paid warning in its own place above the message box.

**H. Crossing into paid**
18. `caps.cross` beside `caps.daily`. On the Models tab, the switch under the slider on *free then
    paid*; turning it on asks for and writes `daily`, starting at $1.
19. **Off**: when Automatic or a sequence runs out of free models, because they are used up or
    cannot do the job, and the same request with the price line open has a paid choice (`priced`,
    `router.ts:513`, and the same check once `send()` has exhausted the free rungs), the run ends
    `paused` rather than `refused`. The shell shows *Allow switching to a paid model*, with the
    amount box when `daily` is $0; a press sets the conversation's `spending` and asks again from
    where it stopped.
20. **On**: `spending` is true from the start of a conversation and the warning shows. The
    *slow local or paid* question (`agent.ts:560`) is removed.
21. **Telegram**: `asTask`'s pause asks through `CORE_CAPABILITIES.ask` and waits 10 minutes; no
    answer ends the task with the sentence sent back.

**I. The bad-answer button**
22. `POST /api/chat { again: true, bad: { provider, model } }` records the press and asks again
    without that model (and `above` its tier with the paid switch on). The shell's button sits in
    one row of message actions with *that wasn't her* (D157).

**J. The hook for later**
23. `store.report(since)` and an empty `World.reported`, with a test that a report carries only
    the listed fields.

### Acceptance

- **Cancel.** A plugin asks for sampling with a 1-second timeout, over a provider that never
  answers and a second that would: the second provider is never called, and no try is recorded
  against the first.
- **Same order, new record.** D159's tests in `router.test.ts` pass unchanged over failures
  written to `tries`.
- **Busy and set aside.** Three rate-limited tries at 10:00, 11:00 and 12:30 with no answer: *always
  busy for you*, and out of Automatic's plan. Three at 20:00, 20:05 and 20:10: *busy*, and still in
  it. One good reply the next day: back.
- **Empty and retired.** Three empty answers in a row: *answers empty*. A 404, an answer, a 404:
  not retired. Two 404s in a row: retired.
- **Needs a key.** A keyless 401 from two models of one keyless provider sets every model of that
  provider aside; saving a key brings them all back without a restart.
- **Lists and pins.** A list whose first entry is set aside asks the second first and shows the
  first as *not available*; a list whose every entry is set aside asks them all, in order; a pin
  on a set-aside model is asked.
- **New.** A model that appears on a provider's second refresh is *new · not tried yet* and last
  in its group; after one good test reply it ranks at its size's middle usage; once its `weekly`
  arrives, at that figure's place. On a fresh install only models with a recent `created` are new.
- **The table is the ranking.** On this Mac's catalog copy, the Automatic group equals `route()`'s
  choices for a plain request row for row, and each row's why-line names the key on which it
  differs from the row above. Kilo's and OpenRouter's Nemotron 3 Super open different details.
- **Current.** With a fake clock the lists are fetched again after 6 hours and not after 5; a
  model added between two fetches produces the news line once. `x-ratelimit-remaining-requests: 3`
  leaves that provider 3 for the day; `retry-after: 20` makes the model busy for 20 seconds.
- **Tests.** With 14 models due, 10 tests go out, none to a paid model, none while an answer
  streams, and nothing lands in a conversation or the spend ledger.
- **Chat first.** A Telegram task needing tools, with keyless Kilo and keyed OpenRouter both able,
  goes to Kilo. With only OpenRouter able and 24 of its 50 used, it asks; at 25 it stops with the
  *kept for your chat* sentence. The chat at 49 of 50 still asks OpenRouter, and so does Adapt.
- **Said twice.** Automatic falls from a 429 to a second model: one `switch` event, a 3-second
  pop-up, the line above the answer, and the line is still there after a reload. No note is in the
  body a provider receives.
- **Paid.** Switch off, every free rung 429, a paid model reachable: the run ends `paused` and
  nothing is billed; *Allow* answers from the paid model, and the same conversation does not pause
  again. Switch on at $1: the paid model answers and the warning shows; with the day's $1 spent it
  stops as the allowance does today. A picture no free model can read: the same pause, with that
  reason. A Telegram task paused for 10 minutes without an answer ends with the sentence on
  Telegram.
- **Bad answer.** A press asks again and the model that answered is not asked; two presses in 30
  days tag it and move it below untagged models.

---

## Order of work

**Status 2026-09-15:** steps 1 and 2 are built and tested. Measured against the live lists:
Requesty 684 → **12** free (9 with tools), Navy 146 → 101 rows (45 unpriced dropped, 1 free),
Kilo 370 rows (22 free), OpenRouter 441 (23 free). Under *free only*, the Models tab no longer
lists paid rows. §3 is in core and the shell (D158), and it reaches the installed app only with
a new build. §2 is built too (D159), and also needs a new build. Not yet: *Funded*, the keyless
group and its switch, key events, key removal. §4 is designed (D160, D161) against a mock-up and
not built. Next: §4 A, then §1 steps 3–4 and §4 B.

1. **§1 steps 1–2**: unpriced is not free, one `available()`. Smallest change, and it closes
   a real billing hole (Requesty) before anything else.
2. ~~**§3**: failure kinds, the three modes, default timeouts. This is the one people feel on
   every rate-limited evening.~~ Done 2026-09-15 (D158).
3. ~~**§2**: ranking. Borrowed `weekly` and *routers last* first, because they are cheap. Strikes
   and size-from-id second.~~ Done 2026-09-15 (D159).
4. **§4 A**: Adapt's cancel. Small, on its own, and it stops work going on behind a refusal the
   person has already seen.
5. **§1 steps 3–4**: key events and key removal, which need the shell. *Needs a key* coming back
   the moment a key is saved depends on the event.
6. ~~**Alexia.md**: D112 rewritten with the three modes, and the decision log entry.~~ Done
   2026-09-15 (D154, D155).
7. **§4 B**: the model record and the tags, in core with their tests. Everything after reads
   `judge()`.
8. **§4 C**: the table, built against the mock-up.
9. **§4 D**: keeping it current (the timer, first seen, the news line, headers, OpenRouter's key,
   the four stale rows).
10. **§4 E**: test messages. Needs B and D.
11. **§4 G**: a switch said twice. Needs nothing above except A, so it can move earlier.
12. **§4 F**: free limits per account.
13. **§4 H**: crossing into paid, then Telegram's question.
14. **§4 I**: the bad-answer button, with *that wasn't her* (`plan-personality.md`, improvement 10).
15. **§4 J**: the hook for later sharing.

Everything here reaches the installed app only in a new build. The persona plugin there is
hand-patched, and a build does not reinstall it.

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
- [x] **How the table shows the ranking.** In Automatic's own order, in four groups, with a
  why-line per row taken from the ranking's keys (D161, against the mock-up).
- [x] **Busy and broken.** Busy sinks and comes back. A whole day of nothing but *too busy* (3
  tries over 2 hours, none answered) sets a model aside (D161), which changes D159's *never
  written off* for that one case.
- [x] **Set aside, never deleted.** Automatic skips it; a list skips it and says why; a pin still
  asks it; one good reply brings it back (D161).
- [x] **Evidence for models lower down.** A test message once a day, free only, at most 10, never
  the person's words (D161).
- [x] **Where a new model starts.** At the bottom. Its first good reply moves it to the middle of
  its size; OpenRouter's figure then places it, up or down (D161).
- [x] **Hallucination.** Only a person can tell: a *Bad answer* button, built after the table; two
  presses in 30 days tag a model (D161).
- [x] **How current.** Every 6 hours, and limits read from answers where providers send them
  (D161). Alexia.md said daily.
- [x] **The chat first, how.** Background uses providers with no daily limit and this Mac first,
  and at most half of a day-limited provider's day; Adapt counts as the chat (D161).
- [x] **The paid switch and the allowance.** One setting: turning the switch on asks for the daily
  amount (D161).
- [x] **Allow.** One press covers the conversation. A Telegram task asks on Telegram and gives up
  after 10 minutes (D161).
- [x] **The *slow local or paid* question.** Folded into the switch (D161).
- [x] **No free model can do it.** The same switch and pause, naming the reason (D161).
- [ ] **Model statistics to the owner's server.** Decided later (D160). The hook is §4 J.
- [ ] **Automatic test messages and each provider's terms.** Alexia.md's *respect each provider's
  terms*: check that a daily automated test is allowed on every free tier before a public release.
