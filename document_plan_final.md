# document_plan_final.md

**The build half of [`document_plan.md`](./document_plan.md) — what was decided, what was
built, and what was deliberately left alone.**

*Written 2026-08-31, the same day as the capture it implements. This is the `plan` half of the
pair, in the shape [`models_plan_final.md`](./models_plan_final.md) established;
[`document_plan.md`](./document_plan.md) is the `facts` half. Neither replaces the other.*

---

## 0. What this file is, and how to use it

[`document_plan.md`](./document_plan.md) is an information capture. It says so itself in §0:
*"It does not schedule anything. It does not authorise anything."*

**This file records the schedule and the authorisation, and then the outcome.** It contains no
new facts about the world. Every fact lives in `document_plan.md` and is cited by section. What
is here is: the rulings on §8's eleven open questions, what was written, what was refused, and
how each was checked.

> **Precedence.** Where this file and `document_plan.md` disagree on a fact — a licence, a
> benchmark, a file path, a line number — **`document_plan.md` wins, always.** This file is
> allowed to be wrong about facts; it is not allowed to overrule them.

**Read order.** §2 is the eleven rulings and is the part worth reading twice — it is where the
questions that needed a human got answered, and each one says on what argument. §4 is what was
**not** built, which is the half a reader will otherwise assume was forgotten.

---

## 1. Scope fence

### 1.1 In scope, and built

Exactly the two halves `document_plan.md` §7 divides the feature into, plus the screen-reading
finding §5.6 opened:

1. **Uploading**, which is core's — the composer, the bytes, how a file appears in a message.
2. **Reading**, which is a plugin's — one capability name, a tier-0 provider in the box.
3. **The router learning `modality`** (§5.2), which §8 Q5 asks for now rather than later.
4. **`plugins/computer` getting the accessibility tree** (§5.6, §6.6) — the reader it was
   missing, the `expect` step `replay.js` had no way to hold, and a way to press a control
   that does not contend for the cursor (§5.7).

### 1.2 Out of scope — and each one has a reason, not an omission

| Left alone | Why, in one line |
|---|---|
| **`plan.md`** — no `D`-numbers added, nothing renumbered | The same fence `models_plan_final.md` §1.2 drew, for the same reason: this work is deliberately outside it. `document_plan.md` §0 says a D-number is where this belongs; **assigning one is a human's call and is the one thing here that still needs doing.** |
| **`document_plan.md`** | It is the source of truth and a historical record. Read-only. |
| **`Alexia.md`** | Cited, never changed. |
| Native image input on the wire (§5.1, Q4) | See §4.1. |
| `document.describe`, or any OCR tier (§6.2, §6.3) | See §4.2. |
| CLI-Anything, the shelf, provenance (§6.7, §7.1, Q10, Q11) | See §4.3. |
| Swapping the system cursor while a plan runs (Q7) | See §4.4. |
| Committing, pushing, branching, opening a PR | The user drives git. |

---

## 2. The eleven questions, answered

Each ruling says **what was decided**, **on what argument**, and **where it now lives**.

### Q1 — Does the upload live in the composer, the manifest, or both?

> **The composer. Not the manifest, and the difference is not a technicality.**

§5.3 records that `file` was put to the widget bar three times and refused three times, the
last refusal ending *"that argument is waiting on a real user."* Document upload is that user.
What it produced is a control on **core's own surface**, which is a different grant from a
`file` widget any plugin may declare: one is a control on one screen that core draws and core
owns; the other widens what every plugin can ask for, on a bar that has not moved.

The path obstacle D89 recorded is also why the composer route works at all. *A browser will not
tell a page where a file is* is true — and drag-and-drop and paste hand the webview **bytes**,
with no path anywhere in it.

*Lives in:* `packages/ui/index.html`, `packages/ui/src/main.ts`, `packages/ui/app.css`, and the
ruling is written into [`docs/spec/ui-schema.md`](./docs/spec/ui-schema.md) beside the three
refusals, so the next person to ask finds the answer where they will look for it.

### Q2 — What goes in the message when the document is bigger than the context window?

> **Send it whole, cut at a stated budget, and let the wall that already exists refuse.** No
> chunking, no embedding index, no summarise-then-drill.

§5.5 offers three answers and calls this the one that constrains the others. The one taken is
the only one that adds no mechanism:

