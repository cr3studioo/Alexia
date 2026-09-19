# Personality — rebuild plan

> **What this doc is.** The plan for the second version of `plugins/persona`: what is fixed,
> what it should feel like, and the work in order. **Agreed 2026-09-15**, all ten improvements
> included, and recorded in [`Alexia.md`](./Alexia.md) as **D156** (G13) and **D157**; **D160**
> settled the budgets, the preview and the facts, and **D161** that Adapt counts as the chat for
> free requests. Tracked as **M8-7** in [`plan.md`](./plan.md). What is still open is at the end.
>
> **Depends on [`model_plan.md`](./model_plan.md).** Which model writes a personality and
> which model reads it are routing questions, and that plan is where they are fixed.
>
> Started 2026-09-15. Builds on M4-4 (D103, D105), M8-1 and G13.

---

## Where it stands (2026-09-15)

### The bug that started this: fixed

**Reported as** *the personality is not being sent; she answers as if none is set.* It was
being sent. What was sent was one sentence, to a random model.

- **Adapt saved half a document.** The 5,825-character description became a 221-character
  personality that stopped at `## How`. A reasoning model spent its 1,200-token budget
  thinking. Core never read `finish_reason`, told the plugin `endTurn` regardless, and
  `usable()` only wanted a heading.
- **The pin was `openrouter/free`**, which hands every request to a random free model. The
  last *who are you* was answered by a 2.6B model that ignored core's own *You are Alexia*.

| Fix | State |
|---|---|
| Core passes `finish_reason: 'length'` through as `stopReason: 'maxTokens'` | **Done**, tested in `provider.test.ts` and end to end in `asking.test.ts` |
| Adapt refuses a cut-off answer; 4,000-token budget; waits 110 s, not the SDK's 60 s | **Done**, `plugins/persona/index.js` |
| `usable()` requires all four sections with something under each | **Done**, `writing.js`, tested with the real cut-off shape |
| A trace line with the personality's length per step, so *was it sent?* is readable | **Done 2026-09-18 (D175)**, per *run* — and **per step since 2026-09-19 (D181)**: D175's reasoning was that a personality read once per task cannot differ between steps, and §2's three lengths are exactly that changing. Repeats collapse, so one length across fifteen steps still reads as one fact |
| Routers labelled on the Models screen | **Done** in `model_plan.md` §2 (D159): *a different free model each time*, ranked last |

### This machine

- **Re-adapted and checked live.** Nemotron 3 Super wrote *Alexia 2* in 23 s. In a new chat,
  *who are you* came back in character.
- **Models:** Automatic with the order Nemotron 3 Super → 3 Ultra → 3.5 Lightning.
  Lightning is a poor writer: it spent all 4,000 tokens and about 150 s thinking.
- **The installed plugin is hand-patched.** Only the plugin half of the fix is in
  `~/Library/Application Support/Alexia/extensions/persona/index.js`, since the worktree's SDK
  is newer than the app's. The original is beside it as
  `persona-index.js.before-2026-09-15-fix`. Updating persona from the Library replaces the
  patch; **deleting and reinstalling it deletes the saved personalities**. The core half needs
  a new app build.
- The broken *Alexia* row is still saved, not in use.

---

## What good looks like

- **She sounds like the description from the first message**, on whatever model answers, and
  it is visible which personality is in use.
- **Nothing fails silently.** A personality that did not save, a line she cannot act on, a
  model too weak to follow it: each one is a sentence on screen.
- **It costs what the reader needs.** A small model gets a short personality; the full one
  goes to a model that can hold it. The cost is shown, not discovered.
- **Nobody writes a system prompt.** Rough words in, a personality out, and changing it is a
  sentence (*more blunt*), not starting over.
- **The gate is never negotiable.** No personality, however it was written or imported, gets
  to argue with `rule()`.

---

## 1. The writer: which model adapts

**Today:** Adapt goes through Automatic, free only (D96), and its own request for a smart
model is ignored (M8-1). ***Was* today. All five sub-items below are built as of 2026-09-19
(D178); each says so in place.***

