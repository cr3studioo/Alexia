# document_plan.md

**Letting Alexia read — a document, a scan, or the screen in front of her.**

*Written 2026-08-31. Captured from the research session of the same date. §5.6, §5.7, §6.6 and
Q7–Q9 were added the same day, when the same question was put to `plugins/computer` and came
back with a different answer.*

---

## 0. What this document is — and is not

An **information capture**, in the shape [`models_plan.md`](./models_plan.md) established.
It is the record of what was asked, what was found in Alexia's own source, what the
open-source field currently offers, and what nobody has answered yet.

- **It does not schedule anything.** No milestones, no task IDs, no ordering. When this
  becomes work it becomes a `D`-number and tasks in [`plan.md`](./plan.md); this file is the
  input to that, not a substitute for it.
- **It does not authorise anything.** Nothing here has been built. §5 describes gaps that
  exist in this worktree right now; they are findings, not fixes.
- **Claims about Alexia are ground truth**, read from the files and cited by path and line.
- **Claims about third-party projects are marked with their trust level** (§1). Licences in
  particular were read from secondary sources and are flagged as such — a licence decides
  whether a plugin may ship at all, so none of §6 should be acted on before the `LICENSE`
  file in the repo itself has been opened.

> **Read order:** §2 is the question. §3 is the answer in one sentence. §5 is what is
> actually missing, and is the part worth reading twice. §8 is what still needs a human.
>
> **Two halves.** §5.1–§5.5 and §6.1–§6.5 are about *uploads*. §5.6, §5.7, §6.6 and §6.7 are
> about *the screen*. They share a question — how does something that is not a model read a
> thing — and they reach **opposite answers**, which is the most useful sentence in this
> document: a document wants a parser, a screen wants the accessibility tree, and an
> application with a backend wants neither (§6.7).

---

## 1. Sources, and how these facts were verified