- The extractor cuts at a budget (a setting, defaulting to 160,000 characters ≈ forty thousand
  tokens) and **says so in the extracted text itself** — *this is the first N characters of M*.
  A field nobody renders would be a quieter version of the same lie.
- Past that, `route()` already refuses on context: `fits()` has filtered models by window since
  M11, and its refusal sentence — *this conversation is longer than any model available to you
  can read* — is already written for a person.

The second option, chunk-and-rank, is the embedding index `plugins/memory/search.js`
deliberately refused, and taking it here would mean owning a vector store to answer a question
nobody has asked yet. The third is a model call per document, which is a second thing that can
be wrong and a cost on every upload.

**The cut is also what keeps the *conversation* usable**, which is the part that surprises
people: a document outlives the question asked about it, so an uncut 200-page PDF does not fail
once — it makes every later turn in that conversation refuse.

*Lives in:* `plugins/documents/read.js` (`DEFAULT_LIMIT`, `cut`), and the existing filter in
`packages/core/src/router.ts`.

### Q3 — Is a document a bigger redaction surface than the policy was written for?

> **Yes, and the policy does not change. What changes is that the extracted text can be looked
> at.**

§5.4 is a fact and it is not an objection: an uploaded document is orders of magnitude more
exposure than a chat turn, in volume, in intent, and in **invisibility**. The policy in
`redact.ts` is the owner's, is quoted verbatim there precisely so a later session cannot
quietly broaden it, and this is not the place to broaden it. Both of the alternatives on the
table cost more than they buy: placement-pinning an upload to local would refuse on the free
rung that is the whole point of D51, and a redaction pass tuned for documents is a second
policy that can disagree with the first.

Two things follow, and both are cheap:

1. **The extracted text is a message**, so `redact.ts` sees it on the way out with no new call
   site — a rule enforced by whoever remembers is not enforced, and there is nothing to
   remember here.
2. **The third exposure, invisibility, is the one that was actually fixable**, and it was
   fixed. What was read comes back to the screen as well as going to the model, folded away
   under the turn that carried it. In a typed turn the user wrote the words and knows what is
   in them; in an attached payslip they did not, and until this there was nothing anywhere that
   would have shown them.

*Lives in:* `packages/core/src/attach.ts` (the finding, written next to the code), the
`attached` event in `packages/core/src/serve.ts`, and `showRead` in `packages/ui/src/main.ts`.

### Q4 — Does native vision get built, and when?

> **Not now.** See §4.1 for the whole of the argument.

### Q5 — Does `route()` learn about `modality` now or with the feature?

> **Now.**

§5.2 found that the catalog has collected `modality` since it existed and the router has never
read it — it was printed under a model row and that was its entire use. Today that is latent,
because nothing can put a picture in a `Message`. It stops being latent the moment anything
can, and the alternative to the filter is a 400 from somebody else's server arriving at step
nine with no explanation attached.

It is the same change, in the same function, on the same argument D112 made for the spend pin:
*a rule nobody can see is a rule nobody can disagree with*. **It has no caller yet, and the
comment on it says so** rather than leaving a reader to wonder what sets it.

*Lives in:* `Ask.modality`, one filter in `fitting()`, and a refusal that names the wall in
`refusal()` — all in `packages/core/src/router.ts`, with two tests.

### Q6 — Tier 0 in the box, or a Docling plugin from the start?

> **Tier 0 in the box, and the refusal sentence carries the weight.**

§6.1's argument is cold install and §6.5 prices the alternative: D117's ComfyUI integration
took six minutes to come up, needed the one Python on the machine that had PyTorch in it, and
**had never once succeeded** before somebody ran it by hand. That is the price of tier 2, and
it is not the price to pay for the *first* extractor.

The condition §8 attaches to this ruling is the one that was actually hard: *"an extractor that
cannot read a scan will be reported as broken by the first person who uploads one, and the
refusal sentence has to be good enough that it reads as a limit rather than a failure."* So the
refusals are written as sentences that say **which wall this is and what would get past it** —
a picture is refused before it is opened, naming both of the jobs it is not doing; a PDF with
no text layer is refused after, saying it is a photograph of a document and that reading one
needs OCR.

**And it is a drop-in, structurally.** A tier-2 extractor is a second plugin offering
`document.extract`; core resolves by capability and cannot tell the difference.

*Lives in:* `plugins/documents/`, and the registry row in
[`docs/spec/capabilities.md`](./docs/spec/capabilities.md).