1. ~~**M8-1.** `intelligencePriority` sorts best-first; manifest `min_tier` becomes
   `Ask.minTier`.~~ **Done 2026-09-19 (D178).** Both, plus the honest half the item asked for and
   the schema would not allow: `speedPriority` and `hints` cannot be deleted from MCP's own field,
   so `wire-protocol.md` says they are read and not acted on, and why.
2. ~~**Never a router, and never a model Alexia doubts.** Adapt asks for one real model, even when
   the chat pin is a router.~~ **Done 2026-09-19 (D178)**, and *even when the chat pin is a router*
   contradicted `plan.md` M8-1's *a preference is not a way past a pin* in as many words. The owner
   was asked and chose the narrow reading: a pin on a **router** is not a pin on a model, so a
   capable request falls through to Automatic's own order; a pin on a real model still wins
   outright. The router half is a filter and the doubt half is not — a router is not a capable
   model on its best day, while a model with three failures behind it might be the only one awake
   at eleven at night, so the tags (*new · not tried yet*, set aside, *too many errors*, *gave bad
   answers*) are skipped while anything else fits and asked when nothing else can.
3. **Prefer a model that answers, not one that thinks forever.** `model_plan.md` §2's strikes
   are built (D159): `send()` records a timeout or a cut-off free answer, and the model sinks for
   about an hour, so one that ran out on Adapt is not first on the next press. What is left here
   is the plugin's side: when Adapt gives up at 110 s, core is not told (the sampling request
   drops its cancel signal), so `send()` goes on walking the plan behind a refusal already shown.
   Fixed as `model_plan.md` §4 A (D160).
4. **G13 is answered: yes** (D156), and **built 2026-09-19 (D178)**. A button somebody pressed is
   a run: a request a plugin makes while its own press is in flight carries a run id, so it may use
   a paid model under the paid switch, the day's amount and the monthly cap. Derived from core's
   `pressing` map rather than declared, so it is not a flag a plugin can set for itself and not one
   a call site can forget. That matters most for §2, because the small size is a distillation and
   weak models distil worst.
5. **Adapt counts as the chat, not as a plugin** (D161). Background requests keep off
   day-limited providers so the chat keeps its free requests (`model_plan.md` §4 F), and Adapt
   is exempt: somebody pressed it and is watching its progress bar, so it may use the OpenRouter
   key's free requests the way the chat does.

---

## 2. Three sizes

A personality is sent **on every step**, as the tail of the system prompt (`agent.ts:606`).
Roughly, 400 words is 500 tokens; a 15-step task spends 7–8k tokens re-sending it. On a paid
model that is money; on a free one it is context, rate limit, and half-followed instructions.

| Size | Budget (D160) | Keeps |
|---|---|---|
| **Small** | about 100 words | Name, register, what to call the user, at most three hard rules |
| **Medium** | about 300 words | All four headings, one or two lines each |
| **High** | about 600 words | The full document |

**Who gets which, by capability, not price** (the signals come from `model_plan.md` §2):

- **Small:** a size class under 7B, a context under 32k, **any router**, and anything whose size
  is unknown *and* that Alexia doubts: *new · not tried yet*, *too many errors* or *gave bad
  answers* in `model_plan.md` §4's record (D161), or a strike in the last hour. When in doubt,
  the weaker reader.
- **Medium:** free hosted models and local models of 7B and up.
- **High:** paid models.

**Chosen in core, per call.** The personality is read once per task, but the model is chosen
per step and can change on a fallback. So `persona.personality` returns
`{ small, medium, high }` in `structuredContent`, with `text` still the high one for an older
core. `system()` in `agent.ts` picks for **the weakest model in that step's plan**: a
fallback never hands a small model the high document.

**Written in one Adapt call**, high first and the two smaller ones derived from it, split on
fixed markers. Each size has its own length ceiling; an over-long small is rejected, not
trimmed, because trimming cuts the hard rules at the end. Storage adds `doc_small` and
`doc_medium` beside `doc`; old rows fall back to `doc` for every size, which is today's
behaviour.

**Acceptance.** A plan with a 2B local model and a paid model sends small. A paid model alone
gets high. An old one-document row still reaches every model.

**Built 2026-09-19 (D181).** *Where the build differs from the text above.*
- **`text` and `structuredContent`, as written** — and nothing in the plugin contract moved for
  it, because `structuredContent` is MCP's own field on a tool result. A core that knows nothing
  about sizes reads `text` and gives the long document to every model, which is what it did.