| Source | What it is | Retrieved | Trust |
|---|---|---|---|
| Alexia's own source | `packages/core/src/*`, `plugins/*`, `docs/spec/*` | 2026-08-31 | **Ground truth** |
| [Docling docs](https://docling-project.github.io/docling/usage/gpu/) | IBM's own GPU/OCR-backend page | 2026-08-31 (web) | High — first-party |
| [OmniDocBench](https://github.com/opendatalab/OmniDocBench) | CVPR 2025 parsing benchmark, 981 pages | 2026-08-31 (web) | High — first-party |
| [OmniDocBench is saturated](https://www.llamaindex.ai/blog/omnidocbench-is-saturated-what-s-next-for-ocr-benchmarks) | LlamaIndex, on the benchmark's ceiling | 2026-08-31 (web) | Medium — vendor blog, but arguing *against* the benchmark it does well on |
| [Marker vs MinerU vs MarkItDown](https://jimmysong.io/blog/pdf-to-markdown-open-source-deep-dive/) | independent comparison | 2026-08-31 (web) | Medium |
| [PDF-to-Markdown 2026](https://themenonlab.blog/blog/best-open-source-pdf-to-markdown-tools-2026) | independent comparison | 2026-08-31 (web) | Medium |
| [Docling vs Marker vs MinerU benchmark](https://adityamangal98.medium.com/docling-vs-marker-vs-mineru-the-ultimate-open-source-pdf-parser-benchmark-2026-which-is-best-a36ecbb6c6b1) | independent, July 2026 | 2026-08-31 (web) | **Low-medium** — where the licence claims in §6.3 come from, and the reason they are marked unverified |
| [Tesseract.js](https://tesseract.projectnaptha.com/) | project site | 2026-08-31 (web) | High — first-party |
| [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Anthropic's own docs — the screenshot agent loop | 2026-08-31 (web) | High — first-party |
| [`winappCli` UI Automation](https://github.com/microsoft/winappCli/blob/main/docs/ui-automation.md) | Microsoft's own UIA-first automation CLI | 2026-08-31 (web) | High — first-party, and §6.6's strongest evidence |
| [`BoundingRectangle`](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.boundingrectangleproperty?view=windowsdesktop-8.0) | Microsoft Learn — the coordinates UIA returns | 2026-08-31 (web) | High — first-party |
| [Chrome native UIA](https://developer.chrome.com/blog/windows-uia-support-update) | Chrome 138 enables UIA by default | 2026-08-31 (web) | High — first-party |
| [Windows platform security for AI agents](https://blogs.windows.com/windowsdeveloper/2026/06/02/windows-platform-security-for-ai-agents/) | Microsoft, Build 2026 — session isolation | 2026-08-31 (web) | High — first-party, but **announcement-grade**: early preview, non-interactive first |
| [Accessibility tree vs screenshots](https://t8r.tech/alternative/compare/accessibility-tree-vs-screenshot-automation) | the router argument, and the cost comparison | 2026-08-31 (web) | **Low-medium** — a vendor comparison page; the reasoning is corroborated by `winappCli` above, the numbers are not |
| [How Claude Code works](https://theaiengineer.substack.com/p/how-claude-code-actually-works) | terminal-agent architecture | 2026-08-31 (web) | Medium |
| [CLI-Anything](https://github.com/HKUDS/CLI-Anything) + [the hub](https://clianything.cc/) | HKUDS — generates agent-native CLIs from an app's own backend | 2026-08-31 (web) | **Medium** — first-party docs, so the architecture is reliable; the **claims** (50+ apps, 2,464 tests, Apache-2.0) are self-reported and unreproduced. Raised by the owner, not found by search. |

**Staleness warning.** This field is moving faster than the model catalog in
`models_plan.md`. OmniDocBench went v1.5 → v1.7 inside April 2026, and LlamaIndex is already
arguing the benchmark is saturated. **Any accuracy ranking copied from §6 decays in months.**
The licence column decays far more slowly and matters far more, which is why it is the column
that gets the warning.

---

## 2. The question, as asked

> *"There is currently no way to upload documents, images or anything like that to Alexia.
> Problem is not every model is capable of using the documents itself so we would have to
> build a way to parse that document and send the information to Alexia. An advanced OCR for
> images or images in a document. Is that possible? And second, is there any open source code
> that does it already?"*
> — the owner, 2026-08-31

Two questions. The second is easy and §6 answers it. The first is easy in the way that
matters — the mechanism exists — and hard in a way the question did not anticipate, which is
§5.1.

**Then the same question was put to the computer-control plugin**, and the answer came back
different enough to reopen the document:

> *"The current computer control plugin can take screenshots — does the plugin have its own OCR
> system, or does it just go 'yeah I see the screenshot file' but doesn't see the stuff in it?"*
>
> *"I like it calculating stuff without using OCR, but let's say it fails to click the right
> window or puts the key somewhere it should not be — that's an issue. So I would like an OCR
> that checks if the action was made correctly. If the task requires the action 10 times it can
> check on the first try and then just copy the thing 10 times. Leave most of the work on
> programmatic stuff, not an LLM part — because an LLM hallucinating that it will do it 10
> times is bad."*
>
> *"Would it be possible to see that Alexia is using my mouse / keyboard / monitor? … Or would
> it be possible to give Alexia a second mouse, so she could click on windows and use the
> keyboard while I do my own work?"*
> — the owner, 2026-08-31

The second guess was right (§5.6). The instinct about where the loop belongs was right and is
**already built** — `replay.js` is that design, missing one step type. And the second mouse is
not possible, for a reason worth writing down rather than just refusing (§5.7).

---

## 3. The answer in one sentence

**This shape has already been built once, for audio.**

`voice.transcribe` is defined in [`docs/spec/capabilities.md:100`](./docs/spec/capabilities.md)
as *"audio file in, text out"*. A plugin provides it, core resolves it **by capability name and
never by plugin id**, and if nothing provides it the caller gets a clean
`-32050 CAPABILITY_NOT_AVAILABLE` and everything else keeps running.

Document extraction is that same sentence with a different noun: **file in, markdown out**.

So the answer to *"not every model can read the document"* is the answer already given to
*"not every model can hear"*: **do not ask the model, ask a capability.** No new mechanism,
one new row in the service registry, and — per that file's own rule — that row arrives *"by
pull request, never by a string somebody typed"*.

The premise in the question is also correct at the code level, and more strongly than
expected. See §5.1: core cannot currently send an image to *any* model, including the ones
that could read it. Extract-to-text is not the fallback for weak models. **Today it is the
only thing the wire can carry.**

---

## 4. "OCR" is one word covering three problems

They have different costs, different failure modes, and only one of them needs OCR. Lumping
them is how this gets expensive, and worse, how it gets quietly wrong.

| | What it is | What it needs | What it costs |
|---|---|---|---|
| **A. Born-digital** | PDF with a text layer, `.docx`, `.xlsx`, `.pptx`, `.md`, `.csv`, source code | Extraction. No OCR at all. | Zero. No model, no GPU, no Python, works offline, works on a plane. |
| **B. Scanned documents** | A contract someone scanned, a photo of a receipt, an old book | Real OCR, where **layout and reading order matter more than character accuracy** | A model, and usually a Python stack |
| **C. Images that are not documents** | A screenshot, a whiteboard, a chart, a photo | A **description**, from a vision model | A vision-capable rung |

**A is most of what people actually drop in**, and it is free. Anything that treats the whole
problem as OCR pays for B on every file in A.

**C is the one that fails silently.** Run OCR over a screenshot and it succeeds: it returns
button labels, menu items and a timestamp, in no order, with no relationship between them.
Nothing errors. The model then answers confidently about a soup of nouns. That is worse than
a refusal, for the same reason D90 refused the inferred-similarity graph — *a picture that
looks meaningful and is not is worse than no picture, because nobody can tell.* The same
argument applies to text.

This is the strongest reason to treat **B and C as two capabilities rather than one**. A
single `document.extract` that quietly accepts a PNG of a whiteboard is the failure above,
shipped.

---

## 5. Findings in Alexia's own source

The seven below are the actual content of this document. Six of them were not visible from
the question, and the first one changes what the answer has to be.

**5.6 and 5.7 were added after the upload question was answered**, when the same question was
put to `plugins/computer`. They are the reason this document is no longer only about uploads:
the plugin that most needs to read a screen is the one that already has permission to see it.

### 5.1 Core has nowhere to put an image — `Message.content` is a `string`

[`packages/core/src/store.ts:220`](./packages/core/src/store.ts):

```ts
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  ...
}
```

Not `string | Part[]`. A **string**. It is a string at the store, a string through
[`trim.ts`](./packages/core/src/trim.ts), and a string at the provider boundary
([`provider.ts:716`](./packages/core/src/provider.ts)).

**So Alexia cannot send an image to a model at all** — not to a weak one, not to a strong
one, not to a local Qwen-VL that `ollama.ts:105` already labels as taking images. There is no
field to put it in.

This reframes the whole question. Extract-to-text was proposed as the *workaround* for models
that cannot read documents. It is currently the **only** path that exists, for every model.
Supporting native image input is a separate and larger change — it touches the message type,
the store schema, `trim.ts` (a base64 image inside a summarisation window is a disaster),
`redact.ts` (§5.4), and every provider that is not OpenAI-shaped.

**The consequence for planning:** extraction is not the cheap half of a two-part feature. It
is the whole feature, and native vision is a second one that can be decided later without
blocking it. That is a good position, not a bad one.

### 5.2 The router reads `modality` and never filters on it

The catalog collects it. [`catalog.ts:30`](./packages/core/src/catalog.ts):

```ts
/** What it can be given: `text`, `image`, `audio`. */
modality: string[]
```

It is populated from OpenRouter's `architecture.input_modalities`
([`catalog.ts:446`](./packages/core/src/catalog.ts)), guessed from the `VL` substring for
OVHcloud ([`catalog.ts:159`](./packages/core/src/catalog.ts)), and read off Ollama's own
capability list ([`ollama.ts:105`](./packages/core/src/ollama.ts)).

Then it is **displayed** — [`surface.ts:297`](./packages/core/src/surface.ts) prints
`takes text, image` under a model row — and that is every use it has.

`route()` ([`router.ts:266`](./packages/core/src/router.ts)) filters on placement, spend,
tools, context, tier, `uncensored` and a named pin. It never looks at `modality`. `Ask`
([`router.ts:122`](./packages/core/src/router.ts)) has no field that could ask it to.

Today this is latent, because of §5.1 — nothing can put an image in a message, so nothing can
route one to the wrong model. **It stops being latent the moment either half of this feature
lands**, including the pure-extraction half, if a `document.describe` capability wants to
reach a vision model through `sampling`.

The fix is small and sits where the `spend` pin already lives (D112): a field on `Ask`, a
filter in `route()`, and a refusal sentence that names what is missing rather than saying
nothing is available.

### 5.3 `file` was refused three times, and this is the user it was waiting for

`docs/spec/ui-schema.md:34` states the bar: a widget with exactly one user is a **no**, and
*"a bar that is only applied when it is convenient is not a bar."*

`file` has been put to that bar three times and refused each time, on a **different** argument:

| | Where | Why it was refused |
|---|---|---|
| D83 | M6-3 | One user. The bar, applied plainly. |
| D89 | M6-6 | *"The use case that motivated it does not exist here"* — the clip was for cloning, and Piper does not clone from a recording. |
| D98 | M7-4 | *"The clip cannot be recorded here, because the only recorder this plugin has returns text."* |

D89 also recorded the structural finding and, crucially, the condition for reopening:

> *"A browser will not tell a page where a file is, so a `path` can never be filled by
> picking, and choosing a file really is inexpressible here. **That argument is waiting on a
> real user.** One user with a convenient need is what the bar exists to refuse."*

**Document upload is that user**, and it is not a convenient need — it is the entire feature.
Two further notes:

1. **The mechanism is already decided.** [`plan.md:2565`](./plan.md): *"If `file` is granted,
   it is base64 in a JSON body, not multipart"* — because `node:http` has no multipart parser
   and adding one for a single widget buys a parser core otherwise never needs.
2. **The path obstacle does not apply.** D89's *"a browser will not tell a page where a file
   is"* is true and irrelevant here. Drag-and-drop and paste hand the webview **bytes**, with
   no path involved. The path problem only ever bit the settings-widget case — pointing at a
   `.wav` already on disk — which is what the `path` widget
   ([`ui-schema.md:189`](./docs/spec/ui-schema.md)) exists for.

**Caveat, stated rather than glossed:** an upload in the *composer* and a `file` *widget in a
manifest* are not the same grant. The composer is core's own surface; the widget is a thing
any plugin may declare. This finding reopens the first cleanly. Whether it also carries the
second is a real question and is left open in §8.

### 5.4 `redact.ts` is regexes over a string, and a document is the worst input it will ever get

[`redact.ts`](./packages/core/src/redact.ts) guards what leaves this machine for a
third-party model, and D51 is why it must exist: free endpoints are the default, and their
terms permit training on what they receive. Its own comment states the ceiling:

> *"This is pattern matching. It is deliberately narrow, it is not exhaustive, and it will
> miss something — a credential shape nobody has seen yet, a street written in a form not
> listed below. Saying so is the difference between a filter and a promise."*

That ceiling was written for **chat turns**. Uploaded documents change its exposure by orders
of magnitude, in three ways at once:

- **Volume.** A chat turn is a sentence. A payslip, a bank statement, a lease, a passport
  scan or a medical letter is a page of exactly the two categories the policy strips —
  credentials and location — written in forms no regex anticipated.
- **Intent.** People upload the documents they cannot be bothered to retype. Those skew
  heavily toward the personal and the official.
- **Invisibility.** Nobody reads the extracted markdown before it is sent. In a chat turn the
  user typed the words and knows what is in them.

**This is a finding, not an objection.** The policy is the owner's and is quoted verbatim in
that file precisely so a later session cannot quietly broaden it — and §5 is not the place to
broaden it. But *"an uploaded document is a much larger surface than a chat turn"* is a fact
about this feature, and the honest place to write it down is before it ships rather than
after. What follows from it is a question, not a rule, and it is in §8.

### 5.5 There is no retrieval, and that is deliberate

[`plugins/memory/search.js:6`](./plugins/memory/search.js):

> *"ponytail: keyword overlap, not embeddings. An embedding index means a model to run, a
> vector to store per row, and a similarity search built on a storage API that has no
> `ORDER BY distance` — three problems, to beat `LIKE` on a table that in practice holds
> hundreds of short sentences rather than millions."*

It also writes down its own upgrade path — *embed with the local T0 model through `sampling`,
keep the vector as a column, and rank here instead of in SQL* — gated on somebody being able
to point at a miss.

That reasoning is sound for the memory store. It does not transfer. A 200-page PDF extracted
to markdown is on the order of 150k tokens, and the bottom rung of the free ladder (M7-6) has
nothing like that context.

[`trim.ts`](./packages/core/src/trim.ts) does not solve this either. It summarises a
**conversation** — recent turns verbatim, older ones collapsed, tool output dropped once what
was learned from it is written down. A document is not a conversation: there is no *recent*,
nothing is *older*, and "what was learned from it" is the question the user has not asked yet.

**So the hard problem in this feature is not OCR. It is what goes in the message.** Extraction
is solved by other people (§6) and can be adopted. "The document is bigger than the context
window" is unsolved here, and every one of the three answers to it — send it whole and let it
fail, chunk-and-rank, or summarise-then-drill — is a design decision nobody has made. §8.

### 5.6 `plugins/computer` takes a screenshot nothing ever reads

The `screenshot` tool ([`index.js:116`](./plugins/computer/index.js)) returns exactly this:

```
C:\...\computer\screen-2026-08-31T14-22-08-441Z.png
2560x1440 pixels. Coordinates for clicking are measured from the top left of this image.
```

A path and a resolution. **There is no OCR in the plugin and no reader of any kind** —
grepping all three source files for `ocr|tesseract|recogni|readtext|extract|uiautomation` finds
one unrelated comment about window titles. The capture is PowerShell `CopyFromScreen` →
`$bitmap.Save(...)` → `ConvertTo-Json @{ width; height }`
([`windows.js:105`](./plugins/computer/windows.js)). The pixels reach the disk and are never
read again by anything.

`windows.js:14` states it plainly, and is the same finding as §5.1 arriving from the other
side:

> *"Everything in here happens in the plugin process. Core spawns this and reads JSON from a
> pipe; **there is no screen buffer on that pipe and no way for core to ask for one.** The
> screenshot lands in this plugin's own folder and what crosses the wire is a path."*

**The loop this produces cannot close.** `click`'s own description
([`index.js:148`](./plugins/computer/index.js)) says *"use after taking a screenshot and
**working out where the thing you want actually is**"* — and nothing in the tool surface lets
it work that out. The only sight the plugin has is `windows`, which lists titles and pids with
no geometry. So the sequence is: take a screenshot it cannot see, then click coordinates it
cannot derive.

`screen.capture` is granted on the sentence *"see your screen"*. Today it buys a resolution and
a filename. The permission is fine; the sentence is ahead of the code.

**And `replay.js` is missing exactly one thing.** That file is already the answer to *computer
control is slow and expensive* — three rungs (skill / workflow / script), with the zero-cost
guarantee enforced by the import graph rather than by a comment, and a test that reads the
imports rather than trusting the paragraph. But `STEPS`
([`replay.js:43`](./plugins/computer/replay.js)) is `click, move, type, key, focus, wait`:
**six ways to act and no way to check.** A plan can do the wrong thing sixty times and report
sixty successes, because nothing in the registry can observe.

So the missing piece is not OCR. It is an **`expect` step** — a postcondition — and the only
real question is what reads the screen for it. §6.6 argues that OCR is the wrong reader.

### 5.7 Nothing on screen says Alexia is driving, and the machine has one cursor

Two findings, one from the code and one from the platform.

**The plugin moves the real pointer and announces nothing.** `win.click` and `win.move`
([`windows.js`](./plugins/computer/windows.js)) drive the system cursor through .NET. There is
no overlay, no cursor change, no tray state, and no border — `allow_input` is a *setting*, not
an *indicator*. Its own hint says **"turn this on only while you are watching"**, which makes
the absence load-bearing: the plugin's stated safety model is a human watching, and the human
has nothing to watch *for*. The Plans panel records what happened afterwards; nothing marks
what is happening now.

This is cheaper to fix than anything else in this document, and the pieces are already here —
`src-tauri` has a tray icon and a window, and Windows has a documented way to swap the system
cursor and put it back. See §8 Q7.

**A second, software-only cursor is not possible on Windows, and the reason is structural.**
Windows was built single-pointer. The window-message system has no field saying which mouse
generated an event, so however many mice are plugged in, applications see one. Raw Input can
tell devices apart at the application layer, but **the OS still draws and dispatches one
pointer** — an app can paint an extra cursor for itself and cannot give that cursor to other
programs. Third-party products exist and work by taking over input globally, which is a
larger intervention than this plugin should ever make. So *"give Alexia her own mouse while I
keep using mine"* has no version that works across arbitrary applications.

**What replaces it is not a second mouse, and it is the same answer as §5.6:** UI Automation's
control patterns act on a control **directly**, with no pointer and no keystroke. Microsoft's
own `winappCli` is built this way — *"most UI Automation commands drive the app through UIA
patterns (no input injection), with `ui click` being the exception"*. An agent that invokes
buttons rather than clicking pixels does not contend for the cursor at all, so the second-mouse
problem mostly stops existing rather than getting solved.

**The platform is building the real isolation and it is not ready.** Microsoft's session
isolation (Execution Containers SDK, announced at Build 2026) separates an agent from *"the
interactive desktop, clipboard, UI, input devices and active sessions"*, explicitly so agents
can run alongside a human. It went to **early preview**, and the first versions support
**non-interactive sessions only** — which is precisely the half that would be needed here. It
is the right thing to watch and the wrong thing to depend on. Windows Sandbox and a VM are the
available versions of the same idea today, at the cost of an isolated machine that cannot touch
the apps a person actually wants driven.

---

## 6. The open-source field

### 6.1 Tier 0 — no Python, ships inside a plugin, works on a cold machine

Covers category **A** in §4, which is most uploads, at zero marginal cost.

| Project | Licence | What it does |
|---|---|---|
| `pdfjs-dist` (Mozilla) | Apache-2.0 | PDF text layer; also rasterises pages for when there isn't one |
| `mammoth` | BSD-2-Clause | `.docx` → HTML/markdown |
| `exceljs` / `xlsx` | varies — **check** | spreadsheets |
| `officeparser` | MIT | several Office formats behind one call |
| **MarkItDown** (Microsoft) | MIT | The reference implementation of exactly this idea. **Python**, so it is a design to copy rather than a dependency to take. ~80k stars. |

The argument for this tier is not quality, it is **cold install**. It adds no process to
spawn, no runtime to find, no model to download, and it cannot fail on a machine that has
never had Python on it. Against the two-minute claim (M2-8, M5-6, still ungated per D79),
that is worth more than accuracy on scans.

### 6.2 Tier 1 — real OCR, still no Python

| Project | Licence | Notes |
|---|---|---|
| `tesseract.js` | Apache-2.0 | Pure JS/WASM, 100+ languages, orientation and script detection, word/character boxes. **No external install and no Python** — the reason it is on this list. Weak on tables and multi-column layout. |
| ONNX PaddleOCR ports via `onnxruntime-node` | Apache-2.0 (PaddleOCR) | Better accuracy than Tesseract, still no Python. Node, browser, React Native and C++ bindings exist. |

### 6.3 Tier 2 — the strong parsers, all Python

**Every licence in this table came from a secondary source and none has been read from the
repository. Treat the column as a shortlist of things to verify, not as a finding.**

| Project | Licence *(unverified)* | Strengths | Notes |
|---|---|---|---|
| **Docling** (IBM Research) | **MIT** | `DoclingDocument` preserving semantic hierarchy; built for RAG pipelines | **The best fit — see §6.4** |
| **MinerU** (OpenDataLab) | **AGPL** | Complex layout, tables rendered as HTML, 84 languages, auto-detects scans | AGPL is **compatible with this tree** (`AGPL-3.0-only`). The attribution clause is reported as *not* conditional on revenue. |
| **Marker** (Datalab) | **GPL-3.0 + RAIL-M weights** | Often rated best structure fidelity; PDF, images, DOCX, PPTX, XLSX, HTML, EPUB → Markdown/JSON/chunks, on Surya OCR | ⚠️ **The weight licence restricts commercial use** above a reported 100M MAU / $20M monthly revenue threshold, with a disclosure obligation for online services. A restriction on the *weights* is not cured by the code licence. **Do not ship this in a plugin without a lawyer.** |
| `pdf-craft` | check | Scanned books → Markdown/EPUB, DeepSeek OCR, fully local | Narrow, and good at its narrow thing |
| `pdf-inspector` (Firecrawl) | check | Rust; reported the fastest PDF→Markdown parser as of mid-2026 | Rust is interesting here — `src-tauri` already exists |

**VLM-based, one model does everything, wants a GPU:** dots.ocr (layout-aware, emits
structured Markdown/JSON), DeepSeek-OCR2 (Jan 2026), PaddleOCR-VL-1.5, GLM-OCR.

On the benchmark: OmniDocBench is 981 PDF pages over 9 document types, 4 layout types and 3
languages, scoring text, tables, formulas and reading order separately. GLM-OCR is reported at
**94.6%** on v1.5, above Gemini 3 Pro and GPT-5.2. LlamaIndex argues the benchmark is
**saturated** — which is the more useful fact of the two, because it means *"which of these is
most accurate"* is no longer the question that separates them. **Licence, install cost and
failure behaviour are.**

### 6.4 Why Docling is the one to look at first

Three reasons, in order of weight:

1. **MIT.** The only licence in §6.3 with no restriction to reason about. For something
   intended to ship inside a redistributable plugin, that outranks a benchmark column.
2. **It already speaks MCP.** `docling-mcp` exists, and `docling-serve` exposes a REST API.
   Alexia's plugin contract *is* MCP, and per D57 core already accepts plain MCP servers that
   have no use for the `alexia/*` methods. That is close to an integration that needs no
   adapter written at all — **worth verifying before designing one.**
3. **Pluggable OCR backends, one of which is cheap.** EasyOCR, tesserocr, RapidOCR, OcrMac,
   Nemotron OCR. IBM's own docs call **RapidOCR lightweight with no C dependencies**, and
   EasyOCR the Windows default needing no extra install. Windows is supported on x86_64 and
   arm64.

**And one finding from IBM's own GPU page that cuts the other way from the obvious
assumption:** *"the only setup which is known to work at the moment is RapidOCR with the torch
backend"*, and users enabling accelerators with EasyOCR or RapidOCR **saw no significant time
difference and no GPU usage increase**. So the OCR backends are effectively CPU-bound. That is
good news for cold install and bad news for anyone budgeting a GPU to make this fast.

### 6.5 The precedent for taking a Python dependency at all

`plugins/media` already does this, and D117 is the record of what it cost. `launch.js` finds
an existing ComfyUI install, works out which Python it was built with, and spawns `main.py`
under `proc.spawn` — a permission widened rather than duplicated, on the rule that **naming
the program in `why` is the bar**.

The costs D117 paid are the ones this would pay again, and they are not small:

- The install this was built against took **six minutes** to come up.
- The venv beside the install was the only Python with PyTorch in it; the one on `PATH` gave
  *no module named torch* on a machine where the program worked perfectly.
- The plugin **had never once succeeded** before it was run by hand, because the failure body
  was being thrown away.

That is the honest price of Tier 2, and it is the strongest argument for Tier 0 being the
thing that ships in the box with Tier 2 as a **drop-in alternative under the same capability
name** — which is exactly the mechanism `docs/spec/capabilities.md:93` describes: *"a second
plugin offering the same thing offers it under the same name and becomes a drop-in
alternative rather than a competitor."*

### 6.6 Reading a screen is a different problem from reading a document

§5.6 needs a reader, and reaching for §6.1–§6.3 would be the mistake this section exists to
prevent. **A document parser answers *what does this say*. A postcondition asks *is the Save
button there, and where*.** Those are not the same question and OCR only answers the first.

But the sharper correction is that *reading the screen at all* is the third-best option.
**There are four tiers, and the rule is to take the highest one the application allows:**

| Tier | When it applies | What it returns | Determinism |
|---|---|---|---|
| **A. Call the backend** (§6.7) | The app has a scriptable API — Blender's `bpy`, LibreOffice's UNO, GIMP's Script-Fu, PyQGIS | Whatever the API returns, as JSON | **Total.** No cursor, no screen, no model. An exit code is not a judgement call. |
| **B. Accessibility tree** (UIA) | No API, but the app exposes its controls | Every control's `Name`, `ControlType`, `AutomationId` and **`BoundingRectangle` in physical screen coordinates** | High, and free — milliseconds, no model, no download |
| **C. OCR** | Neither, and the target is text | Text with pixel positions, no roles, no relationships | Low. It cannot tell a button from a label from a watermark. |
| **D. A vision model** | Nothing else works | A description | Lowest — the slowest, the most expensive, and the only one that can be **confidently wrong** |

Production automation frameworks route between B, C and D rather than picking one. A is not
part of that routing at all: where it exists it is simply better, and the reason it is listed
last in this document is that it was found last.

**The rest of this section is about B**, which is the tier `plugins/computer` is missing and the
one that costs nothing to add.

**UI Automation is the right primary reader, and it fits this repo's existing constraint
exactly.** `System.Windows.Automation` lives in `UIAutomationClient` and `UIAutomationTypes`,
.NET assemblies present on every Windows machine — which is `windows.js`'s own stated design
rule, arriving one assembly over:

> *"no native module, no robotjs, no nut.js. Every one of them is a compiled dependency that
> has to be rebuilt per Node version and shipped per architecture, and the whole of what is
> needed here … is four .NET types that are already on every Windows machine."*

A fifth type, through the same PowerShell spawn, under `screen.capture` which is already
granted. No Python, no model, no download, **no new permission** — and it supplies the
coordinates §5.6 shows the model currently cannot derive.

**It is also what Microsoft ships.** `winappCli` drives apps through UIA patterns and falls
back to real mouse simulation only for controls that expose no pattern. The fallback order is
worth copying verbatim: `InvokePattern` → `TogglePattern` → `SelectionItemPattern` →
`ExpandCollapsePattern`, then `GetClickablePoint()` and a real click.

**Where UIA is blind, OCR is the correct second tier** — not the first. Chrome is fine (native
UIA on by default since Chrome 138) and Electron exposes it through Chromium's accessibility
data. But `BoundingRectangle` returns empty for elements not currently displaying, and can
include points that are not clickable on irregular or obscured controls, so a reader that
believes it unconditionally will click nothing and report success.

The economics are not close, and this is the sentence that decides it: a screenshot spends a
large number of tokens encoding a picture the model must then interpret, while the control tree
is compact text that **states each element's role and name outright** rather than asking a
model to guess which pixels form a control.

**Tier C is not "OCR the screen". It is "OCR a rectangle tier B handed you", and that
distinction is most of why it works.** The tiers compose rather than compete:

1. UIA resolves *the display in the Calculator window* to a `BoundingRectangle`.
2. The screenshot is cropped to that rectangle.
3. OCR runs on the crop — perhaps 300×60 pixels of high-contrast, unskewed, digitally rendered
   text at a known DPI.

Step 3 is close to the easiest input OCR will ever be handed, and bears no resemblance to
reading a photographed receipt (§4 category B). **Screen text is a best case**: no skew, no
perspective, no paper noise, no lighting, standard fonts. The full-screen version of the same
call is a worst case — mixed fonts and sizes, icons, no reading order, and an answer nobody can
check.

So the tool a plugin should expose is **`read_region(target)` and never `ocr_screen()`**. A tool
that only accepts a target cannot be asked for the soup, which makes the scoping structural
rather than a line in a description that a model may ignore. The same shape answers *what does
the display say* and the `expect` step's *does the display say 42*.

**Where tier C actually earns its place, which is narrower than it first appears.** Only where
the text is **drawn rather than composed** — that is, where there is no element to ask:

| Case | Why tier B cannot answer it |
|---|---|
| A game HUD, a chart label, a canvas-rendered readout | Painted pixels; the tree holds one element for the whole canvas |
| A PDF page inside a viewer | The viewer exposes the *document*, not the glyphs on the page |
| A remote desktop or VM window | Literally a bitmap to the host — the guest's tree is on the other side |
| An image inside a document or a web page | Same reason a document needs §6.1–§6.3 |
| Custom-drawn UI — some trading terminals, media apps, older bespoke software | The app draws its own controls and implements no automation provider |

**Everything else is a property read.** The example that prompted this — *what number is in the
calculator display* — needs no OCR at all: that display is a UIA element and its value comes
back as text. The owner anticipated this (*"of course I know calculator technically doesn't need
OCR at all"*) and the general form of the observation is the point: **if a person can select
the text, an element holds it, and tier B is both cheaper and exact.** OCR is for the pixels
nobody can select.

**One practical cost, recorded before it is discovered in use.** `tesseract.js` carries real
start-up cost — worker initialisation plus roughly 10–15 MB of language data. On a warm worker
a small crop is tens of milliseconds; cold, it is seconds. `plugins/computer` is lazily spawned
and stopped when idle, so the naive implementation pays that warm-up on the first read of every
session and looks broken while doing it. Solvable — hold the worker for the plugin's lifetime,
or load the language data on first `read_region` rather than at start-up — but it is the shape
of thing D117 found by making a picture rather than by reading the code, and it is written down
here so it is found earlier this time.

### 6.7 Tier A — [CLI-Anything](https://github.com/HKUDS/CLI-Anything), and skipping the interface entirely

*Raised by the owner, 2026-08-31, after §6.6 was written. It is the reason §6.6 has four tiers
instead of three.*

An Apache-2.0 framework from HKUDS that **automatically generates an agent-native CLI for an
application**, plus a hub ([clianything.cc](https://clianything.cc/)) for publishing and
installing the results. Its own diagnosis is this document's own complaint, arrived at
independently:

> *"AI agents are great at reasoning but terrible at using real professional software"* —
> because they rely on *"fragile UI automation, limited APIs, or simplified reimplementations
> that omit 90% of functionality."*

**It does not automate the GUI.** A seven-phase pipeline analyses the application's source and
APIs, then generates a Click CLI that calls the **actual backend** — Blender's `bpy`,
LibreOffice's ODF generation, Audacity's audio libraries. No screenshot, no accessibility tree,
no pixels. Every generated CLI carries `--json` for structured consumption and `--help` for
self-documentation, and the pipeline emits a `SKILL.md` for agent discovery.

**Why it belongs in this document rather than in a link somewhere.** Three properties line up
with things this repo already decided:

1. **A generated CLI plus a `SKILL.md` is Alexia's plugin-plus-skill shape**, arrived at from
   the other direction. D70 already established that a skill's index is a tool description.
2. **A hub of publishable CLIs is Alexia's registry**, with the same drop-in-alternative
   property the service registry has.
3. **`plugins/claude-code` already spawns `claude`** under `proc.spawn` — *"to run the claude
   program that is already installed on this machine"* — and CLI-Anything installs as a Claude
   Code plugin. The distance from here to there is short.

**Where it stops, which is the part that decides how much it changes.** Read the tested-app
list — Blender, LibreOffice, GIMP, QGIS, FreeCAD, Audacity, Inkscape, Godot — and the pattern
is that **every one of them already had a scripting API**. The pipeline begins by scanning
source code and mapping capabilities to APIs, so a closed-source Windows application with no
API offers nothing to scan: a bank's desktop client, an installer dialog, a legacy WinForms
app, a game.

So **it does not replace `plugins/computer`; it sits above it**, and that plugin becomes the
fallback for everything with no backend — which is what it should have been all along, rather
than the first thing reached for.

**Two costs, stated plainly.**

- **Cold install.** Python 3.10+ and pip, and on Windows the project's own docs call for Git
  Bash or WSL. That is §6.5's Tier-2 price and D117's lessons arriving again — worth paying to
  drive Blender, not worth paying to press a button.
- **The permission sentence.** This is the real one, and it is **Q10**. D117 fixed the bar for
  `proc.spawn` at *naming the program in `why`*, and a generator that produces new programs on
  demand cannot be named in advance.

**Unverified:** 50+ applications and 2,464 passing tests are the project's own figures, read
from its documentation and not reproduced here. The licence (Apache-2.0) is compatible with
this tree and was also read from the docs rather than from the `LICENSE` file — §1's rule
applies.

---

## 7. The shape this would take, if it is built

Framed as options and consequences. **Nothing here is a decision.**

**The division that falls out of §4 and §5.1:**

- **Uploading is core's.** The composer, where the bytes live, how a file appears in the
  session and in the trace, and what `redact.ts` sees. This half cannot be a plugin, because a
  plugin cannot add a control to the composer and should not be able to.
- **Parsing is a plugin's.** One capability name, several possible providers, delete any of
  them and the rest keeps running. This half is where every project in §6 lives.

**On the capability name(s).** §4 argues for two rather than one, because C fails silently
inside a single name:

| Candidate | Contract | Provider |
|---|---|---|
| `document.extract` | a file in, markdown out | Tier 0 in the box; a Docling or MinerU plugin as a drop-in |
| `document.describe` | an image in, a description out | a plugin that calls a vision rung through `sampling`, so the spend slider and the placement pins still apply |

Both are **services**, not permissions, so neither widens what any plugin may ask of core.
Both go in `docs/spec/capabilities.md` by pull request. Whether `document.describe` should
instead be `image.describe` — matching `image.generate` in `plugins/media/plugin.json` — is a
naming question worth ten minutes and no more, but names are permanent once a released plugin
uses one.

**What it does not need:** no new widget for the composer path, no multipart parser
([`plan.md:2565`](./plan.md)), no change to the MCP revision, no new permission. `fs.own_dir`
already covers a plugin keeping the extracted text beside the original.

### 7.1 The shelf is visible, and every row says where it came from

*Asked for by the owner, 2026-08-31, on reading §6.7. Recorded as a requirement rather than an
option — it is the first thing in this document that was specified rather than proposed.*

> *"It would be nice to see what CLIs Alexia gets. And I want to see which ones she generated
> herself and which she just has installed from the internet."*

Two requirements, and the second is much stronger than it looks.

**A panel listing what is on the shelf.** This invents nothing: it is a `table` — *a list of
things with actions on each one*, which is the widget D83 granted and the exact shape
`plugins/computer`'s own Plans panel already uses. One row per CLI, the application it drives,
and a row action to remove it.

**A provenance column, and it is not a nice-to-have.** *Alexia wrote this* and *somebody
published this and it was downloaded* are two different trust stories, and §6.7's tiers make
the difference material rather than cosmetic — a consumed CLI was reviewed by whoever published
it, and a generated one was reviewed by nobody. A person deciding whether to let something
drive Blender is asking exactly that question, and the answer should be on the screen rather
than in a folder somewhere.

**The design constraint that follows, and the reason this is a requirement rather than a
column:**

> **Provenance is written when the thing arrives, and can never be recovered afterwards.**

Look at a directory of generated Python and a directory of downloaded Python and there is
nothing to tell them apart — no header, no signature, no shape. A field inferred later is a
field that will be wrong, and a provenance column that is sometimes wrong is worse than none,
because it is read as a guarantee. So it is recorded at the moment of install or generation,
by whichever code path did it, and it is **not editable from the panel** — the same reason
`plugins/commitments` is read-only (D91): a record whose value is that it only grows must not
have a second way in.

This is **D73 arriving for a new kind of arrival**. That decision ruled that *a folder appearing
is not consent*, whoever or whatever put it there. It was written about folders somebody else
put there. A folder Alexia put there is the case it did not consider, and the panel is where
that distinction becomes visible instead of theoretical.

It also does real work for **Q10**: a permission sentence is easier to write when the thing it
governs is listed on a screen with its origin beside it. Q11 is what is still undecided.

---

## 8. What still needs a human answer

Numbered so they can be lifted into [`questions.md`](./questions.md) unchanged.

**Q1 — Does the upload live in the composer, the manifest, or both?**
§5.3 reopens the composer case cleanly and does **not** automatically grant a `file` *widget*
that any plugin may declare. Those are two grants with two blast radii. Granting the first
without the second is coherent; the reverse is not.

**Q2 — What goes in the message when the document is bigger than the context window?**
The real hard problem (§5.5). Three answers, none free: send it whole and let the rung refuse;
chunk and rank, which means the embedding index `plugins/memory/search.js` deliberately
refused; or summarise-then-drill, which is a model call per document and a second thing that
can be wrong. **This should be answered before an extractor is chosen, not after** — it is the
one that constrains the others.

**Q3 — Is a document a bigger redaction surface than the policy was written for, and if so,
what changes?**
§5.4 is a fact. What follows from it is not, and it is deliberately not decided here. Options
range from *nothing, the policy is the policy* through *the extracted text is shown before it
is sent* to *an uploaded document is placement-pinned local by default*, which is a real
answer with a real cost — it would refuse on the free rung that is the whole point of D51.

**Q4 — Does native vision get built, and when?** *(revised after §5.6)*
§5.1 makes it a separate feature rather than a prerequisite for uploads, and extraction can
ship first and be useful. `Message.content: string` is still load-bearing across the store,
`trim.ts` and every provider, and still gets more expensive to change with every session.

**What changed is the argument that it is urgent.** The first draft of this question assumed
`plugins/computer` was the thing waiting on vision. It is not. §6.6 says computer control wants
the **accessibility tree**, not pixels — cheaper, faster, more reliable, no model in the path,
and it returns coordinates a picture does not. So vision is not on the critical path for the
one plugin that looked like it needed it most, and this question drops in priority rather than
rising. It stays open for category **C** in §4 — a photo, a whiteboard, a chart — which is a
real use and a smaller one.

**Q5 — Does `route()` learn about `modality` now or with the feature?**
§5.2. It is a small change today and a bug the day something can carry an image. D112 put the
`spend` pin in the same function on the same argument — *a rule nobody can see is a rule
nobody can disagree with.*

**Q6 — Tier 0 in the box, or a Docling plugin from the start?**
The cold-install claim (M2-8, M5-6, still ungated per D79) argues for the first. D117's six
minutes argues for it harder. But an extractor that cannot read a scan will be reported as
broken by the first person who uploads one, and the refusal sentence has to be good enough
that it reads as a limit rather than a failure.

> **Q7–Q10 came from the second round (§5.6, §5.7, §6.6, §6.7) and are about the screen rather
> than about uploads.** Q7 is the cheapest thing in this document. Q10 is the one that most
> needs an answer before anybody writes code.

**Q7 — What tells a person that Alexia is driving the mouse right now?**
§5.7. The plugin's stated safety model is *"turn this on only while you are watching"*, and it
gives a watcher nothing to see. Three options, and they compose rather than compete: swap the
system cursor while a plan is running and restore it after (documented Win32, and the most
legible — the pointer itself says who has it); a transparent always-on-top border drawn by the
Tauri shell (**check the click-through behaviour before committing** — Tauri v2's
`setIgnoreCursorEvents` has open issues on webview windows, and the known workaround is a
polling loop, which is a real cost for a border); or a tray-icon state, which is the cheapest
and the easiest to not notice. This is the smallest item in this document and probably the
highest ratio of trust bought to work done.

**Q8 — Who reads the screen for the `expect` step, and does `replay.js` get one?**
§5.6 and §6.6. A postcondition per step turns *"it did it ten times"* from something a model
asserts into something the plugin counts. The recommendation is tier B first with tier C as a
fallback — but note what it costs to keep the file's best property: `replay.js` imports
`./windows.js` **and nothing else**, so a plan cannot bill even by accident, and a test reads
the imports to prove it. A UIA reader lives in `windows.js` and keeps that intact. **An OCR
fallback that reaches for a model would break it**, and the invariant is worth more than the
fallback.

**Q9 — Does Alexia ever get a desktop of her own?**
§5.7 closes the second-mouse question — one cursor, no software workaround that generalises —
but not the need behind it. Microsoft's session isolation is exactly this feature and is early
preview with non-interactive sessions first. Windows Sandbox and a VM exist today and cost an
isolated machine that cannot reach the apps a person wants driven. **The honest near-term
answer is §6.6 rather than isolation**: an agent that invokes controls instead of clicking
pixels does not contend for the cursor, so most of the need dissolves. Worth revisiting when
the preview supports interactive sessions.

**Q10 — What `why` does a generated CLI ask the user to agree to?** *(the sharp one in §6.7)*
D117 fixed the bar for `proc.spawn` at **naming the program**, on the argument that *"run a
program"* is not a sentence anybody can agree to and *"start ComfyUI for you, if it is installed
on this machine"* is. A tool that **generates new programs on demand** cannot name them in
advance, and that is not a wording problem — it is the permission model meeting something it
was not built for.

Three shapes, and they are not equally hard:

- **Consume only.** Install a *published* CLI from the hub, per application, each named in its
  own `why` the way ComfyUI is. This fits the existing bar with nothing widened, and is the
  version worth costing first.
- **Generate locally.** Run the pipeline on this machine. The generator reads source, writes
  Python and runs tests — `proc.spawn` plus `fs.write_scoped` plus a code-writing model, which
  `plugins/claude-code` already composes for a folder the user chose. Whether *"write and run a
  program that drives Blender"* is one yes or several is undecided.
- **Generate and run unattended.** Not proposed, and named here only so the ladder is visible.

**This is also the first place a plugin would arrive that Alexia wrote herself**, which is
larger than a permission string and is why this stops at a question rather than a
recommendation. D73 is the precedent — *a folder appearing is not consent* — and it was written
about folders somebody else put there.

**Q11 — What does the panel show when it does not know where something came from?**
§7.1 makes provenance a requirement and rules that it is written on arrival, because it cannot
be recovered afterwards. That leaves the case §7.1 does not decide: **a row that predates the
field, or arrived by a path that did not write it.** *Unknown* is the honest value and it is
also the one that erodes the column — a table where some rows say *generated*, some say
*downloaded* and some say *unknown* teaches people to skim past it.

The alternatives are worse in specific ways: refusing to list unattributed rows hides things
that are actually installed and running, which is the opposite of what the panel is for;
defaulting them to *downloaded* is a guess presented as a record. The narrow answer is probably
to keep *unknown* and make sure the only way to get one is a path nobody uses — but that is a
ruling, and it belongs to whoever writes the field.

**The larger version of the same question:** does provenance stay a property of *CLIs*, or is
it a property of **every plugin**? Alexia has a registry, a library screen and an install
lifecycle already, and *where did this come from* is a fair question about any of them. Scoping
it to one plugin's shelf is smaller and might be the right size; making it general is a change
to the manifest and to D73's lifecycle, and should not happen by accident because one panel
needed a column.

---

## 9. Checked, and not a problem

Written down so it does not get re-derived.

- **The MCP revision.** Nothing here needs a server-to-client request channel, so D57's pin
  is untouched. An extractor answers a `tools/call` with text.
- **`proc.spawn`.** Already widened by D117 to cover *a program already on this machine*, with
  naming it in `why` as the bar. A Docling or MinerU plugin fits the existing sentence and
  needs no twelfth permission.
- **Storage.** `fs.own_dir` is purged with the plugin, which is the right lifetime for a cache
  of extracted text.
- **`structuredContent`.** D83 established that structured tool output rides MCP's own
  envelope. Extracted document structure — headings, tables, page numbers — has a home
  already, and a second envelope would be a dialect.
- **UI Automation needs no twelfth permission.** Reading the control tree is *seeing the
  screen*, which is what `screen.capture` already grants and what its sentence already says.
  It also needs no new dependency: `UIAutomationClient` and `UIAutomationTypes` ship with
  Windows, reached through the PowerShell spawn `windows.js` already makes.
- **`replay.js`'s zero-cost guarantee survives an `expect` step**, as long as the reader lives
  in `windows.js`. The invariant is structural — that file imports `./windows.js` and nothing
  else — so it holds by construction and the existing import test keeps proving it. Q8 is
  where it would be broken, and says so.
