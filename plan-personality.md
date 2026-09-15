# Personality — rebuild plan

> **What this doc is.** The plan for the second version of `plugins/persona`: what is fixed,
> what it should feel like, and the work in order. **Agreed 2026-09-15**, all ten improvements
> included, and recorded in [`Alexia.md`](./Alexia.md) as **D156** (G13) and **D157**. Tracked
> as **M8-7** in [`plan.md`](./plan.md). What is still open is at the end.
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
| A trace line with the personality's length per step, so *was it sent?* is readable | Not started |
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
model is ignored (M8-1).

1. **M8-1.** `intelligencePriority` sorts best-first; manifest `min_tier` becomes
   `Ask.minTier`.
2. **Never a router.** Adapt asks for one real model, even when the chat pin is a router.
   `model_plan.md` §2 gives the router a recognisable label (`routes()` in `catalog.ts`, D159),
   so this is one filter.
3. **Prefer a model that answers, not one that thinks forever.** `model_plan.md` §2's strikes
   are built (D159): `send()` records a timeout or a cut-off free answer, and the model sinks for
   about an hour, so one that ran out on Adapt is not first on the next press. What is left here
   is the plugin's side: when Adapt gives up at 110 s, core is not told (the sampling request
   drops its cancel signal), so `send()` goes on walking the plan behind a refusal already shown.
4. **G13 is answered: yes** (D156). A button somebody pressed is a run: Adapt carries a run
   id, so it may use a paid model under the monthly cap and the spend preview. That matters
   most for §2, because the small size is a distillation and weak models distil worst.

---

## 2. Three sizes

A personality is sent **on every step**, as the tail of the system prompt (`agent.ts:606`).
Roughly, 400 words is 500 tokens; a 15-step task spends 7–8k tokens re-sending it. On a paid
model that is money; on a free one it is context, rate limit, and half-followed instructions.

| Size | Rough budget | Keeps |
|---|---|---|
| **Small** | 60–80 tokens | Name, register, what to call the user, at most three hard rules |
| **Medium** | ~200 tokens | All four headings, one or two lines each |
| **High** | ~500 tokens | The full document |

**Who gets which, by capability, not price** (the signals come from `model_plan.md` §2):

- **Small:** a size class under 7B, a context under 32k, **any router**, and anything whose size
  is unknown *and* that has a strike. When in doubt, the weaker reader.
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

**Why.** Feel: a personality gets tuned the way a person talks. Efficiency: the call is a
500-token document and a sentence, not a 1,300-token description, so it is faster and far less
likely to run a reasoning model out of room.

### 3. Hear her before she goes live — M

**What.** After Adapt or Refine, two sample answers in the new voice before saving: *who are
you?*, and one prompt built from her own *What you do without being asked* section. Answered
by the model Automatic would use for chat. Buttons: **Use**, **Refine**, **Discard**.

**Why.** Adapt currently saves and switches in one press, so the first time anybody hears the
new personality is in a real conversation. The preview also catches the case this plan
started with: a model too small to follow it at all.

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
confirm. How to behave stays in the personality. Without Memory, nothing changes.

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

**Also worth doing, later:** starter *descriptions* (not documents: D105 showed a model copies
a worked example); export and import a personality as a `.md` file, through the §6 check; and
for paid models, an order that lets provider prompt caching reuse the personality between steps.

---

## Order of work

1. **`model_plan.md` §1 steps 1–2 and §3.** Unpriced is not free, one `available()`, and
   fallback that works. Every personality problem here got worse because of routing.
2. **The trace line** from *Where it stands*.
3. **Quick wins:** improvements 1, 6, 7, and the `/persona` command from 8.
4. **§1, the writer:** M8-1, never a router, strikes. Then G13.
5. **§2, three sizes.**
6. **Improvements 2, 3, 4, 5, 9.**
7. **Improvement 10**, and the header chip from 8.

## Open decisions

- [x] **G13.** May Adapt, a button somebody pressed, use a paid model? **Yes** (D156).
- [x] **All ten improvements.** **Approved** (D157).
- [ ] **The budgets.** 60–80 / ~200 / ~500 tokens?
- [ ] **The high size for paid models.** Still capped at 400 words, when the first real
  description was 5,825 characters?
- [ ] **The preview (3).** Always shown, or skippable once somebody has seen a few?
- [ ] **Facts to memory (5).** One confirm for the batch, or each fact separately?
- [ ] **The old broken row on this machine.** Forget it, or keep it until improvement 1 can
  show what it was?