- **`sizedFor()` reports the size that was *sent*, not the size the model deserved.** A row with
  one document is judged `small` and still sends the long one; a trace saying *small* about six
  hundred words that went out would be the record lying in the one place it exists to tell the
  truth. This is the half the section did not have to think about because it assumed three
  documents always exist.
- **A shorter size that came back empty, over its ceiling, or emptied by the safety check is
  dropped on its own**, rather than failing the press. Dropping one costs a weak model a longer
  document; failing the press throws away a long one that was fine. The screen names which of the
  three survived.
- **`ROOM` 4,000 → 6,000.** One call now writes about a thousand words rather than six hundred,
  and three arriving cut off is D157's bug wearing different clothes.
- **Refine writes the three again; Edit clears the shorter two.** Edit is one document somebody
  typed, and the other two describe the version it replaced — keeping them would leave a weak
  model reading a personality two versions old with nothing on screen saying so.
- **The trace line went per step** (D175's own condition changed — see the order of work, step 6).

**Tests:** `packages/core/test/sizes.test.ts` (the rules), `packages/core/test/sized.test.ts`
(all four acceptances over `/api/chat`, reading the system prompt off what the provider was
actually sent), `plugins/persona/test/sizes.test.js` (the split, the ceilings, the briefs, the
columns, the cost).

---

## 3. Ten improvements

Ranked by what they do for the feel of it per unit of work. **S** is a day or less, **M**
a few days, **L** needs the shell and core.

### 1. Keep the words with the personality — S

**What.** Store the description that was adapted, which model wrote it and when, on the row
itself. Add **Re-adapt** as a row action, and keep the previous version on every change, with
*Undo*.

**Why.** Today the words live only in the settings box and the next description overwrites
them. The user's 5,825 characters could not be re-run on a better model without pasting them
again. Every improvement below that changes a personality needs this first.

### 2. Refine, instead of starting over — M

**What.** A box on the row: *more blunt*, *stop saying "man to man"*. One call with the
current document and that sentence; the change is shown line by line before it saves. Plus
**Edit** for changing the text by hand (the SDK's `multiline` text setting).

**Built 2026-09-19 (D179).** *Where it differs from the text above.* **The box is on the page,
not on the row** — there is no per-row input in the widget set, and there cannot be a modal
either: core does not offer `elicitation`, and a plugin may write only its own `status`
settings, so it cannot prefill a box for somebody. Type the change, press Refine on the row it
is about; for **Edit**, open the row (which already shows exactly what she is being told), copy,
change, press Edit. The hints say so. **The diff is shown after the save, not before it**, with
the previous version kept and Undo as the way back — same reason as D180's, that this plugin is
`lazy` and a draft held between two presses is sometimes gone by the time somebody decides.
`diff.js` is an exact longest-common-subsequence over lines with no dependency; it shows only
what changed, a line either side, and says *nothing changed* when a small model hands back what
it was given. Both buttons go through Adapt's own `write()`, so D157's clamps cover them.
**Tests:** `plugins/persona/test/refining.test.js`, and the shell fix (`.said-lines`) is what
makes a column of `-` and `+` lines legible at all — a tool's answer had been drawn with its
newlines collapsed since the widget existed.

**Why.** Feel: a personality gets tuned the way a person talks. Efficiency: the call is a
500-token document and a sentence, not a 1,300-token description, so it is faster and far less
likely to run a reasoning model out of room.

### 3. Hear her before she goes live — M

**What.** After Adapt or Refine, two sample answers in the new voice before saving: *who are
you?*, and one prompt built from her own *What you do without being asked* section. Answered
by the model Automatic would use for chat. Buttons: **Use**, **Refine**, **Discard**, and
**Skip** from the very first time (D160) — the automatic checks, such as refusing a cut-off
personality, run whether or not the samples are heard.

**Why.** Adapt currently saves and switches in one press, so the first time anybody hears the
new personality is in a real conversation. The preview also catches the case this plan
started with: a model too small to follow it at all.

**Built 2026-09-19 (D180).** *Where it differs from the text above.* **Saved, not in use** —
the samples come after the save rather than before it (the owner chose this from three options;
the plugin is `lazy` and an unsaved draft does not reliably survive between two presses), and
**Use** is the press that changes anything. **The Skip is a toggle**, *Hear her before
switching*, on by default: the samples are two model calls, so the honest place to decline them
is before they are made rather than after. **Refine does not run them** — it already returns a
document and a diff, and two more calls on every tuning press is what stops people tuning — so
**Hear her** is a row action available at any time, on any row. **Refine as a button in the
preview** is unnecessary for the same reason: the row it would refine is right there. The
second question is a plain empty moment with the behaviour line quoted beside it, never a scene
a model invented: that is a third call and puts made-up facts about this person's life on
screen, which every brief in this plugin forbids. It is answered with no `modelPreferences`, so
it is the model the chat would use — and the screen says core's own opening lines are not in it,
because a plugin cannot see them. **Tests:** `plugins/persona/test/refining.test.js`.

### 4. Flag the lines she cannot act on — M

**What.** On save, check each line of *What you do without being asked* against what is
installed and enabled, and say so under the row: *"Send Telegram reminders": Telegram is not
enabled.* / *"Store workflows in Obsidian": nothing installed can do this.*

**Why.** This is D103's lesson a second time. A behaviour line with nothing behind it is inert,
and the person reads it as *she ignores me*. The personality on this machine has both examples.
**How:** the plugin cannot see other plugins by design, so this needs a read-only
`alexia/answers` call returning whether a capability is promised, the same check core already
has in `plugins.answers()`. It names nobody.

**Built 2026-09-19 (D182).** *Where it differs from the text above.* **The two examples above
cannot be caught, and the build says so rather than pretending.** Core can be asked about
capability names, and no capability names *Telegram reminders* or *Obsidian* — so a line whose
words match nothing in the register is **left alone**, and the note reports how many lines were
*looked at* as well as which failed, because a check that reports only failures reads as a
guarantee about everything it did not mention. The owner was shown a broader alternative (a
list of what Alexia can do right now, off the enabled tool list) and chose this one with that
trade stated. `alexia/answers` also returns **`here`** — something that would answer is
installed and switched off — because core already draws that line for itself in
`couldAnswer()`, it costs no name, and *a switch two inches away* and *a search through a
library* are different afternoons. `ALEXIA_PROTOCOL_MAX` 9 → 10; no manifest field moved, so
the schema is untouched. Matching is deterministic and whole-word, run on save and again when a
row is opened — what is installed changes, and a finding saved in September is a finding about
September. It **flags and never removes**. **Tests:** `packages/core/test/answers.test.ts`,
`plugins/persona/test/promises.test.js`.

### 5. Facts to memory, behaviour in the personality — M

**What.** When the Memory plugin is enabled, Adapt splits what it reads. Facts about the
person (their name, their goals, their deadlines) are offered to `memory.remember` with one
confirm for all of them (D160). Proposed, not yet confirmed: one list with every fact ticked, so a
wrong one can be unticked and the rest still saved with one press. How to behave stays in the personality. Without Memory, nothing changes.

**Why.** Efficiency: facts in the personality are re-sent on every step whether they matter
or not, and Memory recalls them only when they do. It also stops two places from disagreeing
about the person's name.

**Built 2026-09-19 (D183).** *Where it differs from the text above.* **The tick-list stayed
proposed.** D160 settled *one confirm for all of them* and proposed a list with every fact
ticked; that shape cannot be drawn here — a plugin may write only its own `status` settings and
core offers no `elicitation`, so there is no way to put a dynamic list into a control for
somebody. The facts are listed under the save and on the row, and one button saves all of them,
which is the settled decision in the only shape available. **They come out of the same Adapt
call**, after a fourth marker, rather than out of a second one, and are asked for only when
`alexia/answers` says something will remember them — so a machine with no memory plugin gets
the brief it always had. The press clears the offer, so it cannot be taken up twice.
**Tests:** `plugins/persona/test/elsewhere.test.js`.

### 6. A safety check in code, not only in the prompt — S

**What.** A deterministic check on save, refine and import. It flags and removes lines that
tell her to skip asking, hide what she did, ignore a limit or claim to be human, with a note
saying what was removed and why.

**Why.** Today the writer is only *told* not to write those lines. `rule()` still enforces
the gate, so this is not the protection. What it prevents is a personality arguing with the
gate on every step: wasted tokens, and refusals that read as her being difficult.

### 7. Show what it costs — S

**What.** On each row, tokens per step for each size and roughly per 15-step task. At Adapt
time, a line if the high size is over budget.

**Why.** It makes §2 visible and gives people a reason to prefer a shorter personality, without
anyone having to explain context windows. An estimate labelled as one (characters ÷ 4) is enough.

### 8. Switch from the chat — S for the command, M for the chip

**What.** Manifest `commands`: `/persona` lists the saved ones, `/persona <name>` switches,
`/plainly` turns it off. Then a small chip in the chat header with the name in use.

**Why.** Switching today takes the settings screen, a table and a row action. The commands
work on Telegram too, since slash commands already reach plugins from there.

### 9. A personality per place — M

**What.** A saved personality can be bound to a channel: *use on Telegram*. Core passes
`{ channel }` when it asks for `persona.personality`, and `asTask` in `serve.ts` already knows
which plugin started the task. The default is the same one everywhere.

**Why.** A reply read on a phone wants to be shorter and plainer than one at the desk. The
argument is optional, so an older persona plugin simply ignores it.

**Built 2026-09-19 (D183).** *Where it differs from the text above.* **The window sends no
channel at all**, rather than a word meaning *the window*: there is nothing to bind a
personality to there, and an absent argument is what makes this optional at both ends and keeps
the contract's number where it is. The channel core sends is the id of the plugin that started
the task — the one thing core knows about where an answer will be read — and what it means is
entirely the answering plugin's business; here it means the word somebody typed into the box.
**A bound row is not a second kind of *in use***: the row in use answers everywhere nothing else
claims, a bound row answers in its own place and nowhere else, and neither action touches the
other flag. Two rows claiming one place is a coin toss nobody could see, so binding one unbinds
the other. The table's *In use* column shows *on telegram*, or the binding would be a setting
nobody can see. **Tests:** `plugins/persona/test/elsewhere.test.js`, and the core half in
`packages/core/test/sized.test.ts`.

### 10. "That wasn't her" — L

**What.** An action on any answer: mark it as out of character, with one optional line on what
she should have said. The last few become examples that **Refine** uses as evidence.

**Why.** It turns *something is off* into a concrete fix without the person having to find
words for a system prompt. It needs a message action in the shell, which is the larger part.
`model_plan.md` §4 I adds *Bad answer* in the same place (D161): that one is about the model,
this one about the personality, and they are built as one row of message actions.

**Also worth doing, later:** starter *descriptions* (not documents: D105 showed a model copies
a worked example); export and import a personality as a `.md` file, through the §6 check; and
for paid models, an order that lets provider prompt caching reuse the personality between steps.

---

## Order of work

*Brought up to date 2026-09-15 for D160 and D161.*

0. **On this machine, whenever the owner likes:** delete the broken *Alexia* row from the app's
   own Personality screen (D160). Never from the database, and never by removing or reinstalling
   the plugin, which would delete every saved personality.
1. ~~**`model_plan.md` §1 steps 1–2 and §3.** Unpriced is not free, one `available()`, and
   fallback that works.~~ Done (D154, D158); §2's ranking and strikes too (D159). All three reach
   the installed app only in a new build.
2. ~~**`model_plan.md` §4 A: Adapt's cancel reaches `send()`** (D160). Before anything that makes
   Adapt call more, since today a refusal on screen leaves core still asking.~~ Done 2026-09-16
   (D162), and §4 B's `judge()` exists for step 5 to read. Both reach the app only in a new build.
3. ~~**The trace line** from *Where it stands*.~~ Done 2026-09-18 (D175), per run rather than per
   step, and counted the way `system()` counts it so it is the length that reached the model. A
   run never told about a personality says nothing at all, rather than *none sent*.
4. ~~**Quick wins:** improvements 1, 6, 7, and the `/persona` command from 8.~~ Done 2026-09-18.
   **4a**, improvement 1: the description, the model that wrote it and when are kept on the
   personality's row, with **Re-adapt** and **Undo**; Adapt and Re-adapt go through one `write()`,
   so D157's room, patience and half-a-personality guard apply to both. **4b**, improvement 6: a
   deterministic check on save and on re-adapt removes lines telling her to skip asking, hide what
   she did, ignore a limit or claim to be human, and says what it removed and why. **4c**,
   improvement 7 (D176): what it costs, as a labelled estimate against today's single document —
   the owner chose that over waiting for §2's three sizes, and `costOf()` takes one document so
   step 6 calls it three times rather than rewriting it. **4d**, the `/persona` command: `/persona`
   lists, `/persona <name>` switches, `/plainly` stops. The `<name>` half was not the plugin's to
   fix — core kept only the first word of a command — and needed **D177**, which hands whatever
   follows a command to the plugin whole under `rest`. The header chip from improvement 8 is *not*
   here: it waits for step 8.
5. ~~**§1, the writer:** M8-1; never a router, and never a model `model_plan.md` §4 B tags as new,
   set aside or doubted (so after §4 B); then G13's build (D156), a run id on Adapt, which also
   makes it the chat for free requests (D161, `model_plan.md` §4 F).~~ Done 2026-09-19 (**D178**),
   all three sub-items in one change because the first is decorative without the third: best-first
   among free models is all a plugin could ever have got while `send()` read *attributed to a
   plugin, belonging to no run* as free-tiers-only. `intelligencePriority` (largest of the three
   and at least a half) becomes `Ask.capable`, which is best-first **and** the two filters; the
   router half is a filter rather than an order, and the doubt half is D161's *skipped while
   anything else fits*. A pin still wins outright **except a pin on a router**, which the owner
   was asked about because this plan and `plan.md`'s M8-1 said opposite things — and it is the
   pin that caused the bug at the top of this document. A press carries a run id, derived from
   core's `pressing` map rather than declared, so Adapt may reach a paid model under the paid
   switch, the day's amount and the monthly cap. `min_tier: "T1"` on this plugin is now read,
   which also means **Adapt never uses a model on this machine**.
6. ~~**§2, three sizes**, at about 100, 300 and 600 words (D160), with *small* also for a model §4 B
   doubts.~~ Done 2026-09-19 (**D181**). Small also for **any router** and for a window under 32k,
   which the section names and this line did not; and the size is picked for the **weakest rung in
   a step's plan** rather than for the model asked first, because a 429 hands the step to the next
   one with the document already attached. The trace line moves from per run to per step with it —
   D175's reasoning was that a personality read once per task cannot differ between steps, and the
   three lengths are exactly that changing.
7. ~~**Improvements 2, 3, 4, 5, 9.** The preview (3) shows with **Skip** from the first time;
   facts (5) go to Memory with one yes for all (D160).~~ **All five done 2026-09-19** — 2 and 3
   (D179, D180), 4 (D182), 5 and 9 (D183). Improvement 2 was built first, on the owner's
   choice, so the preview's button row ships complete rather than with a Refine that does
   nothing. The Skip is a toggle — *Hear her before switching*, on by default — rather than a
   fourth button, because the samples are two model calls and the honest place to decline them
   is before they are made.
8. **Improvement 10** with `model_plan.md` §4 I's *Bad answer*, as one row of message actions,
   and the header chip from 8.

## Open decisions

- [x] **G13.** May Adapt, a button somebody pressed, use a paid model? **Yes** (D156).
- [x] **All ten improvements.** **Approved** (D157).
- [x] **The budgets.** **About 100 / 300 / 600 words** (D160).
- [x] **The high size for paid models.** **About 600 words** (D160). The words it was written
  from are kept (improvement 1), so a long description is not lost by being distilled.
- [x] **The preview (3).** **Shown, with a Skip button from the first time** (D160).
- [x] **Facts to memory (5).** **One confirm for all of them** (D160).
- [x] **The old broken row on this machine.** **Delete it** (D160) — from the app's own
  Personality screen, never from the database, and never by removing the plugin.
- [x] **Adapt and the free requests kept for the chat.** **Adapt counts as the chat** (D161),
  which keeps D156; D160 had listed it among the plugins.