### Q7 — What tells a person that Alexia is driving the mouse right now?

> **The live trace, a frame per step, in the conversation they are already looking at — plus
> the plugin's own state line. Not the system cursor.** See §4.4 for why not.

§5.7 is right that the absence was load-bearing: the plugin's stated safety model is *turn this
on only while you are watching*, and it gave a watcher nothing to watch. A replay is the case
that needs it most, because the permission gate asks **once** for a sequence that then presses
sixty things.

What it uses is the channel that already exists for exactly this — MCP progress, which core
already streams to the live panel a frame at a time, on the rule that the screen is never more
than a moment behind what the tool is doing. Nothing new on the wire, nothing to miss, and no
window of its own that can be orphaned.

*Lives in:* the `onStep` handler in `plugins/computer/index.js`, restored in a `finally` —
a state that says *driving* after it has stopped is worse than no state at all.

### Q8 — Who reads the screen for the `expect` step, and does `replay.js` get one?

> **Yes, and the reader is UI Automation.**

§5.6's finding is that `STEPS` was `click, move, type, key, focus, wait` — **six ways to act and
no way to check** — so a plan could do the wrong thing sixty times and report sixty successes.
*It did it ten times* was something a model asserted rather than something the plugin counted.

The reader is the accessibility tree and not OCR, on §6.6's argument: a document parser answers
*what does this say*, and a postcondition asks *is the Save button there, and does the display
say 42*. Only one of those has an exact answer. §6.6's own example is the point — the calculator
display is a UIA element and its value comes back as text — and the general form is that **if a
person can select the text, an element holds it**.

**The invariant Q8 warns about is intact.** `replay.js` imports `./windows.js` and nothing else;
the reader lives in `windows.js`; the test that reads the imports still passes. What was added
beside it is a second split of the same kind: the *judgement* about a postcondition is a pure
function in `replay.js`, apart from the reading that produced it, so it can be tested on a
machine with no desktop in it. A postcondition whose only test needed the right window open on
Windows would be the one rule nobody ever ran.

*Lives in:* `elements`, `readElement` and `invoke` in `plugins/computer/windows.js`; the
`expect` and `press` steps and their two pure judges in `plugins/computer/replay.js`; the
`elements`, `read`, `check` and `press` tools in `plugins/computer/index.js`.

### Q9 — Does Alexia ever get a desktop of her own?

> **No second cursor, and the near-term answer is §6.6 rather than isolation — which is now
> built.**

§5.7 closes the second-mouse question structurally: Windows was built single-pointer, the
window-message system has no field saying which mouse generated an event, and no arrangement of
software gives a second cursor to *other programs*. What replaces it is not a second mouse. A
UI Automation pattern acts on a control **directly** — nothing moves, nothing is typed, nothing
contends for the cursor — so an agent that invokes buttons rather than clicking pixels makes
most of the need dissolve rather than solving it.

That is the `press` tool and the `press` step. The fallback order is Microsoft's own, from
`winappCli`: `Invoke`, `Toggle`, `SelectionItem`, `ExpandCollapse` — and where none of them
exists **it stops and says so** rather than reaching for the mouse. A real click is a different
permission and a different line in the log, and a rung that silently escalated would be the one
thing this must not do.

Session isolation stays what §5.7 says it is: the right thing to watch and the wrong thing to
depend on.

### Q10 — What `why` does a generated CLI ask the user to agree to?

> **Unanswered, and nothing was built that would need it.** See §4.3.

### Q11 — What does the panel show when it does not know where something came from?

> **Unanswered, and there is no panel yet.** See §4.3.

---

## 3. What was built

### 3.1 Core — the upload half

| File | What it is |
|---|---|
| `packages/core/src/attach.ts` | **New.** The seam: bytes in, files on disk for the length of one capability call, the composed message, and the line under the composer. Base64 in a JSON body, per `plan.md:2565` — `node:http` has no multipart parser. |
| `packages/core/src/serve.ts` | `/api/chat` takes `files`; `documents()` reads them by capability and `extracted()` calls it. **`text` stays what the person typed** and only the message content grows — the permission gate, the boundary sentences and the offer to learn all read `text`, and every one of them would be wrong to read a document. |
| `packages/protocol/src/capabilities.ts` | `CORE_CAPABILITIES.extract`. It is here rather than in core because a capability name in `packages/core/src` would be indistinguishable from core naming a plugin. |
| `docs/spec/capabilities.md` | The service-registry row, by pull request as that file requires, plus why it is deliberately not two names yet. |
| `docs/spec/ui-schema.md` | Q1's ruling, recorded beside the three refusals it settles. |

