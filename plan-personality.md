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
| A trace line with the personality's length per step, so *was it sent?* is readable | **Done 2026-09-18 (D175)** — recorded per *run*, not per step: `AgentOptions.personality` is read once per task, so a per-step number would repeat itself and imply it could have differed |
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

### 5. Facts to memory, behaviour in the personality — M

**What.** When the Memory plugin is enabled, Adapt splits what it reads. Facts about the
person (their name, their goals, their deadlines) are offered to `memory.remember` with one
confirm for all of them (D160). Proposed, not yet confirmed: one list with every fact ticked, so a
wrong one can be unticked and the rest still saved with one press. How to behave stays in the personality. Without Memory, nothing changes.

**Why.** Efficiency: facts in the personality are re-sent on every step whether they matter
or not, and Memory recalls them only when they do. It also stops two places from disagreeing
about the person's name.

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
6. **§2, three sizes**, at about 100, 300 and 600 words (D160), with *small* also for a model §4 B
   doubts.
7. **Improvements 2, 3, 4, 5, 9.** ~~The preview (3) shows with **Skip** from the first time~~;
   facts (5) go to Memory with one yes for all (D160). **2 and 3 done 2026-09-19 (D179, D180);
   4, 5 and 9 are what is left of this step.** Improvement 2 was built first, on the owner's
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