**The bytes do not stay.** A file is written, read and deleted in the same breath: it has to
exist on disk for one call because the capability takes a path the way `voice.transcribe` does,
and a folder of everybody's payslips accumulating beside the database is a second place their
documents live, for nothing.

### 3.2 Core — the router

`Ask.modality`, one filter, one refusal sentence. See Q5.

### 3.3 The shell

Three ways in, because people use all three: **drop it on the conversation, paste it, or press
Attach**. None of them involves a path. A list of what is coming sits above the composer with
the one control that matters on each row — take it off again — and what was read comes back
folded under the turn that carried it.

### 3.4 `plugins/documents` — the reader

Zero dependencies beyond the SDK. No Python, no model, no network, no child process, and
**one permission** (`fs.read_scoped`, *to open the document you attached*).

| File | What it reads |
|---|---|
| `text.js` | Encodings, entities, HTML, CSV/TSV/semicolon exports, and the markdown table everything ends up as |
| `zip.js` | The container all seven office formats are — central directory and `inflateRaw`, ninety lines against a format unchanged since 1993 |
| `office.js` | `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub` |
| `pdf.js` | The PDF **text layer**: objects found by scanning rather than by trusting the cross-reference table, object streams unpacked, `ToUnicode` CMaps, published glyph widths, and line and word breaks taken from the text matrix |
| `kinds.js` | What a file is — and, for everything it will not read, the sentence saying which of the two missing jobs it would need |
| `read.js` | The dispatch and the budget, kept apart from the plugin so the work can be tested without a wire |

**`pdfjs-dist` was measured and refused**, and the measurement is the reason rather than taste.
It reads a real PDF correctly and it is 35 MB that **does not survive being bundled**:
`scripts/publish.mjs` bundles a plugin to one file, and pdf.js reaches for its worker by path at
run time — so the published plugin fails on the first PDF while the checkout works perfectly.
That is D117's lesson arriving before rather than after.

### 3.5 `plugins/computer` — the reader it was missing

`0.1.0 → 0.2.0`. Four new tools (`elements`, `read`, `check`, `press`), two new plan steps
(`expect`, `press`), and the two tool descriptions that had been promising something the tool
surface could not do — *use after taking a screenshot and working out where the thing you want
actually is* — now point at the tool that can actually answer it.

**No twelfth permission.** Reading the control tree *is* seeing the screen, which is what
`screen.capture` already grants and what its sentence already says. `UIAutomationClient` and
`UIAutomationTypes` are .NET assemblies on every Windows machine, reached through the PowerShell
spawn `windows.js` already makes — which is that file's own stated design rule, one assembly
over.

`press` is gated by the input toggle even though no pointer moves: *look but not touch* is about
the touching, not about the road it took. The setting's label and hint were widened to say so.

---

## 4. What was not built, and why

### 4.1 Native image input on the wire (Q4)

`Message.content` is still a `string`. Extraction was proposed as the workaround for models that
cannot read a document and is in fact the **only** path that exists, for every model — which
§5.1 calls a good position rather than a bad one, and it is: it makes vision a separate feature
that can be decided later without blocking anything.

§8's revision of Q4 is the reason it stayed out: the first draft assumed `plugins/computer` was
the thing waiting on vision, and it is not. §6.6 says computer control wants the accessibility
tree — cheaper, faster, exact, and it returns coordinates a picture does not — so vision is not
on the critical path for the plugin that looked like it needed it most.

### 4.2 `document.describe`, and every OCR tier

**`document.describe` would have been a name with nothing behind it.** It is defined in §7 as
*an image in, a description out*, from a plugin calling a vision rung through `sampling` — and
core's `sample` maps every non-text block to the literal string `[image]`. A capability that
cannot work is worse than an absent one, because a caller can see it in the registry. The name
belongs in that table on the day something can provide it; a name with no provider is a promise,
and that table is a record.

**Tier 1 and tier 2 (§6.2, §6.3) were not taken**, on Q6's ruling. What ships instead is the
sentence naming what is missing. `tesseract.js` in particular carries the cost §6.6 records —
worker start-up plus 10–15 MB of language data on a lazily-spawned, idle-stopped plugin — and
taking it would have meant taking it *before* there is a `read_region(target)` to scope it, which
§6.6 argues is most of why cropping to a rectangle works at all.

### 4.3 CLI-Anything, the shelf, and provenance (§6.7, §7.1, Q10, Q11)

Not built, and §6.7 is the reason rather than an excuse: it *"stops at a question rather than a
recommendation"*, and Q10 says plainly that the permission sentence **most needs an answer before
anybody writes code**. D117 fixed the bar for `proc.spawn` at naming the program, and a tool that
generates new programs on demand cannot name them in advance. That is not a wording problem, it
is the permission model meeting something it was not built for — and it is not a thing to answer
by writing the feature and seeing what sentence falls out.

§7.1's panel is a **requirement** rather than an option, and it is a requirement *about CLIs*.
With nothing generating or installing one there is nothing to list, and building the column
before the thing it describes is how a field ends up inferred later — which §7.1 rules out by
name, because a provenance column that is sometimes wrong is worse than none.

### 4.4 Swapping the system cursor while a plan runs (Q7)

Considered, and refused on the restore.

`SetSystemCursor` replaces the pointer **globally, for every application**, and the documented
way back is `SystemParametersInfo(SPI_SETCURSORS, …)`. That is fine when the code that set it
gets to run again. `plugins/computer` is lazily spawned and stopped when idle, so the case that
decides this is the one where it does not: a plugin killed between the set and the restore
leaves a stranger's cursor on the machine until something calls the restore, and *the fix for
the safety indicator is worse than the thing it indicated* is not a trade to make on somebody's
own desktop.

The Tauri border is the other option and `document_plan.md` §8 already flags what it needs:
`setIgnoreCursorEvents` has open issues on webview windows and the known workaround is a polling
loop. **Check the click-through behaviour before committing** is the plan's own instruction and
it has not been checked.

So what was built is the third option done properly rather than the first done riskily, and the
two above stay on the table with their costs written down.

---

## 5. How it was checked

- `pnpm lint`, `pnpm typecheck`, `pnpm test` — **74 files, 593 tests, green**, up from 73/587.
- `pnpm invariants` — green **except** `11-answers-with-no-keys`, which is red on a clean
  checkout too: it calls live keyless providers and one of them is currently answering `406`.
  Confirmed by stashing the whole change and running it again. Nothing here touches that path.
- **Conformance, twice.** `plugins/documents` passes the suite from the checkout — and passes it
  again **after being bundled to one file the way `scripts/publish.mjs` bundles it**, which is
  the check `pdfjs-dist` failed and the reason it is not a dependency.
- **The PDF reader against a real producer.** `plugins/documents/test/browser-print.pdf` was
  printed by a browser and is a checked-in binary on purpose: everything else in that suite is a
  fixture written by the same hand as the reader, and a reader tested only against its own idea
  of a PDF agrees with itself. Its extraction was compared against `pdfjs-dist` and is
  identical, diacritics, table columns and page order included.
- **The whole path, by hand.** Core started, the reader enabled, a real PDF attached over
  `/api/chat`, and the composed message printed — D117's lesson being that a plugin which has
  never been run by hand has never worked.
- **The accessibility reader, against real windows on a real desktop.** `elements`, `read` and
  `invoke` were run against live applications; the tree comes back in tens of milliseconds with
  names, roles and screen coordinates.

## 6. What is still open

1. **A `D`-number and tasks in [`plan.md`](./plan.md).** `document_plan.md` §0 says this is
   where the work belongs once it is work. It has not been done here, for the reason
   `models_plan_final.md` gives for its own pair, and it is the first thing a human should
   decide about this change.
2. **Q10 and Q11**, untouched and unchanged (§4.3).
3. **Q4**, still open and still lower priority than the first draft assumed (§4.1).
4. **Q7's other two options**, costed above and not taken (§4.4).
5. **`document.describe`**, waiting on something that can provide it (§4.2).
6. **A `read_region(target)` and a cropped-OCR tier**, which §6.6 argues for and which is the
   natural next thing on the screen half — *"OCR a rectangle tier B handed you"*, never
   `ocr_screen()`, so the scoping is structural rather than a line in a description.
---

# Part two — the OCR tier, and files coming back

*Added 2026-08-31, the same day. Part one above is unchanged and is still the record of what it
records; this is the next two pieces of work, written in the same shape. §6 above listed the
first — item 6 asked for the OCR tier — and nothing there anticipated the second.*

## 7. The OCR tier (§6.2, and §6 item 6)

### 7.1 What was decided, and on what argument

> **Windows' own text recogniser, in a plugin of its own, under a new capability name that
> `plugins/documents` asks for and never learns the answerer of.**

**The engine was chosen by measurement, not from the shortlist.** §6.2 names `tesseract.js` and
ONNX PaddleOCR. Neither was taken. `Windows.Media.Ocr` is a WinRT API on every Windows 10 and
11 machine — the engine behind Snipping Tool's text actions — and it is reachable through the
same PowerShell spawn `plugins/computer` already makes. Measured on the machine this was
written on:

| | |
|---|---|
| Cold call, spawn to answer | **423 ms** |
| An A4 page at 300 dpi (2480x3508) | **144 ms** of recognition |
| Downloaded, unpacked, or warmed up | **nothing** |

Against that, §6.6's recorded cost for `tesseract.js` — *worker start-up plus 10-15 MB of
language data, on a lazily-spawned, idle-stopped plugin* — is not a tuning problem, it is the
whole of the objection, and here it disappears rather than being managed.

**And the publish check decided it before the speed did.** `scripts/publish.mjs` bundles a
plugin to one file; `pdfjs-dist` fails that because it reaches for its worker by path at run
time, and `tesseract.js` reaches for its worker the same way. A string of PowerShell has no
such path. That is D117's lesson taken in advance, for the second time in this repo.

**The cost is stated rather than buried: this tier is Windows only.** macOS would need a
Vision-framework sibling and Linux has no OS-level engine at all. On those platforms the plugin
refuses by name and `document.extract` falls back to the sentence it already had. A
cross-platform tier is `tesseract.js` with the costs above, and it is **a second plugin
offering the same capability**, not a change to this one.

### 7.2 The wiring, and why it is not a second `document.extract`

Core resolves a capability by taking the **first** enabled plugin that provides it
(`plugins.ts:354`), and there is no fallback when that one refuses. So an OCR plugin offering
`document.extract` as a second provider would be a coin flip on load order, and whichever won
would be wrong for half the files. Instead:

**`image.ocr` — a picture in, the words in it out**, taking a path *or* the bytes. It is
plugin-to-plugin; core never hears about it, which is what `capabilities.ts` means by *every
other service capability is plugin-to-plugin*. `plugins/documents` declares it in `requires`
and calls it exactly the way `vanisher` calls `demo.greet`.

**`image.` rather than `document.`**, and the name is permanent once released. The same call
reads a scanned page, a photographed receipt and a rectangle of somebody's screen, and only one
of those is a document — `read_region` (§6 item 6) is the caller this shape was chosen for. It
cuts against the spec's existing mention of a future `document.describe`, which is the honest
argument for the other side.

**Two argument shapes because there are two real callers.** A screenshot is already a file and
travels as a path; a page pulled out of a PDF was never a file and travels as bytes. Making the
second one write to disk first would mean giving a plugin that *only ever reads* a permission
to write, which is a worse trade than six lines.

### 7.3 The property that mattered most

**OCR is reached for only on the path that was already a refusal.** `read()` runs unchanged; if
it throws, and only then, the file is offered to `image.ocr`. So a born-digital document is
read exactly as it was and never pays for recognition — measured at **4 ms** for a CSV against
**1610 ms** for a scan in the same run — and `read.js` and `kinds.js` know nothing about any of
this and stay testable with no wire in sight.

**With nothing providing it, the refusals are unchanged word for word.** `-32050` is caught and
read as *this machine has no OCR*, which is not a failure but the ordinary state of a machine
without the plugin. `packages/core/test/ocr.test.ts` runs the same plugin twice — once beside a
provider, once alone — and asserts the second one's answer is the sentence that shipped before
OCR existed. That is invariant 4 in the direction nobody usually tests it: *delete the provider
and the consumer goes back to what it said*, not merely *keeps running*.

### 7.4 Reading order was the real work

The engine returns lines in its own order, which is not reading order. On a two-column invoice
what came back was every word correct and every relationship destroyed — the date floated five
lines from the invoice number it sat beside, and three prices came loose from the three things
they priced. **Nothing errors, and no reader of that output can tell.** It is §4's silent
failure exactly, arriving from the tier that was supposed to fix it.

The fix is that the engine also returns where each line is, and that was being thrown away.
Lines are grouped into rows by **growing a band greedily** rather than bucketing on a fixed
grid — a scan is never straight, and some row always straddles a fixed boundary — then sorted
left to right within the row.

Paragraph breaks are measured from **the page's own line spacing** rather than from glyph
height. The first version used height and was wrong on the first real page: leading runs from
about 1.2x the letter height in a dense scan to over 2x in a printed letter, so any multiple of
the height that splits paragraphs in one document splits every single line in the other. The
gap between consecutive rows *is* the leading, and the smallest gaps on a page are the ones
inside its paragraphs — so the quarter mark is the line spacing, and anything half again bigger
is a break.

All of it is a pure function in `lines.js`, tested with no desktop, against the engine's real
output rather than a tidied version of it.

### 7.5 Where it lives

| File | What it is |
|---|---|
| `plugins/ocr/windows.js` | **New.** The PowerShell spawn and the WinRT script. Four known failures answered with sentences rather than exceptions: no language installed, a language that is not installed, a picture past the 10,000-pixel ceiling, and a file that is not a picture. |
| `plugins/ocr/lines.js` | **New.** Reading order. §7.4 is this file. |
| `plugins/ocr/index.js` | **New.** The `read` tool bound to `image.ocr`, and a `languages` tool for after a refusal. |
| `plugins/documents/pdf.js` | `pageImages()` — the page out of a scanned PDF. A scan **is** one image, so there is nothing to render: `DCTDecode` streams are already a JPEG file and are handed over untouched; Flate samples get a top-down BMP; fax and JPEG 2000 are refused **by name**, per page, rather than dropped. |
| `plugins/documents/index.js` | The fallback, on the refusal path only. `0.1.0` to `0.2.0`. |
| `docs/spec/capabilities.md` | The ninth registry row, by pull request as that file requires. |

## 8. Handing a file back (not in `document_plan.md` at all)

*Asked for while §7 was being built: a way for any plugin to send a file to the person, which
they can open, save, or take the path of.*

### 8.1 It is not a skill, and the gap was already live

A skill here is text bundled with a plugin (M2-2). If *hand a file back* lived in one, every
producing plugin would reimplement it and each would render differently. It is a wire shape
plus a row in the conversation, which is **core's surface** — the same argument Q1 used to put
upload in the composer rather than in a plugin widget.

And it was already costing something before it was asked for. A plugin that generates a picture
finished and returned its path **in prose**; so did one that takes a screenshot. Both correct,
neither usable: the file sat on the person's own disk behind a sentence.

### 8.2 The wire is MCP's, and nothing is added to Alexia's

`resource_link` is a block MCP already defines, inside a `CallToolResult` that
`packages/protocol/src/methods.ts` **deliberately declines to re-read** — *MCP owns this shape
and grows it, and Alexia re-reading it would be Alexia reinterpreting MCP.* So the blocks
already crossed the wire untouched; core simply stopped rendering them as `[resource_link]`.

**No new method and no `alexia_protocol` bump.** A plugin that emits none behaves exactly as it
did, which is that file's own bar for not bumping. The fixture that proves it emits the block
**by hand rather than through the SDK helper**, so what passes is the standard rather than our
own convenience.

### 8.3 No route ever accepts a path

The whole security design is one sentence. The shell is handed an **opaque id** and can ask for
exactly the files some tool offered during this run of core. That is structural rather than
validated: there is no path to traverse out of, no prefix to check and no `..` to normalise,
because the string a caller sends is a **key into a map** and is never joined to anything. It
is the shape §6.6 argues for elsewhere — a call that cannot express the dangerous request does
not need to refuse it.

`?id=` rather than `/api/file/<id>` for a reason about this repo rather than about REST:
`guard.test.ts` walks `serve.ts` for literal path comparisons and demands a classification for
each one. A variable path segment would slip past that scanner. **It caught the first draft of
the comment explaining this**, which is a fair sign it reads the file rather than agreeing with
itself.

### 8.4 Open, and the part with teeth

Four things, because people want different ones: **Open**, **Save**, **Show in folder**, and
**Copy path**.

Open hands the file to whatever the OS has registered for it, and for some kinds that means
*running* it. The escalation is specific: a plugin holding no `proc.spawn` writes
`invoice.pdf.bat`, offers it, and a person's press on a button labelled *Open* is what runs it
— a plugin reaching a permission it was never granted, using somebody's click as the grant.

Three layers, ranked honestly:

1. **The id map.** Only a file some tool offered this session can be named at all.
2. **`confirm` in `guard.ts`.** The wire contract, refused before the handler runs — which is
   why it can be asserted against a real server without anything being spawned.
3. **A deny list of executable extensions.** *ponytail: deny lists forget.* It is the third
   layer and is not pretended to be the first. **Show in folder stays available for everything
   Open refuses**, so a refusal is never a dead end: the person still reaches their own file,
   in their own file manager, and decides for themselves.

Saving goes through a blob the shell fetched rather than a link pointed at the route, because a
browser sends no headers when it follows a download link and the alternative was the session
token in a URL, where it would land in history.

### 8.5 Where it lives

| File | What it is |
|---|---|
| `packages/core/src/offered.ts` | **New.** The id registry, the type table, the deny list, and the `spawn` — arguments as an array, never a command line, so a filename with a quote in it has nothing to break out of. |
| `packages/core/src/tooling.ts` | `outcomeOf` reads `resource_link` blocks. The model gets `[file: report.pdf]`; a file the tool **named and did not write** is said out loud and not offered, so the model's sentence and the row on screen agree about whether there is a file. |
| `packages/core/src/agent.ts` | `Produced`, and `files` on `ToolOutcome`. |
| `packages/core/src/serve.ts` | The registry, one route, and the id on the existing step event. |
| `packages/core/src/guard.ts` | Three verdicts: reveal is safe, open is a confirm, and a POST carrying an act nobody declared lands on a read and is refused. |
| `packages/ui/src/main.ts`, `packages/ui/app.css` | The row, the four controls, and an inline preview for a picture. |
| `packages/sdk/src/plugin.ts` | `alexia.file(path)` — one line per producing plugin. |
| `plugins/media`, `plugins/computer` | One line each, so the feature ships with two real users rather than none. |

## 9. How part two was checked

- `pnpm check` — **79 files, 629 tests green**, up from 74/593. `pnpm invariants` **30 green**,
  including 11, which the brief warns is flaky and was not this time. `pnpm check:no-plugins`
  green.
- **Invariant 1 caught the first draft of a comment** in `agent.ts` that named two plugins in
  order to explain the gap. The rule includes comments, and it was right to.
- **A fresh `tsc -b --force` caught what the incremental one missed** — MCP requires `name` on a
  `resource_link`, and a test fixture was omitting it.
- **Conformance twice, for all four plugins**: from the checkout and again bundled to one file
  the way `scripts/publish.mjs` does it. `plugins/ocr` passes bundled, which is the check
  `tesseract.js` was expected to fail and the reason it was never installed.
- **A real producer, committed.** `plugins/documents/test/scanned-page.pdf` is a page printed to
  PDF by a browser from a JPEG — the shape a scanner writes. The suite's other fixtures are
  built by the same hand as the reader, and a reader tested only against those agrees with
  itself.
- **The whole upload path by hand**, through core's own attach seam, three files at once: a
  scanned PDF (1610 ms), a photographed invoice (645 ms) and a CSV (4 ms — it never touched
  OCR). The composed message was printed and read.
- **The file handoff by hand**, because a test that opens Explorer windows on somebody's desktop
  is not a test: a real screenshot plugin's `resource_link` read by core, the id resolving, the
  path **not** resolving, and a real Explorer window opening with the file selected. The windows
  that opened were closed again.

## 10. What is still open after part two

1. **`read_region(target)`** (§6.6, and §6 item 6 above) — unchanged, and now unblocked: the
   tier it needs exists and takes a path or bytes, which is the shape a cropped screenshot
   arrives in.
2. **A `D`-number and tasks in `plan.md`** — still §6 item 1, now covering two more pieces of
   work.
3. **Q4, Q7's other two options, Q10, Q11, and `document.describe`** — all untouched. The last
   is the half of §4 that OCR does not answer: `image.ocr` returns the words in a picture and
   cannot say what a photograph is *of*; handed a chart it returns the axis labels rather than
   the point.
4. **A non-Windows OCR tier**, which is `tesseract.js` and its costs, as a second plugin
   offering `image.ocr` (§7.1).
5. **The shell's file row has not been seen in the real app** by the person who asked for it.
   Every piece under it is exercised over the wire — the id, the bytes, the type, the refusal —
   but the four buttons have been driven by tests and by hand, not by a person in the window.
